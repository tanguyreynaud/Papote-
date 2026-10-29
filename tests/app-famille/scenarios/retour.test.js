// Bouton retour d'Android dans l'app famille : chaque écran revient à celui d'avant, sans jamais
// sortir de l'app ; depuis l'accueil, l'app Android demande « Voulez-vous quitter Papote ? ».

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

/** Bouton retour d'Android, puis l'écran attendu. */
async function retour(t, ecran) {
  await t.page.goBack();
  await g.attendreVue(t, ecran);
}

const question = (t) => t.page.locator('.dialog-back:not(.closing) .dialog', { hasText: 'Voulez-vous quitter Papote ?' });

test('Retour : chaque écran ramène à celui d\'avant, une fenêtre se ferme sans changer d\'écran', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie.retour@exemple.fr', prenom: 'Julie' });

  // Notifications (cloche de l'accueil) : le bug du 29/10, retour sortait de l'app.
  await julie.page.click('#btn-bell');
  await g.attendreVue(julie, 'view-notifs');
  await retour(julie, 'view-home');

  // Profil, puis Aide depuis le Profil : les onglets partagent une étape, retour = accueil.
  await julie.page.click('.nav-item[data-tab="profile"]');
  await g.attendreVue(julie, 'view-profile');
  await julie.page.click('#view-profile .aide-card');
  await g.attendreVue(julie, 'view-support');
  await retour(julie, 'view-home');

  // Abonnement et paiement : retour au Profil.
  await julie.page.click('.nav-item[data-tab="profile"]');
  await g.attendreVue(julie, 'view-profile');
  if (await julie.page.locator('#btn-abo-page').isVisible()) {
    await julie.page.click('#btn-abo-page');
    await g.attendreVue(julie, 'view-abonnement');
    await retour(julie, 'view-profile');
  }

  // Une question ouverte (Se déconnecter ?) : retour = Annuler, on reste sur le Profil, connecté.
  await julie.page.click('#view-profile [data-action="logout"]');
  await julie.page.locator('.dialog-back:not(.closing) .dialog', { hasText: 'Se déconnecter' }).waitFor();
  await julie.page.goBack();
  await julie.page.locator('.dialog-back').waitFor({ state: 'detached' });
  await g.attendreVue(julie, 'view-profile');
  // L'étape du Profil est toujours là : retour ramène à l'accueil.
  await retour(julie, 'view-home');

  // Photos puis Messages par la barre du bas : retour = accueil.
  await julie.page.click('.nav-item[data-page="photos"]');
  await g.attendreVue(julie, 'view-photos');
  await julie.page.click('.nav-item[data-page="messages"]');
  await g.attendreVue(julie, 'view-messages');
  await retour(julie, 'view-home');

  // Profil puis « Accueil » de la barre : l'accueil, et retour ne revient pas sur le Profil.
  await julie.page.click('.nav-item[data-tab="profile"]');
  await g.attendreVue(julie, 'view-profile');
  await g.retourAccueil(julie);
  await julie.page.click('#btn-bell');
  await g.attendreVue(julie, 'view-notifs');
  await retour(julie, 'view-home');

  // Tuiles de l'accueil et « Inviter ».
  for (const tuile of ['photos', 'videos', 'messages', 'agenda', 'settings']) {
    await g.ouvrirTuile(julie, tuile);
    await retour(julie, 'view-home');
  }
  await julie.page.click('#btn-invite');
  await g.attendreVue(julie, 'view-invite');
  await retour(julie, 'view-home');

  // « Rejoindre une autre famille » depuis le Profil : retour = son bouton Retour, l'accueil ;
  // ensuite, retour depuis une page ramène à l'accueil, pas au Profil quitté.
  await julie.page.click('.nav-item[data-tab="profile"]');
  await julie.page.click('#view-profile [data-action="other-family"]');
  await g.attendreVue(julie, 'view-join');
  await retour(julie, 'view-home');
  await g.ouvrirTuile(julie, 'settings');
  await retour(julie, 'view-home');

  // Une feuille (envoi de photo) se ferme d'abord, puis la page.
  await g.ouvrirTuile(julie, 'photos');
  await julie.page.click('#view-photos .fab');
  await julie.page.locator('#sheet-post').waitFor({ state: 'visible' });
  await julie.page.goBack();
  await julie.page.locator('#sheet-post').waitFor({ state: 'hidden' });
  await g.attendreVue(julie, 'view-photos');
  await retour(julie, 'view-home');
});

test('App Android : retour depuis l\'accueil demande « Voulez-vous quitter Papote ? », dans la page', async () => {
  const lea = await banc.telephone('Léa');
  // Ouverte par l'app Android (Ouverture.java ajoute ?quitter=1).
  await g.ouvrir(lea, '?quitter=1');
  await g.familleInstallee(lea, { email: 'lea.retour@exemple.fr', prenom: 'Léa' });

  // Un premier toucher sur l'accueil pose l'étape « sortie » sous l'accueil.
  await lea.page.click('#view-home .brand');
  await lea.page.click('#btn-bell');
  await g.attendreVue(lea, 'view-notifs');
  await retour(lea, 'view-home');
  assert.strictEqual(await question(lea).count(), 0, 'pas de question en revenant des notifications');

  // Retour depuis l'accueil : la question, dans la page, l'accueil reste dessous.
  await lea.page.goBack();
  await question(lea).waitFor();
  await g.attendreVue(lea, 'view-home');
  const boutons = question(lea).locator('button');
  assert.deepStrictEqual(await boutons.allInnerTexts(), ['Rester', 'Quitter']);
  await lea.page.waitForTimeout(400); // fin de l'apparition
  const [a, b] = await Promise.all([boutons.nth(0).boundingBox(), boutons.nth(1).boundingBox()]);
  assert.ok(Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1, `deux boutons de même taille : ${JSON.stringify([a, b])}`);

  // « Rester » : l'accueil, et la question revient au retour suivant (l'étape est remise).
  await g.repondre(lea, 'Rester');
  await g.attendreVue(lea, 'view-home');
  await g.ouvrirTuile(lea, 'messages');
  await retour(lea, 'view-home');
  assert.strictEqual(await question(lea).count(), 0);
  await lea.page.goBack();
  await question(lea).waitFor();

  // « Quitter » : l'app Android est appelée pour fermer Papote (papote://quitter).
  const cdp = await lea.context.newCDPSession(lea.page);
  await cdp.send('Page.enable');
  const demandes = [];
  cdp.on('Page.frameRequestedNavigation', (e) => demandes.push(e.url));
  await question(lea).locator('button', { hasText: 'Quitter' }).click();
  for (let i = 0; i < 50 && !demandes.length; i++) await lea.page.waitForTimeout(100);
  assert.deepStrictEqual(demandes, ['intent://quitter#Intent;scheme=papote;package=fr.mapapote.famille;end']);
});
