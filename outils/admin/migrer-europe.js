// Copie toutes les données de Papote vers l'Europe : base Firestore (default) -> base « europe »,
// fichiers Storage de l'ancien bucket -> nouveau bucket. Les adresses des photos et vidéos
// (imageUrl, videoUrl…) sont réécrites vers le nouveau bucket ; leurs jetons de téléchargement
// sont gardés, donc les liens restent valides.
//
// L'ancienne base et l'ancien bucket ne sont pas modifiés : on peut relancer sans risque
// (les documents et fichiers déjà copiés sont simplement réécrits).
//
//   migrer-europe.bat         : compte ce qui serait copié
//   migrer-europe.bat --oui   : copie
// Options : --base europe  --bucket papote-famille-eu  --ancien-bucket papote-famille.firebasestorage.app
// Clé d'administration : %USERPROFILE%\.papote\cle-admin-firebase.json (jamais dans le dépôt).
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const keyPath = process.env.PAPOTE_CLE_ADMIN
  || path.join(os.homedir(), '.papote', 'cle-admin-firebase.json');
const confirmed = process.argv.includes('--oui');
const targetDb = option('base', 'europe');
const oldBucketName = option('ancien-bucket', 'papote-famille.firebasestorage.app');
const newBucketName = option('bucket', 'papote-famille-eu');

if (!fs.existsSync(keyPath)) {
  console.error(`Clé introuvable : ${keyPath}`);
  process.exit(1);
}

const app = admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });
const source = getFirestore(app);
const target = getFirestore(app, targetDb);

// Remplace l'ancien bucket par le nouveau dans toutes les chaînes d'un document.
function rewrite(value) {
  if (typeof value === 'string') {
    return value
      .split(`/b/${oldBucketName}/o/`).join(`/b/${newBucketName}/o/`)
      .split(`gs://${oldBucketName}/`).join(`gs://${newBucketName}/`)
      .split(`storage.googleapis.com/${oldBucketName}/`).join(`storage.googleapis.com/${newBucketName}/`);
  }
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
  }
  return value; // Timestamp, GeoPoint, référence, octets… : inchangés
}

async function copyDocuments(writer) {
  let docs = 0;
  let rewritten = 0;
  // Une collection = deux requêtes (ses documents d'un coup, plus la liste des documents « vides »
  // qui n'ont que des sous-collections) ; les sous-collections sont parcourues en parallèle.
  async function walk(collections) {
    await Promise.all(collections.map(async (col) => {
      const [snap, refs] = await Promise.all([col.get(), col.listDocuments()]);
      for (const d of snap.docs) {
        const data = d.data();
        const copy = rewrite(data);
        if (JSON.stringify(copy) !== JSON.stringify(data)) rewritten++;
        if (writer) writer.set(target.doc(d.ref.path), copy);
        docs++;
        if (docs % 500 === 0) console.log(`  ${docs} documents…`);
      }
      for (let i = 0; i < refs.length; i += 20) {
        await Promise.all(refs.slice(i, i + 20).map(async (ref) => walk(await ref.listCollections())));
      }
    }));
  }
  await walk(await source.listCollections());
  return { docs, rewritten };
}

async function copyFiles() {
  const oldBucket = admin.storage().bucket(oldBucketName);
  const newBucket = admin.storage().bucket(newBucketName);
  const [files] = await oldBucket.getFiles();
  let bytes = 0;
  for (const f of files) bytes += Number(f.metadata.size || 0);
  if (confirmed) {
    let n = 0;
    for (let i = 0; i < files.length; i += 10) {
      // Copie côté Google : les métadonnées (type, jeton de téléchargement) suivent le fichier.
      await Promise.all(files.slice(i, i + 10).map((f) => f.copy(newBucket.file(f.name))));
      n += files.slice(i, i + 10).length;
      if (n % 50 === 0 || n === files.length) console.log(`  ${n}/${files.length} fichiers…`);
    }
  }
  return { files: files.length, mo: Math.round(bytes / 1e6) };
}

(async () => {
  console.log(`Base : (default) -> ${targetDb}`);
  console.log(`Fichiers : ${oldBucketName} -> ${newBucketName}\n`);
  const writer = confirmed ? target.bulkWriter() : null;
  const { docs, rewritten } = await copyDocuments(writer);
  if (writer) await writer.close();
  console.log(`Documents : ${docs} (dont ${rewritten} avec une adresse de photo ou vidéo réécrite)`);
  const { files, mo } = await copyFiles();
  console.log(`Fichiers : ${files} (${mo} Mo)`);
  console.log(confirmed
    ? '\nCopie terminée. L\'ancienne base et l\'ancien bucket sont intacts.'
    : '\nRien n\'a été copié. Relancez avec --oui pour copier.');
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
