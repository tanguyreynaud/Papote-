const test = require('node:test');
const assert = require('node:assert');
const { empreinte, cleValide } = require('./appcheck');

test('clé de tablette : 32 octets en base64url', () => {
  const cle = require('node:crypto').randomBytes(32).toString('base64url');
  assert.strictEqual(cleValide(cle), true);
  assert.strictEqual(cleValide(''), false);
  assert.strictEqual(cleValide(cle + '='), false);
  assert.strictEqual(cleValide(42), false);
});

test('empreinte stable, la clé elle-même n’est jamais gardée', () => {
  assert.strictEqual(empreinte('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
