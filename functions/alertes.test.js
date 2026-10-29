const test = require('node:test');
const assert = require('node:assert');
const { etatAlerte, pasVueDepuisLongtemps, alertePasVueDue, numeroInconnu } = require('./alertes');

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

test('silencieuse depuis plus de 1 h 10, même débranchée : le silence passe avant', () => {
  assert.strictEqual(etatAlerte({ lastOnline: il(75), battery: { charging: false, unpluggedAt: il(85) } }, maintenant), 'silence');
});

test('60 minutes de silence en journée : pas encore d’alerte (tour de 30 min, un tour manqué)', () => {
  assert.strictEqual(etatAlerte({ lastOnline: il(60) }, maintenant), null);
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

test('veille désactivée par la famille, ou plage qui ne couvre pas 3 h : règle de jour (1 h 10)', () => {
  assert.strictEqual(etatAlerte({ lastOnline: laNuitIl(75) }, nuit, { active: false }), 'silence');
  assert.strictEqual(etatAlerte({ lastOnline: laNuitIl(75) }, nuit, { active: true, de: 23, a: 2 }), 'silence');
});

test('en journée, la veille de la famille ne change rien', () => {
  const { enVeille } = require('./alertes');
  assert.strictEqual(enVeille(undefined, maintenant), false);
  assert.strictEqual(enVeille({ active: true, de: 23, a: 7 }, nuit), true);
  assert.strictEqual(enVeille({ active: true, de: 7, a: 7 }, nuit), false);
});

test('dates Firestore (toMillis) acceptées', () => {
  const ts = (d) => ({ toMillis: () => d.getTime() });
  assert.strictEqual(etatAlerte({ lastOnline: ts(il(75)) }, maintenant), 'silence');
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
  assert.strictEqual(alertePasVueDue([{ lastSeen: hier, lastOnline: new Date(midi - 80 * MIN) }], midi), false, 'tablette hors ligne');
  assert.strictEqual(alertePasVueDue([{ lastSeen: new Date(midi - 20 * H), lastOnline: new Date(midi - MIN) }], midi), false, 'vue hier');
  assert.strictEqual(alertePasVueDue([], midi), false);
  // Deux tablettes : il suffit qu'une réponde et qu'aucune ne l'ait vue.
  assert.strictEqual(alertePasVueDue([{ lastSeen: hier, lastOnline: new Date(midi - 80 * MIN) }, { lastSeen: hier, lastOnline: new Date(midi - MIN) }], midi), true);
});

test('le compte d’appels de la tablette (jamais en ligne) ne compte pas comme une tablette qui répond', () => {
  const vieux = new Date(midi - 60 * H);
  assert.strictEqual(alertePasVueDue([{ lastSeen: vieux, lastOnline: new Date(midi - 80 * MIN) }, { joinedAt: vieux }], midi), false);
});

test('veille par défaut de 21 h à 6 h 30, demi-heures prises en compte', () => {
  const { enVeille } = require('./alertes');
  const paris = (hhmm) => Date.parse(`2026-10-19T${hhmm}:00+02:00`);
  assert.strictEqual(enVeille(undefined, paris('20:59')), false);
  assert.strictEqual(enVeille(undefined, paris('21:00')), true);
  assert.strictEqual(enVeille(undefined, paris('06:29')), true);
  assert.strictEqual(enVeille(undefined, paris('06:30')), false);
  assert.strictEqual(enVeille({ active: true, de: 22, deMin: 30, a: 7 }, paris('22:15')), false);
  assert.strictEqual(enVeille({ active: true, de: 22, deMin: 30, a: 7 }, paris('22:45')), true);
  assert.strictEqual(enVeille({ active: true, de: 23, a: 7 }, paris('06:45')), true);
});

test('numéro de la tablette à retrouver seulement s’il n’a jamais été écrit (null = « aucun », déjà cherché)', () => {
  assert.strictEqual(numeroInconnu({}), true);
  assert.strictEqual(numeroInconnu({ telephone: null }), false);
  assert.strictEqual(numeroInconnu({ telephone: '07 51 23 45 67' }), false);
});
