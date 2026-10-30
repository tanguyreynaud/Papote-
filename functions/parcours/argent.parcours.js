// Audit des actions qui touchent l'argent ou un client (30/10/2026, après l'arrêt de l'abonnement de EJ4N-DVBA
// depuis la commande 8X9K-EB7T : deux commandes sur la même famille). Chaque scénario vérifie qu'une action vise
// exactement la bonne commande, le bon abonnement, la bonne famille, même avec deux commandes reliées à la même
// famille, un double clic ou un vieil onglet.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, commande } = require('./commun');

brancher();

const famille = (fid) => s.lire(`families/${fid}`);
const abo = (id) => s.stripe.etat.abonnements.get(id);

// Commande payée par `acheteur`, tablette envoyée puis installée par lui : { id, fid, t }.
async function familleAbonnee(acheteur) {
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: acheteur.email });
  await a.preparerEtEnvoyer(id, t);
  s.avancer(2);
  await a.afficherCode(t);
  const fid = await a.installer(acheteur, t);
  assert.strictEqual((await famille(fid)).abonnement.statut, 'actif');
  return { id, fid, t };
}

// Premier mois écoulé : l'abonnement est « active » chez Stripe, un mois prélevé.
async function premierMoisPasse(id) {
  s.avancer(31);
  s.stripe.finirEssai(id);
  await s.calme();
}

// Le cas 8X9K-EB7T / EJ4N-DVBA : une deuxième commande du même client, dont la tablette est reliée à la MÊME
// famille depuis l'appli (« Relier à la famille de Mamie »). Renvoie { fid, A, B, t1, t2 }.
async function deuxCommandes(paul) {
  const { id: A, fid, t: t1 } = await familleAbonnee(paul);
  const { abonnement: B } = await a.commanderEtPayer({ email: paul.email });
  assert.strictEqual((await commande(B)).fid, null, 'famille déjà abonnée : la 2e commande n\'est pas reliée toute seule');
  const t2 = await a.tablettePreparee();
  await a.preparerEtEnvoyer(B, t2);
  await a.afficherCode(t2);
  // L'appli famille réclame la tablette pour la famille existante, la tablette accepte (famille.js, form-pair-claim).
  await s.db.doc(`pairings/${t2.code}`).update({ status: 'claimed', fid, familyName: 'Mamie Emma', claimedBy: paul.uid, claimedName: 'Paul' });
  await s.calme();
  await s.db.doc(`pairings/${t2.code}`).update({ status: 'confirmed' });
  await s.calme();
  await a.entrerDansLaFamille(t2);
  const fam = await famille(fid);
  assert.strictEqual(fam.abonnement.stripeSubscriptionId, A, 'la famille garde son premier abonnement');
  assert.strictEqual(fam.abonnement.statut, 'actif');
  const b = await commande(B);
  assert.strictEqual(b.fid, fid, 'la 2e commande est reliée à la famille par sa tablette');
  assert.strictEqual(b.autreAbonnement, A, 'et notée « autre abonnement »');
  return { fid, A, B, t1, t2 };
}

test('deux commandes sur la même famille : l\'admin annule (30 jours) la commande ouverte, pas l\'abonnement que suit la famille', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { fid, A, B, t2 } = await deuxCommandes(paul);

  // Page de la commande B dans l'admin → « Annuler la commande (30 jours) » : la commande cliquée est transmise.
  const r = await s.appeler('retracter', { fid, commande: B }, a.TANGUY);
  await s.calme();
  assert.strictEqual(r.remboursement, 'au-retour');
  assert.strictEqual(r.montant, 6000, 'les 60 € de B seront remboursés au retour de sa tablette');
  const b = await commande(B);
  assert.ok(b.retractation, 'B est annulée');
  assert.strictEqual(b.restitution.statut, 'attendue', 'la tablette de B est à rendre');
  assert.strictEqual(abo(B).status, 'canceled', 'l\'abonnement B est arrêté chez Stripe');
  // A, l'abonnement que la famille suit, n'a pas bougé.
  assert.strictEqual(abo(A).status, 'trialing', 'A tourne toujours');
  const c = await commande(A);
  assert.strictEqual(c.retractation, undefined);
  assert.strictEqual(c.restitution, undefined);
  const fam = await famille(fid);
  assert.strictEqual(fam.abonnement.statut, 'actif');
  assert.strictEqual(fam.abonnement.stripeSubscriptionId, A);
  assert.strictEqual(s.stripe.rembourse(A), 0, 'rien de remboursé sur A');
  assert.strictEqual((await s.lire(`stock/${t2.fiche}`)).fid, fid, 'la tablette de B reste dans la famille jusqu\'au retour');

  // Un simple proche ne peut pas désigner une commande : réservé à l'admin.
  await assert.rejects(s.appeler('retracter', { fid, commande: A }, paul), /administrateur/);
  // Une commande qui n'est pas celle de la famille de la page (vieil onglet) : refusée.
  const { id: autre, fid: autreFid } = await familleAbonnee(await s.compte('Zoe', 'zoe@exemple.fr'));
  await assert.rejects(s.appeler('retracter', { fid, commande: autre }, a.TANGUY), /pas celle de cette famille/);
  assert.strictEqual(abo(autre).status, 'trialing');
  assert.strictEqual((await famille(autreFid)).abonnement.statut, 'actif');
});

test('deux commandes : la pause hospitalisation vise la commande ouverte, pas l\'autre', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { A, B } = await deuxCommandes(paul);
  await premierMoisPasse(A);
  s.stripe.finirEssai(B);
  await s.calme();
  await s.appeler('pauseHospitalisation', { commande: B, jusqua: Date.now() + 10 * s.JOUR }, a.TANGUY);
  await s.calme();
  assert.ok(abo(B).pause_collection, 'B en pause');
  assert.ok(!abo(A).pause_collection, 'A n\'est pas en pause');
  assert.ok((await commande(B)).pause);
  assert.strictEqual((await commande(A)).pause, undefined);
});

test('l\'abonnement suivi s\'arrête, l\'autre commande de la famille paie encore : la famille suit celle-là (pas de pause chez un client qui paie)', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { fid, A, B } = await deuxCommandes(paul);
  await premierMoisPasse(A);
  s.stripe.finirEssai(B);
  await s.calme();

  // Le client résilie dans l'appli : c'est A, l'abonnement que la famille suit, qui s'arrête à la fin du mois.
  const { le } = await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  assert.ok(abo(A).cancel_at, 'A : arrêt programmé');
  assert.ok(!abo(B).cancel_at, 'B : rien');
  s.avancer((le - Date.now()) / s.JOUR + 0.1);
  s.stripe.arreterALaDate(A);
  await s.calme();

  const fam = await famille(fid);
  assert.strictEqual(fam.abonnement.statut, 'actif', 'B paie encore : la famille n\'est pas en pause');
  assert.strictEqual(fam.abonnement.stripeSubscriptionId, B, 'la famille suit désormais B');
  assert.strictEqual(fam.abonnement.resiliationLe, null);
  const c = await commande(A);
  assert.strictEqual(c.restitution.statut, 'attendue', 'la tablette de A est à rendre');
  assert.strictEqual(c.dernierMois.statut, 'fait', 'le dernier mois de A est prélevé');
  assert.strictEqual((await commande(B)).autreAbonnement, null, 'B n\'est plus « à côté »');
  // Et ce qu'un statut « résiliée » à tort aurait permis est refusé.
  await assert.rejects(s.appeler('creerPaiement', { fid, formule: 'sim', tablette: 'incluse' }, paul), /déjà un abonnement/);
  await assert.rejects(s.appeler('gestionSupprimerFamille', { fid, nom: 'Mamie Emma' }, a.TANGUY), /en cours/);
});

test('supprimer une famille dont une commande est encore prélevée chez Stripe : refusé, même si la fiche famille dit « résiliée »', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { fid, B } = await deuxCommandes(paul);
  // Fiche famille fausse (ancien bogue, ou écriture à la main) : « résiliée » alors que B tourne chez Stripe.
  await s.db.doc(`families/${fid}`).update({ 'abonnement.statut': 'resilie' });
  await assert.rejects(s.appeler('gestionSupprimerFamille', { fid, nom: 'Mamie Emma' }, a.TANGUY), /abonnement Stripe en cours/);
  assert.ok((await famille(fid)), 'la famille est toujours là');
  assert.strictEqual(abo(B).status, 'trialing');
});

// Stripe répond au webhook AVANT que la fonction ait fini d'écrire dans la base (course réelle en ligne : le
// message « abonnement supprimé » arrive en une seconde). Ici : les événements sont livrés dès l'arrêt.
async function stripeRepondToutDeSuite(faire) {
  const cancel = s.stripe.api.subscriptions.cancel;
  s.stripe.api.subscriptions.cancel = async (...args) => {
    const r = await cancel(...args);
    while (s.stripe.etat.evenements.length) {
      const ev = s.stripe.etat.evenements.shift();
      const rep = await s.requete('stripeWebhook', { corps: ev, entetes: { 'stripe-signature': 'faux' } });
      assert.strictEqual(rep.statut, 200, `webhook ${ev.type}`);
    }
    return r;
  };
  try {
    return await faire();
  } finally {
    s.stripe.api.subscriptions.cancel = cancel;
  }
}

test('colis revenu, annulé par Tanguy après un mois prélevé : tout remboursé, pas de « dernier mois » même si Stripe répond avant la base', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(id, t);
  await premierMoisPasse(id);
  assert.strictEqual((await commande(id)).fid, null, 'jamais installée');

  const r = await stripeRepondToutDeSuite(() => s.appeler('gestionAnnulerCommande', { commande: id, colisRevenu: true }, a.TANGUY));
  await s.calme();
  assert.strictEqual(r.rembourse, 8500, '60 € de mise en service + le mois prélevé');
  const c = await commande(id);
  assert.strictEqual(c.expedition, 'annulee');
  assert.strictEqual(c.dernierMois, undefined, 'aucun dernier mois prélevé à un client dont le colis est revenu');
  assert.ok(![...s.stripe.etat.factures.values()].some((f) => f.metadata && f.metadata.dernierMois === '1'), 'aucune facture de dernier mois chez Stripe');
  assert.strictEqual(abo(id).status, 'canceled');
  assert.strictEqual(abo(id).metadata.annulation, 'colis-revenu');
  assert.strictEqual((await s.lire(`stock/${t.fiche}`)).etat, 'revenue');
});

// Fin de contrat avec la tablette à rendre : { id, fid }.
async function finDeContrat(paul) {
  const { id, fid } = await familleAbonnee(paul);
  await premierMoisPasse(id);
  const { le } = await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  s.avancer((le - Date.now()) / s.JOUR + 0.1);
  s.stripe.arreterALaDate(id);
  await s.calme();
  assert.strictEqual((await commande(id)).restitution.statut, 'attendue');
  await s.db.doc('gestion/reglages').set({ expediteur: { nom: 'Papote', adresse: '1 rue de test', cp: '07000', ville: 'Privas' } }, { merge: true });
  return { id, fid };
}

test('étiquette de retour : une seule étiquette payée par commande, même avec un double clic ou un vieil onglet', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await finDeContrat(paul);
  const r1 = await s.appeler('gestionEtiquette', { commande: id, sens: 'retour' }, a.TANGUY);
  assert.ok(r1.ok);
  assert.strictEqual(s.sendcloud.colis.size, 1);
  await assert.rejects(s.appeler('gestionEtiquette', { commande: id, sens: 'retour' }, a.TANGUY), /existe déjà/);
  assert.strictEqual(s.sendcloud.colis.size, 1, 'pas de 2e étiquette payée');
  // Le client, dans l'appli, reçoit la même étiquette.
  const qr = await s.appeler('renvoyerTablette', { fid }, paul);
  assert.strictEqual(qr.etiquette, r1.url);
  assert.strictEqual(s.sendcloud.colis.size, 1);
  // Après annulation de l'ancienne, une nouvelle est possible.
  await s.appeler('gestionAnnulerEtiquette', { commande: id, sens: 'retour' }, a.TANGUY);
  const r2 = await s.appeler('gestionEtiquette', { commande: id, sens: 'retour' }, a.TANGUY);
  assert.ok(r2.ok);
  assert.strictEqual(s.sendcloud.colis.size, 2);
  assert.strictEqual([...s.sendcloud.colis.values()].filter((c) => c.annule).length, 1);
  await s.calme();
});

test('« Matériel reçu » deux fois (double clic) : les éléments manquants ne sont prélevés qu\'une fois', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id } = await finDeContrat(paul);
  const r = await s.appeler('tabletteRendue', { commande: id, manquants: ['chargeur'] }, a.TANGUY);
  assert.deepStrictEqual(r, { ok: true, montant: 1000, erreur: null });
  await assert.rejects(s.appeler('tabletteRendue', { commande: id, manquants: ['chargeur'] }, a.TANGUY), /déjà noté rendu/);
  await assert.rejects(s.appeler('tabletteRendue', { commande: id, manquants: ['tablette'] }, a.TANGUY), /déjà noté rendu/);
  const preleves = [...s.stripe.etat.paiements.values()].filter((p) => /non rendu/.test(p.description || ''));
  assert.strictEqual(preleves.length, 1);
  assert.strictEqual(preleves[0].amount, 1000);
  await s.calme();
});

test('étiquette d\'envoi : pas deux étiquettes payées pour le même colis', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await s.db.doc('gestion/reglages').set({ expediteur: { nom: 'Papote', adresse: '1 rue de test', cp: '07000', ville: 'Privas' } }, { merge: true });
  // Le faux Sendcloud ne connaît que les retours : l'étiquette aller est simulée comme déjà créée.
  await s.db.doc(`commandes/${id}`).update({ 'etiquettes.aller': { colis: 42, suivi: 'MR42', url: 'https://etiquette/42', le: Date.now(), par: 'test' } });
  await assert.rejects(s.appeler('gestionEtiquette', { commande: id, sens: 'aller' }, a.TANGUY), /existe déjà/);
  assert.strictEqual(s.sendcloud.colis.size, 0);
});
