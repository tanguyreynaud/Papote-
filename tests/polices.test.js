// Polices de l'appli servies par Papote, plus par Google (Tanguy, 20/11) : aucune page ni le service worker ne
// demande plus rien à fonts.googleapis.com ou fonts.gstatic.com, et les trois fichiers sont bien là.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const web = path.join(__dirname, '../web');
const lire = (f) => fs.readFileSync(path.join(web, f), 'utf8');
const POLICES = ['polices/bricolage.woff2', 'polices/atkinson-400.woff2', 'polices/atkinson-700.woff2'];

test('aucune demande à Google Fonts dans l\'appli', () => {
  const fichiers = [...fs.readdirSync(web).filter((f) => /\.(html|js)$/.test(f)),
    ...fs.readdirSync(path.join(web, 'js')).map((f) => `js/${f}`), ...fs.readdirSync(path.join(web, 'css')).map((f) => `css/${f}`)];
  for (const f of fichiers) assert.doesNotMatch(lire(f), /fonts\.(googleapis|gstatic)\.com/, f);
});

test('les trois polices sont dans l\'appli, déclarées dans la page et gardées hors ligne', () => {
  const page = lire('index.html');
  const sw = lire('sw.js');
  for (const p of POLICES) {
    const octets = fs.readFileSync(path.join(web, p));
    assert.strictEqual(octets.subarray(0, 4).toString('latin1'), 'wOF2', `${p} n'est pas un fichier woff2`);
    assert.ok(page.includes(`url(${p})`), `${p} pas déclarée dans index.html`);
    assert.ok(sw.includes(`'${p}'`), `${p} pas gardée par le service worker`);
  }
  assert.match(page, /font-family: "Bricolage Grotesque";[^}]*font-display: swap/);
  assert.match(page, /font-family: "Atkinson Hyperlegible";[^}]*font-weight: 700;[^}]*font-display: swap/);
});

test('hébergement : les polices sont gardées longtemps par le navigateur, le reste toujours revérifié', () => {
  const regles = JSON.parse(fs.readFileSync(path.join(__dirname, '../firebase.json'), 'utf8')).hosting.headers;
  const de = (source) => Object.fromEntries((regles.find((r) => r.source === source) || { headers: [] }).headers.map((h) => [h.key, h.value]));
  assert.match(de('polices/**')['Cache-Control'], /max-age=31536000/);
  assert.strictEqual(de('**')['Cache-Control'], 'no-cache');
  // La règle des polices vient après « ** » : c'est la dernière qui l'emporte chez Firebase Hosting.
  assert.ok(regles.findIndex((r) => r.source === 'polices/**') > regles.findIndex((r) => r.source === '**'));
});
