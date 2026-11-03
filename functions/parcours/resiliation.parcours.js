// Résiliation, gestes humains (Tanguy, 03/11 : « tous les états et les gestes humains ») : double appui, nouvel
// essai après une erreur, gestes dans le désordre (garder puis résilier de nouveau, vieil onglet après un arrêt
// décidé par Papote, « Garder » après la fin). Chaque scénario vérifie que rien n'est fait deux fois (arrêt chez
// Stripe, e-mail) et que la famille, la commande et Stripe disent la même chose.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, mailsA, commande } = require('./commun');

brancher();

const famille = (fid) => s.lire(`families/${fid}`);
const abo = (id) => s.stripe.etat.abonnements.get(id);

// Commande payée par `acheteur`, tablette envoyée puis installée par lui, premier mois prélevé : { id, fid, t }.
async function familleAbonnee(acheteur) {
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: acheteur.email });
  await a.preparerEtEnvoyer(id, t);
  s.avancer(2);
  await a.afficherCode(t);
  const fid = await a.installer(acheteur, t);
  assert.strictEqual((await famille(fid)).abonnement.statut, 'actif');
  s.avancer(31);
  s.stripe.finirEssai(id);
  await s.calme();
  return { id, fid, t };
}

test('« Résilier » touché deux fois de suite, puis « Garder » deux fois, puis « Résilier » : un e-mail par vraie demande, Stripe suit', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await familleAbonnee(paul);
  s.boite.length = 0;

  // Double appui (ou réseau qui renvoie la demande) : la même date, un seul arrêt prévu, un seul e-mail.
  const r1 = await s.appeler('resilierAbonnement', { fid }, paul);
  const r2 = await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  assert.strictEqual(r1.le, r2.le, 'la même date de fin');
  assert.strictEqual(abo(id).cancel_at, Math.ceil(r1.le / 1000), 'arrêt prévu chez Stripe à cette date');
  assert.strictEqual((await famille(fid)).abonnement.resiliationLe.toMillis(), abo(id).cancel_at * 1000, 'l\'appli montre la même date');
  assert.deepStrictEqual(mailsA(paul.email), ['Votre résiliation Papote est enregistrée']);

  // « Garder mon abonnement » deux fois : l'arrêt disparaît, un seul e-mail.
  assert.deepStrictEqual(await s.appeler('annulerResiliation', { fid }, paul), { ok: true });
  assert.deepStrictEqual(await s.appeler('annulerResiliation', { fid }, paul), { ok: true });
  await s.calme();
  assert.strictEqual(abo(id).cancel_at, null, 'plus d\'arrêt chez Stripe');
  let fam = await famille(fid);
  assert.strictEqual(fam.abonnement.statut, 'actif');
  assert.ok(!fam.abonnement.resiliationLe, 'plus de date d\'arrêt dans l\'appli');
  assert.deepStrictEqual(mailsA(paul.email), ['Votre résiliation Papote est enregistrée', 'Votre abonnement Papote continue']);

  // Il change encore d'avis : nouvelle demande, nouvel e-mail.
  const r3 = await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  assert.strictEqual(r3.le, r1.le, 'toujours la fin du mois en cours');
  assert.strictEqual(abo(id).cancel_at, Math.ceil(r3.le / 1000));
  fam = await famille(fid);
  assert.ok(fam.abonnement.resiliationLe);
  assert.strictEqual(mailsA(paul.email).length, 3);
  assert.strictEqual(mailsA(paul.email)[2], 'Votre résiliation Papote est enregistrée');
  // Tant que la date n'est pas passée : rien à rendre, rien de remboursé, aucun dernier mois.
  const c = await commande(id);
  assert.strictEqual(c.restitution, undefined);
  assert.strictEqual(c.dernierMois, undefined);
  assert.strictEqual(s.stripe.etat.remboursements.length, 0);
  assert.strictEqual(abo(id).status, 'active');
});

test('Stripe ne répond pas au moment de résilier : rien n\'est noté, aucun e-mail ; le nouvel essai passe une seule fois', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await familleAbonnee(paul);
  s.boite.length = 0;
  const update = s.stripe.api.subscriptions.update;
  let pannes = 1;
  s.stripe.api.subscriptions.update = async (...args) => {
    if (pannes > 0) {
      pannes -= 1;
      throw new Error('Simulation : Stripe injoignable');
    }
    return update(...args);
  };
  try {
    await assert.rejects(s.appeler('resilierAbonnement', { fid }, paul), /injoignable/);
    await s.calme();
    assert.ok(!abo(id).cancel_at, 'aucun arrêt chez Stripe');
    assert.ok(!(await famille(fid)).abonnement.resiliationLe, 'l\'appli ne montre pas d\'arrêt');
    assert.strictEqual((await commande(id)).derniereDemande, undefined, 'la demande n\'est pas notée comme faite');
    assert.deepStrictEqual(mailsA(paul.email), [], 'pas d\'e-mail pour un arrêt qui n\'a pas eu lieu');

    // Il réessaie : l'arrêt est pris, un seul e-mail.
    const { le } = await s.appeler('resilierAbonnement', { fid }, paul);
    await s.calme();
    assert.strictEqual(abo(id).cancel_at, Math.ceil(le / 1000));
    assert.ok((await famille(fid)).abonnement.resiliationLe);
    assert.deepStrictEqual(mailsA(paul.email), ['Votre résiliation Papote est enregistrée']);
  } finally {
    s.stripe.api.subscriptions.update = update;
  }
});

test('Papote arrête l\'abonnement : la famille ne le reprend pas seule, même en touchant « Résilier » puis « Garder » (vieil onglet)', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await familleAbonnee(paul);
  s.boite.length = 0;
  const { le } = await s.appeler('resilierAbonnement', { fid, commande: id, par: 'papote' }, a.TANGUY);
  await s.calme();
  assert.strictEqual(abo(id).metadata.arretPar, 'papote');
  assert.strictEqual((await famille(fid)).abonnement.arretPar, 'papote');
  assert.deepStrictEqual(mailsA(paul.email), ['Papote arrête votre abonnement']);
  await assert.rejects(s.appeler('annulerResiliation', { fid }, paul), /Papote a arrêté cet abonnement/);

  // L'appli de Paul, restée ouverte d'avant, montre encore « Résilier » : il touche, puis « Garder ».
  const r = await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  assert.strictEqual(r.le, le, 'même date d\'arrêt');
  assert.strictEqual(abo(id).metadata.arretPar, 'papote', 'l\'arrêt reste celui de Papote');
  assert.strictEqual((await famille(fid)).abonnement.arretPar, 'papote');
  await assert.rejects(s.appeler('annulerResiliation', { fid }, paul), /Papote a arrêté cet abonnement/);
  assert.strictEqual(abo(id).cancel_at, Math.ceil(le / 1000), 'l\'arrêt est toujours prévu');
  assert.deepStrictEqual(mailsA(paul.email), ['Papote arrête votre abonnement'], 'aucun autre e-mail');

  // Papote, lui, peut le reprendre (le client a réglé).
  assert.deepStrictEqual(await s.appeler('annulerResiliation', { fid, commande: id }, a.TANGUY), { ok: true });
  await s.calme();
  assert.strictEqual(abo(id).cancel_at, null);
  assert.ok(!abo(id).metadata.arretPar);
  const fam = await famille(fid);
  assert.strictEqual(fam.abonnement.statut, 'actif');
  assert.ok(!fam.abonnement.resiliationLe);
});

test('abonnement arrivé à sa date d\'arrêt : « Garder » refusé à la famille et à Papote, le retour de la tablette reste attendu', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await familleAbonnee(paul);
  const { le } = await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  s.avancer((le - Date.now()) / s.JOUR + 0.1);
  s.stripe.arreterALaDate(id);
  await s.calme();
  const avant = await commande(id);
  assert.strictEqual(avant.restitution.statut, 'attendue');
  assert.strictEqual(avant.dernierMois.statut, 'fait');
  s.boite.length = 0;

  await assert.rejects(s.appeler('annulerResiliation', { fid }, paul), /déjà en retour/);
  await assert.rejects(s.appeler('annulerResiliation', { fid, commande: id }, a.TANGUY), /ne peut plus être repris/);
  await assert.rejects(s.appeler('retracter', { fid }, paul), /30 jours/);
  await s.calme();
  const apres = await commande(id);
  assert.deepStrictEqual(apres.restitution, avant.restitution, 'le retour n\'a pas bougé');
  assert.deepStrictEqual(apres.dernierMois, avant.dernierMois, 'pas de 2e dernier mois');
  assert.strictEqual((await famille(fid)).abonnement.statut, 'resilie');
  assert.strictEqual(abo(id).status, 'canceled');
  assert.deepStrictEqual(s.boite, [], 'aucun e-mail');
  assert.strictEqual(s.stripe.etat.remboursements.length, 0);
});
