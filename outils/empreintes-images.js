#!/usr/bin/env node
// Images du site gardées 7 jours par le navigateur (firebase.vitrine.json, Tanguy 20/11) : pour qu'une image
// remplacée apparaisse tout de suite, chaque lien d'image des pages de vitrine/ porte l'empreinte du fichier
// (ecran-appel.webp?v=1a2b3c4d). Image changée → empreinte changée → nouveau lien → le navigateur la redemande.
//
//   node outils/empreintes-images.js             remet les liens à jour (à lancer après avoir changé une image)
//   node outils/empreintes-images.js --verifier  ne touche à rien, sort en erreur si un lien n'est pas à jour
//
// L'essai « site : chaque lien d'image porte l'empreinte du fichier » (functions/stock.test.js) fait la même
// vérification : une image changée sans relancer cet outil arrête les tests, donc la publication.
// Les adresses complètes (https://mapapote.fr/mamie.jpg, aperçu des réseaux sociaux) ne sont pas touchées.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VITRINE = path.join(__dirname, '..', 'vitrine');
const LIEN = /(?<![\w/:.-])(\/?)([\w-]+\.(?:jpe?g|png|webp|avif|svg|gif))(\?v=[0-9a-f]*)?(?![\w.-])/g;

function empreinte(fichier) {
  return crypto.createHash('sha256').update(fs.readFileSync(fichier)).digest('hex').slice(0, 8);
}

// Rend le texte de la page avec les liens à jour. Un nom qui n'est pas un fichier de vitrine/ est laissé tel quel.
function mettreAJour(html, dossier = VITRINE) {
  return html.replace(LIEN, (tout, barre, nom) => {
    const fichier = path.join(dossier, nom);
    return fs.existsSync(fichier) ? `${barre}${nom}?v=${empreinte(fichier)}` : tout;
  });
}

// cgv.html n'est pas touchée : le PDF des CGV joint aux commandes est lié à ce fichier au caractère près
// (functions/mail.test.js). Sa seule image est le logo ; s'il change un jour, il y mettra jusqu'à 7 jours.
const SAUF = ['cgv.html'];

function pages(dossier = VITRINE) {
  return fs.readdirSync(dossier).filter((f) => f.endsWith('.html') && !SAUF.includes(f)).sort();
}

// Liste des pages dont au moins un lien d'image n'est pas à jour.
function pagesEnRetard(dossier = VITRINE) {
  return pages(dossier).filter((p) => {
    const html = fs.readFileSync(path.join(dossier, p), 'utf8');
    return mettreAJour(html, dossier) !== html;
  });
}

module.exports = { mettreAJour, pagesEnRetard, empreinte, LIEN };

if (require.main === module) {
  const retard = pagesEnRetard();
  if (process.argv.includes('--verifier')) {
    if (retard.length) {
      console.error(`Liens d'image pas à jour dans : ${retard.join(', ')}. Lancer : node outils/empreintes-images.js`);
      process.exit(1);
    }
    console.log('Liens d\'image à jour.');
  } else {
    for (const p of retard) {
      const f = path.join(VITRINE, p);
      fs.writeFileSync(f, mettreAJour(fs.readFileSync(f, 'utf8')));
      console.log(`mis à jour : vitrine/${p}`);
    }
    if (!retard.length) console.log('Rien à changer.');
  }
}
