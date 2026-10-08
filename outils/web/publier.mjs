// Publier l'app famille en deux temps :
//   node outils/web/publier.mjs test      -> vérifications, puis copie à l'adresse de test (canal « test »)
//   node outils/web/publier.mjs en-ligne  -> vérifications, puis mise en ligne pour toutes les familles
// La version de test s'ouvre et se teste avant la mise en ligne ; l'adresse ne change pas d'une fois à l'autre.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const mode = process.argv[2];
if (!['test', 'en-ligne'].includes(mode)) {
  console.error('Usage : node outils/web/publier.mjs test | en-ligne');
  process.exit(2);
}

const run = (cmd) => spawnSync(cmd, { cwd: ROOT, shell: true, stdio: 'inherit' }).status;

if (run(`"${process.execPath}" outils/web/verifier.mjs`) !== 0) {
  console.error('Publication annulée : corrigez les problèmes ci-dessus.');
  process.exit(1);
}

const status = mode === 'test'
  ? run('firebase hosting:channel:deploy test --expires 30d --project papote-famille --non-interactive')
  : run('firebase deploy --only hosting --project papote-famille --non-interactive');
process.exit(status);
