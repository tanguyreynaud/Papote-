const test = require('node:test');
const assert = require('node:assert');
const { permisEnNombre, jourParis, PLAFOND_JOUR, RESERVE_URGENTS } = require('./quota-courriels');

test('envois en nombre : jamais les 100 derniers e-mails du jour', () => {
  assert.strictEqual(PLAFOND_JOUR, 300);
  assert.strictEqual(permisEnNombre(0, 500), PLAFOND_JOUR - RESERVE_URGENTS);
  assert.strictEqual(permisEnNombre(150, 500), 50);
  assert.strictEqual(permisEnNombre(150, 20), 20);
  assert.strictEqual(permisEnNombre(250, 20), 0);
  assert.strictEqual(permisEnNombre(400, 20), 0);
});

test('compteur du jour à l\'heure de Paris (Brevo remet à zéro chaque jour)', () => {
  assert.strictEqual(jourParis(Date.parse('2027-01-31T23:30:00Z')), '2027-02-01');
  assert.strictEqual(jourParis(Date.parse('2027-07-31T21:59:00Z')), '2027-07-31');
});
