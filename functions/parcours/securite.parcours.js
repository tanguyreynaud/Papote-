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
