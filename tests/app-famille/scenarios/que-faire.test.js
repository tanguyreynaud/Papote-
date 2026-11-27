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
  // La durée est déjà dans le bandeau juste derrière : la fenêtre ne la redit plus (2e épuration, 26/11).
  assert.doesNotMatch(fenetre, /Aucune nouvelle de la tablette/);
  assert.match(fenetre, /Vous êtes loin \? Appelez Mamie Emma ou un voisin.*vérifier que la tablette est branchée et que son écran est allumé/s);
  assert.match(fenetre, /Écran noir : il faut la rallumer.*appuyer 3 secondes sur le bouton marche\/arrêt/s);
  assert.match(fenetre, /Elle revient toute seule/);
  assert.strictEqual(await julie.page.locator('.dialog-etapes li').count(), 3);
  await julie.page.waitForTimeout(400);
  if (process.env.CAPTURE) await julie.page.screenshot({ path: process.env.CAPTURE });
  await g.repondre(julie, 'Plus d\'aide : dépanner la tablette');
  await julie.page.locator('#remote-card').waitFor({ state: 'visible' });
});

test('Assistant pas chargé : « Poser une question à l\'assistant » le dit au lieu de ne rien faire', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await julie.page.evaluate(() => { delete window.papoteChat; });
  await julie.page.click('#nav-reglages');
  await g.attendreVue(julie, 'view-settings');
  await julie.page.click('#view-settings [data-aide]');
  await g.attendreVue(julie, 'view-support');
  await julie.page.click('#support-assistant');
  assert.match(await g.texteFenetre(julie), /L'assistant ne répond pas pour l'instant/);
});

// « Besoin d'aide ? » dans Réglages et Mon profil : la même demande simple partout (Tanguy, 27/11 : une demande
// différente selon le réglage ouvert « perd plus qu'autre chose »).
test('« Besoin d\'aide ? » dans Réglages et Mon profil : la même demande simple, quel que soit le réglage ouvert', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await julie.page.evaluate(() => { window.demandes = []; window.papoteChat = { ouvrir: (d) => window.demandes.push(d) }; });
  const derniere = () => julie.page.evaluate(() => window.demandes[window.demandes.length - 1]);
  const aide = async (vue) => {
    await julie.page.click(`#${vue} .aide-pastille`);
    await g.attendreVue(julie, 'view-support');
    await julie.page.click('#view-support .page-head .back');
    await g.attendreVue(julie, vue);
    return derniere();
  };
  const SIMPLE = "J'ai besoin d'aide avec la tablette.";
  await julie.page.click('#nav-reglages');
  await g.attendreVue(julie, 'view-settings');
  assert.strictEqual(await aide('view-settings'), SIMPLE);
  await julie.page.click('#sleep-card .setting-modify');
  assert.strictEqual(await aide('view-settings'), SIMPLE);
  await julie.page.click('#sleep-card .setting-cancel');
  await g.ouvrirProfil(julie);
  assert.strictEqual(await aide('view-profile'), SIMPLE);
  // La page Aide elle-même : l'assistant s'ouvre, sans demande toute faite.
  await julie.page.click('#view-profile .aide-pastille');
  await g.attendreVue(julie, 'view-support');
  await julie.page.click('#support-assistant');
  assert.strictEqual(await derniere(), undefined);
});
