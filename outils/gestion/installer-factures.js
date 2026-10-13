// Range le mot de passe de la boîte mail relevée pour les factures (secret FACTURES_MOT_DE_PASSE).
//   Boîte et serveur : FACTURES_IMAP dans functions/.env (ssl0.ovh.net:993:contact@mapapote.fr).
// Le mot de passe est vérifié auprès du serveur de mail s'il le peut, puis rangé dans Firebase ;
// il est lu dans le presse-papiers puis effacé, jamais affiché ni écrit dans le dépôt.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const PROJET = 'papote-famille';
const ENV = path.join(__dirname, '..', '..', 'functions', '.env');

function lirePressePapiers() {
  try {
    return execSync('powershell -NoProfile -Command Get-Clipboard', { encoding: 'utf8' }).replace(/[\r\n]+$/, '');
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
  return new Promise((ok) => rl.question(question, (r) => { rl.close(); ok(r); }));
}

function boite() {
  const ligne = fs.readFileSync(ENV, 'utf8').split(/\r?\n/).find((l) => l.startsWith('FACTURES_IMAP='));
  const [hote, port, utilisateur] = (ligne || 'FACTURES_IMAP=ssl0.ovh.net:993:contact@mapapote.fr').slice(14).split(':');
  return { hote, port: Number(port) || 993, utilisateur };
}

// Connexion d'essai avec imapflow (functions/node_modules), si les modules sont installés.
async function essayer({ hote, port, utilisateur }, motDePasse) {
  let ImapFlow;
  try {
    ({ ImapFlow } = require(path.join(__dirname, '..', '..', 'functions', 'node_modules', 'imapflow')));
  } catch (e) {
    return null;
  }
  const client = new ImapFlow({ host: hote, port, secure: true, logger: false, auth: { user: utilisateur, pass: motDePasse } });
  try {
    await client.connect();
    await client.logout();
    return true;
  } catch (e) {
    return false;
  }
}

(async () => {
  const b = boite();
  console.log(`Boîte relevée : ${b.utilisateur} (serveur ${b.hote}:${b.port}).`);
  let motDePasse = '';
  while (!motDePasse) {
    const tape = await demander(`Copiez le mot de passe de ${b.utilisateur}, puis appuyez sur Entrée ici : `);
    motDePasse = tape.trim() ? tape.replace(/[\r\n]+$/, '') : lirePressePapiers();
    if (!motDePasse) {
      console.log('Le presse-papiers est vide. Copiez le mot de passe et réessayez.');
      continue;
    }
    const ok = await essayer(b, motDePasse);
    if (ok === false) {
      console.log('Le serveur de mail refuse ce mot de passe (ou le serveur indiqué dans functions/.env est faux). Réessayez.');
      motDePasse = '';
    } else if (ok) {
      console.log('Connexion à la boîte réussie.');
    }
  }
  viderPressePapiers();
  const fichier = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papote-')), 'secret.txt');
  fs.writeFileSync(fichier, motDePasse, { mode: 0o600 });
  try {
    execSync(`firebase functions:secrets:set FACTURES_MOT_DE_PASSE --project ${PROJET} --data-file "${fichier}" --force`,
      { stdio: 'inherit' });
  } finally {
    fs.rmSync(path.dirname(fichier), { recursive: true, force: true });
  }
  console.log('Mot de passe rangé dans Firebase. Redéployez les fonctions pour que les factures soient relevées.');
})();
