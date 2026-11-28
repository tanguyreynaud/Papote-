// Premier contact d'un proche invité (revue du 28/11) : de l'e-mail d'invitation à sa première photo envoyée, en
// comptant chaque toucher et chaque champ. Un garde-fou : le chemin ne doit pas s'allonger sans qu'on le décide.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

const CAPTURES = process.env.PREMIER_CONTACT_CAPTURES || '';

/** Compte les touchers (vrais clics) et les caractères tapés dans la page du proche, étape par étape. */
async function compteur(t) {
  const c = { etapes: [], touchers: 0, caracteres: 0 };
  await t.context.exposeBinding('__compter', (_s, quoi) => { if (quoi === 'toucher') c.touchers++; else c.caracteres++; });
  await t.context.addInitScript(() => {
    addEventListener('click', (e) => { if (e.isTrusted) window.__compter('toucher'); }, true);
    addEventListener('keydown', (e) => { if (e.isTrusted && e.key.length === 1) window.__compter('caractere'); }, true);
  });
  let n = 0;
  c.etape = async (nom, hors = 0) => {
    await t.page.waitForTimeout(400);
    const avant = c.etapes.reduce((s, e) => ({ t: s.t + e.touchers, k: s.k + e.caracteres }), { t: 0, k: 0 });
    c.touchers += hors; // gestes hors de l'appli (boîte mail, galerie du téléphone)
    c.etapes.push({ nom, touchers: c.touchers - avant.t, caracteres: c.caracteres - avant.k });
    if (CAPTURES) { fs.mkdirSync(CAPTURES, { recursive: true }); await t.page.screenshot({ path: path.join(CAPTURES, `${String(++n).padStart(2, '0')}.png`) }); }
  };
  return c;
}

test('Proche invité par e-mail : de l\'e-mail à la première photo envoyée, touchers comptés', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await julie.page.click('#btn-invite');
  await g.attendreVue(julie, 'view-invite');
  await julie.page.fill('#invite-email', 'paul@exemple.fr');
  await julie.page.click('#form-invite button[type=submit]');
  await g.repondre(julie, 'Inviter');
  await g.toast(julie, 'Invitation envoyée à');
  const lien = /https?:\/\/\S+(\?code=[A-Z0-9-]+&pour=[^\s"<>]+)/.exec(g.dernierMail('paul@exemple.fr').texte);

  const paul = await banc.telephone('Paul', { largeur: 360, hauteur: 740 });
  const c = await compteur(paul);
  const p = paul.page;
  // 1. La boîte mail : ouvrir l'e-mail, toucher le bouton (2 touchers hors de l'appli).
  await g.ouvrir(paul, lien[1]);
  await g.attendreVue(paul, 'view-login');
  await c.etape('E-mail d\'invitation ouvert, bouton touché', 2);
  // 2. Se connecter par e-mail : l'adresse, « Recevoir un lien ».
  await p.click('#login-email');
  await p.keyboard.type('paul@exemple.fr');
  const avant = (await g.codesEmail('paul@exemple.fr')).length;
  await p.click('#btn-email');
  await p.locator('#email-sent').waitFor({ state: 'visible' });
  await c.etape('Adresse tapée, lien de connexion demandé');
  // 3. Retour à la boîte mail : ouvrir le 2e e-mail, toucher le lien (3 touchers hors de l'appli, avec le changement d'appli).
  let codes = [];
  for (let i = 0; i < 50 && codes.length <= avant; i++) { codes = await g.codesEmail('paul@exemple.fr'); await new Promise((r) => setTimeout(r, 100)); }
  await p.goto(`${banc.origine}/?lien=1&mode=signIn&oobCode=${codes[codes.length - 1].oobCode}&apiKey=cle-de-test&lang=fr`);
  await g.attendreVue(paul, 'view-moi');
  await c.etape('2e e-mail ouvert, lien de connexion touché', 3);
  // 4. Vos informations.
  await p.click('#moi-prenom'); await p.keyboard.type('Paul');
  await p.click('#moi-tel'); await p.keyboard.type('0611223344');
  await p.click('#form-moi .genre-btn[data-genre="homme"]');
  await c.etape('Vos informations : prénom, numéro, « Je suis »');
  // La photo : « Ajouter ma photo », puis la galerie du téléphone (choisir, valider : 2 touchers hors de l'appli).
  const choix = p.waitForEvent('filechooser');
  await p.locator('#form-moi .moi-rond').click();
  await (await choix).setFiles(await g.photo({ largeur: 800, hauteur: 800, texte: 'Paul' }));
  await p.locator('#moi-photo').waitFor({ state: 'visible' });
  await c.etape('Vos informations : ma photo', 2);
  const listes = p.locator('#form-moi button.liste-papote:visible');
  for (const [k, texte] of [[0, '12'], [1, 'mai'], [2, '1985']]) {
    // Le clavier encore ouvert (on vient de taper le numéro) se referme quand on touche « Jour » : la liste reste.
    if (k === 0) await g.clavier(paul, true);
    await listes.nth(k).click();
    const menu = p.locator('.liste-papote-menu');
    await menu.waitFor();
    if (k === 0) { await g.clavier(paul, false); await p.waitForTimeout(300); assert.ok(await menu.isVisible(), 'la liste reste ouverte quand le clavier se referme'); }
    await menu.locator('.liste-papote-choix').filter({ hasText: new RegExp(`^${texte}$`, 'i') }).click();
    await menu.waitFor({ state: 'detached' });
  }
  await c.etape('Vos informations : anniversaire (jour, mois, année)');
  await p.click('#form-moi button[type=submit]');
  await g.attendreVue(paul, 'view-invited');
  await c.etape('Continuer');
  await p.click('#invitations button[type=submit]');
  await g.attendreVue(paul, 'view-home');
  await c.etape('Invitation : « Rejoindre »');
  // Le petit guide : « Passer » (ou 3 fois « Suivant »).
  await p.locator('.guide-back button', { hasText: 'Passer' }).click();
  await p.locator('.guide-back').waitFor({ state: 'detached' });
  await c.etape('Petit guide : « Passer »');
  // La première photo : « Envoyer une photo », la galerie (choisir, valider : 2 touchers hors de l'appli), « Envoyer ».
  await p.click('#photo-nudge');
  await p.locator('#sheet-post').waitFor({ state: 'visible' });
  await c.etape('« Envoyer une photo »');
  const galerie = p.waitForEvent('filechooser');
  await p.locator('#sheet-post button, #sheet-post label').filter({ hasText: /Galerie|Choisir/ }).first().click();
  await (await galerie).setFiles(await g.photo({ texte: 'Coucou', nom: 'coucou.jpg' }));
  await g.visible(paul, '#btn-send').waitFor();
  await c.etape('Galerie du téléphone : une photo choisie', 2);
  await p.click('#btn-send');
  await g.toast(paul, 'Envoyé');
  await g.attendreBase(async () => (await g.liste(`families/${fid}/posts`)).some((x) => x.authorName === 'Paul' && x.type === 'photo'), 'photo de Paul partie');
  await c.etape('« Envoyer »');
  const total = c.etapes.reduce((n, e) => n + e.touchers, 0);
  const tapes = c.etapes.reduce((n, e) => n + e.caracteres, 0);
  console.log(`TOTAL ${total} touchers, ${tapes} caractères tapés`);
  if (CAPTURES) fs.writeFileSync(path.join(CAPTURES, 'etapes.json'), JSON.stringify({ total, tapes, etapes: c.etapes }, null, 1));
  // Garde-fou : 27 touchers et 29 caractères le 28/11. Un chemin plus long doit être une décision, pas un accident.
  assert.ok(total <= 27, `le premier contact s'est allongé : ${total} touchers (27 au plus)`);
});
