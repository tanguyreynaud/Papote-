// Restauration d'une sauvegarde (sauvegarder.js) dans la base Firestore : chaque document est réécrit tel qu'il
// était. Ce qui a été créé depuis la sauvegarde est gardé, sauf avec --effacer (remise exacte à l'état sauvegardé).
//
//   node restaurer.js sauvegardes\papote-2026-11-08-03-00-00                : montre ce qui serait fait
//   node restaurer.js sauvegardes\papote-...  --oui                         : restaure (écrase les documents)
//   node restaurer.js sauvegardes\papote-...  --oui --effacer               : et efface ce qui n'est pas dedans
//   node restaurer.js ... --comptes                                         : restaure aussi les comptes absents
//   node restaurer.js ... --photos                                          : remet aussi les fichiers du stockage
//                                                                             (dossier fichiers à côté : gestion/,
//                                                                             et photos si copiées avec --photos)
//   node restaurer.js ... --autre-base                                      : accepte une base différente de celle
//                                                                             d'où vient la sauvegarde
// La sauvegarde est un dossier papote-<date> (format 2) ou un ancien fichier papote-<date>.json (format 1).
// Mauvaise base (audit A15-2) : la sauvegarde note la base d'où elle vient ; si la base visée (config/base ou
// --base) est une autre, la restauration est REFUSÉE, sauf --autre-base (par exemple vers une base neuve « europe2 »).
// Options : --base europe. Les comptes restaurés n'ont pas de mot de passe (comptes Google ou anonymes : rien à
// faire ; comptes « appels » des tablettes : la tablette le recrée).
// Clé d'administration : %USERPROFILE%\.papote\cle-admin-firebase.json (jamais dans le dépôt).
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('firebase-admin');
const { ouvrirBase } = require('./base');
const { restaurer, restaurerFichiers, lireSauvegarde } = require('./sauvegarde-lib');
const BUCKET = process.env.BUCKET_STORAGE || 'papote-famille-eu';

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const valeurs = new Set(['--base'].map((o) => process.argv.indexOf(o) + 1).filter((i) => i > 0));
const chemin = process.argv.slice(2).find((a, i) => !a.startsWith('--') && !valeurs.has(i + 2));
const keyPath = process.env.PAPOTE_CLE_ADMIN || path.join(os.homedir(), '.papote', 'cle-admin-firebase.json');
if (!chemin || !fs.existsSync(chemin)) {
  console.error('Usage : restaurer.bat <dossier papote-date | ancien fichier .json> [--oui] [--effacer] [--comptes] [--photos] [--base europe] [--autre-base]');
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
const photos = process.argv.includes('--photos');
const autreBase = process.argv.includes('--autre-base');

(async () => {
  const sauvegarde = await lireSauvegarde(chemin);
  const cle = require(keyPath);
  console.log(`Sauvegarde du ${sauvegarde.le} (projet ${sauvegarde.projet}, base « ${sauvegarde.base} ») : ${sauvegarde.nbDocuments} documents, ${sauvegarde.comptes.length} comptes.`);
  if (sauvegarde.projet && sauvegarde.projet !== cle.project_id) {
    console.error(`Elle vient du projet ${sauvegarde.projet}, la clé est celle de ${cle.project_id} : arrêt.`);
    process.exit(1);
  }
  const app = admin.initializeApp({ credential: admin.credential.cert(cle) });
  const db = await ouvrirBase(app);
  const cible = db.databaseId || '(default)';
  if (sauvegarde.base !== cible) {
    console.log(`ATTENTION : elle vient de la base « ${sauvegarde.base || 'inconnue'} » et irait dans « ${cible} ».`);
    if (!autreBase) {
      console.error('Restauration refusée. Vérifier config/base ou --base ; pour le faire exprès, ajouter --autre-base.');
      process.exit(1);
    }
  }
  let familles = 0;
  for await (const d of sauvegarde.documents) if (/^families\/[^/]+$/.test(d.chemin)) familles++;
  console.log(`Vers la base « ${cible} » : ${familles} familles, ${effacer ? 'AVEC effacement de tout ce qui n\'est pas dans la sauvegarde' : 'sans effacement du reste'}, ${comptes ? 'avec' : 'sans'} les comptes.`);
  if (!oui) {
    console.log('Rien n\'a été fait. Relancer avec --oui pour restaurer.');
    process.exit(0);
  }
  const r = await restaurer({
    db, auth: comptes ? admin.auth(app) : null, sauvegarde, effacer, autreBase,
    progression: (n) => process.stdout.write(`\r${n} documents écrits`),
  });
  process.stdout.write('\n');
  console.log(`Restauré : ${r.documents} documents, ${r.comptes} comptes.`);
  if (photos) {
    const f = await restaurerFichiers({
      bucket: admin.storage(app).bucket(BUCKET), dossier: sauvegarde.dossierFichiers,
      progression: (n, total) => process.stdout.write(`\r${n} / ${total} fichiers remis`),
    });
    if (f.total) process.stdout.write('\n');
    console.log(`Fichiers du stockage : ${f.remis} fichier(s) remis dans ${BUCKET}.`);
  }
  process.exit(0);
})().catch((e) => {
  console.error('Restauration impossible :', e.message);
  process.exit(1);
});
