const test = require('node:test');
const assert = require('node:assert');
const { tablettesDisponibles, placesDisponibles, delai } = require('./stock');

const maintenant = Date.parse('2026-10-19T14:00:00Z');
const compter = (d) => tablettesDisponibles({ stock: [], commandes: [], reservations: [], maintenant, ...d });

test('les fiches libres en stock ou préparées comptent', () => {
  assert.strictEqual(compter({ stock: [{ etat: 'en-stock' }, { etat: 'preparee' }, { etat: 'revenue' }, { etat: 'chez-client' }] }), 2);
});

test('une fiche reliée à une commande ne compte plus', () => {
  const stock = [{ etat: 'en-stock' }, { etat: 'preparee', commande: 'sub_1' }];
  assert.strictEqual(compter({ stock, commandes: [{ id: 'sub_1', expedition: 'a-preparer' }] }), 1);
});

test('une commande payée sans fiche prend une tablette', () => {
  const stock = [{ etat: 'en-stock' }, { etat: 'en-stock' }];
  const commandes = [{ id: 'a', expedition: 'a-preparer' }, { id: 'b', expedition: 'envoyee' }, { id: 'c', expedition: 'annulee' }];
  assert.strictEqual(compter({ stock, commandes }), 1);
});

test('un paiement en cours prend une tablette, plus après expiration', () => {
  const stock = [{ etat: 'en-stock' }];
  assert.strictEqual(compter({ stock, reservations: [{ expireLe: maintenant + 60_000 }] }), 0);
  assert.strictEqual(compter({ stock, reservations: [{ expireLe: { toMillis: () => maintenant - 1 } }] }), 1);
});

test('jamais en dessous de zéro', () => {
  assert.strictEqual(compter({ commandes: [{ id: 'a', expedition: 'a-preparer' }] }), 0);
});

test('une commande SEPA en attente de la banque garde sa tablette', () => {
  assert.strictEqual(compter({
    stock: [{ etat: 'en-stock' }, { etat: 'en-stock' }],
    commandes: [{ id: 'a', expedition: 'paiement-en-attente' }, { id: 'b', expedition: 'annulee' }],
  }), 1);
});

test('précommandes : stock + 10 commandes, 10 même avec un stock vide', () => {
  assert.strictEqual(placesDisponibles(0), 10);
  assert.strictEqual(placesDisponibles(3), 13);
  assert.strictEqual(placesDisponibles(-4), 6);
  assert.strictEqual(placesDisponibles(-10), 0);
  assert.strictEqual(placesDisponibles(-12), 0);
});

test('délai annoncé : stock, précommande jusqu\'à stock + 10, puis attente longue', () => {
  assert.strictEqual(delai(2), 'stock');
  assert.strictEqual(delai(1), 'stock');
  assert.strictEqual(delai(0), 'precommande');
  assert.strictEqual(delai(-9), 'precommande');
  assert.strictEqual(delai(-10), 'long');
  assert.strictEqual(delai(-40), 'long');
});
