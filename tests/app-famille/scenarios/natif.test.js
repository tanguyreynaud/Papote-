// Jeton de l'app Android (?natif=) : un lien piégé https://app.mapapote.fr/?natif=<jeton d'un autre> ne doit
// rien ranger avec le compte (sinon les sonneries et le jeton de connexion de l'écran d'appel partent chez lui).
// Vraies règles Firestore (émulateur) : c'est le téléphone du proche lui-même qui écrirait le jeton.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

const PIRATE = 'dJetonPirate:APA91b' + 'P'.repeat(140);
const VRAI = 'cVraiJeton:APA91b' + 'V'.repeat(140);

async function jetons(fid, uid) {
  const d = await banc.s.db.doc(`families/${fid}/members/${uid}/private/push`).get();
  return d.exists ? d.data() : {};
}

test('Lien piégé ?natif= : rien n’est rangé ; ouvert par l’app Android : seul son propre jeton', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie.natif@exemple.fr', prenom: 'Julie' });
  const uid = (await g.liste(`families/${fid}/members`)).find((m) => m.email === 'julie.natif@exemple.fr').id;

  // 1. Le lien reçu par SMS, ouvert dans le navigateur où Julie est connectée.
  await g.ouvrir(julie, `?natif=${PIRATE}`);
  await julie.page.locator('#tile-call').waitFor();
  await julie.page.waitForTimeout(2000);
  assert.deepStrictEqual((await jetons(fid, uid)).natifs || [], [], 'jeton pirate rangé avec le compte');

  // 2. Le même lien ouvert par l'app Android (App Link), qui ajoute son propre jeton à la fin.
  await julie.context.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'referrer', { get: () => 'android-app://fr.mapapote.famille/', configurable: true });
  });
  await g.ouvrir(julie, `?natif=${PIRATE}&quitter=1&natif=${VRAI}`);
  await julie.page.locator('#tile-call').waitFor();
  await julie.page.waitForTimeout(2000);
  const d = await jetons(fid, uid);
  assert.deepStrictEqual(d.natifs, [VRAI]);
  assert.strictEqual(d.natifsV, 2);
});

// L3 (audit sécurité du 11/11) : un lien https://app.mapapote.fr/#connexion=<jeton de son propre compte>, envoyé par un
// inconnu, connectait la page à SON compte sans qu'on le voie (ce qu'on envoyait ensuite partait chez lui). Le jeton
// n'est plus accepté qu'avec window.PapoteNatif (écran d'appel de l'app Android, voir appel-android.test.js).
test('L3 : lien #connexion= dans un navigateur : jeton ignoré, ni connexion à un autre compte, ni changement de compte', async () => {
  const pirate = await banc.admin.auth().createUser({ email: 'pirate@exemple.fr', emailVerified: true });
  const jeton = await banc.admin.auth().createCustomToken(pirate.uid);
  // 1. Personne n'est connecté sur ce téléphone : l'écran de connexion, pas le compte du pirate.
  const lea = await banc.telephone('Léa');
  await g.ouvrir(lea, `#connexion=${encodeURIComponent(jeton)}`);
  await g.attendreVue(lea, 'view-login', 30_000);
  assert.ok(!lea.page.url().includes('connexion='), 'le jeton ne reste pas dans l\'adresse');
  await lea.page.reload();
  await g.attendreVue(lea, 'view-login', 30_000);

  // 2. Julie, connectée dans sa famille, touche le lien : elle reste dans son compte et sa famille.
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie.l3@exemple.fr', prenom: 'Julie' });
  await g.ouvrir(julie, `#connexion=${encodeURIComponent(jeton)}`);
  await g.attendreVue(julie, 'view-home', 30_000);
  assert.strictEqual(await julie.page.evaluate(() => localStorage.getItem('papote.fid')), fid);
  await julie.page.click('.nav-item[data-tab="profile"]');
  await julie.page.locator('#account-email', { hasText: 'julie.l3@exemple.fr' }).waitFor();
});
