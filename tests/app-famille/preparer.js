// Avant les tests : les fonctions serveur publiées (branche main) dans .fonctions/, et le navigateur.
// L'app famille se publie depuis sa branche, les fonctions depuis main : on teste l'app contre les fonctions
// de main, comme en ligne. PAPOTE_FONCTIONS=<dossier functions> pour en prendre d'autres.

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ici = __dirname;
const racine = path.join(ici, '..', '..');
const run = (cmd, cwd = racine) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

function fonctions() {
  if (process.env.PAPOTE_FONCTIONS) {
    console.log(`Fonctions : ${process.env.PAPOTE_FONCTIONS}`);
    return;
  }
  const dossier = path.join(ici, '.fonctions');
  const marque = path.join(dossier, 'SHA');
  // Un lot de l'admin (claude/lot-X-admin) se teste contre les fonctions de son lot jumeau (claude/lot-X-main) s'il
  // existe : les deux partent ensemble au même « Publier » (19/11 : écran admin testé contre des fonctions sans sa partie).
  let branche = 'main';
  // La branche : celle de la CI, sinon celle où l'on est (outils/verifier-avant-pousser.sh teste comme la CI).
  let brancheIci = process.env.GITHUB_REF_NAME || '';
  if (!brancheIci) try { brancheIci = run('git rev-parse --abbrev-ref HEAD'); } catch (e) { /* pas de git : main */ }
  const lot = /^claude\/lot-(.+)-admin$/.exec(brancheIci);
  if (lot) {
    try { run(`git fetch --quiet origin claude/lot-${lot[1]}-main`); branche = `claude/lot-${lot[1]}-main`; } catch (e) { /* pas de jumeau : main */ }
  }
  // Pareil pour une branche de travail de l'admin qui a besoin d'un changement des fonctions (claude/X-admin) : testée
  // contre sa jumelle claude/X-main ou claude/X si elle existe (19/11, case « Hors-forfait bloqué »), main sinon.
  const travail = !lot && /^claude\/(.+)-admin$/.exec(brancheIci);
  if (travail) {
    for (const jumelle of [`claude/${travail[1]}-main`, `claude/${travail[1]}`]) {
      try { run(`git fetch --quiet origin ${jumelle}`); branche = jumelle; break; } catch (e) { /* pas cette jumelle */ }
    }
  }
  try {
    run(`git fetch --quiet origin ${branche}`);
  } catch (e) {
    console.warn(`Pas de réseau pour lire ${branche} : fonctions déjà préparées gardées.`);
  }
  const sha = run(branche === 'main' ? 'git rev-parse origin/main' : 'git rev-parse FETCH_HEAD');
  const deja = fs.existsSync(marque) && fs.readFileSync(marque, 'utf8').trim() === sha
    && fs.existsSync(path.join(dossier, 'functions', 'node_modules'))
    && fs.existsSync(path.join(dossier, 'vitrine'));
  if (deja) {
    console.log(`Fonctions de ${branche} ${sha.slice(0, 7)} déjà prêtes.`);
    return;
  }
  console.log(`Fonctions de ${branche} ${sha.slice(0, 7)} : extraction et installation…`);
  fs.rmSync(path.join(dossier, 'functions'), { recursive: true, force: true });
  fs.rmSync(path.join(dossier, 'vitrine'), { recursive: true, force: true });
  fs.mkdirSync(dossier, { recursive: true });
  // git archive | tar : tar existe aussi sous Windows 10 et plus. vitrine/ : la bulle d'aide (chat-support.js et
  // chat-declaration.js), servie par mapapote.fr dans l'app (scenarios/declaration.test.js).
  run(`git archive --format=tar -o "${path.join(dossier, 'functions.tar')}" ${sha} functions vitrine`);
  run(`tar -xf functions.tar`, dossier);
  fs.rmSync(path.join(dossier, 'functions.tar'));
  execSync('npm ci --no-audit --no-fund', { cwd: path.join(dossier, 'functions'), stdio: 'inherit' });
  fs.writeFileSync(marque, sha);
}

function navigateur() {
  const { chromium } = require('playwright');
  if (fs.existsSync(chromium.executablePath())) return;
  console.log('Navigateur de test absent : installation de Chromium (une seule fois)…');
  execSync('npx playwright install chromium', { cwd: ici, stdio: 'inherit' });
}

// Les règles de la base et des photos : copiées ici, l'émulateur ne lit que dans son dossier.
function regles() {
  const dossier = path.join(ici, '.regles');
  fs.mkdirSync(dossier, { recursive: true });
  for (const f of ['firestore.rules', 'storage-eu.rules']) fs.copyFileSync(path.join(racine, f), path.join(dossier, f));
}

regles();
fonctions();
navigateur();
