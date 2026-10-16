// Vide l'ancienne base Firestore (default, États-Unis) et l'ancien bucket Storage, une fois la
// bascule en Europe validée. Plus aucune donnée des familles ne reste aux États-Unis.
//
// On garde UNIQUEMENT le document config/base de l'ancienne base : c'est lui qui dit aux tablettes,
// à l'app famille et à l'admin d'aller sur la base « europe ». Sans lui, tout repartirait sur
// l'ancienne base vide.
//
// Avant d'effacer quoi que ce soit, le script vérifie que config/base pointe bien vers l'Europe
// et que la base « europe » contient des familles.
//
//   vider-ancienne-base.bat         : montre ce qui serait effacé
//   vider-ancienne-base.bat --oui   : efface (IRRÉVERSIBLE)
// Options : --base europe  --ancien-bucket papote-famille.firebasestorage.app
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
const newDb = option('base', 'europe');
const oldBucketName = option('ancien-bucket', 'papote-famille.firebasestorage.app');

if (!fs.existsSync(keyPath)) {
  console.error(`Clé introuvable : ${keyPath}`);
  process.exit(1);
}

const app = admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });
const oldDb = getFirestore(app);
const europe = getFirestore(app, newDb);

async function main() {
  // 1. Garde-fous : la bascule doit être faite et la nouvelle base remplie.
  const signal = await oldDb.doc('config/base').get();
  if (!signal.exists || signal.get('database') !== newDb) {
    console.error(`Arrêt : config/base de l'ancienne base ne pointe pas vers « ${newDb} ». Rien n'est effacé.`);
    process.exit(1);
  }
  const familiesEurope = (await europe.collection('families').count().get()).data().count;
  if (!familiesEurope) {
    console.error(`Arrêt : la base « ${newDb} » ne contient aucune famille. Rien n'est effacé.`);
    process.exit(1);
  }
  console.log(`Bascule vérifiée : config/base -> ${newDb}, ${familiesEurope} famille(s) en Europe.`);

  // 2. Ce qui serait effacé dans l'ancienne base (tout sauf config/base).
  const collections = await oldDb.listCollections();
  for (const col of collections) {
    const n = (await col.count().get()).data().count;
    const kept = col.id === 'config' ? ' (config/base gardé)' : '';
    console.log(`  ${col.id} : ${n} document(s) et leurs sous-collections${kept}`);
  }
  const bucket = admin.storage().bucket(oldBucketName);
  const [files] = await bucket.getFiles({ autoPaginate: true });
  console.log(`  Bucket ${oldBucketName} : ${files.length} fichier(s)`);

  if (!confirmed) {
    console.log('\nRien n\'a été effacé. Relancer avec --oui pour vider (IRRÉVERSIBLE).');
    return;
  }

  // 3. Effacement.
  for (const col of collections) {
    if (col.id === 'config') {
      for (const ref of await col.listDocuments()) {
        if (ref.id !== 'base') await oldDb.recursiveDelete(ref);
      }
    } else {
      await oldDb.recursiveDelete(col);
    }
    console.log(`  ${col.id} : vidé`);
  }
  await bucket.deleteFiles({ force: true });
  console.log(`  Bucket ${oldBucketName} : vidé`);
  console.log('\nAncienne base et ancien bucket vidés. config/base est gardé.');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
