const test = require('node:test');
const assert = require('node:assert');
const { etatAlerte, pasVueDepuisLongtemps, alertePasVueDue } = require('./alertes');

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

const H = 3600_000;
test('pas vue depuis deux jours : 48 h sans caméra ni toucher, l\'un ou l\'autre suffit', () => {
  assert.strictEqual(pasVueDepuisLongtemps({ lastSeen: new Date(midi - 47 * H) }, midi), false, 'vue avant-hier midi : pas encore');
  assert.strictEqual(pasVueDepuisLongtemps({ lastSeen: new Date(midi - 49 * H) }, midi), true);
  assert.strictEqual(pasVueDepuisLongtemps({ lastSeen: new Date(midi - 60 * H), lastActive: new Date(midi - 3 * H) }, midi), false, 'touchée ce matin');
  assert.strictEqual(pasVueDepuisLongtemps({ joinedAt: new Date(midi - 72 * H) }, midi), true, 'jamais vue depuis son arrivée il y a 3 jours');
  assert.strictEqual(pasVueDepuisLongtemps({ joinedAt: new Date(midi - 10 * H) }, midi), false, 'installée ce matin');
  assert.strictEqual(pasVueDepuisLongtemps({}, midi), false, 'rien de connu : rien');
});

test('pas vue depuis deux jours : seulement si une tablette répond encore (sinon « ne répond plus » a déjà prévenu)', () => {
  const hier = new Date(midi - 50 * H);
  assert.strictEqual(alertePasVueDue([{ lastSeen: hier, lastOnline: new Date(midi - 2 * MIN) }], midi), true);
  assert.strictEqual(alertePasVueDue([{ lastSeen: hier, lastOnline: new Date(midi - 50 * MIN) }], midi), false, 'tablette hors ligne');
  assert.strictEqual(alertePasVueDue([{ lastSeen: new Date(midi - 20 * H), lastOnline: new Date(midi - MIN) }], midi), false, 'vue hier');
  assert.strictEqual(alertePasVueDue([], midi), false);
  // Deux tablettes : il suffit qu'une réponde et qu'aucune ne l'ait vue.
  assert.strictEqual(alertePasVueDue([{ lastSeen: hier, lastOnline: new Date(midi - 50 * MIN) }, { lastSeen: hier, lastOnline: new Date(midi - MIN) }], midi), true);
});

test('le compte d’appels de la tablette (jamais en ligne) ne compte pas comme une tablette qui répond', () => {
  const vieux = new Date(midi - 60 * H);
  assert.strictEqual(alertePasVueDue([{ lastSeen: vieux, lastOnline: new Date(midi - 50 * MIN) }, { joinedAt: vieux }], midi), false);
});
