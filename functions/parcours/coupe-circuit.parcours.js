// Coupe-circuit de facturation (budget.js) sur l'émulateur, avec la vraie transaction Firestore (audit des alertes,
// 11/11) : un palier n'est compté que si l'e-mail est parti ; deux avis en même temps ne donnent qu'un e-mail ;
// coupure refusée par Google : e-mail urgent et nouvel essai à l'avis suivant. Rien n'est coupé en vrai : la
// simulation n'a pas internet, l'appel à Cloud Billing échoue toujours ici.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const { brancher, mailsA } = require('./commun');

brancher();

const PAPOTE = 'contact@mapapote.fr';
const avis = (cout) => s.fonctions.coupeCircuit.run({ data: { message: { json: { costAmount: cout, costIntervalStart: '2026-11-01T00:00:00Z', currencyCode: 'EUR' } } } });

test('e-mail des 30 € refusé (Brevo en panne) : l\'alerte repart à l\'avis suivant, une seule fois', async () => {
  const mail = require('../mail');
  const vrai = mail.envoyer;
  mail.envoyer = async () => { throw new Error('Simulation : Brevo refuse'); };
  try {
    await assert.rejects(avis(31), /Brevo refuse/);
  } finally {
    mail.envoyer = vrai;
  }
  assert.strictEqual(await s.lire('interne/budget'), undefined, 'palier rendu');
  await avis(35);
  await avis(60);
  assert.strictEqual(mailsA(PAPOTE).length, 1);
  assert.match(mailsA(PAPOTE)[0], /atteint 35,00 €/);
  assert.strictEqual((await s.lire('interne/budget')).palier, 'alerte');
});

test('deux avis en même temps : un seul e-mail', async () => {
  await Promise.all([avis(31), avis(31), avis(32)]);
  assert.strictEqual(mailsA(PAPOTE).length, 1);
});

test('150 € : e-mail « coupure en cours » d\'abord ; coupure refusée : e-mail urgent, palier rendu, nouvel essai ensuite', async () => {
  await avis(101);
  s.boite.length = 0;
  await avis(151);
  assert.strictEqual(mailsA(PAPOTE).length, 2);
  assert.match(mailsA(PAPOTE)[0], /COUPE-CIRCUIT en cours/);
  assert.match(mailsA(PAPOTE)[1], /URGENT.*n'a pas pu couper/);
  assert.ok(s.erreurs.length === 1 && /n'a pas pu être désactivée/.test(s.erreurs[0]), JSON.stringify(s.erreurs));
  s.erreurs.length = 0; // attendu : pas d'internet dans la simulation
  assert.strictEqual((await s.lire('interne/budget')).palier, 'avertissement', 'le palier des 100 € est gardé, la coupure sera retentée');
  await avis(152);
  assert.strictEqual(mailsA(PAPOTE).length, 4, 'nouvel essai, nouvel e-mail urgent');
  s.erreurs.length = 0;
});
