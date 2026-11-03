// Met en ligne les captures de l'espace Validation de l'admin, visibles par l'admin seulement (Tanguy, 3/11) :
//   - les images vont dans le stockage Firebase (bucket par défaut, dossier validation/i/), chacune avec un jeton
//     secret ; aucune règle ne les ouvre, seul qui a le jeton peut les voir ;
//   - la liste des écrans et les jetons vont dans le document Firestore validation/captures, que seul l'admin lit.
//   node outils/galerie/publier-validation.mjs
// Avant : une galerie (galerie.bat, ou seulement une partie : galerie.bat admin), qui remplit outils/galerie/validation/.
// Clé d'administration : %USERPROFILE%\.papote\cle-admin-firebase.json (jamais dans le dépôt), comme outils/admin.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICI = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// firebase-admin est celui des outils d'administration (outils/admin/node_modules), installé par publier-validation.bat.
const requireAdmin = createRequire(resolve(ICI, '../admin/package.json'));
const { assembler, DOSSIER } = require('./validation.js');
const { ouvrirBase } = requireAdmin('./base.js');
const admin = requireAdmin('firebase-admin');

const BUCKET = 'papote-famille.firebasestorage.app';
const PREFIXE = 'validation/';
const LIMITE_DOC = 900_000; // un document Firestore fait 1 Mo au plus

const resume = assembler();
if (!resume.parties.length) {
  console.error('Aucune capture : lancer d\'abord la galerie (galerie.bat).');
  process.exit(2);
}
console.log(`Écrans : ${resume.parties.join(', ')} (${resume.captures} captures${resume.retirees ? `, ${resume.retirees} anciennes retirées` : ''})`);

const cleChemin = process.env.PAPOTE_CLE_ADMIN || join(os.homedir(), '.papote', 'cle-admin-firebase.json');
if (!fs.existsSync(cleChemin)) {
  console.error(`Clé introuvable : ${cleChemin}`);
  process.exit(1);
}
const cle = JSON.parse(fs.readFileSync(cleChemin, 'utf8'));
const app = admin.initializeApp({ credential: admin.credential.cert(cle), storageBucket: BUCKET });
const bucket = admin.storage(app).bucket();

// Images déjà en ligne : leur nom est l'empreinte de leur contenu, elles ne changent jamais (on garde leur jeton).
const [enLigne] = await bucket.getFiles({ prefix: `${PREFIXE}i/` });
const jetons = new Map();
for (const f of enLigne) {
  const t = String((f.metadata.metadata || {}).firebaseStorageDownloadTokens || '').split(',')[0];
  if (t) jetons.set(f.name.slice(PREFIXE.length), t);
}

const index = JSON.parse(fs.readFileSync(join(DOSSIER, 'index.json'), 'utf8'));
const utilisees = [...new Set(index.parties.flatMap((p) => p.ecrans.flatMap((e) => e.captures.map((c) => c.f))))];
const aEnvoyer = utilisees.filter((f) => !jetons.has(f));
let faits = 0;
async function envoyer(f) {
  const t = randomUUID();
  await bucket.upload(join(DOSSIER, f), {
    destination: PREFIXE + f,
    resumable: false,
    metadata: { contentType: 'image/jpeg', cacheControl: 'private, max-age=31536000, immutable', metadata: { firebaseStorageDownloadTokens: t } },
  });
  jetons.set(f, t);
  process.stdout.write(`\r  envoyées ${++faits}/${aEnvoyer.length}   `);
}
const file = [...aEnvoyer];
await Promise.all(Array.from({ length: 8 }, async () => { for (let f = file.shift(); f; f = file.shift()) await envoyer(f); }));
if (aEnvoyer.length) process.stdout.write('\n');

for (const p of index.parties) for (const e of p.ecrans) for (const c of e.captures) c.t = jetons.get(c.f);
const docCaptures = { le: index.le, bucket: BUCKET, parties: index.parties };
const taille = Buffer.byteLength(JSON.stringify(docCaptures));
if (taille > LIMITE_DOC) {
  console.error(`Liste trop grosse pour un document (${Math.round(taille / 1000)} ko) : rien n'est publié.`);
  process.exit(1);
}
const db = await ouvrirBase(app);
await db.doc('validation/captures').set(docCaptures);

// Images que plus aucun écran n'utilise : retirées du stockage.
const garder = new Set(utilisees);
const vieilles = enLigne.filter((f) => !garder.has(f.name.slice(PREFIXE.length)));
for (const f of vieilles) await f.delete().catch((e) => console.warn(`Pas retirée : ${f.name} (${e.message})`));

console.log(`\nEn ligne : admin Papote › Validation (${utilisees.length} captures, ${aEnvoyer.length} nouvelles, ${vieilles.length} retirées).`);
console.log('Visibles seulement par l\'admin connecté.');
process.exit(0);
