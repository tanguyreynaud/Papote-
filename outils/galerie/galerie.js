// Galerie de tous les écrans : ouvre chaque écran de la tablette et de l'app famille dans un
// navigateur caché, avec de fausses données, prend une capture et range tout dans une seule page
// (sortie/galerie.html) où chaque écran a son numéro.
//
//   node galerie.js                      tablette + app famille, depuis les branches publiées
//   node galerie.js tablette             seulement la tablette
//   node galerie.js famille              seulement l'app famille
//   --tablette=<branche|ici>             autre source pour android/ (ici = fichiers du disque)
//   --famille=<branche|ici>              autre source pour web/
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
};

async function main() {
  const args = process.argv.slice(2);
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
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const parties = [];
  try {
    for (const nom of quoi) {
      const src = SOURCES[nom];
      if (!src) { console.error(`Inconnu : ${nom} (tablette ou famille)`); continue; }
      console.log(`${nom} : ${src.ref}`);
      const { dir, version } = extraire(src.ref, src.dossier);
      const serveur = await servir(dir);
      try {
        const ecrans = await require(src.module).capturer({
          browser, base: serveur.url, dossierImages: images,
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
  // Même page sans l'enveloppe <html>/<head>/<body>, pour la publier en Artifact sur claude.ai.
  fs.writeFileSync(path.join(sortie, 'artifact.html'), html
    .replace(/<!doctype html>\s*<html[^>]*>\s*<head>/i, '').replace(/<\/head>\s*<body>/i, '').replace(/<\/body>\s*<\/html>\s*$/i, '')
    .replace(/<meta charset="utf-8">\s*<meta name="viewport"[^>]*>/i, ''));
  const total = parties.reduce((s, p) => s + p.ecrans.length, 0);
  const erreurs = parties.flatMap((p) => p.ecrans.filter((e) => e.erreurs.length));
  console.log(`\n${total} captures : ${fichier}`);
  if (erreurs.length) console.log(`${erreurs.length} écran(s) avec une erreur de la page (signalée dans la galerie).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
