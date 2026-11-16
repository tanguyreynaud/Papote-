// Première mise en route par une famille (audit du 12/11/2026, décisions de Tanguy du 12/11) : ce qui arrive quand le
// parcours « famille préparée » ne se passe pas dans l'ordre prévu. Joué avec les vraies fonctions (simulation.js).
// Rapports : /mnt/project-files/audit/mise-en-route-12-11/rapport.md (M0, M2), securite-boucle-11-11.md (L2).

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, mailsA, commande } = require('./commun');

brancher();

const familles = async () => (await s.db.collection('families').get()).docs;
const gestion = require('../gestion');
// « À faire » de l'admin, calculé comme gestionDonnees (voir audit-argent.parcours.js).
async function aFaire() {
  const commandes = await s.db.collection('commandes').get();
  return gestion.regles.aFaire({
    commandes: commandes.docs.map((d) => ({ id: d.id, ...d.data() })), stock: [], depenses: [], maintenant: Date.now(), automatique: {},
  });
}

// Garde-fou : allumée chez Tanguy avant « Colis déposé », la tablette reste hors famille ; rallumée chez Mamie, son
// nouveau code la fait entrer seule, sans que personne ne scanne.
test('tablette allumée avant le dépôt du colis, puis chez Mamie : elle entre seule dans la famille de sa commande', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  const { fid } = await commande(id);
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { commande: id } }, a.TANGUY);
  await a.afficherCode(t);
  assert.strictEqual((await s.lire(`pairings/${t.code}`)).status, 'waiting', 'colis pas parti : pas de famille');
  await a.preparerEtEnvoyer(id, t);
  await a.afficherCode(t);
  assert.strictEqual(await a.entrerDansLaFamille(t), fid);
  assert.strictEqual((await familles()).length, 1);
});

// M2 et A29 (Tanguy 12/11 : « il ne doit y avoir aucune trace de l'ancien parcours », seul Papote relie une tablette).
// La tablette montre son QR tant que le jumelage tout seul n'est pas fait (colis pas noté « déposé ») : celui qui a
// payé le scanne quand même. Refusé, aucune famille en plus ; la tablette entre seule dans sa famille une fois partie.
test('M2 : celui qui a payé scanne le QR encore affiché : refusé, jamais de deuxième famille, la tablette entre seule ensuite', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  const { fid } = await commande(id);
  await a.entrerParInvitation(paul, fid);
  await s.appeler('nommerFamillePreparee', { fid, nom: 'Mamie Emma' }, paul);
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { commande: id } }, a.TANGUY);
  await a.afficherCode(t);
  s.boite.length = 0;
  await assert.rejects(s.appeler('reserverTablette', { code: t.code, prenom: 'Paul' }, paul), /rien à scanner/);
  await assert.rejects(s.appeler('nommerFamille', { code: t.code, nom: 'Mamie Emma' }, paul), /plus réservée/);
  await s.calme();
  assert.strictEqual((await familles()).length, 1, 'une seule famille');
  assert.strictEqual((await s.lire(`pairings/${t.code}`)).status, 'waiting');
  assert.deepStrictEqual(mailsA('contact@mapapote.fr'), [], 'rien à réparer pour Tanguy');
  await a.preparerEtEnvoyer(id, t);
  await a.afficherCode(t);
  assert.strictEqual(await a.entrerDansLaFamille(t), fid);
  assert.strictEqual((await familles()).length, 1);
});

// L2 (boucle sécurité 11/11). Un inconnu crée un code (pairings est ouvert aux comptes anonymes) et envoie le lien
// « ?tablette=CODE » à celui qui vient de payer. Plus rien ne le confirme : le compte de l'intrus n'entre jamais.
test('L2 : code d\'un inconnu envoyé à celui qui a payé : jamais confirmé dans sa famille', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  const { fid } = await commande(id);
  await a.entrerParInvitation(paul, fid);
  const intrus = { tabletUid: 'intrus-anonyme', callsUid: 'intrus-appels', serie: 'FAUSSE' };
  await a.afficherCode(intrus);
  await assert.rejects(s.appeler('reserverTablette', { code: intrus.code, prenom: 'Paul' }, paul), /rien à scanner/);
  await s.calme();
  const p = await s.lire(`pairings/${intrus.code}`);
  assert.strictEqual(p.status, 'waiting');
  assert.strictEqual(p.fid, undefined);
});

// Le seul passage qui reste : un compte administrateur (gardé pour Papote, jamais dans l'appli des clients).
test('A29 : seul un compte administrateur peut encore réserver une tablette par son code', async () => {
  const t = await a.tablettePreparee();
  await a.afficherCode(t);
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  await assert.rejects(s.appeler('reserverTablette', { code: t.code, prenom: 'Julie' }, julie), /rien à scanner/);
  assert.deepStrictEqual(await s.appeler('reserverTablette', { code: t.code, prenom: 'Julie' }, a.commeAdmin(julie)), { etat: 'reserve' });
});

// M0. Pas de box chez la personne, 4G qui n'arrive pas : la tablette ne peut prévenir personne. Le serveur voit le
// colis retiré (suivi Mondial Relay) sans tablette dans la famille : Tanguy est prévenu une fois, 2 jours après.
test('M0 : colis retiré il y a 2 jours, tablette toujours pas connectée : Tanguy est prévenu une seule fois', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(id, t);
  s.avancer(2);
  await s.db.doc(`commandes/${id}`).update({ 'preparation.recuLe': Date.now(), 'preparation.recuPar': 'suivi Mondial Relay' });
  s.boite.length = 0;
  s.avancer(1);
  await s.tache('rappelsJumelage');
  assert.deepStrictEqual(mailsA('contact@mapapote.fr').filter((m) => /pas encore connectée/.test(m)), [], 'pas avant 2 jours');
  s.avancer(1.1);
  await s.tache('rappelsJumelage');
  s.avancer(1);
  await s.tache('rappelsJumelage');
  assert.strictEqual(mailsA('contact@mapapote.fr').filter((m) => /pas encore connectée/.test(m)).length, 1);
  assert.strictEqual((await commande(id)).alerteConnexion, true);
  assert.ok((await aFaire()).some((l) => /pas encore connectée, colis retiré : appeler le client/.test(l)), JSON.stringify(await aFaire()));
});

test('M0 : tablette entrée seule dans sa famille : aucune alerte de connexion', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(id, t);
  await a.afficherCode(t);
  await a.entrerDansLaFamille(t);
  s.boite.length = 0;
  s.avancer(4);
  await s.tache('rappelsJumelage');
  assert.deepStrictEqual(mailsA('contact@mapapote.fr').filter((m) => /pas encore connectée/.test(m)), []);
  assert.strictEqual((await commande(id)).alerteConnexion, undefined);
});

// M6 (Tanguy 12/11). La tablette est chez Mamie, personne n'est encore entré dans l'appli. Mamie appuie sur SOS :
// celui qui a payé et Papote sont prévenus par e-mail, une fois (le 2e essai n'en renvoie pas).
test('M6 : SOS alors que personne n\'est encore entré dans la famille : celui qui a payé et Papote sont prévenus', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(id, t);
  await a.afficherCode(t);
  const fid = await a.entrerDansLaFamille(t);
  s.boite.length = 0;
  for (const essai of [1, 2]) {
    const cid = await a.appelerDepuisLaTablette(t, { sos: essai });
    await s.db.doc(`families/${fid}/calls/${cid}`).update({ state: 'missed' });
    await s.calme();
  }
  assert.strictEqual(mailsA(paul.email).filter((m) => /SOS/.test(m)).length, 1, `un e-mail SOS à celui qui a payé (reçus : ${JSON.stringify(mailsA(paul.email))})`);
  assert.strictEqual(mailsA('contact@mapapote.fr').filter((m) => /SOS/.test(m)).length, 1, 'Papote prévenu une fois');
});

// M6 (garde-fou). Un proche est dans la famille : le SOS suit son chemin habituel, pas d'e-mail « sans proche ».
test('M6 : SOS avec un proche dans la famille : pas d\'e-mail « sans proche »', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(id, t);
  await a.afficherCode(t);
  await a.installer(paul, t);
  s.boite.length = 0;
  await a.appelerDepuisLaTablette(t, { sos: 1 });
  await s.calme();
  assert.deepStrictEqual(mailsA('contact@mapapote.fr').filter((m) => /SOS sans aucun proche/.test(m)), []);
});

// M7 (Tanguy 12/11). Tablette branchée chez Mamie, personne dans l'appli : celui qui a payé est relancé une fois à
// 2 jours, Papote voit une ligne « À faire » à 5 jours, qui disparaît dès qu'un proche arrive.
test('M7 : tablette branchée, personne dans l\'appli : relance à 2 jours, « À faire » à 5 jours, effacé quand un proche arrive', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  const { fid } = await commande(id);
  await a.preparerEtEnvoyer(id, t);
  await a.afficherCode(t);
  await a.entrerDansLaFamille(t);
  s.boite.length = 0;
  s.avancer(1);
  await s.tache('rappelsJumelage');
  assert.deepStrictEqual(mailsA(paul.email), [], 'pas avant 2 jours');
  s.avancer(1.1);
  await s.tache('rappelsJumelage');
  s.avancer(1);
  await s.tache('rappelsJumelage');
  assert.deepStrictEqual(mailsA(paul.email).filter((m) => /envoyez la première photo/.test(m)).length, 1, 'une seule relance');
  assert.ok(!(await commande(id)).alerteSansProche, 'pas encore de ligne « À faire »');
  s.avancer(2);
  await s.tache('rappelsJumelage');
  assert.strictEqual((await commande(id)).alerteSansProche, true);
  assert.ok((await aFaire()).some((l) => /branchée depuis 5 jours, personne dans l'appli/.test(l)), JSON.stringify(await aFaire()));
  await a.entrerParInvitation(paul, fid);
  s.avancer(1);
  await s.tache('rappelsJumelage');
  assert.ok(!(await commande(id)).alerteSansProche, 'effacé : un proche est arrivé');
  assert.deepStrictEqual(mailsA(paul.email).filter((m) => /envoyez la première photo/.test(m)).length, 1);
  assert.ok(!(await aFaire()).some((l) => /personne dans l'appli/.test(l)));
});

// A13 (Tanguy, 12/11) : les CGV partent en PDF avec la confirmation de commande ; Papote reçoit sa copie sans.
test('commande payée : la confirmation arrive au client avec les CGV en PDF jointes', async () => {
  await a.tablettePreparee();
  await a.commanderEtPayer({ email: 'cgv@exemple.fr' });
  await s.calme();
  const conf = s.boite.filter((m) => m.a === 'cgv@exemple.fr' && /^Merci pour votre commande/.test(m.sujet));
  assert.strictEqual(conf.length, 1);
  assert.deepStrictEqual(conf[0].pieces, ['Conditions générales de vente Papote.pdf']);
  assert.match(conf[0].texte, /conditions générales de vente sont jointes/);
});
