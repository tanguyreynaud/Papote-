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
