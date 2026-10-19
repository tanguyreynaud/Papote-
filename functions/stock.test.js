const test = require('node:test');
const assert = require('node:assert');
const { tablettesDisponibles } = require('./stock');

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
