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

test('e-mails de confort : jamais dans les 100 derniers envois du jour', () => {
  const { confortPermis } = require('./quota-courriels');
  assert.strictEqual(confortPermis(0), true);
  assert.strictEqual(confortPermis(199), true);
  assert.strictEqual(confortPermis(200), false);
  assert.strictEqual(confortPermis(450), false);
});

test('confortAutorise : retenu avec une ligne de journal, compteur illisible = envoyé', async () => {
  const { confortAutorise } = require('./quota-courriels');
  const lignes = [];
  const logger = { warn: (...x) => lignes.push(x.join(' ')) };
  const db = (n, panne = false) => ({ doc: () => ({ get: async () => { if (panne) throw new Error('panne'); return { exists: true, get: () => n }; } }) });
  assert.strictEqual(await confortAutorise(db(10), { a: 'x@exemple.fr', sujet: 'Bienvenue' }, logger), true);
  assert.strictEqual(await confortAutorise(db(200), { a: 'x@exemple.fr', sujet: 'Bienvenue' }, logger), false);
  assert.match(lignes[0], /non envoyé à x@exemple\.fr/);
  assert.strictEqual(await confortAutorise(db(0, true), {}, logger), true);
});
