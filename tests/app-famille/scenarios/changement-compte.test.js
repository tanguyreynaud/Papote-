// Changer de compte sur le même téléphone (bug Tanguy 17/11 : « je me déconnecte pour me connecter à un autre compte :
// page blanche, puis en actualisant un message d'erreur, puis en actualisant encore c'était bon »).
// Julie (famille de Mamie Emma) se déconnecte, Marc se connecte dans le même onglet par le lien de son e-mail :
// l'accueil de Marc arrive en quelques secondes, sans écran vide, sans message d'erreur, sans erreur dans la console,
// et rien de Julie ni de Mamie Emma ne reste à l'écran. Variantes : page rechargée juste après la déconnexion ;
// lien ouvert dans un nouvel onglet (l'ancien reste ouvert) ; Marc sans famille.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

// Marc a déjà sa famille (Papi Jean), installée sur son propre téléphone.
async function marcAvecSaFamille() {
  const marc = await banc.telephone('Marc');
  await g.familleInstallee(marc, { email: 'marc@exemple.fr', prenom: 'Marc', nom: 'Papi Jean', genre: 'homme' });
  await marc.context.close();
}

async function julieSeDeconnecte(julie) {
  await julie.page.click('.nav-item[data-tab="profile"]');
  await g.attendreVue(julie, 'view-profile');
  await julie.page.click('#view-profile [data-action="logout"]');
  await g.repondre(julie, 'Se déconnecter');
  await g.attendreVue(julie, 'view-login');
}

// Lien de connexion de Marc (comme g.seConnecter), sans l'ouvrir : renvoie son adresse.
async function lienDeConnexion(t, email) {
  const avant = (await g.codesEmail(email)).length;
  await t.page.fill('#login-email', email);
  await t.page.click('#btn-email');
  await t.page.locator('#email-sent').waitFor({ state: 'visible' });
  let codes = [];
  for (let i = 0; i < 50 && codes.length <= avant; i++) {
    codes = await g.codesEmail(email);
    if (codes.length <= avant) await new Promise((r) => setTimeout(r, 100));
  }
  const { oobCode } = codes[codes.length - 1];
  return `${banc.origine}/?lien=1&mode=signIn&oobCode=${oobCode}&apiKey=cle-de-test&lang=fr`;
}

/**
 * Ouvre le lien dans `page` (null : la page y est déjà) et suit l'écran jusqu'à `attendu` : jamais d'écran vide plus d'une seconde, jamais de
 * message d'erreur de connexion, `attendu` en moins de `delai` ms. Renvoie la durée.
 */
async function ouvrirLeLienEtSuivre(t, page, lien, attendu, delai = 15_000) {
  if (lien) await page.goto(lien);
  const debut = Date.now();
  let videDepuis = null;
  for (;;) {
    const etat = await page.evaluate(() => ({
      vues: [...document.querySelectorAll('main > section, #loading')].filter((e) => !e.hidden).map((e) => e.id),
      erreur: [...document.querySelectorAll('#login-error, #link-error, .hors-ligne:not([hidden]), #hors-ligne:not([hidden])')]
        .filter((e) => !e.hidden && e.offsetParent !== null).map((e) => e.innerText.trim()).filter(Boolean).join(' / '),
    })).catch(() => ({ vues: ['navigation'], erreur: '' }));
    assert.strictEqual(etat.erreur, '', `[${t.nom}] message d'erreur affiché (écran ${etat.vues.join(',')})`);
    if (etat.vues.length === 1 && etat.vues[0] === attendu) break;
    if (!etat.vues.length) {
      videDepuis ??= Date.now();
      assert.ok(Date.now() - videDepuis < 1000, `[${t.nom}] page vide depuis plus d'une seconde\n${t.console.slice(-15).join('\n')}`);
    } else videDepuis = null;
    assert.ok(Date.now() - debut < delai,
      `[${t.nom}] ${attendu} attendu en moins de ${delai} ms, affiché : ${etat.vues.join(',') || '(rien)'}\n${t.console.slice(-15).join('\n')}`);
    await page.waitForTimeout(100);
  }
  return Date.now() - debut;
}

// Rien de la famille de Julie à l'écran (texte visible seulement).
async function rienDeJulie(page) {
  const texte = await page.evaluate(() => document.body.innerText);
  assert.ok(!/Emma|julie@exemple/i.test(texte), `il reste de Julie à l'écran :\n${texte.slice(0, 600)}`);
}

async function accueilDeMarc(t, page) {
  await page.locator('#family-title, #family-switch').filter({ visible: true, hasText: 'Pour Papi Jean' }).first().waitFor({ timeout: 10_000 });
  const fid = await page.evaluate(() => localStorage.getItem('papote.fid'));
  const familles = await g.liste('families');
  assert.strictEqual(familles.find((f) => f.id === fid)?.name, 'Papi Jean', 'la famille de Marc est ouverte');
  await page.click('.nav-item[data-tab="profile"]');
  await g.attendreVue({ ...t, page }, 'view-profile');
  assert.match(await page.locator('#account-email').innerText(), /marc@exemple\.fr/);
  await rienDeJulie(page);
}

test('Changer de compte dans le même onglet : l\'accueil de Marc, sans page vide ni erreur', async () => {
  await marcAvecSaFamille();
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await julieSeDeconnecte(julie);
  const lien = await lienDeConnexion(julie, 'marc@exemple.fr');
  const duree = await ouvrirLeLienEtSuivre(julie, julie.page, lien, 'view-home');
  assert.ok(duree < 15_000, `accueil de Marc en ${duree} ms`);
  await g.fermerAccueil(julie);
  await accueilDeMarc(julie, julie.page);
  // Rouvrir l'app : toujours Marc.
  await julie.page.reload();
  await g.attendreVue(julie, 'view-home');
  await julie.page.locator('#family-title, #family-switch').filter({ visible: true, hasText: 'Pour Papi Jean' }).first().waitFor();
  await rienDeJulie(julie.page);
});

test('Changer de compte : page rechargée juste après la déconnexion', async () => {
  await marcAvecSaFamille();
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await julieSeDeconnecte(julie);
  await julie.page.reload();
  await g.attendreVue(julie, 'view-login');
  const lien = await lienDeConnexion(julie, 'marc@exemple.fr');
  await ouvrirLeLienEtSuivre(julie, julie.page, lien, 'view-home');
  await g.fermerAccueil(julie);
  await accueilDeMarc(julie, julie.page);
});

test('Changer de compte : le lien de l\'e-mail s\'ouvre dans un nouvel onglet, l\'ancien reste ouvert', async () => {
  await marcAvecSaFamille();
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await julieSeDeconnecte(julie);
  const lien = await lienDeConnexion(julie, 'marc@exemple.fr');
  const onglet = await julie.context.newPage();
  onglet.on('pageerror', (e) => julie.erreurs.push(`[Julie, onglet 2] erreur non rattrapée : ${e.stack || e.message}`));
  onglet.on('console', (m) => {
    julie.console.push(`(onglet 2) ${m.type()} : ${m.text()}`);
    // Mêmes tolérances que le banc (requêtes coupées par le banc, canaux Firestore abandonnés sous WebKit).
    if (m.type() === 'error' && !/Failed to load resource|^Beacon API cannot load|^Fetch API cannot load|interactive-widget/i.test(m.text())) {
      julie.erreurs.push(`[Julie, onglet 2] console.error : ${m.text()}`);
    }
  });
  await ouvrirLeLienEtSuivre(julie, onglet, lien, 'view-home');
  await g.fermerAccueil({ ...julie, page: onglet });
  await accueilDeMarc(julie, onglet);
  // Puis l'ancien onglet, retrouvé et rechargé : Marc aussi.
  await julie.page.bringToFront();
  await julie.page.reload();
  await g.attendreVue(julie, 'view-home');
  await rienDeJulie(julie.page);
});

// « Vos informations » vides pour un nouveau compte : rien du compte d'avant (prénom, photo, numéro, anniversaire, genre).
async function moiVide(t, page = t.page) {
  const v = await page.evaluate(() => ({
    prenom: document.querySelector('#moi-prenom').value,
    tel: document.querySelector('#moi-tel').value,
    photo: !document.querySelector('#moi-photo').hidden,
    jour: document.querySelector('#moi-jour').value,
    annee: document.querySelector('#moi-annee').value,
    genre: !!document.querySelector('#form-moi .genre-btn[aria-checked="true"]'),
  }));
  assert.ok(!/Julie/i.test(v.prenom), `prénom de Julie repris : ${v.prenom}`);
  assert.strictEqual(v.tel, '', 'numéro de Julie repris');
  assert.strictEqual(v.photo, false, 'photo de Julie reprise');
  assert.strictEqual(v.jour + v.annee, '', 'anniversaire de Julie repris');
  assert.strictEqual(v.genre, false, 'genre de Julie repris');
}

test('Changer de compte vers un compte neuf : « Vos informations » vides, rien de Julie', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await julieSeDeconnecte(julie);
  const lien = await lienDeConnexion(julie, 'marc.neuf@exemple.fr');
  await ouvrirLeLienEtSuivre(julie, julie.page, lien, 'view-moi');
  await moiVide(julie);
  await rienDeJulie(julie.page);
  await g.remplirMoi(julie, { prenom: 'Marc', genre: 'homme' });
  await g.attendreVue(julie, 'view-join');
  assert.match(await julie.page.locator('#join-account').innerText(), /marc\.neuf@exemple\.fr/);
  await rienDeJulie(julie.page);
});

// ---------- Connexion Google (émulateur : fenêtre de choix du compte, ou redirection) ----------

/** « Continuer avec Google » avec un compte Google (simulé par le banc, voir banc.js) ; redirection : la fenêtre est
 *  refusée par le téléphone, l'app part chez Google et revient (page rechargée). */
async function google(t, { email, nom, redirection = false }) {
  await t.page.evaluate((c) => { globalThis.__papoteGoogle = c; }, { email, nom, bloque: redirection });
  await t.page.click('#btn-google');
  if (redirection) await t.page.waitForEvent('load');
}

test('Google après la déconnexion (fenêtre) : « Vos informations » du nouveau compte, sans page vide ni erreur', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await julieSeDeconnecte(julie);
  await google(julie, { email: 'marc.google@exemple.fr', nom: 'Marc Martin' });
  await ouvrirLeLienEtSuivre(julie, julie.page, null, 'view-moi');
  await moiVide(julie);
  assert.strictEqual(await julie.page.inputValue('#moi-prenom'), 'Marc', 'prénom repris du compte Google');
  await rienDeJulie(julie.page);
});

test('Google après la déconnexion (redirection) : « Vos informations » du nouveau compte, rien de Julie', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await julieSeDeconnecte(julie);
  await google(julie, { email: 'marc.google@exemple.fr', nom: 'Marc Martin', redirection: true });
  await ouvrirLeLienEtSuivre(julie, julie.page, null, 'view-moi');
  await moiVide(julie);
  await rienDeJulie(julie.page);
  // Actualiser : toujours le même compte, toujours « Vos informations », aucune erreur.
  await julie.page.reload();
  await g.attendreVue(julie, 'view-moi');
  await moiVide(julie);
});

// ---------- Le cas de Tanguy (17/11) ----------

const espaces = (tel) => tel.replace(/(\d{2})(?=\d)/g, '$1 ');
const fiche = async (fid, email) => (await g.liste(`families/${fid}/members`)).find((m) => m.email === email);
const visageAffiche = (page) => page.evaluate(() => localStorage.getItem('papote.visage'));

test('Tanguy 17/11 : 2e compte Google invité dans la famille, même numéro, puis photo et numéro changés : tout est enregistré', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const ficheJulie = await fiche(fid, 'julie@exemple.fr');
  // Julie invite son 2e compte.
  await banc.s.db.doc(`families/${fid}/invitations/marc.google@exemple.fr`).set({
    email: 'marc.google@exemple.fr', fid, familyName: 'Mamie Emma', invitedBy: 'Julie', createdAt: new Date(),
  });
  await julieSeDeconnecte(julie);
  await google(julie, { email: 'marc.google@exemple.fr', nom: 'Marc Martin' });
  await g.attendreVue(julie, 'view-moi', 20_000);
  await moiVide(julie);
  // Il donne le même numéro que Julie.
  await g.remplirMoi(julie, { prenom: 'Marc', genre: 'homme', tel: g.telDe('Julie') });
  await g.attendreVue(julie, 'view-invited');
  await julie.page.click('#invitations button[type=submit]');
  await g.attendreVue(julie, 'view-moi', 30_000);
  const erreur = await julie.page.locator('#moi-error').innerText();
  assert.match(erreur, /Ce numéro est déjà celui de Julie dans la famille\. Indiquez votre propre numéro de portable, ou cochez « Je n'ai pas de numéro, ou un numéro étranger »\./);
  assert.strictEqual(await julie.page.locator('#moi-photo').isVisible(), true, 'sa photo est toujours là');
  const marc = await fiche(fid, 'marc.google@exemple.fr');
  assert.ok(marc && !marc.telephone, 'rien d\'écrit');
  // Il change sa photo ET son numéro.
  await julie.page.setInputFiles('#moi-in', await g.photo({ largeur: 700, hauteur: 700, texte: 'Marc 2' }));
  await julie.page.waitForFunction(() => document.querySelector('#moi-error').hidden);
  const nouvellePhoto = await visageAffiche(julie.page);
  await julie.page.fill('#moi-tel', g.telDe('Marc'));
  await julie.page.click('#form-moi button[type=submit]');
  await g.attendreVue(julie, 'view-home', 30_000);
  await g.fermerAccueil(julie);
  await g.attendreBase(async () => {
    const m = await fiche(fid, 'marc.google@exemple.fr');
    return m.telephone === espaces(g.telDe('Marc')) && m.face === nouvellePhoto && m.name === 'Marc' && m.genre === 'homme';
  }, 'numéro, photo, prénom et genre de Marc enregistrés');
  const julieApres = await fiche(fid, 'julie@exemple.fr');
  assert.strictEqual(julieApres.telephone, ficheJulie.telephone, 'Julie garde son numéro');
  assert.strictEqual(julieApres.face, ficheJulie.face, 'Julie garde sa photo');
  // Après actualisation : Profil de Marc.
  await julie.page.reload();
  await g.attendreVue(julie, 'view-home');
  await julie.page.click('.nav-item[data-tab="profile"]');
  await g.attendreVue(julie, 'view-profile');
  assert.strictEqual(await julie.page.locator('#my-name-value').innerText(), 'Marc');
  assert.strictEqual(await julie.page.locator('#my-tel-value').innerText(), espaces(g.telDe('Marc')));
  assert.strictEqual(await julie.page.locator('#face-img').getAttribute('src'), nouvellePhoto);
  assert.match(await julie.page.locator('#account-email').innerText(), /marc\.google@exemple\.fr/);
});

test('Déjà dans la famille avec une photo : la photo changée dans « Vos informations » remplace l\'ancienne', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  // Marc est déjà dans la famille, avec une ancienne photo et sans numéro (fiche d'avant).
  const marc = await banc.admin.auth().createUser({ email: 'marc@exemple.fr', emailVerified: true });
  const anciennePhoto = await julie.page.evaluate(() => localStorage.getItem('papote.visage'));
  await banc.s.db.doc(`families/${fid}/members/${marc.uid}`).set({
    name: 'Marco', role: 'famille', code: '', uid: marc.uid, email: 'marc@exemple.fr', status: 'active',
    face: anciennePhoto, genre: 'homme', joinedAt: new Date(),
  });
  await julieSeDeconnecte(julie);
  const lien = await lienDeConnexion(julie, 'marc@exemple.fr');
  await ouvrirLeLienEtSuivre(julie, julie.page, lien, 'view-moi');
  // Repris de sa fiche : prénom, genre, photo ; à compléter : numéro et anniversaire.
  assert.strictEqual(await julie.page.inputValue('#moi-prenom'), 'Marco');
  assert.strictEqual(await julie.page.inputValue('#moi-tel'), '');
  await g.remplirMoi(julie, { prenom: 'Marc', genre: 'homme', tel: g.telDe('Julie') });
  await g.attendreVue(julie, 'view-moi', 30_000);
  await julie.page.locator('#moi-error', { hasText: 'Ce numéro est déjà celui de Julie' }).waitFor();
  await julie.page.setInputFiles('#moi-in', await g.photo({ largeur: 700, hauteur: 700, texte: 'Marc 3' }));
  await julie.page.waitForFunction(() => document.querySelector('#moi-error').hidden);
  const nouvellePhoto = await visageAffiche(julie.page);
  assert.notStrictEqual(nouvellePhoto, anciennePhoto);
  await julie.page.fill('#moi-tel', g.telDe('Marc'));
  await julie.page.click('#form-moi button[type=submit]');
  await g.attendreVue(julie, 'view-home', 30_000);
  await g.fermerAccueil(julie);
  await g.attendreBase(async () => {
    const m = await g.lire(`families/${fid}/members/${marc.uid}`);
    return m.face === nouvellePhoto && m.telephone === espaces(g.telDe('Marc')) && m.name === 'Marc';
  }, 'nouvelle photo, numéro et prénom sur la fiche de Marc');
});

test('Retour du premier compte après un autre : accueil direct, ses informations à lui, rien redemandé', async () => {
  await marcAvecSaFamille();
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await julieSeDeconnecte(julie);
  await g.seConnecter(julie, 'marc@exemple.fr');
  await g.attendreVue(julie, 'view-home', 30_000);
  await g.fermerAccueil(julie);
  await julie.page.click('.nav-item[data-tab="profile"]');
  await g.attendreVue(julie, 'view-profile');
  await julie.page.click('#view-profile [data-action="logout"]');
  await g.repondre(julie, 'Se déconnecter');
  await g.attendreVue(julie, 'view-login');
  const lien = await lienDeConnexion(julie, 'julie@exemple.fr');
  await ouvrirLeLienEtSuivre(julie, julie.page, lien, 'view-home');
  await g.fermerAccueil(julie);
  await julie.page.locator('#family-title, #family-switch').filter({ visible: true, hasText: 'Pour Mamie Emma' }).first().waitFor();
  const texte = await julie.page.evaluate(() => document.body.innerText);
  assert.ok(!/Papi Jean|marc@exemple/.test(texte), 'rien de Marc');
  const m = await fiche(fid, 'julie@exemple.fr');
  assert.strictEqual(m.name, 'Julie');
  assert.strictEqual(m.telephone, espaces(g.telDe('Julie')));
});
