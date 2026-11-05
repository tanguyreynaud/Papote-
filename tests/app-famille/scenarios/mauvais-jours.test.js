// Les mauvais jours (audit du 5/11) : abonnement arrêté (décès, entrée en EHPAD, fin voulue). La famille ne doit
// jamais lire « l'abonnement doit être réglé » : rien n'est à régler, elle a choisi d'arrêter. Captures dans
// captures/mauvais-jours/ (CAPTURES=<dossier> pour les ranger ailleurs).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const banc = require('../banc');
const g = require('../gestes');

const { s } = banc;
const FONCTIONS = process.env.PAPOTE_FONCTIONS || path.join(__dirname, '..', '.fonctions', 'functions');
const decesConnuDesFonctions = () => fs.readFileSync(path.join(FONCTIONS, 'index.js'), 'utf8').includes("motif === 'deces'");

banc.brancher();

const DOSSIER = process.env.CAPTURES || path.join(__dirname, '..', 'captures', 'mauvais-jours');
async function capture(t, nom) {
  await t.page.waitForTimeout(500); // fin des fondus des fenêtres
  await fs.promises.mkdir(DOSSIER, { recursive: true });
  await t.page.screenshot({ path: path.join(DOSSIER, `${nom}.png`) });
}

test('Abonnement arrêté (résilié) : aucun « doit être réglé », ni pour la responsable ni pour un proche', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const paul = await banc.telephone('Paul');
  await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });

  // L'arrêt demandé est arrivé à sa date (Stripe « canceled ») : la famille passe « resilie ».
  await s.db.doc(`families/${fid}`).update({ 'abonnement.statut': 'resilie', 'abonnement.resiliationLe': null });
  await julie.page.locator('#abo-banner').waitFor({ state: 'visible' });
  await paul.page.locator('#abo-banner').waitFor({ state: 'visible' });
  await capture(julie, 'A-responsable-accueil-resilie');
  await capture(paul, 'A-proche-accueil-resilie');
  const bandeauJulie = await julie.page.locator('#abo-banner').innerText();
  const bandeauPaul = await paul.page.locator('#abo-banner').innerText();
  for (const [qui, texte] of [['responsable', bandeauJulie], ['proche', bandeauPaul]]) {
    assert.doesNotMatch(texte, /régl/, `bandeau ${qui} : « ${texte} »`);
    assert.match(texte, /arrêté/, `bandeau ${qui} : dit que l'abonnement est arrêté`);
  }
  assert.strictEqual(await julie.page.locator('#abo-banner-btn').isVisible(), false, 'pas de bouton « Régler »');
  assert.strictEqual(await julie.page.locator('#abo-banner-paid').isVisible(), false, 'pas de « Déjà commandé ? » sous le bandeau');

  // Un proche qui veut encore envoyer un message : explication juste, pas « doit être réglé ».
  await g.ouvrirTuile(paul, 'messages');
  await paul.page.fill('#message-text', 'Coucou');
  await paul.page.click('#btn-message');
  const fenetre = await g.texteFenetre(paul);
  await capture(paul, 'A-proche-envoi-refuse-resilie');
  assert.doesNotMatch(fenetre, /régl/, `fenêtre : « ${fenetre} »`);
  assert.match(fenetre, /arrêté/);
  await g.repondre(paul, 'OK');
  await paul.page.click('#view-messages .back');

  // Impayé suspendu : l'ancien texte reste (c'est bien à régler).
  await s.db.doc(`families/${fid}`).update({ 'abonnement.statut': 'suspendu', 'abonnement.stripeSubscriptionId': 'sub_x' });
  await paul.page.locator('#abo-banner', { hasText: 'réglé par un responsable' }).waitFor();
});

test('Décès : « Votre proche est décédé ? » arrête Papote en un geste, sans « Avant de partir » ni « Merci de rester »', async (t) => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  s.avancer(31);
  s.stripe.finirEssai(tab.commande);
  await s.calme();
  await julie.page.reload();
  await g.attendreVue(julie, 'view-home');
  await julie.page.click('.nav-item[data-tab="profile"]');
  await g.attendreVue(julie, 'view-profile');
  await julie.page.click('#btn-abo-page');
  await g.attendreVue(julie, 'view-abonnement');
  await julie.page.locator('#btn-resilier-deces').waitFor({ state: 'visible' });
  await capture(julie, 'B-page-abonnement-bouton-deces');
  await julie.page.click('#btn-resilier-deces');
  const question = await g.texteFenetre(julie);
  await capture(julie, 'B-question-deces');
  assert.match(question, /sincèrement désolés/);
  assert.doesNotMatch(question, /perdra|Avant de partir/);
  assert.match(question, /deux mois/, 'après un décès : deux mois pour rendre la tablette');
  // « Arrêter Papote » touché deux fois : un seul appel, une seule confirmation.
  await g.doubleAppui(julie, '.dialog-back:not(.closing) .dialog button:has-text("Arrêter Papote")');
  assert.match(await g.texteFenetre(julie), /Toutes nos pensées vous accompagnent/);
  await julie.page.waitForTimeout(300);
  assert.strictEqual(await g.fenetresOuvertes(julie), 1, 'une seule confirmation');
  await capture(julie, 'B-confirmation-deces');
  await g.repondre(julie, 'OK');
  await s.calme();
  assert.strictEqual(g.nbAppels('resilierAbonnement'), 1, 'arrêt demandé une seule fois');
  assert.ok((await g.lire(`families/${fid}`)).abonnement.resiliationLe, 'arrêt prévu');
  await julie.page.locator('#btn-resilier-deces').waitFor({ state: 'hidden' });
  // Le motif et les e-mails de deuil viennent des fonctions (correctif décès de main) : vérifiés dès qu'elles le
  // connaissent. Avant, l'arrêt est une résiliation ordinaire côté serveur (l'app, elle, est déjà juste).
  if (decesConnuDesFonctions()) {
    assert.strictEqual((await g.lire(`commandes/${tab.commande}`)).motif, 'deces', 'motif noté');
    assert.strictEqual(g.dernierMail('julie@exemple.fr').sujet, 'Nous pensons bien à vous');
  } else {
    t.diagnostic('Fonctions sans le correctif décès : motif et e-mail de deuil non vérifiés.');
  }
});
