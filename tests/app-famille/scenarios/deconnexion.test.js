// « Se déconnecter » retire ce téléphone des sonneries du compte (bug Tanguy 2026-11 : après un changement de
// compte, son téléphone sonnait pour les deux profils). Jeton de l'app Android simulé comme dans natif.test.js :
// page ouverte par l'app (referrer android-app://…) avec ?natif=<jeton>. Vraies règles Firestore.
// Hors ligne, la déconnexion se fait quand même (au plus ~3 s d'attente) ; le serveur rattrape
// (functions/jeton-unique.js, essayé dans les parcours serveur).

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

const NATIF = 'cJetonDuTel:APA91b' + 'N'.repeat(140);

async function jetons(fid, uid) {
  const d = await banc.s.db.doc(`families/${fid}/members/${uid}/private/push`).get();
  return d.exists ? d.data() : {};
}

// Julie connectée dans l'app Android : son jeton est rangé avec son compte.
async function julieDansLApp(email) {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email, prenom: 'Julie' });
  const uid = (await g.liste(`families/${fid}/members`)).find((m) => m.email === email).id;
  await g.ouvrirParApp(julie, `?natif=${NATIF}`);
  await julie.page.locator('#tile-call').waitFor();
  await g.attendreBase(async () => ((await jetons(fid, uid)).natifs || []).includes(NATIF), 'jeton de l\'app rangé');
  await julie.page.click('.nav-item[data-tab="profile"]');
  await g.attendreVue(julie, 'view-profile');
  return { julie, fid, uid };
}

const fenetresOuvertes = (t) => t.page.locator('.dialog-back:not(.closing) .dialog', { hasText: 'Se déconnecter' }).count();

test('Se déconnecter retire le jeton du téléphone ; un double appui ne fait qu\'une déconnexion', async () => {
  const { julie, fid, uid } = await julieDansLApp('julie.deco@exemple.fr');

  // Double appui : deux touchers coup sur coup sur « Se déconnecter » (avant que la fenêtre ne couvre le bouton).
  await julie.page.evaluate(() => {
    const b = document.querySelector('#view-profile [data-action="logout"]');
    b.click();
    b.click();
  });
  await julie.page.locator('.dialog-back:not(.closing) .dialog', { hasText: 'Se déconnecter' }).first().waitFor();
  assert.strictEqual(await fenetresOuvertes(julie), 1, 'une seule question');
  await g.repondre(julie, 'Se déconnecter');
  await g.attendreVue(julie, 'view-login');
  await julie.page.waitForTimeout(1000);
  assert.strictEqual(await fenetresOuvertes(julie), 0, 'pas de deuxième question après la déconnexion');
  await g.attendreVue(julie, 'view-login');
  assert.deepStrictEqual((await jetons(fid, uid)).natifs, [], 'ce téléphone ne sonne plus pour Julie');

  // Annuler ne déconnecte pas et ne retire rien ; le bouton remarche ensuite.
  await g.seConnecter(julie, 'julie.deco@exemple.fr');
  await g.attendreVue(julie, 'view-home');
  await g.attendreBase(async () => ((await jetons(fid, uid)).natifs || []).includes(NATIF), 'jeton rangé à nouveau');
  await julie.page.click('.nav-item[data-tab="profile"]');
  await julie.page.click('#view-profile [data-action="logout"]');
  await g.repondre(julie, 'Annuler');
  await julie.page.waitForTimeout(500);
  await g.attendreVue(julie, 'view-profile');
  assert.deepStrictEqual((await jetons(fid, uid)).natifs, [NATIF]);
  await julie.page.click('#view-profile [data-action="logout"]');
  await g.repondre(julie, 'Se déconnecter');
  await g.attendreVue(julie, 'view-login');
  assert.deepStrictEqual((await jetons(fid, uid)).natifs, []);
});

test('Hors ligne : la déconnexion se fait quand même, sans attendre le réseau', async () => {
  const { julie, fid, uid } = await julieDansLApp('julie.horsligne@exemple.fr');
  await julie.context.setOffline(true);
  await julie.page.click('#view-profile [data-action="logout"]');
  const debut = Date.now();
  await g.repondre(julie, 'Se déconnecter');
  await g.attendreVue(julie, 'view-login', 10_000);
  const duree = Date.now() - debut;
  assert.ok(duree < 8000, `déconnecté en ${duree} ms`);
  // Le retrait n'a pas pu partir : le jeton est encore là (le serveur le retirera quand un autre compte l'inscrira).
  assert.deepStrictEqual((await jetons(fid, uid)).natifs, [NATIF]);
  // Toujours déconnecté après un redémarrage de l'app, même sans réseau.
  await julie.context.setOffline(false);
  await julie.page.reload();
  await g.attendreVue(julie, 'view-login', 30_000);
});
