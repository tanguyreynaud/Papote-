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
  // 4 h : au-delà de la tolérance de nuit (3 h, silence.js), quelle que soit l'heure du banc.
  const ilYa4h = s.Timestamp.fromMillis(Date.now() - 4 * 3600_000);
  await s.db.doc(`families/${fid}/members/${tab.id}`).update({ lastOnline: ilYa4h, lastActive: ilYa4h });
  await julie.page.locator('#activity.warn', { hasText: 'ne répond plus' }).waitFor();
  assert.match(await julie.page.locator('#activity').innerText(), /^La tablette de Mamie Emma ne répond plus depuis 4 h\.\s+Peut-être éteinte : demandez à Mamie Emma de la brancher\.\s+Que faire \?$/);
  if (process.env.CAPTURE) await julie.page.screenshot({ path: process.env.CAPTURE });
  await julie.page.locator('#activity button', { hasText: 'Que faire ?' }).click();
  const fenetre = await g.texteFenetre(julie);
  assert.match(fenetre, /Que faire \?/);
  assert.match(fenetre, /Aucune nouvelle de la tablette depuis 4 h/);
  assert.match(fenetre, /Son écran est-il allumé \?.*Demandez-le à Mamie Emma/s);
  assert.match(fenetre, /Écran noir : rallumez-la.*appuyez 3 secondes sur le bouton marche\/arrêt/s);
  assert.match(fenetre, /Elle revient toute seule/);
  assert.strictEqual(await julie.page.locator('.dialog-etapes li').count(), 3);
  await julie.page.waitForTimeout(400);
  if (process.env.CAPTURE) await julie.page.screenshot({ path: process.env.CAPTURE });
  await g.repondre(julie, 'Plus d\'aide : dépanner la tablette');
  await julie.page.locator('#remote-card').waitFor({ state: 'visible' });
});
