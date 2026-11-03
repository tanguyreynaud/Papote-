// Restauration d'une sauvegarde (sauvegarder.js) dans la base Firestore : chaque document est réécrit tel qu'il
// était. Ce qui a été créé depuis la sauvegarde est gardé, sauf avec --effacer (remise exacte à l'état sauvegardé).
//
//   node restaurer.js sauvegardes\papote-2026-11-02-03-00-00.json           : montre ce qui serait fait
//   node restaurer.js sauvegardes\papote-....json --oui                     : restaure (écrase les documents)
//   node restaurer.js sauvegardes\papote-....json --oui --effacer           : et efface ce qui n'est pas dedans
//   node restaurer.js ... --comptes                                         : restaure aussi les comptes absents
// Options : --base europe. Les comptes restaurés n'ont pas de mot de passe (comptes Google ou anonymes : rien à
// faire ; comptes « appels » des tablettes : la tablette le recrée).
// Clé d'administration : %USERPROFILE%\.papote\cle-admin-firebase.json (jamais dans le dépôt).
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('firebase-admin');
const { ouvrirBase } = require('./base');
const { restaurer } = require('./sauvegarde-lib');

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const fichier = process.argv.slice(2).find((a) => !a.startsWith('--') && a.endsWith('.json'));
const keyPath = process.env.PAPOTE_CLE_ADMIN || path.join(os.homedir(), '.papote', 'cle-admin-firebase.json');
if (!fichier || !fs.existsSync(fichier)) {
  console.error('Usage : restaurer.bat <sauvegarde.json> [--oui] [--effacer] [--comptes] [--base europe]');
  process.exit(1);
}
if (!fs.existsSync(keyPath)) {
  console.error(`Clé introuvable : ${keyPath}`);
  process.exit(1);
}
if (option('base', null)) process.env.PAPOTE_BASE = option('base', null);
const oui = process.argv.includes('--oui');
const effacer = process.argv.includes('--effacer');
const comptes = process.argv.includes('--comptes');

(async () => {
  const sauvegarde = JSON.parse(fs.readFileSync(fichier, 'utf8'));
  const cle = require(keyPath);
  console.log(`Sauvegarde du ${sauvegarde.le} (projet ${sauvegarde.projet}, base « ${sauvegarde.base} ») : ${sauvegarde.documents.length} documents, ${sauvegarde.comptes.length} comptes.`);
  if (sauvegarde.projet && sauvegarde.projet !== cle.project_id) {
    console.error(`Elle vient du projet ${sauvegarde.projet}, la clé est celle de ${cle.project_id} : arrêt.`);
    process.exit(1);
  }
  const app = admin.initializeApp({ credential: admin.credential.cert(cle) });
  const db = await ouvrirBase(app);
  const familles = sauvegarde.documents.filter((d) => /^families\/[^/]+$/.test(d.chemin)).length;
  console.log(`Vers la base « ${db.databaseId || '(default)'} » : ${familles} familles, ${effacer ? 'avec' : 'sans'} effacement du reste, ${comptes ? 'avec' : 'sans'} les comptes.`);
  if (!oui) {
    console.log('Rien n\'a été fait. Relancer avec --oui pour restaurer.');
    process.exit(0);
  }
  const r = await restaurer({
    db, auth: comptes ? admin.auth(app) : null, sauvegarde, effacer,
    progression: (n) => process.stdout.write(`\r${n} documents écrits`),
  });
  process.stdout.write('\n');
  console.log(`Restauré : ${r.documents} documents, ${r.comptes} comptes.`);
  process.exit(0);
})().catch((e) => {
  console.error('Restauration impossible :', e.message);
  process.exit(1);
});
