// Les scénarios coupés en morceaux pour la CI : chaque morceau tourne dans sa propre tâche GitHub, avec ses propres
// émulateurs, en parallèle des autres (.github/workflows/app-famille.yml, et app-famille-croise.yml de main).
// Toute la suite dans une seule tâche prenait près de 30 min par navigateur (WebKit iPhone : jusqu'à 50) ; en
// 3 morceaux d'environ 10 min, la CI tient en moins de 30 min de bout en bout (Tanguy, 19/11).
//
//   node morceaux.js verifier   chaque fichier de scenarios/ est dans exactement un morceau (code 1 sinon)
//   node morceaux.js lancer K   vérifie, puis lance le morceau K (1, 2, 3…) exactement comme « npm test »
//                               (même commande, celle du package.json, avec les fichiers du morceau à la place
//                               de scenarios/*.test.js)
//
// Un scénario ajouté doit être rangé ici dans un morceau, sinon la CI est rouge (aucun scénario oublié). Morceaux
// équilibrés sur les durées mesurées en CI (pour chaque fichier, la plus longue de Chromium, run 44517288935, et de WebKit
// iPhone 15 et SE, run 44522085882, du 19/11 : ~13 min de scénarios par morceau) : garder des totaux proches.

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MORCEAUX = [
  [
    'admin-colis-en-route.test.js', 'admin-remplacement.test.js', 'admin-sim-installation.test.js',
    'changement-compte.test.js', 'deux-proches.test.js', 'envois.test.js', 'limites.test.js', 'natif.test.js',
    'proches.test.js', 'reglages.test.js', 'reseau.test.js', 'resiliation-responsables.test.js', 'sos-ordre.test.js', 'sos-rappel.test.js',
    'sos.test.js', 'tel-unique.test.js', 'webkit-liste.test.js',
  ],
  [
    'accueil.test.js', 'admin-hors-forfait.test.js', 'admin-journee.test.js', 'agenda.test.js', 'alerte-pas-vue.test.js', 'appels.test.js',
    'badges.test.js', 'chat-aller.test.js', 'clavier-bas.test.js', 'debordement.test.js', 'installation.test.js',
    'largeur.test.js', 'mauvais-jours.test.js', 'mes-informations.test.js', 'photos-multiples.test.js',
    'resiliation.test.js',
  ],
  [
    'abonnement.test.js', 'admin-sim-bloquee.test.js', 'appel-android.test.js', 'declaration.test.js', 'liens-invitation.test.js',
    'deconnexion.test.js', 'forfait.test.js', 'horsligne.test.js', 'mise-en-route.test.js', 'panne.test.js',
    'partage.test.js', 'plusieurs-proches.test.js', 'renvoi.test.js', 'retour.test.js', 'sepa.test.js', 'touchers.test.js', 'wifi.test.js',
  ],
];

const ici = __dirname;
const GLOB = 'scenarios/*.test.js';

function verifier() {
  const presents = fs.readdirSync(path.join(ici, 'scenarios')).filter((f) => f.endsWith('.test.js')).sort();
  const vus = new Map();
  const soucis = [];
  MORCEAUX.forEach((m, i) => m.forEach((f) => {
    if (vus.has(f)) soucis.push(`${f} est dans les morceaux ${vus.get(f)} et ${i + 1} (il tournerait deux fois)`);
    else vus.set(f, i + 1);
  }));
  for (const f of presents) if (!vus.has(f)) soucis.push(`${f} n'est dans aucun morceau (il ne tournerait pas) : l'ajouter dans tests/app-famille/morceaux.js`);
  for (const f of vus.keys()) if (!presents.includes(f)) soucis.push(`${f} est dans un morceau mais n'existe pas dans scenarios/`);
  if (soucis.length) {
    for (const s of soucis) console.error(`::error::${s}`);
    process.exit(1);
  }
  console.log(`${presents.length} scénarios, chacun dans exactement un des ${MORCEAUX.length} morceaux :`);
  MORCEAUX.forEach((m, i) => console.log(`  morceau ${i + 1} (${m.length}) : ${m.join(' ')}`));
}

function lancer(k) {
  verifier();
  const morceau = MORCEAUX[k - 1];
  if (!morceau) {
    console.error(`::error::Morceau ${k} inconnu (il y en a ${MORCEAUX.length}).`);
    process.exit(1);
  }
  const test = require('./package.json').scripts.test;
  if (!test.includes(GLOB)) {
    console.error(`::error::Le script « test » du package.json ne contient plus ${GLOB} : morceaux.js à mettre à jour.`);
    process.exit(1);
  }
  const fichiers = morceau.map((f) => `scenarios/${f}`).join(' ');
  console.log(`\nMorceau ${k}/${MORCEAUX.length} : ${morceau.length} scénarios.\n`);
  const opts = { cwd: ici, stdio: 'inherit' };
  try {
    execSync('node preparer.js', opts); // comme « pretest »
    execSync(test.replace(GLOB, fichiers), opts);
  } catch (e) {
    process.exit(e.status || 1);
  }
}

const [quoi, k] = process.argv.slice(2);
if (quoi === 'verifier') verifier();
else if (quoi === 'lancer' && /^\d+$/.test(k || '')) lancer(Number(k));
else if (quoi === 'nombre') console.log(MORCEAUX.length);
else {
  console.error('Usage : node morceaux.js verifier | lancer <K> | nombre');
  process.exit(2);
}
