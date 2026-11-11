// Clavier ouvert : la zone où l'on écrit touche le clavier, sans trou par où l'on voit la page derrière
// (Tanguy, 11/11 : Messages ouvert depuis la barre du bas, un vide entre le champ et le clavier).
// La barre du bas se cache quand le clavier s'ouvre, mais la zone d'écriture restait posée au-dessus
// de la place qu'elle occupait. Vérifié par où l'on arrive (barre du bas, tuile), avec la vraie page.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

/** Écart en pixels entre le bas de la zone fixe qui contient le champ et le haut du clavier (bas de l'écran). */
const trouSousLeChamp = (t, champ) => t.page.evaluate((sel) => {
  let el = document.querySelector(sel);
  while (el && getComputedStyle(el).position !== 'fixed') el = el.parentElement;
  if (!el) return null;
  return Math.round(innerHeight - el.getBoundingClientRect().bottom);
}, champ);

async function ecrire(t, champ) {
  await t.page.locator(champ).tap();
  await g.clavier(t, true);
  await t.page.waitForTimeout(300);
  assert.strictEqual(await t.page.evaluate((s) => document.activeElement === document.querySelector(s), champ), true, 'le champ garde la main');
}

test('Messages ouvert depuis la barre du bas, clavier ouvert : la zone d\'écriture touche le clavier', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await julie.page.click('.nav-item[data-page="messages"]');
  await g.attendreVue(julie, 'view-messages');
  assert.ok(await julie.page.evaluate(() => document.body.classList.contains('depuis-barre')), 'arrivé par la barre du bas');
  await ecrire(julie, '#message-text');
  assert.ok(!(await julie.page.locator('#nav').isVisible()), 'barre du bas cachée, clavier ouvert');
  const trou = await trouSousLeChamp(julie, '#message-text');
  assert.ok(trou !== null && Math.abs(trou) <= 2, `trou de ${trou} px entre la zone d'écriture et le clavier`);
  // Clavier refermé par le bouton retour d'Android : le champ garde la main, mais la barre du bas revient,
  // et le champ reste entier au-dessus d'elle (Tanguy, 11/11 : les boutons du bas disparaissaient).
  await g.clavier(julie, false);
  await julie.page.waitForTimeout(300);
  assert.ok(await julie.page.evaluate(() => document.activeElement.id === 'message-text'), 'le champ garde la main (comme sur Android)');
  assert.ok(await julie.page.locator('#nav').isVisible(), 'la barre du bas revient quand le clavier se ferme');
  const [barre, champ] = await julie.page.evaluate(() => [document.getElementById('nav').getBoundingClientRect().top, document.getElementById('message-text').getBoundingClientRect().bottom]);
  assert.ok(champ <= barre, `champ caché sous la barre du bas (${champ} > ${barre})`);
  // Rouvert puis refermé une 2e fois : pareil.
  await g.clavier(julie, true);
  await julie.page.waitForTimeout(300);
  assert.ok(!(await julie.page.locator('#nav').isVisible()), 'barre cachée, clavier rouvert');
  await g.clavier(julie, false);
  await julie.page.waitForTimeout(300);
  assert.ok(await julie.page.locator('#nav').isVisible(), 'barre revenue');
});

test('Téléphone tourné, champ actif sans clavier : la barre du bas reste là', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await julie.page.click('.nav-item[data-page="messages"]');
  await g.attendreVue(julie, 'view-messages');
  await julie.page.locator('#message-text').focus();
  await julie.page.setViewportSize({ width: 844, height: 390 });
  await julie.page.waitForTimeout(300);
  assert.ok(await julie.page.locator('#nav').isVisible(), 'passer en paysage n\'est pas un clavier');
  await julie.page.setViewportSize({ width: 390, height: 844 });
});

test('Messages ouvert depuis la tuile de l\'accueil, clavier ouvert : la zone d\'écriture touche le clavier', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const tuile = julie.page.locator('.tile[data-page="messages"]');
  if (!(await tuile.isVisible())) return; // pas de tuile Messages sur cet accueil : couvert par le test d'avant
  await tuile.click();
  await g.attendreVue(julie, 'view-messages');
  await ecrire(julie, '#message-text');
  const trou = await trouSousLeChamp(julie, '#message-text');
  assert.ok(trou !== null && Math.abs(trou) <= 2, `trou de ${trou} px entre la zone d'écriture et le clavier`);
});

test('Photo : légende tapée clavier ouvert, depuis la barre du bas : la fenêtre d\'envoi touche le clavier', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await julie.page.click('.nav-item[data-page="photos"]');
  await g.attendreVue(julie, 'view-photos');
  await julie.page.click('.fab[data-add="photo"]');
  await julie.page.locator('#sheet-post').waitFor({ state: 'visible' });
  await julie.page.setInputFiles('#in-photo-gallery', await g.photo({ texte: 'Clavier' }));
  await g.visible(julie, '#btn-send').waitFor();
  await ecrire(julie, '#post-text');
  const trou = await trouSousLeChamp(julie, '#post-text');
  assert.ok(trou === null || Math.abs(trou) <= 2, `trou de ${trou} px entre la fenêtre d'envoi et le clavier`);
});
