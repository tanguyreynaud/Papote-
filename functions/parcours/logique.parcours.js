// Logique des parcours (Tanguy, 2026-10-27) : remise en main propre, impayé et suspension prévenus, pas de
// deuxième abonnement, reprise d'un abonnement résilié sans mise en service, payeur responsable, colis revenu,
// SOS qui n'atteint aucun téléphone, pause hospitalisation sans alerte.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, mailsA, commande } = require('./commun');
const regles = require('../abonnement');

brancher();

const famille = (fid) => s.lire(`families/${fid}`);
const alertes = () => s.notifications.filter((n) => n.type === 'alerte');

// Commande payée par `acheteur`, tablette envoyée puis installée par `proche` : { id, fid, t }.
async function familleAbonnee(acheteur, proche = acheteur) {
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: acheteur.email });
  await a.preparerEtEnvoyer(id, t);
  s.avancer(2);
  await a.afficherCode(t);
  const fid = await a.installer(proche, t);
  assert.strictEqual((await famille(fid)).abonnement.statut, 'actif');
  return { id, fid, t };
}

// Premier mois écoulé : l'abonnement est « active » chez Stripe, un mois prélevé.
async function premierMoisPasse(id) {
  s.avancer(31);
  s.stripe.finirEssai(id);
  await s.calme();
}

test('remise en main propre : envoyée et reçue le jour même, e-mail « chez vous », 30 jours pour changer d\'avis', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { commande: id } }, a.TANGUY);
  await a.simSurTablette(t);
  s.boite.length = 0;
  s.avancer(10);
  const r = await s.appeler('tabletteEnvoyee', { commande: id, mainPropre: true }, a.TANGUY);
  assert.strictEqual(r.lien, null, 'pas de lien de suivi');
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { etat: 'envoyee', commande: id } }, a.TANGUY);
  await s.calme();
  const c = await commande(id);
  assert.strictEqual(c.expedition, 'envoyee');
  assert.strictEqual(c.remise, 'main-propre');
  assert.strictEqual(c.suivi, undefined);
  assert.strictEqual(c.preparation.recuPar, 'remise en main propre');
  assert.deepStrictEqual(mailsA(paul.email), ['Votre tablette Papote est chez vous']);
  // Reçue aujourd'hui : 30 jours pour changer d'avis à partir de maintenant, puis premier prélèvement.
  const abo = s.stripe.etat.abonnements.get(id);
  const attendu = (Date.now() + 30 * s.JOUR) / 1000;
  assert.ok(Math.abs(abo.trial_end - attendu) < 3600, `premier prélèvement à J+30 (${abo.trial_end} ≠ ${attendu})`);
  assert.ok(regles.retractationPossible(c, Date.now() + 29 * s.JOUR));
  assert.ok(!regles.retractationPossible(c, Date.now() + 31 * s.JOUR));
  await assert.rejects(s.appeler('tabletteEnvoyee', { commande: id, mainPropre: true }, a.TANGUY), /déjà envoyée/);
  assert.strictEqual(mailsA(paul.email).length, 1, 'un seul e-mail');
});

test('prélèvement refusé : responsables prévenus, pause 7 jours plus tard, pas de 2e abonnement, tout revient au règlement', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const { id, fid } = await familleAbonnee(paul, julie);
  await premierMoisPasse(id);
  s.boite.length = 0;
  s.notifications.length = 0;

  s.avancer(30);
  s.stripe.banqueRefusePrelevement(id);
  await s.calme();
  let fam = await famille(fid);
  assert.strictEqual(fam.abonnement.statut, 'impaye');
  assert.strictEqual(alertes().length, 1, 'une notification « paiement échoué »');
  const [avis] = alertes();
  assert.match(avis.titre, /paiement de Papote a échoué/);
  assert.deepStrictEqual(avis.uids, [julie.uid], 'aux responsables de la famille');
  assert.strictEqual(avis.fid, fid, 'l\'appli ouvre la bonne famille');
  assert.deepStrictEqual(mailsA(paul.email), ['Le paiement de Papote n\'a pas abouti'], 'e-mail à l\'adresse de la commande');

  s.avancer(8);
  await s.tache('finDeGrace');
  await s.calme();
  fam = await famille(fid);
  assert.strictEqual(fam.abonnement.statut, 'suspendu');
  assert.ok(fam.abonnement.suspenduLe, 'date de suspension (À faire : « suspendue depuis N jours »)');
  assert.strictEqual(alertes().length, 2, 'notification « Papote est en pause »');
  assert.match(alertes()[1].titre, /en pause/);
  assert.deepStrictEqual(mailsA(paul.email), ['Le paiement de Papote n\'a pas abouti', 'Papote est en pause']);
  await s.tache('finDeGrace');
  await s.calme();
  assert.strictEqual(alertes().length, 2, 'pas prévenu deux fois');

  // Plus de deuxième abonnement (60 € de plus, dette oubliée) : le retard se règle dans le portail Stripe.
  await assert.rejects(s.appeler('creerPaiement', { fid, formule: 'wifi', tablette: 'incluse' }, julie), /Réglez d'abord le paiement/);
  assert.strictEqual(s.stripe.etat.abonnements.size, 1);

  s.stripe.banqueAccepteEnRetard(id);
  await s.calme();
  fam = await famille(fid);
  assert.strictEqual(fam.abonnement.statut, 'actif', 'réglé : tout revient');
  assert.strictEqual(alertes().length, 2, 'rien de plus à dire');
});

test('suspendue depuis 30 jours : Tanguy arrête l\'abonnement, pas de dernier mois en plus de la dette, retour de la tablette demandé', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await familleAbonnee(paul);
  await premierMoisPasse(id);
  s.avancer(30);
  s.stripe.banqueRefusePrelevement(id);
  await s.calme();
  s.avancer(8);
  await s.tache('finDeGrace');
  await s.calme();
  s.avancer(31);
  assert.ok(regles.suspendueDepuisTrop((await famille(fid)).abonnement, Date.now()), 'ligne À faire : demander le retour');
  s.boite.length = 0;

  const { le } = await s.appeler('resilierAbonnement', { fid }, a.TANGUY);
  await s.calme();
  s.avancer((le - Date.now()) / s.JOUR + 0.1);
  s.stripe.arreterALaDate(id);
  await s.calme();
  const c = await commande(id);
  assert.strictEqual((await famille(fid)).abonnement.statut, 'resilie');
  assert.strictEqual(c.dernierMois.statut, 'aucun', 'pas de dernier mois prélevé');
  assert.strictEqual(c.dernierMois.facture, undefined);
  assert.strictEqual(c.restitution.statut, 'attendue');
  assert.ok(mailsA(paul.email).some((m) => /rendre la tablette/i.test(m)), 'e-mail de retour');
});

test('deux commandes pour la même famille : « Arrêter » et « Reprendre » dans l\'admin visent la commande choisie, pas celle de la famille', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await familleAbonnee(paul);
  await premierMoisPasse(id);
  // Deuxième commande payée par Paul, reliée à la même famille (Tanguy, 30/10 : 8X9K-EB7T et EJ4N-DVBA).
  const { abonnement: id2 } = await a.commanderEtPayer({ email: paul.email });
  await s.db.doc(`commandes/${id2}`).update({ fid });
  const ligne = async (x) => (await s.appeler('gestionDonnees', {}, a.TANGUY)).commandes.find((c) => c.id === x);

  // Seul Tanguy choisit une commande précise, et seulement une commande de cette famille.
  await assert.rejects(s.appeler('resilierAbonnement', { fid, commande: id2 }, paul), /Réservé à Papote/);
  const autre = await familleAbonnee(await s.compte('Léa', 'lea@exemple.fr'));
  await assert.rejects(s.appeler('resilierAbonnement', { fid, commande: autre.id, par: 'papote' }, a.TANGUY), /pas reliée à cette famille/);

  const { le } = await s.appeler('resilierAbonnement', { fid, commande: id2, par: 'papote' }, a.TANGUY);
  await s.calme();
  assert.strictEqual(s.stripe.etat.abonnements.get(id2).cancel_at, Math.ceil(le / 1000), 'la 2e commande s\'arrête');
  assert.strictEqual(s.stripe.etat.abonnements.get(id).cancel_at, null, 'celle de la famille continue');
  const fam = await famille(fid);
  assert.strictEqual(fam.abonnement.stripeSubscriptionId, id);
  assert.strictEqual(fam.abonnement.statut, 'actif');
  assert.strictEqual(fam.abonnement.resiliationLe, null);
  assert.ok((await ligne(id2)).resiliationLe, 'admin : arrêt prévu sur la 2e commande');
  assert.strictEqual((await ligne(id)).resiliationLe, null, 'admin : rien sur la commande de la famille');

  await s.appeler('annulerResiliation', { fid, commande: id2 }, a.TANGUY);
  await s.calme();
  assert.strictEqual(s.stripe.etat.abonnements.get(id2).cancel_at, null, 'reprise de la 2e commande');
  assert.strictEqual((await ligne(id2)).resiliationLe, null);

  // Sans commande précise : toujours l'abonnement de la famille (appli du client).
  await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  assert.ok(s.stripe.etat.abonnements.get(id).cancel_at);
  assert.strictEqual(s.stripe.etat.abonnements.get(id2).cancel_at, null);
  assert.ok((await ligne(id)).resiliationLe);
});

test('résiliation : la tablette peut être renvoyée tout de suite ; sans adresse, l\'appli la demande et le QR code se crée', async () => {
  await s.db.doc('gestion/reglages').set({ expediteur: { nom: 'Papote', adresse: '1 rue de test', cp: '07000', ville: 'Privas' } }, { merge: true });
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await familleAbonnee(paul);
  await premierMoisPasse(id);
  s.boite.length = 0;
  const { le } = await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  const mailArret = s.boite.find((m) => m.a === paul.email && /résiliation/i.test(m.sujet));
  assert.ok(mailArret && /Je renvoie la tablette/.test(mailArret.texte), 'e-mail : renvoyer dès maintenant');
  assert.doesNotMatch(mailArret.texte, /attendre ce jour/);
  assert.strictEqual((await s.appeler('finDeContrat', { fid }, paul)).retourAnticipe, true);

  // Commande sans adresse (Tanguy, 30/10 : tablette jumelée sans livraison) : l'appli demande l'adresse (Tanguy, 31/10 :
  // Mondial Relay toujours possible), rien n'est bloqué ni payé chez Sendcloud avant.
  await s.db.doc(`commandes/${id}`).update({ livraison: null });
  assert.strictEqual((await s.appeler('finDeContrat', { fid }, paul)).adresse, false, 'l\'appli sait qu\'il faut l\'adresse');
  await assert.rejects(s.appeler('renvoyerTablette', { fid }, paul), (e) => /Indiquez votre adresse/.test(e.message) && e.details && e.details.adresse === true);
  await assert.rejects(s.appeler('renvoyerTablette', { fid, adresse: { rue: '3 place Bellecour', cp: '6900', ville: 'Lyon' } }, paul), /5 chiffres/);
  await assert.rejects(s.appeler('renvoyerTablette', { fid, adresse: { rue: '', cp: '69002', ville: 'Lyon' } }, paul), /numéro et la rue/);
  let c = await commande(id);
  assert.strictEqual(c.restitution.statut, 'attendue');
  assert.strictEqual(c.restitution.anticipe, true);
  assert.strictEqual(c.restitution.qrDemandeLe, undefined, 'pas bloqué deux minutes');
  assert.strictEqual(s.sendcloud.colis.size, 0, 'aucune étiquette payée sans adresse');

  const qr = await s.appeler('renvoyerTablette', { fid, adresse: { rue: ' 3  place Bellecour ', cp: '69002', ville: 'Lyon' } }, paul);
  assert.ok(qr.qr && qr.etiquette, 'QR code créé avec l\'adresse donnée');
  const colis = [...s.sendcloud.colis.values()][0];
  assert.strictEqual(colis.de.address_line_1, '3 place Bellecour');
  assert.strictEqual(colis.de.postal_code, '69002');
  c = await commande(id);
  assert.deepStrictEqual(c.retourAdresse, { rue: '3 place Bellecour', cp: '69002', ville: 'Lyon' });
  assert.ok(Math.abs(c.restitution.avant.toMillis() - regles.limiteRestitution(le)) < 60e3, 'même date limite qu\'à l\'arrêt');
});

test('abonnement résilié, tablette encore là : reprise sans les 60 €, retour attendu annulé, tablette rattachée', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const { id, fid, t } = await familleAbonnee(paul, julie);
  await premierMoisPasse(id);
  const { le } = await s.appeler('resilierAbonnement', { fid }, julie);
  await s.calme();
  s.avancer((le - Date.now()) / s.JOUR + 0.1);
  s.stripe.arreterALaDate(id);
  await s.calme();
  assert.strictEqual((await famille(fid)).abonnement.statut, 'resilie');
  assert.strictEqual((await commande(id)).restitution.statut, 'attendue');

  const { url } = await s.appeler('creerPaiement', { fid, formule: 'wifi', tablette: 'incluse' }, julie);
  const session = url.split('/').pop();
  const params = s.stripe.etat.sessions.get(session).params;
  assert.strictEqual(params.line_items.length, 1, 'l\'abonnement seul, pas de mise en service');
  assert.strictEqual(params.metadata.reprise, '1');
  assert.ok(Math.abs(Number(params.subscription_data.metadata.premier) * 1000 - (Date.now() + 30 * s.JOUR)) < 3600e3, 'premier prélèvement à 30 jours');
  assert.match(params.custom_text.submit.message, /^Rien à régler aujourd'hui/);
  const { abonnement: id2 } = s.stripe.payerSession(session, { email: paul.email });
  await s.calme();
  assert.notStrictEqual(id2, id);

  const fam = await famille(fid);
  assert.strictEqual(fam.abonnement.statut, 'actif');
  assert.strictEqual(fam.abonnement.stripeSubscriptionId, id2);
  const ancienne = await commande(id);
  assert.strictEqual(ancienne.restitution.statut, 'annulee', 'plus rien à rendre');
  assert.strictEqual(ancienne.restitution.motif, 'reprise');
  assert.strictEqual(ancienne.restitution.reprisePar, id2);
  const nouvelle = await commande(id2);
  assert.strictEqual(nouvelle.reprise, true);
  assert.strictEqual(nouvelle.fid, fid);
  assert.strictEqual(nouvelle.restitution, undefined);
  const fiche = await s.lire(`stock/${t.fiche}`);
  assert.strictEqual(fiche.commande, id2, 'la tablette suit la nouvelle commande');
  assert.strictEqual(fiche.fid, fid);
  assert.ok(!regles.retractationPossible(nouvelle, Date.now()), 'rien à annuler : pas de mise en service payée');

  // 30 jours plus tard : la tâche des restitutions ne prélève pas les 140 € de l'ancienne commande.
  s.avancer(31);
  await s.tache('restitutions');
  const apres = (await commande(id)).restitution;
  assert.strictEqual(apres.statut, 'annulee');
  assert.strictEqual(apres.paiement, undefined, 'aucun prélèvement de matériel');
});

test('celui qui a payé rejoint la famille installée par un autre : responsable aussi, le propriétaire ne change pas', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const { fid } = await familleAbonnee(paul, julie);
  let fam = await famille(fid);
  assert.strictEqual(fam.createdBy, julie.uid);
  assert.ok(!(fam.admins || []).includes(paul.uid), 'Paul n\'est pas encore dans la famille');
  await a.rejoindre(paul, fid);
  await s.calme();
  fam = await famille(fid);
  assert.ok(fam.admins.includes(paul.uid), 'Paul, qui paie, est responsable');
  assert.strictEqual(fam.createdBy, julie.uid, 'Julie, qui a installé, reste propriétaire');
  assert.ok(s.notifications.some((n) => n.type === 'alerte' && n.fid === fid && /a rejoint/.test(n.titre)), 'notification « a rejoint » avec la famille');
});

test('l\'acheteur installe lui-même une tablette pas reconnue : sa commande est reliée par son e-mail, sans code', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  const t = { serie: 'INCONNUE2', tabletUid: 'tablette-inconnue2', callsUid: 'appels-inconnue2' };
  await a.afficherCode(t);
  s.boite.length = 0;
  const fid = await a.installer(paul, t);
  const fam = await famille(fid);
  assert.strictEqual(fam.abonnement.statut, 'actif');
  assert.strictEqual((await commande(id)).fid, fid);
  assert.deepStrictEqual(mailsA('contact@mapapote.fr'), [], 'rien à faire pour Tanguy');
});

test('deux commandes en attente au même e-mail : rien n\'est relié tout seul, Tanguy est prévenu', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  await a.commanderEtPayer({ email: paul.email });
  await a.commanderEtPayer({ email: paul.email });
  const t = { serie: 'INCONNUE3', tabletUid: 'tablette-inconnue3', callsUid: 'appels-inconnue3' };
  await a.afficherCode(t);
  s.boite.length = 0;
  const fid = await a.installer(paul, t);
  const fam = await famille(fid);
  assert.strictEqual(fam.abonnement.statut, 'installation', 'rien de bloqué pendant 48 h');
  assert.ok(fam.abonnement.toleranceJusqua);
  assert.ok(mailsA('contact@mapapote.fr').some((m) => /sans commande reliée/.test(m)));
});

test('colis jamais retiré : Tanguy prévenu par e-mail à J+20, « Colis revenu » annule, rembourse et rend la tablette au stock', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(id, t);
  s.boite.length = 0;
  s.avancer(20.1);
  await s.tache('rappelsJumelage');
  assert.ok(mailsA('contact@mapapote.fr').some((m) => /pas installée 20 jours/.test(m)), 'e-mail à Tanguy');
  await s.tache('rappelsJumelage');
  assert.strictEqual(mailsA('contact@mapapote.fr').length, 1, 'une seule fois');

  await assert.rejects(s.appeler('gestionAnnulerCommande', { commande: id }, a.TANGUY), /déjà partie/);
  const r = await s.appeler('gestionAnnulerCommande', { commande: id, colisRevenu: true }, a.TANGUY);
  assert.strictEqual(r.rembourse, 6000);
  await s.calme();
  assert.strictEqual(s.stripe.rembourse(id), 6000);
  const c = await commande(id);
  assert.strictEqual(c.expedition, 'annulee');
  assert.strictEqual(c.annulation, 'colis-revenu');
  const fiche = await s.lire(`stock/${t.fiche}`);
  assert.strictEqual(fiche.etat, 'revenue', 'à vérifier avant de repartir');
  assert.strictEqual(fiche.commande, null);
  assert.ok(mailsA(paul.email).some((m) => /annul/i.test(m)), 'le client est prévenu');
});

test('appel ou SOS qui n\'atteint aucun téléphone : tous les proches prévenus par e-mail', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  await a.afficherCode(t);
  const fid = await a.installer(julie, t);
  await s.appeler('gestionFamilleOfferte', { fid, offerte: true }, a.TANGUY);
  await a.rejoindre(paul, fid);
  await s.calme();
  s.reglages.telephones = false;
  s.boite.length = 0;

  const cid = await a.appelerDepuisLaTablette(t, { sos: 1 });
  await s.calme();
  assert.deepStrictEqual(mailsA(julie.email), ['SOS : Mamie Emma a appelé, aucun téléphone n\'a sonné']);
  assert.deepStrictEqual(mailsA(paul.email), ['SOS : Mamie Emma a appelé, aucun téléphone n\'a sonné']);
  await s.db.doc(`families/${fid}/calls/${cid}`).update({ state: 'missed' });
  await s.calme();
  const cid2 = await a.appelerDepuisLaTablette(t, { sos: 2 });
  await s.calme();
  assert.strictEqual(mailsA(paul.email).length, 1, 'pas de 2e e-mail au 2e essai, qui suit de près');
  await s.db.doc(`families/${fid}/calls/${cid2}`).update({ state: 'missed' });
  await s.calme();
  assert.strictEqual(mailsA(paul.email).length, 2, 'l\'alerte SOS sans réponse part aussi par e-mail');

  s.boite.length = 0;
  await a.appelerDepuisLaTablette(t, { vers: julie });
  await s.calme();
  assert.deepStrictEqual(mailsA(julie.email), ['Mamie Emma a appelé, aucun téléphone n\'a sonné']);
  assert.deepStrictEqual(mailsA(paul.email), [], 'appel à Julie seulement');
});

test('pause hospitalisation : aucune alerte de tablette pendant la pause', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid, t } = await familleAbonnee(paul);
  await premierMoisPasse(id);
  const tablette = s.db.doc(`families/${fid}/members/${t.tabletUid}`);
  await tablette.update({ lastOnline: new Date(Date.now() - 3 * 3600e3) });
  s.notifications.length = 0;
  await s.tache('alertesTablettes');
  assert.strictEqual(alertes().length, 1, 'tablette muette depuis 3 h : alerte');
  assert.match(alertes()[0].titre, /ne répond plus/);

  // La tablette revient, puis Mamie est hospitalisée : Tanguy met la commande en pause, la tablette reste éteinte.
  await tablette.update({ lastOnline: new Date(Date.now()) });
  await s.tache('alertesTablettes');
  await s.appeler('pauseHospitalisation', { commande: id, jusqua: Date.now() + 10 * s.JOUR }, a.TANGUY);
  await tablette.update({ lastOnline: new Date(Date.now() - 3 * 3600e3) });
  s.notifications.length = 0;
  await s.tache('alertesTablettes');
  assert.strictEqual(alertes().length, 0, 'en pause : rien');

  s.avancer(11);
  await s.tache('alertesTablettes');
  assert.strictEqual(alertes().length, 1, 'pause finie : les alertes reprennent');
  const { alertes: journal } = await s.appeler('gestionDonnees', {}, a.TANGUY);
  assert.deepStrictEqual(journal.map((x) => x.genre), ['silence', 'silence'], 'deux alertes comptées pour l\'admin, aucune pendant la pause');
});

test('« N téléphones reçoivent les appels » : le serveur note sur chaque proche s\'il a un jeton', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const t = await a.tablettePreparee();
  await a.afficherCode(t);
  const fid = await a.installer(julie, t);
  const membre = s.db.doc(`families/${fid}/members/${julie.uid}`);
  assert.strictEqual((await membre.get()).get('recoitAppels'), undefined);
  const jetons = membre.collection('private').doc('push');
  await jetons.set({ tokens: ['jeton-navigateur'] });
  await s.calme();
  assert.strictEqual((await membre.get()).get('recoitAppels'), true);
  await jetons.set({ tokens: [], natifs: [] });
  await s.calme();
  assert.strictEqual((await membre.get()).get('recoitAppels'), false, 'plus de jeton : plus de téléphone');
  await jetons.set({ natifs: ['jeton-android'] });
  await s.calme();
  assert.strictEqual((await membre.get()).get('recoitAppels'), true);
});

test('pas vue depuis deux jours : une alerte aux responsables, pas de rappel tant qu\'elle n\'est pas revue', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const marc = await s.compte('Marc', 'marc@exemple.fr');
  const { fid, t } = await familleAbonnee(paul, julie);
  await a.rejoindre(marc, fid);
  await s.calme();
  const tablette = s.db.doc(`families/${fid}/members/${t.tabletUid}`);
  const H = 3600e3;
  const enLigne = () => tablette.update({ lastOnline: new Date(Date.now()) });

  await tablette.update({ lastSeen: new Date(Date.now() - 30 * H) });
  await enLigne();
  s.notifications.length = 0;
  await s.tache('alerteMatin');
  assert.strictEqual(alertes().length, 0, 'vue hier : rien');

  s.avancer(1);
  await enLigne();
  await s.tache('alerteMatin');
  assert.strictEqual(alertes().length, 1, 'plus de 48 h : alerte');
  assert.match(alertes()[0].titre, /pas été vue depuis deux jours/);
  assert.deepStrictEqual(alertes()[0].uids, [julie.uid], 'aux responsables seulement, pas à Marc');
  s.avancer(1);
  await enLigne();
  await s.tache('alerteMatin');
  assert.strictEqual(alertes().length, 1, 'le lendemain : pas de rappel, même épisode');

  // Revue, puis de nouveau absente trois jours : nouvel épisode.
  await tablette.update({ lastActive: new Date(Date.now()) });
  await s.tache('alerteMatin');
  assert.strictEqual(alertes().length, 1);
  s.avancer(3);
  await enLigne();
  await s.tache('alerteMatin');
  assert.strictEqual(alertes().length, 2, 'nouvel épisode : nouvelle alerte');

  // Tablette hors ligne : « ne répond plus » s'en charge, pas d'alerte « pas vue » en plus.
  await tablette.update({ lastActive: new Date(Date.now()) });
  s.avancer(3);
  await s.tache('alerteMatin');
  assert.strictEqual(alertes().length, 2, 'hors ligne : rien');
});

test('tablette remise en main propre : au retour, la famille choisit main propre ou Mondial Relay', async () => {
  await s.db.doc('gestion/reglages').set({ expediteur: { nom: 'Papote', adresse: '1 rue de test', cp: '07000', ville: 'Privas' } }, { merge: true });
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await familleAbonnee(paul);
  await premierMoisPasse(id);
  // Arrivée colis : le retour en main propre n'est pas proposé.
  await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  assert.strictEqual((await s.appeler('finDeContrat', { fid }, paul)).mainPropre, false);
  await assert.rejects(s.appeler('renvoyerTablette', { fid, mode: 'main' }, paul), /arrivée par colis/);
  await assert.rejects(s.appeler('renvoyerTablette', { fid, mode: 'pigeon' }, paul), /Choix de retour inconnu/);
  await s.appeler('annulerResiliation', { fid }, paul);
  await s.calme();

  // Remise en main propre (comme EJ4N : pas d'adresse de livraison).
  await s.db.doc(`commandes/${id}`).update({ remise: 'main-propre', livraison: null });
  s.boite.length = 0;
  await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  const arret = s.boite.find((m) => m.a === paul.email && /résiliation/i.test(m.sujet));
  assert.match(arret.texte, /« Par Mondial Relay »/, 'Mondial Relay toujours proposé, nommé comme le bouton de l\'appli');
  assert.match(arret.texte, /En main propre/, 'et la main propre aussi');
  const fin = await s.appeler('finDeContrat', { fid }, paul);
  assert.strictEqual(fin.mainPropre, true);
  assert.strictEqual(fin.adresse, false);
  assert.strictEqual(fin.rendreEnMain, false);

  s.boite.length = 0;
  assert.deepStrictEqual(await s.appeler('renvoyerTablette', { fid, mode: 'main' }, paul), { main: true });
  assert.deepStrictEqual(await s.appeler('renvoyerTablette', { fid, mode: 'main' }, paul), { main: true }, 'touché deux fois');
  await s.calme();
  const avisPapote = s.boite.filter((m) => m.a === 'contact@mapapote.fr' && /main propre/.test(m.sujet));
  assert.strictEqual(avisPapote.length, 1, 'Papote prévenu une seule fois');
  assert.match(avisPapote[0].texte, /paul@exemple\.fr/);
  assert.match(avisPapote[0].texte, /Tablette rendue/);
  assert.strictEqual((await s.appeler('finDeContrat', { fid }, paul)).rendreEnMain, true);
  assert.strictEqual(s.sendcloud.colis.size, 0, 'pas d\'étiquette payée');

  // Elle change d'avis : Mondial Relay reste possible, avec son adresse.
  const qr = await s.appeler('renvoyerTablette', { fid, adresse: { rue: '8 rue des Lilas', cp: '07000', ville: 'Privas' } }, paul);
  assert.ok(qr.qr);
  // Tanguy la récupère : « Tablette rendue » clôt comme pour un colis.
  await s.appeler('tabletteRendue', { commande: id }, a.TANGUY);
  await s.calme();
  assert.strictEqual((await commande(id)).restitution.statut, 'rendue');
});
