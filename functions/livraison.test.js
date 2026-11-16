const test = require('node:test');
const assert = require('node:assert');
const l = require('./livraison');

const JOUR = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 9);

test('point relais choisi sur le site', () => {
  const r = l.relaisDepuisRequete({ relais: '012345', rnom: ' Tabac  du Port ', radr: '2 rue Neuve', rcp: '64200', rville: 'Biarritz', rpays: 'fr' });
  assert.deepStrictEqual(r, { id: '012345', nom: 'Tabac du Port', adresse: '2 rue Neuve', cp: '64200', ville: 'Biarritz', pays: 'FR' });
  assert.strictEqual(l.relaisDepuisRequete({ relais: '012345', rnom: 'X', rcp: '1000', rville: 'Genève', rpays: 'CH' }), null);
  // France seulement depuis l'offre unique : la carte SIM est française.
  assert.strictEqual(l.relaisDepuisRequete({ relais: '012345', rnom: 'X', rcp: '1000', rville: 'Bruxelles', rpays: 'BE' }), null);
  assert.strictEqual(l.relaisDepuisRequete({ relais: '012345', rnom: 'X', rcp: '1009', rville: 'Luxembourg', rpays: 'LU' }), null);
  assert.strictEqual(l.relaisDepuisRequete({ relais: '01 2"', rnom: 'X', rcp: '1', rville: 'Y' }), null);
  assert.strictEqual(l.relaisDepuisRequete({}), null);
  const d = l.relaisDepuisRequete({ relais: '012345', rnom: 'Tabac', rcp: '64200', rville: 'Biarritz', rdest: ' Jeanne  Martin ' });
  assert.strictEqual(d.destinataire, 'Jeanne Martin');
  assert.strictEqual(l.relaisDepuisMeta(l.relaisVersMeta(d)).destinataire, 'Jeanne Martin');
});

test('aller-retour par les métadonnées Stripe', () => {
  const r = { id: '012345', nom: 'Tabac', adresse: '', cp: '64200', ville: 'Biarritz', pays: 'FR' };
  const m = l.relaisDepuisMeta(l.relaisVersMeta(r));
  assert.strictEqual(m.transporteur, 'mondial-relay');
  assert.strictEqual(m.id, '012345');
  assert.strictEqual(m.adresse, null);
  assert.strictEqual(l.relaisDepuisMeta({ formule: 'wifi' }), null);
});

test('numéro de suivi', () => {
  assert.strictEqual(l.normaliserSuivi(' 1234 5678 '), '12345678');
  assert.strictEqual(l.normaliserSuivi('12'), null);
  assert.strictEqual(l.normaliserSuivi('12<34567'), null);
  assert.strictEqual(l.lienSuivi('12345678', '64200'),
    'https://www.mondialrelay.fr/suivi-de-colis/?numeroExpedition=12345678&codePostal=64200');
});

test('rappels de jumelage à J+5 puis J+12', () => {
  assert.strictEqual(l.rappelDu(T0, 0, T0 + 4 * JOUR), null);
  assert.strictEqual(l.rappelDu(T0, 0, T0 + 5 * JOUR), 1);
  assert.strictEqual(l.rappelDu(T0, 1, T0 + 6 * JOUR), null);
  assert.strictEqual(l.rappelDu(T0, 1, T0 + 12 * JOUR), 2);
  assert.strictEqual(l.rappelDu(T0, 2, T0 + 40 * JOUR), null);
  assert.strictEqual(l.rappelDu(null, 0, T0), null);
  assert.strictEqual(l.alerteDue(T0, T0 + 20 * JOUR), true);
  assert.strictEqual(l.alerteDue(T0, T0 + 19 * JOUR), false);
});

// M0 (Tanguy 12/11) : la tablette dit « Papote est prévenu » ; l'alerte part 48 h après son arrivée, quelle qu'elle soit.
test('arrivée de la tablette : colis retiré, remise en main propre, colis sans suivi Sendcloud', () => {
  assert.deepStrictEqual(l.arriveeTablette({ preparation: { recuLe: T0 }, envoyeeLe: T0 - JOUR }), { le: T0, comment: 'retrait' });
  assert.deepStrictEqual(l.arriveeTablette({ remise: 'main-propre', preparation: { recuLe: { toMillis: () => T0 } } }), { le: T0, comment: 'main-propre' });
  // Étiquette Sendcloud, colis pas encore retiré : pas chez la personne.
  assert.strictEqual(l.arriveeTablette({ envoyeeLe: T0, etiquettes: { aller: { colis: 42 } } }), null);
  // N° de suivi tapé à la main : personne ne note le retrait, arrivée comptée à l'envoi + 3 jours.
  assert.deepStrictEqual(l.arriveeTablette({ envoyeeLe: { toMillis: () => T0 } }), { le: T0 + 3 * JOUR, comment: 'estimee' });
  assert.strictEqual(l.arriveeTablette({ expedition: 'a-preparer' }), null);
  assert.strictEqual(l.arriveeTablette(null), null);
});

test('alerte « pas encore connectée » : délai réglé à un seul endroit (48 h), texte selon l\'arrivée', () => {
  assert.strictEqual(l.ALERTE_CONNEXION_JOURS, 2);
  assert.strictEqual(l.delaiConnexion(), '48 h');
  assert.strictEqual(l.alerteConnexionDue(T0, T0 + 2 * JOUR - 1), false);
  assert.strictEqual(l.alerteConnexionDue(T0, T0 + 2 * JOUR), true);
  const c = { nom: 'Paul Martin', id: 'sub_1' };
  const retrait = l.alerteConnexion(c, 'retrait');
  assert.strictEqual(retrait.titre, 'Tablette pas encore connectée, colis retiré il y a 48 h : Paul Martin');
  assert.match(retrait.detail, /^Colis retiré il y a 48 h : .*Papote est prévenu et s'en occupe.*Appelez le client/);
  assert.strictEqual(retrait.aFaire, 'Tablette de Paul Martin pas encore connectée, colis retiré : appeler le client');
  const main = l.alerteConnexion(c, 'main-propre');
  assert.strictEqual(main.titre, 'Tablette pas encore connectée, remise en main propre il y a 48 h : Paul Martin');
  assert.match(main.detail, /^Remise en main propre il y a 48 h : la tablette n'est toujours pas entrée/);
  const estimee = l.alerteConnexion({ email: 'p@x.fr' }, 'estimee');
  assert.strictEqual(estimee.titre, 'Tablette pas encore connectée, colis parti sans suivi il y a 5 jours : p@x.fr');
  assert.match(estimee.aFaire, /colis parti sans suivi : appeler le client/);
});
