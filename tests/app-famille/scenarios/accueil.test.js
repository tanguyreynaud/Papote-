// Accueil de l'app : la carte « Envoyer une photo » en haut, et la tuile Photos qui laisse la
// place à « Appeler par téléphone » dès que la tablette a un numéro (carte SIM).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

const capture = (t, nom) => t.page.screenshot({ path: path.join(__dirname, '..', 'captures', 'accueil', `${nom}.png`) });

test('Accueil : « Envoyer une photo » en haut ; tuile Photos remplacée par « Appeler par téléphone » quand la tablette a un numéro', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });

  // Sans numéro : six tuiles dont Photos, pas de tuile téléphone.
  await julie.page.locator('#tile-photo').waitFor({ state: 'visible' });
  assert.ok(await julie.page.locator('#tile-phone').isHidden());
  assert.strictEqual(await julie.page.locator('.tiles .tile:visible').count(), 6);
  await capture(julie, 'sans-numero');

  // La carte du haut ouvre l'envoi de photo, sans passer par la page Photos.
  await julie.page.click('#photo-nudge');
  await julie.page.locator('#sheet-post').waitFor({ state: 'visible' });
  assert.strictEqual(await julie.page.locator('#post-title').textContent(), 'Envoyer une photo');
  await julie.page.click('#post-close');
  await julie.page.locator('#sheet-post').waitFor({ state: 'hidden' });
  await g.attendreVue(julie, 'view-home');

  // La tablette reçoit un numéro (carte SIM reliée par Tanguy) : la tuile change toute seule.
  await banc.s.db.doc(`families/${fid}/members/${tab.tabletUid}`).update({ telephone: '06 98 76 54 32' });
  await julie.page.locator('#tile-phone').waitFor({ state: 'visible' });
  assert.ok(await julie.page.locator('#tile-photo').isHidden());
  assert.strictEqual(await julie.page.locator('#tile-phone').getAttribute('href'), 'tel:0698765432');
  assert.strictEqual(await julie.page.locator('.tiles .tile:visible').count(), 6);
  await capture(julie, 'avec-numero');

  // Photos reste à portée dans la barre du bas.
  await g.ouvrirTuile(julie, 'photos');
  await julie.page.locator('#photos li.shot').first().waitFor();
  await g.retourAccueil(julie);

  // Numéro retiré (SIM enlevée) : la tuile Photos revient.
  await banc.s.db.doc(`families/${fid}/members/${tab.tabletUid}`).update({ telephone: '' });
  await julie.page.locator('#tile-photo').waitFor({ state: 'visible' });
  assert.ok(await julie.page.locator('#tile-phone').isHidden());
});
