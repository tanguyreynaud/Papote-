// Donne (ou retire) le badge administrateur à un compte Google.
// Les règles Firestore et Storage reconnaissent ce badge (request.auth.token.admin == true)
// au lieu d'une adresse e-mail écrite en clair dans les règles, qui sont publiques.
//
//   node badge-admin.js adresse@gmail.com          : donne le badge
//   node badge-admin.js adresse@gmail.com --retirer : le retire
// Le compte doit s'être connecté au moins une fois avec Google. Il doit ensuite se déconnecter
// et se reconnecter au tableau de bord pour que le badge soit pris en compte.
// Clé d'administration : %USERPROFILE%\.papote\cle-admin-firebase.json (jamais dans le dépôt).
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('firebase-admin');

const keyPath = process.env.PAPOTE_CLE_ADMIN
  || path.join(os.homedir(), '.papote', 'cle-admin-firebase.json');
const email = process.argv.slice(2).find((a) => !a.startsWith('--'));
const remove = process.argv.includes('--retirer');

if (!email) {
  console.error('Usage : badge-admin.bat adresse@gmail.com [--retirer]');
  process.exit(1);
}
if (!fs.existsSync(keyPath)) {
  console.error(`Clé introuvable : ${keyPath}`);
  console.error('Console Firebase > Paramètres du projet > Comptes de service > Générer une nouvelle clé privée,');
  console.error('puis enregistrez le fichier sous ce nom.');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });

(async () => {
  const user = await admin.auth().getUserByEmail(email);
  const claims = { ...(user.customClaims || {}) };
  if (remove) delete claims.admin;
  else claims.admin = true;
  await admin.auth().setCustomUserClaims(user.uid, claims);
  console.log(remove ? `Badge retiré à ${email}.` : `Badge administrateur donné à ${email}.`);
})().catch((e) => {
  console.error(e.code === 'auth/user-not-found'
    ? `Aucun compte avec l'adresse ${email} : connectez-vous d'abord une fois avec Google.`
    : (e.message || e));
  process.exit(1);
});
