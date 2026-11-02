// Avant chaque publication de l'hébergement (firebase.json, hosting.predeploy) : écrit web/version.json avec le
// commit publié et sa date, que l'admin affiche en bas du menu (« Version du 02/11 à 21 h 05 · d1e42b0 »).
// Ne bloque jamais la publication : sans git, le fichier n'est pas écrit et l'admin n'affiche rien.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
try {
  const [sha, date] = execFileSync('git', ['log', '-1', '--format=%h %cI'], { cwd: ROOT, encoding: 'utf8' }).trim().split(' ');
  writeFileSync(resolve(ROOT, 'web/version.json'), `${JSON.stringify({ sha, date, publieeLe: new Date().toISOString() })}\n`);
  console.log(`Version publiée : ${sha} du ${date}`);
} catch (e) {
  console.warn(`Version non notée (${e.message}) : la publication continue.`);
}
