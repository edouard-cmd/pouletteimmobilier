<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ce terrain se divise-t-il ?</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;800&family=Instrument+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    /* Bleu et blanc. Le bleu est franc et administratif, jamais violet. */
    --encre:      #0A2342;   /* texte, navy profond */
    --encre-doux: #5A6E8C;   /* texte secondaire */
    --bleu:       #1B4DB1;   /* accent, actions */
    --bleu-clair: #E9EFFA;   /* aplats */
    --trait:      #CBD9EE;   /* filets, bordures : la ligne cadastrale */
    --papier:     #FCFDFF;   /* fond */
    --blanc:      #FFFFFF;

    /* Signaux fonctionnels : volontairement hors palette, ils doivent
       trancher sur le bleu sans jamais s'y fondre. */
    --ok:   #0F7B52;
    --warn: #B45309;
    --bad:  #B3261E;
    --idle: #B9C6DA;

    --display: "Archivo", system-ui, sans-serif;
    --texte:   "Instrument Sans", system-ui, sans-serif;
    --mono:    "IBM Plex Mono", ui-monospace, Menlo, monospace;
  }

  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    background: var(--papier);
    color: var(--encre);
    font-family: var(--texte);
    font-size: 16px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--bleu); }

  .wrap { max-width: 760px; margin: 0 auto; padding: 0 24px; }

  /* ---------- ACCUEIL ---------- */
  #view-search { position: relative; overflow: hidden; }
  .hero { position: relative; padding: 110px 0 96px; }

  /* SIGNATURE : extrait cadastral. Une voie, une serie de lots aux numeros
     consecutifs, l'un surligne. C'est exactement le motif que le moteur
     detecte : le decor dit ce que fait le produit. */
  .plan {
    position: absolute; top: -40px; right: -140px;
    width: 620px; height: 520px;
    pointer-events: none; user-select: none;
    opacity: .5;
    -webkit-mask-image: radial-gradient(120% 100% at 78% 34%, #000 34%, transparent 76%);
            mask-image: radial-gradient(120% 100% at 78% 34%, #000 34%, transparent 76%);
  }
  .plan .voie   { stroke: var(--trait); stroke-width: 7; fill: none; }
  .plan .limite { stroke: var(--trait); stroke-width: 1.1; fill: none; }
  .plan .lot    { fill: none; }
  .plan .cible  { fill: var(--bleu); opacity: .10; }
  .plan .cible-trait { stroke: var(--bleu); stroke-width: 1.8; fill: none; }
  .plan text {
    font-family: var(--mono); font-size: 9px; fill: var(--encre-doux);
    opacity: .55; letter-spacing: .04em;
  }
  .plan text.actif { fill: var(--bleu); opacity: 1; font-weight: 500; }

  .eyebrow {
    position: relative; display: inline-flex; align-items: center; gap: 9px;
    padding: 6px 14px 6px 10px; margin-bottom: 30px;
    border: 1px solid var(--trait); border-radius: 999px;
    background: var(--blanc);
    font-family: var(--mono); font-size: 11.5px; letter-spacing: .02em;
    color: var(--encre-doux);
  }
  .eyebrow b { color: var(--encre); font-weight: 500; }
  .eyebrow .pastille {
    width: 7px; height: 7px; border-radius: 50%; background: var(--ok); flex: 0 0 7px;
  }

  #view-search h1 {
    position: relative;
    font-family: var(--display);
    font-weight: 800;
    font-size: clamp(38px, 7.2vw, 74px);
    line-height: .96;
    letter-spacing: -.035em;
    margin: 0 0 22px;
    max-width: 12ch;
  }
  #view-search h1 .fin { color: var(--encre-doux); }

  .accroche {
    position: relative;
    font-size: 17.5px; color: var(--encre-doux);
    max-width: 46ch; margin: 0 0 40px;
  }
  .accroche b { color: var(--encre); font-weight: 500; }

  /* ---------- FORMULAIRE ---------- */
  .form { position: relative; max-width: 560px; }
  .form label {
    display: block; font-family: var(--mono); font-size: 11px;
    text-transform: uppercase; letter-spacing: .09em;
    color: var(--encre-doux); margin-bottom: 10px;
  }
  .champ { display: flex; gap: 10px; align-items: stretch; }
  .ac-host { position: relative; flex: 1; }

  input[type=text] {
    width: 100%; padding: 15px 17px;
    font-family: var(--texte); font-size: 16px; color: var(--encre);
    background: var(--blanc);
    border: 1.5px solid var(--trait); border-radius: 6px;
    transition: border-color .15s, box-shadow .15s;
  }
  input[type=text]::placeholder { color: #9FB0C9; }
  input[type=text]:focus {
    outline: none; border-color: var(--bleu);
    box-shadow: 0 0 0 4px rgba(27,77,177,.13);
  }

  button {
    font-family: var(--texte); font-size: 15px; font-weight: 600;
    padding: 15px 26px; border: 1.5px solid transparent; border-radius: 6px;
    background: var(--bleu); color: #fff; cursor: pointer; white-space: nowrap;
    transition: background .15s, transform .06s;
  }
  button:hover:not(:disabled) { background: #163F94; }
  button:active:not(:disabled) { transform: translateY(1px); }
  button:disabled { background: var(--bleu-clair); color: #9FB0C9; cursor: default; }
  button:focus-visible { outline: 3px solid rgba(27,77,177,.4); outline-offset: 2px; }
  button.ghost {
    background: var(--blanc); color: var(--bleu); border-color: var(--trait);
  }
  button.ghost:hover { background: var(--bleu-clair); border-color: var(--bleu); }

  /* Autocompletion */
  .ac-list {
    position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 40;
    background: var(--blanc); border: 1px solid var(--trait); border-radius: 6px;
    box-shadow: 0 14px 34px -8px rgba(10,35,66,.15); overflow: hidden;
  }
  .ac-item {
    padding: 11px 16px; font-size: 14.5px; cursor: pointer;
    border-bottom: 1px solid var(--bleu-clair);
  }
  .ac-item:last-child { border-bottom: 0; }
  .ac-item:hover { background: var(--bleu-clair); }

  /* Ce que le moteur ne fait pas. La franchise est l'argument. */
  .limites {
    position: relative; margin-top: 44px; padding-top: 22px;
    border-top: 1px solid var(--trait);
    max-width: 560px;
    font-size: 14px; color: var(--encre-doux);
  }
  .limites b { color: var(--encre); font-weight: 500; }

  /* ---------- ANALYSE EN COURS ---------- */
  #view-run { padding: 84px 0 96px; }
  #view-run h1 {
    font-family: var(--display); font-weight: 800; font-size: 34px;
    letter-spacing: -.025em; margin: 0 0 6px;
  }
  #run-sub { font-family: var(--mono); font-size: 13px; color: var(--encre-doux); margin: 0 0 30px; }

  /* Pas de carte flottante, pas d'ombre, pas d'angle arrondi : un extrait
     cadastral n'en a pas. Un filet en tete, du papier, des hairlines. */
  .card {
    background: transparent; border: 0; border-radius: 0;
    border-top: 1px solid var(--trait);
    padding: 0;
  }

  .step { display: flex; gap: 14px; padding: 15px 0; border-bottom: 1px solid var(--bleu-clair); }
  .step:last-child { border-bottom: 0; }
  .voyant {
    width: 9px; height: 9px; border-radius: 50%; margin-top: 6px; flex: 0 0 9px;
    background: var(--idle);
  }
  .voyant.run  { background: var(--bleu); animation: pouls 1.1s ease-in-out infinite; }
  .voyant.ok   { background: var(--ok); }
  .voyant.warn { background: var(--warn); }
  .voyant.bad  { background: var(--bad); }
  @keyframes pouls { 50% { opacity: .25; transform: scale(.8); } }

  .step-t { font-size: 14.5px; font-weight: 600; letter-spacing: -.01em; }
  .step-d {
    font-family: var(--mono); font-size: 12.5px; line-height: 1.5;
    color: var(--encre-doux); margin-top: 3px; word-break: break-word;
  }

  /* ---------- RAPPORT ---------- */
  #view-report { padding: 84px 0 96px; }
  #view-report h1 {
    font-family: var(--display); font-weight: 800; font-size: 40px;
    letter-spacing: -.03em; margin: 0 0 8px;
  }
  #view-report .sub {
    font-family: var(--mono); font-size: 13.5px; color: var(--encre-doux);
    margin: 0 0 32px; letter-spacing: .01em;
  }

  /* Le verdict N'EST PAS une carte a filet colore : c'est le composant
     "alert" de tous les kits CSS, et un extrait cadastral n'y ressemble
     en rien. Ici : un filet d'encre en tete, du papier, et la couleur
     reduite a un CARRE DE LEGENDE - exactement comme sur la legende d'un
     plan, ou une teinte pleine designe une categorie. */
  .verdict {
    --signal: var(--idle);
    background: transparent; border: 0; border-radius: 0;
    border-top: 2px solid var(--encre);
    border-bottom: 1px solid var(--trait);
    padding: 20px 0 26px; margin: 0 0 30px;
  }
  .verdict.tres-eleve, .verdict.eleve { --signal: var(--ok); }
  .verdict.probable                   { --signal: var(--warn); }
  .verdict.faible, .verdict.tres-faible, .verdict.exclu { --signal: var(--bad); }
  .verdict.indetermine                { --signal: var(--idle); }

  .verdict h3 {
    margin: 0 0 14px; font-family: var(--mono); font-size: 11px; font-weight: 400;
    text-transform: uppercase; letter-spacing: .09em; color: var(--encre-doux);
    display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  }
  .verdict .val {
    display: flex; align-items: center; gap: 14px;
    font-family: var(--display); font-weight: 800;
    font-size: 44px; line-height: 1; letter-spacing: -.04em;
    margin-bottom: 14px;
  }
  .verdict .val::before {
    content: ''; flex: 0 0 14px; width: 14px; height: 14px;
    background: var(--signal);   /* carre de legende : la seule couleur du bloc */
  }
  .verdict .why { font-size: 14.5px; line-height: 1.6; color: var(--encre-doux); max-width: 68ch; }

  .tag {
    display: inline-block; font-family: var(--mono); font-size: 10px;
    text-transform: uppercase; letter-spacing: .08em;
    padding: 3px 7px; border: 1px solid var(--trait); border-radius: 2px;
    color: var(--encre-doux); background: var(--blanc);
  }

  .actions { display: flex; gap: 10px; margin-top: 24px; }

  .hidden { display: none; }

  @media (max-width: 640px) {
    .hero { padding: 64px 0 56px; }
    .plan { display: none; }
    .champ { flex-direction: column; }
    #view-search h1 { max-width: none; }
    .verdict .val { font-size: 32px; gap: 10px; }
    .actions { flex-direction: column; }
    button { width: 100%; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }

  @media print {
    body { background: #fff; }
    .no-print, .plan { display: none !important; }
    .wrap { max-width: none; padding: 0; }
    #view-report { padding: 0; }
    .verdict { border-top: 2px solid #000; border-bottom: 1px solid #ccc; }
    .card { border-top: 1px solid #ccc; }
    a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>

<div id="view-search">
  <div class="wrap">
    <div class="hero">

      <svg class="plan" viewBox="0 0 620 520" aria-hidden="true" focusable="false">
        <path class="voie" d="M20 452 C 170 436, 330 424, 600 414" />
        <g class="limite">
          <path class="lot" d="M52 442 L60 250 L128 246 L124 438 Z" />
          <path class="lot" d="M124 438 L128 246 L196 243 L194 435 Z" />
          <path class="lot" d="M194 435 L196 243 L264 240 L264 432 Z" />
          <path class="lot" d="M264 432 L264 240 L332 238 L334 429 Z" />
          <path class="lot" d="M404 426 L406 235 L474 233 L478 424 Z" />
          <path class="lot" d="M478 424 L474 233 L542 231 L548 421 Z" />
          <path class="lot" d="M60 250 L548 231" />
        </g>
        <path class="cible"       d="M334 429 L332 238 L406 235 L404 426 Z" />
        <path class="cible-trait" d="M334 429 L332 238 L406 235 L404 426 Z" />
        <text x="78"  y="348">0402</text>
        <text x="148" y="345">0403</text>
        <text x="218" y="342">0404</text>
        <text x="288" y="340">0405</text>
        <text class="actif" x="352" y="337">0406</text>
        <text x="426" y="334">0407</text>
        <text x="500" y="331">0408</text>
      </svg>

      <div class="eyebrow">
        <span class="pastille"></span>
        <span><b>4 sources publiques</b> · cadastre, DVF, PLU, Géorisques</span>
      </div>

      <h1>Ce terrain <span class="fin">se divise-t-il&nbsp;?</span></h1>

      <p class="accroche">
        Une adresse, et le moteur cherche des preuves dans le cadastre et les ventes réelles.
        Il vous dit ce qu'il a trouvé, <b>et sur quoi il s'appuie pour le dire</b>.
      </p>

      <div class="form">
        <label for="addr">Adresse du bien</label>
        <div class="champ">
          <div class="ac-host">
            <input type="text" id="addr" autocomplete="off" spellcheck="false"
                   placeholder="12 rue des Capucins, 61000 Alençon">
            <div id="ac" class="ac-list hidden"></div>
          </div>
          <button id="go" disabled>Analyser</button>
        </div>
      </div>

      <p class="limites">
        <b>Ce qu'il ne fait pas.</b> Il ne lit pas le règlement du PLU : il vous donne le lien
        vers la bonne page. Et quand les données ne suffisent pas à trancher, il le dit
        au lieu de deviner.
      </p>

    </div>
  </div>
</div>

<div id="view-run" class="hidden">
  <div class="wrap">
    <h1>Analyse en cours</h1>
    <p id="run-sub"></p>
    <div class="card" id="steps"></div>
  </div>
</div>

<div id="view-report" class="hidden">
  <div class="wrap">
    <div id="report"></div>
    <div class="actions no-print">
      <button onclick="window.print()">Exporter l'étude</button>
      <button class="ghost" onclick="location.reload()">Nouvelle analyse</button>
    </div>
  </div>
</div>

<script src="foncier-app.js"></script>
</body>
</html>
