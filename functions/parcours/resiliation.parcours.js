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

// Reprise depuis l'appli d'un abonnement fini (Tanguy, 5/11) : les mois d'abonnement impayés se règlent d'abord,
// les 140 € du matériel jamais (la tablette reste chez le proche, son retour est annulé).

// Famille arrêtée à sa date d'arrêt (résiliée par la famille) : renvoie { id, fid, paul }.
async function familleResiliee({ carteExpireeAvantArret = false } = {}) {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await familleAbonnee(paul);
  const { le } = await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  if (carteExpireeAvantArret) s.stripe.carteExpiree(id);
  s.avancer((le - Date.now()) / s.JOUR + 0.1);
  s.stripe.arreterALaDate(id);
  await s.calme();
  assert.strictEqual((await famille(fid)).abonnement.statut, 'resilie');
  return { id, fid, paul };
}

test('reprise : famille arrêtée par Papote pour impayé, 140 € refusés : pas de reprise seule, « écrivez-nous »', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await familleAbonnee(paul);
  s.stripe.banqueRefusePrelevement(id);
  await s.calme();
  s.avancer(8);
  await s.tache('finDeGrace');
  await s.calme();
  assert.strictEqual((await famille(fid)).abonnement.statut, 'suspendu');
  const { le } = await s.appeler('resilierAbonnement', { fid, commande: id, par: 'papote' }, a.TANGUY);
  await s.calme();
  s.stripe.carteExpiree(id);
  s.avancer((le - Date.now()) / s.JOUR + 0.1);
  s.stripe.arreterALaDate(id);
  await s.calme();
  assert.strictEqual((await famille(fid)).abonnement.statut, 'resilie');
  s.avancer(31);
  await s.tache('restitutions');
  await s.calme();
  assert.strictEqual((await commande(id)).restitution.statut, 'echec');
  s.erreurs.length = 0;

  const sessions = s.stripe.etat.sessions.size;
  await assert.rejects(s.appeler('creerPaiement', { fid, formule: 'wifi', tablette: 'incluse' }, paul), /Papote a arrêté cet abonnement : écrivez-nous/);
  assert.strictEqual(s.stripe.etat.sessions.size, sessions, 'aucune page de paiement');
  assert.strictEqual((await commande(id)).restitution.statut, 'echec', 'la dette reste visible pour Tanguy');
});

test('reprise : dernier mois refusé par la banque : « Réglez d\'abord le paiement en retard » ; facture payée, la reprise passe', async () => {
  const { id, fid, paul } = await familleResiliee({ carteExpireeAvantArret: true });
  let c = await commande(id);
  assert.strictEqual(c.dernierMois.statut, 'echec', 'dernier mois refusé (carte expirée)');
  assert.ok(c.dernierMois.facture);
  s.erreurs.length = 0;

  const sessions = s.stripe.etat.sessions.size;
  await assert.rejects(s.appeler('creerPaiement', { fid, formule: 'wifi', tablette: 'incluse' }, paul), /Réglez d'abord le paiement en retard/);
  assert.strictEqual(s.stripe.etat.sessions.size, sessions, 'aucune page de paiement : la dette ne s\'efface pas');
  // La facture à payer est dans « Abonnement et paiement », avec sa page Stripe.
  const { factures } = await s.appeler('facturesFamille', { fid }, paul);
  assert.ok(factures.some((f) => f.id === c.dernierMois.facture && f.statut === 'a-payer'));

  // Paul paie la facture depuis sa page : le dernier mois est réglé, la reprise s'ouvre (tablette gardée, sans 60 €).
  s.stripe.payerFacture(c.dernierMois.facture);
  await s.calme();
  c = await commande(id);
  assert.strictEqual(c.dernierMois.statut, 'fait');
  const { url } = await s.appeler('creerPaiement', { fid, formule: 'wifi', tablette: 'incluse' }, paul);
  const params = s.stripe.etat.sessions.get(url.split('/').pop()).params;
  assert.strictEqual(params.metadata.reprise, '1');
  assert.strictEqual(params.line_items.length, 1, 'l\'abonnement seul, pas de mise en service');
});

test('reprise : 140 € du matériel refusés, abonnement réglé : la reprise passe, le retour est annulé, rien n\'est prélevé', async () => {
  const { id, fid, paul } = await familleResiliee();
  assert.strictEqual((await commande(id)).dernierMois.statut, 'fait');
  s.stripe.carteExpiree(id);
  s.avancer(31);
  await s.tache('restitutions');
  await s.calme();
  assert.strictEqual((await commande(id)).restitution.statut, 'echec', 'prélèvement du matériel refusé');
  s.erreurs.length = 0;

  const { url } = await s.appeler('creerPaiement', { fid, formule: 'wifi', tablette: 'incluse' }, paul);
  const session = url.split('/').pop();
  const params = s.stripe.etat.sessions.get(session).params;
  assert.strictEqual(params.metadata.reprise, '1');
  assert.strictEqual(params.line_items.length, 1, 'ni mise en service, ni 140 € sur la page de paiement');
  const { abonnement: id2 } = s.stripe.payerSession(session, { email: paul.email });
  await s.calme();
  assert.strictEqual((await famille(fid)).abonnement.statut, 'actif');
  const ancienne = await commande(id);
  assert.strictEqual(ancienne.restitution.statut, 'annulee', 'la tablette reste : plus de retour attendu');
  assert.strictEqual(ancienne.restitution.reprisePar, id2);
  // Nouvelle carte (un prélèvement passerait) : la tâche de la nuit ne prélève quand même rien pour le matériel.
  for (const client of s.stripe.etat.clients.values()) client.carteExpiree = false;
  s.avancer(31);
  await s.tache('restitutions');
  await s.calme();
  assert.strictEqual((await commande(id)).restitution.statut, 'annulee');
  const materiel = [...s.stripe.etat.paiements.values()].filter((p) => /non rendu/.test(p.description || ''));
  assert.strictEqual(materiel.length, 0, 'aucun prélèvement du matériel');
});

test('reprise : sans dette (avant la date limite du retour), la reprise reste possible', async () => {
  const { fid, paul } = await familleResiliee();
  assert.ok((await s.appeler('creerPaiement', { fid, formule: 'wifi', tablette: 'incluse' }, paul)).url);
});

// A13 (Tanguy, 12/11) : résilier depuis le site, sans compte, avec l'e-mail et le numéro de la commande.
test('Résilier sans compte depuis le site : mauvais numéro refusé sans rien dire, date montrée, confirmé une seule fois', async () => {
  const paul = await s.compte('Paul', 'paul.sanscompte@exemple.fr');
  const { id, fid } = await familleAbonnee(paul);
  s.boite.length = 0;
  const code = (await commande(id)).code;
  const depuis = '198.51.100.7';
  const site = (corps) => s.requete('resilierSansCompte', { corps, depuis });

  // Champs manquants ou illisibles.
  assert.strictEqual((await site({ email: 'paul', code })).statut, 400);
  assert.strictEqual((await site({ email: paul.email, code: '12' })).statut, 400);
  // Mauvaise adresse ou numéro inconnu : même réponse, rien n'apprend qu'une commande existe.
  const autreAdresse = await site({ email: 'quelquun@exemple.fr', code });
  const autreCode = await site({ email: paul.email, code: code === 'ABCDEFGH' ? 'ABCDEFGJ' : 'ABCDEFGH' });
  assert.strictEqual(autreAdresse.statut, 404);
  assert.deepStrictEqual(autreAdresse.json, autreCode.json);
  assert.strictEqual(abo(id).cancel_at, null, 'rien n\'est arrêté');

  // Bonne adresse (majuscules et espaces tolérés) et numéro avec tiret : la date d'arrêt est montrée, rien n'est fait.
  const vue = await site({ email: ` ${paul.email.toUpperCase()} `, code: `${code.slice(0, 4)}-${code.slice(4)}` });
  assert.strictEqual(vue.statut, 200);
  assert.strictEqual(vue.json.etat, 'a-confirmer');
  assert.ok(vue.json.le > Date.now(), 'date d\'arrêt à venir');
  await s.calme();
  assert.strictEqual(abo(id).cancel_at, null, 'pas encore arrêté avant « Confirmer »');
  assert.deepStrictEqual(mailsA(paul.email), []);

  // « Confirmer » touché deux fois : un seul arrêt, un seul e-mail, même date que celle montrée.
  const ok = await site({ email: paul.email, code, confirmer: true });
  const encore = await site({ email: paul.email, code, confirmer: true });
  await s.calme();
  assert.strictEqual(ok.json.etat, 'resilie');
  assert.strictEqual(ok.json.le, vue.json.le, 'la date annoncée');
  assert.strictEqual(encore.json.etat, 'deja');
  assert.strictEqual(abo(id).cancel_at, Math.ceil(ok.json.le / 1000), 'arrêt prévu chez Stripe');
  assert.strictEqual((await famille(fid)).abonnement.resiliationLe.toMillis(), abo(id).cancel_at * 1000, 'l\'appli montre la même date');
  assert.deepStrictEqual(mailsA(paul.email), ['Votre résiliation Papote est enregistrée']);
  assert.strictEqual(abo(id).metadata.arretPar, 'client', 'le client peut encore le reprendre dans l\'appli');
});

test('Résilier sans compte : 20 essais par jour et par adresse internet, même en trichant sur X-Forwarded-For', async () => {
  const depuis = '198.51.100.8';
  for (let i = 0; i < 20; i++) {
    const r = await s.requete('resilierSansCompte', { corps: { email: 'devine@exemple.fr', code: 'ABCDEFGH' }, depuis, entetes: { 'x-forwarded-for': `10.0.0.${i}` } });
    assert.strictEqual(r.statut, 404, `essai ${i + 1}`);
  }
  const bloque = await s.requete('resilierSansCompte', { corps: { email: 'devine@exemple.fr', code: 'ABCDEFGH' }, depuis, entetes: { 'x-forwarded-for': '10.0.0.99' } });
  assert.strictEqual(bloque.statut, 429);
  const autre = await s.requete('resilierSansCompte', { corps: { email: 'devine@exemple.fr', code: 'ABCDEFGH' }, depuis: '198.51.100.9' });
  assert.strictEqual(autre.statut, 404, 'une autre adresse internet n\'est pas bloquée');
});
