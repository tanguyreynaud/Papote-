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
  try {
    run('git fetch --quiet origin main');
  } catch (e) {
    console.warn('Pas de réseau pour lire main : fonctions déjà préparées gardées.');
  }
  const sha = run('git rev-parse origin/main');
  const deja = fs.existsSync(marque) && fs.readFileSync(marque, 'utf8').trim() === sha
    && fs.existsSync(path.join(dossier, 'functions', 'node_modules'));
  if (deja) {
    console.log(`Fonctions de main ${sha.slice(0, 7)} déjà prêtes.`);
    return;
  }
  console.log(`Fonctions de main ${sha.slice(0, 7)} : extraction et installation…`);
  fs.rmSync(path.join(dossier, 'functions'), { recursive: true, force: true });
  fs.mkdirSync(dossier, { recursive: true });
  // git archive | tar : tar existe aussi sous Windows 10 et plus.
  run(`git archive --format=tar -o "${path.join(dossier, 'functions.tar')}" ${sha} functions`);
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
