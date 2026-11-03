// Panne du serveur (inspection 5, 3/11) : Firebase répond « 503 » pendant un moment. Ce n'est pas « hors ligne »
// (le téléphone a du réseau) : l'appli ne doit ni tourner dans le vide, ni envoyer deux fois, ni perdre l'envoi.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

const PANNE = /503|Service Unavailable|ERR_|net::|Failed to fetch|unavailable|Backend|Could not reach|WebChannel|transport errored|ne répond pas|mis en attente|retry-limit|storage\//;
const postsDe = async (fid, type) => (await g.liste(`families/${fid}/posts`)).filter((p) => p.type === type);

// Tout ce qui va vers Firestore répond 503, comme un serveur en panne.
async function panneFirestore(t) {
  const etat = { active: true, coupees: 0 };
  await t.context.route(/\/google\.firestore\.v1\.Firestore\//, (route) => {
    if (!etat.active) return route.fallback();
    etat.coupees++;
    return route.fulfill({ status: 503, contentType: 'text/plain', body: 'Service Unavailable' });
  });
  return etat;
}

test('Serveur en panne (503) : un message s\'affiche tout de suite, une photo ne laisse pas « Envoi… » tourner sans fin, tout arrive une fois au retour', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await g.ouvrirTuile(julie, 'messages');
  const panne = await panneFirestore(julie);

  // Un message : visible tout de suite dans la conversation (mémoire de l'appli), bouton rendu en moins de 20 s.
  await julie.page.fill('#message-text', 'Pendant la panne');
  await julie.page.click('#btn-message');
  await julie.page.locator('#messages li.bubble.mine', { hasText: 'Pendant la panne' }).waitFor({ timeout: 10_000 });
  await julie.page.locator('#toast').filter({ hasText: 'Le serveur ne répond pas' }).waitFor({ state: 'visible', timeout: 25_000 });
  await julie.page.locator('#btn-message:not([disabled])').waitFor({ timeout: 25_000 });
  assert.strictEqual(await julie.page.locator('#messages li.bubble.mine', { hasText: 'Pendant la panne' }).count(), 1, 'le message une seule fois à l\'écran');
  assert.ok(panne.coupees > 0, 'le serveur a bien été coupé');

  // Une photo : la fenêtre se ferme au bout de 15 s avec l'explication, au lieu de « Envoi… » sans fin.
  await julie.page.click('#view-messages .back');
  await g.attendreVue(julie, 'view-home');
  await g.ouvrirTuile(julie, 'photos');
  await julie.page.click('.fab[data-add="photo"]');
  await julie.page.locator('#sheet-post').waitFor({ state: 'visible' });
  await julie.page.setInputFiles('#in-photo-gallery', [await g.photo({ texte: 'Panne', nom: 'panne.jpg' })]);
  await g.visible(julie, '#btn-send').waitFor();
  await julie.page.fill('#post-text', 'Photo pendant la panne');
  await julie.page.click('#btn-send');
  await julie.page.locator('#sheet-post').waitFor({ state: 'hidden', timeout: 30_000 });
  await julie.page.locator('#toast').filter({ hasText: 'Le serveur ne répond pas' }).waitFor({ state: 'visible', timeout: 5_000 });
  // Rien n'est parti : le serveur est en panne, et rien n'est mis dans la file « en attente de réseau » (ce serait deux fois).
  assert.strictEqual((await postsDe(fid, 'message')).filter((m) => m.text === 'Pendant la panne').length, 0);
  assert.ok(await julie.page.locator('#outbox').isHidden(), 'pas de file « en attente de réseau »');

  // Le serveur revient : tout part, une seule fois.
  panne.active = false;
  const message = await g.attendreBase(async () => { const l = (await postsDe(fid, 'message')).filter((m) => m.text === 'Pendant la panne'); return l.length && l; }, 'message parti', 120_000);
  assert.strictEqual(message.length, 1, 'le message une fois');
  const photo = await g.attendreBase(async () => { const l = (await postsDe(fid, 'photo')).filter((p) => p.text === 'Photo pendant la panne'); return l.length && l; }, 'photo partie', 120_000);
  assert.strictEqual(photo.length, 1, 'la photo une fois');
  assert.ok(photo[0].imageUrl || photo[0].image, 'avec son image');
  await new Promise((r) => setTimeout(r, 3000));
  assert.strictEqual((await postsDe(fid, 'message')).filter((m) => m.text === 'Pendant la panne').length, 1, 'toujours une fois');
  assert.strictEqual((await postsDe(fid, 'photo')).filter((p) => p.text === 'Photo pendant la panne').length, 1, 'toujours une fois');
  banc.tolerer(julie, PANNE);
});

test('Serveur en panne (503) à l\'ouverture : l\'appli s\'ouvre sur ce qu\'elle connaît, sans écran bloqué', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await g.ouvrirTuile(julie, 'photos');
  await julie.page.locator('#photos li.shot').first().waitFor();
  const panne = await panneFirestore(julie);
  await julie.page.reload();
  // L'accueil revient (données en mémoire), et la photo de l'installation est toujours là.
  await g.attendreVue(julie, 'view-home', 30_000);
  await g.ouvrirTuile(julie, 'photos');
  await julie.page.locator('#photos li.shot').first().waitFor({ timeout: 15_000 });
  assert.ok(panne.coupees > 0);
  panne.active = false;
  assert.ok(fid);
  banc.tolerer(julie, PANNE);
});
