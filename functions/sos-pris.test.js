// « Je m'en occupe » pendant un SOS (sos-pris.js) : le premier proche gagne, les autres apprennent qui s'en occupe ;
// rien pour un SOS fini, un inconnu, ou un SOS d'avant déjà pris.
const test = require('node:test');
const assert = require('node:assert');
const { prendre } = require('./sos-pris');

const FID = 'famille-emma';
const T0 = Date.parse('2026-11-20T14:32:00Z');
const HORODATAGE = { serveur: true };

// Base en mémoire : documents par chemin, requête « role == tablette » sur les membres, transactions l'une après
// l'autre (comme Firestore les rejoue quand deux se croisent : la deuxième voit l'écriture de la première).
function fausseBase(docs) {
  const lus = new Map(Object.entries(docs).map(([k, v]) => [k, structuredClone(v)]));
  const instantane = (chemin) => ({
    id: chemin.split('/').pop(),
    exists: lus.has(chemin),
    data: () => structuredClone(lus.get(chemin)),
    get: (champ) => (lus.has(chemin) ? structuredClone(lus.get(chemin)[champ]) : undefined),
  });
  let file = Promise.resolve();
  const base = {
    lus,
    ecritures: 0,
    doc: (chemin) => ({ chemin }),
    collection: (col) => ({
      where: (champ, op, valeur) => ({ requete: { col, champ, op, valeur } }),
    }),
    runTransaction(f) {
      const tour = file.then(() => f({
        get: async (r) => {
          if (r.chemin) return instantane(r.chemin);
          const { col, champ, valeur } = r.requete;
          const docsTrouves = [...lus.keys()]
            .filter((k) => k.startsWith(`${col}/`) && k.split('/').length === col.split('/').length + 1 && lus.get(k)[champ] === valeur)
            .map(instantane);
          return { docs: docsTrouves, empty: !docsTrouves.length };
        },
        update: (r, v) => { base.ecritures += 1; lus.set(r.chemin, { ...lus.get(r.chemin), ...structuredClone(v) }); },
      }));
      file = tour.catch(() => {});
      return tour;
    },
  };
  return base;
}

function famille({ sos = { debut: T0, fin: '', uid: '', nom: '' }, sosPris } = {}) {
  return fausseBase({
    [`families/${FID}`]: { name: 'Mamie Emma', createdBy: 'julie', ...(sosPris ? { sosPris } : {}) },
    [`families/${FID}/members/julie`]: { name: 'Julie', role: 'famille', status: 'active' },
    [`families/${FID}/members/paul`]: { name: 'Paul', role: 'famille', status: 'active' },
    [`families/${FID}/members/zoe`]: { name: 'Zoé', role: 'famille', status: 'pending' },
    [`families/${FID}/members/tab`]: { name: 'Tablette', role: 'tablette', ...(sos ? { sos } : {}) },
    [`families/${FID}/members/tab-appels`]: { name: 'Tablette', role: 'tablette' },
    'families/famille-rose/members/eve': { name: 'Ève', role: 'famille', status: 'active' },
  });
}

const deps = (db, maintenant = T0 + 60_000) => ({ db, horodatage: () => HORODATAGE, maintenant: () => maintenant });
const sosPrisDe = (db) => db.lus.get(`families/${FID}`).sosPris;

test('le premier proche qui touche « Je m\'en occupe » gagne : sosPris = { uid, nom, le, debut }', async () => {
  const db = famille();
  assert.deepStrictEqual(await prendre(deps(db), 'julie', { fid: FID, debut: T0 }), { ok: true, nom: 'Julie' });
  assert.deepStrictEqual(sosPrisDe(db), { uid: 'julie', nom: 'Julie', le: HORODATAGE, debut: T0 });
});

test('le deuxième est refusé avec le prénom de celui qui s\'en occupe ; le même proche qui retouche reste gagnant', async () => {
  const db = famille();
  await prendre(deps(db), 'julie', { fid: FID, debut: T0 });
  const r = await prendre(deps(db), 'paul', { fid: FID, debut: T0 });
  assert.deepStrictEqual(r, { ok: false, raison: 'deja', uid: 'julie', nom: 'Julie', message: 'Julie s\'en occupe déjà.' });
  assert.deepStrictEqual(await prendre(deps(db), 'julie', { fid: FID, debut: T0 }), { ok: true, nom: 'Julie' });
  assert.strictEqual(db.ecritures, 1, 'une seule écriture de sosPris');
  assert.strictEqual(sosPrisDe(db).uid, 'julie');
});

test('deux proches en même temps : un seul gagne, une seule écriture', async () => {
  const db = famille();
  const [a, b] = await Promise.all([
    prendre(deps(db), 'paul', { fid: FID, debut: T0 }),
    prendre(deps(db), 'julie', { fid: FID, debut: T0 }),
  ]);
  assert.deepStrictEqual([a.ok, b.ok], [true, false]);
  assert.strictEqual(b.message, 'Paul s\'en occupe déjà.');
  assert.strictEqual(db.ecritures, 1);
});

test('SOS déjà fini sur la tablette (repondu, arrete, pris) : refusé, rien d\'écrit', async () => {
  for (const fin of ['repondu', 'arrete', 'pris']) {
    const db = famille({ sos: { debut: T0, fin, uid: fin === 'arrete' ? '' : 'paul', nom: fin === 'arrete' ? '' : 'Paul' } });
    const r = await prendre(deps(db), 'julie', { fid: FID, debut: T0 });
    assert.strictEqual(r.ok, false, fin);
    assert.strictEqual(r.raison, 'fini', fin);
    assert.strictEqual(r.fin, fin);
    assert.strictEqual(sosPrisDe(db), undefined, fin);
  }
});

test('SOS de plus de 32 min encore « en cours » (tablette éteinte) ou inconnu : refusé', async () => {
  let db = famille();
  assert.strictEqual((await prendre(deps(db, T0 + 33 * 60_000), 'julie', { fid: FID, debut: T0 })).raison, 'fini');
  assert.strictEqual(sosPrisDe(db), undefined);
  db = famille({ sos: null });
  assert.strictEqual((await prendre(deps(db), 'julie', { fid: FID, debut: T0 })).raison, 'inconnu');
  db = famille();
  assert.strictEqual((await prendre(deps(db), 'julie', { fid: FID, debut: T0 - 1 })).raison, 'inconnu');
  assert.strictEqual(db.ecritures, 0);
});

test('pas membre, en attente, ou la tablette elle-même : refusé (permission-denied)', async () => {
  const db = famille();
  for (const uid of ['eve', 'zoe', 'tab', 'inconnu']) {
    const r = await prendre(deps(db), uid, { fid: FID, debut: T0 });
    assert.strictEqual(r.code, 'permission-denied', uid);
  }
  assert.strictEqual((await prendre(deps(db), null, { fid: FID, debut: T0 })).code, 'unauthenticated');
  for (const data of [{}, { fid: FID }, { fid: '../x', debut: T0 }, { fid: FID, debut: '123' }, { fid: FID, debut: -1 }, null]) {
    assert.strictEqual((await prendre(deps(db), 'julie', data)).code, 'invalid-argument', JSON.stringify(data));
  }
  assert.strictEqual(db.ecritures, 0);
});

test('nouveau SOS après un ancien sosPris : accepté (l\'ancien ne bloque pas)', async () => {
  const avant = T0 - 3 * 3600_000;
  const db = famille({ sosPris: { uid: 'julie', nom: 'Julie', le: 'hier', debut: avant } });
  assert.deepStrictEqual(await prendre(deps(db), 'paul', { fid: FID, debut: T0 }), { ok: true, nom: 'Paul' });
  assert.deepStrictEqual(sosPrisDe(db), { uid: 'paul', nom: 'Paul', le: HORODATAGE, debut: T0 });
});

test('aucune notification ni e-mail : le module ne charge ni push.js ni mail.js', () => {
  const src = require('node:fs').readFileSync(require.resolve('./sos-pris'), 'utf8');
  assert.doesNotMatch(src, /require\(['"]\.\/(push|mail|reveil)['"]\)/);
});
