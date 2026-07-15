/* ============================================================
   foncier-app.js - v0
   Doctrine en cascade, transposee de computeVisibilityScore_V4.
   Le moteur ne renvoie que la voie GAGNANTE (early-return), mais
   chaque adaptateur ecrit son etat dans son cache pour que les
   voyants s'allument independamment.
   Ordre : vetos -> voie 1 (reglement, v1) -> voie 2 (comparables,
   mesure du reel) -> voie 3 (zonage seul, modele) -> voie 4 (abstention).
   ============================================================ */

/* ============================================================
   1. CONFIG - LA SEULE SURFACE DE CALIBRATION
   Tous les seuils ici, nulle part ailleurs. C'est ce fichier
   qu'on ajuste apres la session de 30 parcelles.
   ============================================================ */
var CFG = {
  // Ensemble comparable
  RAYON_M: 800,              // si zonage absent, rayon geographique brut
  SIM_MIN: 0.6,              // parcelle comparable : 0.6x a 1.6x la contenance
  SIM_MAX: 1.6,
  N_MIN_COMPARABLES: 15,     // sous ce seuil, la voie 2 ne tranche pas

  // Seuils de taux (preuves / comparables)
  TAUX_ELEVE: 0.15,
  TAUX_PROBABLE: 0.05,
  TAUX_FAIBLE: 0.01,

  // Fraicheur des preuves (ans -> ponderation). Equivalent des 72h/48h de vizi.
  FRAIS_ANS: 3,   POIDS_FRAIS: 1.0,
  MOYEN_ANS: 6,   POIDS_MOYEN: 0.6,
  POIDS_VIEUX: 0.3,
  FENETRE_ANS: 10,           // au-dela, ignore

  // Vetos
  MIN_CONTENANCE_M2: 400,    // sous ca, division non credible en v0
  ZONES_VETO: ['A', 'N'],

  // Coupe-circuit PLU : preuves anterieures a la derniere revision = temoignage
  // sur des regles mortes. Equivalent du age_hours <= 72.
  PONDERER_AVANT_REVISION: true,
  POIDS_AVANT_REVISION: 0.0
};

/* Caches par voie : le moteur early-return, les voyants lisent ici. */
var S_banCache = null;
var S_parcelleCache = null;
var S_gpuCache = null;
var S_risquesCache = null;
var S_dvfCache = null;

/* ============================================================
   2. ADAPTATEURS
   Regle d'or : un adaptateur ne jette jamais. Il renvoie
   { status, data, note }. Une source morte allume un voyant
   rouge, elle ne casse pas l'analyse. C'est tout le principe.
   ============================================================ */

function jget(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

// --- BAN : adresse -> coordonnees. Source : api-adresse.data.gouv.fr
function banAutocomplete(q) {
  var u = 'https://api-adresse.data.gouv.fr/search/?q=' + encodeURIComponent(q) +
          '&limit=5&autocomplete=1';
  return jget(u).then(function (j) { return (j && j.features) || []; })
                .catch(function () { return []; });
}

// --- Cadastre : point -> parcelle. Source : apicarto.ign.fr
// contenance est en m2. idu = identifiant unique parcelle.
function fetchParcelle(lat, lon) {
  var geom = encodeURIComponent(JSON.stringify({ type: 'Point', coordinates: [lon, lat] }));
  return jget('https://apicarto.ign.fr/api/cadastre/parcelle?geom=' + geom)
    .then(function (j) {
      var f = j && j.features && j.features[0];
      if (!f) return (S_parcelleCache = { status: 'no_data', note: 'aucune parcelle a ce point' });
      var p = f.properties;
      return (S_parcelleCache = {
        status: 'ok',
        data: {
          idu: p.idu,
          section: p.section,
          numero: p.numero,
          contenance: p.contenance,
          insee: p.code_insee || (p.code_dep + p.code_com),
          commune: p.nom_com,
          geometry: f.geometry
        }
      });
    })
    .catch(function (e) { return (S_parcelleCache = { status: 'error', note: String(e.message) }); });
}

// --- GPU : zonage PLU. Source : apicarto.ign.fr/api/gpu
// typezone : U / AUc / AUs / A / N. datappro = date d'approbation du PLU.
// urlfic = lien vers le PDF du reglement -> la voie 1 est LA, non structuree.
function fetchZonage(geometry) {
  var geom = encodeURIComponent(JSON.stringify(geometry));
  return jget('https://apicarto.ign.fr/api/gpu/zone-urba?geom=' + geom)
    .then(function (j) {
      var f = j && j.features && j.features[0];
      if (!f) return (S_gpuCache = { status: 'no_data', note: 'commune non couverte par le GPU' });
      var p = f.properties;
      return (S_gpuCache = {
        status: 'ok',
        data: {
          libelle: p.libelle,
          libelong: p.libelong,
          typezone: p.typezone,
          datappro: p.datappro,     // AAAAMMJJ
          urlfic: p.urlfic          // PDF du reglement : voie 1 v1
        }
      });
    })
    .catch(function (e) { return (S_gpuCache = { status: 'error', note: String(e.message) }); });
}

// --- Georisques. Source : georisques.gouv.fr/api/v1
// v0 : on prend le rapport risques par coordonnees. Endpoint a verifier
// en console au premier run, l'API a bouge plusieurs fois.
function fetchRisques(lat, lon) {
  var u = 'https://georisques.gouv.fr/api/v1/resultats_rapport_risque?latlon=' + lon + ',' + lat;
  return jget(u)
    .then(function (j) { return (S_risquesCache = { status: 'ok', data: j }); })
    .catch(function (e) { return (S_risquesCache = { status: 'error', note: String(e.message) }); });
}

// --- DVF : mutations autour. Source : api.cquest.org/dvf (portage communautaire Etalab)
// Proxy v0 assume : une vente de terrain a batir = marche de la division actif.
// Ce n'est PAS "division aboutie" (qui demande de suivre les IDU dans le temps).
// Approximation DECLAREE, affichee dans le voyant. On la raffine apres.
function fetchDVF(lat, lon) {
  var u = 'https://api.cquest.org/dvf?lat=' + lat + '&lon=' + lon + '&dist=' + CFG.RAYON_M;
  return jget(u)
    .then(function (j) {
      var res = (j && j.resultats) || [];
      return (S_dvfCache = { status: res.length ? 'ok' : 'no_data', data: res });
    })
    .catch(function (e) { return (S_dvfCache = { status: 'error', note: String(e.message) }); });
}

/* ============================================================
   3. HELPERS DE MESURE
   ============================================================ */

function anneeDe(dateStr) {
  var y = parseInt(String(dateStr || '').slice(0, 4), 10);
  return isFinite(y) ? y : null;
}

function poidsFraicheur(annee, anneeRevisionPLU) {
  var now = new Date().getFullYear();
  var age = now - annee;
  if (age > CFG.FENETRE_ANS || age < 0) return 0;
  if (CFG.PONDERER_AVANT_REVISION && anneeRevisionPLU && annee < anneeRevisionPLU) {
    return CFG.POIDS_AVANT_REVISION;   // regles mortes
  }
  if (age <= CFG.FRAIS_ANS) return CFG.POIDS_FRAIS;
  if (age <= CFG.MOYEN_ANS) return CFG.POIDS_MOYEN;
  return CFG.POIDS_VIEUX;
}

// Une mutation est-elle une PREUVE de division ? Proxy v0.
function estPreuve(m) {
  var nat = String(m.nature_mutation || '').toLowerCase();
  if (nat.indexOf('terrain a batir') >= 0 || nat.indexOf('terrain à bâtir') >= 0) return true;
  // Terrain nu vendu : pas de local bati, mais une surface de terrain reelle.
  var sansLocal = !m.type_local && !m.code_type_local;
  var terrain = Number(m.surface_terrain || 0);
  return sansLocal && terrain > 0;
}

function construireComparables(dvf, contenance, anneeRevisionPLU) {
  var lo = contenance * CFG.SIM_MIN, hi = contenance * CFG.SIM_MAX;
  var comparables = [], preuves = 0, poids = 0;

  dvf.forEach(function (m) {
    var st = Number(m.surface_terrain || 0);
    if (!st || st < lo || st > hi) return;
    var an = anneeDe(m.date_mutation);
    if (!an) return;
    var w = poidsFraicheur(an, anneeRevisionPLU);
    if (w === 0) return;
    comparables.push(m);
    if (estPreuve(m)) { preuves++; poids += w; }
  });

  return {
    n: comparables.length,
    preuves: preuves,
    preuvesPonderees: poids,
    taux: comparables.length ? poids / comparables.length : 0
  };
}

/* ============================================================
   4. LE MOTEUR
   ============================================================ */
function computeParcelPotential(ctx) {
  var parcelle = ctx.parcelle, zonage = ctx.zonage, dvf = ctx.dvf;

  // ----- VETOS : early-return, jamais un malus -----
  if (!parcelle) {
    return verdict('Exclu', 'aucune', 'nulle', 'Parcelle introuvable a cette adresse.');
  }
  if (zonage && CFG.ZONES_VETO.indexOf(String(zonage.typezone || '').charAt(0)) >= 0) {
    return verdict('Exclu', 'veto', 'haute',
      'Zone ' + zonage.libelle + ' (' + zonage.typezone + '). La division a des fins de construction ' +
      'est exclue quel que soit le contexte de marche.');
  }
  if (parcelle.contenance < CFG.MIN_CONTENANCE_M2) {
    return verdict('Exclu', 'veto', 'haute',
      'Contenance de ' + parcelle.contenance + ' m2, sous le seuil de credibilite de ' +
      CFG.MIN_CONTENANCE_M2 + ' m2.');
  }

  // ----- VOIE 1 : reglement PLU structure -----
  // Non implementee en v0. Le PDF existe (zonage.urlfic) mais n'est pas
  // machine-readable. C'est le chantier v1, et c'est le seul actif non copiable.
  // Fall-through explicite, comme le strangler de vizi.

  // ----- VOIE 2 : COMPARABLES (mesure du reel) -----
  var anneeRev = zonage && zonage.datappro ? anneeDe(zonage.datappro) : null;
  if (dvf && dvf.length) {
    var c = construireComparables(dvf, parcelle.contenance, anneeRev);
    if (c.n >= CFG.N_MIN_COMPARABLES) {
      var conf = c.n >= 40 ? 'haute' : 'moyenne';
      var base = c.n + ' parcelles comparables (' + Math.round(parcelle.contenance * CFG.SIM_MIN) +
                 ' a ' + Math.round(parcelle.contenance * CFG.SIM_MAX) + ' m2) dans un rayon de ' +
                 CFG.RAYON_M + ' m. ' + c.preuves + ' operation(s) de terrain a batir, ' +
                 'taux pondere ' + (c.taux * 100).toFixed(0) + ' %.';

      // Le cas qui vaut de l'or : gros echantillon, zero preuve.
      // L'absence de signal EST un signal.
      if (c.preuves === 0 && c.n >= 40) {
        return verdict('Tres faible', 'comparables', 'haute',
          base + ' Aucune operation sur un echantillon de cette taille : le marche de la division ' +
          'est inexistant ici, ce n\'est pas une lacune de donnee.');
      }
      if (c.taux >= CFG.TAUX_ELEVE)    return verdict('Eleve', 'comparables', conf, base);
      if (c.taux >= CFG.TAUX_PROBABLE) return verdict('Probable', 'comparables', conf, base);
      if (c.taux >= CFG.TAUX_FAIBLE)   return verdict('Faible', 'comparables', conf, base);
      return verdict('Tres faible', 'comparables', conf, base);
    }
  }

  // ----- VOIE 3 : ZONAGE SEUL (modele, pas mesure) -----
  if (zonage && zonage.status !== 'no_data' && zonage.typezone) {
    var t = String(zonage.typezone).charAt(0);
    if (t === 'U') {
      return verdict('Probable', 'zonage', 'faible',
        'Zone ' + zonage.libelle + ', constructible. Comparables insuffisants pour mesurer le ' +
        'marche reel : verdict fonde sur le seul zonage, sans lecture du reglement. A confirmer.');
    }
    if (t === 'A' && zonage.typezone.length > 1) { // AU
      return verdict('Faible', 'zonage', 'faible',
        'Zone a urbaniser (' + zonage.typezone + '). Ouverture a l\'urbanisation conditionnee, ' +
        'hors de portee d\'une analyse automatique.');
    }
  }

  // ----- VOIE 4 : ABSTENTION -----
  return verdict('Indetermine', 'aucune', 'nulle',
    'Ni reglement structure, ni comparables en nombre suffisant, ni zonage exploitable. ' +
    'Le moteur s\'abstient plutot que de deviner.');
}

function verdict(valeur, voie, confiance, motif) {
  return { valeur: valeur, voie: voie, confiance: confiance, motif: motif };
}

/* ============================================================
   5. UI - LA CASCADE
   L'ecran d'etapes n'est PAS un chargement decoratif. C'est le
   raisonnement qui se donne a voir. Une voie qui echoue s'affiche
   en echec : le voyant rouge vaut plus cher que le vert.
   ============================================================ */
var UI = {};
UI.steps = [];

function stepAdd(titre) {
  var i = UI.steps.length;
  UI.steps.push({ titre: titre, etat: 'run', detail: '' });
  renderSteps();
  return i;
}
function stepSet(i, etat, detail) {
  UI.steps[i].etat = etat;
  UI.steps[i].detail = detail || '';
  renderSteps();
}
function renderSteps() {
  document.getElementById('steps').innerHTML = UI.steps.map(function (s) {
    return '<div class="step"><div class="voyant ' + s.etat + '"></div><div>' +
           '<div class="step-t">' + s.titre + '</div>' +
           (s.detail ? '<div class="step-d">' + s.detail + '</div>' : '') +
           '</div></div>';
  }).join('');
}

function show(id) {
  ['view-search', 'view-run', 'view-report'].forEach(function (v) {
    document.getElementById(v).classList.toggle('hidden', v !== id);
  });
}

/* ============================================================
   6. ORCHESTRATION
   ============================================================ */
function analyser(feature) {
  var lon = feature.geometry.coordinates[0];
  var lat = feature.geometry.coordinates[1];
  UI.steps = [];
  show('view-run');
  document.getElementById('run-sub').textContent = feature.properties.label;

  var s0 = stepAdd('Adresse resolue');
  stepSet(s0, 'ok', lat.toFixed(5) + ', ' + lon.toFixed(5) + ' - source BAN');

  var s1 = stepAdd('Identification de la parcelle');

  fetchParcelle(lat, lon).then(function (pc) {
    if (pc.status !== 'ok') {
      stepSet(s1, 'bad', pc.note || 'echec cadastre');
      return finir(null, null, null);
    }
    var p = pc.data;
    stepSet(s1, 'ok', p.section + '-' + p.numero + ', ' + p.contenance + ' m2, ' + p.commune);

    var s2 = stepAdd('Zonage d\'urbanisme');
    var s3 = stepAdd('Risques');
    var s4 = stepAdd('Comparables de marche');

    return Promise.all([
      fetchZonage(p.geometry).then(function (z) {
        if (z.status === 'ok') {
          stepSet(s2, 'ok', z.data.typezone + ' - ' + z.data.libelle +
            (z.data.datappro ? ' - PLU approuve ' + z.data.datappro : ''));
          var s2b = stepAdd('Reglement PLU');
          stepSet(s2b, 'warn', z.data.urlfic
            ? 'PDF present, non structure - voie 1 indisponible'
            : 'aucun reglement publie - voie 1 indisponible');
        } else {
          stepSet(s2, 'warn', z.note || 'commune non couverte par le GPU');
        }
        return z;
      }),
      fetchRisques(lat, lon).then(function (r) {
        stepSet(s3, r.status === 'ok' ? 'ok' : 'warn', r.status === 'ok' ? 'Georisques interroge' : (r.note || 'indisponible'));
        return r;
      }),
      fetchDVF(lat, lon).then(function (d) {
        if (d.status === 'ok') {
          stepSet(s4, 'ok', d.data.length + ' mutations dans ' + CFG.RAYON_M + ' m - DVF (proxy terrain a batir)');
        } else {
          stepSet(s4, 'bad', d.note || 'DVF indisponible - voie 2 impossible');
        }
        return d;
      })
    ]).then(function (res) {
      finir(p, res[0].status === 'ok' ? res[0].data : null, res[2].data || []);
    });
  });
}

function finir(parcelle, zonage, dvf) {
  var v = computeParcelPotential({ parcelle: parcelle, zonage: zonage, dvf: dvf });
  var s = stepAdd('Verdict');
  stepSet(s, v.voie === 'aucune' ? 'warn' : 'ok',
    'voie gagnante : ' + v.voie + ' - confiance ' + v.confiance);
  setTimeout(function () { renderReport(parcelle, zonage, v); }, 500);
}

function renderReport(parcelle, zonage, v) {
  var cls = v.valeur.toLowerCase().replace(/\s+/g, '-').replace(/é/g, 'e');
  var html = '<h1>Etude foncière</h1>' +
    '<p class="sub">' + (parcelle ? parcelle.section + '-' + parcelle.numero + ' - ' +
      parcelle.contenance + ' m2 - ' + parcelle.commune : 'Parcelle non identifiee') + '</p>' +
    '<div class="verdict ' + cls + '">' +
      '<h3>Potentiel de division parcellaire' +
        '<span class="tag">voie ' + v.voie + '</span>' +
        '<span class="tag">confiance ' + v.confiance + '</span></h3>' +
      '<div class="val">' + v.valeur + '</div>' +
      '<div class="why">' + v.motif + '</div>' +
    '</div>' +
    '<div class="card"><div class="step-t" style="margin-bottom:10px">Traçabilité</div>' +
      UI.steps.map(function (s) {
        return '<div class="step"><div class="voyant ' + s.etat + '"></div><div>' +
               '<div class="step-t">' + s.titre + '</div>' +
               '<div class="step-d">' + (s.detail || '-') + '</div></div></div>';
      }).join('') +
    '</div>';
  document.getElementById('report').innerHTML = html;
  show('view-report');
}

/* ============================================================
   7. BINDINGS
   ============================================================ */
(function () {
  var input = document.getElementById('addr');
  var ac = document.getElementById('ac');
  var go = document.getElementById('go');
  var choix = null, t = null;

  input.addEventListener('input', function () {
    choix = null; go.disabled = true;
    clearTimeout(t);
    var q = input.value.trim();
    if (q.length < 4) { ac.classList.add('hidden'); return; }
    t = setTimeout(function () {
      banAutocomplete(q).then(function (feats) {
        if (!feats.length) { ac.classList.add('hidden'); return; }
        ac.innerHTML = feats.map(function (f, i) {
          return '<div class="ac-item" data-i="' + i + '">' + f.properties.label + '</div>';
        }).join('');
        ac.classList.remove('hidden');
        Array.prototype.forEach.call(ac.children, function (el) {
          el.onclick = function () {
            choix = feats[+el.dataset.i];
            input.value = choix.properties.label;
            ac.classList.add('hidden');
            go.disabled = false;
          };
        });
      });
    }, 180);
  });

  go.onclick = function () { if (choix) analyser(choix); };
})();
