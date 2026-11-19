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

// ---- Cause exacte et crédit épuisé (19/11 : la lecture d'un e-mail disait seulement « ne répond pas ») ----

const { causeErreurIA, creditEpuise, erreurDefinitive, DOCUMENT_CREDIT, TITRE_CREDIT } = require('./cle-ia');
const erreurMsg = (statut, type, message) => Anthropic.APIError.generate(statut, { type: 'error', error: { type, message } }, undefined, new Headers());
const MSG_CREDIT = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';

test('causeErreurIA : code HTTP, type d\'erreur et début du message d\'Anthropic', () => {
  assert.strictEqual(causeErreurIA(erreurMsg(400, 'invalid_request_error', 'messages.0.content.0: bad')),
    'erreur 400 invalid_request_error : messages.0.content.0: bad');
  assert.strictEqual(causeErreurIA(erreurMsg(529, 'overloaded_error', 'Overloaded')), 'erreur 529 overloaded_error : Overloaded');
  assert.strictEqual(causeErreurIA(erreurMsg(429, 'rate_limit_error', '')), 'erreur 429 rate_limit_error');
  const long = causeErreurIA(erreurMsg(400, 'invalid_request_error', `x${'a'.repeat(400)}\n  fin`));
  assert.ok(long.endsWith('…') && long.length < 200, long);
  // Une chaîne ressemblant à une clé n'est jamais recopiée.
  const masquee = causeErreurIA(erreurMsg(401, 'authentication_error', 'invalid x-api-key sk-ant-api03-abcDEF_123-xyz'));
  assert.ok(!/sk-ant-api03/.test(masquee) && /\[clé masquée\]/.test(masquee), masquee);
});

test('causeErreurIA : délai dépassé, connexion impossible, erreur inconnue', () => {
  assert.strictEqual(causeErreurIA(new Anthropic.APIConnectionTimeoutError()), 'délai dépassé');
  assert.strictEqual(causeErreurIA(Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' })), 'délai dépassé');
  assert.strictEqual(causeErreurIA(new Anthropic.APIConnectionError({ message: 'Connection error.' })), 'connexion impossible');
  assert.strictEqual(causeErreurIA(new Error('quelque chose')), 'erreur inattendue');
  assert.strictEqual(causeErreurIA(null), 'erreur inconnue');
});

test('creditEpuise / erreurDefinitive : 400 crédit ≠ 400 document ; 402 ; pannes passagères', () => {
  assert.strictEqual(creditEpuise(erreurMsg(400, 'invalid_request_error', MSG_CREDIT)), true);
  assert.strictEqual(creditEpuise(erreurMsg(402, 'billing_error', 'billing')), true);
  assert.strictEqual(creditEpuise(erreurMsg(400, 'invalid_request_error', 'document: bad')), false);
  assert.strictEqual(erreurDefinitive(erreurMsg(400, 'invalid_request_error', 'document: bad')), true);
  assert.strictEqual(erreurDefinitive(erreurMsg(413, 'request_too_large', 'too large')), true);
  assert.strictEqual(erreurDefinitive(erreurMsg(400, 'invalid_request_error', MSG_CREDIT)), false, 'crédit : à reprendre');
  for (const [s, t] of [[429, 'rate_limit_error'], [500, 'api_error'], [529, 'overloaded_error'], [401, 'authentication_error']]) {
    assert.strictEqual(erreurDefinitive(erreurMsg(s, t, 'x')), false, String(s));
  }
  assert.strictEqual(erreurDefinitive(new Anthropic.APIConnectionTimeoutError()), false);
});

test('crédit épuisé : alerte « crédit Anthropic épuisé », une seule par 24 h, distincte de la clé refusée', async () => {
  const db = fausseBase();
  const { envoyes, prevenir } = temoin();
  const credit = erreurMsg(400, 'invalid_request_error', MSG_CREDIT);
  assert.strictEqual(await signalerCleIA(credit, { db, prevenir, source: 'la lecture des factures', maintenant: T0 }), 'alerte');
  assert.strictEqual(envoyes.length, 1);
  assert.strictEqual(envoyes[0].titre, TITRE_CREDIT);
  assert.match(envoyes[0].detail, /^Crédit Anthropic épuisé/);
  assert.match(envoyes[0].detail, /la lecture des factures : erreur 400/);
  assert.ok(!envoyes[0].detail.includes('credit balance'), 'pas le message d\'Anthropic');
  assert.strictEqual(await signalerCleIA(credit, { db, prevenir, maintenant: T0 + HEURE }), 'deja');
  assert.strictEqual(envoyes.length, 1);
  assert.ok(db.docs.has(DOCUMENT_CREDIT) && !db.docs.has(DOCUMENT), 'document à part');
  // La clé refusée a son propre anti-doublon : une alerte malgré celle du crédit.
  assert.strictEqual(await signalerCleIA(erreurApi(401, 'authentication_error'), { db, prevenir, maintenant: T0 + 2 * HEURE }), 'alerte');
  assert.strictEqual(await signalerCleIA(credit, { db, prevenir, maintenant: T0 + 25 * HEURE }), 'alerte');
  assert.strictEqual(envoyes.length, 3);
  // Un 400 ordinaire n'alerte pas.
  assert.strictEqual(await signalerCleIA(erreurMsg(400, 'invalid_request_error', 'document: bad'), { db, prevenir, maintenant: T0 + 26 * HEURE }), null);
});
