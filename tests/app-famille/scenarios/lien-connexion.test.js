// Lien de connexion envoyé par Papote, en français (Tanguy 20/11 : l'e-mail anglais de Firebase était « moche et pas
// travaillé »). L'appli appelle la fonction lienConnexion (functions/connexion.js) au lieu de sendSignInLinkToEmail :
// un seul e-mail même après un double appui, le lien de l'e-mail connecte ; trop de demandes : message clair ; serveur
// injoignable : message clair, jamais d'e-mail anglais en secours, et « Recevoir le lien » marche au nouvel essai.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();
const { s } = banc;

const mailsA = (email) => s.boite.filter((m) => m.a === email);
const appelsLien = () => banc.appels.filter((a) => a.nom === 'lienConnexion');

async function attendre(f, delai = 10_000) {
  const fin = Date.now() + delai;
  while (!(await f())) {
    if (Date.now() > fin) throw new Error('attente trop longue');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('double appui sur « Recevoir le lien » : un seul e-mail, en français, et son lien connecte', async () => {
  const julie = await banc.telephone('Julie');
  await g.ouvrir(julie);
  await g.attendreVue(julie, 'view-login');
  await julie.page.fill('#login-email', 'julie@exemple.fr');
  await julie.page.locator('#btn-email').dblclick();
  await julie.page.locator('#email-sent').waitFor({ state: 'visible' });
  assert.match(await julie.page.locator('#email-sent').innerText(), /Lien envoyé à julie@exemple\.fr/);
  await s.calme();
  assert.strictEqual(appelsLien().length, 1, 'une seule demande');
  assert.deepStrictEqual(appelsLien()[0].data, { email: 'julie@exemple.fr', retour: `${banc.origine}/?lien=1` });
  const mails = mailsA('julie@exemple.fr');
  assert.strictEqual(mails.length, 1, 'un seul e-mail');
  assert.strictEqual(mails[0].sujet, 'Votre lien pour ouvrir Papote');
  assert.match(mails[0].texte, /Ce lien marche une seule fois, pendant 1 heure, sur ce téléphone\./);
  assert.doesNotMatch(mails[0].texte, /Hello|We received|Your Papote team/);
  const codes = await g.codesEmail('julie@exemple.fr');
  assert.strictEqual(codes.length, 1, 'un seul lien fabriqué');
  assert.ok(mails[0].texte.includes(codes[0].oobCode), 'l\'e-mail porte le lien fabriqué');
  // Le lien de l'e-mail ramène sur l'appli, qui finit la connexion (adresse retenue sur ce téléphone).
  await julie.page.goto(`${banc.origine}/?lien=1&mode=signIn&oobCode=${codes[0].oobCode}&apiKey=cle-de-test&lang=fr`);
  await g.attendreVue(julie, 'view-moi');
});

test('4e demande dans l\'heure pour la même adresse : message clair, rien ne part', async () => {
  const paul = await banc.telephone('Paul');
  await g.ouvrir(paul);
  await g.attendreVue(paul, 'view-login');
  for (let i = 1; i <= 3; i++) {
    await paul.page.fill('#login-email', 'paul@exemple.fr');
    await paul.page.click('#btn-email');
    await attendre(async () => mailsA('paul@exemple.fr').length === i);
    await attendre(async () => !(await paul.page.locator('#btn-email').isDisabled()));
  }
  await paul.page.click('#btn-email');
  await paul.page.locator('#login-error').waitFor({ state: 'visible' });
  assert.match(await paul.page.locator('#login-error').innerText(), /Trop de demandes de lien en peu de temps\. Attendez une heure, puis réessayez\./);
  await s.calme();
  assert.strictEqual(mailsA('paul@exemple.fr').length, 3);
  banc.tolerer(paul, /FirebaseError|resource-exhausted|Trop de demandes/);
});

test('serveur injoignable : message clair, pas d\'e-mail anglais en secours, le nouvel essai marche', async () => {
  const lea = await banc.telephone('Léa');
  await g.ouvrir(lea);
  await g.attendreVue(lea, 'view-login');
  banc.pannes.set('lienConnexion', { status: 'UNAVAILABLE' });
  await lea.page.fill('#login-email', 'lea@exemple.fr');
  await lea.page.click('#btn-email');
  await lea.page.locator('#login-error').waitFor({ state: 'visible' });
  assert.match(await lea.page.locator('#login-error').innerText(), /L'e-mail n'est pas parti\. Vérifiez la connexion internet, puis touchez à nouveau « Recevoir le lien »\./);
  assert.ok(await lea.page.locator('#email-sent').isHidden());
  assert.ok(await lea.page.locator('#btn-email').isEnabled(), 'le bouton se réactive pour réessayer');
  assert.strictEqual((await g.codesEmail('lea@exemple.fr')).length, 0, 'aucun lien Firebase (e-mail anglais) en secours');
  assert.strictEqual(mailsA('lea@exemple.fr').length, 0);
  banc.pannes.delete('lienConnexion');
  await lea.page.click('#btn-email');
  await lea.page.locator('#email-sent').waitFor({ state: 'visible' });
  assert.ok(await lea.page.locator('#login-error').isHidden());
  await s.calme();
  assert.strictEqual(mailsA('lea@exemple.fr').length, 1);
  banc.tolerer(lea, /FirebaseError|status of 503|unavailable/i);
});
