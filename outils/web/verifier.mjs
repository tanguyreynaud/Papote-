// Vérifications de l'app famille (web/) avant toute mise en ligne :
//  1. chaque fichier JavaScript se lit sans erreur de syntaxe (modules) ;
//  2. chaque nom importé d'un fichier local existe bien dans ce fichier (export) ;
//  3. chaque élément cherché par $('…') ou getElementById('…') existe dans la page qui charge le script.
// Usage : node outils/web/verifier.mjs   (code de sortie 1 en cas de problème)
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const problems = [];
const read = (p) => readFileSync(join(WEB, p), 'utf8');

const scripts = ['sw.js', ...readdirSync(join(WEB, 'js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`)];

// 1. Syntaxe (en module, comme dans le navigateur).
for (const file of scripts) {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: read(file), encoding: 'utf8' });
  if (r.status !== 0) problems.push(`${file} : erreur de syntaxe\n${(r.stderr || '').split('\n').slice(0, 4).join('\n')}`);
}

// 2. Imports locaux ↔ exports.
function exportsOf(file) {
  const src = read(file);
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  return names;
}
for (const file of scripts.filter((f) => f.startsWith('js/'))) {
  const src = read(file);
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.\/[^']+)'/g)) {
    const target = `js/${m[2].slice(2)}`;
    let available;
    try { available = exportsOf(target); } catch (e) { problems.push(`${file} : fichier importé introuvable ${target}`); continue; }
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name && !available.has(name)) problems.push(`${file} : « ${name} » n'est pas exporté par ${target}`);
    }
  }
}

// 3. Identifiants d'éléments utilisés au chargement des pages.
const pages = { 'index.html': ['js/famille.js', 'js/agenda.js', 'js/notifs.js'], 'admin.html': ['js/admin.js'] };
for (const [page, files] of Object.entries(pages)) {
  const html = read(page);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(/(?:\$|getElementById)\('([A-Za-z0-9_-]+)'\)/g)) {
      if (!ids.has(m[1])) problems.push(`${file} : l'élément #${m[1]} n'existe pas dans ${page}`);
    }
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} problème(s) :\n- ${[...new Set(problems)].join('\n- ')}`);
  process.exit(1);
}
console.log(`✓ App famille vérifiée : ${scripts.length} scripts, imports et éléments de page cohérents.`);
