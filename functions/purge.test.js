const test = require('node:test');
const assert = require('node:assert');
const { perime, contactChatAPurger, familleAPurger, avisEffacementDu, DUREE_MS, DUREE_FAMILLE_MS } = require('./purge')._test;

const T = Date.parse('2027-11-01T03:00:00Z');
const JOUR = 86400e3;
const ilYA = (jours) => T - jours * JOUR;
const ts = (ms) => ({ toMillis: () => ms });

test('périmé : plus de 365 jours, nombre, Date ou Timestamp ; jamais sans date', () => {
  assert.strictEqual(DUREE_MS, 365 * JOUR);
  assert.strictEqual(perime(ilYA(366), T), true);
  assert.strictEqual(perime(ilYA(365), T), true);
  assert.strictEqual(perime(ilYA(364), T), false);
  assert.strictEqual(perime(new Date(ilYA(400)), T), true);
  assert.strictEqual(perime(ts(ilYA(400)), T), true);
  assert.strictEqual(perime(null, T), false);
  assert.strictEqual(perime(undefined, T), false);
  assert.strictEqual(perime('hier', T), false);
});

test('contact du chat : effacé après 12 mois sans question', () => {
  const chat = { email: 'a@b.fr', nom: 'A B', prenom: 'A', telephone: '0600000000', chatLe: ilYA(400), chatDepuis: ilYA(500) };
  assert.strictEqual(contactChatAPurger(chat, T), true);
  assert.strictEqual(contactChatAPurger({ ...chat, chatLe: ilYA(100) }, T), false);
});

test('contact du chat : gardé s\'il a un accord, la liste d\'attente, une commande ou une désinscription', () => {
  const chat = { email: 'a@b.fr', chatLe: ilYA(400) };
  assert.strictEqual(contactChatAPurger({ ...chat, consentement: true }, T), false);
  assert.strictEqual(contactChatAPurger({ ...chat, consentement: false }, T), false);
  assert.strictEqual(contactChatAPurger({ ...chat, listeAttente: true }, T), false);
  assert.strictEqual(contactChatAPurger({ ...chat, source: 'commande' }, T), false);
  assert.strictEqual(contactChatAPurger({ ...chat, jeton: 'x' }, T), false);
  assert.strictEqual(contactChatAPurger({ ...chat, desinscritLe: ilYA(10) }, T), false);
  assert.strictEqual(contactChatAPurger({ email: 'a@b.fr', consentement: true }, T), false);
  assert.strictEqual(contactChatAPurger(null, T), false);
});

test('famille résiliée depuis plus de 3 mois, prévenue depuis 3 semaines : effacée', () => {
  assert.strictEqual(DUREE_FAMILLE_MS, 90 * JOUR);
  const fam = { name: 'Mamie', avisEffacementLe: ts(ilYA(30)), abonnement: { statut: 'resilie', majLe: ts(ilYA(91)), resiliationLe: ts(ilYA(100)) } };
  assert.strictEqual(familleAPurger(fam, [{ statutStripe: 'canceled' }], T), true);
  assert.strictEqual(familleAPurger(fam, [], T), true);
});

test('jamais effacée sans avoir été prévenue un mois avant (audit « mauvais jours »)', () => {
  const abonnement = { statut: 'resilie', majLe: ts(ilYA(91)), resiliationLe: ts(ilYA(100)) };
  assert.strictEqual(familleAPurger({ abonnement }, [], T), false, 'pas prévenue : gardée');
  assert.strictEqual(avisEffacementDu({ abonnement }, [], T), true, 'à prévenir');
  assert.strictEqual(familleAPurger({ abonnement, avisEffacementLe: ts(ilYA(10)) }, [], T), false, 'prévenue il y a 10 jours : gardée');
  assert.strictEqual(avisEffacementDu({ abonnement, avisEffacementLe: ts(ilYA(10)) }, [], T), false, 'une seule fois');
  // Résiliée il y a 65 jours : effacement dans 25 jours, l'avis part maintenant ; à 40 jours, pas encore.
  assert.strictEqual(avisEffacementDu({ abonnement: { statut: 'resilie', majLe: ts(ilYA(65)) } }, [], T), true);
  assert.strictEqual(avisEffacementDu({ abonnement: { statut: 'resilie', majLe: ts(ilYA(40)) } }, [], T), false);
  assert.strictEqual(avisEffacementDu({ abonnement: { statut: 'suspendu', majLe: ts(ilYA(400)) } }, [], T), false);
});

test('famille gardée : abonnement en cours, résiliation récente, commande encore vivante chez Stripe, sans date', () => {
  const vieille = { statut: 'resilie', majLe: ts(ilYA(120)) };
  assert.strictEqual(familleAPurger({ abonnement: { ...vieille, statut: 'actif' } }, [], T), false);
  assert.strictEqual(familleAPurger({ abonnement: { ...vieille, statut: 'suspendu' } }, [], T), false);
  assert.strictEqual(familleAPurger({ abonnement: { ...vieille, statut: 'offert' } }, [], T), false);
  assert.strictEqual(familleAPurger({ abonnement: { ...vieille, statut: 'aucun' } }, [], T), false);
  assert.strictEqual(familleAPurger({ abonnement: { statut: 'resilie', majLe: ts(ilYA(60)) } }, [], T), false);
  // La fin de période est plus récente que la dernière mise à jour : c'est elle qui compte.
  assert.strictEqual(familleAPurger({ abonnement: { statut: 'resilie', majLe: ts(ilYA(120)), finPeriode: ts(ilYA(30)) } }, [], T), false);
  assert.strictEqual(familleAPurger({ abonnement: vieille }, [{ statutStripe: 'active' }], T), false);
  assert.strictEqual(familleAPurger({ abonnement: vieille }, [{ statutStripe: 'past_due' }], T), false);
  assert.strictEqual(familleAPurger({ abonnement: { statut: 'resilie' } }, [], T), false);
  assert.strictEqual(familleAPurger({}, [], T), false);
  assert.strictEqual(familleAPurger(null, [], T), false);
});
