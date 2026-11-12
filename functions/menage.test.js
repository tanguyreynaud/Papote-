const test = require('node:test');
const assert = require('node:assert');
const { compteCandidat, commandeEnCours, vientDeFinir, DUREE_COMPTE_MS, DUREE_JOURNAUX_MS } = require('./menage')._test;

const T = Date.parse('2027-03-01T09:00:00Z');
const JOUR = 86400e3;
const date = (jours) => new Date(T - jours * JOUR).toUTCString();
const compte = (champs = {}, meta = {}) => ({
  uid: 'u1', email: 'paul@exemple.fr', disabled: false, customClaims: undefined,
  metadata: { creationTime: date(200), lastSignInTime: date(120), lastRefreshTime: date(95), ...meta }, ...champs,
});

test('durées : 90 jours pour les journaux et pour les comptes sans famille', () => {
  assert.strictEqual(DUREE_JOURNAUX_MS, 90 * JOUR);
  assert.strictEqual(DUREE_COMPTE_MS, 90 * JOUR);
});

test('compte candidat : aucune connexion depuis plus de 3 mois, compte réel ou anonyme', () => {
  assert.strictEqual(compteCandidat(compte(), T), true);
  assert.strictEqual(compteCandidat(compte({ email: undefined }), T), true, 'anonyme');
  assert.strictEqual(compteCandidat(compte({}, { lastRefreshTime: date(10) }), T), false, 'connecté il y a 10 jours');
  assert.strictEqual(compteCandidat(compte({}, { lastSignInTime: date(89), lastRefreshTime: null }), T), false);
  assert.strictEqual(compteCandidat(compte({}, { creationTime: date(30), lastSignInTime: null, lastRefreshTime: null }), T), false, 'créé il y a un mois');
  assert.strictEqual(compteCandidat(compte({}, { creationTime: null, lastSignInTime: null, lastRefreshTime: null }), T), false, 'sans date : jamais');
});

test('compte candidat : jamais une tablette, l\'administrateur ou un compte désactivé', () => {
  assert.strictEqual(compteCandidat(compte({ email: 'tablette-abc@tablettes.papote-famille.web.app' }), T), false);
  assert.strictEqual(compteCandidat(compte({ email: 'TABLETTE-APPELS-abc@Tablettes.Papote-Famille.web.app' }), T), false);
  assert.strictEqual(compteCandidat(compte({ customClaims: { admin: true } }), T), false);
  assert.strictEqual(compteCandidat(compte({ customClaims: { admin: false } }), T), true);
  assert.strictEqual(compteCandidat(compte({ disabled: true }), T), false);
  assert.strictEqual(compteCandidat(null, T), false);
});

test('commande en cours : abonnement vivant, paiement ou envoi pas fini, tablette à rendre, ou inconnue chez Stripe', () => {
  assert.strictEqual(commandeEnCours({ statutStripe: 'active', expedition: 'envoyee', fid: 'f' }), true);
  assert.strictEqual(commandeEnCours({ statutStripe: 'past_due', expedition: 'envoyee', fid: 'f' }), true);
  assert.strictEqual(commandeEnCours({ expedition: 'paiement-en-attente' }), true);
  assert.strictEqual(commandeEnCours({ statutStripe: 'canceled', expedition: 'a-preparer' }), true);
  assert.strictEqual(commandeEnCours({ statutStripe: 'canceled', expedition: 'envoyee', fid: 'f', restitution: { statut: 'attendue' } }), true);
  assert.strictEqual(commandeEnCours({ expedition: 'envoyee', fid: 'f', offerte: true }), true, 'offerte, sans Stripe : gardée');
});

test('commande terminée : annulée, ou finie chez Stripe sans rien à rendre', () => {
  assert.strictEqual(commandeEnCours({ expedition: 'annulee', statutStripe: 'active' }), false);
  assert.strictEqual(commandeEnCours({ statutStripe: 'canceled', expedition: 'envoyee', fid: 'f', restitution: { statut: 'rendue' } }), false);
  assert.strictEqual(commandeEnCours({ statutStripe: 'canceled', expedition: 'envoyee', fid: 'f' }), false);
  assert.strictEqual(commandeEnCours(null), false);
});

test('appel qui vient de finir : sonnait ou était en cours, est fini ; une seule fois', () => {
  assert.strictEqual(vientDeFinir({ state: 'ringing' }, { state: 'missed' }), true);
  assert.strictEqual(vientDeFinir({ state: 'ringing' }, { state: 'declined' }), true);
  assert.strictEqual(vientDeFinir({ state: 'accepted' }, { state: 'ended' }), true);
  assert.strictEqual(vientDeFinir({ state: 'ringing' }, { state: 'accepted' }), false, 'décroché : pas fini');
  assert.strictEqual(vientDeFinir({ state: 'ended' }, { state: 'ended' }), false, 'notre propre effacement ne relance rien');
  assert.strictEqual(vientDeFinir(null, { state: 'ended' }), false);
});
