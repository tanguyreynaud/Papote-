// Le temps qui passe (Tanguy, 30/10) : la vie d'une famille sur cinq mois, jour par jour, avec toutes les tâches
// planifiées du serveur lancées chaque jour comme en ligne (fin de grâce, restitutions, relances, rappels, gestion
// automatique, alertes, récap du lundi, clôture du 1er, courrier). Stripe simulé prélève chaque mois, la banque
// refuse un mois, accepte en retard, le client résilie, la tablette revient.
// À chaque jour : aucune erreur, aucun e-mail en double, la famille dans l'état attendu, Stripe et la base d'accord.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, commande } = require('./commun');

brancher();

const famille = (fid) => s.lire(`families/${fid}`);
const JOURNAL = [];

// Les tâches planifiées, comme en ligne : toutes les heures / tous les jours / le lundi / le 1er du mois.
async function journee(jour) {
  const date = new Date(Date.now());
  const taches = ['finDeGrace', 'relancesPaniers', 'gestionCourrier', 'alertesTablettes', 'restitutions', 'rappelsJumelage', 'alerteMatin', 'gestionAutomatique'];
  if (date.getDay() === 1) taches.push('gestionRecap');
  if (date.getDate() === 1) taches.push('gestionCloture');
  for (const t of taches) {
    try {
      await s.tache(t);
    } catch (e) {
      s.erreurs.push(`jour ${jour}, tâche ${t} : ${e.message}`);
    }
  }
  await s.calme();
  const bilan = await s.lire('gestion/automatique');
  if (bilan && bilan.erreurs && bilan.erreurs.length) s.erreurs.push(`jour ${jour}, gestion automatique : ${bilan.erreurs.join(' ; ')}`);
}

// Aucun e-mail envoyé deux fois à la même adresse avec le même sujet (sauf les rappels voulus, espacés de jours).
function pasDeDoublon() {
  const vus = new Map();
  for (const m of s.boite) {
    const cle = `${m.a} | ${m.sujet}`;
    const avant = vus.get(cle);
    if (avant != null && m.le - avant < 2 * s.JOUR) assert.fail(`e-mail en double : ${cle}`);
    vus.set(cle, m.le);
  }
}

test('cinq mois d\'une famille, jour par jour : prélèvements, refus puis retard réglé, résiliation, retour de la tablette', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(id, t);
  s.avancer(2);
  await a.afficherCode(t);
  const fid = await a.installer(julie, t);
  await s.calme();
  const attendu = { statut: 'actif' };
  let jourArret = null;
  void jourArret;
  let jourLimiteRetour = null;

  // Stripe fait son travail chaque jour, comme en ligne : fin d'essai, prélèvement à chaque fin de période, arrêt à la
  // date demandée. La banque refuse le 3e prélèvement ; le client règle 12 jours plus tard, résilie 5 jours après.
  let prelevements = 0;
  let jourRefus = null;
  let jourRegle = null;
  const stripeTravaille = (jour) => {
    const abo = s.stripe.etat.abonnements.get(id);
    const maintenant = Math.floor(Date.now() / 1000);
    if (abo.status === 'trialing' && abo.trial_end && abo.trial_end <= maintenant) { s.stripe.finirEssai(id); prelevements++; JOURNAL.push(`J${jour} fin du mois offert, 1er mois prélevé`); return; }
    if (abo.cancel_at && abo.cancel_at <= maintenant && abo.status !== 'canceled') { s.stripe.arreterALaDate(id); attendu.statut = 'resilie'; JOURNAL.push(`J${jour} Stripe arrête l'abonnement`); return; }
    if (abo.status === 'active' && abo.current_period_end <= maintenant) {
      if (prelevements === 2) { s.stripe.banqueRefusePrelevement(id); attendu.statut = 'impaye'; jourRefus = jour; JOURNAL.push(`J${jour} la banque refuse le 3e mois`); return; }
      s.stripe.prelevementMensuel(id); prelevements++; JOURNAL.push(`J${jour} mois prélevé (${prelevements})`);
    }
  };

  for (let jour = 2; jour <= 170; jour++) {
    s.avancer(1);
    stripeTravaille(jour);
    if (jourRefus && jour === jourRefus + 12) { s.stripe.banqueAccepteEnRetard(id); prelevements++; attendu.statut = 'actif'; jourRegle = jour; JOURNAL.push(`J${jour} réglé en retard`); }
    if (jourRegle && jour === jourRegle + 5) {
      const { le } = await s.appeler('resilierAbonnement', { fid }, julie);
      jourArret = jour + Math.ceil((le - Date.now()) / s.JOUR);
      JOURNAL.push(`J${jour} Julie résilie, arrêt prévu J${jourArret}`);
    }
    if (jourLimiteRetour && jour === jourLimiteRetour - 3) {
      await s.appeler('tabletteRendue', { commande: id, manquants: [] }, a.TANGUY);
      JOURNAL.push(`J${jour} tablette rendue, rien ne manque`);
    }
    await s.calme();
    await journee(jour);

    // Invariants du jour.
    assert.deepStrictEqual(s.erreurs, [], `J${jour} : erreurs`);
    pasDeDoublon();
    const fam = await famille(fid);
    // Délai de grâce (abonnement.graceJusqua) dépassé : la famille passe en pause (finDeGrace, toutes les heures).
    if (attendu.statut === 'impaye' && fam.abonnement.graceJusqua && fam.abonnement.graceJusqua.toMillis() <= Date.now()) { attendu.statut = 'suspendu'; JOURNAL.push(`J${jour} délai de grâce dépassé : Papote en pause`); }
    assert.strictEqual(fam.abonnement.statut, attendu.statut, `J${jour} : statut de la famille`);
    const abo = s.stripe.etat.abonnements.get(id);
    assert.strictEqual(s.stripe.etat.abonnements.size, 1, `J${jour} : un seul abonnement Stripe`);
    assert.strictEqual(s.stripe.etat.remboursements.length, 0, `J${jour} : aucun remboursement`);
    if (attendu.statut === 'resilie') {
      const c = await commande(id);
      if (!jourLimiteRetour) {
        assert.strictEqual(c.restitution.statut, 'attendue', `J${jour} : retour attendu`);
        jourLimiteRetour = jour + Math.round((c.restitution.avant.toMillis() - Date.now()) / s.JOUR);
        JOURNAL.push(`J${jour} retour attendu avant J${jourLimiteRetour}, dernier mois ${c.dernierMois && c.dernierMois.statut}`);
      }
      assert.ok(['attendue', 'rendue'].includes(c.restitution.statut), `J${jour} : restitution ${c.restitution.statut}`);
      assert.strictEqual(c.restitution.paiement, undefined, `J${jour} : rien prélevé pour le matériel`);
    } else {
      assert.ok(['active', 'past_due', 'trialing'].includes(abo.status), `J${jour} : Stripe ${abo.status}`);
      assert.strictEqual(attendu.statut === 'impaye' || attendu.statut === 'suspendu', abo.status === 'past_due', `J${jour} : famille ${attendu.statut}, Stripe ${abo.status}`);
    }
  }

  // Bilan des cinq mois.
  const c = await commande(id);
  const paiements = [...s.stripe.etat.paiements.values()].filter((p) => p.customer === s.stripe.etat.abonnements.get(id).customer);
  const total = paiements.reduce((t2, p) => t2 + p.amount, 0);
  JOURNAL.push(`total prélevé ${total / 100} € en ${paiements.length} paiements ; e-mails à Paul : ${s.boite.filter((m) => m.a === paul.email).map((m) => m.sujet).join(' / ')}`);
  console.log(JOURNAL.join('\n'));
  assert.strictEqual(paiements.filter((p) => p.amount === 2500).length, prelevements + 1, 'chaque mois prélevé une fois, plus le dernier mois à l\'arrêt');
  assert.strictEqual(total, 6000 + 2500 * (prelevements + 1), '60 € de mise en service + les mois, rien d\'autre');
  assert.strictEqual(c.dernierMois.statut, 'fait');
  assert.strictEqual(c.restitution.statut, 'rendue');
  const fiche = (await s.db.collection('tablettes').where('commande', '==', id).get()).docs.map((d) => d.data())[0]
    || (await s.db.collection('tablettes').where('id', '==', t.fiche).get()).docs.map((d) => d.data())[0];
  if (fiche) assert.ok(!fiche.fid, 'la fiche de la tablette rendue a oublié la famille');
});

test('la famille qui ne paie plus jamais : pause, Tanguy arrête après 30 jours, tablette jamais rendue, carte expirée au moment de prélever', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(id, t);
  s.avancer(2);
  await a.afficherCode(t);
  const fid = await a.installer(paul, t);
  await s.calme();
  const journal = [];
  const attendu = { statut: 'actif' };
  let jourRefus = null;
  let jourArret = null;
  let jourLimite = null;
  let prelevements = 0;
  for (let jour = 2; jour <= 150; jour++) {
    s.avancer(1);
    const abo = s.stripe.etat.abonnements.get(id);
    const maintenant = Math.floor(Date.now() / 1000);
    if (abo.status === 'trialing' && abo.trial_end <= maintenant) { s.stripe.finirEssai(id); prelevements++; journal.push(`J${jour} 1er mois prélevé`); }
    else if (abo.status === 'active' && abo.current_period_end <= maintenant) { s.stripe.banqueRefusePrelevement(id); attendu.statut = 'impaye'; jourRefus = jour; journal.push(`J${jour} la banque refuse`); }
    else if (abo.cancel_at && abo.cancel_at <= maintenant && abo.status !== 'canceled') { s.stripe.arreterALaDate(id); attendu.statut = 'resilie'; journal.push(`J${jour} Stripe arrête`); }
    if (jourRefus && jour === jourRefus + 40) {
      // Suspendue depuis plus de 30 jours : Tanguy arrête l'abonnement depuis l'admin.
      const { le } = await s.appeler('resilierAbonnement', { fid, commande: id, par: 'papote' }, a.TANGUY);
      jourArret = jour + Math.ceil((le - Date.now()) / s.JOUR);
      s.stripe.carteExpiree(id);
      journal.push(`J${jour} Tanguy arrête l'abonnement (arrêt J${jourArret}), la carte de Paul a expiré`);
    }
    await s.calme();
    await journee(jour);
    assert.deepStrictEqual(s.erreurs, [], `J${jour} : erreurs`);
    pasDeDoublon();
    const fam = await famille(fid);
    if (attendu.statut === 'impaye' && fam.abonnement.graceJusqua && fam.abonnement.graceJusqua.toMillis() <= Date.now()) { attendu.statut = 'suspendu'; journal.push(`J${jour} Papote en pause`); }
    assert.strictEqual(fam.abonnement.statut, attendu.statut, `J${jour} : statut de la famille`);
    if (attendu.statut === 'resilie') {
      const c = await commande(id);
      if (!jourLimite) {
        jourLimite = jour + Math.round((c.restitution.avant.toMillis() - Date.now()) / s.JOUR);
        journal.push(`J${jour} retour attendu avant J${jourLimite} ; dernier mois : ${c.dernierMois.statut} (${c.dernierMois.motif || ''})`);
        assert.strictEqual(c.dernierMois.statut, 'aucun', 'famille suspendue : pas de dernier mois en plus de la dette');
      }
      if (jour > jourLimite) {
        assert.strictEqual(c.restitution.statut, 'echec', `J${jour} : prélèvement du matériel refusé (carte expirée), noté pour Tanguy`);
        assert.match(c.restitution.erreur || '', /expired/);
      }
    }
  }
  journal.push(`e-mails à Paul : ${s.boite.filter((m) => m.a === paul.email).map((m) => m.sujet).join(' / ')}`);
  journal.push(`e-mails à Papote : ${s.boite.filter((m) => m.a !== paul.email).map((m) => m.sujet).join(' / ')}`);
  console.log(journal.join('\n'));
  const paiements = [...s.stripe.etat.paiements.values()].filter((p) => p.customer === s.stripe.etat.abonnements.get(id).customer);
  assert.strictEqual(paiements.reduce((t2, p) => t2 + p.amount, 0), 6000 + 2500 * prelevements, 'rien prélevé de plus que les mois payés');
  assert.ok(s.boite.some((m) => m.a !== paul.email && /prélèvement refusé/i.test(m.sujet)), 'Tanguy prévenu une fois du prélèvement refusé');
  assert.strictEqual(s.boite.filter((m) => m.a !== paul.email && /prélèvement refusé/i.test(m.sujet)).length, 1, 'une seule fois');
});
