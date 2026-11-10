// Passer de la carte au prélèvement SEPA (Tanguy, 10/11) : 15 jours après le premier prélèvement mensuel par
// carte, e-mail au payeur (et encart doré dans l'appli), une seule relance 30 jours après ; le mandat signé depuis
// l'appli devient le moyen de paiement de l'abonnement. Rien pour une famille déjà en SEPA ou en retard de paiement.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, mailsA } = require('./commun');

brancher();

const famille = (fid) => s.lire(`families/${fid}`);
const millis = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : t);
const PREMIER = 'Plus jamais de souci de carte pour Papote';
const RELANCE = 'Un petit rappel : le prélèvement pour Papote';
const mailsSepa = (email) => mailsA(email).filter((m) => m === PREMIER || m === RELANCE);

// Commande payée (par carte si demandé), tablette installée, premier mois prélevé : { id, fid }.
async function famillePayee(acheteur, { carte }) {
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: acheteur.email, carte });
  await a.preparerEtEnvoyer(id, t);
  s.avancer(2);
  await a.afficherCode(t);
  const fid = await a.installer(acheteur, t);
  s.avancer(31);
  s.stripe.finirEssai(id);
  await s.calme();
  return { id, fid };
}

async function relances() {
  await s.tache('relancesSepa');
  await s.calme();
}

test('payé par carte : rien avant J+15, e-mail à J+15, une seule relance 30 jours après, puis plus rien', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { fid } = await famillePayee(paul, { carte: true });
  const p = (await famille(fid)).paiement;
  assert.strictEqual(p.moyen, 'carte');
  const premierLe = millis(p.premierLe);
  assert.ok(Math.abs(premierLe - Date.now()) < 60e3, 'premier prélèvement noté à sa date');

  s.avancer(14);
  await relances();
  assert.deepStrictEqual(mailsSepa(paul.email), [], 'rien avant 15 jours');

  s.avancer(1);
  await relances();
  await relances(); // tâche relancée le même jour : pas de deuxième e-mail
  assert.deepStrictEqual(mailsSepa(paul.email), [PREMIER]);

  s.avancer(29);
  await relances();
  assert.deepStrictEqual(mailsSepa(paul.email), [PREMIER], 'pas de relance avant 30 jours');

  s.avancer(1);
  await relances();
  assert.deepStrictEqual(mailsSepa(paul.email), [PREMIER, RELANCE]);

  // Un autre mois prélevé par carte ne déplace pas la date du premier prélèvement, et plus aucun e-mail.
  s.stripe.prelevementMensuel((await famille(fid)).abonnement.stripeSubscriptionId);
  await s.calme();
  assert.strictEqual(millis((await famille(fid)).paiement.premierLe), premierLe);
  s.avancer(90);
  await relances();
  assert.deepStrictEqual(mailsSepa(paul.email), [PREMIER, RELANCE]);
});

test('« Passer au prélèvement » : mandat SEPA signé, l\'abonnement est prélevé sur le compte, plus d\'e-mail', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await famillePayee(paul, { carte: true });

  // Quelqu'un hors de la famille ne peut pas ouvrir la page du mandat.
  const inconnu = await s.compte('Inconnu', 'inconnu@exemple.fr');
  await assert.rejects(s.appeler('passerAuSepa', { fid }, inconnu));

  // Double appui : deux pages créées chez Stripe, sans effet tant que rien n'est signé.
  const [r1, r2] = await Promise.all([s.appeler('passerAuSepa', { fid }, paul), s.appeler('passerAuSepa', { fid }, paul)]);
  assert.match(r1.url, /^https:\/\/checkout\.stripe\.test\//);
  assert.match(r2.url, /^https:\/\/checkout\.stripe\.test\//);
  const session = s.stripe.etat.sessions.get(r1.url.split('/').pop());
  assert.strictEqual(session.mode, 'setup');
  assert.deepStrictEqual(session.params.payment_method_types, ['sepa_debit']);
  assert.strictEqual((await famille(fid)).paiement.moyen, 'carte');

  s.stripe.signerMandatSepa(session.id);
  await s.calme();
  const fam = await famille(fid);
  assert.strictEqual(fam.paiement.moyen, 'sepa');
  const abo = s.stripe.etat.abonnements.get(id);
  const client = s.stripe.etat.clients.get(abo.customer);
  assert.strictEqual(client.moyen.type, 'sepa_debit', 'le client sera prélevé sur son compte');
  assert.strictEqual(abo.default_payment_method, client.moyen.id, 'l\'abonnement aussi');

  // Le mois suivant est prélevé en SEPA, et aucun e-mail ne part plus.
  s.stripe.prelevementMensuel(id);
  await s.calme();
  assert.strictEqual((await famille(fid)).paiement.moyen, 'sepa');
  s.avancer(60);
  await relances();
  assert.deepStrictEqual(mailsSepa(paul.email), []);
});

test('déjà en SEPA, ou paiement en retard : jamais d\'e-mail « passer au prélèvement »', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const { fid } = await famillePayee(julie, { carte: false });
  assert.strictEqual((await famille(fid)).paiement.moyen, 'sepa');
  s.avancer(20);
  await relances();
  assert.deepStrictEqual(mailsSepa(julie.email), []);

  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id } = await famillePayee(paul, { carte: true });
  s.stripe.banqueRefusePrelevement(id);
  await s.calme();
  s.avancer(16);
  await relances();
  assert.deepStrictEqual(mailsSepa(paul.email), [], 'en retard ou en pause : on règle d\'abord le paiement');
});
