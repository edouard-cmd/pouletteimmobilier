/* ============================================================
   foncier-app.js - v0.3
   Doctrine en cascade, transposee de computeVisibilityScore_V4.
   Le moteur ne renvoie que la voie GAGNANTE (early-return), mais
   chaque adaptateur ecrit son etat dans son cache pour que les
   voyants s'allument independamment.
   Ordre : vetos -> voie 1 (reglement, v1) -> voie 2 (comparables,
   mesure du reel) -> voie 3 (zonage seul, modele) -> voie 4 (abstention).

   v0.2 : correction du veto qui avalait les zones AU.
   v0.4 : discriminateur lotissement. Le proxy "vente de terrain a
          batir" etait INVERSE sur les lots de lotissement : la
          commercialisation d'un lotissement (= parcelles definitives)
          etait lue comme un marche de la division actif. Deux
          detecteurs independants, cf. section 3bis.
   v0.3 : abandon de api.cquest.org (POC communautaire, http seul,
          dispo non garantie) au profit du DVF geolocalise officiel
          d'Etalab, en CSV statique par commune :
          files.data.gouv.fr/geo-dvf/latest/csv/{annee}/communes/{dep}/{insee}.csv
          Ajout du dedoublonnage par id_mutation (une vente genere
          plusieurs lignes : Appartement + Dependance + ...).
   ============================================================ */

/* ============================================================
   1. CONFIG - LA SEULE SURFACE DE CALIBRATION
   Tous les seuils ici, nulle part ailleurs.
   ============================================================ */
var CFG = {
  // Passe-plat DVF (dvf-proxy.gs). files.data.gouv.fr n'envoie AUCUN
  // en-tete CORS : le navigateur ne peut pas lire les CSV directement,
  // quelle que soit l'origine. Colle ici ton URL /exec de deploiement GAS.
  GAS_URL: 'https://script.google.com/macros/s/AKfycbzmai25INh-quLHyZPRKM-IfljSKLNm6sneWg4m0atQaXnf9-ld0srNr92p7M52Apnk/exec',

  // Millesimes disponibles dans geo-dvf/latest. A bumper aux publications.
  // NB : la liste fait foi cote GAS (var ANNEES), celle-ci n'est plus
  // qu'un libelle pour les voyants.
  ANNEES: [2021, 2022, 2023, 2024, 2025],

  // Ensemble comparable
  RAYON_M: 800,
  SIM_MIN: 0.6,              // parcelle comparable : 0.6x a 1.6x la contenance
  SIM_MAX: 1.6,
  N_MIN_COMPARABLES: 15,     // sous ce seuil, la voie 2 ne tranche pas

  // Seuils de taux (preuves ponderees / comparables)
  TAUX_ELEVE: 0.15,
  TAUX_PROBABLE: 0.05,
  TAUX_FAIBLE: 0.01,

  // Echantillon au-dela duquel l'absence de preuve devient un signal
  N_ABSENCE_SIGNIFICATIVE: 40,

  // Fraicheur des preuves (ans -> ponderation). Equivalent des 72h/48h de vizi.
  FRAIS_ANS: 3,   POIDS_FRAIS: 1.0,
  MOYEN_ANS: 6,   POIDS_MOYEN: 0.6,
  POIDS_VIEUX: 0.3,
  FENETRE_ANS: 10,

  // --- Discriminateur lotissement ---
  // Signal A (cadastre, independant de la date) : des lots de lotissement
  // portent des numeros consecutifs dans la meme section, avec des
  // contenances homogenes. Une division organique ne produit jamais ca.
  LOT_RAYON_M: 250,          // fenetre cadastrale autour de la parcelle
  LOT_ECART_NUM: 25,         // ecart max de numero pour etre "du meme paquet"
  LOT_VOISINS_MIN: 8,        // en dessous, pas de presomption
  // La bande de similarite est le coeur du detecteur : on ne demande pas
  // "ce paquet est-il homogene ?" (deux lotissements voisins de tailles
  // differentes le font echouer) mais "combien de parcelles RESSEMBLENT A
  // LA MIENNE juste a cote ?". Teste sur Bernieres AH : sans la bande, le
  // Camp de l'Ile (~670 m2) etait melange a l'operation voisine (~270 m2)
  // -> dispersion 39 %. Avec la bande : 16 lots, dispersion 1 %.
  LOT_SIM_MIN: 0.75,
  LOT_SIM_MAX: 1.35,
  LOT_CV_MAX: 0.25,          // dispersion residuelle DANS la bande

  // Signal B (DVF) : plusieurs ventes de terrain a batir groupees dans le
  // temps ET dans la meme section = commercialisation d'un lotissement.
  // Ces mutations ne sont PAS des preuves de division : on les retire.
  LOTDVF_N_MIN: 4,
  LOTDVF_FENETRE_MOIS: 36,

  // Vetos
  MIN_CONTENANCE_M2: 400,
  ZONES_VETO: ['A', 'N'],    // NB : AU est traite AVANT ce test, cf. moteur

  // Coupe-circuit PLU : preuves anterieures a la derniere revision =
  // temoignage sur des regles mortes. Equivalent du age_hours <= 72.
  PONDERER_AVANT_REVISION: true,
  POIDS_AVANT_REVISION: 0.0
};

/* Caches par voie : le moteur early-return, les voyants lisent ici. */
var S_parcelleCache = null;
var S_gpuCache = null;
var S_risquesCache = null;
var S_dvfCache = null;

/* ============================================================
   2. ADAPTATEURS
   Regle d'or : un adaptateur ne jette jamais. Il renvoie
   { status, data, note }. Une source morte allume un voyant
   rouge, elle ne casse pas l'analyse.
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
          insee: p.code_insee || ((p.code_dep || '') + (p.code_com || '')),
          commune: p.nom_com,
          geometry: f.geometry
        }
      });
    })
    .catch(function (e) { return (S_parcelleCache = { status: 'error', note: String(e.message) }); });
}

// --- Voisinage cadastral : toutes les parcelles autour du point.
// Sert au detecteur de lotissement (signal A). Meme service que
// fetchParcelle, mais avec un Polygon au lieu d'un Point.
var S_voisinageCache = null;

function fetchVoisinage(lat, lon) {
  var r = CFG.LOT_RAYON_M;
  var dLat = r / 111320;
  var dLon = r / (111320 * Math.cos(lat * Math.PI / 180));
  var poly = {
    type: 'Polygon',
    coordinates: [[
      [lon - dLon, lat - dLat], [lon + dLon, lat - dLat],
      [lon + dLon, lat + dLat], [lon - dLon, lat + dLat],
      [lon - dLon, lat - dLat]
    ]]
  };
  var geom = encodeURIComponent(JSON.stringify(poly));
  return jget('https://apicarto.ign.fr/api/cadastre/parcelle?geom=' + geom + '&_limit=500')
    .then(function (j) {
      var f = (j && j.features) || [];
      return (S_voisinageCache = {
        status: f.length ? 'ok' : 'no_data',
        data: f.map(function (x) {
          return {
            idu: x.properties.idu,
            section: x.properties.section,
            numero: x.properties.numero,
            contenance: Number(x.properties.contenance || 0)
          };
        })
      });
    })
    .catch(function (e) { return (S_voisinageCache = { status: 'error', note: String(e.message), data: [] }); });
}

// --- GPU : zonage PLU. Source : apicarto.ign.fr/api/gpu
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
          partition: p.partition,   // DU_14066 -> cle d'acces au reglement via GPU
          urlfic: p.urlfic          // souvent vide : NE PAS en deduire l'absence de reglement
        }
      });
    })
    .catch(function (e) { return (S_gpuCache = { status: 'error', note: String(e.message) }); });
}

// --- Reglement PLU via le GPU, a travers le passe-plat GAS.
// L'API du GPU se declare "usage avant tout interne" dans sa propre spec :
// pas de CORS garanti. La chaine est /document?partition= -> /details.
// ATTENTION : ceci recupere le PDF, PAS les regles. La voie 1 exige de
// structurer le texte (emprise au sol, reculs, facade sur voie) : c'est
// le vrai chantier, et c'est ce que personne n'a fait a l'echelle.
var S_pluCache = null;

function fetchPLU(partition) {
  if (!partition) {
    return Promise.resolve((S_pluCache = { status: 'no_data', note: 'aucune partition dans le zonage' }));
  }
  if (!CFG.GAS_URL || CFG.GAS_URL.indexOf('COLLE_ICI') === 0) {
    return Promise.resolve((S_pluCache = { status: 'error', note: 'CFG.GAS_URL non configure' }));
  }
  return jget(CFG.GAS_URL + '?action=plu&partition=' + encodeURIComponent(partition))
    .then(function (j) { return (S_pluCache = j); })
    .catch(function (e) { return (S_pluCache = { status: 'error', note: 'passe-plat injoignable : ' + e.message }); });
}

// --- Georisques. Source : georisques.gouv.fr/api/v1
function fetchRisques(lat, lon) {
  var u = 'https://georisques.gouv.fr/api/v1/resultats_rapport_risque?latlon=' + lon + ',' + lat;
  return jget(u)
    .then(function (j) { return (S_risquesCache = { status: 'ok', data: j }); })
    .catch(function (e) { return (S_risquesCache = { status: 'error', note: String(e.message) }); });
}

/* ------------------------------------------------------------
   DVF GEOLOCALISE OFFICIEL (Etalab / DGFiP) via passe-plat GAS
   Le navigateur ne peut PAS lire files.data.gouv.fr : aucun en-tete
   CORS n'est envoye, quelle que soit l'origine. dvf-proxy.gs telecharge
   les millesimes, filtre le rayon, dedoublonne par id_mutation et
   renvoie du JSON compact.
   Colonnes verifiees sur donnees reelles : id_mutation, date_mutation,
   nature_mutation, id_parcelle, type_local, code_nature_culture,
   surface_terrain, longitude, latitude.
   ------------------------------------------------------------ */

function fetchDVF(insee, lat, lon) {
  if (!CFG.GAS_URL || CFG.GAS_URL.indexOf('COLLE_ICI') === 0) {
    return Promise.resolve(
      (S_dvfCache = { status: 'error', note: 'CFG.GAS_URL non configure - voie 2 impossible', data: [] })
    );
  }
  var u = CFG.GAS_URL + '?insee=' + encodeURIComponent(insee) +
          '&lat=' + lat + '&lon=' + lon + '&dist=' + CFG.RAYON_M;
  return jget(u)
    .then(function (j) {
      return (S_dvfCache = {
        status: j.status || 'error',
        data: j.data || [],
        note: j.note || ''
      });
    })
    .catch(function (e) {
      return (S_dvfCache = { status: 'error', note: 'passe-plat injoignable : ' + e.message, data: [] });
    });
}

/* ============================================================
   3. HELPERS DE MESURE
   ============================================================ */

function anneeDe(dateStr) {
  var y = parseInt(String(dateStr || '').slice(0, 4), 10);
  return isFinite(y) ? y : null;
}

function poidsFraicheur(annee, anneeRevisionPLU) {
  var age = new Date().getFullYear() - annee;
  if (age > CFG.FENETRE_ANS || age < 0) return 0;
  if (CFG.PONDERER_AVANT_REVISION && anneeRevisionPLU && annee < anneeRevisionPLU) {
    return CFG.POIDS_AVANT_REVISION;   // regles mortes
  }
  if (age <= CFG.FRAIS_ANS) return CFG.POIDS_FRAIS;
  if (age <= CFG.MOYEN_ANS) return CFG.POIDS_MOYEN;
  return CFG.POIDS_VIEUX;
}

// Une mutation est-elle une PREUVE ? Deux signaux verifies sur donnees reelles :
//   - nature_mutation = "Vente terrain a batir"
//   - code_nature_culture = 'AB' (nature_culture = "terrains a batir")
// Proxy ASSUME : marche du terrain a batir actif, pas "division aboutie"
// (qui demanderait de suivre les id_parcelle dans le temps). Chantier v1.
function estPreuve(m) {
  var nat = String(m.nature_mutation || '').toLowerCase();
  if (nat.indexOf('terrain à bâtir') >= 0 || nat.indexOf('terrain a batir') >= 0) return true;
  if (String(m.code_nature_culture || '').toUpperCase() === 'AB') return true;
  return false;
}

function construireComparables(dvf, contenance, anneeRevisionPLU, idsExclus) {
  var lo = contenance * CFG.SIM_MIN, hi = contenance * CFG.SIM_MAX;
  var exclus = {};
  (idsExclus || []).forEach(function (id) { exclus[id] = 1; });
  var n = 0, preuves = 0, poids = 0, retirees = 0, retenues = [];

  dvf.forEach(function (m) {
    var st = Number(m.surface_terrain || 0);
    if (!st || st < lo || st > hi) return;
    var an = anneeDe(m.date_mutation);
    if (!an) return;
    var w = poidsFraicheur(an, anneeRevisionPLU);
    if (w === 0) return;
    n++;
    if (!estPreuve(m)) return;
    if (exclus[m.id_mutation]) { retirees++; return; }   // lotissement : pas une preuve
    preuves++; poids += w; retenues.push(m);
  });

  return { n: n, preuves: preuves, taux: n ? poids / n : 0, retirees: retirees, retenues: retenues };
}

/* ============================================================
   3bis. DISCRIMINATEUR LOTISSEMENT
   Pourquoi : "vente de terrain a batir" est un signal AMBIGU.
   - division organique -> preuve que le secteur se divise
   - commercialisation d'un lotissement -> preuve du CONTRAIRE :
     ces parcelles sont des produits finis, dimensionnes pour rester
     tels quels. Les compter comme preuves INVERSE le verdict.
   Deux detecteurs independants, car ils couvrent des angles morts
   differents : le signal DVF ne voit rien avant 2021, le signal
   cadastral est intemporel.
   ============================================================ */

// id_parcelle CNIG : INSEE(5) + prefixe(3) + section(2) + numero(4)
// "14066000AH0406" -> section "AH", numero 406
function sectionDe(idu) { return String(idu || '').slice(8, 10); }
function numeroDe(idu) { return parseInt(String(idu || '').slice(10, 14), 10); }

function coefVariation(vals) {
  if (vals.length < 2) return 999;
  var moy = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
  if (!moy) return 999;
  var v = vals.reduce(function (a, b) { return a + (b - moy) * (b - moy); }, 0) / vals.length;
  return Math.sqrt(v) / moy;
}

/* --- SIGNAL A : le cadastre. Intemporel.
   Un lotissement = numeros consecutifs, meme section, contenances
   homogenes. Une division organique ne produit jamais ce motif.
   Renvoie null (pas de presomption) ou un objet de constat. --- */
function detecterLotissementCadastral(voisines, parcelle) {
  if (!voisines || !voisines.length || !parcelle) return null;
  var sec = parcelle.section;
  var num = parseInt(parcelle.numero, 10);
  var ref = Number(parcelle.contenance || 0);
  if (!sec || !isFinite(num) || !ref) return null;

  var lo = ref * CFG.LOT_SIM_MIN, hi = ref * CFG.LOT_SIM_MAX;

  // Meme section + numero proche + contenance comparable A LA MIENNE.
  // La bande de similarite evite de melanger deux operations mitoyennes.
  var paquet = voisines.filter(function (v) {
    var n = parseInt(v.numero, 10);
    return v.section === sec && isFinite(n) &&
           Math.abs(n - num) <= CFG.LOT_ECART_NUM &&
           v.contenance >= lo && v.contenance <= hi;
  });
  if (paquet.length < CFG.LOT_VOISINS_MIN) return null;

  var cs = paquet.map(function (v) { return v.contenance; });
  var cv = coefVariation(cs);
  if (cv > CFG.LOT_CV_MAX) return null;

  var moy = cs.reduce(function (a, b) { return a + b; }, 0) / cs.length;
  var nums = paquet.map(function (v) { return parseInt(v.numero, 10); }).sort(function (a, b) { return a - b; });
  return {
    n: paquet.length, cv: cv, moyenne: Math.round(moy), section: sec,
    plage: nums[0] + '-' + nums[nums.length - 1]
  };
}

/* --- SIGNAL B : DVF. Ne voit rien avant 2021, mais precis quand il voit.
   Plusieurs ventes de terrain a batir groupees dans le temps ET dans la
   meme section = commercialisation. On retire ces mutations des preuves. --- */
function detecterLotissementsDVF(preuves) {
  var parSection = {};
  preuves.forEach(function (m) {
    var sec = sectionDe(m.id_parcelle);
    if (!sec) return;
    (parSection[sec] = parSection[sec] || []).push(m);
  });

  var operations = [];
  Object.keys(parSection).forEach(function (sec) {
    var ms = parSection[sec];
    if (ms.length < CFG.LOTDVF_N_MIN) return;
    var ts = ms.map(function (m) { return new Date(m.date_mutation).getTime(); })
               .filter(function (t) { return isFinite(t); }).sort();
    if (ts.length < CFG.LOTDVF_N_MIN) return;
    var moisEcoules = (ts[ts.length - 1] - ts[0]) / (1000 * 3600 * 24 * 30.44);
    if (moisEcoules > CFG.LOTDVF_FENETRE_MOIS) return;   // etale : organique
    operations.push({ section: sec, n: ms.length, mois: Math.round(moisEcoules), ids: ms.map(function (m) { return m.id_mutation; }) });
  });
  return operations;
}

/* ============================================================
   4. LE MOTEUR
   ============================================================ */
function computeParcelPotential(ctx) {
  var parcelle = ctx.parcelle, zonage = ctx.zonage, dvf = ctx.dvf || [];
  var voisines = ctx.voisines || [];

  // ----- VETOS : early-return, jamais un malus -----
  if (!parcelle) {
    return verdict('Exclu', 'aucune', 'nulle', 'Parcelle introuvable a cette adresse.');
  }

  // AU se teste sur DEUX caracteres, AVANT le test A/N sur un seul.
  // Sinon "AUc" -> charAt(0) = 'A' -> veto agricole a tort.
  var tz = String((zonage && zonage.typezone) || '');
  var estAU = tz.slice(0, 2).toUpperCase() === 'AU';

  if (zonage && !estAU && CFG.ZONES_VETO.indexOf(tz.charAt(0).toUpperCase()) >= 0) {
    return verdict('Exclu', 'veto', 'haute',
      'Zone ' + (zonage.libelle || tz) + ' (' + tz + '). La division a des fins de construction ' +
      'est exclue quel que soit le contexte de marche.');
  }
  if (parcelle.contenance < CFG.MIN_CONTENANCE_M2) {
    return verdict('Exclu', 'veto', 'haute',
      'Contenance de ' + parcelle.contenance + ' m2, sous le seuil de credibilite de ' +
      CFG.MIN_CONTENANCE_M2 + ' m2.');
  }

  // ----- VOIE 1 : reglement PLU structure -----
  // Non implementee en v0. Le PDF existe (zonage.urlfic) mais n'est pas
  // machine-readable. Chantier v1, et seul actif non copiable.
  // Fall-through explicite, comme le strangler de vizi.

  // ----- DISCRIMINATEUR LOTISSEMENT -----
  // Tourne AVANT la voie 2 : il conditionne la lecture des preuves.
  // Le signal cadastral ne depend PAS de DVF : il doit pouvoir trancher
  // meme sans une seule mutation. (Bug v0.5 : il etait enferme dans le
  // bloc DVF et un lot repartait en "Probable" quand DVF etait vide.)
  var lotCad = detecterLotissementCadastral(voisines, parcelle);
  var preuvesBrutes = dvf.filter(estPreuve);
  var opsDVF = detecterLotissementsDVF(preuvesBrutes);
  var idsLot = [];
  opsDVF.forEach(function (o) { idsLot = idsLot.concat(o.ids); });

  var anneeRev = (zonage && zonage.datappro) ? anneeDe(zonage.datappro) : null;
  var c = dvf.length ? construireComparables(dvf, parcelle.contenance, anneeRev, idsLot) : null;

  var noteLot = '';
  if (c && c.retirees > 0) {
    noteLot = ' ' + c.retirees + ' vente(s) ecartee(s) : commercialisation de lotissement detectee (' +
              opsDVF.map(function (o) { return o.n + ' lots section ' + o.section + ' en ' + o.mois + ' mois'; }).join(', ') +
              '), ce n\'est pas un marche de la division.';
  }

  // Presomption forte : la parcelle est elle-meme un lot de lotissement.
  // Independante de DVF. Ce n'est PAS un veto : depuis la loi ALUR, les
  // regles d'urbanisme du lotissement deviennent caduques 10 ans apres
  // l'autorisation de lotir (art. L442-9 c. urb.) quand la commune a un PLU.
  // MAIS le cahier des charges, contractuel entre colotis, survit
  // indefiniment et ne figure dans aucune base publique. D'ou : presomption
  // + renvoi au notaire, jamais une certitude.
  if (lotCad) {
    return verdict('Faible', 'lotissement', 'moyenne',
      'Presomption de lot de lotissement : ' + lotCad.n + ' parcelles de taille comparable a ' +
      'numeros consecutifs en section ' + lotCad.section + ' (' + lotCad.plage + '), moyenne ' +
      lotCad.moyenne + ' m2, dispersion ' + (lotCad.cv * 100).toFixed(0) + ' %. Un lot est un ' +
      'produit fini, dimensionne pour rester tel quel.' + noteLot + ' A VERIFIER CHEZ LE NOTAIRE : ' +
      'le cahier des charges du lotissement peut interdire la division independamment du PLU, ' +
      'et ne figure dans aucune base publique.');
  }

  // ----- VOIE 2 : COMPARABLES (mesure du reel) -----
  if (c && c.n >= CFG.N_MIN_COMPARABLES) {
    // La confiance ne mesure plus SEULEMENT la taille de l'echantillon :
    // un signal ambigu la plafonne. Une confiance haute sur un verdict
    // potentiellement inverse est pire qu'une confiance faible sur un
    // verdict juste.
    var conf = c.n >= CFG.N_ABSENCE_SIGNIFICATIVE ? 'haute' : 'moyenne';
    if (c.retirees > 0 && conf === 'haute') conf = 'moyenne';

    var base = c.n + ' mutations comparables (' + Math.round(parcelle.contenance * CFG.SIM_MIN) +
               ' a ' + Math.round(parcelle.contenance * CFG.SIM_MAX) + ' m2) dans un rayon de ' +
               CFG.RAYON_M + ' m. ' + c.preuves + ' vente(s) de terrain a batir, ' +
               'taux pondere ' + (c.taux * 100).toFixed(0) + ' %.' + noteLot;

    // Le cas qui vaut de l'or : gros echantillon, zero preuve.
    // L'absence de signal EST un signal.
    if (c.preuves === 0 && c.n >= CFG.N_ABSENCE_SIGNIFICATIVE) {
      return verdict('Tres faible', 'comparables', conf,
        base + ' Aucune operation sur un echantillon de cette taille : le marche de la division ' +
        'est inexistant ici. Ce n\'est pas une lacune de donnee, c\'est un resultat.');
    }
    if (c.taux >= CFG.TAUX_ELEVE)    return verdict('Eleve', 'comparables', conf, base);
    if (c.taux >= CFG.TAUX_PROBABLE) return verdict('Probable', 'comparables', conf, base);
    if (c.taux >= CFG.TAUX_FAIBLE)   return verdict('Faible', 'comparables', conf, base);
    return verdict('Tres faible', 'comparables', conf, base);
  }

  // ----- VOIE 3 : ZONAGE SEUL (modele, pas mesure) -----
  if (tz) {
    if (estAU) {
      return verdict('Faible', 'zonage', 'faible',
        'Zone a urbaniser (' + tz + '). L\'ouverture a l\'urbanisation est conditionnee ' +
        '(OAP, equipements, modification du PLU) : hors de portee d\'une analyse automatique.');
    }
    if (tz.charAt(0).toUpperCase() === 'U') {
      return verdict('Probable', 'zonage', 'faible',
        'Zone ' + (zonage.libelle || tz) + ', constructible. Comparables insuffisants pour mesurer ' +
        'le marche reel : verdict fonde sur le seul zonage, sans lecture du reglement. A confirmer.');
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
var UI = { steps: [], pluUrl: null, pluNom: null };

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
function stepsHtml() {
  return UI.steps.map(function (s) {
    return '<div class="step"><div class="voyant ' + s.etat + '"></div><div>' +
           '<div class="step-t">' + s.titre + '</div>' +
           (s.detail ? '<div class="step-d">' + s.detail + '</div>' : '') +
           '</div></div>';
  }).join('');
}
function renderSteps() {
  document.getElementById('steps').innerHTML = stepsHtml();
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
  UI.steps = []; UI.pluUrl = null; UI.pluNom = null;
  show('view-run');
  document.getElementById('run-sub').textContent = feature.properties.label;

  var s0 = stepAdd('Adresse resolue');
  stepSet(s0, 'ok', lat.toFixed(5) + ', ' + lon.toFixed(5) + ' - source BAN');

  var s1 = stepAdd('Identification de la parcelle');

  fetchParcelle(lat, lon).then(function (pc) {
    if (pc.status !== 'ok') {
      stepSet(s1, 'bad', pc.note || 'echec cadastre');
      return finir(null, null, [], []);
    }
    var p = pc.data;
    stepSet(s1, 'ok', p.section + '-' + p.numero + ', ' + p.contenance + ' m2, ' +
      p.commune + ' (' + p.insee + ')');

    var s2 = stepAdd('Zonage d\'urbanisme');
    var s3 = stepAdd('Risques');
    var s4 = stepAdd('Comparables de marche');
    var s5 = stepAdd('Contexte parcellaire');

    return Promise.all([
      fetchZonage(p.geometry).then(function (z) {
        if (z.status === 'ok') {
          stepSet(s2, 'ok', z.data.typezone + ' - ' + (z.data.libelle || '') +
            (z.data.datappro ? ' - PLU approuve ' + z.data.datappro : ''));
          var s2b = stepAdd('Reglement PLU');
          fetchPLU(z.data.partition).then(function (pl) {
            var d = pl && pl.data;
            if (pl && pl.status === 'ok' && d) {
              var opposable = d.legalStatus === 'APPROVED';
              stepSet(s2b, 'warn', d.type + ' ' + d.originalName + ' - ' +
                (opposable ? 'opposable' : 'NON OPPOSABLE (' + d.legalStatus + ')') +
                ' - reglement trouve : ' + d.reglement + ' - PDF non structure, voie 1 indisponible');
              UI.pluUrl = d.reglementUrl;
              UI.pluNom = d.reglement;
            } else if (pl && pl.status === 'no_reglement') {
              stepSet(s2b, 'bad', (pl.note || '') + ' - le document existe mais ne contient pas de reglement ecrit');
            } else if (pl && d && d.rnu) {
              stepSet(s2b, 'bad', 'commune au reglement national d\'urbanisme : pas de PLU');
            } else {
              stepSet(s2b, 'bad', (pl && pl.note) || 'reglement introuvable');
            }
          });
        } else {
          stepSet(s2, 'warn', z.note || 'commune non couverte par le GPU');
        }
        return z;
      }),
      fetchRisques(lat, lon).then(function (r) {
        stepSet(s3, r.status === 'ok' ? 'ok' : 'warn',
          r.status === 'ok' ? 'Georisques interroge' : (r.note || 'indisponible'));
        return r;
      }),
      fetchDVF(p.insee, lat, lon).then(function (d) {
        if (d.status === 'ok') {
          stepSet(s4, 'ok', d.note + ' - DVF geolocalise Etalab ' +
            CFG.ANNEES[0] + '-' + CFG.ANNEES[CFG.ANNEES.length - 1]);
        } else {
          stepSet(s4, 'bad', d.note || 'DVF indisponible - voie 2 impossible');
        }
        return d;
      }),
      fetchVoisinage(lat, lon).then(function (v) {
        if (v.status === 'ok') {
          var lot = detecterLotissementCadastral(v.data, p);
          stepSet(s5, lot ? 'warn' : 'ok', v.data.length + ' parcelles dans ' + CFG.LOT_RAYON_M + ' m - ' +
            (lot ? 'LOTISSEMENT PRESUME : ' + lot.n + ' lots section ' + lot.section + ' ' + lot.plage +
                   ', moyenne ' + lot.moyenne + ' m2, dispersion ' + (lot.cv * 100).toFixed(0) + ' %'
                 : 'tissu heterogene, pas de motif de lotissement'));
        } else {
          stepSet(s5, 'warn', v.note || 'voisinage cadastral indisponible - discriminateur aveugle');
        }
        return v;
      })
    ]).then(function (res) {
      finir(p, res[0].status === 'ok' ? res[0].data : null,
            (res[2] && res[2].data) || [], (res[3] && res[3].data) || []);
    });
  });
}

function finir(parcelle, zonage, dvf, voisines) {
  var v = computeParcelPotential({ parcelle: parcelle, zonage: zonage, dvf: dvf, voisines: voisines });
  var s = stepAdd('Verdict');
  stepSet(s, v.voie === 'aucune' ? 'warn' : 'ok',
    'voie gagnante : ' + v.voie + ' - confiance ' + v.confiance);
  setTimeout(function () { renderReport(parcelle, v); }, 500);
}

function renderReport(parcelle, v) {
  var cls = v.valeur.toLowerCase().replace(/\s+/g, '-');
  document.getElementById('report').innerHTML =
    '<h1>Etude fonciere</h1>' +
    '<p class="sub">' + (parcelle
      ? parcelle.section + '-' + parcelle.numero + ' - ' + parcelle.contenance + ' m2 - ' + parcelle.commune
      : 'Parcelle non identifiee') + '</p>' +
    '<div class="verdict ' + cls + '">' +
      '<h3>Potentiel de division parcellaire' +
        '<span class="tag">voie ' + v.voie + '</span>' +
        '<span class="tag">confiance ' + v.confiance + '</span></h3>' +
      '<div class="val">' + v.valeur + '</div>' +
      '<div class="why">' + v.motif + '</div>' +
    '</div>' +
    '<div class="card"><div class="step-t" style="margin-bottom:10px">Tracabilite</div>' +
      stepsHtml() +
      (UI.pluUrl
        ? '<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line)">' +
          '<div class="step-t">Piece a verifier</div>' +
          '<div class="step-d" style="margin-top:4px">Reglement non lu par le moteur. ' +
          '<a href="' + UI.pluUrl + '" target="_blank" rel="noopener">' + UI.pluNom + '</a></div></div>'
        : '') +
    '</div>';
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
