// Un numéro de portable par proche dans une même famille (Tanguy, 13/11) : un numéro déjà celui d'un autre proche
// (pas la tablette) est refusé à l'entrée dans la famille et dans Profil, avec « Ce numéro est déjà celui de <Prénom>
// dans la famille. » ; garder son propre numéro n'est pas refusé ; un double appui sur Enregistrer n'écrit qu'une fois.
// Un doublon resté (fiche d'avant, deux écritures en même temps) est montré à l'admin : « À faire » et page de la famille.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

const { s, acteurs: a } = banc;
const GSTATIC = 'https://www.gstatic.com/firebasejs/12.19.0/';

banc.brancher();

const espaces = (t) => t.replace(/(\d{2})(?=\d)/g, '$1 ');

async function modifier(t, carte) {
  await t.page.click(`#${carte} .setting-modify`);
  await t.page.locator(`#${carte} .setting-edit`).waitFor({ state: 'visible' });
}

test('Entrée dans la famille avec le numéro de Julie : refusé avec son prénom, rien d\'écrit ; un autre numéro passe', async () => {
  const julie = await banc.telephone('Julie');
  const paul = await banc.telephone('Paul');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const telJulie = g.telDe('Julie');
  await g.attendreBase(async () => (await g.liste(`families/${fid}/members`)).some((m) => m.name === 'Julie' && m.telephone === espaces(telJulie)),
    'numéro de Julie sur sa fiche');

  // Paul donne le numéro de Julie, écrit à l'international, puis entre avec le code famille.
  const { code } = await g.lire(`families/${fid}`);
  await g.inscrire(paul, 'paul@exemple.fr', 'Paul', { genre: 'homme', suite: `?code=${code}`, tel: `+33${telJulie.slice(1)}` });
  await g.attendreVue(paul, 'view-join');
  await paul.page.click('#form-join button[type=submit]');
  await g.attendreVue(paul, 'view-pending');
  await julie.page.locator('#pending-banner .join-card', { hasText: 'Paul' }).locator('.join-ok').click();

  // Accepté : « Vos informations » revient, le numéro refusé et le message affichés.
  await g.attendreVue(paul, 'view-moi', 30_000);
  await paul.page.locator('#moi-error', { hasText: 'Ce numéro est déjà celui de Julie dans la famille.' }).waitFor();
  assert.strictEqual((await paul.page.inputValue('#moi-tel')).replace(/\D/g, '').slice(-9), telJulie.slice(1));
  const fichePaul = async () => (await g.liste(`families/${fid}/members`)).find((m) => m.email === 'paul@exemple.fr');
  assert.ok(!(await fichePaul()).telephone, 'aucun numéro écrit sur la fiche de Paul');

  // Son propre numéro : la famille s'ouvre et le numéro est écrit.
  await paul.page.fill('#moi-tel', g.telDe('Paul'));
  await paul.page.click('#form-moi button[type=submit]');
  await g.attendreVue(paul, 'view-home', 30_000);
  await g.fermerAccueil(paul);
  await g.attendreBase(async () => (await fichePaul()).telephone === espaces(g.telDe('Paul')), 'numéro de Paul écrit');
  assert.strictEqual((await g.liste(`families/${fid}/members`)).find((m) => m.name === 'Julie').telephone, espaces(telJulie), 'Julie garde le sien');
});

test('Profil : le numéro de Julie refusé, le sien gardé sans refus, double appui sur Enregistrer = une seule écriture', async () => {
  const julie = await banc.telephone('Julie');
  const paul = await banc.telephone('Paul');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const uid = await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });
  const telJulie = g.telDe('Julie');
  const telPaul = g.telDe('Paul');
  await g.attendreBase(async () => (await g.lire(`families/${fid}/members/${uid}`)).telephone === espaces(telPaul), 'numéro de Paul écrit');
  // La tablette porte un autre numéro que personne n'a : elle ne compte pas parmi les proches.
  await s.db.doc(`families/${fid}/members/${tab.tabletUid}`).update({ telephone: '07 11 22 33 44' });

  await paul.page.click('.nav-item[data-tab="profile"]');
  await g.attendreVue(paul, 'view-profile');

  // Numéro de Julie (avec des espaces) : refusé, la carte reste ouverte, rien n'est écrit.
  await modifier(paul, 'my-tel-card');
  await paul.page.fill('#my-tel', `+33${telJulie.slice(1)}`);
  await paul.page.click('#my-tel-card .setting-edit button[type=submit]');
  await paul.page.locator('#my-tel-error', { hasText: 'Ce numéro est déjà celui de Julie dans la famille.' }).waitFor();
  assert.ok(await paul.page.locator('#my-tel-card .setting-edit').isVisible(), 'la carte reste ouverte');
  await paul.page.waitForTimeout(500);
  assert.strictEqual((await g.lire(`families/${fid}/members/${uid}`)).telephone, espaces(telPaul));

  // Son propre numéro : accepté, la carte se ferme.
  await paul.page.fill('#my-tel', telPaul);
  await paul.page.click('#my-tel-card .setting-edit button[type=submit]');
  await paul.page.locator('#my-tel-card .setting-edit').waitFor({ state: 'hidden' });
  assert.strictEqual(await paul.page.locator('#my-tel-error').isVisible(), false);

  // Le numéro de la tablette ne compte pas (seuls les proches), double appui sur Enregistrer : une seule écriture
  // (rev de la famille +1).
  await s.calme();
  const revAvant = (await g.lire(`families/${fid}`)).rev || 0;
  await modifier(paul, 'my-tel-card');
  await paul.page.fill('#my-tel', '0711223344');
  await g.doubleAppui(paul, '#my-tel-card .setting-edit button[type=submit]');
  await g.toast(paul, 'Numéro enregistré');
  await g.attendreBase(async () => (await g.lire(`families/${fid}/members/${uid}`)).telephone === '07 11 22 33 44', 'nouveau numéro écrit');
  await paul.page.waitForTimeout(1500);
  await s.calme();
  assert.strictEqual(((await g.lire(`families/${fid}`)).rev || 0) - revAvant, 1, 'une seule écriture');
  await paul.page.locator('#my-tel-value', { hasText: '07 11 22 33 44' }).waitFor();
});

async function ouvrirAdmin(nom, hash) {
  await banc.admin.auth().createUser({ uid: a.TANGUY.uid, email: a.TANGUY.email, emailVerified: true, displayName: 'Tanguy' }).catch(() => {});
  const jeton = await banc.admin.auth().createCustomToken(a.TANGUY.uid, { admin: true });
  const t = await banc.telephone(nom, { largeur: 1280, hauteur: 900 });
  await t.context.route('**/version.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await t.page.goto(`${banc.origine}/admin.html${hash}`);
  await t.page.evaluate(async ({ jeton: j, G }) => {
    const { getApp } = await import(`${G}firebase-app.js`);
    const { getAuth, signInWithCustomToken } = await import(`${G}firebase-auth.js`);
    await signInWithCustomToken(getAuth(getApp('admin')), j);
  }, { jeton, G: GSTATIC });
  await t.page.locator('#dashboard').waitFor({ state: 'visible' });
  return t;
}

test('Admin : « Numéro en double dans la famille Mamie Rose : 06 •• •• •• 78 (Julie, Paul) » dans « À faire » et sur la page de la famille', async () => {
  const FID = 'famille-tel-double';
  await s.db.doc(`families/${FID}`).set({ name: 'Mamie Rose', code: 'FAMT2345', createdBy: 'julie', abonnement: { statut: 'offert' } });
  const m = (uid, d) => s.db.doc(`families/${FID}/members/${uid}`).set({ joinedAt: s.Timestamp.now(), status: 'active', ...d });
  await m('julie', { name: 'Julie', role: 'famille', telephone: '06 12 34 56 78' });
  await m('paul', { name: 'Paul', role: 'famille', telephone: '+33612345678' });
  await m('lea', { name: 'Léa', role: 'famille', telephone: '07 00 00 00 01' });
  await m('tablette', { name: 'Tablette', role: 'tablette', telephone: '07 00 00 00 01' });
  // Une autre famille où chacun a le sien : rien.
  await s.db.doc('families/autre').set({ name: 'Papi Jean', code: 'FAMU2345', createdBy: 'marc', abonnement: { statut: 'offert' } });
  await s.db.doc('families/autre/members/marc').set({ name: 'Marc', role: 'famille', telephone: '06 12 34 56 78' });

  const t = await ouvrirAdmin('ordinateur', '#accueil');
  const ligne = t.page.locator('#a-faire .ligne-tache', { hasText: 'Numéro en double dans la famille Mamie Rose' });
  await ligne.waitFor();
  assert.match(await ligne.innerText(), /06 •• •• •• 78 \(Julie, Paul\)/);
  assert.doesNotMatch(await t.page.locator('#a-faire').innerText(), /Papi Jean|Léa/);
  assert.doesNotMatch(await t.page.locator('#a-faire').innerText(), /12 34 56/, 'numéro jamais en entier');
  assert.strictEqual(await ligne.locator('a.urgent').count(), 0, 'pas présenté comme urgent');

  // La ligne ouvre la page de la famille, qui le dit en haut.
  await ligne.locator('a').first().click();
  await t.page.waitForURL(/#clients\/familles\/famille-tel-double$/);
  await t.page.locator('#famille-liens .tel-double', { hasText: 'Numéro en double : 06 •• •• •• 78 (Julie, Paul)' }).waitFor();

  // Corrigé par Paul : plus rien à la prochaine lecture.
  await s.db.doc(`families/${FID}/members/paul`).update({ telephone: '06 98 76 54 31' });
  await t.page.reload();
  await t.page.evaluate(async ({ jeton: j, G }) => {
    const { getApp } = await import(`${G}firebase-app.js`);
    const { getAuth, signInWithCustomToken } = await import(`${G}firebase-auth.js`);
    if (!getAuth(getApp('admin')).currentUser) await signInWithCustomToken(getAuth(getApp('admin')), j);
  }, { jeton: await banc.admin.auth().createCustomToken(a.TANGUY.uid, { admin: true }), G: GSTATIC });
  await t.page.locator('#famille-liens h2', { hasText: 'Commande, client et tablette' }).waitFor({ state: 'attached' });
  await t.page.waitForTimeout(500);
  assert.strictEqual(await t.page.locator('#famille-liens .tel-double').count(), 0);
});
