// Range la clé Anthropic du chat de support de Papote dans Firebase (secret ANTHROPIC_API_KEY).
//   Clé créée sur https://console.anthropic.com/settings/keys (sk-ant-api...).
// La clé est lue dans le presse-papiers puis effacée ; elle n'est jamais affichée ni écrite dans le dépôt.
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

function extraire(texte) {
  // Une clé collée deux fois d'affilée : on ne garde que la première.
  const m = (texte || '').match(/sk-ant-[A-Za-z0-9_-]{20,}/);
  return m ? m[0].split(/(?=sk-ant-)/)[0] : null;
}

(async () => {
  let cle = null;
  while (!cle) {
    const reponse = await demander('Copiez la clé Anthropic (sk-ant-api...), puis appuyez sur Entrée ici (ou collez-la puis Entrée) : ');
    cle = extraire(reponse) || extraire(lirePressePapiers());
    if (!cle) {
      // Seulement le début du presse-papiers, jamais une clé entière.
      const debut = (lirePressePapiers() || '').trim().slice(0, 7);
      console.log(`Pas de clé Anthropic (sk-ant-...) dans le presse-papiers${debut ? ` (il commence par « ${debut} »)` : ' (il est vide)'}. Copiez-la et réessayez.`);
    }
  }
  viderPressePapiers();
  const fichier = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papote-')), 'secret.txt');
  fs.writeFileSync(fichier, cle, { mode: 0o600 });
  try {
    execSync(`firebase functions:secrets:set ANTHROPIC_API_KEY --project ${PROJET} --data-file "${fichier}" --force`,
      { stdio: 'inherit' });
  } finally {
    fs.rmSync(path.dirname(fichier), { recursive: true, force: true });
  }
  console.log('Clé rangée dans Firebase. Redéployez les fonctions pour que le chat l\'utilise.');
})();
