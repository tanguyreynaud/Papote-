// push.js / envoyer : quels téléphones reçoivent un message (sans Firebase : faux admin et fausse base).
const test = require('node:test');
const assert = require('node:assert');

const envois = [];
require.cache[require.resolve('firebase-admin')] = {
  exports: {
    messaging: () => ({
      sendEachForMulticast: async ({ tokens, data }) => {
        envois.push({ tokens, data });
        return { responses: tokens.map(() => ({ success: true })) };
      },
    }),
    firestore: { FieldValue: { arrayRemove: (...v) => ({ retirer: v }) } },
  },
};
const { envoyer } = require('./push');

function base(docs) {
  return {
    doc: (chemin) => ({ chemin, update: async () => {} }),
    getAll: async (...refs) => refs.map((r) => ({ get: (k) => (docs[r.chemin] || {})[k] })),
  };
}
const PUSH = 'families/F1/members/u1/private/push';

test('jeton natif rangé avant le contrôle d’origine (sans natifsV) : ignoré, les navigateurs sonnent', async () => {
  envois.length = 0;
  const db = base({ [PUSH]: { natifs: ['jeton-peut-etre-pirate'], tokens: ['web-1'] } });
  const n = await envoyer(db, 'F1', ['u1'], { type: 'appel', cid: 'c1' }, 45);
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(envois.flatMap((e) => e.tokens), ['web-1']);
});

test('jeton de connexion (natifsSeulement) : jamais vers un jeton natif non contrôlé', async () => {
  envois.length = 0;
  const db = base({ [PUSH]: { natifs: ['jeton-peut-etre-pirate'], tokens: ['web-1'] } });
  const n = await envoyer(db, 'F1', ['u1'], { type: 'connexion', cid: 'c1', connexion: 'x' }, 45, { natifsSeulement: true });
  assert.strictEqual(n, 0);
  assert.deepStrictEqual(envois.flatMap((e) => e.tokens), []);
});

test('jeton natif rangé par la page corrigée (natifsV: 2) : l’app seule sonne', async () => {
  envois.length = 0;
  const db = base({ [PUSH]: { natifs: ['natif-1'], natifsV: 2, tokens: ['web-1'] } });
  const n = await envoyer(db, 'F1', ['u1'], { type: 'appel', cid: 'c1' }, 45);
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(envois.flatMap((e) => e.tokens), ['natif-1']);
});

test('notifications Android coupées (natifs vidé par la page) : aucun téléphone, n = 0 (e-mail de secours)', async () => {
  envois.length = 0;
  const db = base({ [PUSH]: { natifs: [], natifsV: 2, tokens: [] } });
  assert.strictEqual(await envoyer(db, 'F1', ['u1'], { type: 'appel', cid: 'c1' }, 45), 0);
});
