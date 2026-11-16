// M0 et M2 avant la mise à jour de la tablette (Tanguy 12/11) : la tablette qui n'est pas reliée à sa famille au bout
// de 2 minutes affiche « Papote est prévenu et s'en occupe ». Pour que ce soit vrai :
//   (a) 48 h après l'arrivée de la tablette (colis retiré, remise en main propre, colis sans suivi compté arrivé),
//       toujours hors famille : Tanguy prévenu une seule fois ;
//   (b) tablette qui a internet (elle écrit son code) mais ne trouve pas sa famille : Tanguy prévenu tout de suite,
//       une seule fois par tablette et par commande ;
//   (c) le vieux chemin « code scanné → nom → nouvelle famille » ne crée plus de famille pour un client, ni une
//       deuxième famille pour une tablette dont la commande a déjà la sienne.
// Joué avec les vraies fonctions (simulation.js).

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, mailsA, commande } = require('./commun');

brancher();

const PAPOTE = 'contact@mapapote.fr';
const familles = async () => (await s.db.collection('families').get()).docs;
const gestion = require('../gestion');
async function aFaire() {
  const commandes = await s.db.collection('commandes').get();
  return gestion.regles.aFaire({
    commandes: commandes.docs.map((d) => ({ id: d.id, ...d.data() })), stock: [], depenses: [], maintenant: Date.now(), automatique: {},
  });
}
const alertesConnexion = () => mailsA(PAPOTE).filter((m) => /pas encore connectée/.test(m));
const alertesSansFamille = () => mailsA(PAPOTE).filter((m) => /connectée mais sans famille/.test(m));

// « Remis en main propre » dans l'admin (tabletteEnvoyee, mainPropre) : même préparation qu'un colis, sans suivi.
async function remettreEnMainPropre(id, t) {
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { commande: id } }, a.TANGUY);
  await a.simSurTablette(t);
  await s.appeler('tabletteEnvoyee', { commande: id, mainPropre: true, tablette: t.ref }, a.TANGUY);
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { etat: 'envoyee', commande: id } }, a.TANGUY);
  await s.calme();
}

// ---------- (a) 48 h après l'arrivée ----------

test('(a) tablette remise en main propre par Papote, pas connectée 48 h après : Tanguy prévenu une seule fois', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await remettreEnMainPropre(id, t);
  const c = await commande(id);
  assert.strictEqual(c.remise, 'main-propre');
  s.boite.length = 0;
  s.avancer(1);
  await s.tache('rappelsJumelage');
  assert.deepStrictEqual(alertesConnexion(), [], 'pas avant 48 h');
  s.avancer(1.1);
  await s.tache('rappelsJumelage');
  s.avancer(1);
  await s.tache('rappelsJumelage');
  assert.deepStrictEqual(alertesConnexion(), ['Tablette pas encore connectée, remise en main propre il y a 48 h : Paul Martin']);
  assert.strictEqual((await commande(id)).alerteConnexion, true);
  assert.ok((await aFaire()).includes('Tablette de Paul Martin pas encore connectée, remise en main propre : appeler le client'), JSON.stringify(await aFaire()));
});

test('(a) colis parti avec un n° de suivi tapé à la main (sans Sendcloud) : alerte 3 jours + 48 h après l\'envoi, une fois', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(id, t);
  const c = await commande(id);
  assert.ok(!(c.etiquettes && c.etiquettes.aller && c.etiquettes.aller.colis), 'pas d\'étiquette Sendcloud');
  assert.ok(!(c.preparation && c.preparation.recuLe), 'retrait jamais noté');
  s.boite.length = 0;
  s.avancer(4.9);
  await s.tache('rappelsJumelage');
  assert.deepStrictEqual(alertesConnexion(), [], 'pas avant envoi + 3 jours + 48 h');
  s.avancer(0.2);
  await s.tache('rappelsJumelage');
  s.avancer(1);
  await s.tache('rappelsJumelage');
  assert.deepStrictEqual(alertesConnexion(), ['Tablette pas encore connectée, colis parti sans suivi il y a 5 jours : Paul Martin']);
  assert.ok((await aFaire()).some((l) => /Paul Martin pas encore connectée, colis parti sans suivi : appeler le client/.test(l)));
});

test('(a) colis Sendcloud pas encore retiré au relais : aucune alerte de connexion (la tablette n\'est pas chez la personne)', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(id, t);
  // Étiquette Sendcloud faite dans l'admin (gestionEtiquette) : le suivi de nuit notera le retrait.
  await s.db.doc(`commandes/${id}`).update({ 'etiquettes.aller': { colis: 4242, suivi: 'MR4242', le: Date.now() } });
  s.boite.length = 0;
  s.avancer(6);
  await s.tache('rappelsJumelage');
  assert.deepStrictEqual(alertesConnexion(), []);
});

test('(a) remise en main propre puis entrée dans la famille le lendemain : aucune alerte', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  const { fid } = await commande(id);
  await remettreEnMainPropre(id, t);
  s.avancer(1);
  await a.afficherCode(t);
  assert.strictEqual(await a.entrerDansLaFamille(t), fid);
  s.boite.length = 0;
  s.avancer(3);
  await s.tache('rappelsJumelage');
  assert.deepStrictEqual(alertesConnexion(), []);
  assert.deepStrictEqual(alertesSansFamille(), []);
  assert.strictEqual((await commande(id)).alerteConnexion, undefined);
});

// ---------- (b) internet, mais pas de famille ----------

test('(b) ancienne commande sans famille préparée : la tablette a internet, Tanguy prévenu tout de suite, une seule fois', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await a.commandeDAvant(id);
  await a.preparerEtEnvoyer(id, t);
  s.boite.length = 0;
  await a.afficherCode(t);
  assert.strictEqual((await s.lire(`pairings/${t.code}`)).status, 'waiting');
  assert.deepStrictEqual(alertesSansFamille(), [`Tablette connectée mais sans famille : ${t.ref} (commande de Paul Martin)`]);
  const corps = s.boite.find((m) => /sans famille/.test(m.sujet));
  assert.match(JSON.stringify(corps), new RegExp(`n° de série ${t.serie}`));
  assert.match(JSON.stringify(corps), /sa commande n'a pas de famille/);
  // Code renouvelé tous les quarts d'heure, tablette éteinte et rallumée : pas d'autre e-mail.
  await a.afficherCode(t);
  s.avancer(1);
  await a.afficherCode(t);
  assert.strictEqual(alertesSansFamille().length, 1);
  const marque = (await s.db.collection('alertesJumelage').get()).docs;
  assert.strictEqual(marque.length, 1);
  assert.strictEqual(marque[0].get('serie'), t.serie);
  assert.strictEqual(marque[0].get('etat'), 'sans-famille');
  assert.strictEqual((await familles()).length, 0, 'aucune famille créée');
});

test('(b) tablette inconnue du stock (n° de série absent) : Tanguy prévenu une fois, avec le n° de série', async () => {
  const inconnue = { tabletUid: 'tablette-inconnue', callsUid: 'appels-inconnue', serie: 'R9XN30ZZZZ' };
  await a.afficherCode(inconnue);
  await a.afficherCode(inconnue);
  assert.deepStrictEqual(alertesSansFamille(), ['Tablette connectée mais sans famille : n° de série R9XN30ZZZZ']);
  assert.match(JSON.stringify(s.boite.find((m) => /sans famille/.test(m.sujet))), /aucune tablette du stock n'a le n° de série R9XN30ZZZZ/);
});

test('(b) tablette envoyée dont la fiche n\'a pas de commande : alerte, puis Tanguy la relie et elle entre seule', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  const { fid } = await commande(id);
  await a.preparerEtEnvoyer(id, t);
  // Erreur de saisie dans Stock : la fiche a perdu sa commande.
  await s.db.doc(`stock/${t.fiche}`).update({ commande: null });
  s.boite.length = 0;
  await a.afficherCode(t);
  assert.deepStrictEqual(alertesSansFamille(), [`Tablette connectée mais sans famille : ${t.ref}`]);
  assert.match(JSON.stringify(s.boite.find((m) => /sans famille/.test(m.sujet))), /aucune commande/);
  await s.db.doc(`stock/${t.fiche}`).update({ commande: id });
  await a.afficherCode(t);
  assert.strictEqual(await a.entrerDansLaFamille(t), fid);
  assert.strictEqual(alertesSansFamille().length, 1);
});

test('(b) chemins normaux : allumée chez Papote (préparation, stock), puis entrée seule : aucune alerte', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const enStock = await a.tablettePreparee();
  await a.afficherCode(enStock);
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  const { fid } = await commande(id);
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { commande: id } }, a.TANGUY);
  await a.afficherCode(t);
  await a.preparerEtEnvoyer(id, t);
  await a.afficherCode(t);
  assert.strictEqual(await a.entrerDansLaFamille(t), fid);
  assert.deepStrictEqual(alertesSansFamille(), []);
  assert.strictEqual((await s.db.collection('alertesJumelage').get()).size, 0);
});

// ---------- (c) le scan ne crée plus de famille ----------

test('(c) M2 : même un compte admin ne crée pas une deuxième famille pour une tablette dont la commande a la sienne', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  const { fid } = await commande(id);
  assert.strictEqual((await familles()).length, 1, 'famille créée à la commande payée');
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { commande: id } }, a.TANGUY);
  await a.afficherCode(t);
  assert.deepStrictEqual(await s.appeler('reserverTablette', { code: t.code, prenom: 'Paul' }, a.commeAdmin(paul)), { etat: 'reserve' });
  await assert.rejects(s.appeler('nommerFamille', { code: t.code, nom: 'Mamie Emma' }, a.commeAdmin(paul)), /déjà sa famille/);
  await s.calme();
  assert.strictEqual((await familles()).length, 1, 'une seule famille');
  // La réservation rendue (« Recommencer » sur la tablette), le colis part : elle entre seule dans SA famille.
  await s.db.doc(`pairings/${t.code}`).update({ status: 'cancelled' });
  await a.preparerEtEnvoyer(id, t);
  await a.afficherCode(t);
  assert.strictEqual(await a.entrerDansLaFamille(t), fid);
  assert.strictEqual((await familles()).length, 1);
});

test('(c) réservation d\'un client restée ouverte d\'avant A29 : « Comment l\'appelez-vous ? » ne crée plus de famille', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const t = await a.tablettePreparee();
  await a.afficherCode(t);
  // Réservée par l'ancienne appli (avant le 12/11) : pairing « reserved » au nom de Julie, sans famille.
  await s.db.doc(`pairings/${t.code}`).update({
    status: 'reserved', claimedBy: julie.uid, claimedName: 'Julie', claimedEmail: julie.email, reservedAt: s.Timestamp.now(),
  });
  await assert.rejects(s.appeler('nommerFamille', { code: t.code, nom: 'Mamie Emma' }, julie), /rien à installer/);
  await s.calme();
  assert.strictEqual((await familles()).length, 0);
  assert.strictEqual((await s.lire(`pairings/${t.code}`)).fid, undefined);
});

test('(c) chemins gardés : tablette sans commande reliée par Papote (compte admin), famille préparée au paiement', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const t = await a.tablettePreparee();
  await a.afficherCode(t);
  const fid = await a.installer(julie, t);
  assert.strictEqual((await s.lire(`families/${fid}`)).name, 'Mamie Emma');
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  assert.ok((await commande(id)).fid);
  assert.strictEqual((await familles()).length, 2);
  assert.deepStrictEqual(alertesSansFamille(), [], 'tablette sans commande encore au stock : pas d\'alerte');
});
