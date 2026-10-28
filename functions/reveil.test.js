const test = require('node:test');
const assert = require('node:assert');
const { reveiller, aChange, doitPinger } = require('./reveil');

// Base imitée : membres d'une famille et leurs jetons privés.
function base(membres, jetons) {
  const maj = [];
  const ref = (chemin) => ({ chemin, update: async (d) => { maj.push({ chemin, d }); } });
  return {
    maj,
    collection: (chemin) => ({
      where: (champ, op, valeur) => ({
        get: async () => {
          const docs = membres.filter((m) => m[champ] === valeur).map((m) => ({ id: m.id }));
          return { empty: !docs.length, docs };
        },
      }),
    }),
    doc: (chemin) => ref(chemin),
    getAll: async (...refs) => refs.map((r) => {
      const uid = r.chemin.split('/')[3];
      const j = jetons[uid];
      return { exists: !!j, get: (champ) => (j ? j[champ] : undefined) };
    }),
  };
}
const messagerie = (reponses, envois) => () => ({
  sendEachForMulticast: async (m) => { envois.push(m); return { responses: reponses }; },
});

test('réveil : seules les tablettes de la famille sont réveillées, en priorité haute', async () => {
  const db = base([{ id: 't1', role: 'tablette' }, { id: 'julie', role: 'famille' }], { t1: { tablette: ['jeton-t1'] }, julie: { natifs: ['jeton-julie'] } });
  const envois = [];
  const n = await reveiller(db, 'F1', { type: 'appel', id: 'c1' }, 60, messagerie([{ success: true }], envois));
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(envois[0].tokens, ['jeton-t1']);
  assert.strictEqual(envois[0].android.priority, 'high');
  assert.strictEqual(envois[0].android.ttl, 60_000);
  assert.deepStrictEqual(envois[0].data, { type: 'appel', id: 'c1' });
});

test('réveil : tablette sans jeton (ancienne version) : rien envoyé, rien ne casse', async () => {
  const db = base([{ id: 't1', role: 'tablette' }], {});
  const envois = [];
  assert.strictEqual(await reveiller(db, 'F1', { type: 'famille' }, 600, messagerie([], envois)), 0);
  assert.strictEqual(envois.length, 0);
});

test('réveil : un jeton périmé est oublié', async () => {
  const db = base([{ id: 't1', role: 'tablette' }, { id: 't2', role: 'tablette' }], { t1: { tablette: ['vieux'] }, t2: { tablette: ['bon'] } });
  const envois = [];
  const n = await reveiller(db, 'F1', { type: 'famille' }, 600,
    messagerie([{ success: false, error: { code: 'messaging/registration-token-not-registered' } }, { success: true }], envois));
  assert.strictEqual(n, 1);
  assert.strictEqual(db.maj.length, 1);
  assert.strictEqual(db.maj[0].chemin, 'families/F1/members/t1/private/push');
});

test('fiche de la famille : un compte tenu par le serveur ne réveille pas la tablette', () => {
  assert.strictEqual(aChange({ name: 'Mamie', nbProches: 3 }, { name: 'Mamie', nbProches: 4 }), false);
  assert.strictEqual(aChange({ name: 'Mamie', rev: 1 }, { name: 'Mamie', rev: 2 }), true);
  assert.strictEqual(aChange({ name: 'Mamie' }, { name: 'Mamie', veille: { de: 22, a: 7 } }), true);
  assert.strictEqual(aChange(undefined, { name: 'Mamie' }), true);
});

test('auto-contrôle : ping seulement quand pingDemande change et qu\'un jeton existe', () => {
  const t = (ms) => ({ toMillis: () => ms });
  assert.strictEqual(doitPinger(null, { tablette: ['j'], pingDemande: t(1) }), true);
  assert.strictEqual(doitPinger({ tablette: ['j'], pingDemande: t(1) }, { tablette: ['j'], pingDemande: t(2) }), true);
  assert.strictEqual(doitPinger({ tablette: ['j'], pingDemande: t(1) }, { tablette: ['j'], pingDemande: t(1) }), false, 'rien de neuf');
  assert.strictEqual(doitPinger({ tablette: ['j'] }, { tablette: ['j', 'k'] }), false, 'jeton ajouté sans demande');
  assert.strictEqual(doitPinger(null, { tablette: [], pingDemande: t(1) }), false, 'pas de jeton');
  assert.strictEqual(doitPinger({ tablette: ['j'], pingDemande: t(1) }, null), false, 'document effacé');
});
