// « Installer la carte SIM » (sim-installation.js) : règles pures. Le parcours sur l'émulateur est dans
// parcours/sim-installation.parcours.js, l'écran de l'admin dans tests/app-famille (admin-sim-installation).
const test = require('node:test');
const assert = require('node:assert');
const { Timestamp } = require('firebase-admin/firestore');
const m = require('./sim-installation');

const T0 = Date.parse('2026-11-13T10:00:00Z');
const ICCID = '8933150000000001234';
const ordre = { id: 'abc123', type: 'simTest', demandeLe: T0 };
const resultat = (plus = {}) => ({
  id: 'abc123', le: Timestamp.fromMillis(T0 + 5000), iccid: ICCID, mcc: '208', mnc: '01', operateur: 'Orange',
  etat: 'ok', inscrite: true, itinerance: false, donnees: { ok: true, ms: 230 }, ...plus,
});
const v = (test, plus = {}) => m.verdict({ ordre, test, simAttendue: ICCID, maintenant: T0 + 10_000, ...plus });

test('memeCarte : complet, 13 derniers chiffres, sans chiffre de contrôle, trop court, autre carte', () => {
  assert.ok(m.memeCarte(ICCID, ICCID));
  assert.ok(m.memeCarte('89 33 15 0000 0000 01234', ICCID), 'espaces');
  assert.ok(m.memeCarte(ICCID, `99${ICCID.slice(2)}`), '13 derniers chiffres');
  assert.ok(m.memeCarte(`${ICCID}7`, ICCID), 'ICCID de 20 chiffres lu sur 19');
  assert.ok(!m.memeCarte(ICCID, '1234'), 'trop court');
  assert.ok(!m.memeCarte(ICCID, '8933150000000005678'));
  assert.ok(!m.memeCarte('', ICCID));
  assert.ok(!m.memeCarte(ICCID, null));
});

test('verdict OK : bonne carte, réseau français, inscrite, internet, résultat récent', () => {
  const r = v(resultat());
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.coches, { carte: true, reseau: true, inscrite: true, internet: true });
  assert.strictEqual(r.ms, 230);
  assert.strictEqual(r.operateur, 'Orange');
  assert.match(r.message, /La carte marche/);
});

test('verdict : chaque état de la tablette a son message en mots simples', () => {
  const attendus = {
    absente: /Aucune carte détectée : vérifiez qu'elle est bien dans la tablette/,
    pin: /demande un code PIN : touchez « Retirer le code PIN »/,
    puk: /PUK/,
    verrouillee: /verrouillée/,
    etrangere: /pas sur un réseau français/,
    'sans-reseau': /ne capte pas encore le réseau/,
    'donnees-ko': /pas internet/,
  };
  for (const [etat, re] of Object.entries(attendus)) {
    const r = v(resultat({ etat, ...(etat === 'etrangere' ? { mcc: '234' } : {}), ...(etat === 'donnees-ko' ? { donnees: { ok: false, ms: null } } : {}) }));
    assert.strictEqual(r.ok, false, etat);
    assert.match(r.message, re, etat);
    assert.doesNotMatch(r.message, /erreur|échec|danger|!/i, `${etat} : rien d'anxiogène`);
  }
  assert.strictEqual(v(resultat({ etat: 'etrangere', mcc: '234' })).coches.reseau, false);
  assert.strictEqual(v(resultat({ etat: 'absente', iccid: null })).coches.carte, false);
});

test('verdict : mauvaise carte, itinérance, internet coupé, résultat trop vieux', () => {
  const mauvaise = v(resultat({ iccid: '8933150000000005678' }));
  assert.strictEqual(mauvaise.ok, false);
  assert.strictEqual(mauvaise.coches.carte, false);
  assert.match(mauvaise.message, /Ce n'est pas la carte choisie.*…5678.*…1234/);
  const itinerance = v(resultat({ itinerance: true }));
  assert.strictEqual(itinerance.ok, false);
  assert.strictEqual(itinerance.coches.reseau, false);
  assert.strictEqual(v(resultat({ donnees: { ok: false, ms: 0 } })).ok, false);
  const vieux = v(resultat(), { maintenant: T0 + 5000 + m.FRAIS_MS });
  assert.strictEqual(vieux.ok, false);
  assert.match(vieux.message, /plus de 10 minutes/);
  assert.strictEqual(v(resultat(), { maintenant: T0 + 5000 + m.FRAIS_MS - 1 }).ok, true);
});

test('verdict : pas d\'ordre, en attente, silence, résultat d\'un autre ordre, test après le retrait du code PIN', () => {
  assert.strictEqual(m.verdict({ ordre: null, test: resultat(), simAttendue: ICCID, maintenant: T0 }).ok, false);
  const attente = v(undefined);
  assert.strictEqual(attente.attente, true);
  assert.match(attente.message, /quelques secondes/);
  assert.match(v(undefined, { maintenant: T0 + 60_000 }).message, /pas encore répondu.*Bienvenue/);
  assert.strictEqual(v(resultat({ id: 'ancien' })).attente, true, 'résultat d\'un ordre précédent : on attend encore');
  assert.strictEqual(v(resultat({ id: 'abc123-apres-pin' })).ok, true);
  assert.strictEqual(m.idDeBase('abc123-apres-pin'), 'abc123');
  assert.ok(!m.repondA(ordre, resultat({ id: 'abc123-apres-pin-apres-pin' })));
});

test('pairingPourOrdre : le plus récent, en attente, pas expiré, de la même série, d\'un compte prouvé', () => {
  const p = (code, minutes, plus = {}) => ({
    code, serie: 'S1', status: 'waiting', tabletUid: 'tab', createdAt: Timestamp.fromMillis(T0 + minutes * 60_000),
    expiresAt: Timestamp.fromMillis(T0 + (minutes + 15) * 60_000), ...plus,
  });
  const ctx = { serie: 'S1', comptes: ['tab'], maintenant: T0 + 16 * 60_000 };
  assert.strictEqual(m.pairingPourOrdre([p('A', 0), p('B', 15), p('C', 14)], ctx).code, 'B');
  assert.strictEqual(m.pairingPourOrdre([p('A', 0)], ctx), null, 'expiré');
  assert.strictEqual(m.pairingPourOrdre([p('B', 15, { status: 'confirmed' })], ctx), null);
  assert.strictEqual(m.pairingPourOrdre([p('B', 15, { tabletUid: 'intrus' })], ctx), null, 'n° de série recopié par un autre compte');
  assert.strictEqual(m.pairingPourOrdre([p('B', 15, { serie: 'S2' })], ctx), null);
});

test('ordreDejaParti (double clic) et ordreAReporter (nouveau code)', () => {
  const o = { id: 'x', type: 'simTest', demandeLe: T0, codes: ['A'] };
  assert.ok(m.ordreDejaParti(o, 'simTest', T0 + 2000));
  assert.ok(!m.ordreDejaParti(o, 'simPin', T0 + 2000), 'autre bouton');
  assert.ok(!m.ordreDejaParti(o, 'simTest', T0 + m.DOUBLON_MS), 'plus tard : nouveau test');
  assert.ok(!m.ordreDejaParti({ ...o, repondu: true }, 'simTest', T0 + 2000), 'déjà répondu : nouveau test');
  assert.ok(m.ordreAReporter(o, 'B', T0 + 60_000));
  assert.ok(!m.ordreAReporter(o, 'A', T0 + 60_000), 'même code');
  assert.ok(!m.ordreAReporter({ ...o, repondu: true }, 'B', T0 + 60_000));
  assert.ok(!m.ordreAReporter(o, 'B', T0 + m.REPORT_MS), 'trop vieux');
  assert.ok(!m.ordreAReporter(null, 'B', T0));
});

test('resultatPropre : champs gardés, état inconnu refusé', () => {
  const r = m.resultatPropre({ ...resultat(), autre: 'x', mcc: 208 });
  assert.strictEqual(r.le, T0 + 5000);
  assert.strictEqual(r.mcc, '208');
  assert.strictEqual(r.autre, undefined);
  assert.strictEqual(m.resultatPropre({ ...resultat(), etat: 'bizarre' }), null);
  assert.strictEqual(m.resultatPropre(null), null);
});

test('refusSimNonTestee : sans carte, pas testée, test raté, carte changée depuis, test réussi', () => {
  const ligne = { iccid: ICCID };
  assert.strictEqual(m.refusSimNonTestee({ ref: 'T-003' }, null), '');
  assert.match(m.refusSimNonTestee({ ref: 'T-003', simId: 's' }, ligne), /Testez d'abord la carte SIM dans la tablette T-003/);
  assert.match(m.refusSimNonTestee({ ref: 'T-003', simId: 's', simTest: { ok: false, simAttendue: ICCID } }, ligne), /Testez d'abord/);
  assert.match(m.refusSimNonTestee({ ref: 'T-003', simId: 's', simTest: { ok: true, simAttendue: '8933150000000005678' } }, ligne), /a changé depuis son test/);
  assert.strictEqual(m.refusSimNonTestee({ ref: 'T-003', simId: 's', simTest: { ok: true, simAttendue: ICCID } }, ligne), '');
});
