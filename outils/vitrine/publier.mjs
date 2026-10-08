// Publier le site vitrine (dossier vitrine/), comme l'app famille, en deux temps :
//   node outils/vitrine/publier.mjs test      -> copie à une adresse de test (canal « test »)
//   node outils/vitrine/publier.mjs en-ligne  -> mise en ligne du site public
// Ne touche jamais à l'app famille : seule la cible d'hébergement « vitrine » est publiée.
// Une seule fois avant : firebase hosting:sites:create papote --project papote-famille
// (la cible « vitrine » de firebase.json et .firebaserc pointe vers ce site).
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const mode = process.argv[2];
if (!['test', 'en-ligne'].includes(mode)) {
  console.error('Usage : node outils/vitrine/publier.mjs test | en-ligne');
  process.exit(2);
}

const run = (cmd) => spawnSync(cmd, { cwd: ROOT, shell: true, stdio: 'inherit' }).status;

const status = mode === 'test'
  ? run('firebase hosting:channel:deploy test --only vitrine --expires 30d --project papote-famille --non-interactive')
  : run('firebase deploy --only hosting:vitrine --project papote-famille --non-interactive');
process.exit(status);
