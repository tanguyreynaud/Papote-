// « Partager » d'Android vers Papote (Tanguy, 8/11) : depuis WhatsApp, Messenger, la Galerie ou l'appareil
// photo, l'app Android (telephone/, cible de partage) fait envoyer par Chrome les photos ou la vidéo à
// /partage ; le service worker (web/sw.js) les garde et ouvre /?partage=1, qui ouvre « Envoyer à la tablette ».
// Ici : le vrai code du service worker (sans l'enregistrer : le banc les bloque), puis l'app ouverte comme
// après ce renvoi, et chaque geste jusqu'à la tablette.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

const postsDe = async (fid, type) => (await g.liste(`families/${fid}/posts`)).filter((p) => p.type === type);

/**
 * Ce que Chrome fait après « Partager → Papote » : POST multipart vers /partage, traité par le vrai
 * code de web/sw.js (chargé avec un faux `self`). Renvoie la réponse du service worker.
 */
async function partager(t, fichiers, { title = '', text = '' } = {}) {
  if (!t.page.url().startsWith(banc.origine)) await t.page.goto(`${banc.origine}/__vide.html`);
  return t.page.evaluate(async ({ fichiers: fs, title: ti, text: tx }) => {
    const src = await (await fetch('/sw.js')).text();
    const ecoutes = {};
    const faux = { addEventListener: (n, f) => { ecoutes[n] = f; }, location, clients: { claim() {} }, skipWaiting() {} };
    new Function('self', src)(faux);
    const form = new FormData();
    if (ti) form.append('title', ti);
    if (tx) form.append('text', tx);
    for (const f of fs) {
      const octets = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      form.append('media', new File([octets], f.name, { type: f.mimeType }));
    }
    let reponse = null;
    ecoutes.fetch({ request: new Request(`${location.origin}/partage`, { method: 'POST', body: form }), respondWith: (p) => { reponse = p; } });
    const r = await reponse;
    return { status: r.status, location: r.headers.get('Location') };
  }, { fichiers: fichiers.map((f) => ({ name: f.name, mimeType: f.mimeType, base64: f.buffer.toString('base64') })), title, text });
}

/** Le renvoi du service worker : l'app s'ouvre sur /?partage=1. */
async function ouvrirPartage(t, r) {
  assert.strictEqual(r.status, 303, 'le service worker renvoie vers l\'app');
  assert.match(r.location, /\/\?partage=1$/);
  await t.page.goto(`${banc.origine}/?partage=1`);
}

test('Une photo partagée depuis WhatsApp avec un texte joint : « Envoyer » s\'ouvre prêt, légende vide, un appui et elle part', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const avant = (await postsDe(fid, 'photo')).length;
  await ouvrirPartage(julie, await partager(julie, [await g.photo({ texte: 'Anniversaire', nom: 'IMG-20261108-WA0001.jpg' })], { title: 'Photo de Tanguy', text: 'IMG-20261108-WA0001.jpg' }));
  await g.attendreVue(julie, 'view-photos');
  await julie.page.locator('#sheet-post').waitFor({ state: 'visible' });
  await julie.page.locator('#previews img').first().waitFor();
  assert.strictEqual(await julie.page.locator('#previews img').count(), 1);
  assert.strictEqual(await julie.page.inputValue('#post-text'), '', 'le texte joint par l\'appli d\'origine n\'est pas repris en légende');
  await julie.page.fill('#post-text', 'Anniversaire de Léo');
  await g.visible(julie, '#btn-send').waitFor();
  await julie.page.click('#btn-send');
  await g.toast(julie, 'Envoyé');
  await julie.page.locator('#sheet-post').waitFor({ state: 'hidden' });
  const posts = await g.attendreBase(async () => { const l = await postsDe(fid, 'photo'); return l.length > avant && l; }, 'photo partie');
  const p = posts.find((x) => x.text === 'Anniversaire de Léo');
  assert.ok(p, 'envoi avec la légende');
  assert.match(p.imageUrl, /^https:\/\/firebasestorage\.googleapis\.com\//);
  // Le partage est consommé : rouvrir l'app ne repropose rien.
  await julie.page.goto(`${banc.origine}/`);
  await g.attendreVue(julie, 'view-home');
  await julie.page.waitForTimeout(1000);
  assert.ok(!(await julie.page.locator('#sheet-post').isVisible()), 'rien ne se rouvre');
});

test('Trois photos partagées depuis la Galerie : un seul envoi de trois photos, double appui sur Envoyer compris', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const trois = [];
  for (let i = 1; i <= 3; i++) trois.push(await g.photo({ texte: `Galerie ${i}`, nom: `PXL_${i}.jpg`, largeur: 800 + i * 100, hauteur: 600 }));
  await ouvrirPartage(julie, await partager(julie, trois));
  await julie.page.locator('#sheet-post').waitFor({ state: 'visible' });
  await julie.page.locator('#previews img').nth(2).waitFor();
  assert.strictEqual(await julie.page.locator('#previews img').count(), 3);
  await julie.page.fill('#post-text', 'Dimanche');
  await g.visible(julie, '#btn-send').waitFor();
  await julie.page.evaluate(() => { const b = document.getElementById('btn-send'); b.click(); b.click(); });
  await julie.page.locator('#sheet-post').waitFor({ state: 'hidden', timeout: 60_000 });
  const posts = await g.attendreBase(async () => { const l = (await postsDe(fid, 'photo')).filter((p) => p.text === 'Dimanche'); return l.length && l; }, 'photos parties');
  assert.strictEqual(posts.length, 1, 'un seul envoi');
  assert.strictEqual((posts[0].photos || []).length, 3, 'les trois photos');
});

test('Une vidéo partagée depuis l\'appareil photo : la page Vidéos s\'ouvre avec l\'aperçu, et elle part', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await ouvrirPartage(julie, await partager(julie, [await g.video({ secondes: 2, nom: 'VID_20261108.webm' })]));
  await g.attendreVue(julie, 'view-videos');
  await julie.page.locator('#sheet-post').waitFor({ state: 'visible' });
  await julie.page.waitForFunction(() => document.getElementById('video-preview').readyState >= 1, null, { timeout: 20_000 });
  await g.visible(julie, '#btn-send').waitFor();
  await julie.page.fill('#post-text', 'Premiers pas');
  await julie.page.click('#btn-send');
  await julie.page.locator('#sheet-post').waitFor({ state: 'hidden', timeout: 60_000 });
  const [v] = await g.attendreBase(async () => { const l = (await postsDe(fid, 'video')).filter((p) => p.text === 'Premiers pas'); return l.length && l; }, 'vidéo partie');
  assert.match(v.videoUrl, /^https:\/\/firebasestorage\.googleapis\.com\//);
});

test('Partage sans photo ni vidéo (un simple lien) : l\'accueil s\'ouvre normalement, aucune erreur', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await ouvrirPartage(julie, await partager(julie, [], { text: 'https://exemple.fr' }));
  await g.attendreVue(julie, 'view-home');
  await julie.page.waitForTimeout(1500);
  assert.ok(!(await julie.page.locator('#sheet-post').isVisible()), 'pas de fenêtre d\'envoi vide');
});

test('Retour d\'Android sur la fenêtre d\'envoi ouverte par un partage : elle se ferme, rien ne part', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const avant = (await postsDe(fid, 'photo')).length;
  await ouvrirPartage(julie, await partager(julie, [await g.photo({ texte: 'Oups', nom: 'oups.jpg' })]));
  await julie.page.locator('#sheet-post').waitFor({ state: 'visible' });
  await julie.page.locator('#previews img').first().waitFor();
  await julie.page.goBack();
  await julie.page.locator('#sheet-post').waitFor({ state: 'hidden' });
  await julie.page.waitForTimeout(1500);
  assert.strictEqual((await postsDe(fid, 'photo')).length, avant, 'rien n\'est parti');
});
