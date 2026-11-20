// SOS de la tablette, vu par les proches dans l'app : toute la famille sonne (« Mamie Emma vous appelle »),
// le premier qui répond l'emporte, la sonnerie s'arrête chez les autres. Sans réponse, la tablette réessaie
// (2e essai), puis la page Notifications le raconte. Avec les gestes de tous les jours (double appui sur
// « Répondre », bouton retour d'Android, page rechargée) et un téléphone qui perd le réseau pendant la sonnerie.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');
const tablette = require('../tablette');

banc.brancher();

const RESEAU = /ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|ERR_FAILED|net::|Failed to fetch|Could not reach|WebChannel|Backend|unavailable/;
// Chrome bloque le vibreur tant que la page n'a pas été touchée (sonnerie arrivée avant tout toucher) : prévu.
const VIBREUR = /Blocked call to navigator\.vibrate/;

async function notifications(t) {
  await t.page.click('#btn-bell');
  await g.attendreVue(t, 'view-notifs');
}

// La tablette arrête de sonner sans réponse (60 s écoulées, ou Mamie annule).
async function sansReponse(mamie, cid) {
  await tablette.ref(mamie, cid).update({ state: 'missed', endedAt: banc.s.FieldValue.serverTimestamp() });
  await mamie.page.evaluate(() => window.pc && window.pc.close());
  await mamie.arreterRelais?.();
}

test('SOS : Julie et Paul sonnent ; retour d\'Android ne coupe pas la sonnerie ; double appui sur « Répondre » = une réponse, jamais d\'appel caché ; Notifications le racontent', async () => {
  const julie = await banc.telephone('Julie');
  // Julie a l'app Android (Ouverture.java ajoute ?quitter=1 ; Chrome donne son referrer) : c'est son bouton
  // retour qu'on essaie pendant la sonnerie. Dans un simple onglet, l'entrée d'avant l'accueil est un autre
  // document (ici le lien de connexion) : « retour » quittait la page, la sonnerie ne revenait qu'avec la page
  // rechargée, à temps ou non selon le moteur (iPhone 15, 18/11).
  await g.ouvrirParApp(julie, '?quitter=1&cle=c1e5ecrete');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const paul = await banc.telephone('Paul');
  const uidPaul = await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });
  // Un premier toucher sur l'accueil pose l'étape « sortie » de l'app sous l'accueil (famille.js).
  await julie.page.click('#view-home .brand', { position: { x: 10, y: 10 } }); // à gauche : la roue Réglages est au milieu du titre
  const mamie = await tablette.ouvrir(fid, tab);

  const cid = await tablette.appeler(mamie, { sos: 1 });
  for (const t of [julie, paul]) {
    await t.page.locator('#incoming').waitFor({ state: 'visible' });
    assert.strictEqual(await t.page.locator('#incoming-name').innerText(), 'Mamie Emma');
  }
  // Retour d'Android pendant la sonnerie : rien ne se ferme, ça sonne toujours, la page ne part pas, pas de
  // « Voulez-vous quitter Papote ? » ; l'app remonte d'elle-même au-dessus de l'étape « sortie ».
  await julie.page.evaluate(() => { window.__avantRetour = true; });
  await julie.page.goBack();
  await julie.page.waitForFunction(() => !history.state?.sortie);
  assert.strictEqual(await julie.page.evaluate(() => window.__avantRetour === true), true, 'retour ne quitte pas la page');
  assert.strictEqual(await julie.page.locator('#incoming').isVisible(), true, 'la sonnerie reste à l\'écran');
  assert.strictEqual(await julie.page.locator('.dialog-back:not(.closing) .dialog').count(), 0, 'pas de question pendant la sonnerie');

  // Paul répond d'un double appui : une seule réponse. Le 2e appui tombe sur « Raccrocher » (à la place de
  // « Répondre »), qui ne répond pas pendant 4 s : l'appel reste pris, écran ouvert (décision Tanguy 4/11).
  await g.doubleAppui(paul, '#incoming-answer');
  const { answer } = await g.attendreBase(async () => { const d = (await tablette.ref(mamie, cid).get()).data(); return d.answer && d; }, 'réponse de Paul');
  assert.strictEqual(answer.uid, uidPaul);
  assert.strictEqual(await paul.page.locator('#call-hangup').isDisabled(), true, '« Raccrocher » grisé juste après la réponse');
  await mamie.page.evaluate((a) => window.pc.setRemoteDescription({ type: a.type, sdp: a.sdp }), answer).catch(() => {});
  await julie.page.locator('#incoming').waitFor({ state: 'hidden' });
  await paul.page.waitForTimeout(2500);
  const etat = (await tablette.ref(mamie, cid).get()).data().state;
  assert.strictEqual(await paul.page.locator('#call').isVisible(), true, 'le double appui ne raccroche pas');
  assert.notStrictEqual(etat, 'ended', 'le double appui ne raccroche pas');
  await paul.page.locator('#call-timer', { hasText: /0:0\d/ }).waitFor();
  // Après 4 s, « Raccrocher » marche de nouveau.
  await paul.page.locator('#call-hangup:not([disabled])').waitFor({ timeout: 5_000 });
  await paul.page.click('#call-hangup');
  await g.attendreBase(async () => (await tablette.ref(mamie, cid).get()).data().state === 'ended', 'appel terminé');
  await paul.page.locator('#call').waitFor({ state: 'hidden', timeout: 10_000 });
  await mamie.arreterRelais?.();

  // Notifications : le SOS et qui a répondu, chez les deux.
  await notifications(julie);
  await julie.page.locator('#notifs li', { hasText: 'Mamie Emma a appuyé sur SOS : Paul a répondu' }).waitFor();
  await notifications(paul);
  await paul.page.locator('#notifs li', { hasText: 'Mamie Emma a appuyé sur SOS : vous avez répondu' }).waitFor();
  for (const t of [julie, paul]) banc.tolerer(t, VIBREUR);
});

test('SOS sans réponse puis 2e essai : téléphone sans réseau pendant la sonnerie, page rechargée ; Notifications « personne n\'a pu répondre »', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const mamie = await tablette.ouvrir(fid, tab);

  // Julie est dans le métro : le SOS sonne pendant qu'elle n'a pas de réseau, puis le réseau revient.
  await julie.context.setOffline(true);
  const cid1 = await tablette.appeler(mamie, { sos: 1 });
  await julie.page.waitForTimeout(1500);
  assert.strictEqual(await julie.page.locator('#incoming').isVisible(), false, 'rien ne peut sonner sans réseau');
  await julie.context.setOffline(false);
  await julie.page.locator('#incoming').waitFor({ state: 'visible', timeout: 30_000 });

  // Page rechargée pendant la sonnerie : ça sonne encore.
  await julie.page.reload();
  await g.attendreVue(julie, 'view-home');
  await julie.page.locator('#incoming').waitFor({ state: 'visible', timeout: 20_000 });

  // Personne ne répond : la sonnerie s'arrête, la tablette réessaie aussitôt (2e essai), qui sonne à nouveau.
  await sansReponse(mamie, cid1);
  await julie.page.locator('#incoming').waitFor({ state: 'hidden' });
  const cid2 = await tablette.appeler(mamie, { sos: 2 });
  await julie.page.locator('#incoming').waitFor({ state: 'visible' });
  await sansReponse(mamie, cid2);
  await julie.page.locator('#incoming').waitFor({ state: 'hidden' });
  await banc.s.calme();

  // Notifications : le SOS manqué, en rouge, dit clairement.
  await notifications(julie);
  const manque = julie.page.locator('#notifs li.missed', { hasText: 'Mamie Emma a appuyé sur SOS : personne n\'a pu répondre' });
  await manque.first().waitFor();
  assert.strictEqual(await julie.page.locator('#notifs li', { hasText: /appel de Mamie Emma|pour SOS/ }).count(), 0, 'pas de phrase à l\'envers');
  banc.tolerer(julie, RESEAU);
  banc.tolerer(julie, VIBREUR);
});
