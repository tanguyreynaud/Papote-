// Galerie de tous les écrans : ouvre chaque écran de la tablette, de l'app famille, du site et de l'admin dans un
// navigateur caché, avec de fausses données, prend une capture et range tout dans une seule page
// (sortie/galerie.html) où chaque écran a son numéro.
//
//   node galerie.js                      tout (tablette, app famille, site, admin), depuis les branches publiées
//   node galerie.js tablette             seulement la tablette
//   node galerie.js famille              seulement l'app famille
//   node galerie.js vitrine              seulement le site (origin/main), téléphone et ordinateur
//   node galerie.js admin                seulement l'admin (web/admin.html), ordinateur et téléphone
//   node galerie.js emails               seulement les e-mails (functions/mail.js), téléphone et ordinateur
//   --tablette=<branche|ici>             autre source pour android/ (ici = fichiers du disque)
//   --famille=<branche|ici>              autre source pour web/
//   --vitrine=<branche|ici>              autre source pour vitrine/
//   --admin=<branche|ici>                autre source pour web/ (admin.html)
//   --emails=<branche|ici>               autre source pour functions/ (mail.js)
//   --double [vitrine famille tablette admin]  au lieu des captures : touche chaque bouton deux fois, serveur bloqué,
//                                        et signale toute action partie en double (double.js)
//   --gestes [famille vitrine]           au lieu des captures : chaque écran en paysage, zoom 130 %, texte +30 %, mode sombre,
//                                        noms très longs ; bouton retour sur les fenêtres ; retour après paiement (gestes.js)
//   --courriels                          au lieu des captures : chaque e-mail à 320/375/412/600/900 px sans police ni image,
//                                        poids, liens, texte brut, contraste clair et inversé (courriels.js)
//   --identifiants [admin famille]       au lieu des captures : chaque bouton qui agit sur une commande ou un abonnement
//                                        doit envoyer au serveur la commande de la page / la famille ouverte (identifiants.js)
//   --accessibilite [famille vitrine admin tablette]  au lieu des captures : chaque écran passé à axe-core (WCAG A/AA : lecteur
//                                        d'écran, contrastes, étiquettes) + texte trop petit, cible trop petite (accessibilite.js)
//   --boutons                            au lieu des captures : touche chaque bouton de l'app famille et de l'admin,
//                                        serveur bloqué, et liste ceux qui ne montrent rien (sortie/boutons.txt)
//   --appui [vitrine famille tablette admin]  au lieu des captures : garde le doigt 1,2 s sur chaque bouton, serveur
//                                        bloqué : une action au plus, rien de sélectionné, pas de menu (appui.js)
//
// Chaque balayage, et la galerie elle-même (erreurs de page, clavier ouvert, largeur), finit en erreur (code 1)
// dès qu'un souci est trouvé : c'est ce qui bloque la fusion dans GitHub Actions (.github/workflows/balayages.yml).
//
// Rien n'est envoyé nulle part : pas de Firebase, pas d'internet (sauf les polices Google).
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { extraire, servir } = require('./commun');
const page = require('./page');

const SOURCES = {
  tablette: { ref: 'origin/claude/project-thread-cmnwxy', dossier: 'android/app/src/main/assets', module: './tablette' },
  famille: { ref: 'origin/claude/project-thread-dlattc', dossier: 'web', module: './famille' },
  vitrine: { ref: 'origin/main', dossier: 'vitrine', module: './vitrine' },
  admin: { ref: 'origin/claude/project-thread-dlattc', dossier: 'web', module: './admin' },
  emails: { ref: 'origin/main', dossier: 'functions', module: './emails' },
};

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--boutons')) return boutons(args.filter((a) => a !== '--boutons'));
  if (args.includes('--double')) return double(args.filter((a) => a !== '--double'));
  if (args.includes('--identifiants')) return identifiants(args.filter((a) => a !== '--identifiants'));
  if (args.includes('--gestes')) return gestes(args.filter((a) => a !== '--gestes'));
  if (args.includes('--courriels')) return courriels(args.filter((a) => a !== '--courriels'));
  if (args.includes('--accessibilite')) return double(args.filter((a) => a !== '--accessibilite'), require('./accessibilite'), ['famille', 'vitrine', 'admin', 'tablette']);
  if (args.includes('--appui')) return double(args.filter((a) => a !== '--appui'), require('./appui'), ['vitrine', 'famille', 'tablette', 'admin']);
  const choix = args.filter((a) => !a.startsWith('--'));
  for (const a of args.filter((a) => a.startsWith('--'))) {
    const [k, v] = a.slice(2).split('=');
    if (SOURCES[k] && v) SOURCES[k].ref = v;
  }
  const quoi = choix.length ? choix : Object.keys(SOURCES);

  const sortie = path.join(__dirname, 'sortie');
  const images = path.join(sortie, 'images');
  fs.rmSync(sortie, { recursive: true, force: true });
  fs.mkdirSync(images, { recursive: true });

  // Caméra et micro simulés (mire de test) pour les écrans d'appel.
  // --lang : les champs date/heure du navigateur s'affichent en français (sinon « 09:00 AM », « mm/dd/yyyy »).
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--lang=fr-FR'] });
  const parties = [];
  try {
    for (const nom of quoi) {
      const src = SOURCES[nom];
      if (!src) { console.error(`Inconnu : ${nom} (tablette, famille, vitrine, admin ou emails)`); continue; }
      console.log(`${nom} : ${src.ref}`);
      const { dir, version } = extraire(src.ref, src.dossier);
      const serveur = await servir(dir);
      try {
        const ecrans = await require(src.module).capturer({
          browser, base: serveur.url, dossierImages: images, dossierSource: dir,
          progression: (t) => process.stdout.write(`\r  ${t}   `),
        });
        process.stdout.write('\n');
        parties.push({ nom, version, ecrans });
      } finally {
        serveur.close();
      }
    }
  } finally {
    await browser.close();
  }

  const fichier = path.join(sortie, 'galerie.html');
  const html = page.html(parties, images);
  fs.writeFileSync(fichier, html);
  // Même page sans l'enveloppe <html>/<head>/<body>, pour la publier en Artifact sur claude.ai,
  // avec les captures en fichiers séparés (sortie/images/) publiés à côté.
  fs.writeFileSync(path.join(sortie, 'artifact.html'), page.html(parties, images, { fichiers: true })
    .replace(/<!doctype html>\s*<html[^>]*>\s*<head>/i, '').replace(/<\/head>\s*<body>/i, '').replace(/<\/body>\s*<\/html>\s*$/i, '')
    .replace(/<meta charset="utf-8">\s*<meta name="viewport"[^>]*>/i, ''));
  const total = parties.reduce((s, p) => s + p.ecrans.length, 0);
  const erreurs = parties.flatMap((p) => p.ecrans.filter((e) => e.erreurs.length));
  console.log(`\n${total} captures : ${fichier}`);
  if (erreurs.length) {
    console.log(`${erreurs.length} écran(s) avec un souci (erreur de la page, clavier ouvert, largeur), signalé dans la galerie :`);
    for (const e of erreurs) console.log(`  - ${e.titre} (${e.taille}) : ${e.erreurs.join(' · ')}`);
  }
  verdict(erreurs.length);
}

// Code de sortie 1 dès qu'un souci est trouvé (GitHub Actions bloque alors la fusion).
function verdict(soucis) {
  if (!soucis) { console.log('\nRAS : aucun souci.'); return; }
  console.log(`\nÉCHEC : ${soucis} souci(s).`);
  process.exitCode = 1;
}

// Balayage des boutons (boutons.js) : app famille et admin seulement (la tablette et le site ont leurs propres tests).
async function boutons(args) {
  const { balayer, rapport } = require('./boutons');
  for (const a of args.filter((a) => a.startsWith('--'))) {
    const [k, v] = a.slice(2).split('=');
    if (SOURCES[k] && v) SOURCES[k].ref = v;
  }
  const choix = args.filter((a) => !a.startsWith('--'));
  const quoi = (choix.length ? choix : ['famille', 'admin']).filter((n) => n === 'famille' || n === 'admin');
  const sortie = path.join(__dirname, 'sortie');
  fs.mkdirSync(sortie, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--lang=fr-FR'] });
  const parties = [];
  try {
    for (const nom of quoi) {
      const src = SOURCES[nom];
      console.log(`${nom} : ${src.ref}`);
      const { dir, version } = extraire(src.ref, src.dossier);
      const serveur = await servir(dir);
      try {
        const r = await balayer({ browser, base: serveur.url, partie: nom, progression: (t) => process.stdout.write(`\r  ${t}   `) });
        process.stdout.write('\n');
        parties.push({ nom, version, ...r });
      } finally {
        serveur.close();
      }
    }
  } finally {
    await browser.close();
  }
  const { fichier, texte, soucis } = rapport(parties, sortie);
  console.log(`\n${texte}\n\n${fichier}`);
  verdict(soucis);
}

// E-mails dans les vraies boîtes (courriels.js) : largeurs Gmail / Apple Mail / Outlook, sans police ni image, mode sombre.
async function courriels(args) {
  for (const a of args.filter((a2) => a2.startsWith('--'))) {
    const [k, v] = a.slice(2).split('=');
    if (SOURCES[k] && v) SOURCES[k].ref = v;
  }
  const { verifier, rapport } = require('./courriels');
  const sortie = path.join(__dirname, 'sortie');
  fs.mkdirSync(sortie, { recursive: true });
  const src = SOURCES.emails;
  console.log(`emails : ${src.ref}`);
  const { dir, version } = extraire(src.ref, src.dossier);
  const browser = await chromium.launch();
  try {
    const resultats = await verifier({ browser, dossierSource: dir, progression: (t) => process.stdout.write(`\r  ${t}   `) });
    process.stdout.write('\n');
    const { fichier, texte, soucis } = rapport(resultats, version, sortie);
    console.log(`\n${texte}\n\n${fichier}`);
    verdict(soucis);
  } finally {
    await browser.close();
  }
}

// Gestes humains (gestes.js) : paysage, zoom, texte agrandi, mode sombre, noms longs, bouton retour, retour après paiement.
async function gestes(args) {
  return double(args, require('./gestes'), ['famille', 'vitrine']);
}

// Double clic (double.js) : chaque bouton touché deux fois, rien ne doit partir en double.
async function double(args, outil = require('./double'), defaut = ['vitrine', 'famille', 'tablette', 'admin']) {
  const { balayer, rapport } = outil;
  for (const a of args.filter((a) => a.startsWith('--'))) {
    const [k, v] = a.slice(2).split('=');
    if (SOURCES[k] && v) SOURCES[k].ref = v;
  }
  const choix = args.filter((a) => !a.startsWith('--'));
  const quoi = (choix.length ? choix : defaut).filter((n) => defaut.includes(n));
  const sortie = path.join(__dirname, 'sortie');
  fs.mkdirSync(sortie, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--lang=fr-FR'] });
  const parties = [];
  try {
    for (const nom of quoi) {
      const src = SOURCES[nom];
      console.log(`${nom} : ${src.ref}`);
      const { dir, version } = extraire(src.ref, src.dossier);
      const serveur = await servir(dir);
      try {
        const r = await balayer({ browser, base: serveur.url, partie: nom, progression: (t) => process.stdout.write(`\r  ${t}   `) });
        process.stdout.write('\n');
        parties.push({ nom, version, ...r });
      } finally {
        serveur.close();
      }
    }
  } finally {
    await browser.close();
  }
  const { fichier, texte, soucis } = rapport(parties, sortie);
  console.log(`\n${texte}\n\n${fichier}`);
  verdict(soucis);
}

// Le bon identifiant part au serveur (identifiants.js) : admin (pages de commande) et appli famille (abonnement).
async function identifiants(args) {
  const mod = require('./identifiants');
  for (const a of args.filter((a) => a.startsWith('--'))) {
    const [k, v] = a.slice(2).split('=');
    if (SOURCES[k] && v) SOURCES[k].ref = v;
  }
  const choix = args.filter((a) => !a.startsWith('--'));
  const quoi = (choix.length ? choix : ['admin', 'famille']).filter((n) => n === 'admin' || n === 'famille');
  const sortie = path.join(__dirname, 'sortie');
  fs.mkdirSync(sortie, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--lang=fr-FR'] });
  const parties = [];
  try {
    for (const nom of quoi) {
      const src = SOURCES[nom];
      console.log(`${nom} : ${src.ref}`);
      const { dir, version } = extraire(src.ref, src.dossier);
      const serveur = await servir(dir);
      try {
        const resultats = await mod[nom]({ browser, base: serveur.url, progression: (t) => process.stdout.write(`\r  ${t}   `) });
        process.stdout.write('\n');
        parties.push({ nom, version, resultats });
      } finally {
        serveur.close();
      }
    }
  } finally {
    await browser.close();
  }
  const { fichier, texte, soucis } = mod.rapport(parties, sortie);
  console.log(`\n${texte}\n\n${fichier}`);
  verdict(soucis);
}

main().catch((e) => { console.error(e); process.exit(1); });
