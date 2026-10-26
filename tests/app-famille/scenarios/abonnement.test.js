// Abonnement dans l'app : annulation de la commande dans les 30 jours, résiliation puis « garder »,
// tablette installée sans commande (relier par code, ou payer depuis l'app), pause et retard de paiement.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

const { s, acteurs } = banc;

banc.brancher();

async function profil(t) {
  await t.page.click('.nav-item[data-tab="profile"]');
  await g.attendreVue(t, 'view-profile');
  await t.page.locator('#abo-card').waitFor({ state: 'visible' });
}

const famille = (fid) => g.lire(`families/${fid}`);

test('Dans les 30 jours : seule « Annuler ma commande » est proposée ; annulation et tablette à renvoyer', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await profil(julie);
  await julie.page.locator('#abo-status', { hasText: 'Actif' }).waitFor();
  assert.match(await julie.page.locator('#abo-details').innerText(), /Avec le Wi-Fi de la maison, 20 € par mois, tablette prêtée · Prochain prélèvement le/);
  await julie.page.locator('#btn-retracter').waitFor({ state: 'visible' });
  assert.match(await julie.page.locator('#retract-info').innerText(), /Annulation possible jusqu'au .* 60 € de mise en service compris/);
  assert.strictEqual(await julie.page.locator('#btn-resilier').isVisible(), false, 'pas de « Résilier » pendant les 30 jours');
  assert.strictEqual(await julie.page.locator('#btn-portail').isVisible(), true);

  await julie.page.click('#btn-retracter');
  assert.match(await g.texteFenetre(julie), /Annuler votre commande \? Votre abonnement s'arrête tout de suite/);
  await g.repondre(julie, 'Annuler ma commande');
  assert.match(await g.texteFenetre(julie), /Commande annulée/);
  await g.repondre(julie, 'OK');
  await s.calme();
  const fam = await famille(fid);
  assert.ok(['resilie', 'aucun'].includes(fam.abonnement.statut), `statut ${fam.abonnement.statut}`);
  await julie.page.locator('#retour-box', { hasText: 'Tablette à nous rendre' }).waitFor();
  assert.ok(g.dernierMail('julie@exemple.fr'), 'e-mail avec les instructions de retour');
  // Plus d'envoi possible : Papote est en pause.
  await julie.page.click('.nav-item[data-tab="home"]');
  await julie.page.locator('#abo-banner', { hasText: 'Papote est en pause' }).waitFor();
});

test('Après 30 jours : résilier (avec l\'étape « Avant de partir »), puis garder son abonnement', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  s.avancer(31);
  s.stripe.finirEssai(tab.commande);
  await s.calme();
  await julie.page.reload();
  await g.attendreVue(julie, 'view-home');
  await profil(julie);
  await julie.page.locator('#btn-resilier').waitFor({ state: 'visible' });
  assert.strictEqual(await julie.page.locator('#btn-retracter').isVisible(), false);

  // « Garder Papote » : rien ne change.
  await julie.page.click('#btn-resilier');
  assert.match(await g.texteFenetre(julie), /Avant de partir[\s\S]*Mamie Emma perdra/);
  await g.repondre(julie, 'Garder Papote');
  await g.toast(julie, 'Merci de rester avec Papote');
  assert.ok(!(await famille(fid)).abonnement.resiliationLe);

  await julie.page.click('#btn-resilier');
  await g.repondre(julie, 'Résilier quand même');
  assert.match(await g.texteFenetre(julie), /Résiliation enregistrée\. Papote s'arrêtera le/);
  await g.repondre(julie, 'OK');
  await s.calme();
  await julie.page.locator('#abo-details', { hasText: 'Résilié : Papote s\'arrête le' }).waitFor();
  await julie.page.locator('#btn-garder').waitFor({ state: 'visible' });
  assert.strictEqual(await julie.page.locator('#btn-resilier').isVisible(), false);

  await julie.page.click('#btn-garder');
  await g.toast(julie, 'Abonnement gardé');
  await s.calme();
  await julie.page.locator('#btn-resilier').waitFor({ state: 'visible' });
  assert.ok(!(await famille(fid)).abonnement.resiliationLe, 'résiliation annulée');
});

test('Tablette installée sans commande : relier la commande payée par quelqu\'un d\'autre avec son code', async () => {
  const julie = await banc.telephone('Julie');
  await g.inscrire(julie, 'julie@exemple.fr', 'Julie');
  const tab = await g.tabletteAllumee();
  const fid = await g.installer(julie, tab).catch(async (e) => {
    // Sans commande, l'installation finit sur la page « pas encore activé » au lieu de l'accueil.
    if (!/view-home attendu, affiché : view-sans-abo/.test(e.message)) throw e;
    return julie.page.evaluate(() => localStorage.getItem('papote.fid'));
  });
  await g.attendreVue(julie, 'view-sans-abo');
  assert.strictEqual(await julie.page.locator('.guide-back').count(), 0, 'pas de guide tant que la tablette attend son abonnement');
  assert.strictEqual((await famille(fid)).abonnement.statut, 'aucun');
  await julie.page.click('#sans-abo-deja');
  await julie.page.fill('#sans-abo-panel-deja .order-code', 'ZZZZZZZZ');
  assert.strictEqual(await julie.page.inputValue('#sans-abo-panel-deja .order-code'), 'ZZZZ-ZZZZ', 'tiret ajouté tout seul');
  await julie.page.click('#sans-abo-panel-deja button[type=submit]');
  assert.match(await g.texteFenetre(julie), /Ce code de commande est inconnu/);
  await g.repondre(julie, 'OK');
  banc.tolerer(julie, /FirebaseError|not-found|Aucune commande/);

  // Paul avait commandé sur le site avec son adresse.
  const { abonnement } = await acteurs.commanderEtPayer({ email: 'paul@exemple.fr' });
  const { code } = await g.lire(`commandes/${abonnement}`);
  await julie.page.fill('#sans-abo-panel-deja .order-code', code);
  await julie.page.click('#sans-abo-panel-deja button[type=submit]');
  await g.toast(julie, 'Commande reliée');
  await s.calme();
  await g.attendreVue(julie, 'view-home');
  // Une fois la tablette démarrée, le petit guide est proposé.
  await julie.page.locator('.guide-back .guide-skip').waitFor();
  await g.fermerAccueil(julie);
  assert.strictEqual((await famille(fid)).abonnement.statut, 'actif');
});

test('Tablette installée sans commande : prendre l\'abonnement depuis l\'app (page de paiement), retour « activé »', async () => {
  const julie = await banc.telephone('Julie');
  await g.inscrire(julie, 'julie@exemple.fr', 'Julie');
  const tab = await g.tabletteAllumee();
  const fid = await g.installer(julie, tab).catch(async (e) => {
    if (!/view-sans-abo/.test(e.message)) throw e;
    return julie.page.evaluate(() => localStorage.getItem('papote.fid'));
  });
  await g.attendreVue(julie, 'view-sans-abo');
  await julie.page.click('#sans-abo-prendre');
  const formule = julie.page.locator('#sans-abo-formules .abo-formule', { hasText: 'Internet inclus' });
  await formule.waitFor();
  const [requete] = await Promise.all([
    julie.page.waitForRequest((r) => r.url().startsWith('https://checkout.stripe.test/')),
    formule.click(),
  ]);
  const session = requete.url().split('/').pop();
  assert.strictEqual(banc.appels.find((a) => a.nom === 'creerPaiement').data.formule, 'sim');

  // Julie paie sur la page Stripe, puis revient dans l'app.
  s.stripe.payerSession(session, { email: 'julie@exemple.fr', nom: 'Julie Martin' });
  await s.calme();
  assert.strictEqual((await famille(fid)).abonnement.statut, 'actif');
  await julie.page.goto(`${banc.origine}/?abonnement=ok`);
  assert.match(await g.texteFenetre(julie), /Abonnement activé\. Merci/);
  await g.repondre(julie, 'OK');
  await g.attendreVue(julie, 'view-home');
  await g.fermerAccueil(julie);
});

test('En pause (paiement non réglé) : envois et appels bloqués avec une explication ; retard de paiement', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const paul = await banc.telephone('Paul');
  await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });

  // Retard de paiement : bandeau pour la propriétaire, rien de bloqué.
  const graceJusqua = s.Timestamp.fromMillis(Date.now() + 7 * s.JOUR);
  await s.db.doc(`families/${fid}`).update({ 'abonnement.statut': 'impaye', 'abonnement.graceJusqua': graceJusqua });
  await julie.page.locator('#abo-banner', { hasText: 'Le dernier paiement a échoué' }).waitFor();
  assert.strictEqual(await paul.page.locator('#abo-banner').isVisible(), false, 'les autres proches ne sont pas inquiétés');
  const [portail] = await Promise.all([
    julie.page.waitForRequest((r) => r.url().startsWith('https://billing.stripe.test/')),
    julie.page.click('#abo-banner-btn'),
  ]);
  assert.ok(portail);
  await julie.page.goto(banc.origine);
  await g.attendreVue(julie, 'view-home');

  // Suspendu : tout est en pause, avec une explication adaptée.
  await s.db.doc(`families/${fid}`).update({ 'abonnement.statut': 'suspendu' });
  await paul.page.locator('#abo-banner', { hasText: 'réglé par un responsable' }).waitFor();
  await g.ouvrirTuile(paul, 'messages');
  await paul.page.fill('#message-text', 'Coucou');
  await paul.page.click('#btn-message');
  assert.match(await g.texteFenetre(paul), /Papote est en pause : l'abonnement de la famille doit être réglé par un responsable/);
  await g.repondre(paul, 'OK');
  await paul.page.click('#view-messages .back');
  await g.ouvrirTuile(paul, 'photos');
  await paul.page.click('.fab[data-add="photo"]');
  assert.match(await g.texteFenetre(paul), /Papote est en pause/);
  await g.repondre(paul, 'OK');
  assert.strictEqual(await paul.page.locator('#sheet-post').isVisible(), false);
  await paul.page.click('#view-photos .back');
  await paul.page.click('#tile-call');
  assert.match(await g.texteFenetre(paul), /Papote est en pause/);
  await g.repondre(paul, 'OK');
  await julie.page.locator('#abo-banner', { hasText: 'Tout reviendra automatiquement' }).waitFor();
  assert.strictEqual((await g.liste(`families/${fid}/posts`)).some((p) => p.text === 'Coucou'), false);
});
