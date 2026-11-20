// Clavier ouvert : la zone où l'on écrit touche le clavier, sans trou par où l'on voit la page derrière
// (Tanguy, 11/11 : Messages ouvert depuis la barre du bas, un vide entre le champ et le clavier ; Messages s'ouvre
// depuis sa tuile depuis le 20/11).
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

/** La barre du bas finit cachée (ou visible) : WebKit lent (iPhone 15 en CI) peut traiter le redimensionnement après 300 ms. */
async function barre(t, visible, message) {
  try { await t.page.locator('#nav').waitFor({ state: visible ? 'visible' : 'hidden', timeout: 3000 }); } catch { assert.fail(message); }
}

async function ecrire(t, champ) {
  await t.page.locator(champ).tap();
  await g.clavier(t, true);
  await t.page.waitForTimeout(300);
  assert.strictEqual(await t.page.evaluate((s) => document.activeElement === document.querySelector(s), champ), true, 'le champ garde la main');
}

// Messages n'est plus dans la barre du bas (Réglages à sa place, Tanguy, 20/11) : la zone d'écriture des Messages est
// vérifiée depuis la tuile (plus bas) ; la barre du bas qui se cache et revient avec le clavier, sur Réglages.
test('Réglages ouvert depuis la barre du bas, clavier ouvert : la barre se cache, revient, et ne couvre pas le champ', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await julie.page.click('#nav-reglages');
  await g.attendreVue(julie, 'view-settings');
  assert.ok(await julie.page.evaluate(() => document.body.classList.contains('depuis-barre')), 'arrivé par la barre du bas');
  await julie.page.click('#family-name-card h2');
  await julie.page.locator('#form-family-name').waitFor();
  await ecrire(julie, '#family-name');
  await barre(julie, false, 'barre du bas cachée, clavier ouvert');
  // Clavier refermé par le bouton retour d'Android : le champ garde la main, mais la barre du bas revient
  // (Tanguy, 11/11 : les boutons du bas disparaissaient).
  await g.clavier(julie, false);
  await julie.page.waitForTimeout(300);
  assert.ok(await julie.page.evaluate(() => document.activeElement.id === 'family-name'), 'le champ garde la main (comme sur Android)');
  await barre(julie, true, 'la barre du bas revient quand le clavier se ferme');
  // Rouvert puis refermé une 2e fois : pareil.
  await g.clavier(julie, true);
  await julie.page.waitForTimeout(300);
  await barre(julie, false, 'barre cachée, clavier rouvert');
  await g.clavier(julie, false);
  await julie.page.waitForTimeout(300);
  await barre(julie, true, 'barre revenue');
  // Tout en bas de Réglages, la dernière carte passe au-dessus de la barre du bas.
  await julie.page.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, document.body.scrollHeight); });
  await julie.page.waitForTimeout(300);
  const [barre, fin] = await julie.page.evaluate(() => {
    const cartes = [...document.querySelectorAll('#view-settings > :not([hidden])')].filter((e) => e.offsetParent);
    return [document.getElementById('nav').getBoundingClientRect().top, cartes[cartes.length - 1].getBoundingClientRect().bottom];
  });
  assert.ok(fin <= barre, `bas de Réglages caché sous la barre du bas (${fin} > ${barre})`);
});

test('Téléphone tourné, champ actif sans clavier : la barre du bas reste là', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await julie.page.click('#nav-reglages');
  await g.attendreVue(julie, 'view-settings');
  await julie.page.click('#family-name-card h2');
  await julie.page.locator('#family-name').focus();
  await g.tourner(julie, true);
  await julie.page.waitForTimeout(300);
  assert.ok(await julie.page.locator('#nav').isVisible(), 'passer en paysage n\'est pas un clavier');
  await g.tourner(julie, false);
});

test('Messages ouvert depuis la tuile de l\'accueil, clavier ouvert : la zone d\'écriture touche le clavier', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const tuile = julie.page.locator('.tile[data-page="messages"]');
  assert.ok(await tuile.isVisible(), 'la tuile Messages est le seul chemin vers les Messages : elle doit rester');
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
