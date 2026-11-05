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

banc.brancher();

const DOSSIER = process.env.CAPTURES || path.join(__dirname, '..', 'captures', 'mauvais-jours');
async function capture(t, nom) {
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
