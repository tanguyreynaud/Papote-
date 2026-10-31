// Plusieurs photos dans un seul envoi (Tanguy, 31/10) : transfert coupé en route avec ou sans réseau,
// double appui sur Envoyer, ordre des photos, et la limite des 200 derniers envois de photos.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

const { s } = banc;

banc.brancher();

const RESEAU = /ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|ERR_FAILED|net::|Storage indisponible|liaison|Failed to fetch|storage\/retry-limit|storage\/unknown|hors ligne|mis en attente/;
const LARGEURS = [1000, 900, 800, 700, 600];
const postsDe = async (fid, type) => (await g.liste(`families/${fid}/posts`)).filter((p) => p.type === type);

/** Cinq photos de largeurs décroissantes : la largeur dit laquelle est laquelle. */
async function cinqPhotos() {
  const photos = [];
  for (const [i, l] of LARGEURS.entries()) photos.push(await g.photo({ largeur: l, hauteur: 500, texte: `Photo ${i + 1}`, nom: `photo-${i + 1}.jpg` }));
  return photos;
}

/** Les fichiers de la famille dans Storage (émulateur). */
async function fichiers(fid) {
  const [h, p] = process.env.FIREBASE_STORAGE_EMULATOR_HOST.split(':');
  const r = await fetch(`http://${h}:${p}/v0/b/papote-famille-eu/o?prefix=${encodeURIComponent(`families/${fid}/media/`)}`, { headers: { Authorization: 'Bearer owner' } });
  assert.strictEqual(r.status, 200, `liste Storage : ${r.status}`);
  return ((await r.json()).items || []).map((f) => f.name);
}

/** Largeur réelle de chaque photo d'un envoi, lue par le navigateur. */
function largeurs(t, post) {
  return t.page.evaluate((urls) => Promise.all(urls.map((u) => new Promise((ok, ko) => {
    const img = new Image();
    img.onload = () => ok(img.naturalWidth);
    img.onerror = () => ko(new Error(`photo illisible : ${u}`));
    img.src = u;
  }))), post.photos.map((p) => p.imageUrl));
}

async function choisirCinq(t) {
  await g.ouvrirTuile(t, 'photos');
  await t.page.click('.fab[data-add="photo"]');
  await t.page.locator('#sheet-post').waitFor({ state: 'visible' });
  await t.page.setInputFiles('#in-photo-gallery', await cinqPhotos());
  await g.visible(t, '#btn-send').waitFor();
  await t.page.locator('#previews img').nth(4).waitFor({ timeout: 20_000 });
  await t.page.waitForFunction(() => !document.getElementById('post-status') || document.getElementById('post-status').hidden, null, { timeout: 20_000 });
}

test('5 photos, transfert coupé à la 3e (réseau toujours là), double appui : un seul envoi de 5 photos, dans l\'ordre', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  let envois = 0;
  let coupe = false;
  await julie.context.route(/\/v0\/b\/[^/]+\/o\?name=/, (route) => {
    if (route.request().method() === 'POST' && ++envois === 3 && !coupe) { coupe = true; return route.abort('connectionreset'); }
    return route.fallback();
  });
  await choisirCinq(julie);
  await julie.page.fill('#post-text', 'Le week-end');
  // Deux appuis coup sur coup sur Envoyer.
  await julie.page.evaluate(() => { const b = document.getElementById('btn-send'); b.click(); b.click(); });
  await julie.page.locator('#sheet-post').waitFor({ state: 'hidden', timeout: 60_000 });
  const posts = await g.attendreBase(async () => { const l = (await postsDe(fid, 'photo')).filter((p) => p.text === 'Le week-end'); return l.length && l; }, 'photos parties');
  assert.ok(coupe, 'le transfert a bien été coupé une fois');
  assert.strictEqual(posts.length, 1, `un seul envoi (${posts.length} trouvés)`);
  assert.strictEqual((posts[0].photos || []).length, 5, 'les 5 photos dans l\'envoi');
  assert.ok(posts[0].photos.every((p) => /^https:\/\/firebasestorage/.test(p.imageUrl) && p.storagePath), 'toutes dans Storage');
  assert.deepStrictEqual(await largeurs(julie, posts[0]), LARGEURS, 'dans l\'ordre choisi');
  // Aucun fichier orphelin : la photo de l'installation + 5.
  assert.strictEqual((await fichiers(fid)).length, 6, 'pas de fichier en trop dans Storage');
  // L'écran : 1 (installation) + 1 envoi de 5, avec son compteur.
  await julie.page.locator('#photos li.shot').nth(1).waitFor();
  await julie.page.locator('#photos .shot-count', { hasText: '5' }).waitFor();
  banc.tolerer(julie, RESEAU);
});

test('5 photos, réseau coupé net à la 3e : rien n\'est perdu ni envoyé deux fois, l\'envoi part entier au retour du réseau', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  let envois = 0;
  await julie.context.route(/\/v0\/b\/[^/]+\/o\?name=/, async (route) => {
    if (route.request().method() === 'POST' && ++envois === 3) { await julie.context.setOffline(true); return route.abort('internetdisconnected'); }
    return route.fallback();
  });
  await choisirCinq(julie);
  await julie.page.fill('#post-text', 'Sans réseau');
  await julie.page.click('#btn-send');
  await julie.page.locator('#sheet-post').waitFor({ state: 'hidden', timeout: 60_000 });
  await julie.page.locator('#view-photos .outbox', { hasText: '1 envoi en attente de réseau' }).waitFor();
  assert.strictEqual((await postsDe(fid, 'photo')).filter((p) => p.text === 'Sans réseau').length, 0, 'rien de parti à moitié');
  // Le réseau revient : l'envoi part tout seul, entier.
  await julie.context.setOffline(false);
  await julie.page.locator('#view-photos .outbox').waitFor({ state: 'hidden', timeout: 60_000 });
  const posts = await g.attendreBase(async () => { const l = (await postsDe(fid, 'photo')).filter((p) => p.text === 'Sans réseau'); return l.length && l; }, 'envoi parti');
  assert.strictEqual(posts.length, 1, `un seul envoi (${posts.length} trouvés)`);
  assert.strictEqual((posts[0].photos || []).length, 5, 'les 5 photos dans l\'envoi');
  assert.deepStrictEqual(await largeurs(julie, posts[0]), LARGEURS, 'dans l\'ordre choisi');
  // Les 2 photos déjà transférées avant la coupure sont réutilisées : pas de fichier orphelin.
  assert.strictEqual((await fichiers(fid)).length, 6, 'pas de fichier en trop dans Storage');
  banc.tolerer(julie, RESEAU);
});

test('Limite : au-delà de 200 envois de photos, les plus anciens (plus de 7 jours) sont effacés après un envoi', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  // 201 vieux envois (il y a 30 jours), par lots.
  const posts = s.db.collection(`families/${fid}/posts`);
  let lot = s.db.batch();
  let n = 0;
  for (let i = 0; i < 201; i++) {
    lot.set(posts.doc(), {
      type: 'photo', text: `Vieille ${i}`, image: null, thumb: null, imageUrl: null, authorUid: 'x', authorName: 'Léo',
      createdAt: s.Timestamp.fromMillis(Date.now() - 30 * 86_400_000 + i * 1000), seenAt: null, hearts: 0,
    });
    if (++n === 400) { await lot.commit(); lot = s.db.batch(); n = 0; }
  }
  await lot.commit();
  await g.ouvrirTuile(julie, 'photos');
  await julie.page.click('.fab[data-add="photo"]');
  await julie.page.locator('#sheet-post').waitFor({ state: 'visible' });
  await julie.page.setInputFiles('#in-photo-gallery', [await g.photo({ texte: 'Neuve', nom: 'neuve.jpg' })]);
  await g.visible(julie, '#btn-send').waitFor();
  await julie.page.click('#btn-send');
  await julie.page.locator('#sheet-post').waitFor({ state: 'hidden', timeout: 30_000 });
  // 1 (installation) + 201 + 1 = 203, moins les plus vieux au-delà de 200.
  await g.attendreBase(async () => (await postsDe(fid, 'photo')).length === 200, 'retour à 200 envois de photos');
  const restants = await postsDe(fid, 'photo');
  assert.ok(!restants.some((p) => p.text === 'Vieille 0' || p.text === 'Vieille 1' || p.text === 'Vieille 2'), 'les 3 plus vieux effacés');
  assert.ok(restants.some((p) => p.text === 'Vieille 200'), 'les récents gardés');
});
