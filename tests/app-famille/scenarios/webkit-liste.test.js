// Aucun saut silencieux sous WebKit : chaque banc.nonCouvert('webkit', '…') des scénarios a sa raison, mot pour mot,
// dans WEBKIT.md (la liste de ce qui n'est pas couvert sous Safari). Tourne sans navigateur, dans les deux moteurs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('WEBKIT.md liste chaque essai (ou partie d\'essai) non couvert sous WebKit, avec sa raison', () => {
  const liste = fs.readFileSync(path.join(__dirname, '..', 'WEBKIT.md'), 'utf8').replace(/\s+/g, ' ');
  const absents = [];
  let total = 0;
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.js') && n !== path.basename(__filename))) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const appels = src.split('nonCouvert(').length - 1;
    const raisons = [...src.matchAll(/nonCouvert\(\s*'webkit',\s*'((?:[^'\\]|\\.)+)'\s*\)/g)].map((m) => m[1].replace(/\\'/g, '\''));
    assert.strictEqual(raisons.length, appels, `${f} : nonCouvert('webkit', '<raison écrite en toutes lettres>') attendu`);
    for (const r of raisons) {
      total++;
      if (!liste.includes(`${f.replace(/\.test\.js$/, '')}`) || !liste.includes(r.replace(/\s+/g, ' '))) absents.push(`${f} : ${r}`);
    }
  }
  assert.deepStrictEqual(absents, [], 'sauts sous WebKit absents de WEBKIT.md');
  console.log(`# ${total} saut(s) sous WebKit, tous listés dans WEBKIT.md`);
});
