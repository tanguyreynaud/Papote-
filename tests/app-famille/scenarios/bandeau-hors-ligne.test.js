// Bandeau « Pas de connexion pour le moment » (19/11) : il restait affiché sur un téléphone pourtant connecté.
// Il n'apparaissait que sur l'événement « offline » et ne partait que sur « online » : un événement manqué
// (page gelée par Chrome, téléphone en veille, passage Wi-Fi ↔ 4G) le laissait collé pour toujours.
// Maintenant : affiché seulement si internet ne répond vraiment pas, et revérifié toutes les 5 s.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

const RESEAU = /ERR_INTERNET_DISCONNECTED|ERR_FAILED|Could not reach Cloud Firestore|WebChannelConnection|net::|Failed to fetch/;
const bandeau = (t) => t.page.locator('#hors-ligne-bandeau');

test('Faux « offline » alors qu\'internet marche : jamais de bandeau', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie.bandeau1@exemple.fr', prenom: 'Julie' });
  // Chrome Android annonce « hors ligne » (navigator.onLine à false) pendant un changement de réseau, puis rien.
  await julie.page.evaluate(() => {
    Object.defineProperty(Navigator.prototype, 'onLine', { get: () => false, configurable: true });
    window.dispatchEvent(new Event('offline'));
  });
  await julie.page.waitForTimeout(6000);
  assert.strictEqual(await bandeau(julie).isHidden(), true, 'internet répond : pas de bandeau « Pas de connexion »');
});

test('Vraie coupure : bandeau ; retour du réseau sans événement « online » : le bandeau part tout seul', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie.bandeau2@exemple.fr', prenom: 'Julie' });
  banc.tolerer(julie, RESEAU);

  await g.reseau(julie, true);
  await bandeau(julie).waitFor({ state: 'visible', timeout: 15_000 });

  // L'événement « online » n'arrive jamais à la page (page gelée pendant le retour du réseau).
  await julie.page.evaluate(() => window.addEventListener('online', (e) => e.stopImmediatePropagation(), true));
  await g.reseau(julie, false);
  await bandeau(julie).waitFor({ state: 'hidden', timeout: 15_000 })
    .catch(() => assert.fail('réseau revenu depuis 15 s, le bandeau « Pas de connexion » est toujours là'));
});

test('Retour sur l\'app après la veille : le bandeau collé disparaît aussitôt', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie.bandeau3@exemple.fr', prenom: 'Julie' });
  // Bandeau resté d'avant la veille, réseau revenu sans événement.
  await julie.page.evaluate(() => {
    const b = document.getElementById('hors-ligne-bandeau');
    b.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await bandeau(julie).waitFor({ state: 'hidden', timeout: 4000 })
    .catch(() => assert.fail('au retour sur l\'app, le bandeau aurait dû être revérifié et retiré'));
});
