// Balayage des retours (Tanguy, 27/11 : « t'as corrigé tous les boutons retour ? ») : chaque bouton qui ouvre une page
// ou une feuille, touché une fois puis deux fois de suite (double toucher), puis UN retour : on doit revenir d'où
// l'on vient. Avant, un double toucher empilait la page deux fois et le premier retour ne changeait rien.
const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');
banc.brancher();
const etat = (t) => t.page.evaluate(() => {
  const vues = [...document.querySelectorAll('section[id^=view-]')].filter((s) => !s.hidden).map((s) => s.id);
  const feuilles = ['viewer', 'sheet-post', 'sheet-reminder', 'sheet-wifi'].filter((i) => !document.getElementById(i).hidden);
  return vues.concat(feuilles).join('+') + ' n' + (history.state?.niveau || 0);
});
const ORIGINES = {
  home: async (t) => {},
  settings: async (t) => { await t.page.click('#nav-reglages'); await g.attendreVue(t, 'view-settings'); },
  famille: async (t) => { await t.page.click('#nav-reglages'); await g.attendreVue(t, 'view-settings'); await t.page.click('#view-settings [data-reglages-choix="famille"]'); },
  profile: async (t) => { await g.ouvrirProfil(t); },
  photos: async (t) => { await t.page.click('#tile-photo'); await g.attendreVue(t, 'view-photos'); },
  videos: async (t) => { await t.page.click('.tile.t-video'); await g.attendreVue(t, 'view-videos'); },
  agenda: async (t) => { await t.page.click('.tile.t-agenda'); await g.attendreVue(t, 'view-agenda'); },
  messages: async (t) => { await t.page.click('.tile.t-message'); await g.attendreVue(t, 'view-messages'); },
  support: async (t) => { await g.ouvrirProfil(t); await t.page.click('#view-profile .aide-pastille'); await g.attendreVue(t, 'view-support'); },
};
const CAS = [
  ['home', '#tile-photo'], ['home', '.tile.t-video'], ['home', '.tile.t-message'], ['home', '.tile.t-agenda'], ['home', '#tile-settings'],
  ['home', '#btn-invite'], ['home', '#btn-bell'], ['home', '.nav-item[data-page="photos"]'], ['home', '#nav-reglages'],
  ['settings', '#view-settings .aide-pastille'], ['settings', '#view-settings [data-reglages-choix="profil"]'], ['settings', '.nav-item[data-page="photos"]'],
  ['famille', '#btn-invite-famille'],
  ['profile', '#view-profile .aide-pastille'], ['profile', '#btn-abo-page'], ['profile', '#view-profile [data-reglages-choix="tablette"]'],
  ['photos', '#view-photos [data-add="photo"]'], ['videos', '#view-videos [data-add="video"]'], ['agenda', '#add-reminder'],

];
test('Retour, balayage : chaque page ou feuille ouverte (même en double toucher) se quitte en un seul retour', async () => {
  const ecarts = [];
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie.balayage@exemple.fr', prenom: 'Julie' });
  await julie.page.evaluate(() => { window.papoteChat = { ouvrir() {} }; });
  const maison = async () => { for (let i = 0; i < 6 && !(await etat(julie)).startsWith('view-home n0'); i++) { await julie.page.goBack(); await julie.page.waitForTimeout(500); } };
  for (const fois of [1, 2]) for (const [origine, sel] of CAS) {
    try {
      await maison();
      const e0 = await etat(julie);
      assert.ok(e0.startsWith('view-home n0'), `retour à l'accueil avant ${sel} : ${e0}`);
      await ORIGINES[origine](julie); await julie.page.waitForTimeout(400);
      const avant = await etat(julie);
      const vu = await julie.page.evaluate(([s, n]) => { const el = document.querySelector(s); if (!el || el.hidden || !el.getClientRects().length) return false; for (let i = 0; i < n; i++) el.click(); return true; }, [sel, fois]);
      if (!vu) { ecarts.push(`${origine} ${sel} : bouton introuvable`); continue; }
      await julie.page.waitForTimeout(900);
      const ouvert = await etat(julie);
      await julie.page.goBack(); await julie.page.waitForTimeout(900);
      const apres = await etat(julie);
      // Un onglet (Réglages, Photos, Profil) remplace l'onglet d'avant : retour = accueil.
      const ok = apres === avant || (apres === e0 && /view-(settings|photos|profile) n1/.test(ouvert) && /n1$/.test(avant));
      if (!ok) ecarts.push(`x${fois} ${origine} ${sel} : ${avant} -> ${ouvert} -> ${apres}`);
    } catch (e) { ecarts.push(`x${fois} ${origine} ${sel} : ${e.message.split('\n')[0]}`); }
  }
  assert.deepStrictEqual(ecarts, []);
});

// Tanguy, 27/11 : la liste de durée d'affichage ouvrait la liste standard du téléphone (hors style Papote), et sur le
// guide du premier lancement l'icône était décalée à gauche et « C'est parti » seul à droite.
test('Style Papote : aucune liste standard du téléphone visible ; une liste Papote change bien le réglage', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie.listes@exemple.fr', prenom: 'Julie' });
  await julie.page.click('#nav-reglages');
  await g.attendreVue(julie, 'view-settings');
  await julie.page.click('#duree-card .setting-modify');
  // Tous les <select> de la page sont habillés : invisibles, avec un bouton Papote juste après.
  const nus = await julie.page.evaluate(() => [...document.querySelectorAll('select')]
    .filter((s) => !s.classList.contains('liste-native') || !s.nextElementSibling?.classList.contains('liste-papote') || getComputedStyle(s).opacity !== '0')
    .map((s) => s.id || s.name));
  assert.deepStrictEqual(nus, []);
  // Le bouton montre la valeur, la liste s'ouvre juste sous lui (pas de fenêtre), et le choix s'enregistre comme avant.
  const bouton = julie.page.locator('#duree-card .liste-papote');
  assert.strictEqual((await bouton.innerText()).trim(), '5 minutes'); // 5 minutes par défaut depuis le 27/11
  await bouton.click();
  const menu = julie.page.locator('.liste-papote-menu');
  await menu.waitFor();
  assert.strictEqual(await julie.page.locator('.dialog-back:not(.closing)').count(), 0, 'aucune fenêtre');
  assert.deepStrictEqual(await menu.locator('.liste-papote-choix').allInnerTexts(), ['1 minute', '2 minutes', '3 minutes', '4 minutes', '5 minutes']);
  assert.strictEqual((await menu.locator('[aria-selected="true"]').innerText()).trim(), '5 minutes');
  const place = await julie.page.evaluate(() => {
    const b = document.querySelector('#duree-card .liste-papote').getBoundingClientRect();
    const m = document.querySelector('.liste-papote-menu').getBoundingClientRect();
    return { dessous: Math.round(m.top - b.bottom), gauche: Math.round(m.left - b.left), large: Math.round(m.width - b.width), bas: Math.round(window.innerHeight - m.bottom) };
  });
  assert.ok(place.dessous >= 0 && place.dessous <= 8 && place.gauche === 0 && place.large === 0 && place.bas >= 0, `liste collée sous son champ, dans l'écran : ${JSON.stringify(place)}`);
  await menu.getByRole('option', { name: '2 minutes' }).click();
  await menu.waitFor({ state: 'detached' });
  assert.strictEqual((await bouton.innerText()).trim(), '2 minutes');
  await julie.page.click('#duree-card button[type=submit]');
  await g.attendreBase(async () => (await g.lire(`families/${fid}`)).options?.dureeAffichage === 2, 'durée de 2 minutes enregistrée');
  // Toucher à côté referme sans rien changer ; toucher le bouton une 2e fois aussi.
  await julie.page.click('#duree-card .setting-modify');
  await bouton.click();
  await menu.waitFor();
  await julie.page.locator('#duree-card h2').click();
  await menu.waitFor({ state: 'detached' });
  await bouton.click();
  await menu.waitFor();
  await bouton.click();
  await menu.waitFor({ state: 'detached' });
  assert.strictEqual((await bouton.innerText()).trim(), '2 minutes');
});
