// Retour de la tablette, gestes humains (Tanguy, 03/11) : « Je renvoie la tablette » touché deux fois, Sendcloud
// en panne puis un nouvel essai, reprise par Papote pendant un retour anticipé (colis pas encore déposé, ou déjà
// parti), tablette rendue avant la date d'arrêt, main propre notée par Papote puis Mondial Relay quand même, tâche
// des restitutions relancée. La famille n'a jamais que Mondial Relay ; seul Papote note la main propre.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, mailsA, commande } = require('./commun');

brancher();

const famille = (fid) => s.lire(`families/${fid}`);
const abo = (id) => s.stripe.etat.abonnements.get(id);
const preleveMateriel = () => [...s.stripe.etat.paiements.values()].filter((p) => /non rendu/.test(p.description || ''));
const MAIL_QR = 'Votre QR code pour nous rendre la tablette';

// Famille abonnée depuis plus d'un mois (premier mois prélevé), adresse de Papote renseignée : { id, fid, t }.
async function familleAbonnee(acheteur) {
  await s.db.doc('gestion/reglages').set({ expediteur: { nom: 'Papote', adresse: '1 rue de test', cp: '07000', ville: 'Privas' } }, { merge: true });
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: acheteur.email });
  await a.preparerEtEnvoyer(id, t);
  s.avancer(2);
  await a.afficherCode(t);
  const fid = await a.installer(acheteur, t);
  s.avancer(31);
  s.stripe.finirEssai(id);
  await s.calme();
  assert.strictEqual((await famille(fid)).abonnement.statut, 'actif');
  return { id, fid, t };
}

// Arrêt demandé, date d'arrêt passée : la tablette est attendue en retour. { id, fid, t, le }.
async function finDeContrat(paul) {
  const { id, fid, t } = await familleAbonnee(paul);
  const { le } = await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  s.avancer((le - Date.now()) / s.JOUR + 0.1);
  s.stripe.arreterALaDate(id);
  await s.calme();
  assert.strictEqual((await commande(id)).restitution.statut, 'attendue');
  return { id, fid, t, le };
}

// Arrêt demandé, la famille renvoie la tablette sans attendre la date (retour anticipé) : QR code créé. { id, fid, le, colis }.
async function retourAnticipe(paul) {
  const { id, fid } = await familleAbonnee(paul);
  const { le } = await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  const qr = await s.appeler('renvoyerTablette', { fid }, paul);
  assert.ok(qr.qr, 'QR code Mondial Relay');
  await s.calme();
  const r = (await commande(id)).restitution;
  assert.strictEqual(r.statut, 'attendue');
  assert.strictEqual(r.anticipe, true);
  assert.strictEqual(s.sendcloud.colis.size, 1);
  return { id, fid, le, colis: [...s.sendcloud.colis.values()][0] };
}

test('« Je renvoie la tablette » touché deux fois en même temps : un seul QR code payé, un seul e-mail ; le 3e appui rend le même', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await finDeContrat(paul);
  s.boite.length = 0;
  const deux = await Promise.allSettled([
    s.appeler('renvoyerTablette', { fid }, paul),
    s.appeler('renvoyerTablette', { fid }, paul),
  ]);
  await s.calme();
  const reussis = deux.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  assert.ok(reussis.length >= 1, JSON.stringify(deux));
  for (const r of deux.filter((x) => x.status === 'rejected')) assert.match(r.reason.message, /en cours de création/, 'le second appui attend le premier');
  assert.strictEqual(s.sendcloud.colis.size, 1, 'une seule étiquette payée chez Sendcloud');
  const c = await commande(id);
  assert.ok(c.restitution.qr && c.restitution.etiquette);
  assert.ok(reussis.every((r) => r.etiquette === c.restitution.etiquette), 'le même QR code pour chaque appui qui répond');
  assert.deepStrictEqual(mailsA(paul.email).filter((m) => m === MAIL_QR), [MAIL_QR], 'un seul e-mail avec le QR code');

  // Il touche encore le bouton plus tard : le même QR code, rien de neuf.
  const encore = await s.appeler('renvoyerTablette', { fid }, paul);
  await s.calme();
  assert.deepStrictEqual(encore, { etiquette: c.restitution.etiquette, qr: c.restitution.qr });
  assert.strictEqual(s.sendcloud.colis.size, 1);
  assert.strictEqual(mailsA(paul.email).filter((m) => m === MAIL_QR).length, 1);
});

test('Sendcloud en panne au moment du QR code : rien de payé, le bouton se débloque, le nouvel essai crée le QR code', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await finDeContrat(paul);
  s.boite.length = 0;
  s.sendcloud.panne = true;
  await assert.rejects(s.appeler('renvoyerTablette', { fid }, paul), /Réessayez dans un instant/);
  await s.calme();
  // Papote le voit dans les journaux (logger.error) : attendu ici.
  assert.ok(s.erreurs.length && s.erreurs.every((e) => /QR code de retour non créé/.test(e)), JSON.stringify(s.erreurs));
  s.erreurs.length = 0;
  let c = await commande(id);
  assert.strictEqual(c.restitution.statut, 'attendue', 'toujours attendue');
  assert.strictEqual(c.restitution.qrDemandeLe, undefined, 'pas bloqué deux minutes après une panne');
  assert.strictEqual(c.restitution.etiquette, undefined);
  assert.strictEqual(s.sendcloud.colis.size, 0);
  assert.deepStrictEqual(mailsA(paul.email).filter((m) => m === MAIL_QR), []);

  // Sendcloud revient, Paul réessaie aussitôt.
  s.sendcloud.panne = false;
  const qr = await s.appeler('renvoyerTablette', { fid }, paul);
  await s.calme();
  assert.ok(qr.qr);
  c = await commande(id);
  assert.strictEqual(c.restitution.qr, qr.qr);
  assert.strictEqual(s.sendcloud.colis.size, 1);
  assert.deepStrictEqual(mailsA(paul.email).filter((m) => m === MAIL_QR), [MAIL_QR]);
});

test('retour anticipé, colis pas encore déposé : seul Papote peut reprendre l\'abonnement ; le QR code est annulé, plus rien à rendre ni à prélever', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid, colis } = await retourAnticipe(paul);
  s.boite.length = 0;
  // La famille ne peut pas reprendre seule une fois le retour commencé : elle écrit à Papote.
  await assert.rejects(s.appeler('annulerResiliation', { fid }, paul), /écrivez-nous/);
  assert.strictEqual(colis.annule, false);

  assert.deepStrictEqual(await s.appeler('annulerResiliation', { fid, commande: id }, a.TANGUY), { ok: true });
  await s.calme();
  assert.strictEqual(colis.annule, true, 'QR code annulé chez Sendcloud (remboursé)');
  let c = await commande(id);
  assert.strictEqual(c.restitution, undefined, 'plus de retour attendu');
  assert.strictEqual(c.retourAnnule.par, 'papote');
  assert.strictEqual(c.etiquettes.retour, undefined);
  assert.strictEqual(c.etiquettes.annulees.length, 1);
  assert.strictEqual(abo(id).cancel_at, null, 'plus d\'arrêt chez Stripe');
  const fam = await famille(fid);
  assert.strictEqual(fam.abonnement.statut, 'actif');
  assert.ok(!fam.abonnement.resiliationLe);
  assert.deepStrictEqual(mailsA(paul.email), ['Votre abonnement Papote continue']);

  // Double clic de Tanguy : rien de plus (pas de 2e annulation, pas de 2e e-mail).
  assert.deepStrictEqual(await s.appeler('annulerResiliation', { fid, commande: id }, a.TANGUY), { ok: true });
  await s.calme();
  assert.strictEqual((await commande(id)).etiquettes.annulees.length, 1);
  assert.strictEqual(mailsA(paul.email).length, 1);
  // Vieil onglet de la famille : « Je renvoie la tablette » n'a plus lieu d'être.
  await assert.rejects(s.appeler('renvoyerTablette', { fid }, paul), /pas de tablette à nous renvoyer/);
  assert.strictEqual(s.sendcloud.colis.size, 1, 'aucun nouveau QR code payé');
  const fin = await s.appeler('finDeContrat', { fid }, paul);
  assert.strictEqual(fin.restitution, null);
  assert.strictEqual(fin.retourAnticipe, false);

  // Bien après l'ancienne date limite : aucun rappel, aucun matériel prélevé.
  s.avancer(70);
  await s.tache('restitutions');
  await s.calme();
  c = await commande(id);
  assert.strictEqual(c.restitution, undefined);
  assert.deepStrictEqual(preleveMateriel(), []);
  assert.strictEqual(mailsA(paul.email).length, 1);
});

test('retour anticipé, colis déjà déposé au point relais : la reprise est refusée, même à Papote ; le retour continue', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid, le, colis } = await retourAnticipe(paul);
  colis.statut = 3; // « En route » chez Mondial Relay
  const avant = await commande(id);
  s.boite.length = 0;
  await assert.rejects(s.appeler('annulerResiliation', { fid, commande: id }, a.TANGUY), /déjà déposé/);
  await s.calme();
  assert.strictEqual(colis.annule, false, 'le colis en route n\'est pas annulé');
  const c = await commande(id);
  assert.deepStrictEqual(c.restitution, avant.restitution, 'le retour n\'a pas bougé');
  assert.deepStrictEqual(c.etiquettes, avant.etiquettes);
  assert.strictEqual(abo(id).cancel_at, Math.ceil(le / 1000), 'l\'arrêt reste prévu');
  assert.deepStrictEqual(s.boite, []);
});

test('résiliée, colis de retour déjà déposé : la famille ne peut pas payer une reprise ; avant le dépôt, elle peut', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await finDeContrat(paul);
  await s.appeler('renvoyerTablette', { fid }, paul);
  await s.calme();
  const colis = [...s.sendcloud.colis.values()][0];
  assert.ok(colis, 'QR code de retour créé');
  // Pas encore déposé : la reprise payante reste possible.
  const { url } = await s.appeler('creerPaiement', { fid, formule: 'wifi', tablette: 'incluse' }, paul);
  assert.ok(url);
  // Déposé au point relais : refusé, message clair, rien ne change.
  colis.statut = 3;
  const avant = await commande(id);
  const sessions = s.stripe.etat.sessions.size;
  await assert.rejects(s.appeler('creerPaiement', { fid, formule: 'wifi', tablette: 'incluse' }, paul), /déjà en route vers Papote/);
  assert.strictEqual(s.stripe.etat.sessions.size, sessions, 'aucune page de paiement créée');
  assert.deepStrictEqual((await commande(id)).restitution, avant.restitution, 'le retour continue');
});

test('tablette rendue avant la date d\'arrêt (retour anticipé) : à l\'arrêt, rien de nouveau à rendre, ni rappel ni 140 € ; « Garder » refusé', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid, le } = await retourAnticipe(paul);
  // Le colis arrive chez Papote : « Matériel reçu », rien ne manque.
  assert.deepStrictEqual(await s.appeler('tabletteRendue', { commande: id, manquants: [] }, a.TANGUY), { ok: true, montant: 0, erreur: null });
  await s.calme();
  assert.strictEqual((await commande(id)).restitution.statut, 'rendue');
  assert.ok(mailsA(paul.email).some((m) => /reçu/i.test(m)), 'Paul sait que la tablette est arrivée');
  // Tablette déjà rendue : l'abonnement ne se reprend plus (rien à rattacher).
  await assert.rejects(s.appeler('annulerResiliation', { fid, commande: id }, a.TANGUY), /ne peut plus être repris/);
  s.boite.length = 0;

  // La date d'arrêt arrive : Stripe arrête, le mois en cours est dû (pas de prorata), mais rien à rendre.
  s.avancer((le - Date.now()) / s.JOUR + 0.1);
  s.stripe.arreterALaDate(id);
  await s.calme();
  let c = await commande(id);
  assert.strictEqual(c.restitution.statut, 'rendue', 'le retour n\'est pas recréé');
  assert.strictEqual(c.dernierMois.montant, 2500);
  assert.strictEqual((await famille(fid)).abonnement.statut, 'resilie');
  assert.ok(!s.boite.some((m) => m.a === paul.email && /rendre la tablette/i.test(m.sujet)), 'pas de mode d\'emploi du retour');
  s.avancer(40);
  await s.tache('restitutions');
  await s.calme();
  c = await commande(id);
  assert.strictEqual(c.restitution.statut, 'rendue');
  assert.deepStrictEqual(preleveMateriel(), [], 'aucun matériel prélevé');
  assert.ok(!s.boite.some((m) => m.a === paul.email && /Pensez à nous rendre|non rendue/.test(m.sujet)), 'ni rappel ni avis de prélèvement');
});

test('main propre notée par Papote, puis la famille passe quand même par Mondial Relay : un seul retour, clos à la réception, rien prélevé', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await finDeContrat(paul);
  // Tanguy prévoit d'aller la chercher : seul l'admin le note.
  await assert.rejects(s.appeler('gestionCommande', { commande: id, action: 'retourEnMain', main: true }, paul), /administrateur/);
  await s.appeler('gestionCommande', { commande: id, action: 'retourEnMain', main: true }, a.TANGUY);
  assert.ok((await commande(id)).restitution.mainPropreLe);
  // L'appli de la famille ne parle jamais de main propre : seulement Mondial Relay.
  const fin = await s.appeler('finDeContrat', { fid }, paul);
  assert.deepStrictEqual(Object.keys(fin.restitution).sort(), ['avant', 'etiquette', 'qr', 'statut']);
  assert.strictEqual(fin.mainPropre, undefined);
  assert.strictEqual(fin.adresse, true);
  // Paul n'a pas attendu Tanguy : il crée le QR code et dépose le colis.
  const qr = await s.appeler('renvoyerTablette', { fid }, paul);
  await s.calme();
  assert.ok(qr.qr, 'Mondial Relay reste possible');
  assert.strictEqual(s.sendcloud.colis.size, 1);
  assert.ok(!s.boite.some((m) => m.a === paul.email && /main propre/i.test(m.texte)), 'aucun e-mail à la famille ne parle de main propre');
  // Le colis arrive : « Matériel reçu » clôt le retour, une seule fois.
  await s.appeler('tabletteRendue', { commande: id, manquants: [] }, a.TANGUY);
  await s.calme();
  await assert.rejects(s.appeler('tabletteRendue', { commande: id, manquants: [] }, a.TANGUY), /déjà noté rendu/);
  await assert.rejects(s.appeler('gestionCommande', { commande: id, action: 'retourEnMain', main: false }, a.TANGUY), /Aucune tablette attendue/);
  await assert.rejects(s.appeler('renvoyerTablette', { fid }, paul), /pas de tablette à nous renvoyer/);
  s.avancer(40);
  await s.tache('restitutions');
  await s.calme();
  assert.strictEqual((await commande(id)).restitution.statut, 'rendue');
  assert.deepStrictEqual(preleveMateriel(), []);
  assert.strictEqual(s.sendcloud.colis.size, 1);
});

test('tâche des restitutions relancée le même jour : un seul rappel, 140 € prélevés une fois, un seul avis ; « Matériel reçu » ensuite refusé, rien remboursé', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id } = await finDeContrat(paul);
  s.boite.length = 0;
  const RAPPEL = 'Pensez à nous rendre la tablette Papote';
  const AVIS = 'Tablette non rendue : le matériel a été prélevé';

  // 7 jours avant la limite : le rappel part une fois, même si la tâche repart (nouvel essai du serveur).
  s.avancer(24);
  await s.tache('restitutions');
  await s.tache('restitutions');
  await s.calme();
  assert.deepStrictEqual(mailsA(paul.email), [RAPPEL]);
  assert.deepStrictEqual(preleveMateriel(), [], 'rien prélevé avant la limite');

  // Limite passée : prélevé une fois, la tâche relancée ne prélève pas de nouveau.
  s.avancer(7);
  await s.tache('restitutions');
  await s.tache('restitutions');
  await s.calme();
  const c = await commande(id);
  assert.strictEqual(c.restitution.statut, 'facturee');
  assert.deepStrictEqual(preleveMateriel().map((p) => p.amount), [14000], '140 € une seule fois');
  assert.deepStrictEqual(mailsA(paul.email), [RAPPEL, AVIS]);

  // La tablette arrive enfin chez Papote : déjà prélevée, rien d'automatique (pas de remboursement hors des cas prévus).
  await assert.rejects(s.appeler('tabletteRendue', { commande: id, manquants: [] }, a.TANGUY), /déjà été prélevé/);
  await s.calme();
  assert.strictEqual((await commande(id)).restitution.statut, 'facturee');
  assert.strictEqual(s.stripe.etat.remboursements.length, 0);
});

test('tâche des restitutions lancée deux fois en même temps à la limite : la banque ne prélève les 140 € qu\'une fois', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id } = await finDeContrat(paul);
  s.boite.length = 0;
  s.avancer(31);
  await Promise.all([s.tache('restitutions'), s.tache('restitutions')]);
  await s.calme();
  const c = await commande(id);
  assert.strictEqual(c.restitution.statut, 'facturee');
  assert.deepStrictEqual(preleveMateriel().map((p) => p.amount), [14000], 'même clé d\'idempotence chez Stripe : un seul prélèvement');
  assert.strictEqual(c.restitution.paiement, preleveMateriel()[0].id);
  assert.deepStrictEqual(mailsA(paul.email).filter((m) => /non rendue/.test(m)), ['Tablette non rendue : le matériel a été prélevé'], 'un seul avis au client');
});
