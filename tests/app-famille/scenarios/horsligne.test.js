// Sans réseau : les envois (message, photos) sont gardés sur le téléphone et partent tout seuls
// au retour du réseau, même si l'app a été fermée entre-temps.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

const RESEAU = /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_FAILED|Could not reach Cloud Firestore|WebChannelConnection|net::/;

async function envoyerHorsLigne(t) {
  await t.context.setOffline(true);
  await g.ouvrirTuile(t, 'messages');
  await t.page.fill('#message-text', 'Écrit dans le métro');
  await t.page.click('#btn-message');
  await g.toast(t, 'Pas de réseau : l\'envoi partira tout seul');
  assert.strictEqual(await t.page.inputValue('#message-text'), '', 'le champ est vidé');
  // Le message n'a pas l'air perdu : la page Messages le dit.
  await t.page.locator('#view-messages .outbox', { hasText: '1 envoi en attente de réseau' }).waitFor();
  await t.page.click('#view-messages .back');
  await g.attendreVue(t, 'view-home');
  await t.page.locator('#outbox', { hasText: '1 envoi en attente de réseau' }).waitFor();

  await g.ouvrirTuile(t, 'photos');
  await t.page.click('.fab[data-add="photo"]');
  await t.page.locator('#sheet-post').waitFor({ state: 'visible' });
  await t.page.setInputFiles('#in-photo-gallery', [await g.photo({ texte: 'A', nom: 'a.jpg' }), await g.photo({ texte: 'B', nom: 'b.jpg' })]);
  await g.visible(t, '#btn-send').waitFor();
  await t.page.fill('#post-text', 'Sans réseau');
  await t.page.click('#btn-send');
  await g.toast(t, 'Pas de réseau');
  await t.page.locator('#sheet-post').waitFor({ state: 'hidden' });
  await t.page.locator('#view-photos .outbox', { hasText: '2 envois en attente de réseau' }).waitFor();
  await t.page.click('#view-photos .back');
  await g.attendreVue(t, 'view-home');
}

async function verifierPartis(fid) {
  const posts = await g.attendreBase(async () => {
    const l = await g.liste(`families/${fid}/posts`);
    return l.some((p) => p.text === 'Écrit dans le métro') && l.some((p) => p.text === 'Sans réseau') && l;
  }, 'envois partis');
  const album = posts.filter((p) => p.text === 'Sans réseau');
  assert.strictEqual(album.length, 1, 'les deux photos dans un seul envoi');
  assert.strictEqual(album[0].photos.length, 2);
  assert.match(album[0].imageUrl, /^https:\/\/firebasestorage\.googleapis\.com\//, 'photos dans Storage');
  assert.strictEqual(posts.filter((p) => p.text === 'Écrit dans le métro').length, 1, 'message envoyé une seule fois');
}

test('Hors ligne : message et photos mis en attente, partis dès le retour du réseau', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await envoyerHorsLigne(julie);

  await julie.context.setOffline(false);
  await g.toast(julie, 'Envois en attente partis');
  await julie.page.locator('#outbox').waitFor({ state: 'hidden' });
  await verifierPartis(fid);
  banc.tolerer(julie, RESEAU);
});

test('Hors ligne puis app fermée : les envois partent à la prochaine ouverture', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await envoyerHorsLigne(julie);
  await julie.page.close();
  banc.tolerer(julie, RESEAU);

  await julie.context.setOffline(false);
  julie.page = await julie.context.newPage();
  await julie.page.goto(banc.origine);
  await g.attendreVue(julie, 'view-home');
  await g.toast(julie, 'Envois en attente partis');
  await verifierPartis(fid);
});
