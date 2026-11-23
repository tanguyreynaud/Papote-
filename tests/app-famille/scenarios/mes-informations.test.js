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
  await g.ouvrirProfil(t);
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
  // L'ancien numéro est sélectionné : ce qu'on tape le remplace (banc du 20/11).
  assert.ok(await paul.page.locator('#my-tel').evaluate((e) => e.value && e.selectionStart === 0 && e.selectionEnd === e.value.length), 'ancien numéro sélectionné');
  await paul.page.keyboard.type('0711223344');
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
  await g.ouvrirFamille(julie);
  await julie.page.locator('#members li', { hasText: 'Paulo' }).locator('img').waitFor();

  // Photo retirée.
  // « Retirer » à côté de « Changer ma photo » (Tanguy, 23/11), puis la confirmation.
  if (!(await paul.page.locator('#face-remove').isVisible())) await paul.page.click('#my-name-card .setting-modify');
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
  await g.ouvrirFamille(julie);
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
  await g.ouvrirFamille(paul);
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

// Prénom vide ou sans lettre (recontrôle du testeur, 18/11 : refusé sans aucun mot) : partout où l'on tape un prénom
// (« Vos informations » au premier lancement, en rejoignant par le code famille, par une invitation ; Profil ; prénom
// d'un anniversaire), un mot clair juste sous le champ, parti dès qu'une lettre est tapée ; rien n'est envoyé.
async function motSousLeChamp(t, champ, erreur, motif) {
  const mot = t.page.locator(erreur);
  await mot.waitFor({ state: 'visible', timeout: 5_000 });
  assert.match(await mot.innerText(), motif);
  const [c, e] = await Promise.all([t.page.locator(champ).boundingBox(), mot.boundingBox()]);
  assert.ok(e.y >= c.y + c.height - 1 && e.y - (c.y + c.height) < 40, `${erreur} juste sous ${champ} (champ ${Math.round(c.y + c.height)}, mot ${Math.round(e.y)})`);
}

async function prenomRefuseDansVosInformations(t, quoi) {
  await g.attendreVue(t, 'view-moi');
  await t.page.fill('#moi-tel', g.telDe(quoi));
  await t.page.click('#form-moi .genre-btn[data-genre="homme"]');
  await t.page.setInputFiles('#moi-in', await g.photo({ largeur: 400, hauteur: 400, texte: quoi }));
  await t.page.locator('#moi-photo').waitFor({ state: 'visible' });
  await t.page.selectOption('#moi-jour', '3');
  await t.page.selectOption('#moi-mois', '4');
  await t.page.selectOption('#moi-annee', '1980');
  for (const vide of ['', '   ', "- '"]) {
    await t.page.fill('#moi-prenom', vide);
    await t.page.click('#form-moi button[type=submit]');
    await motSousLeChamp(t, '#moi-prenom', '#moi-prenom-error', /Indiquez votre prénom/);
    assert.ok(await t.page.locator('#moi-error').isHidden(), `${quoi} : pas d'autre message en bas`);
    assert.strictEqual(await g.vue(t), 'view-moi', `${quoi} : « Vos informations » reste ouvert (« ${vide} »)`);
  }
  // Une lettre tapée : le mot s'en va tout de suite, avant même « Continuer ».
  await t.page.locator('#moi-prenom').pressSequentially('P');
  await t.page.locator('#moi-prenom-error').waitFor({ state: 'hidden', timeout: 2_000 });
}

test('Prénom vide ou sans lettre : un mot sous le champ partout où l\'on tape un prénom, parti dès qu\'il est corrigé, rien d\'envoyé', async () => {
  // Premier lancement, sans famille.
  const julie = await banc.telephone('Julie');
  await g.seConnecter(julie, 'julie@exemple.fr');
  await prenomRefuseDansVosInformations(julie, 'premier lancement');
  assert.deepStrictEqual(await g.liste('families'), [], 'rien d\'écrit');
  await julie.page.fill('#moi-prenom', 'Julie');
  await julie.page.click('#form-moi button[type=submit]');
  await julie.page.waitForFunction(() => document.getElementById('view-moi').hidden);
  const tab = await g.tabletteAllumee({ commande: { email: 'julie@exemple.fr' } });
  const fid = await g.installer(julie, tab, { nom: 'Mamie Emma' });
  await g.fermerAccueil(julie);
  const membres = (await g.liste(`families/${fid}/members`)).length;

  // Rejoindre par le code famille.
  const { code } = await g.lire(`families/${fid}`);
  const paul = await banc.telephone('Paul');
  await g.seConnecter(paul, 'paul@exemple.fr', `?code=${code}`);
  await prenomRefuseDansVosInformations(paul, 'code famille');

  // Invitation par e-mail.
  await julie.page.click('#btn-invite');
  await g.attendreVue(julie, 'view-invite');
  await julie.page.fill('#invite-email', 'lea@exemple.fr');
  await julie.page.click('#form-invite button[type=submit]');
  await g.repondre(julie, 'Inviter'); // « Inviter cette personne ? »
  await g.toast(julie, 'Invitation envoyée à');
  const lien = /\?code=([A-Z0-9-]+)&pour=([^\s"<>]+)/.exec(g.dernierMail('lea@exemple.fr').texte);
  const lea = await banc.telephone('Léa');
  await g.seConnecter(lea, 'lea@exemple.fr', `?code=${lien[1]}&pour=${lien[2]}`);
  await prenomRefuseDansVosInformations(lea, 'invitation');
  assert.strictEqual((await g.liste(`families/${fid}/members`)).length, membres, 'personne n\'est entré dans la famille');
  await julie.page.click('#view-invite .back');
  await g.attendreVue(julie, 'view-home');

  // Profil : le mot sous le champ s'en va dès qu'une lettre est tapée.
  await profil(julie);
  await modifier(julie, 'my-name-card');
  await julie.page.fill('#my-name', "- '");
  await enregistrer(julie, 'my-name-card');
  await motSousLeChamp(julie, '#my-name', '#my-name-error', /Indiquez votre prénom/);
  await julie.page.locator('#my-name').pressSequentially('J');
  await julie.page.locator('#my-name-error').waitFor({ state: 'hidden', timeout: 2_000 });
  const uid = (await g.liste(`families/${fid}/members`)).find((m) => m.email === 'julie@exemple.fr').id;
  assert.strictEqual((await g.lire(`families/${fid}/members/${uid}`)).name, 'Julie', 'rien d\'écrit');
  await julie.page.fill('#my-name', '');
  await enregistrer(julie, 'my-name-card');
  await motSousLeChamp(julie, '#my-name', '#my-name-error', /Indiquez votre prénom/);

  // Agenda : prénom d'un anniversaire.
  await julie.page.click('.nav-item[data-tab="home"]');
  await g.attendreVue(julie, 'view-home');
  await g.ouvrirTuile(julie, 'agenda');
  const avant = (await g.liste(`families/${fid}/birthdays`)).length;
  await julie.page.click('#add-reminder');
  await julie.page.locator('#sheet-reminder').waitFor({ state: 'visible' });
  await julie.page.click('#agenda-seg .seg[data-seg="birthday"]');
  for (const vide of ['', '  ', '-']) {
    await julie.page.fill('#bday-name', vide);
    await julie.page.click('#btn-reminder');
    await motSousLeChamp(julie, '#bday-name', '#bday-name-error', /Écrivez le prénom/);
  }
  await julie.page.locator('#bday-name').pressSequentially('L');
  await julie.page.locator('#bday-name-error').waitFor({ state: 'hidden', timeout: 2_000 });
  assert.strictEqual((await g.liste(`families/${fid}/birthdays`)).length, avant, 'aucun anniversaire écrit');
});

test('Photo retirée (V2) : ne revient pas après actualisation ni à la réouverture, la carte « Ajoutez votre photo » est due', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const uid = (await g.liste(`families/${fid}/members`)).find((m) => m.email === 'julie@exemple.fr').id;
  await g.attendreBase(async () => !!(await g.lire(`families/${fid}/members/${uid}`)).face, 'photo de l\'inscription');
  await profil(julie);
  if (!(await julie.page.locator('#face-remove').isVisible())) await julie.page.click('#my-name-card .setting-modify');
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
