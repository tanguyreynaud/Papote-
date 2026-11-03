// Sauvegarde de la base Firestore de Papote (et de la liste des comptes) dans un fichier JSON, à garder hors du PC
// (clé USB, disque). À faire au moins une fois par semaine, et avant toute manipulation risquée.
//
//   node sauvegarder.js                      : écrit sauvegardes\papote-<date>.json à côté de ce script
//   node sauvegarder.js --vers D:\sauvegardes : dans ce dossier
//   node sauvegarder.js --base europe        : force la base (sinon config/base, comme les autres outils)
// Coût : une lecture Firestore par document (quelques milliers pour dix familles).
// Clé d'administration : %USERPROFILE%\.papote\cle-admin-firebase.json (jamais dans le dépôt).
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('firebase-admin');
const { ouvrirBase } = require('./base');
const { sauvegarder } = require('./sauvegarde-lib');

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const keyPath = process.env.PAPOTE_CLE_ADMIN || path.join(os.homedir(), '.papote', 'cle-admin-firebase.json');
if (!fs.existsSync(keyPath)) {
  console.error(`Clé introuvable : ${keyPath}`);
  process.exit(1);
}
if (option('base', null)) process.env.PAPOTE_BASE = option('base', null);
const dossier = option('vers', path.join(__dirname, 'sauvegardes'));

(async () => {
  const cle = require(keyPath);
  const app = admin.initializeApp({ credential: admin.credential.cert(cle) });
  const db = await ouvrirBase(app);
  const base = db.databaseId || process.env.PAPOTE_BASE || '(default)';
  console.log(`Base « ${base} » du projet ${cle.project_id} : lecture…`);
  const s = await sauvegarder({
    db, auth: admin.auth(app), projet: cle.project_id, base,
    progression: (n) => process.stdout.write(`\r${n} documents lus`),
  });
  process.stdout.write('\n');
  fs.mkdirSync(dossier, { recursive: true });
  const nom = `papote-${s.le.slice(0, 19).replace(/[:T]/g, '-')}.json`;
  const fichier = path.join(dossier, nom);
  fs.writeFileSync(fichier, JSON.stringify(s));
  const ko = Math.round(fs.statSync(fichier).size / 1024);
  console.log(`Sauvegarde écrite : ${fichier} (${s.documents.length} documents, ${s.comptes.length} comptes, ${ko} ko).`);
  console.log('À copier hors du PC. Les photos et vidéos (Storage) ne sont pas dedans : voir le README.');
  process.exit(0);
})().catch((e) => {
  console.error('Sauvegarde impossible :', e.message);
  process.exit(1);
});
