// « Que faire ? » sous « La tablette ne répond plus » (Tanguy, 20/11) : 3 étapes concrètes dans une fenêtre,
// puis « Dépanner la tablette » en dessous (banc du 19/11 : on arrivait dans Dépanner sans consigne).

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

const { s } = banc;

banc.brancher();

test('Tablette muette : « Que faire ? » donne 3 étapes, puis mène à « Dépanner la tablette »', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const tab = (await g.liste(`families/${fid}/members`)).find((m) => m.role === 'tablette');
  const ilYa2h = s.Timestamp.fromMillis(Date.now() - 2 * 3600_000);
  await s.db.doc(`families/${fid}/members/${tab.id}`).update({ lastOnline: ilYa2h, lastActive: ilYa2h });
  await julie.page.locator('#activity.warn', { hasText: 'ne répond plus' }).waitFor();
  await julie.page.locator('#activity button', { hasText: 'Que faire ?' }).click();
  const fenetre = await g.texteFenetre(julie);
  assert.match(fenetre, /Que faire \?/);
  assert.match(fenetre, /1\. Demandez à Mamie Emma si l'écran de la tablette est allumé\./);
  assert.match(fenetre, /2\. S'il est noir : branchez le chargeur, puis appuyez 3 secondes sur le bouton marche\/arrêt/);
  assert.match(fenetre, /3\. La tablette se reconnecte ensuite toute seule/);
  await g.repondre(julie, 'Dépanner la tablette');
  await julie.page.locator('#remote-card').waitFor({ state: 'visible' });
});
