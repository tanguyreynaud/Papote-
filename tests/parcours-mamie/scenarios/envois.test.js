// Ce que la famille envoie, vu sur la vraie tablette : plusieurs photos d'un coup (« Suivante », double appui),
// un message avec des emojis, une vidéo. Et ce que la famille voit en retour (« Vu »).

const { test, assert, g, s, brancher, chezMamie, familleChezMamie, envoyerPhoto, enGrand, diagnostic, doubleAppui } = require('../commun');

brancher();

const postsDe = async (fid) => (await g.liste(`families/${fid}/posts`)).sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
const imageAffichee = (mamie) => mamie.page.evaluate(() => {
  const i = document.getElementById('overlay-img');
  return i.getAttribute('data-url');
});

test('3 photos d\'un coup : « Suivante » montre chacune, un double appui n\'en saute aucune, « OK » ferme et Julie voit « Vu »', async () => {
  const { julie, mamie, fid } = await familleChezMamie();
  const fichiers = [];
  for (const [i, l] of [1000, 800, 600].entries()) fichiers.push(await g.photo({ largeur: l, hauteur: 500, texte: `Photo ${i + 1}`, nom: `photo-${i + 1}.jpg` }));
  await envoyerPhoto(julie, { fichiers, legende: 'Les vacances 🏖️' });

  const debut = Date.now();
  await chezMamie(mamie, '#overlay:not([hidden])', 60_000);
  const attente = Math.round((Date.now() - debut) / 1000);
  console.log(`3 photos affichées chez Mamie ${attente} s après l'envoi.`);
  assert.ok(attente <= 30, `les photos arrivent en moins de 30 s une fois la tablette en direct (${attente} s)`);
  assert.match(await enGrand(mamie), /Les vacances 🏖️/);

  const vues = [await imageAffichee(mamie)];
  assert.strictEqual((await mamie.texte('#overlay-close')).trim(), 'Suivante');
  // Double appui de Mamie : une seule photo avance.
  await doubleAppui(mamie, '#overlay-close');
  vues.push(await imageAffichee(mamie));
  assert.notStrictEqual(vues[1], vues[0], `la 2e photo est montrée\nBouton : ${await mamie.texte('#overlay-close')}\nEnvois : ${JSON.stringify(mamie.envois()).slice(0, 1500)}`);
  assert.strictEqual((await mamie.texte('#overlay-close')).trim(), 'Suivante', 'il reste la 3e : toujours « Suivante »');
  await mamie.page.waitForTimeout(1100);
  await mamie.toucher('#overlay-close');
  vues.push(await imageAffichee(mamie));
  assert.strictEqual(new Set(vues).size, 3, `trois photos différentes montrées (${vues.map((v) => String(v).slice(-30)).join(' | ')})`);
  assert.strictEqual((await mamie.texte('#overlay-close')).trim(), 'OK');
  assert.strictEqual(await mamie.visible('#overlay'), true, 'la 3e reste affichée tant que Mamie n\'a pas touché OK');
  // Les trois fichiers sont bien sur la tablette.
  const lisibles = await mamie.page.evaluate((urls) => Promise.all(urls.map((u) => new Promise((ok) => {
    const i = new Image(); i.onload = () => ok(i.naturalWidth); i.onerror = () => ok(0); i.src = u;
  }))), vues);
  assert.deepStrictEqual(lisibles.slice().sort((a, b) => b - a), [1000, 800, 600], 'les trois photos, entières, dans leur taille');
  assert.deepStrictEqual(lisibles, [1000, 800, 600], 'dans l\'ordre choisi par Julie');

  await mamie.page.waitForTimeout(1100);
  await mamie.toucher('#overlay-close');
  await g.attendreBase(async () => (await postsDe(fid)).every((p) => p.seenAt), 'envoi marqué vu', 30_000);
  assert.strictEqual(await mamie.visible('#overlay'), false);
  assert.strictEqual((await postsDe(fid)).length, 1, 'un seul envoi');
});

test('Message avec emojis : affiché en entier chez Mamie, « Vu » chez Julie ; puis une vidéo, annoncée et regardée', async () => {
  const { julie, mamie, fid } = await familleChezMamie();
  const texte = 'Bisous de Lyon 😘❤️ à dimanche 👨‍👩‍👧 !';
  await g.ouvrirTuile(julie, 'messages');
  await julie.page.fill('#message-text', texte);
  await julie.page.click('#btn-message');
  await julie.page.locator('#messages li.bubble.mine', { hasText: 'Bisous de Lyon' }).waitFor();

  await chezMamie(mamie, '#overlay:not([hidden])', 60_000);
  const affiche = (await mamie.texte('#overlay-text')).replace(/\s+/g, ' ').trim();
  assert.strictEqual(affiche, texte.replace(' !', ' !').replace(/\s+/g, ' '), 'le message, emojis compris');
  // Aucun emoji remplacé par un carré vide ou un « ? » : le texte de la base est le même.
  assert.strictEqual((await postsDe(fid))[0].text, texte);
  await mamie.toucher('#overlay-close');
  await julie.page.locator('#messages li.bubble.mine', { hasText: 'Bisous de Lyon' }).locator('.bubble-foot', { hasText: 'Vu' }).waitFor({ timeout: 30_000 });
  assert.strictEqual(await mamie.visible('#overlay'), false);

  // Une vidéo.
  await julie.page.click('#view-messages .back');
  await g.attendreVue(julie, 'view-home');
  await g.ouvrirTuile(julie, 'videos');
  await julie.page.click('.fab[data-add="video"]');
  await julie.page.locator('#video-hint').waitFor({ state: 'visible' });
  await julie.page.setInputFiles('#in-video-gallery', await g.video({ secondes: 2 }));
  await g.visible(julie, '#btn-send').waitFor({ timeout: 30_000 });
  await julie.page.fill('#post-text', 'Coucou en vidéo 🎬');
  await julie.page.click('#btn-send');
  await g.toast(julie, 'Envoyé');
  await s.calme();

  await chezMamie(mamie, '#overlay.mode-video:not([hidden])', 90_000);
  assert.match(await enGrand(mamie), /Coucou en vidéo 🎬/);
  // L'appli a bien le fichier de la vidéo sur la tablette (téléchargé), prêt à être joué.
  const video = [].concat((mamie.envois() || {}).posts || mamie.envois() || []).find((p) => p.type === 'video');
  assert.ok(video, `la vidéo est donnée à la page\n${await diagnostic(mamie)}`);
  console.log('Vidéo donnée à la page :', JSON.stringify(video).slice(0, 400));
});
