// Annonce aux tablettes qu'une nouvelle version de Papote est publiée : écrit config/version
// (lu en direct par les tablettes, qui vont aussitôt chercher la mise à jour).
// Lancé par installation/publier-mise-a-jour.ps1 après la publication des fichiers de version.
//   node annoncer-version.js --stable 99 --test 100
// Clé d'administration : %USERPROFILE%\.papote\cle-admin-firebase.json (jamais dans le dépôt).
const os = require('os');
const path = require('path');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const { ouvrirBase } = require('./base');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) || null : null;
}

const keyPath = process.env.PAPOTE_CLE_ADMIN
  || path.join(os.homedir(), '.papote', 'cle-admin-firebase.json');
const app = admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });

(async () => {
  const db = await ouvrirBase(app);
  await db.doc('config/version').set({
    stable: arg('stable'),
    test: arg('test'),
    publieeLe: FieldValue.serverTimestamp(),
  });
  console.log('Nouvelle version annoncée aux tablettes.');
  process.exit(0);
})().catch((e) => {
  console.error(`Annonce impossible : ${e.message}`);
  process.exit(1);
});
