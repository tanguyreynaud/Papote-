// Supprime les comptes anonymes Firebase qui ne sont membres d'aucune famille
// (restes de tests, téléphones qui ont quitté la famille, navigateurs vidés).
// Les tablettes et les téléphones encore membres d'une famille sont gardés :
// leur compte est la seule chose qui les relie à leur famille.
//
// Sans option : affiche seulement ce qui serait supprimé. Avec --oui : supprime.
// Clé d'administration : %USERPROFILE%\.papote\cle-admin-firebase.json (jamais dans le dépôt).
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('firebase-admin');

const keyPath = process.env.PAPOTE_CLE_ADMIN
  || path.join(os.homedir(), '.papote', 'cle-admin-firebase.json');
const delete_ = process.argv.includes('--oui');

if (!fs.existsSync(keyPath)) {
  console.error(`Clé introuvable : ${keyPath}`);
  console.error('Console Firebase > Paramètres du projet > Comptes de service > Générer une nouvelle clé privée,');
  console.error('puis enregistrez le fichier sous ce nom.');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });

async function memberUids() {
  const snap = await admin.firestore().collectionGroup('members').select().get();
  return new Set(snap.docs.map((d) => d.id));
}

async function anonymousUsers() {
  const users = [];
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    for (const u of page.users) {
      if (u.providerData.length === 0 && !u.email && !u.phoneNumber) users.push(u);
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return users;
}

(async () => {
  const members = await memberUids();
  const anon = await anonymousUsers();
  const kept = anon.filter((u) => members.has(u.uid));
  const unused = anon.filter((u) => !members.has(u.uid));

  console.log(`Comptes anonymes : ${anon.length}`);
  console.log(`  gardés (membres d'une famille, dont les tablettes) : ${kept.length}`);
  console.log(`  inutiles : ${unused.length}`);

  if (!unused.length) return;
  if (!delete_) {
    console.log('\nRien n\'a été supprimé. Relancez avec --oui pour supprimer les comptes inutiles.');
    return;
  }
  let deleted = 0;
  for (let i = 0; i < unused.length; i += 1000) {
    const res = await admin.auth().deleteUsers(unused.slice(i, i + 1000).map((u) => u.uid));
    deleted += res.successCount;
    res.errors.forEach((e) => console.error(`  échec : ${e.error.message}`));
  }
  console.log(`\n${deleted} compte(s) supprimé(s).`);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
