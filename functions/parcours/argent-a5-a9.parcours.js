// Décisions d'argent de Tanguy du 12/11 (A5 à A9), avec les gestes humains : double appui, message Stripe rejoué,
// tâche du matin relancée.
//   A5 : 140 € prélevés puis reprise de l'abonnement : remboursés ; nouvel arrêt sans retour : de nouveau dus à J+30.
//   A6 : QR code de retour encore possible après les 140 € ; tablette reçue : remboursés.
//   A7 : « Laisser plus de temps » : le prélèvement des 140 € recule de 15 jours.
//   A8 : mois avec plus de 2 semaines de pause hospitalisation : pas prélevé, le dernier mois à l'arrêt compris.
//   A9 : tablette en panne remplacée seulement une fois l'ancienne reçue ; « Rembourser un mois » (25 €).

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, mailsA, commande } = require('./commun');

brancher();

const famille = (fid) => s.lire(`families/${fid}`);
const abo = (id) => s.stripe.etat.abonnements.get(id);
const preleveMateriel = () => [...s.stripe.etat.paiements.values()].filter((p) => /non rendu/.test(p.description || ''));
const remboursements = () => s.stripe.etat.remboursements.map((r) => r.amount);
const fiche = (t) => s.lire(`stock/${t.fiche}`);

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

// Arrêt à la date, tablette attendue : { id, fid, t }.
async function finDeContrat(paul, existante = null) {
  const { id, fid, t } = existante || await familleAbonnee(paul);
  const { le } = await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  s.avancer((le - Date.now()) / s.JOUR + 0.1);
  s.stripe.arreterALaDate(id);
  await s.calme();
  assert.strictEqual((await commande(id)).restitution.statut, 'attendue');
  return { id, fid, t };
}

// Tablette jamais rendue : J+31, la tâche du matin prélève les 140 €.
async function materielPreleve(paul) {
  const r = await finDeContrat(paul);
  s.avancer(31);
  await s.tache('restitutions');
  await s.calme();
  assert.strictEqual((await commande(r.id)).restitution.statut, 'facturee');
  assert.deepStrictEqual(preleveMateriel().map((p) => p.amount), [14000]);
  return r;
}

// ---------- A5 ----------

test('A5 : 140 € prélevés, la famille reprend : 140 € remboursés une seule fois (message rejoué, tâche relancée) ; nouvel arrêt sans retour : 140 € de nouveau dus à J+30', async () => {
  const vus = [];
  const file = s.stripe.etat.evenements;
  const push = file.push.bind(file);
  file.push = (...evs) => { vus.push(...evs.map((e) => JSON.parse(JSON.stringify(e)))); return push(...evs); };
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid, t } = await materielPreleve(paul);
  assert.strictEqual((await fiche(t)).etat === 'perdue' || (await fiche(t)).etat === 'chez-client', true);

  // Reprise depuis l'appli : la tablette est toujours chez Mamie : ni mise en service, ni 140 € de plus.
  const fin = await s.appeler('finDeContrat', { fid }, paul);
  assert.strictEqual(fin.restitution.statut, 'facturee');
  assert.strictEqual(fin.restitution.preleve, 14000, 'l\'appli sait que 140 € ont été prélevés');
  const { url } = await s.appeler('creerPaiement', { fid, formule: 'sim', tablette: 'incluse' }, paul);
  const session = url.split('/').pop();
  const params = s.stripe.etat.sessions.get(session).params;
  assert.strictEqual(params.metadata.reprise, '1');
  assert.strictEqual(params.line_items.length, 1, 'l\'abonnement seul');
  const { abonnement: id2 } = s.stripe.payerSession(session, { email: paul.email });
  await s.calme();
  assert.strictEqual((await famille(fid)).abonnement.statut, 'actif');
  let ancienne = await commande(id);
  assert.strictEqual(ancienne.restitution.statut, 'annulee');
  assert.strictEqual(ancienne.restitution.reprisePar, id2);
  assert.strictEqual(ancienne.restitution.rembourse.statut, 'fait');
  assert.strictEqual(ancienne.restitution.rembourse.montant, 14000);
  assert.deepStrictEqual(remboursements(), [14000], '140 € remboursés');
  assert.strictEqual((await fiche(t)).commande, id2, 'la tablette passe sur la nouvelle commande');
  assert.strictEqual((await fiche(t)).etat, 'chez-client');

  // Le même paiement rejoué par Stripe (nouvel identifiant), puis la tâche du matin deux fois : rien de plus.
  const termine = vus.find((e) => e.type === 'checkout.session.completed' && e.data.object.id === session);
  await s.requete('stripeWebhook', { corps: { ...termine, id: 'evt_rejoue_a5' }, entetes: { 'stripe-signature': 'faux' } });
  await s.calme();
  await Promise.all([s.tache('restitutions'), s.tache('restitutions')]);
  await s.calme();
  assert.deepStrictEqual(remboursements(), [14000], 'jamais deux remboursements');
  ancienne = await commande(id);
  assert.strictEqual(ancienne.restitution.statut, 'annulee');

  // Nouvel arrêt, tablette toujours pas rendue : la nouvelle commande l'attend, 140 € prélevés à J+30, une fois.
  s.avancer(31);
  s.stripe.finirEssai(id2);
  await s.calme();
  await finDeContrat(paul, { id: id2, fid, t });
  s.avancer(29);
  await s.tache('restitutions');
  assert.strictEqual((await commande(id2)).restitution.statut, 'attendue', 'pas avant J+30');
  s.avancer(2);
  await Promise.all([s.tache('restitutions'), s.tache('restitutions')]);
  await s.calme();
  assert.strictEqual((await commande(id2)).restitution.statut, 'facturee');
  assert.deepStrictEqual(preleveMateriel().map((p) => [p.amount, p.metadata.commande]), [[14000, id], [14000, id2]]);
  assert.deepStrictEqual(remboursements(), [14000]);
});

test('A5 : Stripe refuse le remboursement au moment de la reprise : la reprise passe, le remboursement est refait le lendemain, une fois', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await materielPreleve(paul);
  const vrai = s.stripe.api.refunds.create;
  s.stripe.api.refunds.create = async () => { throw new Error('Stripe indisponible'); };
  try {
    const { url } = await s.appeler('creerPaiement', { fid, formule: 'sim', tablette: 'incluse' }, paul);
    s.stripe.payerSession(url.split('/').pop(), { email: paul.email });
    await s.calme();
  } finally {
    s.stripe.api.refunds.create = vrai;
  }
  let c = await commande(id);
  assert.strictEqual((await famille(fid)).abonnement.statut, 'actif', 'la reprise n\'attend pas le remboursement');
  assert.strictEqual(c.restitution.statut, 'annulee');
  assert.strictEqual(c.restitution.rembourse.statut, 'a-faire');
  assert.deepStrictEqual(remboursements(), []);
  s.avancer(1);
  await Promise.all([s.tache('restitutions'), s.tache('restitutions')]);
  await s.calme();
  c = await commande(id);
  assert.strictEqual(c.restitution.rembourse.statut, 'fait');
  assert.deepStrictEqual(remboursements(), [14000]);
  s.avancer(1);
  await s.tache('restitutions');
  assert.deepStrictEqual(remboursements(), [14000]);
});

// ---------- A6 ----------

test('A6 : 140 € prélevés, la famille demande quand même le QR code (deux appuis) : un seul colis ; tablette reçue : 140 € remboursés une fois', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await materielPreleve(paul);
  s.boite.length = 0;
  const [q1, q2] = await Promise.allSettled([s.appeler('renvoyerTablette', { fid }, paul), s.appeler('renvoyerTablette', { fid }, paul)]);
  const ok = [q1, q2].filter((r) => r.status === 'fulfilled');
  assert.ok(ok.length >= 1 && ok[0].value.qr, JSON.stringify([q1, q2]));
  await s.calme();
  assert.strictEqual(s.sendcloud.colis.size, 1, 'un seul QR code payé');
  assert.strictEqual((await s.appeler('renvoyerTablette', { fid }, paul)).qr, ok[0].value.qr, 'le même QR code ensuite');
  assert.strictEqual(s.sendcloud.colis.size, 1);
  const mails = s.boite.filter((m) => m.a === paul.email);
  assert.strictEqual(mails.length, 1, mails.map((m) => m.sujet).join(' | '));
  assert.match(mails[0].texte, /remboursons les 140 € prélevés/);
  assert.strictEqual((await commande(id)).restitution.statut, 'facturee', 'toujours prélevé tant que rien n\'est revenu');
  // La reprise est refusée une fois le colis déposé (la tablette revient).
  s.sendcloud.colis.get([...s.sendcloud.colis.keys()][0]).statut = 3;
  await assert.rejects(s.appeler('creerPaiement', { fid, formule: 'sim', tablette: 'incluse' }, paul), /déjà en route/);

  // Tablette reçue : « Matériel reçu » touché deux fois : remboursée une fois.
  const [r1, r2] = await Promise.allSettled([
    s.appeler('tabletteRendue', { commande: id, manquants: [] }, a.TANGUY),
    s.appeler('tabletteRendue', { commande: id, manquants: [] }, a.TANGUY),
  ]);
  assert.ok([r1, r2].some((r) => r.status === 'fulfilled'));
  await s.calme();
  const c = await commande(id);
  assert.strictEqual(c.restitution.statut, 'rendue');
  assert.deepStrictEqual(remboursements(), [14000]);
  await assert.rejects(s.appeler('tabletteRendue', { commande: id, manquants: [] }, a.TANGUY), /déjà noté rendu/);
  assert.deepStrictEqual(remboursements(), [14000]);
});

test('A6 : l\'admin crée l\'étiquette de retour après les 140 € (refusée avant le 12/11)', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id } = await materielPreleve(paul);
  const r = await s.appeler('gestionEtiquette', { commande: id, sens: 'retour' }, a.TANGUY);
  assert.ok(r.url);
  await s.calme();
  assert.ok((await commande(id)).restitution.etiquette);
});

// ---------- A7 ----------

test('A7 : « Laisser plus de temps » : 15 jours de plus, double appui sans effet, rappel renvoyé, 140 € prélevés à la nouvelle date seulement', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id } = await finDeContrat(paul);
  s.avancer(24);
  await s.tache('restitutions');
  let c = await commande(id);
  assert.ok(c.restitution.rappelLe, 'rappel 7 jours avant');
  const avant = c.restitution.avant.toMillis();
  const [r1, r2] = await Promise.all([
    s.appeler('gestionCommande', { commande: id, action: 'plusDeTemps', avant }, a.TANGUY),
    s.appeler('gestionCommande', { commande: id, action: 'plusDeTemps', avant }, a.TANGUY),
  ]);
  assert.strictEqual(r1.avant, avant + 15 * s.JOUR);
  assert.strictEqual(r2.avant, avant + 15 * s.JOUR, 'le double appui ne repousse pas deux fois');
  c = await commande(id);
  assert.strictEqual(c.restitution.avant.toMillis(), avant + 15 * s.JOUR);
  assert.strictEqual(c.restitution.prolongations.length, 1);
  assert.strictEqual(c.restitution.rappelLe, undefined);

  // À l'ancienne date : rien de prélevé. Le rappel repart 7 jours avant la nouvelle.
  s.avancer(8);
  await s.tache('restitutions');
  assert.strictEqual((await commande(id)).restitution.statut, 'attendue');
  assert.strictEqual(preleveMateriel().length, 0);
  s.avancer(1);
  await s.tache('restitutions');
  assert.ok(!(await commande(id)).restitution.rappelLe, 'pas encore de rappel');
  s.avancer(6);
  await s.tache('restitutions');
  assert.ok((await commande(id)).restitution.rappelLe, 'nouveau rappel 7 jours avant la nouvelle date');
  s.avancer(7);
  await Promise.all([s.tache('restitutions'), s.tache('restitutions')]);
  await s.calme();
  assert.strictEqual((await commande(id)).restitution.statut, 'facturee');
  assert.deepStrictEqual(preleveMateriel().map((p) => p.amount), [14000]);
  // Après le prélèvement : plus de délai possible.
  await assert.rejects(s.appeler('gestionCommande', { commande: id, action: 'plusDeTemps', avant: Date.now() }, a.TANGUY), /Aucune tablette attendue/);
});

// ---------- A8 ----------

async function pause(id, jours) {
  return s.appeler('pauseHospitalisation', { commande: id, jusqua: Date.now() + jours * s.JOUR }, a.TANGUY);
}
const facturesMois = (id) => [...s.stripe.etat.factures.values()].filter((f) => f.subscription === id && f.billing_reason === 'subscription_cycle');

test('A8 : plus de 2 semaines d\'hospitalisation dans le mois : ce mois n\'est pas prélevé, le suivant oui ; tâche relancée sans effet', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id } = await familleAbonnee(paul);
  s.avancer(10);
  // 20 jours d'hospitalisation, tous dans le mois qui finit au prochain prélèvement.
  const r = await pause(id, 20);
  assert.strictEqual(r.prochainOffert, true);
  const pc = abo(id).pause_collection;
  assert.strictEqual(pc.behavior, 'void');
  assert.strictEqual(pc.resumes_at, abo(id).current_period_end + 86400, 'jusqu\'au lendemain du prélèvement');
  // Pause rejouée (double appui) et tâche du matin deux fois : rien ne change chez Stripe.
  await pause(id, 20);
  await Promise.all([s.tache('restitutions'), s.tache('restitutions')]);
  await s.calme();
  assert.deepStrictEqual(abo(id).pause_collection, pc);
  assert.strictEqual(s.boite.filter((m) => m.a === paul.email && /pause/i.test(m.sujet)).length, 1, 'un seul e-mail de pause');

  // Jour du prélèvement (fin de la période Stripe) : la facture du mois est annulée.
  s.avancer((abo(id).current_period_end * 1000 - Date.now()) / s.JOUR);
  s.stripe.prelevementMensuel(id);
  await s.calme();
  await s.tache('restitutions');
  let mois = facturesMois(id);
  assert.deepStrictEqual(mois.map((f) => f.status), ['paid', 'void'], 'le mois de l\'hospitalisation n\'est pas prélevé');

  // Le mois suivant (hospitalisation finie) est prélevé normalement.
  s.avancer(5);
  await s.tache('restitutions');
  await s.calme();
  const reste = abo(id).pause_collection;
  assert.ok(!reste || reste.resumes_at * 1000 <= Date.now(), 'plus de pause pour le mois suivant');
  s.avancer(25);
  s.stripe.prelevementMensuel(id);
  await s.calme();
  mois = facturesMois(id);
  assert.deepStrictEqual(mois.map((f) => f.status), ['paid', 'void', 'paid']);
});

test('A8 : 10 jours d\'hospitalisation seulement : le mois est prélevé ; 10 jours de plus (prolongée) : il ne l\'est plus', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id } = await familleAbonnee(paul);
  s.avancer(5);
  const r = await pause(id, 10);
  assert.strictEqual(r.prochainOffert, false);
  assert.strictEqual(abo(id).pause_collection, null, '10 jours : prélevé');
  // Hospitalisation prolongée de 10 jours : le même mois en compte 20.
  const r2 = await pause(id, 20);
  assert.strictEqual(r2.prochainOffert, true);
  assert.ok(abo(id).pause_collection);
  // Sortie anticipée au bout de 12 jours en tout : moins de 2 semaines, le mois redevient dû.
  s.avancer(12);
  await s.appeler('pauseHospitalisation', { commande: id, jusqua: null }, a.TANGUY);
  await s.appeler('pauseHospitalisation', { commande: id, jusqua: null }, a.TANGUY);
  await s.calme();
  assert.strictEqual(abo(id).pause_collection, null);
  const c = await commande(id);
  assert.strictEqual(c.pause, undefined);
  assert.strictEqual(c.hospitalisations.length, 1, 'la période est gardée une fois');
  assert.strictEqual(s.boite.filter((m) => m.a === paul.email && /reprise|reprennent/i.test(m.sujet)).length, 1, 'un seul e-mail de reprise');
});

test('A8 : arrêt de l\'abonnement pendant une hospitalisation de plus de 2 semaines : le dernier mois n\'est pas prélevé', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await familleAbonnee(paul);
  const { le } = await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  s.avancer(5);
  await pause(id, 22);
  s.avancer((le - Date.now()) / s.JOUR + 0.1);
  s.stripe.arreterALaDate(id);
  await s.calme();
  const c = await commande(id);
  assert.strictEqual(c.dernierMois.statut, 'aucun');
  assert.match(c.dernierMois.motif, /hospitalisation/);
  const derniers = [...s.stripe.etat.factures.values()].filter((f) => f.metadata && f.metadata.dernierMois === '1');
  assert.strictEqual(derniers.length, 0, 'aucune facture du dernier mois');
});

test('A8 : arrêt sans hospitalisation (ou moins de 2 semaines) : le dernier mois reste prélevé', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await familleAbonnee(paul);
  const { le } = await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  s.avancer(5);
  await pause(id, 8);
  s.avancer((le - Date.now()) / s.JOUR + 0.1);
  s.stripe.arreterALaDate(id);
  await s.calme();
  assert.strictEqual((await commande(id)).dernierMois.statut, 'fait');
});

// ---------- A9 ----------

const remplacer = (id, neuve, extra = {}) => s.appeler('gestionStock', {
  action: 'remplacer', commande: id, element: 'tablette', nouveau: neuve && neuve.fiche, raison: 'panne', motif: 'écran noir', ...extra,
}, a.TANGUY);

test('A9 : tablette en panne : retour demandé d\'abord (double appui sans effet), la nouvelle part seulement une fois l\'ancienne reçue', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, t } = await familleAbonnee(paul);
  const neuve = await a.tablettePreparee();
  await a.simSurTablette(neuve);
  s.boite.length = 0;
  const [r1, r2] = await Promise.all([remplacer(id, neuve), remplacer(id, neuve)]);
  assert.strictEqual(r1.attente && r2.attente, true);
  let c = await commande(id);
  assert.strictEqual(c.remplacement.statut, 'attente-retour');
  assert.strictEqual((await fiche(t)).etat, 'en-retour');
  assert.strictEqual((await fiche(t)).commande, id, 'toujours la tablette prêtée de la commande');
  assert.ok(!(await fiche(neuve)).commande, 'la nouvelle ne part pas');
  // Étiquette de retour de l'ancienne : e-mail « la nouvelle part à réception ».
  await s.appeler('gestionEtiquette', { commande: id, sens: 'retour' }, a.TANGUY);
  await s.calme();
  assert.ok(mailsA(paul.email).length >= 1);
  assert.match(s.boite.filter((m) => m.a === paul.email).at(-1).texte, /nous vous envoyons la nouvelle/);

  // Ancienne reçue : la nouvelle part ; double appui : une seule fois.
  const [e1, e2] = await Promise.allSettled([remplacer(id, neuve, { ancienneRecue: true }), remplacer(id, neuve, { ancienneRecue: true })]);
  assert.ok([e1, e2].some((r) => r.status === 'fulfilled'), JSON.stringify([e1, e2]));
  assert.ok([e1, e2].every((r) => r.status === 'fulfilled' || /déjà fait/.test(r.reason.message)), JSON.stringify([e1, e2]));
  const deja = await remplacer(id, neuve, { ancienneRecue: true });
  assert.strictEqual(deja.deja, true);
  c = await commande(id);
  assert.strictEqual(c.remplacement.statut, 'fait');
  assert.strictEqual((await fiche(t)).etat, 'revenue');
  assert.ok(!(await fiche(t)).commande);
  assert.strictEqual((await fiche(neuve)).commande, id);
  assert.strictEqual((await fiche(neuve)).etat, 'envoyee');
  assert.strictEqual([...s.stripe.etat.paiements.values()].filter((p) => /remplacée/.test(p.description || '')).length, 0, 'panne : rien de prélevé');
});

test('A9 : tablette en panne jamais renvoyée, puis arrêt : 140 € à J+30 comme d\'habitude, aucune nouvelle tablette partie', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid, t } = await familleAbonnee(paul);
  await remplacer(id, null);
  await finDeContrat(paul, { id, fid, t });
  s.avancer(31);
  await s.tache('restitutions');
  await s.calme();
  assert.strictEqual((await commande(id)).restitution.statut, 'facturee');
  assert.deepStrictEqual(preleveMateriel().map((p) => p.amount), [14000]);
  assert.strictEqual((await s.db.collection('stock').where('commande', '==', id).get()).size, 1, 'seule l\'ancienne tablette');
});

test('A9 : « Rembourser un mois » : 25 € sur le dernier mois payé, une seule fois (double appui), puis sur le mois d\'après', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id } = await familleAbonnee(paul);
  s.avancer(30);
  s.stripe.prelevementMensuel(id);
  await s.calme();
  const dernier = facturesMois(id).at(-1);
  const [r1, r2] = await Promise.all([
    s.appeler('gestionCommande', { commande: id, action: 'rembourserMois' }, a.TANGUY),
    s.appeler('gestionCommande', { commande: id, action: 'rembourserMois' }, a.TANGUY),
  ]);
  assert.strictEqual(r1.facture, dernier.id);
  assert.strictEqual(r2.facture, dernier.id);
  assert.deepStrictEqual(remboursements(), [2500], 'un seul remboursement de 25 €');
  const r3 = await s.appeler('gestionCommande', { commande: id, action: 'rembourserMois' }, a.TANGUY);
  assert.strictEqual(r3.deja, true);
  assert.deepStrictEqual(remboursements(), [2500]);
  const c = await commande(id);
  assert.strictEqual(c.moisRembourses.length, 1);
  assert.strictEqual(c.moisRembourses[0].montant, 2500);
  // Le mois suivant est payé : un nouveau « Rembourser un mois » vise cette nouvelle facture.
  s.avancer(30);
  s.stripe.prelevementMensuel(id);
  await s.calme();
  const r4 = await s.appeler('gestionCommande', { commande: id, action: 'rembourserMois' }, a.TANGUY);
  assert.strictEqual(r4.facture, facturesMois(id).at(-1).id);
  assert.deepStrictEqual(remboursements(), [2500, 2500]);
  // Réservé à l'admin.
  await assert.rejects(s.appeler('gestionCommande', { commande: id, action: 'rembourserMois' }, paul), /administrateur/i);
});

test('A9 : « Rembourser un mois » après l\'arrêt : le dernier mois prélevé à l\'arrêt ; jamais la mise en service', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id } = await finDeContrat(paul);
  const c0 = await commande(id);
  assert.strictEqual(c0.dernierMois.statut, 'fait');
  const r = await s.appeler('gestionCommande', { commande: id, action: 'rembourserMois' }, a.TANGUY);
  assert.strictEqual(r.facture, c0.dernierMois.facture);
  assert.strictEqual(r.montant, 2500);
  assert.deepStrictEqual(remboursements(), [2500]);
});
