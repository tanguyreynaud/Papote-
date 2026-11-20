// Relance « Une photo pour Mamie ? » (relances-photos.js, Tanguy 20/11) : décision sans base, puis la tâche entière
// sur une petite base en mémoire.
const test = require('node:test');
const assert = require('node:assert');
const { decision, message, relancesPhotos, SANS_ENVOI } = require('./relances-photos');

const JOUR = 24 * 3600_000;
const T = Date.parse('2026-11-20T17:00:00Z');

test('7 jours sans rien envoyer : relance ; 6 jours : rien', () => {
  assert.strictEqual(SANS_ENVOI, 7 * JOUR);
  assert.deepStrictEqual(decision({ dernierEnvoi: T - 7 * JOUR, arrivee: T - 60 * JOUR, etat: null, maintenant: T }), { relancer: true, etat: { le: T, n: 1 } });
  assert.deepStrictEqual(decision({ dernierEnvoi: T - 6 * JOUR, arrivee: T - 60 * JOUR, etat: null, maintenant: T }), { relancer: false, etat: null });
});

test('arrivé il y a moins de 7 jours, sans envoi : rien ; jamais rien envoyé depuis 7 jours : relance', () => {
  assert.strictEqual(decision({ dernierEnvoi: null, arrivee: T - 3 * JOUR, etat: null, maintenant: T }).relancer, false);
  assert.strictEqual(decision({ dernierEnvoi: null, arrivee: T - 8 * JOUR, etat: null, maintenant: T }).relancer, true);
  assert.strictEqual(decision({ dernierEnvoi: null, arrivee: null, etat: null, maintenant: T }).relancer, false);
});

test('une par semaine, puis une par mois après 2 relances sans envoi', () => {
  const d = (le, n) => decision({ dernierEnvoi: T - 40 * JOUR, arrivee: T - 90 * JOUR, etat: { le, n }, maintenant: T });
  assert.strictEqual(d(T - 6 * JOUR, 1).relancer, false, '6 jours après la 1re');
  assert.deepStrictEqual(d(T - 7 * JOUR, 1), { relancer: true, etat: { le: T, n: 2 } });
  assert.strictEqual(d(T - 7 * JOUR, 2).relancer, false, 'après 2 : plus chaque semaine');
  assert.strictEqual(d(T - 29 * JOUR, 2).relancer, false);
  assert.deepStrictEqual(d(T - 30 * JOUR, 2), { relancer: true, etat: { le: T, n: 3 } });
  assert.strictEqual(d(T - 30 * JOUR, 5).relancer, true);
});

test('un envoi après la relance remet le compte à zéro', () => {
  assert.deepStrictEqual(decision({ dernierEnvoi: T - 2 * JOUR, arrivee: T - 90 * JOUR, etat: { le: T - 10 * JOUR, n: 3 }, maintenant: T }),
    { relancer: false, etat: { le: null, n: 0 } });
  // Envoi après la relance, puis de nouveau 7 jours sans rien : relance de la semaine, compte repart à 1.
  assert.deepStrictEqual(decision({ dernierEnvoi: T - 8 * JOUR, arrivee: T - 90 * JOUR, etat: { le: T - 20 * JOUR, n: 2 }, maintenant: T }),
    { relancer: true, etat: { le: T, n: 1 } });
});

test('texte sans reproche ni accord au féminin', () => {
  const m = message('Papi Jean');
  assert.strictEqual(m.titre, 'Une photo pour Papi Jean ?');
  assert.ok(!/pas envoyé|contente|n'avez/.test(`${m.titre} ${m.texte}`));
  assert.strictEqual(message(null).titre, 'Une photo pour votre proche ?');
});

// ---------- La tâche entière, sur une base en mémoire ----------

function base(docs) {
  const d = new Map(Object.entries(docs));
  const ecrits = [];
  const snap = (chemin) => ({
    id: chemin.split('/').pop(), exists: d.has(chemin), ref: ref(chemin),
    data: () => d.get(chemin), get: (k) => (d.get(chemin) || {})[k],
  });
  const ref = (chemin) => ({
    path: chemin,
    collection: (nom) => coll(`${chemin}/${nom}`),
    get: async () => snap(chemin),
    update: async (v) => { ecrits.push({ chemin, v }); d.set(chemin, { ...d.get(chemin), ...v }); },
  });
  const coll = (chemin, filtre = () => true) => ({
    doc: (id) => ref(`${chemin}/${id}`),
    where: (champ, op, val) => coll(chemin, (x) => filtre(x) && (op !== '>=' || (x[champ] && x[champ] >= val))),
    get: async () => ({ docs: [...d.keys()].filter((k) => k.startsWith(`${chemin}/`) && !k.slice(chemin.length + 1).includes('/') && filtre(d.get(k))).map(snap) }),
  });
  return { collection: (nom) => coll(nom), ecrits, d };
}

function famille(o = {}) {
  const vue = new Date(T - 3600_000);
  return {
    'families/f1': { name: 'Mamie Emma', abonnement: { statut: 'actif' }, ...(o.famille || {}) },
    'families/f1/members/tab': { role: 'tablette', lastOnline: new Date(T - 60_000), lastSeen: o.pasVue ? new Date(T - 10 * JOUR) : vue, lastActive: o.pasVue ? new Date(T - 10 * JOUR) : vue, joinedAt: new Date(T - 90 * JOUR) },
    'families/f1/members/julie': { role: 'famille', name: 'Julie', joinedAt: new Date(T - 90 * JOUR) },
    'families/f1/members/paul': { role: 'famille', name: 'Paul', joinedAt: new Date(T - 90 * JOUR) },
    'families/f1/members/ana': { role: 'famille', name: 'Ana', status: 'pending', joinedAt: new Date(T - 90 * JOUR) },
    'families/f1/posts/p1': { type: 'photo', authorUid: 'julie', createdAt: new Date(T - 2 * JOUR) },
    'families/f1/posts/p2': { type: 'message', authorUid: 'paul', createdAt: new Date(T - 9 * JOUR) },
    ...(o.docs || {}),
  };
}
const sansPause = { collection: () => ({ where: () => ({ get: async () => ({ docs: [] }) }) }) };

async function lancer(docs) {
  const db = base(docs);
  const coll = db.collection;
  db.collection = (nom) => (nom === 'commandes' ? sansPause.collection() : coll(nom));
  const envois = [];
  const pousser = async (_db, fid, uids, data) => { envois.push({ fid, uids, data }); return 1; };
  const n = await relancesPhotos({ db, maintenant: T, pousser });
  return { n, envois, db };
}

test('tâche : seul Paul (9 jours sans rien) est relancé ; Julie (2 jours), Ana (en attente) et la tablette non', async () => {
  const { n, envois, db } = await lancer(famille());
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(envois.map((e) => e.uids), [['paul']]);
  assert.deepStrictEqual(envois[0].data, { type: 'alerte', relance: 'photo', fid: 'f1', titre: 'Une photo pour Mamie Emma ?', texte: 'Un petit moment de votre journée, et Mamie Emma le voit tout de suite sur sa tablette.' });
  assert.ok(Object.values(envois[0].data).every((v) => typeof v === 'string'), 'données FCM en chaînes');
  assert.strictEqual(db.d.get('families/f1/members/paul').relancePhotos.n, 1);
  // Le lendemain : rien de plus.
  const encore = await relancesPhotos({ db, maintenant: T + JOUR, pousser: async () => { throw new Error('relancé deux fois'); } });
  assert.strictEqual(encore, 0);
});

test('tâche : rien si « Petits rappels » coupé, si la personne n\'a pas été vue, si l\'abonnement est arrêté, ou sans téléphone atteint', async () => {
  assert.strictEqual((await lancer(famille({ docs: { 'families/f1/members/paul/private/push': { tokens: ['t'], rappelsPhotos: false } } }))).n, 0);
  assert.strictEqual((await lancer(famille({ pasVue: true }))).n, 0);
  assert.strictEqual((await lancer(famille({ famille: { abonnement: { statut: 'resilie' } } }))).n, 0);
  const db = base(famille());
  const coll = db.collection;
  db.collection = (nom) => (nom === 'commandes' ? sansPause.collection() : coll(nom));
  assert.strictEqual(await relancesPhotos({ db, maintenant: T, pousser: async () => 0 }), 0);
  assert.strictEqual(db.d.get('families/f1/members/paul').relancePhotos, undefined, 'rien noté : on réessaiera');
});
