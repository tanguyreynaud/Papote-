const test = require('node:test');
const assert = require('node:assert');
const { fusionner, LIGNES_MAX, TAILLE_MAX } = require('./journal-tablette')._test;

const lignes = (de, a) => Array.from({ length: a - de + 1 }, (_, i) => `21/11 10:00:${String(de + i).padStart(2, '0')}  ligne ${de + i}`);

test('les lignes nouvelles sont rangées à la suite', () => {
  assert.strictEqual(fusionner('a\nb', ['c\nd']), 'a\nb\nc\nd');
  assert.strictEqual(fusionner(undefined, ['x']), 'x');
  assert.strictEqual(fusionner('', ['x', 'y']), 'x\ny');
});

test('un morceau qui reprend la fin déjà là (tablette redémarrée) n’est pas recopié', () => {
  assert.strictEqual(fusionner('a\nb\nc', ['b\nc\nd']), 'a\nb\nc\nd');
  assert.strictEqual(fusionner('a\nb\nc', ['a\nb\nc']), 'a\nb\nc');
});

test('seules les 300 dernières lignes sont gardées : la fiche ne grossit jamais', () => {
  const avant = lignes(1, 290).join('\n');
  const r = fusionner(avant, [lignes(291, 320).join('\n')]).split('\n');
  assert.strictEqual(r.length, LIGNES_MAX);
  assert.strictEqual(r[0], lignes(21, 21)[0]);
  assert.strictEqual(r[r.length - 1], lignes(320, 320)[0]);
});

test('jamais plus de 60 000 caractères (règles de la base)', () => {
  const longues = Array.from({ length: 200 }, (_, i) => `${i} ${'x'.repeat(500)}`).join('\n');
  const r = fusionner(longues, [longues]);
  assert.ok(r.length <= TAILLE_MAX);
  assert.ok(r.endsWith(`199 ${'x'.repeat(500)}`));
});

test('valeurs étranges ignorées', () => {
  assert.strictEqual(fusionner('a', [null, 3, '', 'b']), 'a\nb');
});
