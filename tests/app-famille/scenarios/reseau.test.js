// Le mauvais réseau (Tanguy, 30/10) : la tablette coupée en plein appel, le transfert d'une photo coupé en route,
// une 4G lente. L'appli ne doit jamais rester bloquée, ne rien envoyer deux fois, et dire ce qu'elle fait.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');
const tablette = require('../tablette');

banc.brancher();

const RESEAU = /ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|ERR_FAILED|net::|Storage indisponible|liaison|Failed to fetch|storage\/retry-limit|storage\/unknown/;

async function lancerAppel(t) {
  await t.page.locator('#tile-call:not([disabled])').waitFor();
  await t.page.click('#tile-call');
  await g.repondre(t, 'Appeler');
  await t.page.locator('#call').waitFor({ state: 'visible' });
}

test('La tablette perd le réseau en plein appel vidéo : le téléphone ferme l\'appel tout seul, sans rester bloqué', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const mamie = await tablette.ouvrir(fid, tab);
  await lancerAppel(julie);
  const [appel] = await g.attendreBase(async () => { const l = await g.liste(`families/${fid}/calls`); return l.length && l; }, 'appel écrit');
  await tablette.decrocher(mamie, appel.id);
  await julie.page.locator('#call-status').waitFor({ state: 'hidden' });

  // La tablette disparaît du réseau d'un coup (Wi-Fi coupé, 4G perdue) : plus un paquet, pas un mot dans la base.
  await mamie.arreterRelais();
  await mamie.page.evaluate(() => { window.pc.getSenders().forEach((s2) => s2.track && s2.track.stop()); window.pc.close(); });
  const debut = Date.now();
  await julie.page.locator('#call').waitFor({ state: 'hidden', timeout: 60_000 })
    .catch(() => assert.fail('60 s après la coupure, le téléphone montre toujours l\'écran d\'appel'));
  const duree = Math.round((Date.now() - debut) / 1000);
  console.log(`appel fermé ${duree} s après la coupure`);
  assert.ok(duree <= 45, `l'appel devrait se fermer en moins de 45 s (ici ${duree} s)`);
  // Et on peut rappeler tout de suite.
  await julie.page.locator('#tile-call:not([disabled])').waitFor({ timeout: 10_000 });
  banc.tolerer(julie, RESEAU);
  banc.tolerer(mamie, RESEAU);
});

test('Transfert d\'une photo coupé en plein milieu : la photo part quand même, une seule fois', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  // Le premier envoi vers Storage est coupé net (connexion perdue au milieu du transfert).
  let coupes = 0;
  await julie.context.route(/\/v0\/b\/[^/]+\/o\?name=/, (route) => {
    if (route.request().method() === 'POST' && coupes++ === 0) return route.abort('connectionreset');
    return route.fallback();
  });
  await g.ouvrirTuile(julie, 'photos');
  await julie.page.click('.fab[data-add="photo"]');
  await julie.page.locator('#sheet-post').waitFor({ state: 'visible' });
  await julie.page.setInputFiles('#in-photo-gallery', [await g.photo({ texte: 'Coupée', nom: 'coupee.jpg' })]);
  await g.visible(julie, '#btn-send').waitFor();
  await julie.page.fill('#post-text', 'Réseau coupé en route');
  await julie.page.click('#btn-send');
  await julie.page.locator('#sheet-post').waitFor({ state: 'hidden', timeout: 30_000 });
  const posts = await g.attendreBase(async () => { const l = (await g.liste(`families/${fid}/posts`)).filter((p) => p.text === 'Réseau coupé en route'); return l.length && l; }, 'photo partie');
  assert.strictEqual(posts.length, 1, 'une seule photo');
  assert.ok(posts[0].imageUrl || posts[0].image, 'avec son image');
  assert.ok(coupes >= 1, 'le transfert a bien été coupé une fois');
  // L'écran la montre, une fois.
  // L'écran montre autant de photos que la base en a (la photo de bienvenue de l'installation, plus celle-ci).
  const enBase = (await g.liste(`families/${fid}/posts`)).filter((p) => p.type === 'photo').length;
  await julie.page.waitForFunction((n) => document.querySelectorAll('#photos > *').length === n, enBase, { timeout: 10_000 })
    .catch(async () => assert.fail(`l'écran montre ${await julie.page.locator('#photos > *').count()} photo(s), la base en a ${enBase}`));
  banc.tolerer(julie, RESEAU);
});

test('4G lente (700 ms par requête) : un message part une fois, avec un retour visible pendant l\'attente', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  // Chaque requête vers la base met 700 ms de plus (l'émulateur répond en local : la lenteur est ajoutée ici).
  let lentes = 0;
  await julie.context.route(/\/google\.firestore\.v1\.Firestore\//, async (route) => {
    lentes++;
    await new Promise((ok) => setTimeout(ok, 700));
    return route.fallback();
  });
  await g.ouvrirTuile(julie, 'messages');
  await julie.page.fill('#message-text', 'Depuis la campagne');
  const debut = Date.now();
  await julie.page.click('#btn-message');
  // Le bouton montre qu'il travaille (retour.js), puis le message est bien parti une fois.
  const retour = await julie.page.waitForFunction(() => {
    const b = document.getElementById('btn-message');
    return b && (b.disabled || b.dataset.retour !== undefined || b.getAttribute('aria-busy') === 'true');
  }, null, { timeout: 3_000 }).then(() => true).catch(() => false);
  const posts = await g.attendreBase(async () => { const l = (await g.liste(`families/${fid}/posts`)).filter((p) => p.text === 'Depuis la campagne'); return l.length && l; }, 'message parti', 40_000);
  console.log(`message parti en ${Math.round((Date.now() - debut) / 100) / 10} s (${lentes} requêtes ralenties), retour visible : ${retour}`);
  assert.ok(lentes > 0, 'la lenteur a bien été appliquée');
  assert.ok(retour, 'le bouton montre qu\'il travaille pendant l\'attente');
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(await julie.page.inputValue('#message-text'), '', 'le champ est vidé après l\'envoi');
});
