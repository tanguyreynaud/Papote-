const test = require('node:test');
const assert = require('node:assert');
const { nomVoix, cheminFichier, texteDe, texteAnnonce, motParDefaut, MOTS, VOIX, MAX } = require('./voix');

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

test('annonce de prénom : dossier commun, le même fichier pour deux familles', () => {
  const a = cheminFichier(null, VOIX.femme, texteAnnonce('Julie'));
  assert.ok(a.startsWith('voix-annonces/'));
  assert.ok(!a.includes('families/'));
  assert.notStrictEqual(a, cheminFichier(null, VOIX.homme, texteAnnonce('Julie')));
});

test('photo sans légende : même petit mot que la tablette (motParDefaut de tablette.js)', () => {
  // Valeurs calculées avec la fonction de android/app/src/main/assets/tablette.js (2.99.63).
  assert.strictEqual(motParDefaut('a8Kq3xZp0LmN2vB7cD1e'), 'Plein de bisous !');
  assert.strictEqual(motParDefaut('Zz9yX8wV7uT6sR5qP4oN'), 'Gros bisous !');
  assert.strictEqual(motParDefaut('0000000000000000000a'), 'Bonne journée !');
  assert.strictEqual(MOTS.length, 7);
  assert.ok(cheminFichier(null, VOIX.homme, MOTS[4]).startsWith('voix-annonces/'));
});
