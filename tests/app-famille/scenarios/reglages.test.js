// Réglages de la tablette (propriétaire), dépannage à distance, profil, plusieurs familles,
// départ d'un proche, déconnexion et reconnexion.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

const { s } = banc;

banc.brancher();

async function modifier(t, carte) {
  await t.page.click(`#${carte} .setting-modify`);
  await t.page.locator(`#${carte} .setting-edit`).waitFor({ state: 'visible' });
}
const enregistrer = (t, carte) => t.page.click(`#${carte} .setting-edit button[type=submit]`);

test('Réglages de la tablette : nom, options et radio, volume, nuit, météo, photo de Mamie, dépannage', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await g.ouvrirTuile(julie, 'settings');
  await julie.page.locator('#members li', { hasText: 'Tablette de Mamie Emma' }).waitFor();
  await julie.page.locator('#members li', { hasText: 'Julie' }).locator('.badge', { hasText: 'Responsable' }).waitFor();
  // Météo de la ville du point relais (commande), donnée par le serveur à l'installation.
  assert.strictEqual(await julie.page.locator('#meteo-current').innerText(), 'Saint-Martin-de-Valamas');

  // Nom de la tablette.
  await modifier(julie, 'family-name-card');
  assert.strictEqual(await julie.page.inputValue('#family-name'), 'Mamie Emma');
  await julie.page.fill('#family-name', 'Mamie Jeanne');
  await enregistrer(julie, 'family-name-card');
  await g.toast(julie, 'Nom enregistré');
  await julie.page.locator('#family-name-value', { hasText: 'Mamie Jeanne' }).waitFor();
  assert.strictEqual((await g.lire(`families/${fid}`)).name, 'Mamie Jeanne');

  // Options : sans lecture à voix haute, radio FIP.
  await modifier(julie, 'options-card');
  assert.strictEqual(await julie.page.isChecked('#opt-sos'), true, 'SOS activé à l\'installation');
  await julie.page.locator('#opt-lecture').setChecked(false);
  await julie.page.locator('#opt-radio').setChecked(true);
  await julie.page.selectOption('#opt-radio-station', { label: 'FIP' });
  await enregistrer(julie, 'options-card');
  await g.toast(julie, 'Options envoyées à la tablette');
  const options = (await g.lire(`families/${fid}`)).options;
  assert.strictEqual(options.lecture, false);
  assert.strictEqual(options.sos, true);
  assert.deepStrictEqual([options.radio.active, options.radio.nom], [true, 'FIP']);
  assert.match(await julie.page.locator('#options-value').innerText(), /FIP/);

  // Volume.
  await modifier(julie, 'volume-card');
  await julie.page.locator('#volume').fill('50');
  await enregistrer(julie, 'volume-card');
  await g.toast(julie, 'Volume envoyé');
  assert.strictEqual((await g.lire(`families/${fid}`)).volume, 50);
  await julie.page.locator('#volume-text', { hasText: '50 %' }).waitFor();

  // Nuit : mêmes heures refusées, puis de 22 h à 8 h.
  await modifier(julie, 'sleep-card');
  await julie.page.selectOption('#sleep-from', '7');
  await julie.page.selectOption('#sleep-to', '7');
  await enregistrer(julie, 'sleep-card');
  assert.match(await g.texteFenetre(julie), /L'heure de fin doit être différente/);
  await g.repondre(julie, 'OK');
  await julie.page.selectOption('#sleep-from', '22');
  await julie.page.selectOption('#sleep-to', '8');
  await enregistrer(julie, 'sleep-card');
  await g.toast(julie, 'Mise en veille enregistrée');
  assert.deepStrictEqual((await g.lire(`families/${fid}`)).veille, { active: true, de: 22, a: 8 });
  await julie.page.locator('#sleep-value', { hasText: 'De 22 h à 8 h' }).waitFor();

  // Météo : code postal puis commune.
  await modifier(julie, 'meteo-card');
  await julie.page.fill('#meteo-cp', '07310');
  await julie.page.locator('#meteo-commune-wrap').waitFor({ state: 'visible' });
  await enregistrer(julie, 'meteo-card');
  await g.toast(julie, 'Ville envoyée à la tablette');
  assert.strictEqual((await g.lire(`families/${fid}`)).meteoVille.nom, 'Saint-Martin-de-Valamas');

  // Photo de Mamie (affichée quand elle appelle) : sur les deux fiches de la tablette.
  await julie.page.locator('#tablet-face-card').waitFor({ state: 'visible' });
  await julie.page.setInputFiles('#in-tface-gallery', await g.photo({ largeur: 1000, hauteur: 1400, texte: 'Mamie' }));
  await g.toast(julie, 'Photo enregistrée');
  for (const uid of [tab.tabletUid, tab.callsUid]) {
    await g.attendreBase(async () => (await g.lire(`families/${fid}/members/${uid}`)).face, `photo sur la fiche ${uid}`);
  }

  // Dépannage : « Obtenir l'état », la tablette répond.
  await julie.page.locator('#remote-card').waitFor({ state: 'visible' });
  await julie.page.click('#remote-card [data-cmd="status"]');
  await julie.page.locator('#remote-result', { hasText: 'en attente de la tablette' }).waitFor();
  const [cmd] = await g.attendreBase(async () => { const l = await g.liste(`families/${fid}/commands`); return l.filter((c) => c.type === 'status').length && l.filter((c) => c.type === 'status'); }, 'commande écrite');
  assert.strictEqual(cmd.state, 'pending');
  assert.ok([tab.tabletUid, tab.callsUid].includes(cmd.target));
  await s.db.doc(`families/${fid}/commands/${cmd.id}`).update({ state: 'done', result: 'Batterie 87 %, Wi-Fi Maison', doneAt: s.FieldValue.serverTimestamp() });
  await julie.page.locator('#remote-result.ok', { hasText: 'Batterie 87 %' }).waitFor();
  await g.attendreBase(async () => !(await g.liste(`families/${fid}/commands`)).some((c) => c.id === cmd.id), 'commande effacée');
  // Redémarrer : confirmé avant.
  await julie.page.click('#remote-card [data-cmd="restart"]');
  await g.repondre(julie, 'Annuler');
  assert.strictEqual((await g.liste(`families/${fid}/commands`)).some((c) => c.type === 'restart'), false);
  await julie.page.click('#remote-card [data-cmd="restart"]');
  await g.repondre(julie, 'Redémarrer');
  await g.attendreBase(async () => (await g.liste(`families/${fid}/commands`)).some((c) => c.type === 'restart'), 'redémarrage demandé');
});

test('Un proche (pas propriétaire) : réglages de la tablette réservés, profil, apparence, quitter la famille', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const paul = await banc.telephone('Paul');
  const uid = await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });

  await g.ouvrirTuile(paul, 'settings');
  await paul.page.locator('#tablet-owner-note', { hasText: 'depuis le téléphone de Julie' }).waitFor();
  for (const carte of ['options-card', 'volume-card', 'sleep-card', 'meteo-card', 'family-name-card', 'remote-card']) {
    assert.strictEqual(await paul.page.locator(`#${carte}`).isVisible(), false, `${carte} caché pour un proche`);
  }
  await paul.page.click('#view-settings .back');
  await g.attendreVue(paul, 'view-home');

  // Profil : prénom, genre, photo, apparence sombre.
  await paul.page.click('.nav-item[data-tab="profile"]');
  await g.attendreVue(paul, 'view-profile');
  assert.match(await paul.page.locator('#account-email').innerText(), /paul@exemple\.fr/);
  await modifier(paul, 'my-name-card');
  await paul.page.fill('#my-name', 'Paulo');
  await enregistrer(paul, 'my-name-card');
  await g.toast(paul, 'Prénom enregistré');
  await modifier(paul, 'my-genre-card');
  assert.strictEqual(await paul.page.isChecked('input[name="my-genre"][value="homme"]'), true);
  await paul.page.check('input[name="my-genre"][value="femme"]');
  await enregistrer(paul, 'my-genre-card');
  await g.toast(paul, 'Enregistré');
  await g.attendreBase(async () => { const m = await g.lire(`families/${fid}/members/${uid}`); return m.name === 'Paulo' && m.genre === 'femme'; }, 'profil enregistré');
  await paul.page.setInputFiles('#in-face-gallery', await g.photo({ texte: 'Paulo' }));
  await paul.page.locator('#face-img').waitFor({ state: 'visible' });
  await paul.page.click('[data-theme-choice="dark"]');
  assert.strictEqual(await paul.page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await paul.page.reload();
  await g.attendreVue(paul, 'view-home');
  assert.strictEqual(await paul.page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'thème gardé');
  // Le nouveau prénom apparaît chez Julie.
  await g.ouvrirTuile(julie, 'settings');
  await julie.page.locator('#members li', { hasText: 'Paulo' }).waitFor();

  // Julie (propriétaire et responsable) ne peut pas quitter sa famille ; Paul si.
  await julie.page.click('#view-settings .back');
  await g.attendreVue(julie, 'view-home');
  await julie.page.click('.nav-item[data-tab="profile"]');
  assert.strictEqual(await julie.page.locator('#btn-leave').isVisible(), false);
  await paul.page.click('.nav-item[data-tab="profile"]');
  await paul.page.click('#btn-leave');
  assert.match(await g.texteFenetre(paul), /Quitter la famille de Mamie Emma/);
  await g.repondre(paul, 'Quitter');
  await g.attendreVue(paul, 'view-join');
  await g.attendreBase(async () => !(await g.liste(`families/${fid}/members`)).some((m) => m.id === uid), 'Paul parti');
});

test('Deux familles : changer de famille depuis l\'accueil ; déconnexion puis reconnexion', async () => {
  // Julie installe la tablette de Mamie Emma, puis celle de Papi Jean.
  const julie = await banc.telephone('Julie');
  const { fid: emma } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await julie.page.click('.nav-item[data-tab="profile"]');
  await julie.page.click('#view-profile [data-action="other-family"]');
  await g.attendreVue(julie, 'view-join');
  const tab2 = await g.tabletteAllumee({ commande: { email: 'julie@exemple.fr' } });
  const jean = await g.installer(julie, tab2, { nom: 'Papi Jean' });
  await g.fermerAccueil(julie);
  assert.notStrictEqual(jean, emma);

  // Le nom en haut de l'accueil devient un bouton pour changer de famille.
  await julie.page.locator('#family-switch', { hasText: 'Pour Papi Jean' }).waitFor();
  await julie.page.click('#family-switch');
  await g.repondre(julie, 'Famille de Mamie Emma');
  await julie.page.locator('#family-switch', { hasText: 'Pour Mamie Emma' }).waitFor();
  await g.ouvrirTuile(julie, 'messages');
  await julie.page.fill('#message-text', 'Pour Emma seulement');
  await julie.page.click('#btn-message');
  await g.attendreBase(async () => (await g.liste(`families/${emma}/posts`)).some((p) => p.text === 'Pour Emma seulement'), 'message chez Emma');
  assert.strictEqual((await g.liste(`families/${jean}/posts`)).some((p) => p.text === 'Pour Emma seulement'), false);
  await julie.page.click('#view-messages .back');
  await g.attendreVue(julie, 'view-home');

  // Fermer et rouvrir l'app : on retrouve la dernière famille choisie.
  await julie.page.reload();
  await g.attendreVue(julie, 'view-home');
  await julie.page.locator('#family-switch', { hasText: 'Pour Mamie Emma' }).waitFor();

  // Déconnexion, puis reconnexion : pas de nouvelles questions, retour direct à l'accueil.
  await julie.page.click('.nav-item[data-tab="profile"]');
  await julie.page.click('#view-profile [data-action="logout"]');
  await g.repondre(julie, 'Se déconnecter');
  await g.attendreVue(julie, 'view-login');
  await g.seConnecter(julie, 'julie@exemple.fr');
  await g.attendreVue(julie, 'view-home');
});
