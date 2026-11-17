// reveilMembres : la fiche d'un proche change -> families/{fid}.rev + 1 (la tablette ne relit les proches qu'au
// changement de rev, Sync.java). Et reveilFamille : nom de la famille (= nom de la tablette) changé sans rev.
const test = require('node:test');
const assert = require('node:assert');
const base = require('./base');

// Base imitée, branchée avant de charger reveil.js (qui garde base.db).
const ecrits = [];
const fausseBase = {
  doc: (chemin) => ({ update: async (d) => { if (chemin === 'families/perdue') { const e = new Error('5 NOT_FOUND'); e.code = 5; throw e; } ecrits.push({ chemin, d }); } }),
  collection: () => ({ where: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
};
base.db = () => fausseBase;
base.restaurationEnCours = async () => false;
const { reveilMembres, reveilFamille, membreAChange, doitAvancerRev } = require('./reveil');

const instantane = (d, chemin) => ({ exists: !!d, data: () => d || undefined, ref: { update: async (x) => { ecrits.push({ chemin, d: x }); } } });
const membre = (avant, apres, fid = 'F1') => ({
  params: { fid, uid: 'u1' },
  data: { before: instantane(avant), after: instantane(apres) },
});
const estRev = (e, fid = 'F1') => e.chemin === `families/${fid}` && e.d.rev && e.d.rev.constructor.name === 'NumericIncrementTransform';

test('proche : nouveau prénom, nouvelle photo, photo retirée, numéro -> rev + 1', async () => {
  const julie = { name: 'Julie', role: 'famille', status: 'active', face: 'data:image/jpeg;a', telephone: '0601020304' };
  for (const apres of [{ ...julie, name: 'Juju' }, { ...julie, face: 'data:image/jpeg;b' }, { ...julie, face: null },
    { ...julie, telephone: '0700000000' }, { ...julie, enTete: 123 }]) {
    ecrits.length = 0;
    await reveilMembres.run(membre(julie, apres));
    assert.strictEqual(ecrits.length, 1, JSON.stringify(apres));
    assert.ok(estRev(ecrits[0]));
  }
});

test('proche qui arrive, est accepté ou part -> rev + 1', async () => {
  for (const [avant, apres] of [[null, { name: 'Paul', role: 'famille', status: 'pending' }],
    [{ name: 'Paul', role: 'famille', status: 'pending' }, { name: 'Paul', role: 'famille', status: 'active' }],
    [{ name: 'Paul', role: 'famille', status: 'active' }, null]]) {
    ecrits.length = 0;
    await reveilMembres.run(membre(avant, apres));
    assert.strictEqual(ecrits.length, 1);
  }
});

test('champs tenus par la tablette ou le serveur, ou genre : rien (pas de réveil en boucle)', async () => {
  const tab = { name: 'Mamie', role: 'tablette', lastOnline: 1, battery: { level: 50 } };
  const julie = { name: 'Julie', role: 'famille', status: 'active', lastActive: 1 };
  const cas = [
    [tab, { ...tab, lastOnline: 2, battery: { level: 49 }, lastSeen: 3, wifi: { ssid: 'x' }, meteoVille: 'Lyon' }],
    [tab, { ...tab, alerteType: 'silence', alerteLe: 4, recoitAppels: true }],
    [tab, { ...tab, name: 'Mamie Rose', face: 'data:image/jpeg;t' }], // fiche de la tablette : jamais lue par elle
    [null, tab], [tab, null],
    [julie, { ...julie, lastActive: 2, lastSeen: 5 }],
    [julie, { ...julie, genre: 'femme' }],
    [julie, { ...julie }],
  ];
  for (const [avant, apres] of cas) {
    ecrits.length = 0;
    await reveilMembres.run(membre(avant, apres));
    assert.deepStrictEqual(ecrits, [], JSON.stringify([avant, apres]));
  }
});

test('famille effacée : rien, sans erreur', async () => {
  ecrits.length = 0;
  await reveilMembres.run(membre({ name: 'Paul', role: 'famille' }, null, 'perdue'));
  assert.deepStrictEqual(ecrits, []);
});

test('membreAChange : règles', () => {
  assert.strictEqual(membreAChange(undefined, undefined), false);
  assert.strictEqual(membreAChange({ role: 'tablette' }, { role: 'famille' }), true, 'rôle changé');
});

test('nom de la famille (= nom de la tablette) changé sans rev : rev + 1, sans réveil direct (le rev réveillera)', async () => {
  ecrits.length = 0;
  const ev = (avant, apres) => ({ params: { fid: 'F1' }, data: { before: instantane(avant), after: instantane(apres, 'families/F1') } });
  await reveilFamille.run(ev({ name: 'Mamie', rev: 4 }, { name: 'Mamie Rose', rev: 4 }));
  assert.strictEqual(ecrits.length, 1);
  assert.ok(estRev(ecrits[0]));
  // Le changement de rev qui suit : réveil normal, pas de nouvel incrément (pas de boucle).
  ecrits.length = 0;
  await reveilFamille.run(ev({ name: 'Mamie Rose', rev: 4 }, { name: 'Mamie Rose', rev: 5 }));
  assert.deepStrictEqual(ecrits, []);
  // Nom changé avec rev (famille préparée) : pas d'incrément en plus.
  assert.strictEqual(doitAvancerRev(['name', 'nomAChoisir', 'rev']), false);
  assert.strictEqual(doitAvancerRev(['veille']), false);
  assert.strictEqual(doitAvancerRev(['name']), true);
});
