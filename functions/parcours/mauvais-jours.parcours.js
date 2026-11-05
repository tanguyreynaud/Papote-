// Les mauvais jours (audit du 5/11) : décès du proche, paiement refusé jusqu'au bout des relances de Stripe,
// effacement des données 3 mois après l'arrêt. Ce que reçoit la famille, mot pour mot.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, mailsA, commande } = require('./commun');

brancher();

const famille = (fid) => s.lire(`families/${fid}`);
const mailsComplets = (email) => s.boite.filter((m) => m.a === email);

async function familleAbonnee(acheteur, proche = acheteur) {
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: acheteur.email });
  await a.preparerEtEnvoyer(id, t);
  s.avancer(2);
  await a.afficherCode(t);
  const fid = await a.installer(proche, t);
  s.avancer(31);
  s.stripe.finirEssai(id);
  await s.calme();
  return { id, fid, t };
}

test('décès : arrêt avec le motif « décès », e-mails de deuil sans « Merci de nous avoir fait confiance » ni somme en gras, plus de nouvelles', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const { id, fid } = await familleAbonnee(paul, julie);
  s.boite.length = 0;

  await s.appeler('resilierAbonnement', { fid, motif: 'deces' }, julie);
  await s.calme();
  const [arret] = mailsComplets(paul.email);
  assert.strictEqual(arret.sujet, 'Nous pensons bien à vous');
  assert.match(arret.texte, /condoléances/);
  assert.match(arret.texte, /Tout télécharger/, 'les photos à garder avant l\'effacement');
  assert.doesNotMatch(arret.texte, /140|Garder mon abonnement/);
  assert.strictEqual((await commande(id)).motif, 'deces');

  s.avancer(30);
  s.stripe.arreterALaDate(id);
  await s.calme();
  const retour = mailsComplets(paul.email).at(-1);
  assert.strictEqual(retour.sujet, 'La tablette Papote, quand vous serez prêt');
  assert.doesNotMatch(retour.texte, /Merci de nous avoir fait confiance/);
  assert.match(retour.texte, /Rien ne presse/);
  assert.doesNotMatch(retour.texte, /seront prélevés/, 'pas de menace de prélèvement, seulement la règle en petit');

  s.avancer(24);
  await s.tache('restitutions');
  const rappel = mailsComplets(paul.email).at(-1);
  assert.strictEqual(rappel.sujet, 'La tablette Papote, un petit rappel');
  assert.doesNotMatch(rappel.texte, /Pensez à nous rendre/);

  // Plus jamais de nouvelles de Papote (campagnes) à cette adresse.
  const { contacts } = await s.appeler('gestionClients', {}, a.TANGUY);
  const fiche = contacts.find((c) => c.email === paul.email);
  assert.ok(fiche && fiche.desinscrit, 'désinscrit des nouvelles');
  assert.deepStrictEqual(mailsA(julie.email), [], 'rien d\'autre à Julie');
  assert.strictEqual((await famille(fid)).abonnement.statut, 'resilie');
});

test('effacement 3 mois après l\'arrêt : la famille est prévenue un mois avant, avec « Tout télécharger », puis seulement effacée', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const { id, fid } = await familleAbonnee(paul, julie);
  await s.appeler('resilierAbonnement', { fid, motif: 'deces' }, julie);
  s.avancer(30);
  s.stripe.arreterALaDate(id);
  await s.calme();
  s.boite.length = 0;

  s.avancer(40);
  await s.tache('purgeMensuelle');
  assert.deepStrictEqual(mailsA(paul.email), [], 'trop tôt pour prévenir');
  s.avancer(25);
  await s.tache('purgeMensuelle');
  await s.calme();
  assert.ok(await famille(fid), 'pas encore effacée');
  const [avis] = mailsComplets(paul.email);
  assert.ok(avis, 'e-mail avant l\'effacement');
  assert.strictEqual(avis.sujet, 'Les photos de la famille, à garder');
  assert.match(avis.texte, /Tout télécharger/);
  // Effacement prévu dans 25 jours, la tâche suivante tombe un mois plus tard : effacée à ce moment-là.
  s.avancer(10);
  await s.tache('purgeMensuelle');
  assert.ok(await famille(fid), 'prévenue il y a 10 jours : gardée');
  s.avancer(21);
  await s.tache('purgeMensuelle');
  await s.calme();
  assert.ok(!(await famille(fid)), 'effacée après l\'avis');
  assert.strictEqual(mailsComplets(paul.email).length, 1, 'un seul avis');
});
