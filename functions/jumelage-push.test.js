// Réveil de la tablette pas encore reliée (jumelage-push.js) : quand le serveur la prévient, et ce qu'il envoie.
const test = require('node:test');
const assert = require('node:assert');
const { doitPrevenir, prevenir } = require('./jumelage-push');

const code = { tabletUid: 't1', status: 'waiting', push: 'jeton-t1' };
const muet = { warn() {} };

test('doitPrevenir : le statut change (famille prête, annulé) ou un nouvel ordre carte SIM arrive', () => {
  assert.ok(doitPrevenir(code, { ...code, status: 'confirmed', fid: 'F1' }), 'famille prête');
  assert.ok(doitPrevenir(code, { ...code, status: 'cancelled' }));
  assert.ok(doitPrevenir(code, { ...code, ordre: { id: 'o1', type: 'simTest' } }), 'premier ordre');
  assert.ok(doitPrevenir({ ...code, ordre: { id: 'o1' } }, { ...code, ordre: { id: 'o2' } }), 'ordre suivant');
  assert.ok(doitPrevenir(undefined, code), 'création');
});

test('doitPrevenir : jamais pour ce que la tablette écrit elle-même, ni sans rien de neuf pour elle', () => {
  assert.ok(!doitPrevenir(code, { ...code, simTest: { id: 'o1', etat: 'ok' } }), 'résultat du test écrit par la tablette');
  assert.ok(!doitPrevenir({ ...code, ordre: { id: 'o1' } }, { ...code, ordre: { id: 'o1' }, simTest: { id: 'o1' } }));
  assert.ok(!doitPrevenir(code, { ...code, familyName: 'Mamie Emma' }));
  assert.ok(!doitPrevenir(code, { ...code }));
});

test('doitPrevenir : sans jeton (ancienne tablette), ou jeton qui n\'en est pas un, rien à envoyer', () => {
  const sans = { tabletUid: 't1', status: 'waiting' };
  assert.ok(!doitPrevenir(sans, { ...sans, status: 'confirmed' }));
  assert.ok(!doitPrevenir(undefined, sans));
  assert.ok(!doitPrevenir(code, { ...code, status: 'confirmed', push: '' }));
  assert.ok(!doitPrevenir(code, { ...code, status: 'confirmed', push: 42 }));
  assert.ok(!doitPrevenir(code, { ...code, status: 'confirmed', push: 'x'.repeat(4097) }));
});

test('prevenir : un message « data » en priorité haute, au seul jeton de la tablette, avec son code', async () => {
  const envois = [];
  const ok = await prevenir('ABCD1234', code, { messagerie: () => ({ send: async (m) => { envois.push(m); } }), logger: muet });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(envois, [{
    token: 'jeton-t1',
    data: { type: 'jumelage', id: 'ABCD1234' },
    android: { priority: 'high', ttl: 60_000, collapseKey: 'jumelage' },
  }]);
});

test('prevenir : sans jeton, aucun envoi', async () => {
  const envois = [];
  const ok = await prevenir('ABCD1234', { status: 'waiting' }, { messagerie: () => ({ send: async (m) => { envois.push(m); } }), logger: muet });
  assert.strictEqual(ok, false);
  assert.strictEqual(envois.length, 0);
});

test('prevenir : un envoi refusé (jeton périmé, Google en panne) ne lève pas, il est noté', async () => {
  const notes = [];
  const ok = await prevenir('ABCD1234', code, {
    messagerie: () => ({ send: async () => { const e = new Error('périmé'); e.code = 'messaging/registration-token-not-registered'; throw e; } }),
    logger: { warn: (...a) => notes.push(a) },
  });
  assert.strictEqual(ok, false);
  assert.strictEqual(notes.length, 1);
  assert.match(notes[0][0], /ABCD1234/);
  assert.strictEqual(notes[0][1], 'messaging/registration-token-not-registered');
});
