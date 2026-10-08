// Supprime les comptes anonymes Firebase.
//
// Par défaut : seulement ceux qui ne sont membres d'aucune famille (restes de tests,
// téléphones qui ont quitté la famille, navigateurs vidés). Les autres sont gardés :
// leur compte est la seule chose qui les relie à leur famille.
//
// --tous : TOUS les comptes anonymes, avec leurs fiches membres (anciennes fiches « Tablette »
// comprises). À lancer seulement quand les tablettes ont leurs nouveaux comptes e-mail et que
// la famille se connecte avec Google ou par e-mail. Ensuite, désactiver « Anonyme » dans la console.
//
// Sans --oui : affiche seulement ce qui serait supprimé. Avec --oui : supprime (irréversible).
// Clé d'administration : %USERPROFILE%\.papote\cle-admin-firebase.json (jamais dans le dépôt).
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('firebase-admin');

const keyPath = process.env.PAPOTE_CLE_ADMIN
  || path.join(os.homedir(), '.papote', 'cle-admin-firebase.json');
const confirmed = process.argv.includes('--oui');
const all = process.argv.includes('--tous');

if (!fs.existsSync(keyPath)) {
  console.error(`Clé introuvable : ${keyPath}`);
  console.error('Console Firebase > Paramètres du projet > Comptes de service > Générer une nouvelle clé privée,');
  console.error('puis enregistrez le fichier sous ce nom.');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });

// uid -> fiches membres (une par famille).
async function memberDocs() {
  const snap = await admin.firestore().collectionGroup('members').get();
  const byUid = new Map();
  for (const d of snap.docs) {
    if (!byUid.has(d.id)) byUid.set(d.id, []);
    byUid.get(d.id).push(d);
  }
  return byUid;
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

function describe(doc) {
  const d = doc.data();
  const fid = doc.ref.parent.parent.id;
  return `${d.role === 'tablette' ? 'tablette' : 'membre'} « ${d.name || '?'} » (famille ${fid})`;
}

(async () => {
  const members = await memberDocs();
  const anon = await anonymousUsers();
  const linked = anon.filter((u) => members.has(u.uid));
  const unused = anon.filter((u) => !members.has(u.uid));
  const toDelete = all ? anon : unused;
  const docsToDelete = all ? linked.flatMap((u) => members.get(u.uid)) : [];

  console.log(`Comptes anonymes : ${anon.length}`);
  console.log(`  membres d'une famille : ${linked.length}${all ? ' (seront supprimés avec leurs fiches)' : ' (gardés)'}`);
  console.log(`  inutiles : ${unused.length}`);
  docsToDelete.forEach((d) => console.log(`  fiche supprimée : ${describe(d)}`));

  if (!toDelete.length) {
    console.log('\nRien à supprimer.');
    return;
  }
  if (!confirmed) {
    console.log(`\nRien n'a été supprimé. Relancez avec --oui pour supprimer ${toDelete.length} compte(s).`);
    return;
  }
  for (let i = 0; i < docsToDelete.length; i += 400) {
    const batch = admin.firestore().batch();
    docsToDelete.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += 1000) {
    const res = await admin.auth().deleteUsers(toDelete.slice(i, i + 1000).map((u) => u.uid));
    deleted += res.successCount;
    res.errors.forEach((e) => console.error(`  échec : ${e.error.message}`));
  }
  console.log(`\n${docsToDelete.length} fiche(s) membre et ${deleted} compte(s) supprimé(s).`);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
