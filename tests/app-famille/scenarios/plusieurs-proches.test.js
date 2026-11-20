// Plusieurs proches en même temps (audit du 19/11) : trois envois au même instant, deux appels vers la tablette au
// même instant, deux responsables qui nomment chacun un responsable, photo supprimée pendant qu'un autre la regarde ;
// adresse e-mail incomplète (« paul@exemple ») refusée à la connexion et à l'invitation.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');
const tablette = require('../tablette');

const { s } = banc;

banc.brancher();

async function trois() {
  const julie = await banc.telephone('Julie');
  const paul = await banc.telephone('Paul');
  const marc = await banc.telephone('Marc');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });
  await g.rejoindre(julie, fid, marc, { email: 'marc@exemple.fr', prenom: 'Marc' });
  return { julie, paul, marc, fid, tab };
}

test('Trois proches envoient une photo puis un message au même instant : tout arrive, chez tout le monde', async () => {
  const { julie, paul, marc, fid } = await trois();
  const tels = [julie, paul, marc];
  for (const t of tels) {
    await g.ouvrirTuile(t, 'photos');
    await t.page.click('.fab[data-add="photo"]');
    await t.page.locator('#sheet-post').waitFor({ state: 'visible' });
    await t.page.setInputFiles('#in-photo-gallery', await g.photo({ texte: t.nom }));
    await t.page.locator('#btn-send').filter({ visible: true }).waitFor();
  }
  await Promise.all(tels.map((t) => t.page.click('#btn-send')));
  await Promise.all(tels.map((t) => g.toast(t, 'Envoyé')));
  // La première photo de Julie (installation) plus les trois.
  await g.attendreBase(async () => (await g.liste(`families/${fid}/posts`)).filter((p) => p.type === 'photo').length === 4, '4 photos');
  for (const t of tels) await t.page.waitForFunction(() => document.querySelectorAll('#photos li.shot').length === 4);
  for (const t of tels) { await t.page.click('#view-photos .page-head .back'); await g.ouvrirTuile(t, 'messages'); }
  for (const t of tels) await t.page.fill('#message-text', `Bisous de ${t.nom}`);
  await Promise.all(tels.map((t) => t.page.click('#btn-message')));
  await g.attendreBase(async () => (await g.liste(`families/${fid}/posts`)).filter((p) => /^Bisous de/.test(p.text || '')).length === 3, '3 messages');
  for (const t of tels) await t.page.waitForFunction(() => document.querySelectorAll('#messages li').length === 3);
});

test('Deux proches appellent la tablette au même instant : un seul appel sonne, l\'autre entend « déjà en communication »', async () => {
  const { julie, paul, fid, tab } = await trois();
  await tablette.ouvrir(fid, tab);
  for (const t of [julie, paul]) {
    await t.page.locator('#tile-call:not([disabled])').waitFor();
    await t.page.click('#tile-call');
    await t.page.locator('.dialog-back:not(.closing) .dialog button', { hasText: 'Appeler' }).waitFor();
  }
  await Promise.all([g.repondre(julie, 'Appeler'), g.repondre(paul, 'Appeler')]);
  // L'un des deux entend « déjà en communication » (le mot reste 4 s), l'autre sonne ; un seul appel vivant.
  const dejaEnCours = (t) => t.page.locator('#call-status', { hasText: 'déjà en communication' })
    .waitFor({ timeout: 12_000 }).then(() => t);
  const perdant = await Promise.any([dejaEnCours(julie), dejaEnCours(paul)]);
  const gagnant = perdant === julie ? paul : julie;
  await gagnant.page.locator('#call-status', { hasText: 'Ça sonne' }).waitFor();
  const appels = await g.liste(`families/${fid}/calls`);
  assert.strictEqual(appels.filter((c) => c.state === 'ringing').length, 1, JSON.stringify(appels.map((c) => [c.callerName, c.state])));
  assert.strictEqual(appels.find((c) => c.state === 'ringing').callerName, gagnant.nom);
  await perdant.page.locator('#call').waitFor({ state: 'hidden', timeout: 10_000 });
  await perdant.page.waitForTimeout(2500);
  assert.strictEqual(await perdant.page.locator('.dialog-back', { hasText: 'message vidéo' }).count(), 0, 'pas de « laisser un message vidéo »');
  await gagnant.page.click('#call-hangup');
  await gagnant.page.locator('#call').waitFor({ state: 'hidden', timeout: 10_000 });
});

test('Deux responsables nomment chacun un responsable au même instant : les deux sont gardés', async () => {
  const { julie, paul, marc, fid } = await trois();
  await s.db.doc(`families/${fid}`).update({ admins: s.FieldValue.arrayUnion(paul.uid) });
  const lea = await banc.telephone('Lea');
  await g.rejoindre(julie, fid, lea, { email: 'lea@exemple.fr', prenom: 'Lea', genre: 'femme' });
  for (const t of [julie, paul]) await g.ouvrirTuile(t, 'settings');
  await julie.page.click('button[aria-label="Actions pour Marc"]');
  await g.repondre(julie, 'Rendre responsable');
  await paul.page.locator('button[aria-label="Actions pour Lea"]').click();
  await g.repondre(paul, 'Rendre responsable');
  await Promise.all([g.repondre(julie, 'Rendre responsable'), g.repondre(paul, 'Rendre responsable')]);
  const f = await g.attendreBase(async () => {
    const fam = await g.lire(`families/${fid}`);
    return fam.admins.includes(marc.uid) && fam.admins.includes(lea.uid) && fam;
  }, 'Marc et Léa responsables');
  assert.ok(f.admins.includes(paul.uid), 'Paul reste responsable');
});

test('Photo supprimée par Julie pendant que Paul la regarde en grand : la visionneuse se ferme avec un mot', async () => {
  const { julie, paul } = await trois();
  await g.ouvrirTuile(julie, 'photos');
  await julie.page.click('.fab[data-add="photo"]');
  await julie.page.setInputFiles('#in-photo-gallery', await g.photo({ texte: 'Plage' }));
  await julie.page.fill('#post-text', 'A la plage');
  await julie.page.click('#btn-send');
  await g.toast(julie, 'Envoyé');
  await g.ouvrirTuile(paul, 'photos');
  await paul.page.locator('#photos li.shot', { hasText: 'A la plage' }).locator('.shot-frame').click();
  await paul.page.locator('#viewer').waitFor({ state: 'visible' });
  await julie.page.locator('#photos li.shot', { hasText: 'A la plage' }).locator('button[aria-label*="Supprimer"]').click();
  await g.repondre(julie, 'Supprimer');
  await paul.page.locator('#viewer').waitFor({ state: 'hidden', timeout: 10_000 });
  await g.toast(paul, 'Cette photo a été retirée');
  await g.attendreVue(paul, 'view-photos');
  assert.strictEqual(await paul.page.locator('#photos li.shot', { hasText: 'A la plage' }).count(), 0);
});

test('Adresse e-mail sans « .fr » : refusée à la connexion et à l\'invitation, rien d\'envoyé', async () => {
  const paul = await banc.telephone('Paul');
  await g.ouvrir(paul);
  await g.attendreVue(paul, 'view-login');
  await paul.page.fill('#login-email', 'paul@exemple');
  await paul.page.click('#btn-email');
  await paul.page.locator('#login-error', { hasText: 'semble incomplète' }).waitFor();
  assert.ok(await paul.page.locator('#email-sent').isHidden(), 'pas de « Lien envoyé »');
  assert.strictEqual((await g.codesEmail('paul@exemple')).length, 0, 'aucun lien parti');

  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await julie.page.click('#btn-invite');
  await g.attendreVue(julie, 'view-invite');
  await julie.page.fill('#invite-email', 'lea@exemple');
  await julie.page.click('#form-invite button[type=submit]');
  assert.match(await g.texteFenetre(julie), /semble incomplète/);
  await g.repondre(julie, 'OK');
  assert.strictEqual((await g.liste(`families/${fid}/invitations`)).length, 0);
  assert.strictEqual(s.boite.filter((m) => m.a === 'lea@exemple').length, 0);
});

test('Même adresse invitée deux fois (renvoi, ou deux responsables au même instant) : l\'e-mail repart, aucun « n\'a pas pu être enregistrée »', async () => {
  const { julie, paul, fid } = await trois();
  await s.db.doc(`families/${fid}`).update({ admins: s.FieldValue.arrayUnion(paul.uid) });
  for (const t of [julie, paul]) {
    await t.page.click('#btn-invite');
    await g.attendreVue(t, 'view-invite');
    await t.page.locator('#invite-email-card').waitFor({ state: 'visible' });
    await t.page.fill('#invite-email', 'lea@exemple.fr');
  }
  await Promise.all([julie.page.click('#form-invite button[type=submit]'), paul.page.click('#form-invite button[type=submit]')]);
  await g.toast(julie, 'Invitation envoyée à lea@exemple.fr');
  await g.toast(paul, 'Invitation envoyée à lea@exemple.fr');
  // Plus tard, Julie la renvoie parce que Léa ne l'a pas reçue.
  await julie.page.fill('#invite-email', 'Lea@exemple.fr');
  await julie.page.click('#form-invite button[type=submit]');
  await g.toast(julie, 'Invitation envoyée');
  assert.strictEqual(s.boite.filter((m) => m.a === 'lea@exemple.fr').length, 3, 'un e-mail par envoi');
  assert.deepStrictEqual((await g.liste(`families/${fid}/invitations`)).map((i) => i.id), ['lea@exemple.fr']);
  for (const t of [julie, paul]) assert.strictEqual(await t.page.locator('.dialog-back').count(), 0, `${t.nom} : aucune fenêtre d'erreur`);
});

test('Demande acceptée par Julie pendant que Paul la refuse : Ana reste dans la famille ; refusée puis acceptée : rien ne casse', async () => {
  const { julie, paul, fid } = await trois();
  await s.db.doc(`families/${fid}`).update({ admins: s.FieldValue.arrayUnion(paul.uid) });
  await paul.page.reload();
  await g.attendreVue(paul, 'view-home', 30_000);
  await g.fermerAccueil(paul);
  const { code } = await g.lire(`families/${fid}`);
  const demande = async (tel, email, prenom) => {
    await g.inscrire(tel, email, prenom, { genre: 'femme', suite: `?code=${code}` });
    await g.attendreVue(tel, 'view-join');
    await tel.page.click('#form-join button[type=submit]');
    await g.attendreVue(tel, 'view-pending');
    for (const t of [julie, paul]) await t.page.locator('#pending-banner .join-card', { hasText: prenom }).waitFor();
  };
  const ana = await banc.telephone('Ana');
  await demande(ana, 'ana@exemple.fr', 'Ana');
  // Paul touche « Refuser », la question est ouverte ; Julie accepte ; Paul confirme le refus.
  await paul.page.locator('#pending-banner .join-card', { hasText: 'Ana' }).locator('.join-no').click();
  await paul.page.locator('.dialog-back:not(.closing) .dialog', { hasText: 'Refuser la demande' }).waitFor();
  await julie.page.locator('#pending-banner .join-card', { hasText: 'Ana' }).locator('.join-ok').click();
  await g.toast(julie, 'Ana a rejoint la famille');
  await g.attendreVue(ana, 'view-home');
  await g.repondre(paul, 'Refuser');
  await g.toast(paul, 'déjà été acceptée');
  await new Promise((r) => setTimeout(r, 1500));
  const fiche = (await g.liste(`families/${fid}/members`)).find((m) => m.email === 'ana@exemple.fr');
  assert.strictEqual(fiche && fiche.status, 'active', 'Ana toujours dans la famille');
  assert.strictEqual(await g.vue(ana), 'view-home');

  // L'inverse : Paul refuse, puis Julie (écran pas encore à jour) accepte.
  const zoe = await banc.telephone('Zoe');
  await demande(zoe, 'zoe@exemple.fr', 'Zoe');
  await julie.page.evaluate(() => { window.__carteZoe = [...document.querySelectorAll('#pending-banner .join-card')].find((c) => c.textContent.includes('Zoe')); });
  await paul.page.locator('#pending-banner .join-card', { hasText: 'Zoe' }).locator('.join-no').click();
  await g.repondre(paul, 'Refuser');
  await g.toast(paul, 'Demande refusée');
  await g.attendreBase(async () => !(await g.liste(`families/${fid}/members`)).some((m) => m.email === 'zoe@exemple.fr'), 'demande de Zoé retirée');
  // La carte a disparu chez Julie, ou elle a eu le temps de toucher « Accepter » : jamais « L'acceptation a échoué ».
  await julie.page.evaluate(() => { const c = window.__carteZoe; if (c) c.querySelector('.join-ok').click(); });
  await new Promise((r) => setTimeout(r, 1500));
  assert.strictEqual(await julie.page.locator('.dialog-back', { hasText: 'acceptation a échoué' }).count(), 0);
  assert.ok(!(await g.liste(`families/${fid}/members`)).some((m) => m.email === 'zoe@exemple.fr'), 'Zoé pas entrée');
});
