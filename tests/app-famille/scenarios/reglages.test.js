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

  // Volumes : sonnerie, vidéos et messages lus. Chaque barre lâchée fait sonner ou parler la tablette, sans
  // récapitulatif « La tablette sonne à 70 % » au-dessus d'Enregistrer (Tanguy, 17/11 : inutile).
  await modifier(julie, 'volume-card');
  await julie.page.locator('#volume-sonnerie').fill('70');
  await julie.page.locator('#volume').fill('50');
  const essais = await g.attendreBase(async () => {
    const c = (await g.liste(`families/${fid}/commands`)).filter((d) => d.type === 'son');
    return c.length >= 2 && c;
  }, 'essais du son');
  assert.ok(essais.some((c) => c.quoi === 'sonnerie' && c.volume === 70));
  assert.ok(essais.some((c) => c.quoi === 'voix' && c.volume === 50));
  assert.strictEqual(await julie.page.locator('#volume-card').getByText(/La tablette (sonne|parle) à/).count(), 0, 'plus de récapitulatif');
  // « Écouter » touché : un petit mot en bas, et la tablette sonne.
  await julie.page.click('#volume-card .volume-essai[data-essai="sonnerie"]');
  await g.toast(julie, 'Écoutez la tablette : elle sonne.');
  await g.attendreBase(async () => (await g.liste(`families/${fid}/commands`)).filter((d) => d.type === 'son').length >= 3, '3e essai du son');
  assert.strictEqual(await julie.page.inputValue('#volume-appel'), '100', 'appels au plus fort par défaut');
  await julie.page.locator('#volume-appel').fill('80');
  await enregistrer(julie, 'volume-card');
  await g.toast(julie, 'Volumes envoyés');
  const fam = await g.lire(`families/${fid}`);
  assert.deepStrictEqual([fam.volume, fam.volumeSonnerie, fam.volumeAppel], [50, 70, 80]);
  await julie.page.locator('#volume-text', { hasText: 'Sonnerie 70 % · Vidéos et messages 50 % · Appels 80 %' }).waitFor();

  // Nuit : le coucher se choisit le soir (19 h à 23 h 30), le réveil le matin (5 h à 10 h), par demi-heure
  // (Tanguy, 17/11) ; puis de 22 h à 6 h 30.
  await modifier(julie, 'sleep-card');
  const heures = (sel) => julie.page.locator(`${sel} option`).evaluateAll((os) => os.map((o) => o.textContent));
  assert.deepStrictEqual(await heures('#sleep-from'), ['19 h', '19 h 30', '20 h', '20 h 30', '21 h', '21 h 30', '22 h', '22 h 30', '23 h', '23 h 30']);
  assert.deepStrictEqual(await heures('#sleep-to'), ['5 h', '5 h 30', '6 h', '6 h 30', '7 h', '7 h 30', '8 h', '8 h 30', '9 h', '9 h 30', '10 h']);
  assert.deepStrictEqual([await julie.page.inputValue('#sleep-from'), await julie.page.inputValue('#sleep-to')], ['23:0', '5:0'], 'par défaut 23 h à 5 h (Tanguy, 17/11)');
  // T-003 (17/11) : réveil réglé à « 20 h 30 » dans l'ancienne liste de 0 h à 23 h 30 (8 h 30 voulu ?), la tablette
  // en nuit 23 h 30 sur 24. Plus aucune heure du soir dans le réveil, ni du matin dans le coucher.
  for (const [liste, interdite] of [['#sleep-to', '20:30'], ['#sleep-to', '12:0'], ['#sleep-from', '8:30'], ['#sleep-from', '0:30']]) {
    assert.strictEqual(await julie.page.locator(`${liste} option[value="${interdite}"]`).count(), 0, `${liste} ${interdite}`);
  }
  await julie.page.selectOption('#sleep-from', '22:0');
  await julie.page.selectOption('#sleep-to', '6:30');
  await enregistrer(julie, 'sleep-card');
  await g.toast(julie, 'Mise en veille enregistrée');
  assert.deepStrictEqual((await g.lire(`families/${fid}`)).veille, { active: true, de: 22, a: 6, aMin: 30 });
  await julie.page.locator('#sleep-value', { hasText: 'De 22 h à 6 h 30' }).waitFor();

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

// Tanguy, 17/11 : le nom de la tablette acceptait un numéro de téléphone, et la nuit se réglait de 0 h 30 à 23 h 30.
test('Nom de la tablette : jamais un numéro (message sous le champ) ; nuit : heures d\'avant hors des bornes ramenées', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await g.ouvrirTuile(julie, 'settings');

  await modifier(julie, 'family-name-card');
  // Testeur du 17/11 (V6) : « 12345 », émojis, balises et nom vidé passaient, ou rien ne se passait sans un mot.
  const MOTIFS = {
    '06 12 34 56 78': /ressemble à un numéro de téléphone/, '0612345678': /ressemble à un numéro/,
    '+33 6 12 34 56 78': /ressemble à un numéro/, 12345: /ressemble à un numéro/, 'Mamie 0612': /ressemble à un numéro/,
    12: /ressemble à un numéro/, '---': /avec des lettres/, 'Mamie 🙂🙂': /émojis/, '🙂🙂': /émojis/,
    'Mamie <b>Rose</b>': /< et >/, '   ': /Indiquez le nom de la tablette/, '': /Indiquez le nom de la tablette/,
  };
  for (const [nom, motif] of Object.entries(MOTIFS)) {
    await julie.page.fill('#family-name', nom);
    await enregistrer(julie, 'family-name-card');
    const erreur = julie.page.locator('#family-name-error');
    await erreur.waitFor();
    assert.match(await erreur.innerText(), motif, `« ${nom} »`);
    assert.ok(await julie.page.locator('#form-family-name').isVisible(), 'le champ reste ouvert pour corriger');
  }
  // Juste sous le champ, en calme : pas une fenêtre.
  assert.strictEqual(await julie.page.locator('.dialog-back').count(), 0);
  const ecart = await julie.page.evaluate(() => document.getElementById('family-name-error').getBoundingClientRect().top
    - document.getElementById('family-name').getBoundingClientRect().bottom);
  assert.ok(ecart >= 0 && ecart < 40, `sous le champ (${ecart} px)`);
  assert.strictEqual((await g.lire(`families/${fid}`)).name, 'Mamie Emma', 'rien d\'écrit');
  // Le message part dès qu'on corrige ; accents, trait d'union, apostrophe, espace et un chiffre vont bien.
  await julie.page.fill('#family-name', 'Pépé d\'Émile-André 2');
  assert.strictEqual(await julie.page.locator('#family-name-error').isVisible(), false);
  await enregistrer(julie, 'family-name-card');
  await g.toast(julie, 'Nom enregistré');
  assert.strictEqual((await g.lire(`families/${fid}`)).name, 'Pépé d\'Émile-André 2');
  // Rouvert : plus de message d'avant.
  await modifier(julie, 'family-name-card');
  assert.strictEqual(await julie.page.locator('#family-name-error').isVisible(), false);
  await julie.page.click('#family-name-card .setting-cancel');

  // Nuit réglée avant les bornes (cas réel : de 21 h à 20 h 30, la tablette en nuit 23 h 30 sur 24) : l'app d'un
  // responsable la ramène dans les bornes (réveil le plus proche, en passant minuit : 5 h) et l'envoie à la tablette, sans rien demander.
  await s.db.doc(`families/${fid}`).update({ veille: { active: true, de: 21, a: 20, aMin: 30 } });
  await g.attendreBase(async () => require('node:util').isDeepStrictEqual((await g.lire(`families/${fid}`)).veille, { active: true, de: 21, a: 5 }), 'veille ramenée à 21 h – 5 h');
  await julie.page.locator('#sleep-value', { hasText: 'De 21 h à 5 h' }).waitFor();
  // Coucher à 0 h 30 et réveil à midi : 23 h 30 et 10 h ; les listes ne sont jamais vides.
  await s.db.doc(`families/${fid}`).update({ veille: { active: false, de: 0, deMin: 30, a: 12 } });
  await g.attendreBase(async () => (await g.lire(`families/${fid}`)).veille.de === 23, 'veille ramenée à 23 h 30 – 10 h');
  assert.deepStrictEqual((await g.lire(`families/${fid}`)).veille, { active: false, de: 23, deMin: 30, a: 10 });
  await julie.page.locator('#sleep-value', { hasText: 'Jamais' }).waitFor();
  await modifier(julie, 'sleep-card');
  await julie.page.locator('#sleep-on').setChecked(true);
  assert.deepStrictEqual([await julie.page.inputValue('#sleep-from'), await julie.page.inputValue('#sleep-to')], ['23:30', '10:0']);
  await julie.page.selectOption('#sleep-to', '7:0');
  await enregistrer(julie, 'sleep-card');
  await g.toast(julie, 'Mise en veille enregistrée');
  assert.deepStrictEqual((await g.lire(`families/${fid}`)).veille, { active: true, de: 23, deMin: 30, a: 7 });
  await julie.page.locator('#sleep-value', { hasText: 'De 23 h 30 à 7 h' }).waitFor();
});
