// Carte SIM sans réseau depuis plus de 2 h (sim-hors-service.js) : règles pures. Le parcours sur l'émulateur est dans
// parcours/sim-hors-service.parcours.js.
const test = require('node:test');
const assert = require('node:assert');
const { Timestamp } = require('firebase-admin/firestore');
const { decider, etatReseau, lignesAFaire, duree, DELAI_MS } = require('./sim-hors-service');
const mail = require('./mail');

const T0 = Date.parse('2026-11-13T01:00:00Z');
const MIN = 60_000;
const sim = (service, minutes, extra = {}) => ({ service, vuLe: Timestamp.fromMillis(T0 + minutes * MIN), ...extra });
const fiche = (s, plus = {}) => ({ role: 'tablette', sim: s, ...plus });
const panne = (depuis, plus = {}) => ({ simHorsService: { depuis: Timestamp.fromMillis(T0 + depuis * MIN), ...plus } });

test('la constante : 2 h', () => assert.strictEqual(DELAI_MS, 2 * 3600_000));

test('decider : début, 1 h 59, 2 h, déjà prévenu, retour, carte retirée', () => {
  assert.strictEqual(decider(fiche(sim('ok', 0)), fiche(sim('hors service', 30))).quoi, 'debut');
  assert.strictEqual(decider(fiche(sim('hors service', 148)), fiche(sim('hors service', 149), panne(30))), null);
  const d = decider(fiche(sim('hors service', 149)), fiche(sim('hors service', 150), panne(30)));
  assert.deepStrictEqual([d.quoi, d.motif], ['alerte', 'service']);
  assert.strictEqual(decider(fiche(sim('hors service', 180)), fiche(sim('hors service', 210), panne(30, { alerteLe: Timestamp.now() }))), null);
  assert.strictEqual(decider(fiche(sim('hors service', 180)), fiche(sim('ok', 210), panne(30, { alerteLe: Timestamp.now() }))).quoi, 'revenu');
  assert.strictEqual(decider(fiche(sim('hors service', 180)), fiche(null, panne(30))).quoi, 'oublier');
  assert.strictEqual(decider(fiche(sim('hors service', 180)), fiche(sim('eteint', 210), panne(30))), null, 'mode avion : on attend');
});

test('decider : pas un nouveau rapport, pas une tablette, pas de SIM, trou de plus de 2 h', () => {
  const s = sim('hors service', 200);
  assert.strictEqual(decider(fiche(s), fiche(s, panne(0))), null, 'même rapport (autre champ écrit)');
  assert.strictEqual(decider(null, { role: 'famille', sim: s }), null);
  assert.strictEqual(decider(fiche(null), fiche(null)), null);
  assert.strictEqual(decider(fiche(sim('hors service', 0)), fiche(sim('hors service', 200), panne(0))).quoi, 'debut', 'trou : le compte repart');
});

test('etatReseau : antennes du réseau hôte, absentes, vides, hôte inconnu', () => {
  const o = { reseau: '20801' };
  const b = { reseau: '20820' };
  assert.deepStrictEqual(etatReseau({ service: 'urgences', antennes: [o] }, '20820'), { panne: 'antennes', fin: false });
  assert.deepStrictEqual(etatReseau({ service: 'urgences', antennes: [o] }, null), { panne: 'service', fin: false });
  assert.deepStrictEqual(etatReseau({ service: 'ok', antennes: [] }, '20820'), { panne: null, fin: true });
  assert.deepStrictEqual(etatReseau({ service: 'ok' }, '20820'), { panne: null, fin: true });
  assert.deepStrictEqual(etatReseau({ service: 'hors service', antennes: [b] }, '20820'), { panne: 'service', fin: false });
  assert.deepStrictEqual(etatReseau({ service: 'eteint', antennes: [b] }, '20820'), { panne: null, fin: true });
  assert.deepStrictEqual(etatReseau(null, '20820'), { panne: null, fin: false });
});

test('decider : réseau hôte appris en service (antenne utilisée), envoyé par la tablette sinon', () => {
  const ok = sim('ok', 30, { antennes: [{ reseau: '20820', utilisee: true }, { reseau: '20801' }] });
  assert.deepStrictEqual(decider(fiche(sim('ok', 0)), fiche(ok)), { quoi: 'hote', hote: '20820' });
  assert.strictEqual(decider(fiche(sim('ok', 0)), fiche(ok, { simReseauHote: '20820' })), null, 'déjà connu : pas d\'écriture');
  const orange = sim('urgences', 60, { antennes: [{ reseau: '20801' }] });
  assert.strictEqual(decider(fiche(ok), fiche(orange, { simReseauHote: '20820' })).motif, 'antennes');
  const parTablette = sim('ok', 60, { reseauHote: '20820', antennes: [{ reseau: '20801' }] });
  assert.strictEqual(decider(fiche(ok), fiche(parTablette)).motif, 'antennes', 'sim.reseauHote envoyé par une future tablette');
});

test('lignes « À faire » et e-mails : le cas est dit', () => {
  const lignes = lignesAFaire({ pannes: {
    a: { nom: 'Mamie Jeanne', ref: 'T-003', operateur: 'Lyca Mobile', motif: 'service', depuis: Timestamp.fromMillis(T0) },
    b: { nom: 'Mamie Rose', motif: 'antennes', hote: '20820', depuis: Timestamp.fromMillis(T0 + MIN) },
  } });
  assert.match(lignes[0], /^Carte SIM hors service depuis le 13 novembre à 02 h 00 : tablette T-003 de Mamie Jeanne \(Lyca Mobile\)/);
  assert.match(lignes[1], /^Carte SIM sans antenne de son réseau .*Aucune antenne 20820/);
  assert.deepStrictEqual(lignesAFaire(null), []);
  assert.strictEqual(duree(2 * 3600_000 + 10 * MIN), '2 h 10');
  assert.strictEqual(duree(2 * 3600_000), '2 h');
  const e = mail.alerteSimHorsService({ nom: 'Mamie', motif: 'antennes', hote: '20820', depuis: T0, duree: '2 h' });
  assert.match(e.subject, /sans antenne de son réseau depuis 2 h/);
  assert.match(mail.alerteSimHorsService({ nom: 'Mamie', motif: 'service', depuis: T0, duree: '2 h' }).subject, /hors service depuis 2 h/);
  assert.match(mail.alerteSimHorsService({ nom: 'Mamie', motif: 'service', depuis: T0, duree: '3 h', revenu: true }).subject, /^Carte SIM revenue/);
});
