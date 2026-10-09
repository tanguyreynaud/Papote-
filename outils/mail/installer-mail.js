// Range le mot de passe d'envoi des e-mails de Papote dans Firebase (secret MAIL_MOT_DE_PASSE).
//   Gmail : mot de passe d'application (16 lettres) créé sur https://myaccount.google.com/apppasswords
//   Brevo : clé SMTP (xsmtpsib-...), avec MAIL_SMTP=smtp-relay.brevo.com:587:<identifiant> dans functions/.env
// Le mot de passe est lu dans le presse-papiers puis effacé ; il n'est jamais affiché ni écrit dans le dépôt.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const PROJET = 'papote-famille';

function lirePressePapiers() {
  try {
    return execSync('powershell -NoProfile -Command Get-Clipboard', { encoding: 'utf8' });
  } catch (e) {
    return '';
  }
}

function viderPressePapiers() {
  try {
    execSync('cmd /c "echo.| clip"', { stdio: 'ignore' });
  } catch (e) { /* sans importance */ }
}

function demander(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((ok) => rl.question(question, (r) => { rl.close(); ok(r.trim()); }));
}

// Mot de passe d'application Google (« abcd efgh ijkl mnop ») ou clé SMTP Brevo.
function extraire(texte) {
  const t = (texte || '').trim();
  const brevo = t.match(/xsmtpsib-[A-Za-z0-9-]+/);
  if (brevo) return brevo[0];
  const gmail = t.replace(/\s+/g, '');
  return /^[a-z]{16}$/.test(gmail) ? gmail : null;
}

(async () => {
  let motDePasse = null;
  while (!motDePasse) {
    const reponse = await demander('Copiez le mot de passe d\'application Google (16 lettres),\n'
      + 'puis appuyez sur Entrée ici (ou collez-le puis Entrée) : ');
    motDePasse = extraire(reponse) || extraire(lirePressePapiers());
    if (!motDePasse) console.log('Pas de mot de passe d\'application dans le presse-papiers. Copiez-le et réessayez.');
  }
  viderPressePapiers();
  const fichier = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papote-')), 'secret.txt');
  fs.writeFileSync(fichier, motDePasse, { mode: 0o600 });
  try {
    execSync(`firebase functions:secrets:set MAIL_MOT_DE_PASSE --project ${PROJET} --data-file "${fichier}" --force`,
      { stdio: 'inherit' });
  } finally {
    fs.rmSync(path.dirname(fichier), { recursive: true, force: true });
  }
  console.log('Mot de passe rangé dans Firebase. Redéployez les fonctions pour qu\'elles l\'utilisent.');
})();
