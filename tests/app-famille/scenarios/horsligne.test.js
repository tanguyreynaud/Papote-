// Sans réseau : les envois (message, photos) sont gardés sur le téléphone et partent tout seuls
// au retour du réseau, même si l'app a été fermée entre-temps.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

const RESEAU = /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_FAILED|Could not reach Cloud Firestore|WebChannelConnection|net::/;

async function envoyerHorsLigne(t) {
  await g.reseau(t, true);
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
  await g.retourAccueil(t); // Photos : la barre du bas, plus de flèche (cohérence, 23/11)
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

  await g.reseau(julie, false);
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

  await g.reseau(julie, false);
  julie.page = await julie.context.newPage();
  await julie.page.goto(banc.origine);
  await g.attendreVue(julie, 'view-home');
  await g.toast(julie, 'Envois en attente partis');
  await verifierPartis(fid);
});

test('Sans réseau, mon message en attente se supprime (19/11) : il ne part pas au retour du réseau', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  banc.tolerer(julie, RESEAU);
  await g.reseau(julie, true);
  await g.ouvrirTuile(julie, 'messages');
  for (const texte of ['À garder', 'À retirer']) {
    await julie.page.fill('#message-text', texte);
    await julie.page.click('#btn-message');
    await g.toast(julie, 'Pas de réseau : l\'envoi partira tout seul');
  }
  const bulle = julie.page.locator('#messages li.bubble.mine.en-route', { hasText: 'À retirer' });
  await bulle.locator('.bubble-foot', { hasText: 'En attente de réseau' }).waitFor();
  // Double appui : une seule question.
  await bulle.locator('.bubble-del').dblclick();
  await julie.page.locator('.dialog-back:not(.closing) .dialog').first().waitFor();
  assert.strictEqual(await julie.page.locator('.dialog-back:not(.closing) .dialog').count(), 1, 'une seule question');
  await g.repondre(julie, 'Supprimer');
  await g.toast(julie, 'Message supprimé');
  await bulle.waitFor({ state: 'detached' });
  await julie.page.locator('#view-messages .outbox', { hasText: '1 envoi en attente de réseau' }).waitFor();

  await g.reseau(julie, false);
  await g.toast(julie, 'Envoi en attente parti');
  const textes = await g.attendreBase(async () => {
    const l = (await g.liste(`families/${fid}/posts`)).filter((p) => p.type === 'message').map((p) => p.text);
    return l.includes('À garder') && l;
  }, 'message gardé parti');
  assert.deepStrictEqual(textes, ['À garder'], 'le message supprimé n\'est jamais parti');
  // Une fois parti, mon message garde sa poubelle.
  await julie.page.locator('#messages li.bubble.mine:not(.en-route)', { hasText: 'À garder' }).locator('.bubble-del').waitFor();
});
