// Les proches arrivent dans la famille : invitation par e-mail, code famille avec acceptation ou refus,
// rôle de responsable, retrait, départ.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

test('Invitation par e-mail : le proche invité voit l\'invitation et entre directement', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });

  // Julie invite Paul depuis « Inviter ».
  await julie.page.click('#btn-invite');
  await g.attendreVue(julie, 'view-invite');
  await julie.page.locator('#invite-email-card').waitFor({ state: 'visible' });
  await julie.page.fill('#invite-email', 'Paul@Exemple.fr');
  await julie.page.click('#form-invite button[type=submit]');
  await g.toast(julie, 'Invitation envoyée à');
  await julie.page.locator('#invitations-sent li', { hasText: 'paul@exemple.fr' }).waitFor();
  const mail = g.dernierMail('paul@exemple.fr');
  assert.ok(mail, 'e-mail d\'invitation parti');
  const lien = /https?:\/\/\S+\?code=([A-Z0-9-]+)&pour=([^\s"<>]+)/.exec(mail.texte);
  assert.ok(lien, `lien dans l'e-mail : ${mail.texte}`);

  // Paul ouvre le lien, se connecte avec l'adresse invitée : l'invitation l'attend.
  const paul = await banc.telephone('Paul');
  await g.inscrire(paul, 'paul@exemple.fr', 'Paul', { genre: 'homme', suite: `?code=${lien[1]}&pour=${lien[2]}` });
  await g.attendreVue(paul, 'view-invited');
  assert.match(await paul.page.locator('#invitations').innerText(), /Famille de Mamie Emma/);
  await paul.page.click('#invitations button[type=submit]');
  await g.attendreVue(paul, 'view-home');
  // Le genre et la photo donnés à l'inscription rejoignent sa fiche.
  const fiche = await g.attendreBase(async () => (await g.liste(`families/${fid}/members`))
    .find((m) => m.email === 'paul@exemple.fr' && m.genre && m.face), 'fiche de Paul complète');
  assert.strictEqual(fiche.status, 'active');
  assert.strictEqual(fiche.name, 'Paul');
  assert.strictEqual(fiche.genre, 'homme');
  // L'invitation remplie a disparu, chez Julie aussi.
  await g.attendreBase(async () => !(await g.liste(`families/${fid}/invitations`)).length, 'invitation effacée');
  await julie.page.locator('#invitations-sent li').waitFor({ state: 'detached' });
  // L'anniversaire de Paul est dans l'agenda de la famille.
  await g.attendreBase(async () => (await g.liste(`families/${fid}/birthdays`)).some((b) => b.name === 'Paul'), 'anniversaire de Paul');
});

test('Code famille : demande en attente, acceptée par la responsable, l\'app s\'ouvre toute seule', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const { code } = await g.lire(`families/${fid}`);

  const marc = await banc.telephone('Marc');
  await g.inscrire(marc, 'marc@exemple.fr', 'Marc', { genre: 'homme', suite: `?code=${code}&pour=Mamie%20Emma` });
  await g.attendreVue(marc, 'view-join');
  assert.match(await marc.page.locator('#join-title').innerText(), /Rejoindre la famille de Mamie Emma/);
  await marc.page.click('#form-join button[type=submit]');
  await g.attendreVue(marc, 'view-pending');

  // Julie voit la demande sur l'accueil et l'accepte.
  const carte = julie.page.locator('#pending-banner .join-card', { hasText: 'Marc' });
  await carte.waitFor();
  assert.match(await carte.innerText(), /marc@exemple\.fr/);
  await carte.locator('.join-ok').click();
  await g.toast(julie, 'Marc a rejoint la famille');
  await g.attendreVue(marc, 'view-home');
  await g.fermerAccueil(marc);
  assert.strictEqual(await marc.page.locator('#tile-settings').isVisible(), true);
});

test('Code famille : demande refusée, le proche revient à l\'écran pour rejoindre', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const { code } = await g.lire(`families/${fid}`);

  const inconnu = await banc.telephone('Inconnu');
  await g.inscrire(inconnu, 'inconnu@exemple.fr', 'Kevin', { genre: 'homme', suite: `?code=${code}` });
  await g.attendreVue(inconnu, 'view-join');
  await inconnu.page.click('#form-join button[type=submit]');
  await g.attendreVue(inconnu, 'view-pending');

  const carte = julie.page.locator('#pending-banner .join-card', { hasText: 'Kevin' });
  await carte.locator('.join-no').click();
  await g.repondre(julie, 'Refuser');
  await g.toast(julie, 'Demande refusée');
  await g.attendreVue(inconnu, 'view-join');
  assert.strictEqual((await g.liste(`families/${fid}/members`)).some((m) => m.name === 'Kevin'), false);
});

test('Code faux, puis responsable désigné, membre retiré, départ d\'un proche', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const { code } = await g.lire(`families/${fid}`);

  // Un code mal recopié.
  const paul = await banc.telephone('Paul');
  await g.inscrire(paul, 'paul@exemple.fr', 'Paul', { genre: 'homme' });
  await g.attendreVue(paul, 'view-join');
  await paul.page.fill('#join-code', 'ZZZZ-ZZZZ');
  await paul.page.click('#form-join button[type=submit]');
  await paul.page.locator('#join-error', { hasText: 'Ce code ne correspond à aucune famille' }).waitFor();
  banc.tolerer(paul, /CodeInconnuError/);
  // Le bon code.
  await paul.page.fill('#join-code', code);
  await paul.page.click('#form-join button[type=submit]');
  await g.attendreVue(paul, 'view-pending');
  await julie.page.locator('#pending-banner .join-ok').click();
  await g.attendreVue(paul, 'view-home');
  await g.fermerAccueil(paul);
  const uidPaul = (await g.liste(`families/${fid}/members`)).find((m) => m.name === 'Paul').id;

  // Julie rend Paul responsable (Réglages > membres, menu ⋮).
  await g.ouvrirTuile(julie, 'settings');
  await julie.page.click('button[aria-label="Actions pour Paul"]');
  await g.repondre(julie, 'Rendre responsable');
  await g.repondre(julie, 'Rendre responsable');
  await g.attendreBase(async () => ((await g.lire(`families/${fid}`)).admins || []).includes(uidPaul), 'Paul responsable');
  await julie.page.locator('#members li', { hasText: 'Paul' }).locator('.badge').waitFor();

  // Paul, responsable, ne peut pas retirer Julie (propriétaire) : pas de menu ⋮ pour elle.
  await g.ouvrirTuile(paul, 'settings');
  await paul.page.locator('#members li', { hasText: 'Julie' }).waitFor();
  assert.strictEqual(await paul.page.locator('button[aria-label="Actions pour Julie"]').count(), 0);

  // Julie retire Paul de la famille : son téléphone revient à l'écran pour rejoindre.
  await julie.page.click('button[aria-label="Actions pour Paul"]');
  await g.repondre(julie, 'Retirer de la famille');
  await g.repondre(julie, 'Retirer');
  assert.match(await g.texteFenetre(paul), /Vous ne faites plus partie de la famille de Mamie Emma/);
  await g.repondre(paul, 'OK');
  await g.attendreVue(paul, 'view-join');
  assert.strictEqual(await paul.page.evaluate(() => localStorage.getItem('papote.fid')), null);
  await g.attendreBase(async () => !((await g.lire(`families/${fid}`)).admins || []).includes(uidPaul), 'rôle de Paul retiré');
});
