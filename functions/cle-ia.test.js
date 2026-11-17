// Alerte « clé IA (Anthropic) refusée » (cle-ia.js) : un seul e-mail par 24 h, rien pour une simple panne.
const test = require('node:test');
const assert = require('node:assert');
const Anthropic = require('@anthropic-ai/sdk');
const { signalerCleIA, refusDeCle, DOCUMENT, TEXTE } = require('./cle-ia');

const T0 = Date.parse('2026-11-11T08:00:00Z');
const HEURE = 3600_000;

const erreurApi = (statut, type) => Anthropic.APIError.generate(statut, { type: 'error', error: { type, message: 'refus' } }, 'refus', new Headers());

function fausseBase() {
  const docs = new Map();
  const ecrire = (chemin, v) => docs.set(chemin, { ...(docs.get(chemin) || {}), ...v });
  const doc = (chemin) => ({ chemin, set: async (v) => ecrire(chemin, v) });
  return {
    docs,
    doc,
    async runTransaction(f) {
      return f({
        get: async (r) => ({ exists: docs.has(r.chemin), data: () => ({ ...docs.get(r.chemin) }) }),
        set: (r, v) => ecrire(r.chemin, v),
      });
    },
  };
}

function temoin() {
  const envoyes = [];
  return { envoyes, prevenir: async (titre, detail) => envoyes.push({ titre, detail }) };
}

test('refusDeCle : 401, 403, authentication_error ; pas 500, 529, 429 ni une erreur réseau', () => {
  assert.strictEqual(refusDeCle(erreurApi(401, 'authentication_error')), true);
  assert.strictEqual(refusDeCle(erreurApi(403, 'permission_error')), true);
  assert.strictEqual(refusDeCle({ error: { type: 'error', error: { type: 'authentication_error' } } }), true);
  assert.strictEqual(refusDeCle(erreurApi(500, 'api_error')), false);
  assert.strictEqual(refusDeCle(erreurApi(529, 'overloaded_error')), false);
  assert.strictEqual(refusDeCle(erreurApi(429, 'rate_limit_error')), false);
  assert.strictEqual(refusDeCle(new Error('ECONNRESET')), false);
  assert.strictEqual(refusDeCle(null), false);
});

test('401 : une alerte ; second 401 dans les 24 h : pas de nouvelle alerte ; après 24 h : une nouvelle', async () => {
  const db = fausseBase();
  const { envoyes, prevenir } = temoin();
  assert.strictEqual(await signalerCleIA(erreurApi(401, 'authentication_error'), { db, prevenir, source: 'le chat du site', maintenant: T0 }), 'alerte');
  assert.strictEqual(envoyes.length, 1);
  assert.strictEqual(envoyes[0].titre, 'La clé IA (Anthropic) est refusée');
  assert.ok(envoyes[0].detail.startsWith(TEXTE), envoyes[0].detail);
  assert.match(envoyes[0].detail, /le chat du site : erreur 401/);

  assert.strictEqual(await signalerCleIA(erreurApi(401, 'authentication_error'), { db, prevenir, maintenant: T0 + HEURE }), 'deja');
  assert.strictEqual(await signalerCleIA(erreurApi(403, 'permission_error'), { db, prevenir, maintenant: T0 + 23 * HEURE }), 'deja');
  assert.strictEqual(envoyes.length, 1, 'pas de nouvel e-mail dans les 24 h');
  assert.strictEqual(db.docs.get(DOCUMENT).dernierRefusLe.toMillis(), T0 + 23 * HEURE, 'le dernier refus est noté');

  assert.strictEqual(await signalerCleIA(erreurApi(401, 'authentication_error'), { db, prevenir, maintenant: T0 + 25 * HEURE }), 'alerte');
  assert.strictEqual(envoyes.length, 2);
});

test('500 : aucune alerte, rien d\'écrit', async () => {
  const db = fausseBase();
  const { envoyes, prevenir } = temoin();
  assert.strictEqual(await signalerCleIA(erreurApi(500, 'api_error'), { db, prevenir, maintenant: T0 }), null);
  assert.strictEqual(await signalerCleIA(new Error('timeout'), { db, prevenir, maintenant: T0 }), null);
  assert.strictEqual(envoyes.length, 0);
  assert.strictEqual(db.docs.size, 0);
});

test('jamais la clé ni le message d\'Anthropic dans l\'e-mail ou la base ; ne lève jamais d\'erreur', async () => {
  const cle = 'sk-ant-api03-SECRET';
  const e = erreurApi(401, 'authentication_error');
  e.message = `invalid x-api-key ${cle}`;
  const db = fausseBase();
  const { envoyes, prevenir } = temoin();
  await signalerCleIA(e, { db, prevenir, maintenant: T0 });
  assert.ok(!JSON.stringify(envoyes).includes(cle));
  assert.ok(!JSON.stringify([...db.docs.values()]).includes(cle));
  assert.ok(!JSON.stringify([...db.docs.values()]).includes('invalid x-api-key'));

  // Base illisible ou e-mail qui échoue : pas d'erreur levée ; un e-mail raté peut repartir au refus suivant.
  const cassee = { doc: () => ({}), runTransaction: async () => { throw new Error('base indisponible'); } };
  assert.strictEqual(await signalerCleIA(erreurApi(401, 'authentication_error'), { db: cassee, prevenir, maintenant: T0 }), null);
  const db2 = fausseBase();
  const rate = async () => { throw new Error('SMTP en panne'); };
  assert.strictEqual(await signalerCleIA(erreurApi(401, 'authentication_error'), { db: db2, prevenir: rate, maintenant: T0 }), null);
  assert.strictEqual(await signalerCleIA(erreurApi(401, 'authentication_error'), { db: db2, prevenir, maintenant: T0 + HEURE }), 'alerte');
});

test('IA de l\'admin : un 401 déclenche le signalement, la réponse à l\'admin ne change pas', async () => {
  const { creer, MESSAGE_PANNE } = require('./ia-admin')._test;
  const signales = [];
  const base = {
    collection: () => { throw new Error('pas de parc'); },
    doc: () => ({}),
    runTransaction: async () => true, // quota du jour : accordé
  };
  const iaAdmin = creer({
    db: () => base,
    client: () => ({ messages: { create: async () => { throw erreurApi(401, 'authentication_error'); } } }),
    maintenant: () => T0,
    signalerCle: async (e, o) => { signales.push({ statut: e.status, source: o.source }); return 'alerte'; },
  });
  const r = await iaAdmin({ auth: { uid: 'a', token: { admin: true } }, data: { question: 'Que faire ?' } });
  assert.deepStrictEqual(r, { ok: false, raison: 'indisponible', reponse: MESSAGE_PANNE });
  assert.deepStrictEqual(signales, [{ statut: 401, source: 'l\'IA de l\'admin' }]);
});
