// Accueil de l'app : la carte « Envoyer une photo » en haut, et la tuile Photos qui laisse la
// place à « Appeler » (par téléphone, à gauche) dès que la tablette a un numéro (carte SIM).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

const capture = (t, nom) => t.page.screenshot({ path: path.join(__dirname, '..', 'captures', 'accueil', `${nom}.png`) });

test('Accueil : « Envoyer une photo » en haut ; tuile Photos remplacée par « Appeler » quand la tablette a un numéro', async () => {
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

// Proche sans numéro (« Je n'ai pas de numéro, ou un numéro étranger ») : la tablette refuserait son appel.
// « Appeler » reste à sa place mais grisée ; la toucher n'appelle pas et mène au numéro dans Profil (Tanguy, 13/11).
test('Accueil : proche sans numéro : « Appeler » grisée, la toucher mène au numéro, puis elle redevient normale', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie2@exemple.fr', prenom: 'Julie' });
  await banc.s.db.doc(`families/${fid}/members/${tab.tabletUid}`).update({ telephone: '06 98 76 54 32' });
  const membres = await banc.s.db.collection(`families/${fid}/members`).get();
  const fiche = membres.docs.find((d) => d.get('email') === 'julie2@exemple.fr');
  // Comme si Julie avait coché « Je n'ai pas de numéro, ou un numéro étranger » (rien n'est réécrit sur sa fiche).
  await julie.page.evaluate(() => localStorage.setItem('papote.telephone', 'aucun'));
  await fiche.ref.update({ telephone: '' });
  await julie.page.reload();
  await g.attendreVue(julie, 'view-home');
  const tuile = julie.page.locator('#tile-phone');
  await tuile.waitFor({ state: 'visible' });
  await julie.page.waitForFunction(() => document.querySelector('#tile-phone').classList.contains('tile-off'));
  assert.strictEqual(await tuile.getAttribute('href'), 'tel:', 'aucun numéro composé');
  assert.ok(await julie.page.locator('#tile-phone .tile-note').isVisible());
  assert.strictEqual(await julie.page.locator('.tiles .tile:visible').count(), 6, 'six tuiles, rien ne bouge');
  assert.ok(await julie.page.locator('#contact-encart').isHidden(), 'la tablette ne l\'appellera pas : pas de « Enregistrez le numéro »');
  await capture(julie, 'appeler-grisee');
  // Double toucher : une seule ouverture du numéro, aucun appel.
  await tuile.dblclick();
  await julie.page.locator('#my-tel-card.editing').waitFor({ state: 'visible' });
  assert.ok(await julie.page.locator('#my-tel').isVisible());
  await julie.page.fill('#my-tel', '0611223344');
  await julie.page.locator('#form-my-tel button[type=submit]').click();
  await julie.page.locator('#my-tel-card:not(.editing)').waitFor();
  await g.retourAccueil(julie);
  await julie.page.waitForFunction(() => !document.querySelector('#tile-phone').classList.contains('tile-off'));
  assert.strictEqual(await tuile.getAttribute('href'), 'tel:0698765432');
  assert.ok(await julie.page.locator('#tile-phone .tile-note').isHidden());
});
