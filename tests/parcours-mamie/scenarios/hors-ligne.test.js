// Sans internet chez Mamie : la box tombe, Mamie touche quand même « OK », la tablette est éteinte et rallumée
// (coupure de courant) toujours sans réseau, la famille continue d'envoyer. Au retour du réseau, tout se rattrape.

const { test, assert, banc, g, brancher, chezMamie, familleChezMamie, envoyerPhoto, enGrand, diagnostic } = require('../commun');

brancher();

const posts = async (fid) => g.liste(`families/${fid}/posts`);
const cadre = (mamie) => mamie.page.evaluate(() => new Promise((ok) => {
  const url = document.getElementById('frame-img').getAttribute('data-url') || '';
  if (!url) return ok({ url, largeur: 0 });
  const i = new Image();
  i.onload = () => ok({ url, largeur: i.naturalWidth });
  i.onerror = () => ok({ url, largeur: 0 });
  i.src = url;
}));

test('Box coupée : « OK » touché sans réseau, tablette rallumée sans réseau (photos toujours là, « Pas d\'internet »), puis tout se rattrape au retour', { timeout: 400_000 }, async () => {
  const { julie, mamie, fid } = await familleChezMamie();

  await envoyerPhoto(julie, { texte: 'A', legende: 'Photo A' });
  await chezMamie(mamie, '#overlay:not([hidden])', 60_000);
  await mamie.toucher('#overlay-close');
  await g.attendreBase(async () => (await posts(fid)).every((p) => p.seenAt), 'A vue', 30_000);

  // B arrive, puis la box tombe avant que Mamie ne touche OK.
  await envoyerPhoto(julie, { texte: 'B', legende: 'Photo B' });
  await chezMamie(mamie, '#overlay:not([hidden])', 60_000);
  assert.match(await enGrand(mamie), /Photo B/);
  await mamie.reseau(false);
  await mamie.toucher('#overlay-close');
  assert.strictEqual(await mamie.visible('#overlay'), false, 'OK ferme, même sans réseau');
  await mamie.page.waitForTimeout(3000);
  assert.strictEqual((await posts(fid)).filter((p) => !p.seenAt).length, 1, 'sans réseau, le « vu » de B n\'est pas encore parti');

  // Coupure de courant : la tablette redémarre, toujours sans internet.
  await mamie.rallumer();
  await mamie.page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 40_000 })
    .catch(async () => assert.fail(`L'écran de démarrage reste affiché sans réseau.\n${await diagnostic(mamie)}`));
  assert.strictEqual(await mamie.visible('#view-home'), true, 'accueil affiché sans réseau');
  const photo = await cadre(mamie);
  assert.ok(photo.largeur > 100, `la photo du cadre est toujours là sans réseau (${JSON.stringify(photo)})\n${await diagnostic(mamie)}`);
  await mamie.page.waitForTimeout(2000);
  assert.strictEqual(await mamie.visible('#overlay'), false, 'B, déjà vue, ne revient pas en grand au redémarrage');
  // « Pas d'internet » sur l'accueil (10 s après un démarrage sans réseau).
  await chezMamie(mamie, '.net-banner', 40_000);
  assert.match(await mamie.texte('.net-banner'), /Pas d’internet/);
  // Mamie peut toujours feuilleter ses photos.
  await mamie.toucher('#home-frame');
  await chezMamie(mamie, '#view-photos', 10_000);
  const feuilletees = await mamie.page.evaluate(() => Array.from(document.querySelectorAll('#photo-stage img')).map((i) => i.getAttribute('data-url')).filter(Boolean));
  assert.ok(feuilletees.length >= 1, 'diaporama sans réseau');

  // Pendant ce temps, Julie envoie C.
  await envoyerPhoto(julie, { texte: 'C', legende: 'Photo C' });
  await mamie.page.waitForTimeout(3000);
  assert.strictEqual(await mamie.visible('#overlay'), false);

  // Le réseau revient : C s'affiche, le « vu » de B part enfin.
  const retour = Date.now();
  await mamie.reseau(true);
  await chezMamie(mamie, '#overlay:not([hidden])', 150_000);
  console.log(`Retour du réseau : la photo en attente s'affiche au bout de ${Math.round((Date.now() - retour) / 1000)} s.`);
  assert.match(await enGrand(mamie), /Photo C/);
  await g.attendreBase(async () => (await posts(fid)).find((p) => p.text === 'Photo B').seenAt, 'le « vu » de B, touché sans réseau, part au retour', 150_000);
  console.log(`« Vu » de B parti ${Math.round((Date.now() - retour) / 1000)} s après le retour du réseau.`);
  await mamie.toucher('#overlay-close');
  await g.attendreBase(async () => (await posts(fid)).every((p) => p.seenAt), 'C vue', 60_000);
  await mamie.page.locator('.net-banner').waitFor({ state: 'hidden', timeout: 90_000 })
    .catch(async () => assert.fail(`« Pas d'internet » reste affiché après le retour du réseau.\n${await diagnostic(mamie)}`));
  // Ce que le navigateur de la tablette a écrit pendant la coupure est attendu.
  banc.tolerer(mamie, /ERR_INTERNET_DISCONNECTED|Could not reach Cloud Firestore backend|net::ERR_/);
});
