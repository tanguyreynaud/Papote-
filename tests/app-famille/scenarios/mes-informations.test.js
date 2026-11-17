// Mes informations (Tanguy 17/11) : chaque champ, à l'inscription (« Vos informations ») et dans Profil, est vraiment
// écrit sur ma fiche (relu dans la base) et toujours là après actualisation. Le numéro ajouté (par l'app ou écrit
// par l'admin) met à jour tout de suite le compteur « La tablette peut appeler… », la tuile « Appeler », la carte
// « Enregistrez le numéro » et Profil, sans actualiser.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

const espaces = (tel) => tel.replace(/(\d{2})(?=\d)/g, '$1 ');

async function modifier(t, carte) {
  await t.page.click(`#${carte} .setting-modify`);
  await t.page.locator(`#${carte} .setting-edit`).waitFor({ state: 'visible' });
}
const enregistrer = (t, carte) => t.page.click(`#${carte} .setting-edit button[type=submit]`);

async function profil(t) {
  await t.page.click('.nav-item[data-tab="profile"]');
  await g.attendreVue(t, 'view-profile');
}

test('Inscription : prénom, genre, photo, numéro et anniversaire écrits sur la fiche et dans l\'agenda', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const visage = await julie.page.evaluate(() => localStorage.getItem('papote.visage'));
  const uid = (await g.liste(`families/${fid}/members`)).find((m) => m.email === 'julie@exemple.fr').id;
  await g.attendreBase(async () => {
    const m = await g.lire(`families/${fid}/members/${uid}`);
    return m.name === 'Julie' && m.genre === 'femme' && m.face === visage && m.telephone === espaces(g.telDe('Julie'));
  }, 'prénom, genre, photo et numéro sur la fiche');
  const anniv = await g.attendreBase(() => g.lire(`families/${fid}/birthdays/membre-${uid}`), 'anniversaire dans l\'agenda');
  assert.deepStrictEqual([anniv.day, anniv.month, anniv.year], [12, 5, 1985]);
  await julie.page.reload();
  await g.attendreVue(julie, 'view-home');
  await profil(julie);
  assert.strictEqual(await julie.page.locator('#my-name-value').innerText(), 'Julie');
  assert.strictEqual(await julie.page.locator('#my-genre-value').innerText(), 'Une femme');
  assert.strictEqual(await julie.page.locator('#my-tel-value').innerText(), espaces(g.telDe('Julie')));
  assert.strictEqual(await julie.page.locator('#face-img').getAttribute('src'), visage);
  assert.match(await julie.page.locator('#account-email').innerText(), /julie@exemple\.fr/);
});

test('Profil : prénom, genre, numéro, photo (changée puis retirée) enregistrés, gardés après actualisation, vus par la famille', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const paul = await banc.telephone('Paul');
  const uid = await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });
  const fiche = () => g.lire(`families/${fid}/members/${uid}`);
  await profil(paul);

  await modifier(paul, 'my-name-card');
  await paul.page.fill('#my-name', 'Paulo');
  await enregistrer(paul, 'my-name-card');
  await g.toast(paul, 'Prénom enregistré');
  await modifier(paul, 'my-genre-card');
  await paul.page.check('input[name="my-genre"][value="femme"]');
  await enregistrer(paul, 'my-genre-card');
  await g.toast(paul, 'Enregistré');
  await modifier(paul, 'my-tel-card');
  await paul.page.fill('#my-tel', '0711223344');
  await enregistrer(paul, 'my-tel-card');
  await g.toast(paul, 'Numéro enregistré');
  await paul.page.setInputFiles('#in-face-gallery', await g.photo({ largeur: 600, hauteur: 600, texte: 'Paulo' }));
  await g.toast(paul, 'Photo enregistrée');
  const photo = await paul.page.locator('#face-img').getAttribute('src');
  await g.attendreBase(async () => {
    const m = await fiche();
    return m.name === 'Paulo' && m.genre === 'femme' && m.telephone === '07 11 22 33 44' && m.face === photo;
  }, 'prénom, genre, numéro et photo sur la fiche');

  await paul.page.reload();
  await g.attendreVue(paul, 'view-home');
  await profil(paul);
  assert.strictEqual(await paul.page.locator('#my-name-value').innerText(), 'Paulo');
  assert.strictEqual(await paul.page.locator('#my-genre-value').innerText(), 'Une femme');
  assert.strictEqual(await paul.page.locator('#my-tel-value').innerText(), '07 11 22 33 44');
  assert.strictEqual(await paul.page.locator('#face-img').getAttribute('src'), photo);
  // Gardés aussi sur ce téléphone : « Vos informations » reprendrait les nouveaux.
  const local = await paul.page.evaluate(() => ({ p: localStorage.getItem('papote.prenom'), g: localStorage.getItem('papote.genre'),
    t: localStorage.getItem('papote.telephone'), v: localStorage.getItem('papote.visage') }));
  assert.deepStrictEqual(local, { p: 'Paulo', g: 'femme', t: '07 11 22 33 44', v: photo });

  // Julie le voit sans actualiser.
  await g.ouvrirTuile(julie, 'settings');
  await julie.page.locator('#members li', { hasText: 'Paulo' }).locator('img').waitFor();

  // Photo retirée.
  await paul.page.click('#face-remove');
  // « Retirer » s'ouvre sous le doigt : un appui dans la demi-seconde serait pris pour un double appui (ui.js).
  await paul.page.waitForTimeout(600);
  await g.repondre(paul, 'Retirer');
  await paul.page.locator('#face-img').waitFor({ state: 'hidden' });
  await g.attendreBase(async () => !(await fiche()).face, 'photo retirée de la fiche');
  await paul.page.reload();
  await g.attendreVue(paul, 'view-home');
  await profil(paul);
  assert.ok(await paul.page.locator('#face-img').isHidden(), 'toujours retirée après actualisation');
});

test('Numéro ajouté dans l\'app puis par l\'admin : compteur, tuile « Appeler », « Enregistrez le numéro » et Profil suivent sans actualiser', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await banc.s.db.doc(`families/${fid}/members/${tab.tabletUid}`).update({ telephone: '06 98 76 54 32' });
  const paul = await banc.telephone('Paul');
  // Paul entre sans numéro (« Je n'ai pas de numéro, ou un numéro étranger »).
  const { code } = await g.lire(`families/${fid}`);
  await g.seConnecter(paul, 'paul@exemple.fr', `?code=${code}`);
  await g.attendreVue(paul, 'view-moi');
  await paul.page.fill('#moi-prenom', 'Paul');
  await paul.page.click('#form-moi .genre-btn[data-genre="homme"]');
  await paul.page.setInputFiles('#moi-in', await g.photo({ largeur: 600, hauteur: 600, texte: 'Paul' }));
  await paul.page.locator('#moi-photo').waitFor({ state: 'visible' });
  await paul.page.check('#moi-sans-tel', { force: true });
  await paul.page.selectOption('#moi-jour', '3');
  await paul.page.selectOption('#moi-mois', '4');
  await paul.page.selectOption('#moi-annee', '1990');
  await paul.page.click('#form-moi button[type=submit]');
  await g.attendreVue(paul, 'view-join');
  await paul.page.click('#form-join button[type=submit]');
  await g.attendreVue(paul, 'view-pending');
  await julie.page.locator('#pending-banner .join-card', { hasText: 'Paul' }).locator('.join-ok').click();
  await g.attendreVue(paul, 'view-home', 30_000);
  await g.fermerAccueil(paul);
  const uid = (await g.liste(`families/${fid}/members`)).find((m) => m.email === 'paul@exemple.fr').id;
  assert.ok(!(await g.lire(`families/${fid}/members/${uid}`)).telephone, 'Paul sans numéro');

  const compteur = (t) => t.page.locator('#appels-telephones').textContent();
  await g.ouvrirTuile(julie, 'settings');
  await julie.page.waitForFunction(() => /La tablette peut appeler 1 proche : celui dont le numéro de portable est enregistré\. 1 proche n'a pas encore de numéro\./
    .test(document.querySelector('#appels-telephones').textContent));
  await paul.page.waitForFunction(() => document.querySelector('#tile-phone').classList.contains('tile-off'));

  // 1) Dans l'app : Paul ajoute son numéro dans Profil.
  await profil(paul);
  assert.strictEqual(await paul.page.locator('#my-tel-value').innerText(), 'Non renseigné');
  await modifier(paul, 'my-tel-card');
  await paul.page.fill('#my-tel', '0711223344');
  await enregistrer(paul, 'my-tel-card');
  await g.toast(paul, 'Numéro enregistré');
  // Chez Julie, sans actualiser.
  await julie.page.waitForFunction(() => document.querySelector('#appels-telephones').textContent
    .startsWith('La tablette peut appeler 2 proches : ceux dont le numéro de portable est enregistré.'));
  assert.ok(!/pas encore de numéro/.test(await compteur(julie)));
  await g.retourAccueil(paul);
  await paul.page.waitForFunction(() => !document.querySelector('#tile-phone').classList.contains('tile-off'));
  assert.strictEqual(await paul.page.locator('#tile-phone').getAttribute('href'), 'tel:0698765432');
  await paul.page.waitForFunction(() => /Enregistrez le numéro de Mamie Emma/.test(document.querySelector('#contact-titre').textContent));

  // 2) Par l'admin : le numéro de Paul retiré puis remis, écrit directement sur sa fiche.
  await banc.s.db.doc(`families/${fid}/members/${uid}`).update({ telephone: '' });
  await julie.page.waitForFunction(() => /La tablette peut appeler 1 proche/.test(document.querySelector('#appels-telephones').textContent));
  await paul.page.waitForFunction(() => document.querySelector('#tile-phone').classList.contains('tile-off'));
  await banc.s.db.doc(`families/${fid}/members/${uid}`).update({ telephone: '07 55 44 33 22' });
  await julie.page.waitForFunction(() => /La tablette peut appeler 2 proches/.test(document.querySelector('#appels-telephones').textContent));
  await paul.page.waitForFunction(() => !document.querySelector('#tile-phone').classList.contains('tile-off'));
  await profil(paul);
  await paul.page.locator('#my-tel-value', { hasText: '07 55 44 33 22' }).waitFor();
  // Et la liste des membres chez Paul aussi (compteur).
  await g.retourAccueil(paul);
  await g.ouvrirTuile(paul, 'settings');
  await paul.page.waitForFunction(() => /La tablette peut appeler 2 proches/.test(document.querySelector('#appels-telephones').textContent));
});

test('Numéro collé avec des espaces ou en +33 (V4) : gardé en entier, dans « Vos informations » et dans Profil', async () => {
  const paul = await banc.telephone('Paul');
  await g.seConnecter(paul, 'paul@exemple.fr');
  await g.attendreVue(paul, 'view-moi');
  // Collé (ou rempli par le téléphone) : le texte arrive d'un coup, espaces compris.
  await paul.page.click('#moi-tel');
  await paul.page.keyboard.insertText('06 12 34 56 78');
  assert.strictEqual(await paul.page.inputValue('#moi-tel'), '0612345678');
  await paul.page.fill('#moi-tel', '');
  await paul.page.click('#moi-tel');
  await paul.page.keyboard.insertText('+33 6 12 34 56 78');
  assert.strictEqual(await paul.page.inputValue('#moi-tel'), '+33612345678');

  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await profil(julie);
  await modifier(julie, 'my-tel-card');
  await julie.page.fill('#my-tel', '');
  await julie.page.keyboard.insertText('+33 7 11 22 33 44');
  assert.strictEqual(await julie.page.inputValue('#my-tel'), '+33711223344');
  await enregistrer(julie, 'my-tel-card');
  await g.toast(julie, 'Numéro enregistré');
  await g.attendreBase(async () => (await g.liste(`families/${fid}/members`)).some((m) => m.email === 'julie@exemple.fr' && m.telephone === '07 11 22 33 44'),
    'numéro collé enregistré en entier');
});

test('Prénom vidé (V6) : refusé avec un mot ; prénom changé (V5) : l\'anniversaire de l\'agenda suit ; la tablette est prévenue (V3)', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const uid = (await g.liste(`families/${fid}/members`)).find((m) => m.email === 'julie@exemple.fr').id;
  await g.attendreBase(() => g.lire(`families/${fid}/birthdays/membre-${uid}`), 'anniversaire de Julie');
  await profil(julie);
  await modifier(julie, 'my-name-card');
  await julie.page.fill('#my-name', '   ');
  await enregistrer(julie, 'my-name-card');
  await julie.page.locator('#my-name-error', { hasText: 'Indiquez votre prénom' }).waitFor();
  assert.ok(await julie.page.locator('#my-name-card .setting-edit').isVisible(), 'la case reste ouverte');
  assert.strictEqual((await g.lire(`families/${fid}/members/${uid}`)).name, 'Julie', 'rien d\'écrit');

  const rev = (await g.lire(`families/${fid}`)).rev || 0;
  await julie.page.fill('#my-name', 'Juju');
  await enregistrer(julie, 'my-name-card');
  await g.toast(julie, 'Prénom enregistré');
  assert.ok(await julie.page.locator('#my-name-error').isHidden());
  await g.attendreBase(async () => (await g.lire(`families/${fid}/birthdays/membre-${uid}`)).name === 'Juju', 'anniversaire renommé');
  await g.attendreBase(async () => ((await g.lire(`families/${fid}`)).rev || 0) > rev, 'la tablette est prévenue (rev)');
  await g.retourAccueil(julie);
  await g.ouvrirTuile(julie, 'agenda');
  await julie.page.locator('#birthdays li', { hasText: 'Juju' }).waitFor();
  assert.ok(!/Julie/.test(await julie.page.locator('#birthdays').innerText()), 'plus l\'ancien prénom dans l\'agenda');

  // Photo et genre changés : la tablette est prévenue aussi.
  const rev2 = (await g.lire(`families/${fid}`)).rev || 0;
  await julie.page.click('#view-agenda .back');
  await profil(julie);
  await julie.page.setInputFiles('#in-face-gallery', await g.photo({ largeur: 600, hauteur: 600, texte: 'Juju' }));
  await g.toast(julie, 'Photo enregistrée');
  await g.attendreBase(async () => ((await g.lire(`families/${fid}`)).rev || 0) > rev2, 'photo : rev');
});

test('Photo retirée (V2) : ne revient pas après actualisation ni à la réouverture, la carte « Ajoutez votre photo » est due', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const uid = (await g.liste(`families/${fid}/members`)).find((m) => m.email === 'julie@exemple.fr').id;
  await g.attendreBase(async () => !!(await g.lire(`families/${fid}/members/${uid}`)).face, 'photo de l\'inscription');
  await profil(julie);
  await julie.page.click('#face-remove');
  await julie.page.waitForTimeout(600);
  await g.repondre(julie, 'Retirer');
  await g.attendreBase(async () => !(await g.lire(`families/${fid}/members/${uid}`)).face, 'photo retirée');
  for (let i = 0; i < 2; i++) {
    await julie.page.reload();
    await g.attendreVue(julie, 'view-home');
    await julie.page.waitForTimeout(1500);
    assert.ok(!(await g.lire(`families/${fid}/members/${uid}`)).face, 'la photo n\'est pas revenue sur la fiche');
  }
  await profil(julie);
  assert.ok(await julie.page.locator('#face-img').isHidden());
  assert.ok(await julie.page.locator('#face-empty').isVisible(), '« Ajoutez votre photo » proposé');
});
