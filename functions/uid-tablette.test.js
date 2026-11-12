// Fiches des tablettes : uid écrit par le serveur pour le relais des appels (uid-tablette.js, règles 2, R3).
const test = require('node:test');
const assert = require('node:assert');
const { uidDesTablettes, regles } = require('./uid-tablette');

// Faux Firestore : une famille, ses fiches membres.
function fauxDb(fiches) {
  const ecrits = [];
  const docs = () => Object.entries(fiches).filter(([, f]) => f.role === 'tablette').map(([id, f]) => ({
    id, get: (k) => f[k],
    ref: { update: async (maj) => { if (f.efface) { const e = new Error('absent'); e.code = 5; throw e; } Object.assign(f, maj); ecrits.push([id, maj]); } },
  }));
  let requetes = 0;
  return {
    ecrits, requetes: () => requetes,
    collection: (chemin) => ({
      where: (champ, op, valeur) => {
        assert.strictEqual(chemin, 'families/F1/members');
        assert.deepStrictEqual([champ, op, valeur], ['role', '==', 'tablette']);
        return { get: async () => { requetes++; return { docs: docs() }; } };
      },
    }),
  };
}

test('une tablette sans uid : elle et le compte des appels de la famille le reçoivent, une seule fois', async () => {
  const fiches = {
    tab: { role: 'tablette', name: 'Mamie' },
    'tab-appels': { role: 'tablette', name: 'Mamie' },
    julie: { role: 'famille', uid: 'julie' },
  };
  const db = fauxDb(fiches);
  assert.strictEqual(await uidDesTablettes(db, 'F1', 'tab', fiches.tab), 2);
  assert.strictEqual(fiches.tab.uid, 'tab');
  assert.strictEqual(fiches['tab-appels'].uid, 'tab-appels');
  assert.strictEqual(fiches.julie.uid, 'julie');
  // Battement suivant de la tablette : plus rien à lire ni à écrire.
  assert.strictEqual(await uidDesTablettes(db, 'F1', 'tab', fiches.tab), 0);
  assert.strictEqual(db.requetes(), 1);
});

test('fiche d\'un proche, fiche effacée ou tablette déjà à jour : aucune lecture', async () => {
  const db = fauxDb({});
  assert.strictEqual(await uidDesTablettes(db, 'F1', 'julie', { role: 'famille', uid: 'julie' }), 0);
  assert.strictEqual(await uidDesTablettes(db, 'F1', 'tab', null), 0);
  assert.strictEqual(await uidDesTablettes(db, 'F1', 'tab', { role: 'tablette', uid: 'tab' }), 0);
  assert.strictEqual(db.requetes(), 0);
  // Un uid qui n'est pas le sien est corrigé.
  assert.strictEqual(regles.aRattraper({ role: 'tablette', uid: 'autre' }, 'tab'), true);
});

test('fiche effacée pendant le rattrapage (tablette retirée) : pas d\'erreur', async () => {
  const fiches = { tab: { role: 'tablette' }, vieille: { role: 'tablette', efface: true } };
  const db = fauxDb(fiches);
  assert.strictEqual(await uidDesTablettes(db, 'F1', 'tab', fiches.tab), 1);
});
