const test = require('node:test');
const assert = require('node:assert');
const l = require('./livraison');

const JOUR = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 9);

test('point relais choisi sur le site', () => {
  const r = l.relaisDepuisRequete({ relais: '012345', rnom: ' Tabac  du Port ', radr: '2 rue Neuve', rcp: '64200', rville: 'Biarritz', rpays: 'fr' });
  assert.deepStrictEqual(r, { id: '012345', nom: 'Tabac du Port', adresse: '2 rue Neuve', cp: '64200', ville: 'Biarritz', pays: 'FR' });
  assert.strictEqual(l.relaisDepuisRequete({ relais: '012345', rnom: 'X', rcp: '1000', rville: 'Genève', rpays: 'CH' }), null);
  assert.strictEqual(l.relaisDepuisRequete({ relais: '01 2"', rnom: 'X', rcp: '1', rville: 'Y' }), null);
  assert.strictEqual(l.relaisDepuisRequete({}), null);
});

test('aller-retour par les métadonnées Stripe', () => {
  const r = { id: '012345', nom: 'Tabac', adresse: '', cp: '64200', ville: 'Biarritz', pays: 'FR' };
  const m = l.relaisDepuisMeta(l.relaisVersMeta(r));
  assert.strictEqual(m.transporteur, 'mondial-relay');
  assert.strictEqual(m.id, '012345');
  assert.strictEqual(m.adresse, null);
  assert.strictEqual(l.relaisDepuisMeta({ formule: 'wifi' }), null);
});

test('numéro de suivi', () => {
  assert.strictEqual(l.normaliserSuivi(' 1234 5678 '), '12345678');
  assert.strictEqual(l.normaliserSuivi('12'), null);
  assert.strictEqual(l.normaliserSuivi('12<34567'), null);
  assert.strictEqual(l.lienSuivi('12345678', '64200'),
    'https://www.mondialrelay.fr/suivi-de-colis/?numeroExpedition=12345678&codePostal=64200');
});

test('rappels de jumelage à J+5 puis J+12', () => {
  assert.strictEqual(l.rappelDu(T0, 0, T0 + 4 * JOUR), null);
  assert.strictEqual(l.rappelDu(T0, 0, T0 + 5 * JOUR), 1);
  assert.strictEqual(l.rappelDu(T0, 1, T0 + 6 * JOUR), null);
  assert.strictEqual(l.rappelDu(T0, 1, T0 + 12 * JOUR), 2);
  assert.strictEqual(l.rappelDu(T0, 2, T0 + 40 * JOUR), null);
  assert.strictEqual(l.rappelDu(null, 0, T0), null);
  assert.strictEqual(l.alerteDue(T0, T0 + 20 * JOUR), true);
  assert.strictEqual(l.alerteDue(T0, T0 + 19 * JOUR), false);
});
