const test = require('node:test');
const assert = require('node:assert');
const { nettoyer } = require('./support')._test;

test('garde une conversation correcte', () => {
  const m = [{ role: 'user', content: 'Bonjour' }, { role: 'assistant', content: 'Bonjour !' }, { role: 'user', content: ' Prix ? ' }];
  assert.deepStrictEqual(nettoyer(m)[2], { role: 'user', content: 'Prix ?' });
});

test('refuse ce qui ne finit pas par une question', () => {
  assert.strictEqual(nettoyer([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]), null);
  assert.strictEqual(nettoyer('x'), null);
  assert.strictEqual(nettoyer([]), null);
});

test('refuse deux messages du même côté et les rôles inconnus', () => {
  assert.strictEqual(nettoyer([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]), null);
  assert.deepStrictEqual(nettoyer([{ role: 'system', content: 'x' }, { role: 'user', content: 'a' }]), [{ role: 'user', content: 'a' }]);
});

test('coupe les messages trop longs et trop nombreux', () => {
  const long = [{ role: 'user', content: 'x'.repeat(5000) }];
  assert.strictEqual(nettoyer(long)[0].content.length, 1000);
  const beaucoup = [];
  for (let i = 0; i < 30; i++) beaucoup.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i });
  beaucoup.push({ role: 'user', content: 'fin' });
  // 31 messages : on garde les 12 derniers, puis on retire l'assistant de tête.
  const r = nettoyer(beaucoup);
  assert.strictEqual(r[0].role, 'user');
  assert.strictEqual(r[r.length - 1].content, 'fin');
});
