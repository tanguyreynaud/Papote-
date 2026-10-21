const test = require('node:test');
const assert = require('node:assert');
const { regles: r } = require('./installation');

test('scan du code d\'une tablette', () => {
  const t = 1_000_000;
  assert.deepStrictEqual(r.decisionScan(null, 'a', t), { etat: 'inconnu' });
  assert.deepStrictEqual(r.decisionScan({ status: 'waiting', expiresAt: t + 1 }, 'a', t), { etat: 'reserver' });
  assert.deepStrictEqual(r.decisionScan({ status: 'waiting', expiresAt: t - 1 }, 'a', t), { etat: 'expire' });
  // Réservée : pas de minuterie, le même compte reprend, un autre voit qui installe.
  const resa = { status: 'reserved', expiresAt: t - 99_999, claimedBy: 'a', claimedName: 'Julie' };
  assert.deepStrictEqual(r.decisionScan(resa, 'a', t), { etat: 'reprendre', fid: null });
  assert.deepStrictEqual(r.decisionScan(resa, 'b', t), { etat: 'occupe', par: 'Julie' });
  assert.deepStrictEqual(r.decisionScan({ ...resa, status: 'confirmed', fid: 'F' }, 'a', t), { etat: 'reprendre', fid: 'F' });
  assert.deepStrictEqual(r.decisionScan({ status: 'cancelled', claimedBy: 'a' }, 'a', t), { etat: 'expire' });
  assert.deepStrictEqual(r.decisionScan({ status: 'claimed' }, 'a', t), { etat: 'expire' });
});

test('ville de la météo depuis le point relais', () => {
  assert.deepStrictEqual(r.villeDuRelais({ livraison: { ville: 'SAINT-MARTIN-DE-VALAMAS' } }), { nom: 'Saint-Martin-De-Valamas' });
  assert.deepStrictEqual(r.villeDuRelais({ livraison: { ville: 'LYON 06' } }), { nom: 'Lyon' });
  assert.deepStrictEqual(r.villeDuRelais({ livraison: { ville: 'VALENCE CEDEX 9' } }), { nom: 'Valence' });
  assert.deepStrictEqual(r.villeDuRelais({ livraison: { ville: 'Lyon' } }), { nom: 'Lyon' });
  assert.strictEqual(r.villeDuRelais({ livraison: {} }), null);
  assert.strictEqual(r.villeDuRelais(null), null);
});

test('code saisi', () => {
  assert.strictEqual(r.normaliserCode('abcd-2345'), 'ABCD2345');
  assert.strictEqual(r.normaliserCode('abc'), null);
});

test('coordonnées de la ville du point relais', async () => {
  const reponse = (communes) => async () => ({ json: async () => communes });
  const deux = [{ nom: 'Lyon', centre: { coordinates: [4.85, 45.76] } }, { nom: 'Villeurbanne', centre: { coordinates: [4.88, 45.77] } }];
  assert.deepStrictEqual(await r.villeAvecCoordonnees({ nom: 'Lyon' }, '69006', reponse(deux)), { nom: 'Lyon', lat: 45.76, lon: 4.85 });
  assert.deepStrictEqual(await r.villeAvecCoordonnees({ nom: 'Saint-Martin-De-Valamas' }, '07310',
    reponse([{ nom: 'Saint-Martin-de-Valamas', centre: { coordinates: [4.37, 44.94] } }])), { nom: 'Saint-Martin-de-Valamas', lat: 44.94, lon: 4.37 });
  assert.deepStrictEqual(await r.villeAvecCoordonnees({ nom: 'Ailleurs' }, '69006', reponse(deux)), { nom: 'Ailleurs' });
  assert.deepStrictEqual(await r.villeAvecCoordonnees({ nom: 'Lyon' }, '69006', async () => { throw new Error('réseau'); }), { nom: 'Lyon' });
  assert.deepStrictEqual(await r.villeAvecCoordonnees({ nom: 'Lyon' }, null), { nom: 'Lyon' });
  assert.strictEqual(await r.villeAvecCoordonnees(null, '69006'), null);
});
