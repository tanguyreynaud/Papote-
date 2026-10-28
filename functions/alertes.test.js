const test = require('node:test');
const assert = require('node:assert');
const { etatAlerte, pasVueAujourdhui } = require('./alertes');

const MIN = 60_000;
const maintenant = Date.parse('2026-10-19T10:00:00Z');
const il = (minutes) => new Date(maintenant - minutes * MIN);

test('tablette branchée et en ligne : pas d’alerte', () => {
  assert.strictEqual(etatAlerte({ lastOnline: il(2), battery: { charging: true, unpluggedAt: null } }, maintenant), null);
});

test('débranchée depuis peu : pas encore d’alerte', () => {
  assert.strictEqual(etatAlerte({ lastOnline: il(1), battery: { charging: false, unpluggedAt: il(5) } }, maintenant), null);
});

test('débranchée depuis plus de 10 minutes', () => {
  assert.strictEqual(etatAlerte({ lastOnline: il(1), battery: { charging: false, unpluggedAt: il(11) } }, maintenant), 'debranchee');
});

test('silencieuse depuis plus de 45 minutes, même débranchée : le silence passe avant', () => {
  assert.strictEqual(etatAlerte({ lastOnline: il(50), battery: { charging: false, unpluggedAt: il(60) } }, maintenant), 'silence');
});

// 3 h du matin à Paris le 19 octobre 2026 = 1 h UTC : pendant la veille (23 h-7 h par défaut).
const nuit = Date.parse('2026-10-19T01:00:00Z');
const laNuitIl = (minutes) => new Date(nuit - minutes * MIN);

test('la nuit, 50 minutes de silence ne valent pas d’alerte (la tablette ne se signale qu’une fois par heure)', () => {
  assert.strictEqual(etatAlerte({ lastOnline: laNuitIl(50) }, nuit), null);
  assert.strictEqual(etatAlerte({ lastOnline: laNuitIl(50) }, nuit, { active: true, de: 22, a: 8 }), null);
});

test('la nuit, plus de 2 heures de silence : alerte', () => {
  assert.strictEqual(etatAlerte({ lastOnline: laNuitIl(125) }, nuit), 'silence');
});

test('veille désactivée par la famille, ou plage qui ne couvre pas 3 h : règle de jour (45 minutes)', () => {
  assert.strictEqual(etatAlerte({ lastOnline: laNuitIl(50) }, nuit, { active: false }), 'silence');
  assert.strictEqual(etatAlerte({ lastOnline: laNuitIl(50) }, nuit, { active: true, de: 23, a: 2 }), 'silence');
});

test('en journée, la veille de la famille ne change rien', () => {
  const { enVeille } = require('./alertes');
  assert.strictEqual(enVeille(undefined, maintenant), false);
  assert.strictEqual(enVeille({ active: true, de: 23, a: 7 }, nuit), true);
  assert.strictEqual(enVeille({ active: true, de: 7, a: 7 }, nuit), false);
});

test('dates Firestore (toMillis) acceptées', () => {
  const ts = (d) => ({ toMillis: () => d.getTime() });
  assert.strictEqual(etatAlerte({ lastOnline: ts(il(46)) }, maintenant), 'silence');
});

test('tablette jamais vue : pas d’alerte', () => {
  assert.strictEqual(etatAlerte({}, maintenant), null);
});

// 12h à Paris le 19 octobre 2026 = 10h UTC.
const midi = Date.parse('2026-10-19T10:00:00Z');

test('vue par la caméra ce matin : pas d’alerte', () => {
  assert.strictEqual(pasVueAujourdhui({ lastSeen: new Date('2026-10-19T06:30:00Z') }, midi), false);
});

test('touchée ce matin : pas d’alerte', () => {
  assert.strictEqual(pasVueAujourdhui({ lastActive: new Date('2026-10-19T08:00:00Z') }, midi), false);
});

test('vue hier soir seulement : alerte', () => {
  assert.strictEqual(pasVueAujourdhui({ lastSeen: new Date('2026-10-18T20:00:00Z'), lastActive: new Date('2026-10-18T19:00:00Z') }, midi), true);
});

test('minuit à Paris compte pour le jour même (22h30 UTC la veille)', () => {
  assert.strictEqual(pasVueAujourdhui({ lastSeen: new Date('2026-10-18T22:30:00Z') }, midi), false);
});

test('jamais vue : alerte', () => {
  assert.strictEqual(pasVueAujourdhui({}, midi), true);
});

const { alerteMatinDue } = require('./alertes');

test('pas vue ce matin : seulement si une tablette répond encore (sinon « ne répond plus » a déjà prévenu)', () => {
  const hier = new Date('2026-10-18T20:00:00Z');
  assert.strictEqual(alerteMatinDue([{ lastSeen: hier, lastOnline: new Date(midi - 2 * MIN) }], midi), true);
  assert.strictEqual(alerteMatinDue([{ lastSeen: hier, lastOnline: new Date(midi - 50 * MIN) }], midi), false, 'tablette hors ligne');
  assert.strictEqual(alerteMatinDue([{ lastSeen: new Date('2026-10-19T08:00:00Z'), lastOnline: new Date(midi - MIN) }], midi), false, 'vue ce matin');
  assert.strictEqual(alerteMatinDue([], midi), false);
  // Deux tablettes : il suffit qu'une réponde et qu'aucune ne l'ait vue.
  assert.strictEqual(alerteMatinDue([{ lastSeen: hier, lastOnline: new Date(midi - 50 * MIN) }, { lastSeen: hier, lastOnline: new Date(midi - MIN) }], midi), true);
});
