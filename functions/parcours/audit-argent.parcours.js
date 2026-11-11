// Audit de l'argent du 11/11 : les quatre trous prouvés (A1 à A4), le réglage des prélèvements hors abonnement (B1)
// et le contrôle de nuit Stripe ↔ base (B3-B4). Chaque scénario échouait avant le correctif (preuves d'origine :
// audit/argent-11-11/zz-audit-argent.parcours.js dans les fichiers du projet).

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const gestion = require('../gestion');
const { brancher, commande, mailsA } = require('./commun');

brancher();

const abo = (id) => s.stripe.etat.abonnements.get(id);
const PAPOTE = 'contact@mapapote.fr';
// « À faire » de l'admin, calculé comme gestionDonnees (commandes, familles, dernier passage automatique).
async function aFaire() {
  const [commandes, familles, automatique] = await Promise.all([
    s.db.collection('commandes').get(), s.db.collection('families').get(), s.db.doc('gestion/automatique').get()]);
  return gestion.regles.aFaire({
    commandes: commandes.docs.map((d) => ({ id: d.id, ...d.data() })), stock: [], depenses: [], maintenant: Date.now(),
    familles: familles.docs.map((f) => ({ id: f.id, nom: f.get('name'), statut: f.get('abonnement.statut') })),
    automatique: automatique.data(),
  });
}
// Une erreur attendue du scénario (logger.error) : vérifiée, puis retirée pour le contrôle de fin.
function erreurAttendue(motif) {
  assert.ok(s.erreurs.some((e) => motif.test(e)), `erreur attendue ${motif} : ${JSON.stringify(s.erreurs)}`);
  s.erreurs.length = 0;
}

async function familleAbonnee(acheteur) {
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: acheteur.email });
  await a.preparerEtEnvoyer(id, t);
  s.avancer(2);
  await a.afficherCode(t);
  const fid = await a.installer(acheteur, t);
  return { id, fid, t };
}

test('A1. annulation avant l\'envoi pendant une coupure Stripe : message clair, le nouvel essai termine tout (abonnement arrêté, 60 € rendus, une seule fois)', async () => {
  const { abonnement: id } = await a.commanderEtPayer({ email: 'paul@exemple.fr' });
  s.boite.length = 0;
  const cancel = s.stripe.api.subscriptions.cancel;
  s.stripe.api.subscriptions.cancel = async () => { throw new Error('Simulation : Stripe injoignable'); };
  try {
    await assert.rejects(s.appeler('retracter', { commande: id }, a.TANGUY), /n'a pas pu se terminer\. Réessayez/);
  } finally {
    s.stripe.api.subscriptions.cancel = cancel;
  }
  await s.calme();
  erreurAttendue(/abonnement Stripe non arrêté/);
  assert.notStrictEqual(abo(id).status, 'canceled');
  assert.strictEqual((await commande(id)).retractation.enCours, 0, 'annulation notée « à refaire », verrou levé');
  assert.deepStrictEqual(mailsA('paul@exemple.fr'), [], 'pas d\'e-mail pour une annulation pas finie');
  // Le contrôle de nuit le voit tout de suite.
  await s.tache('gestionAutomatique');
  assert.ok((await aFaire()).some((l) => /annulée.*abonnement Stripe tourne encore/.test(l)), JSON.stringify(await aFaire()));

  // Nouvel essai, deux appuis en même temps : un seul passe, tout est fini une seule fois.
  const essais = await Promise.allSettled([s.appeler('retracter', { commande: id }, a.TANGUY), s.appeler('retracter', { commande: id }, a.TANGUY)]);
  await s.calme();
  assert.strictEqual(essais.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(essais.map((r) => r.reason && r.reason.message)));
  // L'autre est refusé : « déjà en cours », ou « délai dépassé » s'il arrive juste après la fin du premier.
  assert.match(essais.find((r) => r.status === 'rejected').reason.message, /déjà en cours|délai de 30 jours/);
  assert.strictEqual(abo(id).status, 'canceled', 'abonnement arrêté chez Stripe');
  assert.strictEqual(s.stripe.rembourse(id), 6000, '60 € rendus, une fois');
  const c = await commande(id);
  assert.strictEqual(c.remboursement.statut, 'fait');
  assert.strictEqual(c.retractation.enCours, undefined);
  assert.strictEqual(c.dernierMois, undefined, 'pas de dernier mois');
  assert.strictEqual(mailsA('paul@exemple.fr').length, 1, 'un seul e-mail au client');
  // Troisième appui : c'est fini, refusé.
  await assert.rejects(s.appeler('retracter', { commande: id }, a.TANGUY), /délai de 30 jours/);
  await s.tache('gestionAutomatique');
  assert.ok(!(await aFaire()).some((l) => /Stripe tourne encore|restée en plan/.test(l)));
});

test('A1 bis. annulation après réception pendant une coupure Stripe : rejouée, tablette à rendre, 60 € au retour, pas de dernier mois', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await familleAbonnee(paul);
  const cancel = s.stripe.api.subscriptions.cancel;
  s.stripe.api.subscriptions.cancel = async () => { throw new Error('Simulation : Stripe injoignable'); };
  try {
    await assert.rejects(s.appeler('retracter', { fid }, paul), /Réessayez/);
  } finally {
    s.stripe.api.subscriptions.cancel = cancel;
  }
  await s.calme();
  erreurAttendue(/abonnement Stripe non arrêté/);
  // L'appli propose toujours le bouton.
  assert.ok((await s.appeler('finDeContrat', { fid }, paul)).retractation, 'le bouton « Annuler ma commande » reste');
  const r = await s.appeler('retracter', { fid }, paul);
  await s.calme();
  assert.strictEqual(r.remboursement, 'au-retour');
  assert.strictEqual(r.montant, 6000);
  assert.strictEqual(abo(id).status, 'canceled');
  const c = await commande(id);
  assert.strictEqual(c.restitution.statut, 'attendue');
  assert.strictEqual(c.dernierMois, undefined);
  assert.strictEqual(c.retractation.enCours, undefined);
});

test('A2. annulation avant l\'envoi, remboursement refusé : Papote reçoit un e-mail et « À faire » le montre', async () => {
  const { abonnement: id } = await a.commanderEtPayer({ email: 'paul@exemple.fr' });
  s.boite.length = 0;
  const create = s.stripe.api.refunds.create;
  s.stripe.api.refunds.create = async () => { throw new Error('Simulation : remboursement refusé'); };
  try {
    await assert.rejects(s.appeler('retracter', { commande: id }, a.TANGUY), /remboursement a échoué : nous le faisons à la main/);
  } finally {
    s.stripe.api.refunds.create = create;
  }
  await s.calme();
  erreurAttendue(/remboursement refusé/);
  assert.strictEqual((await commande(id)).remboursement.statut, 'echec');
  assert.ok(mailsA(PAPOTE).some((sujet) => /Remboursement à faire à la main/.test(sujet)), JSON.stringify(mailsA(PAPOTE)));
  assert.ok((await aFaire()).some((l) => /1 remboursement échoué/.test(l)), JSON.stringify(await aFaire()));
});

test('A3. casse 130 € en prélèvement SEPA, refusé par la banque après le départ de la tablette : noté, Papote prévenu, « À faire »', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id } = await familleAbonnee(paul);
  const neuve = await a.tablettePreparee();
  await a.simSurTablette(neuve);
  const create = s.stripe.api.paymentIntents.create;
  let pi;
  let params;
  s.stripe.api.paymentIntents.create = async (...args) => {
    [params] = args;
    pi = await create(...args);
    s.stripe.etat.paiements.get(pi.id).status = 'processing';
    return { ...pi, status: 'processing' };
  };
  try {
    await s.appeler('gestionStock', { action: 'remplacer', commande: id, element: 'tablette', nouveau: neuve.fiche, raison: 'casse', motif: 'écran' }, a.TANGUY);
  } finally {
    s.stripe.api.paymentIntents.create = create;
  }
  await s.calme();
  // B1 : paiement confirmé côté serveur, sans moyen de paiement à redirection (sinon Stripe exige return_url).
  assert.deepStrictEqual(params.automatic_payment_methods, { enabled: true, allow_redirects: 'never' });
  assert.strictEqual(params.off_session, true);
  assert.strictEqual((await commande(id)).remplacement.statut, 'preleve');
  s.boite.length = 0;
  s.avancer(3);
  const vrai = s.stripe.etat.paiements.get(pi.id);
  vrai.status = 'requires_payment_method';
  const refus = { id: 'evt_audit_refus', type: 'payment_intent.payment_failed', data: { object: { ...structuredClone(vrai), last_payment_error: { message: 'Insufficient funds' } } } };
  s.stripe.etat.evenements.push(refus);
  await s.calme();
  const c = await commande(id);
  assert.strictEqual(c.remplacement.statut, 'echec');
  assert.strictEqual(c.remplacement.erreur, 'Insufficient funds');
  assert.deepStrictEqual(mailsA(PAPOTE).filter((sujet) => /Remplacement payant refusé/.test(sujet)).length, 1, JSON.stringify(mailsA(PAPOTE)));
  assert.ok((await aFaire()).some((l) => /1 remplacement payant refusé par la banque/.test(l)), JSON.stringify(await aFaire()));
  // Le même message renvoyé par Stripe (autre identifiant) : pas de deuxième e-mail.
  s.stripe.etat.evenements.push({ ...refus, id: 'evt_audit_refus2' });
  await s.calme();
  assert.strictEqual(mailsA(PAPOTE).filter((sujet) => /Remplacement payant refusé/.test(sujet)).length, 1);
});

test('A3 bis. carte refusée tout de suite pour une casse : rien n\'est remplacé, le message de refus de Stripe ne change rien', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id } = await familleAbonnee(paul);
  const neuve = await a.tablettePreparee();
  await a.simSurTablette(neuve);
  s.stripe.carteExpiree(id);
  await assert.rejects(s.appeler('gestionStock', { action: 'remplacer', commande: id, element: 'tablette', nouveau: neuve.fiche, raison: 'casse', motif: 'écran' }, a.TANGUY), /refusé/);
  s.boite.length = 0;
  s.stripe.etat.evenements.push({ id: 'evt_audit_refus3', type: 'payment_intent.payment_failed', data: { object: {
    id: 'pi_refuse', amount: 13000, description: 'Papote : tablette cassée, remplacée', metadata: { commande: id, remplacement: `${id}-x` }, last_payment_error: { message: 'expired' } } } });
  await s.calme();
  assert.strictEqual((await commande(id)).remplacement.statut, 'refuse');
  assert.deepStrictEqual(mailsA(PAPOTE), []);
});

test('A4. commande payée, tablette toujours pas partie : le premier prélèvement est repoussé chaque fois qu\'il approche, « À faire » le dit jusqu\'à l\'envoi', async () => {
  const { abonnement: id } = await a.commanderEtPayer({ email: 'paul@exemple.fr' });
  const t = await a.tablettePreparee();
  const premier = () => (abo(id).trial_end || abo(id).billing_cycle_anchor) * 1000;
  const prevu = premier();
  // 29 jours : encore loin, rien ne bouge.
  s.avancer(29);
  await s.tache('restitutions');
  assert.strictEqual(premier(), prevu);
  assert.ok(!(await aFaire()).some((l) => /toujours pas partie/.test(l)));
  // Puis jour après jour jusqu'à 45 jours sans envoi : jamais de prélèvement avant le départ.
  for (let j = 0; j < 16; j += 1) {
    s.avancer(1);
    await s.tache('restitutions');
    assert.ok(premier() - Date.now() >= 6 * s.JOUR, `jour ${30 + j} : premier prélèvement toujours à plus de 6 jours`);
  }
  assert.ok(premier() > prevu);
  assert.ok((await aFaire()).some((l) => /payée mais toujours pas partie : premier prélèvement repoussé/.test(l)), JSON.stringify(await aFaire()));
  // La tablette part enfin : la ligne disparaît. (Le recalage sur la réception + 30 jours, debutApresReception, est
  // vérifié dans cas-limites : ici l'horloge avancée et l'heure du serveur de l'émulateur ne s'accordent pas.)
  await a.preparerEtEnvoyer(id, t);
  await s.calme();
  assert.ok(!(await aFaire()).some((l) => /toujours pas partie/.test(l)));
});

test('B3-B4. contrôle de nuit : tout est d\'accord → rien ; un abonnement arrêté chez Stripe sans que la base le sache, un prélèvement resté en plan → lignes « À faire »', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await familleAbonnee(paul);
  await s.tache('gestionAutomatique');
  assert.deepStrictEqual((await s.lire('gestion/automatique')).rapprochement, []);
  // Message Stripe perdu : l'abonnement est arrêté chez Stripe, la famille est toujours « active ».
  abo(id).status = 'canceled';
  // Serveur arrêté en plein prélèvement du dernier mois, il y a deux jours.
  await s.db.doc(`commandes/${id}`).update({ dernierMois: { statut: 'en-cours', montant: 2500, le: s.Timestamp.fromMillis(Date.now() - 2 * s.JOUR) } });
  await s.tache('gestionAutomatique');
  const liste = await aFaire();
  assert.ok(liste.some((l) => /Famille Mamie Emma notée « active », mais son abonnement Stripe est arrêté/.test(l)), JSON.stringify(liste));
  assert.ok(liste.some((l) => /Dernier mois de .* resté « en cours »/.test(l)), JSON.stringify(liste));
  assert.strictEqual((await s.lire(`families/${fid}`)).abonnement.statut, 'actif', 'le contrôle ne corrige rien, il signale');
});
