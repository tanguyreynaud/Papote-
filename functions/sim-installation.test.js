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

test('ordreReporte : un « Retirer le code PIN » reporté devient le test qui le suit (-apres-pin)', () => {
  const T0 = Date.parse('2026-11-13T10:00:00Z');
  const pin = m.ordreReporte({ id: 'abc', type: 'simPin', demandeLe: T0, simAttendue: '8933' });
  assert.strictEqual(pin.id, 'abc-apres-pin');
  assert.strictEqual(pin.type, 'simTest');
  assert.strictEqual(pin.simAttendue, '8933');
  assert.ok(m.repondA({ id: 'abc', type: 'simPin' }, { id: pin.id }), 'le résultat répond à l\'ordre en cours');
  const test = m.ordreReporte({ id: 'xyz', type: 'simTest', demandeLe: T0, simAttendue: '8933' });
  assert.strictEqual(test.id, 'xyz');
  assert.strictEqual(test.type, 'simTest');
});

// ---------- SMS et appel d'essai (Tanguy, 17/11) ----------
const APPEL = { numero: '+33612345678', secondes: 20, texte: 'Papote : test de la carte SIM de T-003' };
const ordreAppel = { ...ordre, appel: APPEL };
const smsOk = { ok: true, code: -1, ms: 2100 };
const appelOk = { ok: true, secondes: 20 };
const va = (test, plus = {}) => m.verdict({ ordre: ordreAppel, test, simAttendue: ICCID, maintenant: T0 + 10_000, ...plus });

test('numeroEssai : portable français 06/07 normalisé en +33, tout le reste refusé', () => {
  assert.strictEqual(m.numeroEssai('0612345678'), '+33612345678');
  assert.strictEqual(m.numeroEssai('07 12 34 56 78'), '+33712345678');
  assert.strictEqual(m.numeroEssai('06.12.34.56.78'), '+33612345678');
  assert.strictEqual(m.numeroEssai('+33 6 12 34 56 78'), '+33612345678');
  assert.strictEqual(m.numeroEssai('0033612345678'), '+33612345678');
  for (const faux of ['0112345678', '061234567', '06123456789', '+44612345678', '+33112345678', 'abc', '', null, 612345678]) {
    assert.strictEqual(m.numeroEssai(faux), null, String(faux));
  }
  assert.strictEqual(m.numeroLisible('+33612345678'), '06 12 34 56 78');
  assert.strictEqual(m.numeroLisible(''), '');
});

test('appelPourOrdre : rien sans numéro valable ; sinon numéro, 20 s et texte du SMS', () => {
  assert.strictEqual(m.appelPourOrdre('', 'T-003'), null);
  assert.strictEqual(m.appelPourOrdre('0112345678', 'T-003'), null);
  assert.deepStrictEqual(m.appelPourOrdre('06 12 34 56 78', 'T-003'), APPEL);
  // Reporté (et le « Retirer le code PIN » devenu test « -apres-pin ») avec son appel.
  assert.deepStrictEqual(m.ordreReporte({ id: 'a', type: 'simPin', demandeLe: T0, simAttendue: '1', appel: APPEL }).appel, APPEL);
  assert.strictEqual(m.ordreReporte({ id: 'a', type: 'simTest', demandeLe: T0, simAttendue: '1' }).appel, undefined);
});

test('verdict avec appel : OK seulement avec SMS parti et appel passé ; coches sms et appel', () => {
  const r = va(resultat({ sms: smsOk, appel: appelOk }));
  assert.strictEqual(r.ok, true, r.message);
  assert.deepStrictEqual(r.coches, { carte: true, reseau: true, inscrite: true, internet: true, sms: true, appel: true });
  assert.match(r.message, /SMS parti et appel passé/);
  assert.deepStrictEqual(r.appel, { ok: true, secondes: 20, raison: null });
  // Sans numéro d'essai : pas de coches sms ni appel (comme avant).
  assert.deepStrictEqual(Object.keys(v(resultat()).coches), ['carte', 'reseau', 'inscrite', 'internet']);
});

test('verdict avec appel : chaque raison a son message clair, rien d\'anxiogène', () => {
  const cas = [
    [{}, /n'a pas fait l'essai de SMS et d'appel : mettez à jour/],
    [{ sms: { ok: false, code: -1, ms: 30000 }, appel: appelOk }, /pas parti dans les 30 secondes/],
    [{ sms: { ok: false, code: 4, ms: 900 }, appel: appelOk }, /SMS d'essai n'est pas parti\. Vérifiez que la ligne permet les SMS/],
    [{ sms: smsOk, appel: { ok: false, secondes: 2, raison: 'coupe' } }, /arrêté trop tôt \(au bout de 2 s\)/],
    [{ sms: smsOk, appel: { ok: false, secondes: 0, raison: 'refuse' } }, /n'a pas laissé passer l'appel/],
    [{ sms: { ok: false, code: 0, ms: 0 }, appel: { ok: false, secondes: 0, raison: 'sans-permission' } }, /autorisation/],
    [{ sms: smsOk, appel: { ok: false, secondes: 0, raison: 'erreur' } }, /n'a pas pu passer l'appel d'essai : redémarrez-la/],
    [{ sms: { ok: false, code: 0, ms: 0 }, appel: { ok: false, secondes: 0, raison: 'numero' } }, /pas un portable français/],
  ];
  for (const [plus, re] of cas) {
    const r = va(resultat(plus));
    assert.strictEqual(r.ok, false, re.source);
    assert.match(r.message, re);
    assert.doesNotMatch(r.message, /erreur|échec|danger|!/i, `${re.source} : rien d'anxiogène`);
  }
  // Une carte absente reste dite comme avant, même avec l'appel raté.
  assert.match(va(resultat({ etat: 'absente', appel: { ok: false, secondes: 0, raison: 'erreur' } })).message, /Aucune carte détectée/);
  assert.strictEqual(va(resultat({ sms: smsOk, appel: { ok: false, secondes: 3, raison: 'coupe' } })).coches.sms, true);
});

test('verdict avec appel : la tablette a 90 s pour répondre avant « pas encore répondu »', () => {
  assert.match(va(undefined, { maintenant: T0 + 60_000 }).message, /appelle votre portable/);
  assert.match(va(undefined, { maintenant: T0 + m.SILENCE_APPEL_MS + 1 }).message, /pas encore répondu/);
  assert.strictEqual(m.SILENCE_APPEL_MS, 90_000);
  assert.match(v(undefined, { maintenant: T0 + 60_000 }).message, /pas encore répondu/, 'sans appel : 45 s comme avant');
});

test('resultatPropre : sms et appel recopiés, validés et bornés', () => {
  const r = m.resultatPropre({ ...resultat(), sms: { ok: true, code: -1.4, ms: 1e9, plus: 1 }, appel: { ok: 'oui', secondes: 20.6, raison: 'autre', x: 1 } });
  assert.deepStrictEqual(r.sms, { ok: true, code: -1, ms: 600_000 });
  assert.deepStrictEqual(r.appel, { ok: false, secondes: 21, raison: null });
  assert.deepStrictEqual(m.resultatPropre({ ...resultat(), appel: { ok: false, secondes: 'x', raison: 'refuse' } }).appel, { ok: false, secondes: null, raison: 'refuse' });
  const sans = m.resultatPropre(resultat());
  assert.strictEqual(sans.sms, null);
  assert.strictEqual(sans.appel, null);
});

test('refusSimNonTestee : test fait avec appel, l\'envoi demande aussi le SMS et l\'appel', () => {
  const ligne = { iccid: ICCID };
  const fiche = (simTest) => ({ ref: 'T-003', simId: 's', simTest: { ok: true, simAttendue: ICCID, ...simTest } });
  assert.strictEqual(m.refusSimNonTestee(fiche({ avecAppel: true, sms: smsOk, appel: appelOk }), ligne), '');
  assert.match(m.refusSimNonTestee(fiche({ avecAppel: true, sms: smsOk, appel: { ok: false, secondes: 0, raison: 'refuse' } }), ligne), /SMS ou l'appel d'essai de la tablette T-003/);
  assert.match(m.refusSimNonTestee(fiche({ avecAppel: true, sms: null, appel: null }), ligne), /testez à nouveau/);
  assert.strictEqual(m.refusSimNonTestee(fiche({ avecAppel: false }), ligne), '', 'test sans numéro d\'essai : comme avant');
});

// Répondeur de la ligne de la tablette (##002#, Tanguy 19/11) : affiché, ne bloque jamais l'envoi.
test('resultatPropre : répondeur recopié, validé et borné', () => {
  const r = m.resultatPropre({ ...resultat(), repondeur: { ok: true, essais: 1.2, x: 1 } });
  assert.deepStrictEqual(r.repondeur, { ok: true, essais: 1, raison: null });
  assert.deepStrictEqual(m.resultatPropre({ ...resultat(), repondeur: { ok: 'oui', essais: 99, raison: 'autre' } }).repondeur, { ok: false, essais: 10, raison: null });
  assert.deepStrictEqual(m.resultatPropre({ ...resultat(), repondeur: { ok: false, essais: 2, raison: 'refuse' } }).repondeur, { ok: false, essais: 2, raison: 'refuse' });
  assert.strictEqual(m.resultatPropre(resultat()).repondeur, null);
});

test('verdict : répondeur coupé, en cours, refusé par l\'opérateur, appli trop vieille ; jamais bloquant', () => {
  const coupe = v(resultat({ repondeur: { ok: true, essais: 1 } }));
  assert.strictEqual(coupe.ok, true);
  assert.strictEqual(coupe.repondeur.ok, true);
  assert.match(coupe.repondeur.message, /Répondeur de la ligne coupé/);

  const enCours = v(resultat());
  assert.strictEqual(enCours.ok, true, 'la carte reste bonne pendant que le répondeur se coupe');
  assert.strictEqual(enCours.repondeur.attente, true);

  const vieux = v(resultat(), { maintenant: T0 + 5000 + m.REPONDEUR_MS + 1 });
  assert.strictEqual(vieux.repondeur.attente, false);
  assert.match(vieux.repondeur.message, /mettez à jour l'appli Papote/);

  const refuse = v(resultat({ repondeur: { ok: false, essais: 1, raison: 'refuse' } }));
  assert.strictEqual(refuse.ok, true, 'un refus de l\'opérateur ne bloque pas l\'envoi');
  assert.match(refuse.repondeur.message, /espace client/);
  assert.match(v(resultat({ repondeur: { ok: false, essais: 2, raison: 'delai' } })).repondeur.message, /réessaiera toute seule/);
  assert.match(v(resultat({ repondeur: { ok: false, essais: 0, raison: 'sans-permission' } })).repondeur.message, /autorisation Téléphone/);

  for (const raison of [...m.RAISONS_REPONDEUR, null]) {
    const msg = m.etatRepondeur({ repondeur: { ok: false, raison } }, T0).message;
    assert.doesNotMatch(msg, /urgent|danger|erreur grave|panne/i, raison);
  }
  // Carte pas inscrite : la tablette n'essaie pas, rien à dire sur le répondeur.
  assert.strictEqual(v(resultat({ etat: 'sans-reseau', inscrite: false })).repondeur, null);
});

test('refusSimNonTestee : un répondeur pas coupé ne bloque pas l\'envoi', () => {
  const fiche = { ref: 'T-009', simId: 's1', simTest: { ...m.resultatPropre(resultat({ repondeur: { ok: false, essais: 2, raison: 'refuse' } })), le: Date.now(), ok: true, simAttendue: ICCID } };
  assert.strictEqual(m.refusSimNonTestee(fiche, { iccid: ICCID }), '');
});
