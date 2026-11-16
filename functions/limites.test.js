const test = require('node:test');
const assert = require('node:assert');
const {
  LIMITES, jourParis, minuitSuivantParis, estFrais, compterMessage, compterRappel, compterRappelModifie, rappelEnCours,
} = require('./limites');

const T = Date.parse('2026-11-12T10:00:00Z'); // 11 h à Paris

test('jour de Paris et minuit suivant, en hiver, en été et aux changements d’heure', () => {
  assert.strictEqual(jourParis(Date.parse('2026-11-12T22:59:00Z')), '2026-11-12');
  assert.strictEqual(jourParis(Date.parse('2026-11-12T23:00:00Z')), '2026-11-13'); // minuit à Paris (UTC+1)
  assert.strictEqual(minuitSuivantParis(T), Date.parse('2026-11-12T23:00:00Z'));
  assert.strictEqual(minuitSuivantParis(Date.parse('2026-07-01T21:30:00Z')), Date.parse('2026-07-01T22:00:00Z')); // UTC+2
  // Passage à l'heure d'été (29/03/2026) et à l'heure d'hiver (25/10/2026) : minuit est avant le changement.
  assert.strictEqual(minuitSuivantParis(Date.parse('2026-03-28T12:00:00Z')), Date.parse('2026-03-28T23:00:00Z'));
  assert.strictEqual(minuitSuivantParis(Date.parse('2026-03-29T12:00:00Z')), Date.parse('2026-03-29T22:00:00Z'));
  assert.strictEqual(minuitSuivantParis(Date.parse('2026-10-24T12:00:00Z')), Date.parse('2026-10-24T22:00:00Z'));
  assert.strictEqual(minuitSuivantParis(Date.parse('2026-10-25T12:00:00Z')), Date.parse('2026-10-25T23:00:00Z'));
  // Fin de mois et d'année.
  assert.strictEqual(minuitSuivantParis(Date.parse('2026-12-31T20:00:00Z')), Date.parse('2026-12-31T23:00:00Z'));
});

test('voix coupée à partir du 10e message du jour du même proche, pas pour les autres', () => {
  let c = null;
  for (let i = 1; i <= 9; i++) {
    const r = compterMessage(c, 'julie', T);
    assert.strictEqual(r.voix, true, `message ${i}`);
    c = r.compteur;
  }
  const dixieme = compterMessage(c, 'julie', T);
  assert.strictEqual(dixieme.voix, false);
  assert.strictEqual(dixieme.compteur.parAuteur.julie, 10);
  const paul = compterMessage(dixieme.compteur, 'paul', T);
  assert.strictEqual(paul.voix, true);
  assert.strictEqual(paul.compteur.messages, 11);
  assert.strictEqual(paul.bloque, false);
  assert.strictEqual(paul.compteur.bloqueJusqua, undefined);
});

test('50 messages par famille : le 50e passe et bloque jusqu’à minuit, ceux qui passent quand même n’ont pas de voix', () => {
  let c = null;
  let r;
  for (let i = 1; i <= 50; i++) {
    r = compterMessage(c, `proche${i % 7}`, T); // 7 proches : chacun reste sous 10
    c = r.compteur;
    if (i < 50) assert.strictEqual(r.bloque, false, `message ${i}`);
  }
  assert.strictEqual(r.bloque, true);
  assert.strictEqual(r.voix, true); // le 50e garde sa voix
  assert.strictEqual(r.compteur.bloqueJusqua, Date.parse('2026-11-12T23:00:00Z'));
  const enCourse = compterMessage(c, 'proche1', T);
  assert.strictEqual(enCourse.enTrop, true);
  assert.strictEqual(enCourse.voix, false);
});

test('le lendemain, tout repart de zéro (compteurs et drapeaux)', () => {
  let c = null;
  for (let i = 0; i < 50; i++) c = compterMessage(c, 'julie', T).compteur;
  for (let i = 0; i < 10; i++) c = compterRappel(c, T).compteur;
  assert.ok(c.bloqueJusqua && c.rappelsBloquesJusqua);
  const demain = compterMessage(c, 'julie', T + 24 * 3600000);
  assert.strictEqual(demain.voix, true);
  assert.strictEqual(demain.compteur.jour, '2026-11-13');
  assert.strictEqual(demain.compteur.messages, 1);
  assert.strictEqual(demain.compteur.rappels, 0);
  assert.deepStrictEqual(demain.compteur.parAuteur, { julie: 1 });
  assert.strictEqual(demain.compteur.bloqueJusqua, undefined);
  assert.strictEqual(demain.compteur.rappelsBloquesJusqua, undefined);
});

test('un message ne touche pas aux rappels du jour, et inversement', () => {
  let c = compterRappel(null, T).compteur;
  c = compterMessage(c, 'julie', T).compteur;
  assert.strictEqual(c.rappels, 1);
  assert.strictEqual(c.messages, 1);
  c = compterRappel(c, T).compteur;
  assert.strictEqual(c.messages, 1);
  assert.strictEqual(c.parAuteur.julie, 1);
});

test('rappels : le 10e du jour bloque jusqu’à minuit, le 11e (passé quand même) est en trop', () => {
  let c = null;
  let r;
  for (let i = 1; i <= 10; i++) {
    r = compterRappel(c, T);
    c = r.compteur;
    assert.strictEqual(r.enTrop, false);
    assert.strictEqual(r.bloque, i === 10);
  }
  assert.strictEqual(c.rappelsBloquesJusqua, Date.parse('2026-11-12T23:00:00Z'));
  assert.strictEqual(compterRappel(c, T).enTrop, true);
});

test('rappel modifié : voix Google jusqu’au 20e changement de texte du jour', () => {
  let c = null;
  for (let i = 1; i <= LIMITES.voixRappelsModifies; i++) {
    const r = compterRappelModifie(c, T);
    assert.strictEqual(r.voix, true);
    c = r.compteur;
  }
  assert.strictEqual(compterRappelModifie(c, T).voix, false);
});

test('rappel en cours : une fois à venir ou aujourd’hui, répété non terminé, en pause compris', () => {
  const j = '2026-11-12';
  assert.strictEqual(rappelEnCours({ repeat: 'once', date: '2026-11-12' }, j), true);
  assert.strictEqual(rappelEnCours({ repeat: 'once', date: '2026-11-11' }, j), false);
  assert.strictEqual(rappelEnCours({ repeat: 'daily' }, j), true);
  assert.strictEqual(rappelEnCours({ repeat: 'weekly', finLe: '2026-11-12' }, j), true);
  assert.strictEqual(rappelEnCours({ repeat: 'daily', finLe: '2026-11-11' }, j), false);
  assert.strictEqual(rappelEnCours({ repeat: 'daily', enPauseJusquau: '9999-12-31' }, j), true);
});

test('envoi frais (écrit à l’instant) compté ; copie ancienne non comptée', () => {
  assert.strictEqual(estFrais(undefined, T), true);
  assert.strictEqual(estFrais({ toMillis: () => T - 1000 }, T), true);
  assert.strictEqual(estFrais({ toMillis: () => T - 2 * 3600000 }, T), false);
});
