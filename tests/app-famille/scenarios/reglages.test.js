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
  // Trois choix en haut de Réglages (Tanguy, 20/11) : un responsable arrive sur « La tablette » ; les membres et
  // « Inviter un proche » sont dans « La famille ».
  await g.ouvrirTuile(julie, 'settings');
  assert.deepStrictEqual(await julie.page.locator('#view-settings [data-reglages-choix]:visible').allInnerTexts(), ['La tablette', 'La famille', 'Mon profil']);
  await julie.page.locator('#rg-tablette').waitFor({ state: 'visible' });
  assert.strictEqual(await julie.page.locator('#members').isVisible(), false, 'les membres ne sont plus sous « La tablette »');
  await julie.page.locator('#tablette-etat', { hasText: /En ligne|Hors ligne/ }).waitFor();
  await g.panneau(julie, 'famille');
  await julie.page.locator('#members li', { hasText: 'Tablette de Mamie Emma' }).waitFor();
  await julie.page.locator('#members li', { hasText: 'Julie' }).locator('.badge', { hasText: 'Responsable' }).waitFor();
  assert.strictEqual(await julie.page.locator('#volume-card').isVisible(), false, 'les réglages de la tablette ne sont pas sous « La famille »');
  await julie.page.click('#btn-invite-famille');
  await g.attendreVue(julie, 'view-invite');
  // Retour : on revient sur Réglages, toujours sur « La famille ».
  await julie.page.click('#view-invite .back');
  await g.attendreVue(julie, 'view-settings');
  await julie.page.locator('#rg-famille').waitFor({ state: 'visible' });
  await g.panneau(julie, 'tablette');
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

  // Les anciennes « Options de la tablette », rangées par sujet (Tanguy, 20/11).
  // Son : la lecture à voix haute se coupe d'un toucher, sans « Enregistrer » ; double appui = une seule écriture.
  const rev0 = (await g.lire(`families/${fid}`)).rev || 0;
  assert.strictEqual(await julie.page.isChecked('#opt-lecture'), true, 'lecture activée au départ');
  await julie.page.locator('#opt-lecture-ligne').scrollIntoViewIfNeeded();
  await g.doubleAppui(julie, '#opt-lecture-ligne .toggle-text');
  await g.toast(julie, 'Lecture à voix haute coupée');
  await g.attendreBase(async () => (await g.lire(`families/${fid}`)).options.lecture === false, 'lecture coupée');
  await julie.page.waitForTimeout(600);
  assert.strictEqual((await g.lire(`families/${fid}`)).rev, rev0 + 1, 'double appui : une seule écriture');
  assert.strictEqual(await julie.page.isChecked('#opt-lecture'), false);
  // Écran : durée d'affichage d'un envoi ou d'un rappel pas encore vu, 3 minutes sans réglage, 1 à 5 au choix.
  await modifier(julie, 'duree-card');
  assert.strictEqual(await julie.page.inputValue('#opt-duree-affichage'), '3', '3 minutes sans réglage');
  assert.deepStrictEqual(await julie.page.locator('#opt-duree-affichage option').allInnerTexts(), ['1 minute', '2 minutes', '3 minutes', '4 minutes', '5 minutes']);
  await julie.page.selectOption('#opt-duree-affichage', '5');
  await enregistrer(julie, 'duree-card');
  await g.toast(julie, 'Durée envoyée à la tablette');
  await julie.page.locator('#duree-value', { hasText: '5 minutes' }).waitFor();
  // Radio seulement en Wi-Fi (Tanguy, 23/11) : cachée tant que la tablette n'a pas de Wi-Fi, là dès qu'elle en a un.
  assert.strictEqual(await julie.page.locator('#radio-card').isVisible(), false, 'pas de radio sans Wi-Fi');
  const membreTab = (await g.liste(`families/${fid}/members`)).find((m) => m.role === 'tablette');
  await s.db.doc(`families/${fid}/members/${membreTab.id}`).update({ wifi: { ssid: 'Livebox-Emma' } });
  await julie.page.locator('#radio-card').waitFor({ state: 'visible' });
  // Accueil de la tablette : radio FIP ; prochain rappel enlevé d'un toucher.
  await modifier(julie, 'radio-card');
  await julie.page.locator('#form-radio', { hasText: 'Fonctionne seulement en Wi-Fi' }).waitFor();
  await julie.page.locator('#opt-radio').setChecked(true);
  await julie.page.selectOption('#opt-radio-station', { label: 'FIP' });
  await enregistrer(julie, 'radio-card');
  await g.toast(julie, 'Radio envoyée à la tablette');
  await julie.page.locator('#radio-value', { hasText: 'FIP' }).waitFor();
  // Wi-Fi perdu un moment : une radio déjà activée reste visible, pour pouvoir l'enlever.
  await s.db.doc(`families/${fid}/members/${membreTab.id}`).update({ wifi: null });
  await julie.page.waitForTimeout(800);
  assert.strictEqual(await julie.page.locator('#radio-card').isVisible(), true, 'radio activée gardée sans Wi-Fi');
  await julie.page.waitForTimeout(2800); // le toast précédent s'en va
  await julie.page.click('#opt-rappels-accueil-ligne .toggle-text');
  await g.toast(julie, 'Prochain rappel enlevé de l\'accueil');
  // Météo : l'interrupteur seul, sans changer de ville.
  await modifier(julie, 'meteo-card');
  assert.strictEqual(await julie.page.isChecked('#opt-meteo'), true);
  await julie.page.locator('#opt-meteo').setChecked(false);
  await enregistrer(julie, 'meteo-card');
  await g.toast(julie, 'Météo enlevée de l\'accueil');
  await julie.page.locator('#meteo-current', { hasText: 'Enlevée de l\'accueil · Saint-Martin-de-Valamas' }).waitFor();
  // Sécurité : le bouton SOS est sur la même ligne que l'ordre d'appel. Le couper n'enregistre pas d'ordre.
  await modifier(julie, 'sos-ordre-card');
  assert.strictEqual(await julie.page.isChecked('#opt-sos'), true, 'SOS activé à l\'installation');
  await julie.page.locator('#opt-sos').setChecked(false);
  await enregistrer(julie, 'sos-ordre-card');
  await g.toast(julie, 'SOS famille enlevé de la tablette');
  await julie.page.locator('#sos-ordre-value', { hasText: 'Désactivé' }).waitFor();
  let fam0 = await g.lire(`families/${fid}`);
  assert.strictEqual(fam0.sosOrdre, undefined, 'aucun ordre figé en coupant le bouton');
  await modifier(julie, 'sos-ordre-card');
  await julie.page.locator('#opt-sos').setChecked(true);
  await enregistrer(julie, 'sos-ordre-card');
  await g.toast(julie, 'SOS famille activé sur la tablette');
  // Chaque réglage n'a changé que le sien : rien n'a été écrasé par un autre.
  fam0 = await g.lire(`families/${fid}`);
  const options = fam0.options;
  assert.strictEqual(options.dureeAffichage, 5, 'durée d\'affichage enregistrée pour la tablette');
  assert.strictEqual(options.lecture, false);
  assert.strictEqual(options.sos, true);
  assert.strictEqual(options.meteo, false);
  assert.strictEqual(options.rappelsAccueil, false);
  assert.deepStrictEqual([options.radio.active, options.radio.nom], [true, 'FIP']);

  // Volumes : sonnerie, vidéos et messages lus, appels. Glisser une barre ne fait rien sonner : la tablette ne
  // joue un son que sur « Écouter », une seule demande même au double appui (Tanguy, 19/11). Pas de
  // récapitulatif « La tablette sonne à 70 % » au-dessus d'Enregistrer (Tanguy, 17/11 : inutile).
  const essaisSon = async () => (await g.liste(`families/${fid}/commands`)).filter((d) => d.type === 'son');
  await modifier(julie, 'volume-card');
  assert.strictEqual(await julie.page.inputValue('#volume-appel'), '100', 'appels au plus fort par défaut');
  await julie.page.locator('#volume-sonnerie').fill('70');
  await julie.page.locator('#volume').fill('50');
  await julie.page.locator('#volume-appel').fill('80');
  for (const barre of ['#volume-sonnerie', '#volume', '#volume-appel']) {
    await julie.page.locator(barre).focus();
    await julie.page.keyboard.press('ArrowLeft');
    await julie.page.keyboard.press('ArrowRight');
  }
  await julie.page.locator('#volume-sonnerie-val', { hasText: '70 %' }).waitFor();
  await julie.page.waitForTimeout(1500);
  assert.strictEqual((await essaisSon()).length, 0, 'aucun son demandé en changeant un réglage');
  assert.strictEqual(await julie.page.locator('#volume-card').getByText(/La tablette (sonne|parle) à/).count(), 0, 'plus de récapitulatif');
  // Chaque « Écouter », touché deux fois de suite : une seule demande, et le bouton change tout de suite.
  const tablettes = (await g.liste(`families/${fid}/members`)).filter((m) => m.role === 'tablette').length;
  assert.ok(tablettes >= 1, 'une tablette dans la famille');
  const attendus = { sonnerie: [70, 'elle sonne.'], voix: [50, 'elle parle.'], appel: [80, 'elle parle comme pendant un appel.'] };
  let total = 0;
  for (const [quoi, [volume, mot]] of Object.entries(attendus)) {
    const bouton = `#volume-card .volume-essai[data-essai="${quoi}"]`;
    assert.strictEqual(await julie.page.locator(bouton).innerText(), 'Écouter');
    await g.doubleAppui(julie, bouton);
    await julie.page.locator(`#volume-card .volume-essai.en-cours[data-essai="${quoi}"]`, { hasText: 'Écoute…' }).waitFor();
    await g.toast(julie, `Écoutez la tablette : ${mot}`);
    total += tablettes;
    const c = await g.attendreBase(async () => { const l = await essaisSon(); return l.length >= total && l; }, `essai ${quoi}`);
    await julie.page.waitForTimeout(800);
    const deCeType = (await essaisSon()).filter((d) => d.quoi === quoi);
    assert.strictEqual(deCeType.length, tablettes, `double appui sur « Écouter » (${quoi}) : une seule demande`);
    assert.ok(deCeType.every((d) => d.volume === volume), `${quoi} au niveau de la barre`);
    if (quoi !== 'sonnerie') assert.match(deCeType[0].parle, /Vous m'entendez bien \?/);
    assert.ok(c.length >= total);
  }
  // Le son fini, le bouton redevient « Écouter ».
  await julie.page.locator('#volume-card .volume-essai[data-essai="appel"]:not(.en-cours)', { hasText: 'Écouter' }).waitFor();
  await enregistrer(julie, 'volume-card');
  await g.toast(julie, 'Volumes enregistrés');
  const fam = await g.lire(`families/${fid}`);
  assert.deepStrictEqual([fam.volume, fam.volumeSonnerie, fam.volumeAppel], [50, 70, 80]);
  await julie.page.locator('#volume-text', { hasText: 'Sonnerie 70 · Vidéos 50 · Appels 80' }).waitFor();
  assert.strictEqual((await essaisSon()).length, total, 'Enregistrer ne fait rien sonner');

  // Sonneries (Tanguy, 23/11) : trois sons pour l'appel, trois pour les envois ; le son d'avant par défaut.
  await julie.page.locator('#sons-value', { hasText: 'Appel : Sonnerie de la tablette · Envois : Ding-dong' }).waitFor();
  await modifier(julie, 'sons-card');
  assert.deepStrictEqual(await julie.page.locator('#sons-appel strong').allInnerTexts(), ['Sonnerie de la tablette', 'Téléphone d\'autrefois', 'Carillon d\'horloge']);
  assert.deepStrictEqual(await julie.page.locator('#sons-arrivee strong').allInnerTexts(), ['Ding-dong', 'Cloche', 'Sonnette']);
  assert.strictEqual(await julie.page.isChecked('#sons-appel input[value=tablette]'), true);
  assert.strictEqual(await julie.page.isChecked('#sons-arrivee input[value=dingdong]'), true);
  // « Écouter » : le son essayé est coché et joué sur la tablette, au volume de sa barre ; double appui = une demande.
  await g.doubleAppui(julie, '#sons-appel .son-ligne:nth-child(2) .son-essai');
  await g.toast(julie, 'Écoutez la tablette : elle sonne.');
  total += tablettes;
  await g.attendreBase(async () => (await essaisSon()).length >= total, 'essai de la sonnerie choisie');
  await julie.page.waitForTimeout(800);
  const essaiAppel = (await essaisSon()).filter((d) => d.son === 'autrefois');
  assert.strictEqual(essaiAppel.length, tablettes, 'une seule demande');
  assert.ok(essaiAppel.every((d) => d.quoi === 'sonnerie' && d.volume === 70));
  assert.strictEqual(await julie.page.isChecked('#sons-appel input[value=autrefois]'), true, 'le son écouté est coché');
  await julie.page.locator('#sons-arrivee .son-ligne:nth-child(2) .son-essai').click();
  total += tablettes;
  await g.attendreBase(async () => (await essaisSon()).filter((d) => d.son === 'cloche').length === tablettes, 'essai du son d\'arrivée');
  assert.ok((await essaisSon()).filter((d) => d.son === 'cloche').every((d) => d.quoi === 'arrivee' && d.volume === 50));
  await enregistrer(julie, 'sons-card');
  await g.toast(julie, 'Sonneries enregistrées');
  const famSons = await g.lire(`families/${fid}`);
  assert.deepStrictEqual([famSons.sonAppel, famSons.sonArrivee], ['autrefois', 'cloche']);
  await julie.page.locator('#sons-value', { hasText: 'Appel : Téléphone d\'autrefois · Envois : Cloche' }).waitFor();

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
  await g.toast(julie, 'Enregistré : écran éteint de 22 h à 6 h 30');
  assert.deepStrictEqual((await g.lire(`families/${fid}`)).veille, { active: true, de: 22, a: 6, aMin: 30 });
  await julie.page.locator('#sleep-value', { hasText: 'Écran éteint de 22 h à 6 h 30' }).waitFor();

  // Météo : code postal puis commune, et la météo remise sur l'accueil du même coup.
  await modifier(julie, 'meteo-card');
  await julie.page.locator('#opt-meteo').setChecked(true);
  await julie.page.fill('#meteo-cp', '07310');
  await julie.page.locator('#meteo-commune-wrap').waitFor({ state: 'visible' });
  await enregistrer(julie, 'meteo-card');
  await g.toast(julie, 'Ville envoyée à la tablette');
  const apresMeteo = await g.lire(`families/${fid}`);
  assert.strictEqual(apresMeteo.meteoVille.nom, 'Saint-Martin-de-Valamas');
  assert.strictEqual(apresMeteo.options.meteo, true);
  assert.strictEqual(apresMeteo.options.dureeAffichage, 5, 'les autres options gardées');

  // Photo de Mamie (affichée quand elle appelle) : sur les deux fiches de la tablette.
  await julie.page.click('#family-name-card .setting-modify');
  await julie.page.locator('#tablet-face-card').waitFor({ state: 'visible' });
  await julie.page.setInputFiles('#in-tface-gallery', await g.photo({ largeur: 1000, hauteur: 1400, texte: 'Mamie' }));
  await g.toast(julie, 'Photo enregistrée');
  for (const uid of [tab.tabletUid, tab.callsUid]) {
    await g.attendreBase(async () => (await g.lire(`families/${fid}/members/${uid}`)).face, `photo sur la fiche ${uid}`);
  }

  // La photo enregistrée, la fiche se referme et la montre (Tanguy, 23/11).
  await julie.page.locator('#family-name-card .setting-edit').waitFor({ state: 'hidden' });
  await julie.page.locator('#tface-img').waitFor({ state: 'visible' });
  // Dépannage : « Obtenir l'état », la tablette répond.
  await julie.page.locator('#remote-card').waitFor({ state: 'visible' });
  await julie.page.click('#remote-card summary');
  await julie.page.click('#remote-card [data-cmd="status"]');
  await julie.page.locator('#remote-result', { hasText: /en attente de la tablette|elle la recevra dès qu'elle sera de nouveau connectée/ }).waitFor();
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
  // Tablette hors ligne (aucune vraie tablette ici) : la fenêtre le dit avant d'envoyer (tests IA du 21/11).
  assert.match(await g.texteFenetre(julie), /La tablette est hors ligne : elle ne redémarrera qu'une fois reconnectée/);
  await g.repondre(julie, 'Envoyer la demande');
  await g.attendreBase(async () => (await g.liste(`families/${fid}/commands`)).some((c) => c.type === 'restart'), 'redémarrage demandé');
});

test('Un proche (pas propriétaire) : réglages de la tablette réservés, profil, apparence, quitter la famille', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const paul = await banc.telephone('Paul');
  const uid = await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });

  // Un proche n'a que deux choix : « La famille » (où il arrive) et « Mon profil ».
  await g.ouvrirTuile(paul, 'settings');
  assert.deepStrictEqual(await paul.page.locator('#view-settings [data-reglages-choix]:visible').allInnerTexts(), ['La famille', 'Mon profil']);
  await paul.page.locator('#tablet-owner-note', { hasText: 'depuis le téléphone de Julie' }).waitFor();
  await paul.page.locator('#btn-invite-famille').waitFor({ state: 'visible' });
  for (const carte of ['duree-card', 'radio-card', 'sons-card', 'sos-ordre-card', 'opt-lecture-ligne', 'volume-card', 'sleep-card', 'meteo-card', 'family-name-card', 'remote-card']) {
    assert.strictEqual(await paul.page.locator(`#${carte}`).isVisible(), false, `${carte} caché pour un proche`);
  }
  await g.retourAccueil(paul); // Réglages : plus de flèche, la barre du bas (23/11)
  await g.attendreVue(paul, 'view-home');

  // Profil : prénom, genre, photo, apparence sombre.
  await g.ouvrirProfil(paul);
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
  await paul.page.click('#apparence-card summary');
  await paul.page.click('[data-theme-choice="dark"]');
  assert.strictEqual(await paul.page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await paul.page.reload();
  await g.attendreVue(paul, 'view-home');
  assert.strictEqual(await paul.page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'thème gardé');
  // Le nouveau prénom apparaît chez Julie.
  await g.ouvrirFamille(julie);
  await julie.page.locator('#members li', { hasText: 'Paulo' }).waitFor();

  // Julie (propriétaire et responsable) ne peut pas quitter sa famille ; Paul si.
  await g.retourAccueil(julie); // Réglages : plus de flèche, la barre du bas (23/11)
  await g.attendreVue(julie, 'view-home');
  await g.ouvrirProfil(julie);
  assert.strictEqual(await julie.page.locator('#btn-leave').isVisible(), false);
  await g.ouvrirProfil(paul);
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
  await g.ouvrirProfil(julie);
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
  await g.ouvrirProfil(julie);
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

  // responsable la ramène dans les bornes (simple borne, comme la tablette et le serveur : réveil 10 h) et l'envoie à la tablette, sans rien demander.
  // responsable la ramène dans les bornes (réveil le plus proche, en passant minuit : 5 h) et l'envoie à la tablette, sans rien demander.
  await s.db.doc(`families/${fid}`).update({ veille: { active: true, de: 21, a: 20, aMin: 30 } });
  await g.attendreBase(async () => require('node:util').isDeepStrictEqual((await g.lire(`families/${fid}`)).veille, { active: true, de: 21, a: 10 }), 'veille ramenée à 21 h – 10 h');
  await julie.page.locator('#sleep-value', { hasText: 'Écran éteint de 21 h à 10 h' }).waitFor();
  // Une nuit courte hors bornes (écrite par le serveur, ou les essais de la tablette) : affichée ramenée, pas
  // réécrite (la tablette ne dort pas trop longtemps).
  await s.db.doc(`families/${fid}`).update({ veille: { active: true, de: 15, a: 18 } });
  await julie.page.locator('#sleep-value', { hasText: 'Écran éteint de 19 h à 10 h' }).waitFor();
  await julie.page.waitForTimeout(1500);
  assert.deepStrictEqual((await g.lire(`families/${fid}`)).veille, { active: true, de: 15, a: 18 }, 'pas réécrite');
  // Coucher à 0 h 30 et réveil à midi, écran jamais éteint : affichés 23 h 30 et 10 h ; les listes ne sont jamais vides.
  await s.db.doc(`families/${fid}`).update({ veille: { active: false, de: 0, deMin: 30, a: 12 } });
  await julie.page.locator('#sleep-value', { hasText: 'reste allumé la nuit' }).waitFor();
  await modifier(julie, 'sleep-card');
  await julie.page.locator('#sleep-on').setChecked(true);
  assert.deepStrictEqual([await julie.page.inputValue('#sleep-from'), await julie.page.inputValue('#sleep-to')], ['19:0', '10:0']);
  await julie.page.selectOption('#sleep-to', '7:0');
  await enregistrer(julie, 'sleep-card');
  await g.toast(julie, 'Enregistré : écran éteint de 19 h à 7 h');
  assert.deepStrictEqual((await g.lire(`families/${fid}`)).veille, { active: true, de: 19, a: 7 });
  await julie.page.locator('#sleep-value', { hasText: 'Écran éteint de 19 h à 7 h' }).waitFor();
});

// Luminosité de l'écran le jour (Tanguy, 20/11) : families/{fid}.luminosite de 40 à 100, par un responsable ; la tablette
// la limite à 55 % le soir. Le serveur pose 70 % à la création de la famille (jamais par-dessus un réglage).
test('Luminosité : 70 % posé par le serveur, réglée à 85 % par Julie ; Paul (pas responsable) ne voit pas la carte', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await g.ouvrirTuile(julie, 'settings');
  await julie.page.locator('#luminosite-value', { hasText: '70 % le jour' }).waitFor();
  await julie.page.click('#luminosite-card .setting-modify');
  assert.strictEqual(await julie.page.locator('#luminosite').inputValue(), '70');
  assert.strictEqual(await julie.page.locator('#luminosite-val').innerText(), '70 %');
  await julie.page.locator('#luminosite').fill('85');
  assert.strictEqual(await julie.page.locator('#luminosite-val').innerText(), '85 %');
  await julie.page.click('#luminosite-card .setting-edit button[type=submit]');
  await g.toast(julie, 'Luminosité envoyée à la tablette : 85 %');
  await g.attendreBase(async () => (await g.lire(`families/${fid}`)).luminosite === 85, 'luminosite 85');
  await julie.page.locator('#luminosite-value', { hasText: '85 % le jour' }).waitFor();

  await g.retourAccueil(julie); // Réglages : plus de flèche, la barre du bas (23/11)
  await g.attendreVue(julie, 'view-home');
  const paul = await banc.telephone('Paul');
  await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });
  await g.ouvrirTuile(paul, 'settings');
  assert.strictEqual(await paul.page.locator('#luminosite-card').isVisible(), false);
});
