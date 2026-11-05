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
