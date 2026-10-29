// Ce que les proches envoient à la tablette : photos (une ou plusieurs), vidéo, messages ; ce que la
// tablette renvoie (vu, bisous, réponse) ; suppression ; téléchargement de toutes les photos.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

const { s } = banc;

banc.brancher();

const postsDe = async (fid, type) => (await g.liste(`families/${fid}/posts`)).filter((p) => p.type === type);

test('Photos : une photo avec légende, puis 6 choisies (5 gardées) en un envoi, vue, suppression, téléchargement', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });

  await g.ouvrirTuile(julie, 'photos');
  // La photo de l'installation est déjà là.
  await julie.page.locator('#photos li.shot').first().waitFor();
  assert.strictEqual(await julie.page.locator('#photos li.shot').count(), 1);

  // Une photo, avec une légende.
  await julie.page.click('.fab[data-add="photo"]');
  await julie.page.locator('#sheet-post').waitFor({ state: 'visible' });
  await julie.page.setInputFiles('#in-photo-gallery', await g.photo({ largeur: 3000, hauteur: 2000, texte: 'Plage' }));
  await g.visible(julie, '#btn-send').waitFor();
  await julie.page.fill('#post-text', 'À la plage');
  assert.strictEqual(await julie.page.locator('#post-text-compte').innerText(), '10 / 60');
  await julie.page.click('#btn-send');
  await g.toast(julie, 'Envoyé');
  await julie.page.locator('#sheet-post').waitFor({ state: 'hidden' });
  await julie.page.locator('#photos li.shot', { hasText: 'À la plage' }).waitFor();
  const [plage] = (await postsDe(fid, 'photo')).filter((p) => p.text === 'À la plage');
  assert.match(plage.imageUrl, /^https:\/\/firebasestorage\.googleapis\.com\//, 'photo dans Storage');
  assert.match(plage.storagePath, new RegExp(`^families/${fid}/media/.+\\.jpg$`));
  assert.ok(plage.thumb.startsWith('data:image/jpeg'), 'aperçu léger dans le document');
  assert.strictEqual(plage.authorName, 'Julie');
  assert.strictEqual(plage.seenAt, null);

  // La photo s'ouvre en grand (lue dans Storage, comme sur la tablette) ; réduite à 2048 px.
  await julie.page.locator('#photos li.shot', { hasText: 'À la plage' }).locator('.shot-frame').click();
  await julie.page.locator('#viewer').waitFor({ state: 'visible' });
  await julie.page.waitForFunction(() => {
    const img = document.getElementById('viewer-img');
    return img.src.startsWith('https://firebasestorage') && img.complete && img.naturalWidth > 0;
  });
  assert.strictEqual(await julie.page.evaluate(() => document.getElementById('viewer-img').naturalWidth), 2048);
  assert.strictEqual(await julie.page.locator('#viewer-caption').innerText(), 'À la plage');
  await julie.page.click('#viewer-close');
  await julie.page.locator('#viewer').waitFor({ state: 'hidden' });
  await g.attendreVue(julie, 'view-photos');

  // Six photos choisies d'un coup : cinq au plus par envoi.
  await julie.page.click('.fab[data-add="photo"]');
  const six = [];
  for (let i = 1; i <= 6; i++) six.push(await g.photo({ texte: `Photo ${i}`, nom: `p${i}.jpg`, largeur: 900, hauteur: 1200 }));
  await julie.page.setInputFiles('#in-photo-gallery', six);
  assert.match(await g.texteFenetre(julie), /5 photos au plus par envoi/);
  await g.repondre(julie, 'OK');
  await julie.page.locator('#previews .preview').nth(4).waitFor();
  assert.strictEqual(await julie.page.locator('#previews .preview').count(), 5);
  // On en retire une avant d'envoyer.
  await julie.page.locator('#previews .preview button').first().click();
  assert.strictEqual(await julie.page.locator('#previews .preview').count(), 4);
  await julie.page.click('#btn-send');
  await g.toast(julie, 'Envoyé');
  const multi = await g.attendreBase(async () => (await postsDe(fid, 'photo')).find((p) => p.photos), 'envoi de plusieurs photos');
  assert.strictEqual(multi.photos.length, 4);
  assert.ok(multi.photos.every((p) => /^https:\/\/firebasestorage/.test(p.imageUrl) && p.storagePath && p.thumb));
  await julie.page.locator('#photos .shot-count', { hasText: '1 / 4' }).waitFor();

  // La tablette affiche l'envoi et le marque vu : « Lu » chez Julie.
  await s.db.doc(`families/${fid}/posts/${plage.id}`).update({ seenAt: s.FieldValue.serverTimestamp(), hearts: 1 });
  await julie.page.locator('#photos li.shot', { hasText: 'À la plage' }).locator('.read-badge.read').waitFor();

  // Tout télécharger : un fichier .zip avec chaque photo (1 + 1 + 4).
  const [telechargement] = await Promise.all([
    julie.page.waitForEvent('download', { timeout: 30_000 }),
    julie.page.click('#btn-photos-zip'),
  ]);
  assert.match(telechargement.suggestedFilename(), /\.zip$/);
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(require('node:fs').readFileSync(await telechargement.path()));
  const fichiers = Object.keys(zip.files).filter((n) => n.endsWith('.jpg'));
  assert.strictEqual(fichiers.length, 6, `photos dans le zip : ${fichiers.join(', ')}`);

  // Suppression de l'envoi de 4 photos : le document et ses fichiers disparaissent.
  const avant = (await postsDe(fid, 'photo')).length;
  await julie.page.locator('#photos li.shot').filter({ has: julie.page.locator('.shot-count') }).locator('button.del').click();
  await g.repondre(julie, 'Supprimer');
  await g.attendreBase(async () => (await postsDe(fid, 'photo')).length === avant - 1, 'envoi supprimé');
  await julie.page.locator('#photos .shot-count').waitFor({ state: 'detached' });
});

test('Vidéo : préparée dans le téléphone, envoyée dans Storage, lue dans la visionneuse', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });

  await g.ouvrirTuile(julie, 'videos');
  await julie.page.locator('#videos-empty').waitFor({ state: 'visible' });
  await julie.page.click('.fab[data-add="video"]');
  await julie.page.locator('#video-hint').waitFor({ state: 'visible' });
  await julie.page.setInputFiles('#in-video-gallery', await g.video({ secondes: 2 }));
  await g.visible(julie, '#btn-send').waitFor({ timeout: 30_000 });
  await julie.page.fill('#post-text', 'Coucou en vidéo');
  await julie.page.click('#btn-send');
  await g.toast(julie, 'Envoyé');
  const [v] = await g.attendreBase(async () => { const l = await postsDe(fid, 'video'); return l.length ? l : null; }, 'vidéo envoyée');
  assert.match(v.videoUrl, /^https:\/\/firebasestorage\.googleapis\.com\//);
  assert.match(v.storagePath, /\.(webm|mp4)$/);
  assert.ok(v.duration >= 1 && v.duration <= 3, `durée ${v.duration}`);
  assert.ok(v.thumb.startsWith('data:image/jpeg'));
  assert.strictEqual(v.text, 'Coucou en vidéo');

  const tuile = julie.page.locator('#videos li.shot', { hasText: 'Coucou en vidéo' });
  await tuile.waitFor();
  assert.match(await tuile.locator('.shot-duration').innerText(), /\d s/);
  await tuile.locator('.shot-frame').click();
  await julie.page.waitForFunction(() => {
    const el = document.getElementById('viewer-video');
    return !el.hidden && el.src.startsWith('https://firebasestorage') && el.readyState >= 1;
  }, null, { timeout: 15_000 });
  await julie.page.click('#viewer-close');
  await julie.page.locator('#viewer').waitFor({ state: 'hidden' });
});

// Captures des écrans de cette partie, si PAPOTE_CAPTURES donne un dossier (pour les montrer à Tanguy).
const capture = async (p, nom) => { if (process.env.PAPOTE_CAPTURES) await p.screenshot({ path: require('node:path').join(process.env.PAPOTE_CAPTURES, `${nom}.png`) }); };

// Bug du 29/10 : le plein écran de l'aperçu se refermait aussitôt (l'app fermait tout plein écran hors
// appel). L'aperçu avant envoi : la vidéo à sa forme, lecture et plein écran sur la vidéo, Refilmer / Galerie, Envoyer.
for (const [forme, largeur, hauteur] of [['debout', 240, 426], ['couchée', 426, 240]]) {
  test(`Vidéo ${forme} : aperçu à sa forme, lecture, plein écran qui reste ouvert, Galerie, téléphone tourné`, async () => {
    const julie = await banc.telephone('Julie');
    const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
    const p = julie.page;

    await g.ouvrirTuile(julie, 'videos');
    await p.click('.fab[data-add="video"]');
    await p.locator('#video-hint').waitFor({ state: 'visible' });
    await p.setInputFiles('#in-video-gallery', await g.video({ secondes: 2, largeur, hauteur }));
    await g.visible(julie, '#btn-send').waitFor({ timeout: 30_000 });
    await p.waitForFunction(() => document.getElementById('video-preview').readyState >= 1);
    await capture(p, `apercu-${forme}`);

    // La vidéo garde sa forme (ni déformée, ni arrondie), sans les boutons du navigateur.
    const v = await p.evaluate(() => {
      const el = document.getElementById('video-preview');
      const r = el.getBoundingClientRect();
      return { ratio: r.width / r.height, attendu: el.videoWidth / el.videoHeight, rayon: getComputedStyle(el).borderRadius, controls: el.controls };
    });
    assert.ok(Math.abs(v.ratio - v.attendu) < 0.05, `vidéo déformée : ${v.ratio} pour ${v.attendu}`);
    assert.strictEqual(v.rayon, '0px');
    assert.strictEqual(v.controls, false);
    // Refilmer et Galerie de même taille ; l'icône plein écran dans le coin de la vidéo.
    const [ra, rb] = await Promise.all([p.locator('#video-refilmer').boundingBox(), p.locator('#video-autre').boundingBox()]);
    assert.ok(Math.abs(ra.width - rb.width) < 1 && Math.abs(ra.height - rb.height) < 1, 'Refilmer et Galerie de tailles différentes');
    const [rv, rp] = await Promise.all([p.locator('#video-preview').boundingBox(), p.locator('#video-plein').boundingBox()]);
    assert.ok(rp.x + rp.width <= rv.x + rv.width + 1 && rp.y + rp.height <= rv.y + rv.height + 1 && rp.x > rv.x + rv.width / 2, 'plein écran hors du coin de la vidéo');

    // Le gros bouton lecture lance la vidéo et disparaît.
    await p.click('#video-play');
    await p.waitForFunction(() => !document.getElementById('video-preview').paused);
    await p.locator('#video-play').waitFor({ state: 'hidden', timeout: 2000 });

    // Plein écran : il s'ouvre et reste ouvert.
    await p.click('#video-plein');
    await p.waitForFunction(() => document.fullscreenElement?.id === 'video-preview');
    await p.waitForTimeout(800);
    assert.strictEqual(await p.evaluate(() => document.fullscreenElement?.id), 'video-preview', 'plein écran refermé tout seul');
    await p.evaluate(() => document.exitFullscreen());
    await p.waitForFunction(() => !document.fullscreenElement);
    await g.visible(julie, '#btn-send').waitFor();

    // Téléphone tourné : tout reste dans l'écran.
    await p.setViewportSize({ width: 844, height: 390 });
    await g.verifierLargeur(julie, 'aperçu vidéo couché');
    await p.setViewportSize({ width: 390, height: 844 });

    // Galerie : la galerie se rouvre, la nouvelle vidéo remplace l'ancienne.
    const [choix] = await Promise.all([p.waitForEvent('filechooser'), p.click('#video-autre')]);
    assert.strictEqual(await choix.element().getAttribute('id'), 'in-video-gallery');
    await choix.setFiles(await g.video({ secondes: 1, largeur, hauteur }));
    await g.visible(julie, '#btn-send').waitFor({ timeout: 30_000 });
    await p.click('#btn-send');
    await g.toast(julie, 'Envoyé');
    const [envoi] = await g.attendreBase(async () => { const l = await postsDe(fid, 'video'); return l.length ? l : null; }, 'vidéo envoyée');
    assert.ok(envoi.duration < 1.8, `la première vidéo est partie (${envoi.duration} s)`);
    assert.strictEqual((await postsDe(fid, 'video')).length, 1);
  });
}

// Filmer dans Papote (29/10) : la caméra dans la page plutôt que l'appareil photo du téléphone.
// Le navigateur du banc filme avec une fausse caméra (image de test et bip).
test('Filmer dans Papote : caméra, Filmer / Arrêter, aperçu, Refilmer, retour d\'Android, envoi sans préparation', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const p = julie.page;
  const pret = () => p.waitForFunction(() => document.getElementById('filmer').dataset.etat === 'pret', null, { timeout: 15_000 });

  await g.ouvrirTuile(julie, 'videos');
  await p.click('.fab[data-add="video"]');
  assert.strictEqual(await p.locator('#pick-camera').innerText(), 'Filmer');
  await p.click('#pick-camera');
  await p.locator('#filmer').waitFor({ state: 'visible' });
  await pret();
  assert.strictEqual(await p.locator('#filmer-temps').innerText(), '0:00 / 1:00');
  await capture(p, 'filmer-pret');
  // L'image de la caméra n'est ni déformée ni arrondie.
  const cam = await p.evaluate(() => {
    const el = document.getElementById('filmer-live');
    const r = el.getBoundingClientRect();
    return { ratio: r.width / r.height, attendu: el.videoWidth / el.videoHeight, rayon: getComputedStyle(el).borderRadius };
  });
  assert.ok(Math.abs(cam.ratio - cam.attendu) < 0.05, `caméra déformée : ${cam.ratio} pour ${cam.attendu}`);
  assert.strictEqual(cam.rayon, '0px');
  // Annuler et Retourner de même taille.
  const [ra, rb] = await Promise.all([p.locator('#filmer-annuler').boundingBox(), p.locator('#filmer-tourner').boundingBox()]);
  assert.ok(Math.abs(ra.width - rb.width) < 1 && Math.abs(ra.height - rb.height) < 1, 'Annuler et Retourner de tailles différentes');

  // Retour d'Android : la caméra se ferme, la feuille d'envoi reste.
  await p.goBack();
  await p.locator('#filmer').waitFor({ state: 'hidden' });
  await g.visible(julie, '#pick-camera').waitFor();
  assert.ok(await p.locator('#sheet-post').isVisible());
  assert.strictEqual(await p.evaluate(() => document.getElementById('filmer-live').srcObject), null, 'caméra restée allumée');

  // Filmer 2 s, Arrêter : l'aperçu tout de suite, sans « Préparation de la vidéo… ».
  await p.click('#pick-camera');
  await pret();
  await p.click('#filmer-rec');
  await p.waitForFunction(() => document.getElementById('filmer').dataset.etat === 'film');
  assert.strictEqual(await p.locator('#filmer-rec-label').innerText(), 'Arrêter');
  assert.ok(await p.locator('#filmer-tourner').isDisabled(), 'Retourner pendant le film');
  await p.waitForTimeout(2300);
  assert.match(await p.locator('#filmer-temps').innerText(), /^0:0[23] \/ 1:00$/);
  await capture(p, 'filmer-en-cours');
  await p.setViewportSize({ width: 844, height: 390 });
  await capture(p, 'filmer-couche');
  await g.verifierLargeur(julie, 'caméra couchée');
  await p.setViewportSize({ width: 390, height: 844 });
  await p.click('#filmer-rec');
  await p.locator('#filmer').waitFor({ state: 'hidden' });
  await g.visible(julie, '#btn-send').waitFor({ timeout: 5000 });
  await p.waitForFunction(() => document.getElementById('video-preview').readyState >= 1);
  await capture(p, 'filmer-apercu');

  // Refilmer puis Annuler : la caméra se ferme, la vidéo d'avant est toujours là.
  await p.click('#video-refilmer');
  await pret();
  await p.click('#filmer-annuler');
  await p.locator('#filmer').waitFor({ state: 'hidden' });
  await g.visible(julie, '#btn-send').waitFor();
  assert.ok(await p.locator('#video-review').isVisible());

  // Annuler pendant le film : rien n'est gardé, la vidéo d'avant reste.
  await p.click('#video-refilmer');
  await pret();
  await p.click('#filmer-rec');
  await p.waitForTimeout(1200);
  await p.click('#filmer-annuler');
  await p.locator('#filmer').waitFor({ state: 'hidden' });
  await p.waitForTimeout(500);
  assert.ok(await p.evaluate(() => document.getElementById('video-preview').duration > 1.8 || !Number.isFinite(document.getElementById('video-preview').duration)), 'la vidéo annulée a remplacé la première');

  // Refilmer 1 s : cette vidéo remplace la première, et c'est elle qui part.
  await p.click('#video-refilmer');
  await pret();
  await p.click('#filmer-rec');
  await p.waitForTimeout(1300);
  await p.click('#filmer-rec');
  await g.visible(julie, '#btn-send').waitFor({ timeout: 5000 });
  await p.fill('#post-text', 'Filmé dans Papote');
  await p.click('#btn-send');
  await g.toast(julie, 'Envoyé');
  const [v] = await g.attendreBase(async () => { const l = await postsDe(fid, 'video'); return l.length ? l : null; }, 'vidéo envoyée');
  assert.match(v.storagePath, /\.(webm|mp4)$/);
  assert.ok(v.duration >= 1 && v.duration <= 2, `durée ${v.duration}`);
  assert.ok(v.thumb.startsWith('data:image/jpeg'));
  assert.strictEqual(v.text, 'Filmé dans Papote');
});

test('Filmer : caméra refusée, message clair et repli sur l\'appareil photo du téléphone', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const p = julie.page;
  await p.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('refus', 'NotAllowedError'));
  });
  await g.ouvrirTuile(julie, 'videos');
  await p.click('.fab[data-add="video"]');
  await p.click('#pick-camera');
  await p.locator('#filmer-erreur').waitFor({ state: 'visible' });
  assert.ok(await p.locator('#filmer-rec').isDisabled());
  await capture(p, 'filmer-refus');
  const [choix] = await Promise.all([p.waitForEvent('filechooser'), p.click('#filmer-repli')]);
  assert.strictEqual(await choix.element().getAttribute('id'), 'in-video-camera');
  await p.locator('#filmer').waitFor({ state: 'hidden' });
  await choix.setFiles(await g.video({ secondes: 1 }));
  await g.visible(julie, '#btn-send').waitFor({ timeout: 30_000 });
});

test('Messages : écrit, message rapide, vu par la tablette, réponse de Mamie, suppression', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });

  await g.ouvrirTuile(julie, 'messages');
  await julie.page.locator('#messages-empty').waitFor({ state: 'visible' });
  assert.match(await julie.page.getAttribute('#message-text', 'placeholder'), /Écrire à Mamie Emma/);
  await julie.page.fill('#message-text', 'Bisous de Lyon, à dimanche !');
  await julie.page.click('#btn-message');
  await julie.page.locator('#messages li.bubble.mine', { hasText: 'Bisous de Lyon' }).waitFor();
  assert.strictEqual(await julie.page.inputValue('#message-text'), '');
  await julie.page.click('.quick-msg:has-text("Bonne nuit")');
  await julie.page.locator('#messages li.bubble.mine', { hasText: 'Bonne nuit' }).waitFor();
  // La bulle s'affiche avant l'accord du serveur : on attend qu'il ait bien les deux.
  const messages = await g.attendreBase(async () => { const l = await postsDe(fid, 'message'); return l.length === 2 && l; }, '2 messages');
  assert.deepStrictEqual(messages.map((m) => m.text).sort(), ['Bisous de Lyon, à dimanche !', 'Bonne nuit']);

  // Le compteur n'apparaît qu'à 40 caractères de la limite (160).
  await julie.page.fill('#message-text', 'x'.repeat(130));
  await julie.page.locator('#message-text').dispatchEvent('input');
  assert.strictEqual(await julie.page.locator('#message-count').innerText(), '30');
  await julie.page.fill('#message-text', '');
  await julie.page.locator('#message-text').dispatchEvent('input');

  // La tablette lit le message : « Vu ». Mamie répond d'un bouton : la réponse s'affiche à gauche.
  const bisous = messages.find((m) => m.text.startsWith('Bisous'));
  await s.db.doc(`families/${fid}/posts/${bisous.id}`).update({ seenAt: s.FieldValue.serverTimestamp() });
  await julie.page.locator('#messages li.bubble.mine', { hasText: 'Bisous de Lyon' }).locator('.bubble-foot', { hasText: 'Vu' }).waitFor();
  await s.db.collection(`families/${fid}/posts`).add({
    type: 'reply', text: 'Merci ma chérie !', replyTo: bisous.id, authorUid: tab.tabletUid, authorName: 'Mamie Emma',
    createdAt: s.FieldValue.serverTimestamp(), seenAt: null, hearts: 0,
  });
  const reponse = julie.page.locator('#messages li.bubble.theirs.reply', { hasText: 'Merci ma chérie' });
  await reponse.waitFor();
  assert.match(await reponse.locator('.bubble-who').innerText(), /Mamie Emma/);

  // Julie supprime son message « Bonne nuit ».
  await julie.page.locator('#messages li.bubble.mine', { hasText: 'Bonne nuit' }).locator('.bubble-del').click();
  await g.repondre(julie, 'Supprimer');
  await julie.page.locator('#messages li.bubble', { hasText: 'Bonne nuit' }).waitFor({ state: 'detached' });
  assert.deepStrictEqual((await postsDe(fid, 'message')).map((m) => m.text), ['Bisous de Lyon, à dimanche !']);
});

test('Un proche voit les envois des autres, ne peut supprimer que les siens', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const { code } = await g.lire(`families/${fid}`);
  const paul = await banc.telephone('Paul');
  await g.inscrire(paul, 'paul@exemple.fr', 'Paul', { genre: 'homme', suite: `?code=${code}` });
  await g.attendreVue(paul, 'view-join');
  await paul.page.click('#form-join button[type=submit]');
  await julie.page.locator('#pending-banner .join-ok').click();
  await g.attendreVue(paul, 'view-home');
  await g.fermerAccueil(paul);

  await g.ouvrirTuile(julie, 'messages');
  await julie.page.fill('#message-text', 'Message de Julie');
  await julie.page.click('#btn-message');
  await g.ouvrirTuile(paul, 'messages');
  const deJulie = paul.page.locator('#messages li.bubble.theirs', { hasText: 'Message de Julie' });
  await deJulie.waitFor();
  assert.match(await deJulie.locator('.bubble-who').innerText(), /Julie/);
  assert.strictEqual(await deJulie.locator('.bubble-del').count(), 0, 'Paul ne supprime pas le message de Julie');
  // Julie (responsable) peut supprimer celui de Paul.
  await paul.page.fill('#message-text', 'Message de Paul');
  await paul.page.click('#btn-message');
  const dePaul = julie.page.locator('#messages li.bubble.theirs', { hasText: 'Message de Paul' });
  await dePaul.waitFor();
  assert.strictEqual(await dePaul.locator('.bubble-del').count(), 1);
});
