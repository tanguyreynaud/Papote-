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

// 3 h du matin à Paris le 19 octobre 2026 = 1 h UTC : pendant la veille (23 h-5 h par défaut).
const nuit = Date.parse('2026-10-19T01:00:00Z');
const laNuitIl = (minutes) => new Date(nuit - minutes * MIN);

test('la nuit, 50 minutes de silence ne valent pas d’alerte (la tablette ne se signale qu’une fois par heure)', () => {
  assert.strictEqual(etatAlerte({ lastOnline: laNuitIl(50) }, nuit), null);
  assert.strictEqual(etatAlerte({ lastOnline: laNuitIl(50) }, nuit, { active: true, de: 22, a: 8 }), null);
});

test('la nuit, 2 h 30 de silence ne valent pas d’alerte (la tablette ne se signale que toutes les 2 h)', () => {
  assert.strictEqual(etatAlerte({ lastOnline: laNuitIl(150) }, nuit), null);
});

test('la nuit, plus de 3 heures de silence : alerte', () => {
  assert.strictEqual(etatAlerte({ lastOnline: laNuitIl(185) }, nuit), 'silence');
});

test('au réveil, la tolérance de nuit court encore 30 min (premier tour du matin)', () => {
  // Veille par défaut 23 h-5 h. 5 h 20 à Paris le 19/10/2026 = 3 h 20 UTC, dernier signe de vie à 3 h 30 Paris.
  const matin = Date.parse('2026-10-19T03:20:00Z');
  assert.strictEqual(etatAlerte({ lastOnline: new Date(matin - 110 * MIN) }, matin), null);
  // 5 h 40 : la grâce est finie, règle de jour (1 h 10).
  const plusTard = Date.parse('2026-10-19T03:40:00Z');
  assert.strictEqual(etatAlerte({ lastOnline: new Date(plusTard - 130 * MIN) }, plusTard), 'silence');
});

test('veille désactivée par la famille : règle de jour (1 h 10)', () => {
  assert.strictEqual(etatAlerte({ lastOnline: laNuitIl(75) }, nuit, { active: false }), 'silence');
});

test('réveil hors bornes en base (2 h) : ramené à 5 h, 3 h reste la nuit (tolérance de 2 h)', () => {
  assert.strictEqual(etatAlerte({ lastOnline: laNuitIl(75) }, nuit, { active: true, de: 23, a: 2 }), null);
});

test('en journée, la veille de la famille ne change rien', () => {
  const { enVeille } = require('./alertes');
  assert.strictEqual(enVeille(undefined, maintenant), false);
  assert.strictEqual(enVeille({ active: true, de: 23, a: 7 }, nuit), true);
  // Coucher à 7 h en base : ramené à 19 h, la plage 19 h-7 h couvre 3 h.
  assert.strictEqual(enVeille({ active: true, de: 7, a: 7 }, nuit), true);
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
test('pas vue, réglé à deux jours : 48 h sans caméra ni toucher, l\'un ou l\'autre suffit', () => {
  assert.strictEqual(pasVueDepuisLongtemps({ lastSeen: new Date(midi - 47 * H) }, midi, 2), false, 'vue avant-hier midi : pas encore');
  assert.strictEqual(pasVueDepuisLongtemps({ lastSeen: new Date(midi - 49 * H) }, midi, 2), true);
  assert.strictEqual(pasVueDepuisLongtemps({ lastSeen: new Date(midi - 60 * H), lastActive: new Date(midi - 3 * H) }, midi, 2), false, 'touchée ce matin');
  assert.strictEqual(pasVueDepuisLongtemps({ joinedAt: new Date(midi - 72 * H) }, midi, 2), true, 'jamais vue depuis son arrivée il y a 3 jours');
  assert.strictEqual(pasVueDepuisLongtemps({ joinedAt: new Date(midi - 10 * H) }, midi, 2), false, 'installée ce matin');
  assert.strictEqual(pasVueDepuisLongtemps({}, midi, 2), false, 'rien de connu : rien');
});

test('pas vue, réglé à deux jours : seulement si une tablette répond encore (sinon « ne répond plus » a déjà prévenu)', () => {
  const hier = new Date(midi - 50 * H);
  assert.strictEqual(alertePasVueDue([{ lastSeen: hier, lastOnline: new Date(midi - 2 * MIN) }], midi, 2), true);
  assert.strictEqual(alertePasVueDue([{ lastSeen: hier, lastOnline: new Date(midi - 80 * MIN) }], midi, 2), false, 'tablette hors ligne');
  assert.strictEqual(alertePasVueDue([{ lastSeen: new Date(midi - 20 * H), lastOnline: new Date(midi - MIN) }], midi, 2), false, 'vue hier');
  assert.strictEqual(alertePasVueDue([], midi, 2), false);
  // Deux tablettes : il suffit qu'une réponde et qu'aucune ne l'ait vue.
  assert.strictEqual(alertePasVueDue([{ lastSeen: hier, lastOnline: new Date(midi - 80 * MIN) }, { lastSeen: hier, lastOnline: new Date(midi - MIN) }], midi, 2), true);
});

test('le compte d’appels de la tablette (jamais en ligne) ne compte pas comme une tablette qui répond', () => {
  const vieux = new Date(midi - 60 * H);
  assert.strictEqual(alertePasVueDue([{ lastSeen: vieux, lastOnline: new Date(midi - 80 * MIN) }, { joinedAt: vieux }], midi, 2), false);
});

test('veille par défaut de 23 h à 5 h, demi-heures prises en compte', () => {
  const { enVeille } = require('./alertes');
  const paris = (hhmm) => Date.parse(`2026-10-19T${hhmm}:00+02:00`);
  assert.strictEqual(enVeille(undefined, paris('22:59')), false);
  assert.strictEqual(enVeille(undefined, paris('23:00')), true);
  assert.strictEqual(enVeille(undefined, paris('04:59')), true);
  assert.strictEqual(enVeille(undefined, paris('05:00')), false);
  assert.strictEqual(enVeille(undefined, paris('21:30')), false, 'plus de veille dès 21 h par défaut');
  assert.strictEqual(enVeille({ active: true, de: 22, deMin: 30, a: 7 }, paris('22:15')), false);
  assert.strictEqual(enVeille({ active: true, de: 22, deMin: 30, a: 7 }, paris('22:45')), true);
  assert.strictEqual(enVeille({ active: true, de: 23, a: 7 }, paris('06:45')), true);
});

test('réglage aberrant d\'une vraie famille (21 h-20 h 30) : ramené à 21 h-10 h, la tablette est éveillée l\'après-midi', () => {
  const { enVeille } = require('./alertes');
  const paris = (hhmm) => Date.parse(`2026-10-19T${hhmm}:00+02:00`);
  const v = { active: true, de: 21, a: 20, aMin: 30 };
  assert.strictEqual(enVeille(v, paris('09:59')), true);
  assert.strictEqual(enVeille(v, paris('10:00')), false);
  assert.strictEqual(enVeille(v, paris('15:00')), false);
  assert.strictEqual(enVeille(v, paris('21:00')), true);
  // Midi, 2 h sans signe de vie : alerte comme en journée (avant : tolérée, la tablette « dormait »).
  assert.strictEqual(etatAlerte({ lastOnline: new Date(paris('12:00') - 75 * MIN) }, paris('12:00'), v), 'silence');
});

test('numéro de la tablette à retrouver seulement s’il n’a jamais été écrit (null = « aucun », déjà cherché)', () => {
  assert.strictEqual(numeroInconnu({}), true);
  assert.strictEqual(numeroInconnu({ telephone: null }), false);
  assert.strictEqual(numeroInconnu({ telephone: '07 51 23 45 67' }), false);
});

test('« pas vue depuis deux jours » part chaque jour à 10 h (Paris), hors des heures de veille', () => {
  const { HORAIRE_PAS_VUE, enVeille } = require('./alertes');
  assert.strictEqual(HORAIRE_PAS_VUE, 'every day 10:00');
  // 10 h à Paris le 29 octobre 2026 (heure d'hiver) = 9 h UTC : jamais pendant la veille par défaut (23 h-5 h), ni à 10 h, réveil le plus tard permis.
  assert.strictEqual(enVeille(undefined, Date.parse('2026-10-29T09:00:00Z')), false);
  assert.strictEqual(enVeille({ active: true, de: 23, a: 12 }, Date.parse('2026-10-29T09:00:00Z')), false);
});

test('délai « pas vue » réglé par la famille : entier de 1 à 5 jours, 5 par défaut (21/11), toute valeur bizarre ramenée', () => {
  const { joursPasVue } = require('./alertes');
  assert.strictEqual(joursPasVue(undefined), 5);
  assert.strictEqual(joursPasVue(null), 5);
  assert.strictEqual(joursPasVue('3'), 5, 'texte : défaut');
  assert.strictEqual(joursPasVue(NaN), 5);
  assert.strictEqual(joursPasVue(Infinity), 5);
  assert.strictEqual(joursPasVue(true), 5);
  for (const n of [1, 2, 3, 4, 5]) assert.strictEqual(joursPasVue(n), n);
  assert.strictEqual(joursPasVue(0), 1, 'trop petit : 1');
  assert.strictEqual(joursPasVue(-4), 1);
  assert.strictEqual(joursPasVue(12), 5, 'trop grand : 5');
  assert.strictEqual(joursPasVue(2.6), 3, 'décimal : arrondi');
});

test('délai « pas vue » de 1, 3 ou 5 jours : la tablette compte le bon nombre de jours', () => {
  const vue = (h) => ({ lastSeen: new Date(midi - h * H) });
  assert.strictEqual(pasVueDepuisLongtemps(vue(23), midi, 1), false);
  assert.strictEqual(pasVueDepuisLongtemps(vue(25), midi, 1), true, '1 jour : plus de 24 h suffit');
  assert.strictEqual(pasVueDepuisLongtemps(vue(49), midi, 3), false, '3 jours : 49 h, pas encore');
  assert.strictEqual(pasVueDepuisLongtemps(vue(73), midi, 3), true);
  assert.strictEqual(pasVueDepuisLongtemps(vue(119), midi, 5), false);
  assert.strictEqual(pasVueDepuisLongtemps(vue(121), midi, 5), true);
  assert.strictEqual(pasVueDepuisLongtemps(vue(49), midi, 'n importe quoi'), false, 'réglage illisible : 5 jours');
  assert.strictEqual(pasVueDepuisLongtemps(vue(121), midi, 'n importe quoi'), true);
  assert.strictEqual(pasVueDepuisLongtemps(vue(49), midi, 99), false, 'réglage trop grand : 5 jours');
  const enLigne = new Date(midi - MIN);
  assert.strictEqual(alertePasVueDue([{ ...vue(30), lastOnline: enLigne }], midi, 1), true);
  assert.strictEqual(alertePasVueDue([{ ...vue(30), lastOnline: enLigne }], midi), false, 'sans réglage : 5 jours');
  assert.strictEqual(alertePasVueDue([{ ...vue(80), lastOnline: enLigne }], midi, 4), false);
});

test('texte de l\'alerte « pas vue » : le nombre de jours choisi, « 1 jour » au singulier', () => {
  const { messagePasVue } = require('./alertes');
  assert.deepStrictEqual(messagePasVue('Mamie Jeanne', 1), {
    titre: "Mamie Jeanne n'a pas été vue depuis 1 jour",
    texte: "La tablette ne l'a ni vue ni sentie depuis plus de 24 heures. Un petit appel pour prendre des nouvelles ?",
  });
  assert.strictEqual(messagePasVue('Mamie', 2).titre, "Mamie n'a pas été vue depuis 2 jours");
  assert.strictEqual(messagePasVue('Mamie', 3).titre, "Mamie n'a pas été vue depuis 3 jours");
  assert.match(messagePasVue('Mamie', 5).texte, /plus de 120 heures/);
});

// ---------- « N'a pas vu vos 3 derniers envois » (Tanguy, 21/11/2026) ----------
const { nonVus, messageNonVus, heureTabletteEnMillis } = require('./alertes');
// Lundi 23 novembre 2026, heure de Paris (UTC+1).
const nov = (jourHeure) => Date.parse(`2026-11-${jourHeure}:00+01:00`);
const tab = (plus = {}) => ({ uid: 'tab', lastOnline: new Date(nov('23T15:58')), lastSeen: new Date(nov('23T09:00')), ...plus });
const envoi = (jourHeure, plus = {}) => ({ type: 'photo', authorUid: 'julie', createdAt: new Date(nov(jourHeure)), seenAt: null, ...plus });
const a16h = nov('23T16:00');

test('non vus : heure de la tablette lue à Paris, hiver comme été', () => {
  assert.strictEqual(heureTabletteEnMillis('2026-11-23 12:00'), Date.parse('2026-11-23T12:00:00+01:00'));
  assert.strictEqual(heureTabletteEnMillis('2026-07-01 12:00'), Date.parse('2026-07-01T12:00:00+02:00'));
  assert.strictEqual(heureTabletteEnMillis('n importe quoi'), null);
});

test('non vus : 3 envois de suite sans « vu » depuis le dernier signe de vie : alerte', () => {
  const r = nonVus({ tablettes: [tab()], envois: [envoi('23T10:00'), envoi('23T12:00'), envoi('23T15:00')], maintenant: a16h });
  assert.deepStrictEqual(r, { due: true, depuis: nov('23T09:00'), nombre: 3 });
  assert.match(messageNonVus('Mamie', 3).titre, /^Mamie n'a pas vu vos 3 derniers envois$/);
});

test('non vus : 2 seulement, rien', () => {
  assert.strictEqual(nonVus({ tablettes: [tab()], envois: [envoi('23T12:00'), envoi('23T15:00')], maintenant: a16h }).due, false);
});

test('non vus : un envoi lu, un toucher ou un visage remet à zéro', () => {
  const envois = [envoi('23T10:00'), envoi('23T12:00', { seenAt: new Date(nov('23T12:05')) }), envoi('23T13:00'), envoi('23T15:00')];
  assert.strictEqual(nonVus({ tablettes: [tab()], envois, maintenant: a16h }).due, false, 'envoi de 12 h lu');
  const trois = [envoi('23T10:00'), envoi('23T12:00'), envoi('23T15:00')];
  assert.strictEqual(nonVus({ tablettes: [tab({ lastActive: new Date(nov('23T13:00')) })], envois: trois, maintenant: a16h }).due, false, 'touchée à 13 h');
  assert.strictEqual(nonVus({ tablettes: [tab({ lastSeen: new Date(nov('23T11:00')) })], envois: trois, maintenant: a16h }).due, false, 'vue à 11 h');
});

test('non vus : les rappels comptent, et un rappel vu ou fait est un signe de vie', () => {
  const rappel = { time: '11:00', repeat: 'daily', title: 'Médicament' };
  const envois = [envoi('23T12:00'), envoi('23T15:00')];
  assert.strictEqual(nonVus({ tablettes: [tab()], envois, rappels: [rappel], maintenant: a16h }).due, true);
  assert.strictEqual(nonVus({ tablettes: [tab()], envois, rappels: [{ ...rappel, lastSeen: '2026-11-23 11:02' }], maintenant: a16h }).due, false, 'rappel vu');
  assert.strictEqual(nonVus({ tablettes: [tab()], envois, rappels: [{ ...rappel, lastAck: '2026-11-23 11:10' }], maintenant: a16h }).due, false, 'rappel fait');
  // Rappel de 15 h : encore affiché à 16 h, ne compte pas encore.
  assert.strictEqual(nonVus({ tablettes: [tab()], envois, rappels: [{ ...rappel, time: '15:00' }], maintenant: a16h }).due, false);
  // Rappel du mardi seulement (2) : pas aujourd'hui lundi.
  assert.strictEqual(nonVus({ tablettes: [tab()], envois, rappels: [{ ...rappel, repeat: 'weekly', days: [2] }], maintenant: a16h }).due, false);
  assert.strictEqual(nonVus({ tablettes: [tab()], envois, rappels: [{ ...rappel, repeat: 'weekly', days: [1] }], maintenant: a16h }).due, true);
});

test('non vus : rien la nuit, rien de trop frais, ni ses propres réponses', () => {
  const t = tab({ lastSeen: new Date(nov('22T20:00')) });
  const nuit = [envoi('22T23:30'), envoi('23T00:30'), envoi('23T10:00')];
  assert.strictEqual(nonVus({ tablettes: [t], envois: nuit, maintenant: a16h }).nombre, 1, 'envoyés pendant la veille : pas comptés');
  const frais = [envoi('23T10:00'), envoi('23T12:00'), envoi('23T15:50')];
  assert.strictEqual(nonVus({ tablettes: [tab()], envois: frais, maintenant: a16h }).due, false, 'envoyé il y a 10 min');
  const reponses = [envoi('23T10:00'), envoi('23T12:00'), envoi('23T15:00', { type: 'reply' }), envoi('23T15:10', { authorUid: 'tab' })];
  assert.strictEqual(nonVus({ tablettes: [tab()], envois: reponses, maintenant: a16h }).due, false);
});

test('non vus : tablette hors ligne ou absente, rien (« ne répond plus » s\'en charge)', () => {
  const envois = [envoi('23T10:00'), envoi('23T12:00'), envoi('23T15:00')];
  assert.strictEqual(nonVus({ tablettes: [tab({ lastOnline: new Date(nov('23T13:00')) })], envois, maintenant: a16h }).due, false);
  assert.strictEqual(nonVus({ tablettes: [], envois, maintenant: a16h }).due, false);
});

test('non vus : sur plusieurs jours, et jamais vue depuis l\'arrivée de la tablette', () => {
  const t = tab({ lastSeen: null, joinedAt: new Date(nov('21T09:00')) });
  const envois = [envoi('21T18:00'), envoi('22T11:00'), envoi('23T10:00')];
  assert.deepStrictEqual(nonVus({ tablettes: [t], envois, maintenant: a16h }), { due: true, depuis: nov('21T09:00'), nombre: 3 });
});
