// Scénarios croisés (Tanguy, 30/10 : « il y a d'autres scénarios qui pourraient faire un problème ? ») : une tablette
// qui revient puis repart chez un autre client, deux responsables ou deux onglets qui agissent en même temps, des
// messages Stripe reçus en double ou dans le désordre. Chaque scénario vérifie qu'il ne reste aucun lien faux, qu'aucune
// action n'est faite deux fois et que la famille suit toujours l'état réel chez Stripe.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, mailsA, commande } = require('./commun');

brancher();

const famille = (fid) => s.lire(`families/${fid}`);
const abo = (id) => s.stripe.etat.abonnements.get(id);
const tablettesDe = async (fid) => (await s.db.collection(`families/${fid}/members`).where('role', '==', 'tablette').get()).docs.map((d) => d.id).sort();

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

async function premierMoisPasse(id) {
  s.avancer(31);
  s.stripe.finirEssai(id);
  await s.calme();
}

// Abonnement arrêté par le client, fin de période passée : la tablette est attendue en retour.
async function finDeContrat(paul) {
  const { id, fid, t } = await familleAbonnee(paul);
  await premierMoisPasse(id);
  const { le } = await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  s.avancer((le - Date.now()) / s.JOUR + 0.1);
  s.stripe.arreterALaDate(id);
  await s.calme();
  assert.strictEqual((await commande(id)).restitution.statut, 'attendue');
  return { id, fid, t };
}

// ---------- Une tablette qui revient puis repart ----------

test('tablette revenue puis repartie chez un autre client : plus aucun lien avec l\'ancienne famille, aucun appel qui s\'y perd', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid, t } = await finDeContrat(paul);
  assert.deepStrictEqual(await tablettesDe(fid), [t.callsUid, t.tabletUid].sort());
  // Le colis revient : « Matériel reçu » dans l'admin, puis la tablette passe « revenue » (web/js/gestion.js, materielRecu).
  const r = await s.appeler('tabletteRendue', { commande: id, manquants: [] }, a.TANGUY);
  assert.strictEqual(r.ok, true);
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { etat: 'revenue' } }, a.TANGUY);
  await s.calme();
  let fiche = await s.lire(`stock/${t.fiche}`);
  assert.strictEqual(fiche.etat, 'revenue');
  assert.strictEqual(fiche.fid, null, 'la fiche ne pointe plus vers l\'ancienne famille');
  assert.strictEqual(fiche.tabletUid, null, 'ni vers les anciens comptes de la tablette');
  assert.strictEqual(fiche.callsUid, null);
  assert.strictEqual(fiche.jumeleeLe, undefined);
  assert.deepStrictEqual(await tablettesDe(fid), [], 'l\'ancienne famille n\'a plus de tablette');
  assert.strictEqual((await commande(id)).fid, fid, 'l\'ancienne commande reste à l\'ancienne famille (historique)');
  // La tablette, pas encore remise à zéro, essaie encore d'appeler : personne ne sonne, aucun e-mail « aucun téléphone ».
  s.notifications.length = 0;
  s.boite.length = 0;
  await a.appelerDepuisLaTablette(t, { vers: paul });
  assert.strictEqual(s.notifications.length, 0, 'aucun téléphone de l\'ancienne famille ne sonne');
  assert.deepStrictEqual(s.boite, []);
  // Vérifiée, remise en stock, préparée pour Marie. Remise à zéro : la tablette a de nouveaux comptes et une nouvelle clé.
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { etat: 'en-stock' } }, a.TANGUY);
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { etat: 'preparee' } }, a.TANGUY);
  const marie = await s.compte('Marie', 'marie@exemple.fr');
  const { abonnement: B } = await a.commanderEtPayer({ email: marie.email, nom: 'Marie Durand' });
  const t2 = { ...t, tabletUid: `${t.tabletUid}-bis`, callsUid: `${t.callsUid}-bis`, code: null, fid: null };
  await s.db.collection('clesTablettes').doc('cle-bis').set({ serie: t.serie, tabletUid: t2.tabletUid, creeLe: s.FieldValue.serverTimestamp() });
  await a.preparerEtEnvoyer(B, t2);
  s.avancer(2);
  await a.afficherCode(t2);
  const fid2 = await a.installer(marie, t2);
  assert.notStrictEqual(fid2, fid);
  fiche = await s.lire(`stock/${t.fiche}`);
  assert.strictEqual(fiche.fid, fid2, 'la fiche suit la nouvelle famille');
  assert.strictEqual(fiche.tabletUid, t2.tabletUid);
  assert.strictEqual(fiche.callsUid, t2.callsUid);
  assert.strictEqual(fiche.commande, B);
  assert.strictEqual(fiche.etat, 'chez-client');
  assert.strictEqual((await commande(B)).fid, fid2, 'la nouvelle commande est reliée à la nouvelle famille');
  assert.strictEqual((await commande(id)).fid, fid, 'l\'ancienne commande n\'a pas bougé');
  assert.strictEqual((await famille(fid)).abonnement.statut, 'resilie');
  assert.strictEqual((await famille(fid2)).abonnement.statut, 'actif');
  assert.strictEqual((await famille(fid2)).abonnement.stripeSubscriptionId, B);
  assert.deepStrictEqual(await tablettesDe(fid), []);
  assert.deepStrictEqual(await tablettesDe(fid2), [t2.callsUid, t2.tabletUid].sort());
  // Un appel de la nouvelle tablette sonne chez Marie seulement.
  s.notifications.length = 0;
  await a.appelerDepuisLaTablette(t2, { vers: marie });
  assert.ok(s.notifications.every((n) => n.fid === fid2), 'rien ne part vers l\'ancienne famille');
});

// ---------- Deux responsables ou deux onglets en même temps ----------

test('deux responsables demandent l\'arrêt en même temps, puis l\'un garde pendant que l\'autre arrête : la famille suit Stripe, un seul e-mail par demande', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const { id, fid } = await familleAbonnee(paul, julie);
  // Paul (qui a payé) rejoint : responsable d'office.
  await a.rejoindre(paul, fid);
  await s.calme();
  assert.ok(((await famille(fid)).admins || []).includes(paul.uid), 'le payeur est responsable');
  await premierMoisPasse(id);
  s.boite.length = 0;
  const deux = await Promise.allSettled([
    s.appeler('resilierAbonnement', { fid }, paul),
    s.appeler('resilierAbonnement', { fid }, julie),
  ]);
  await s.calme();
  assert.deepStrictEqual(deux.map((r) => r.status), ['fulfilled', 'fulfilled']);
  assert.strictEqual(deux[0].value.le, deux[1].value.le, 'la même date de fin');
  assert.ok(abo(id).cancel_at, 'arrêt prévu chez Stripe');
  assert.ok((await famille(fid)).abonnement.resiliationLe, 'arrêt prévu sur la famille');
  assert.deepStrictEqual(mailsA(paul.email), ['Votre résiliation Papote est enregistrée'], 'un seul e-mail au client');
  // Julie garde pendant que Paul arrête de nouveau : quel que soit le dernier mot, la famille et Stripe disent la même chose.
  s.boite.length = 0;
  const croises = await Promise.allSettled([
    s.appeler('annulerResiliation', { fid }, julie),
    s.appeler('resilierAbonnement', { fid }, paul),
  ]);
  await s.calme();
  assert.ok(croises.every((r) => r.status === 'fulfilled'), JSON.stringify(croises));
  const fam = await famille(fid);
  assert.strictEqual(Boolean(fam.abonnement.resiliationLe), Boolean(abo(id).cancel_at), 'famille et Stripe d\'accord');
  assert.strictEqual(fam.abonnement.statut, 'actif');
  assert.ok(mailsA(paul.email).length <= 2, `au plus un e-mail par demande : ${mailsA(paul.email)}`);
});

test('deux onglets de l\'admin annulent la même commande en même temps : un seul remboursement, un seul e-mail', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  s.boite.length = 0;
  const deux = await Promise.allSettled([
    s.appeler('gestionAnnulerCommande', { commande: id }, a.TANGUY),
    s.appeler('gestionAnnulerCommande', { commande: id }, a.TANGUY),
  ]);
  await s.calme();
  assert.ok(deux.some((r) => r.status === 'fulfilled'), JSON.stringify(deux));
  assert.ok(deux.some((r) => r.status === 'rejected' && /déjà/.test(r.reason.message)), 'le second onglet est refusé');
  const c = await commande(id);
  assert.strictEqual(c.annulationEnCours, undefined);
  assert.strictEqual(c.expedition, 'annulee');
  assert.strictEqual(c.remboursement.statut, 'fait');
  assert.strictEqual(c.remboursement.montant, 6000);
  assert.deepStrictEqual(s.stripe.etat.remboursements.map((r) => r.amount), [6000], 'les 60 € rendus une seule fois');
  assert.strictEqual(abo(id).status, 'canceled');
  assert.strictEqual(mailsA(paul.email).length, 1, `un seul e-mail « commande annulée » : ${mailsA(paul.email)}`);
});

// ---------- Messages Stripe en double ou dans le désordre ----------

// Rejoue un événement déjà reçu, comme Stripe quand il n'a pas eu de réponse à temps.
const rejouer = (ev) => s.requete('stripeWebhook', { corps: ev, entetes: { 'stripe-signature': 'faux' } });

test('messages Stripe reçus en double puis dans le désordre : rien n\'est refait, la famille suit l\'état réel chez Stripe', async () => {
  // Chaque événement émis par le faux Stripe est gardé en copie pour être rejoué.
  const vus = [];
  const file = s.stripe.etat.evenements;
  const push = file.push.bind(file);
  file.push = (...evs) => { vus.push(...evs.map((e) => JSON.parse(JSON.stringify(e)))); return push(...evs); };
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid, t } = await familleAbonnee(paul);
  await premierMoisPasse(id);
  // rev et majLe bougent à chaque relecture de Stripe : le reste doit rester identique.
  const sansHorodatage = (fam) => ({ ...fam, rev: null, abonnement: { ...fam.abonnement, majLe: null } });
  const avant = { mails: s.boite.length, commande: await commande(id), famille: sansHorodatage(await famille(fid)), stock: await s.lire(`stock/${t.fiche}`) };
  assert.ok(vus.some((e) => e.type === 'checkout.session.completed') && vus.some((e) => e.type === 'invoice.paid'));
  // Tout en double, dans l'ordre inverse.
  for (const ev of [...vus].reverse()) assert.strictEqual((await rejouer(ev)).statut, 200, ev.type);
  await s.calme();
  assert.strictEqual(s.boite.length, avant.mails, 'aucun e-mail renvoyé');
  assert.deepStrictEqual(await commande(id), avant.commande, 'la commande n\'a pas bougé');
  assert.deepStrictEqual(sansHorodatage(await famille(fid)), avant.famille, 'la famille n\'a pas bougé');
  assert.deepStrictEqual(await s.lire(`stock/${t.fiche}`), avant.stock);
  assert.strictEqual((await s.db.collection('commandes').get()).size, 1, 'pas de commande en double');
  // Arrêt à la date, puis un vieux message « abonnement actif » qui arrive en retard : la famille reste résiliée.
  const { le } = await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  s.avancer((le - Date.now()) / s.JOUR + 0.1);
  s.stripe.arreterALaDate(id);
  await s.calme();
  assert.strictEqual((await famille(fid)).abonnement.statut, 'resilie');
  const vieux = vus.filter((e) => e.type === 'customer.subscription.updated' && e.data.object.status === 'active');
  assert.ok(vieux.length, 'un vieux message « actif » existe');
  for (const ev of vieux) assert.strictEqual((await rejouer(ev)).statut, 200);
  await rejouer(vus.find((e) => e.type === 'invoice.paid'));
  await s.calme();
  assert.strictEqual((await famille(fid)).abonnement.statut, 'resilie', 'un message en retard ne ressuscite pas l\'abonnement');
  assert.strictEqual((await commande(id)).restitution.statut, 'attendue');
  file.push = push;
});
