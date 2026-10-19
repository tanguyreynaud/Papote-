const test = require('node:test');
const assert = require('node:assert');
const { palierAtteint, aPrevenir, message } = require('./budget');

test('paliers : rien sous 30 €, puis alerte, avertissement, coupure', () => {
  assert.strictEqual(palierAtteint(12.4), null);
  assert.strictEqual(palierAtteint(30), 'alerte');
  assert.strictEqual(palierAtteint(99.99), 'alerte');
  assert.strictEqual(palierAtteint(100), 'avertissement');
  assert.strictEqual(palierAtteint(151), 'coupure');
});

test('chaque palier n’est prévenu qu’une fois par mois', () => {
  assert.strictEqual(aPrevenir('alerte', null), true);
  assert.strictEqual(aPrevenir('alerte', 'alerte'), false);
  assert.strictEqual(aPrevenir('avertissement', 'alerte'), true);
  assert.strictEqual(aPrevenir('alerte', 'avertissement'), false);
  assert.strictEqual(aPrevenir('coupure', 'alerte'), true);
  assert.strictEqual(aPrevenir(null, null), false);
});

test('l’avertissement à 100 € annonce la coupure à 150 €', () => {
  const m = message('avertissement', 104.5, 'EUR');
  assert.match(m.subject, /coupe-circuit bientôt/);
  assert.match(m.text, /coupera tout à 150 €/);
  assert.match(m.text, /104,50 €/);
});

test('coupure ratée : e-mail urgent pour couper à la main', () => {
  assert.match(message('coupure', 152, 'EUR', false).subject, /n'a pas pu couper/);
  assert.match(message('coupure', 152, 'EUR').subject, /COUPE-CIRCUIT/);
});
