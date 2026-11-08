// Accès aux fonctions de l'appli famille : seuls les responsables encore membres touchent à l'abonnement,
// et les e-mails ou relevés qu'un compte peut déclencher sont plafonnés.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, mailsA } = require('./commun');

brancher();

async function familleInstallee(proche) {
  const t = await a.tablettePreparee();
  await a.afficherCode(t);
  return a.installer(proche, t);
}

test('un responsable parti de la famille ne touche plus à son abonnement', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const fid = await familleInstallee(julie);
  await a.rejoindre(paul, fid);
  await s.db.doc(`families/${fid}`).update({ admins: [paul.uid] });

  // Paul quitte la famille lui-même : il reste dans admins, mais n'est plus membre.
  await s.db.doc(`families/${fid}/members/${paul.uid}`).delete();
  await s.calme();
  for (const nom of ['creerPaiement', 'portailClient', 'resilierAbonnement', 'retracter', 'finDeContrat', 'rattacherCommande']) {
    await assert.rejects(s.appeler(nom, { fid, formule: 'wifi', tablette: 'incluse' }, paul), /responsables/, nom);
  }
  await assert.rejects(s.appeler('inviterParEmail', { fid, email: 'x@exemple.fr' }, paul), /membres/);

  // Julie, toujours membre, peut prendre l'abonnement.
  const { url } = await s.appeler('creerPaiement', { fid, formule: 'wifi', tablette: 'incluse' }, julie);
  assert.ok(url);
});

test('un compte n\'envoie pas plus de 20 invitations par jour, même avec plusieurs familles', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const fid1 = await familleInstallee(julie);
  const fid2 = await familleInstallee(julie);
  for (let i = 0; i < 20; i++) {
    await s.appeler('inviterParEmail', { fid: i % 2 ? fid2 : fid1, email: `proche${i}@exemple.fr` }, julie);
  }
  await assert.rejects(s.appeler('inviterParEmail', { fid: fid2, email: 'proche20@exemple.fr' }, julie), /Trop d'invitations/);
  assert.strictEqual(mailsA('proche20@exemple.fr').length, 0);
  s.avancer(1);
  await s.appeler('inviterParEmail', { fid: fid2, email: 'proche20@exemple.fr' }, julie);
});

test('relevé des appels ratés : 50 par compte et par jour, au-delà dans les journaux seulement', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  for (let i = 0; i < 55; i++) await s.appeler('incidentAppel', { raison: 'test', detail: String(i) }, julie);
  const releves = await s.db.collection('incidentsAppels').where('uid', '==', julie.uid).get();
  assert.strictEqual(releves.size, 50);
});

// Inspection 5 (3/11) : quelqu'un qui ouvre des pages de paiement sans jamais payer bloquerait tout le stock
// 32 minutes à chaque fois (une tablette mise de côté par page). Au-delà de 5 pages en une heure depuis la même
// adresse internet, ou de 2 pour le même e-mail, la commande renvoie à la page de commande avec « ?trop=1 ».
test('pages de paiement ouvertes à la chaîne : 5 par adresse et 2 par e-mail en une heure, le stock n\'est pas bloqué', async () => {
  // Assez de tablettes pour que chaque page en mette une de côté (sans stock, une commande d'essai passerait sans réserver).
  for (let i = 0; i < 12; i++) await a.tablettePreparee();
  const stock = require('../stock');
  const essai = (entetes, email) => s.requete('commander', {
    query: { formule: 'sim', tablette: 'incluse', ...a.RELAIS, ...(email ? { email } : {}), essai: '' }, entetes,
  });
  const deA = { 'x-forwarded-for': '203.0.113.7' };
  for (let i = 0; i < stock.ESSAIS_HEURE_IP; i++) {
    const r = await essai(deA);
    assert.strictEqual(r.statut, 303);
    assert.match(r.redirection, /checkout\.stripe\.test/, `page ${i + 1} ouverte`);
  }
  const refus = await essai(deA);
  assert.strictEqual(refus.statut, 303);
  assert.match(refus.redirection, /commande\.html\?trop=1$/, 'la 6e page est refusée');
  // Une autre adresse passe encore ; le même e-mail, deux fois seulement.
  const deB = { 'x-forwarded-for': '198.51.100.9' };
  assert.match((await essai(deB, 'curieux@exemple.fr')).redirection, /checkout\.stripe\.test/);
  assert.match((await essai(deB, 'curieux@exemple.fr')).redirection, /checkout\.stripe\.test/);
  assert.match((await essai(deB, 'Curieux@exemple.fr')).redirection, /commande\.html\?trop=1$/, 'le 3e essai du même e-mail est refusé');
  assert.match((await essai(deB, 'autre@exemple.fr')).redirection, /checkout\.stripe\.test/, 'un autre e-mail passe');
  // Une heure plus tard, l'adresse peut recommencer.
  s.avancer(1 / 24 + 0.01);
  assert.match((await essai(deA)).redirection, /checkout\.stripe\.test/, 'une heure après, à nouveau possible');
  // Les réservations finies depuis plus d'un jour sont effacées par le ménage quotidien.
  s.avancer(2);
  const avant = (await s.db.collection('reservations').get()).size;
  assert.ok(avant >= 9, `réservations gardées : ${avant}`);
  await stock.nettoyerReservations(s.db);
  assert.strictEqual((await s.db.collection('reservations').get()).size, 0, 'toutes effacées après un jour');
});
