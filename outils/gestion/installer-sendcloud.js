// Range les clés de l'intégration Sendcloud « Papote étiquettes » (secret SENDCLOUD_API = « publique:secrète »).
// Sendcloud → Paramètres → Intégrations → Sendcloud API → Connecter : nom « Papote étiquettes ».
// Les clés sont vérifiées auprès de Sendcloud, puis rangées dans Firebase ; la clé secrète est lue dans
// le presse-papiers puis effacée, jamais affichée ni écrite dans le dépôt.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const PROJET = 'papote-famille';

function lirePressePapiers() {
  try {
    return execSync('powershell -NoProfile -Command Get-Clipboard', { encoding: 'utf8' }).trim();
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

// true : clés acceptées ; false : refusées ; null : Sendcloud injoignable.
async function essayer(publique, secrete) {
  try {
    const r = await fetch('https://panel.sendcloud.sc/api/v3/shipping-options', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${publique}:${secrete}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ carrier_code: 'mondial_relay' }),
    });
    return !(r.status === 401 || r.status === 403);
  } catch (e) {
    return null;
  }
}

(async () => {
  console.log('Intégration Sendcloud « Papote étiquettes » (pas celle du site).');
  for (;;) {
    const publique = await demander('Clé publique (Public key), puis Entrée : ');
    if (!publique) continue;
    let secrete = await demander('Copiez la clé secrète (Secret key), puis appuyez sur Entrée ici : ');
    if (!secrete) secrete = lirePressePapiers();
    if (!secrete) {
      console.log('Le presse-papiers est vide. Recommençons.');
      continue;
    }
    const ok = await essayer(publique, secrete);
    if (ok === false) {
      console.log('Sendcloud refuse ces clés. Vérifiez-les et recommencez.');
      continue;
    }
    if (ok) console.log('Clés acceptées par Sendcloud.');
    viderPressePapiers();
    const fichier = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papote-')), 'secret.txt');
    fs.writeFileSync(fichier, `${publique}:${secrete}`, { mode: 0o600 });
    try {
      execSync(`firebase functions:secrets:set SENDCLOUD_API --project ${PROJET} --data-file "${fichier}" --force`, { stdio: 'inherit' });
    } finally {
      fs.rmSync(path.dirname(fichier), { recursive: true, force: true });
    }
    console.log('Clés rangées dans Firebase. Redéployez les fonctions pour créer les étiquettes depuis l\'espace admin.');
    break;
  }
})();
