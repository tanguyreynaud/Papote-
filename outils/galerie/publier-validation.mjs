// Met en ligne les captures de l'espace Validation de l'admin sur le site Firebase « papote-validation »
// (hébergement gratuit, séparé de l'app et de la vitrine : firebase.validation.json ne décrit que ce site).
//   node outils/galerie/publier-validation.mjs
// Avant : une galerie (galerie.bat, ou seulement une partie : galerie.bat admin), qui remplit outils/galerie/validation/.
// La première fois, le site est créé tout seul (firebase hosting:sites:create papote-validation).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { assembler } = require('./validation.js');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = 'papote-validation';
const PROJET = 'papote-famille';

const run = (cmd, opts = {}) => spawnSync(cmd, { cwd: ROOT, shell: true, encoding: 'utf8', stdio: opts.lire ? 'pipe' : 'inherit' });

const resume = assembler();
if (!resume.parties.length) {
  console.error('Aucune capture : lancer d\'abord la galerie (galerie.bat).');
  process.exit(2);
}
console.log(`Écrans : ${resume.parties.join(', ')} (${resume.captures} captures${resume.retirees ? `, ${resume.retirees} anciennes retirées` : ''})`);

const sites = run(`firebase hosting:sites:list --project ${PROJET}`, { lire: true });
if (sites.status === 0 && !sites.stdout.includes(SITE)) {
  console.log(`Création du site ${SITE} (une seule fois)…`);
  if (run(`firebase hosting:sites:create ${SITE} --project ${PROJET}`).status !== 0) process.exit(1);
}
const status = run(`firebase deploy --only hosting --config firebase.validation.json --project ${PROJET} --non-interactive`).status;
if (status === 0) console.log(`\nEn ligne : admin Papote › Validation (captures sur https://${SITE}.web.app)`);
process.exit(status);
