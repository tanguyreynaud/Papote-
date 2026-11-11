// Le jour où Mamie reçoit sa tablette : commande du site, tablette reliée dans Stock, colis, « Commencer »,
// la tablette entre seule dans la famille, le proche qui a payé entre par son e-mail, première photo, « Vu ».

const { test, assert, banc, g, s, brancher, chezMamie, commandeLivree, brancherChezMamie, entrerDansSaFamille, envoyerPhoto } = require('../commun');

brancher();

test('Commande, colis, « Commencer » : la tablette entre seule dans sa famille ; première photo affichée chez Mamie, « Vu » chez Julie', async () => {
  const julie = await banc.telephone('Julie');
  await g.inscrire(julie, 'julie@exemple.fr', 'Julie', { genre: 'femme' });
  const { mamie, commande } = await commandeLivree({ email: 'julie@exemple.fr' });

  const fid = await brancherChezMamie(mamie);
  assert.strictEqual((await g.lire(`commandes/${commande}`)).fid, fid, 'la famille de la commande');

  await entrerDansSaFamille(julie, fid);
  await envoyerPhoto(julie, { texte: 'Coucou', legende: 'Bonjour Mamie 👋' });

  // Chez Mamie : la photo s'affiche en grand, avec la légende.
  // Tablette tout juste installée : sa page des appels rejoint la famille dans la minute, et d'ici là l'appli
  // relit le serveur toutes les 2 minutes. La première photo peut donc mettre jusqu'à 2 minutes (mesuré ici).
  const debut = Date.now();
  await chezMamie(mamie, '#overlay:not([hidden])', 150_000);
  console.log(`Première photo affichée chez Mamie ${Math.round((Date.now() - debut) / 1000)} s après l'envoi.`);
  assert.match(await mamie.texte('#overlay'), /Bonjour Mamie 👋/);
  assert.match(await mamie.texte('#overlay'), /Julie/);
  // La photo elle-même est bien sur la tablette (téléchargée par l'appli, servie à la page).
  const image = await mamie.page.evaluate(() => new Promise((ok) => {
    const url = document.getElementById('overlay-img').getAttribute('data-url') || document.getElementById('overlay-img').src;
    const i = new Image();
    i.onload = () => ok({ url, largeur: i.naturalWidth });
    i.onerror = () => ok({ url, largeur: 0 });
    i.src = url;
  }));
  assert.ok(image.largeur > 100, `photo lisible sur la tablette (${JSON.stringify(image)})`);

  // Mamie touche OK : Julie voit « Vu ».
  await mamie.toucher('#overlay-close');
  await g.attendreBase(async () => (await g.liste(`families/${fid}/posts`)).every((p) => p.seenAt), 'photo marquée vue', 30_000);
  assert.strictEqual(await mamie.visible('#overlay'), false);
});
