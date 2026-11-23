// Toutes les façons d'arriver par un lien d'invitation (lien ou QR code « ?code=…&pour=… », e-mail d'invitation)
// (Tanguy, 18/11) : compte neuf, proche déjà inscrit dans une autre famille (avant, le lien était oublié sans un mot),
// déjà membre de la famille du lien, demande déjà envoyée, invitation par e-mail, code qui ne correspond à rien.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

const lienDe = (code, pour = 'Mamie Emma') => `?code=${code}&pour=${encodeURIComponent(pour)}`;
const codeGarde = (t) => t.page.evaluate(() => localStorage.getItem('papote.codeInvite'));

/** Paul a déjà sa famille (Papi Jean) ; Julie a celle de Mamie Emma. */
async function deuxFamilles() {
  const julie = await banc.telephone('Julie');
  const { fid: emma } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const paul = await banc.telephone('Paul');
  const { fid: jean } = await g.familleInstallee(paul, { email: 'paul@exemple.fr', prenom: 'Paul', nom: 'Papi Jean', genre: 'homme' });
  const { code } = await g.lire(`families/${emma}`);
  return { julie, paul, emma, jean, code };
}

test('Compte neuf : le lien propose « Rejoindre la famille de Mamie Emma », sans code à taper', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const { code } = await g.lire(`families/${fid}`);

  const marc = await banc.telephone('Marc');
  await g.inscrire(marc, 'marc@exemple.fr', 'Marc', { genre: 'homme', suite: lienDe(code) });
  await g.attendreVue(marc, 'view-join');
  assert.strictEqual(await marc.page.locator('#join-title').innerText(), 'Rejoindre la famille de Mamie Emma');
  assert.strictEqual(await marc.page.locator('#join-code-wrap').isVisible(), false, 'code déjà rempli, caché');
  // Pas encore de famille : ni « Plus tard » ni « Retour », mais « Se déconnecter ».
  assert.strictEqual(await marc.page.locator('#join-later').isVisible(), false);
  assert.strictEqual(await marc.page.locator('#btn-join-back').isVisible(), false);
  assert.strictEqual(await marc.page.locator('#join-logout').isVisible(), true);
  await g.doubleAppui(marc, '#form-join button[type=submit]');
  await g.attendreVue(marc, 'view-pending');
  const demandes = (await g.liste(`families/${fid}/members`)).filter((m) => m.email === 'marc@exemple.fr');
  assert.strictEqual(demandes.length, 1, 'une seule demande au double appui');
  assert.strictEqual(demandes[0].status, 'pending');
});

test('Déjà inscrit ailleurs : « Plus tard » garde sa famille, puis « Rejoindre » ; une fois accepté, le lien ouvre cette famille', async () => {
  const { julie, paul, emma, jean, code } = await deuxFamilles();

  // Paul, sur l'accueil de Papi Jean, ouvre le lien de Julie (même chose par le QR code).
  await g.ouvrir(paul, lienDe(code));
  await g.attendreVue(paul, 'view-join');
  assert.strictEqual(await paul.page.locator('#join-title').innerText(), 'Rejoindre la famille de Mamie Emma');
  assert.match(await paul.page.locator('#join-help').innerText(), /Vous gardez aussi vos autres familles/);
  assert.strictEqual(await paul.page.locator('#join-later').isVisible(), true);
  assert.strictEqual(await paul.page.locator('#join-code-wrap').isVisible(), false);
  // Déjà dans une famille : pas de « Se déconnecter » ici, un seul moyen de sortir (« Plus tard »).
  assert.strictEqual(await paul.page.locator('#join-logout').isVisible(), false);
  assert.strictEqual(await paul.page.locator('#btn-join-back').isVisible(), false);
  // « Plus tard » et « Rejoindre » ont la même taille.
  const [oui, non] = await Promise.all(['#form-join button[type=submit]', '#join-later']
    .map((sel) => paul.page.locator(sel).boundingBox()));
  assert.strictEqual(Math.round(oui.height), Math.round(non.height));
  assert.strictEqual(Math.round(oui.width), Math.round(non.width));

  // « Plus tard » : retour sur Papi Jean, rien demandé, le lien est oublié (pas reproposé en rouvrant l'appli).
  await paul.page.click('#join-later');
  await g.attendreVue(paul, 'view-home');
  assert.strictEqual(await paul.page.evaluate(() => localStorage.getItem('papote.fid')), jean);
  assert.strictEqual(await codeGarde(paul), null);
  assert.strictEqual((await g.liste(`families/${emma}/members`)).some((m) => m.email === 'paul@exemple.fr'), false);
  await paul.page.reload();
  await g.attendreVue(paul, 'view-home');

  // Le lien rouvert : « Rejoindre » (double appui = une demande). L'accueil reste sur Papi Jean et dit que c'est parti.
  await g.ouvrir(paul, lienDe(code));
  await g.attendreVue(paul, 'view-join');
  await g.doubleAppui(paul, '#form-join button[type=submit]');
  assert.match(await g.texteFenetre(paul), /Demande envoyée pour rejoindre la famille de Mamie Emma/);
  await g.repondre(paul, 'OK');
  await g.attendreVue(paul, 'view-home');
  assert.strictEqual(await paul.page.evaluate(() => localStorage.getItem('papote.fid')), jean);
  const demandes = (await g.liste(`families/${emma}/members`)).filter((m) => m.email === 'paul@exemple.fr');
  assert.strictEqual(demandes.length, 1);
  assert.strictEqual(demandes[0].status, 'pending');
  // Sa famille d'avant est intacte.
  assert.strictEqual((await g.liste(`families/${jean}/members`)).find((m) => m.email === 'paul@exemple.fr').status, 'active');

  // Le lien rouvert pendant l'attente : pas de 2e demande, juste un mot.
  await g.ouvrir(paul, lienDe(code));
  assert.match(await g.texteFenetre(paul), /déjà demandé à rejoindre la famille de Mamie Emma/);
  await g.repondre(paul, 'OK');
  await g.attendreVue(paul, 'view-home');
  assert.strictEqual(await codeGarde(paul), null);

  // Julie accepte. Paul a deux familles : le bouton « Pour … » permet de changer.
  await julie.page.locator('#pending-banner .join-card', { hasText: 'Paul' }).locator('.join-ok').click();
  await g.toast(julie, 'Paul a rejoint la famille');
  await g.attendreBase(async () => (await g.liste(`families/${emma}/members`))
    .find((m) => m.email === 'paul@exemple.fr')?.status === 'active', 'Paul accepté');

  // Déjà membre : le lien ouvre simplement la famille de Mamie Emma, sans rien demander.
  await g.ouvrir(paul, lienDe(code));
  await g.attendreVue(paul, 'view-home');
  await g.fermerAccueil(paul);
  await paul.page.locator('#family-switch', { hasText: 'Pour Mamie Emma' }).waitFor();
  assert.strictEqual(await paul.page.evaluate(() => localStorage.getItem('papote.fid')), emma);
  assert.strictEqual(await codeGarde(paul), null);
  await paul.page.click('#family-switch');
  await g.repondre(paul, 'Famille de Papi Jean');
  await paul.page.locator('#family-switch', { hasText: 'Pour Papi Jean' }).waitFor();
});

test('Déjà membre de la famille du lien (seule famille) : l\'appli s\'ouvre, rien n\'est demandé', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const { code } = await g.lire(`families/${fid}`);
  // Julie ouvre son propre lien (par exemple pour le tester avant de l'envoyer).
  await g.ouvrir(julie, lienDe(code));
  await g.attendreVue(julie, 'view-home');
  await g.fermerAccueil(julie);
  assert.strictEqual(await julie.page.locator('.dialog-back:not(.closing) .dialog').count(), 0);
  assert.strictEqual(await codeGarde(julie), null);
});

test('Invitation par e-mail d\'un proche déjà inscrit : l\'invitation, puis la famille ; « Plus tard » ne repropose rien', async () => {
  const { julie, paul, emma, jean } = await deuxFamilles();

  // Julie invite Paul par e-mail.
  await julie.page.click('#btn-invite');
  await g.attendreVue(julie, 'view-invite');
  await julie.page.locator('#invite-email-card').waitFor({ state: 'visible' });
  await julie.page.fill('#invite-email', 'paul@exemple.fr');
  await julie.page.click('#form-invite button[type=submit]');
  await g.repondre(julie, 'Inviter'); // « Inviter cette personne ? »
  await g.toast(julie, 'Invitation envoyée à');
  const mail = g.dernierMail('paul@exemple.fr');
  const lien = /https?:\/\/\S+(\?code=[A-Z0-9-]+&pour=[^\s"<>]+)/.exec(mail.texte);
  assert.ok(lien, `lien dans l'e-mail : ${mail.texte}`);

  // « Plus tard » sur l'invitation : retour sur Papi Jean, sans 2e question pour le même lien.
  await g.ouvrir(paul, lien[1]);
  await g.attendreVue(paul, 'view-invited');
  assert.match(await paul.page.locator('#invitations').innerText(), /Famille de Mamie Emma/);
  await paul.page.click('#btn-skip-invites');
  await g.attendreVue(paul, 'view-home');
  assert.strictEqual(await paul.page.evaluate(() => localStorage.getItem('papote.fid')), jean);
  assert.strictEqual(await codeGarde(paul), null);

  // Le lien de l'e-mail rouvert : « Rejoindre la famille », il entre directement (invité par son adresse).
  await g.ouvrir(paul, lien[1]);
  await g.attendreVue(paul, 'view-invited');
  await paul.page.click('#invitations button[type=submit]');
  await g.attendreVue(paul, 'view-home');
  await g.fermerAccueil(paul);
  await paul.page.locator('#family-switch', { hasText: 'Pour Mamie Emma' }).waitFor();
  const fiche = (await g.liste(`families/${emma}/members`)).find((m) => m.email === 'paul@exemple.fr');
  assert.strictEqual(fiche.status, 'active');
  assert.strictEqual((await g.liste(`families/${jean}/members`)).find((m) => m.email === 'paul@exemple.fr').status, 'active');
  await g.attendreBase(async () => !(await g.liste(`families/${emma}/invitations`)).length, 'invitation effacée');
});

test('Code du lien qui ne correspond à aucune famille : un mot clair et le code à corriger', async () => {
  // Déjà inscrit : le mot tout de suite, le code visible, « Retour » vers sa famille.
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await g.ouvrir(julie, lienDe('ZZZZ-ZZZZ', 'Personne'));
  await g.attendreVue(julie, 'view-join');
  await julie.page.locator('#join-error', { hasText: 'Ce code ne correspond à aucune famille' }).waitFor();
  assert.strictEqual(await julie.page.locator('#join-code-wrap').isVisible(), true);
  assert.strictEqual(await julie.page.inputValue('#join-code'), 'ZZZZ-ZZZZ');
  assert.strictEqual(await julie.page.locator('#join-title').innerText(), 'Rejoindre une famille');
  assert.strictEqual(await julie.page.locator('#join-later').isVisible(), false);
  await julie.page.click('#btn-join-back');
  await g.attendreVue(julie, 'view-home');
  assert.strictEqual(await codeGarde(julie), null);

  // Compte neuf : « Rejoindre », le mot, et le code montré pour être corrigé.
  const marc = await banc.telephone('Marc');
  await g.inscrire(marc, 'marc@exemple.fr', 'Marc', { genre: 'homme', suite: lienDe('ZZZZ-ZZZZ') });
  await g.attendreVue(marc, 'view-join');
  assert.strictEqual(await marc.page.locator('#join-code-wrap').isVisible(), false);
  await marc.page.click('#form-join button[type=submit]');
  await marc.page.locator('#join-error', { hasText: 'Ce code ne correspond à aucune famille' }).waitFor();
  banc.tolerer(marc, /CodeInconnuError|Code refusé/);
  assert.strictEqual(await marc.page.locator('#join-code-wrap').isVisible(), true);
  assert.strictEqual(await marc.page.inputValue('#join-code'), 'ZZZZ-ZZZZ');
  assert.strictEqual(await codeGarde(marc), null);
});
