// Départ d'un client jusqu'à la famille suivante (audit du 11/11) : tablette revenue, remise à zéro, remise en stock,
// nuit, puis nouveau client ; ancien client qui veut reprendre ; ligne SIM suspendue ; réponse de Stripe perdue
// pendant le prélèvement du matériel non rendu.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, mailsA, commande } = require('./commun');

brancher();

const famille = (fid) => s.lire(`families/${fid}`);
const fiche = (t) => s.lire(`stock/${t.fiche}`);
const preleveMateriel = () => [...s.stripe.etat.paiements.values()].filter((p) => /non rendu/.test(p.description || ''));
const modifier = (t, champs) => s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs }, a.TANGUY);

// Famille abonnée, arrêt demandé, date d'arrêt passée : la tablette est attendue en retour. { id, fid, t }.
async function finDeContrat(paul) {
  await s.db.doc('gestion/reglages').set({ expediteur: { nom: 'Papote', adresse: '1 rue de test', cp: '07000', ville: 'Privas' } }, { merge: true });
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(id, t);
  s.avancer(2);
  await a.afficherCode(t);
  const fid = await a.installer(paul, t);
  s.avancer(31);
  s.stripe.finirEssai(id);
  await s.calme();
  const { le } = await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  s.avancer((le - Date.now()) / s.JOUR + 0.1);
  s.stripe.arreterALaDate(id);
  await s.calme();
  assert.strictEqual((await commande(id)).restitution.statut, 'attendue');
  return { id, fid, t };
}

// « Matériel reçu » dans l'admin (web/js/gestion.js, zoneMaterielRecu) : retour noté, fiche « Revenue ».
async function materielRecu(id, t) {
  await s.appeler('tabletteRendue', { commande: id, manquants: [] }, a.TANGUY);
  await modifier(t, { etat: 'revenue' });
  await s.calme();
}

test('tablette revenue : pas « En stock » sans remise à zéro confirmée ; la nuit ne la rend pas à son ancienne famille ; elle repart chez un nouveau client', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid, t } = await finDeContrat(paul);
  s.avancer(5);
  await materielRecu(id, t);
  await assert.rejects(modifier(t, { etat: 'en-stock' }), /Remettez d'abord la tablette à zéro/);
  assert.strictEqual((await fiche(t)).etat, 'revenue');
  await modifier(t, { etat: 'en-stock', remiseAZero: true });
  let f = await fiche(t);
  assert.strictEqual(f.etat, 'en-stock');
  assert.strictEqual(f.historique.at(-1).motif, 'remise à zéro faite');
  // L'ancien jumelage est clos : il ne sert plus ni au rattrapage de nuit, ni à une reprise « déjà installée ».
  const jumelages = (await s.db.collection('pairings').where('fid', '==', fid).get()).docs.map((d) => d.get('status'));
  assert.deepStrictEqual(jumelages, ['closed']);
  // Trois nuits en stock : toujours libre, toujours comptée par le site.
  for (let i = 0; i < 3; i++) {
    s.avancer(1);
    await s.tache('gestionAutomatique');
    await s.calme();
  }
  f = await fiche(t);
  assert.strictEqual(f.fid, null, 'pas reprise par l\'ancienne famille');
  assert.strictEqual(f.tabletUid, null);
  assert.strictEqual(f.etat, 'en-stock');
  assert.strictEqual((await s.requete('stockDisponible', {})).json.disponible, true, 'le site la compte en stock');
  // Nouvelle cliente : la tablette se relie à sa commande et part.
  const { abonnement: id2 } = await a.commanderEtPayer({ email: 'lea@exemple.fr', nom: 'Léa Durand' });
  await a.preparerEtEnvoyer(id2, t, '87654321');
  f = await fiche(t);
  assert.strictEqual(f.commande, id2);
  assert.strictEqual(f.etat, 'envoyee');
});

test('vieux jumelage resté « confirmed » (tablettes rendues avant ce correctif) : la nuit l\'ignore, la fiche reste libre', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid, t } = await finDeContrat(paul);
  s.avancer(5);
  await materielRecu(id, t);
  await modifier(t, { etat: 'en-stock', remiseAZero: true });
  // Comme avant le correctif : le jumelage de l'ancienne famille est encore « confirmed ».
  for (const d of (await s.db.collection('pairings').where('fid', '==', fid).get()).docs) await d.ref.update({ status: 'confirmed' });
  await s.calme();
  await s.db.doc(`stock/${t.fiche}`).update({ fid: null, tabletUid: null, callsUid: null });
  s.avancer(1);
  await s.tache('gestionAutomatique');
  await s.calme();
  assert.strictEqual((await fiche(t)).fid, null);
});

test('« Matériel reçu » noté mais fiche pas suivie (coupure) : la nuit la passe « Revenue » et la sort de sa famille', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid, t } = await finDeContrat(paul);
  s.avancer(5);
  await s.appeler('tabletteRendue', { commande: id, manquants: [] }, a.TANGUY);
  s.avancer(1);
  await s.tache('gestionAutomatique');
  await s.calme();
  const f = await fiche(t);
  assert.strictEqual(f.etat, 'revenue');
  assert.strictEqual(f.fid, null);
  assert.ok(!(await s.lire(`families/${fid}/members/${t.tabletUid}`)), 'plus dans la famille');
});

test('ancien client qui a rendu sa tablette et reprend Papote dans l\'appli : une vraie commande à préparer, jamais « déjà installée »', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid, t } = await finDeContrat(paul);
  s.avancer(5);
  await materielRecu(id, t);
  await modifier(t, { etat: 'en-stock', remiseAZero: true });
  s.avancer(3);
  const { url } = await s.appeler('creerPaiement', { fid, formule: 'sim' }, paul);
  const session = url.split('/').pop();
  const meta = s.stripe.etat.sessions.get(session).metadata;
  assert.strictEqual(meta.dejaInstallee, undefined, 'pas « déjà installée »');
  assert.ok(meta.reservation, 'une tablette du stock est mise de côté');
  const { abonnement } = s.stripe.payerSession(session, { email: paul.email, nom: 'Paul Martin' });
  await s.calme();
  assert.strictEqual((await commande(abonnement)).expedition, 'a-preparer', 'Papote la voit dans « À envoyer »');
});

test('tablette revenue dont la ligne SIM a été suspendue : l\'envoi au client suivant attend la réactivation', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, t } = await finDeContrat(paul);
  s.avancer(5);
  await materielRecu(id, t);
  await modifier(t, { etat: 'en-stock', remiseAZero: true });
  const { simId } = await fiche(t);
  await s.appeler('gestionSim', { action: 'modifier', id: simId, champs: { statut: 'suspendue' } }, a.TANGUY);
  const { abonnement: id2 } = await a.commanderEtPayer({ email: 'lea@exemple.fr', nom: 'Léa Durand' });
  await assert.rejects(a.preparerEtEnvoyer(id2, t, '87654321'), /suspendue : réactivez-la/);
  assert.strictEqual((await commande(id2)).expedition, 'a-preparer', 'rien n\'est parti');
  await s.appeler('gestionSim', { action: 'modifier', id: simId, champs: { statut: 'active' } }, a.TANGUY);
  await a.preparerEtEnvoyer(id2, t, '87654321');
  assert.strictEqual((await commande(id2)).expedition, 'envoyee');
});

// Stripe débite, mais la réponse n'arrive jamais (coupure réseau, serveur arrêté).
async function reponsePerdue(faire) {
  const vrai = s.stripe.api.paymentIntents.create;
  s.stripe.api.paymentIntents.create = async (...args) => { await vrai.apply(s.stripe.api.paymentIntents, args); throw new Error('socket hang up'); };
  try { await faire(); } finally { s.stripe.api.paymentIntents.create = vrai; }
}

test('140 € : Stripe débite mais la réponse se perd : retrouvé chez Stripe, noté prélevé, pas de mise en demeure ; remboursé au retour', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id } = await finDeContrat(paul);
  s.boite.length = 0;
  s.avancer(31);
  await reponsePerdue(() => s.tache('restitutions'));
  await s.calme();
  let c = await commande(id);
  assert.strictEqual(c.restitution.statut, 'facturee');
  assert.strictEqual(c.restitution.paiement, preleveMateriel()[0].id);
  assert.deepStrictEqual(preleveMateriel().map((p) => p.amount), [14000]);
  assert.ok(!mailsA(paul.email).some((m) => /Mise en demeure/.test(m)), 'pas de mise en demeure à un client débité');
  // Les nuits suivantes ne prélèvent rien de plus.
  s.avancer(1);
  await s.tache('restitutions');
  s.avancer(1);
  await s.tache('restitutions');
  assert.strictEqual(preleveMateriel().length, 1);
  await s.appeler('tabletteRendue', { commande: id, manquants: [] }, a.TANGUY);
  await s.calme();
  c = await commande(id);
  assert.strictEqual(c.restitution.statut, 'rendue');
  assert.deepStrictEqual(s.stripe.etat.remboursements.map((r) => r.amount), [14000]);
});

test('140 € : serveur arrêté juste après avoir noté la tentative : le lendemain, un seul prélèvement, noté', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id } = await finDeContrat(paul);
  s.avancer(31);
  // Tentative notée, rien d'autre (arrêt en plein milieu) : Stripe n'a rien reçu.
  await s.db.doc(`commandes/${id}`).update({ 'restitution.prelevementTenteLe': s.Timestamp.fromMillis(Date.now()) });
  await s.tache('restitutions');
  assert.deepStrictEqual(preleveMateriel(), [], 'moins d\'une heure après : on n\'y touche pas (tâche en double)');
  s.avancer(1);
  await Promise.all([s.tache('restitutions'), s.tache('restitutions')]);
  await s.calme();
  assert.deepStrictEqual(preleveMateriel().map((p) => p.amount), [14000]);
  assert.strictEqual((await commande(id)).restitution.statut, 'facturee');
});

test('140 € : carte refusée : toujours « refusé », mise en demeure et alerte à Papote, rien de prélevé', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id } = await finDeContrat(paul);
  s.stripe.etat.clients.get((await commande(id)).stripeCustomerId).carteExpiree = true;
  s.boite.length = 0;
  s.avancer(31);
  await s.tache('restitutions');
  await s.calme();
  assert.strictEqual((await commande(id)).restitution.statut, 'echec');
  assert.deepStrictEqual(preleveMateriel(), []);
  assert.ok(mailsA(paul.email).some((m) => /Mise en demeure/.test(m)));
});
