const test = require('node:test');
const assert = require('node:assert');
const { nomVoix, cheminFichier, texteDe, texteAnnonce, VOIX, MAX } = require('./voix');

test('voix selon le genre du proche : Orus pour un homme, Kore sinon', () => {
  assert.strictEqual(nomVoix('homme'), VOIX.homme);
  assert.strictEqual(nomVoix('femme'), VOIX.femme);
  assert.strictEqual(nomVoix(''), VOIX.femme);
  assert.strictEqual(nomVoix(undefined), VOIX.femme);
});

test('un même texte avec la même voix retombe sur le même fichier (payé une fois)', () => {
  const a = cheminFichier('f1', VOIX.femme, 'Gros bisous');
  assert.strictEqual(a, cheminFichier('f1', VOIX.femme, 'Gros bisous'));
  assert.notStrictEqual(a, cheminFichier('f1', VOIX.homme, 'Gros bisous'));
  assert.notStrictEqual(a, cheminFichier('f1', VOIX.femme, 'Gros bisous !'));
  assert.match(a, /^families\/f1\/voix\/[0-9a-f]{40}\.mp3$/);
});

test('texte lu : nettoyé, vide si absent, coupé à la longueur maximale', () => {
  assert.strictEqual(texteDe({ text: '  Coucou  ' }, 'text'), 'Coucou');
  assert.strictEqual(texteDe({}, 'text'), '');
  assert.strictEqual(texteDe({ text: 42 }, 'text'), '');
  assert.strictEqual(texteDe({ title: 'x'.repeat(500) }, 'title').length, MAX);
});

test('annonce « Prénom vous écrit : » : même texte pour tous les messages d’un proche (un seul fichier)', () => {
  assert.strictEqual(texteAnnonce('Julie'), 'Julie vous écrit :');
  assert.strictEqual(texteAnnonce('  Julie '), 'Julie vous écrit :');
  assert.strictEqual(texteAnnonce(''), '');
  assert.strictEqual(texteAnnonce(undefined), '');
  assert.strictEqual(cheminFichier('f1', VOIX.femme, texteAnnonce('Julie')), cheminFichier('f1', VOIX.femme, texteAnnonce('Julie')));
});
