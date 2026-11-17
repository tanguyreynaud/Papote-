// Deux proches, changement de compte Google, champs texte, tout ce qui a l'air touchable, Wi-Fi, cartes à faire.
const test = require('node:test');
const banc = require('../app-famille/banc');
const g = require('../app-famille/gestes');
const o = require('./outil');
const c = require('./commun');
const { s, acteurs } = banc;
banc.brancher();

test('B. Famille à deux, propagation, champs, balayage, Wi-Fi, comptes Google', async () => {
  const t = await o.telephone('tanguy');
  t.page.setDefaultTimeout(8000);
  const email = 'tanguy.reynaud@gmail.com';
  const { fid, tab, code } = await c.familleParGoogle(t, { email, prenom: 'Tanguy', tel: '0608991612' });
  o.note(`CARTES responsable seul : ${JSON.stringify(await c.cartes(t))}`);
  await o.cap(t, 'accueil-depart', { plein: false });

  // --- Julie rejoint avec le code (lien e-mail) ---
  const j = await o.telephone('julie');
  j.page.setDefaultTimeout(8000);
  await c.etape(j, 'julie-rejoint', async () => {
    await g.seConnecter(j, 'julie@exemple.fr', `?code=${code}`);
    await g.attendreVue(j, 'view-moi');
    o.note(`Vos informations de Julie pré-remplies : prénom « ${await j.page.inputValue('#moi-prenom')} », tel « ${await j.page.inputValue('#moi-tel')} »`);
    await c.remplirMoi(j, { prenom: 'Julie', tel: '0611223344', genre: 'femme' });
    await g.attendreVue(j, 'view-join', 20000);
    await o.cap(j, 'rejoindre-code');
    await g.doubleAppui(j, '#form-join button[type=submit]');
    await g.attendreVue(j, 'view-pending');
    await o.cap(j, 'demande-envoyee', { plein: false });
    await t.page.waitForTimeout(1500);
    o.note(`CARTES chez Tanguy avec une demande : ${JSON.stringify(await c.cartes(t))}`);
    await o.cap(t, 'demande-recue', { plein: false });
    await t.page.locator('#pending-banner .join-card', { hasText: 'Julie' }).locator('.join-ok').click();
    await g.attendreVue(j, 'view-home', 20000);
    await c.passerDialogues(j, 'julie-entree', { capturer: true });
    await o.cap(j, 'julie-accueil');
    o.note(`CARTES chez Julie : ${JSON.stringify(await c.cartes(j))}`);
  });

  // --- Propagation des modifications de Tanguy chez Julie ---
  const chezJulie = async (motif, quoi) => {
    const d = Date.now();
    await c.accueil(j).catch(() => {});
    await g.ouvrirTuile(j, 'settings');
    for (;;) {
      const ok = await j.page.evaluate((m) => document.getElementById('members').innerText.includes(m), motif);
      if (ok) { o.note(`PROPAGATION ${quoi} chez Julie (Réglages > Membres) : ${(Date.now() - d) / 1000} s`); return; }
      if (Date.now() - d > 20000) {
        await j.page.reload(); await g.attendreVue(j, 'view-home', 20000); await g.ouvrirTuile(j, 'settings');
        const ok2 = await j.page.evaluate((m) => document.getElementById('members').innerText.includes(m), motif);
        o.note(`PROPAGATION ${quoi} chez Julie : PAS en direct en 20 s ; après actualisation : ${ok2 ? 'oui' : 'NON'}`);
        await o.cap(j, `membres-${quoi}`, { plein: false });
        return;
      }
      await j.page.waitForTimeout(300);
    }
  };
  await c.etape(t, 'prenom-propage', async () => {
    await c.profil(t);
    await t.page.click('#my-name-card .setting-modify');
    await t.page.fill('#my-name', 'Tanguy-Pierre');
    await t.page.click('#form-my-name button[type=submit]');
    await g.toast(t, 'Prénom enregistré');
    await chezJulie('Tanguy-Pierre', 'prénom');
    await o.cap(j, 'membres-apres-prenom');
  });
  await c.etape(t, 'photo-propage', async () => {
    await c.profil(t);
    await t.page.setInputFiles('#in-face-gallery', await g.photo({ largeur: 900, hauteur: 900, texte: 'VISAGE 2' }));
    await g.toast(t, 'Photo enregistrée');
    const face = (await g.lire(`families/${fid}/members/${t.uid}`)).face;
    const d = Date.now();
    await c.accueil(j).catch(() => {});
    await g.ouvrirTuile(j, 'settings');
    const vu = await j.page.waitForFunction((f) => [...document.querySelectorAll('#members img')].some((i) => i.src === f), face, { timeout: 20000 }).then(() => true).catch(() => false);
    o.note(`PROPAGATION photo de profil chez Julie : ${vu ? `${(Date.now() - d) / 1000} s` : 'PAS en 20 s'}`);
    await o.cap(j, 'membres-apres-photo', { plein: false });
  });
  await c.etape(t, 'tel-propage', async () => {
    await c.profil(t);
    await t.page.click('#my-tel-card .setting-modify');
    await t.page.fill('#my-tel', '0611223344');
    await t.page.click('#form-my-tel button[type=submit]');
    await t.page.waitForTimeout(1200);
    o.note(`numéro de Julie pris par Tanguy : « ${await t.page.locator('#my-tel-error').innerText().catch(() => '')} »`);
    await o.cap(t, 'tel-deja-pris', { plein: false });
    await t.page.fill('#my-tel', '0745917717');
    await t.page.click('#form-my-tel button[type=submit]');
    await t.page.waitForTimeout(1200);
    await chezJulie('07 45 91 77 17', 'numéro');
  });
  await c.etape(t, 'nom-tablette-propage', async () => {
    await c.accueil(t);
    await g.ouvrirTuile(t, 'settings');
    await t.page.click('#family-name-card .setting-modify');
    for (const v of ['12345', '   ', '🙂🙂', 'Mamie <b>Rose</b>', 'x'.repeat(60)]) {
      await t.page.fill('#family-name', v);
      await t.page.click('#family-name-card button[type=submit]');
      await t.page.waitForTimeout(900);
      const f = await g.lire(`families/${fid}`);
      o.note(`NOM DE LA TABLETTE saisi « ${v.slice(0, 20)} » -> base « ${f.name} » ; écran « ${await t.page.locator('#family-name-value').innerText()} »`);
      if (!(await t.page.locator('#form-family-name').isVisible())) await t.page.click('#family-name-card .setting-modify');
    }
    await o.cap(t, 'nom-tablette-saisies', { plein: false });
    await t.page.fill('#family-name', 'Mamie Jeanne');
    await t.page.click('#family-name-card button[type=submit]');
    await t.page.waitForTimeout(800);
    const d = Date.now();
    const vu = await j.page.waitForFunction(() => document.body.innerText.includes('Mamie Jeanne'), null, { timeout: 15000 }).then(() => true).catch(() => false);
    o.note(`PROPAGATION nom de la tablette chez Julie : ${vu ? `${(Date.now() - d) / 1000} s` : 'PAS en 15 s'}`);
  });
  await c.etape(t, 'prenom-saisies', async () => {
    await c.profil(t);
    await t.page.click('#my-name-card .setting-modify');
    for (const v of ['12', '   ', 'Jean-Paul', 'Zoë 2', 'a'.repeat(60)]) {
      await t.page.fill('#my-name', v);
      o.note(`PRÉNOM tapé « ${v.slice(0, 20)} » -> champ « ${await t.page.inputValue('#my-name')} »`);
      await t.page.click('#form-my-name button[type=submit]');
      await t.page.waitForTimeout(700);
      const m = await g.lire(`families/${fid}/members/${t.uid}`);
      o.note(`   -> base « ${m.name} »`);
      if (!(await t.page.locator('#form-my-name').isVisible())) await t.page.click('#my-name-card .setting-modify');
    }
    await o.cap(t, 'prenom-saisies', { plein: false });
    await t.page.fill('#my-name', 'Tanguy');
    await t.page.click('#form-my-name button[type=submit]');
  });
  await c.etape(t, 'meteo-saisies', async () => {
    await c.accueil(t);
    await g.ouvrirTuile(t, 'settings');
    if (!(await t.page.locator('#meteo-card').isVisible())) { o.note('carte météo absente'); return; }
    await t.page.click('#meteo-card .setting-modify');
    for (const v of ['abcde', '123', '99999', '07310']) {
      await t.page.fill('#meteo-cp', v);
      await t.page.click('#meteo-card button[type=submit]');
      await t.page.waitForTimeout(1200);
      o.note(`MÉTÉO cp « ${v} » -> champ « ${await t.page.inputValue('#meteo-cp')} », erreur « ${await t.page.locator('#meteo-error').innerText().catch(() => '')} »`);
    }
    await o.cap(t, 'meteo', { plein: false });
  });
  await c.etape(t, 'wifi', async () => {
    await c.accueil(t);
    await g.ouvrirTuile(t, 'settings');
    await s.db.doc(`families/${fid}/members/${tab.tabletUid}`).set({ wifi: { ssid: 'Livebox-1234', connecte: true } }, { merge: true }).catch(() => {});
    if (!(await t.page.locator('#wifi-card').isVisible())) { o.note('WIFI : carte « Wi-Fi de la tablette » absente des réglages'); return; }
    await o.cap(t, 'wifi-carte', { plein: false });
    await t.page.click('#wifi-modify');
    await t.page.waitForTimeout(1500);
    await o.cap(t, 'wifi-ouvert', { plein: false });
    o.note(`WIFI ouvert : ${(await t.page.evaluate(() => [...document.querySelectorAll('.sheet, #sheet-wifi')].filter((e) => !e.hidden).map((e) => e.innerText).join(' | '))).replace(/\s+/g, ' ').slice(0, 600)}`);
  });
  // --- Balayage : tout ce qui a l'air touchable ---
  const pages = {
    accueil: async () => { await t.page.goto(`${banc.origine}/`); await g.attendreVue(t, 'view-home', 20000); await c.passerDialogues(t, 'x'); },
    reglages: async () => { await t.page.goto(`${banc.origine}/`); await g.attendreVue(t, 'view-home', 20000); await c.passerDialogues(t, 'x'); await g.ouvrirTuile(t, 'settings'); },
    profil: async () => { await t.page.goto(`${banc.origine}/`); await g.attendreVue(t, 'view-home', 20000); await c.passerDialogues(t, 'x'); await c.profil(t); },
    photos: async () => { await t.page.goto(`${banc.origine}/`); await g.attendreVue(t, 'view-home', 20000); await c.passerDialogues(t, 'x'); await g.ouvrirTuile(t, 'photos'); },
    messages: async () => { await t.page.goto(`${banc.origine}/`); await g.attendreVue(t, 'view-home', 20000); await c.passerDialogues(t, 'x'); await g.ouvrirTuile(t, 'messages'); },
    agenda: async () => { await t.page.goto(`${banc.origine}/`); await g.attendreVue(t, 'view-home', 20000); await c.passerDialogues(t, 'x'); await g.ouvrirTuile(t, 'agenda'); },
    inviter: async () => { await t.page.goto(`${banc.origine}/`); await g.attendreVue(t, 'view-home', 20000); await c.passerDialogues(t, 'x'); await t.page.click('#btn-invite'); await g.attendreVue(t, 'view-invite'); },
    notifications: async () => { await t.page.goto(`${banc.origine}/`); await g.attendreVue(t, 'view-home', 20000); await c.passerDialogues(t, 'x'); await t.page.click('#btn-bell'); await g.attendreVue(t, 'view-notifs'); },
    support: async () => { await t.page.goto(`${banc.origine}/`); await g.attendreVue(t, 'view-home', 20000); await c.passerDialogues(t, 'x'); await c.profil(t); await t.page.click('#view-profile .aide-card'); await g.attendreVue(t, 'view-support'); },
  };
  for (const [nom, ouvrir] of Object.entries(pages)) {
    await c.etape(t, `balayage-${nom}`, async () => { await c.balayer(t, nom, ouvrir); await ouvrir(); await o.cap(t, `page-${nom}`); });
  }
  // --- Retirer la photo, actualiser ---
  await c.etape(t, 'retirer-photo', async () => {
    await pages.profil();
    await t.page.click('#face-remove');
    await g.repondre(t, 'Retirer');
    await t.page.waitForTimeout(800);
    const avant = (await g.lire(`families/${fid}/members/${t.uid}`)).face;
    await t.page.reload(); await g.attendreVue(t, 'view-home', 20000); await c.passerDialogues(t, 'x');
    await t.page.waitForTimeout(1500);
    const apres = (await g.lire(`families/${fid}/members/${t.uid}`)).face;
    o.note(`RETIRER PHOTO : base juste après = ${avant ? 'photo' : 'vide'} ; après actualisation = ${apres ? 'UNE PHOTO EST REVENUE' : 'vide'}`);
    o.note(`CARTES après retrait de la photo : ${JSON.stringify(await c.cartes(t))}`);
  });
  // --- Changement de compte Google sur le même téléphone, même numéro ---
  await c.etape(t, 'autre-compte-google', async () => {
    await c.profil(t);
    await t.page.locator('#view-profile [data-action="logout"]').click();
    await t.page.waitForTimeout(800);
    if (await t.page.locator('.dialog-back:not(.closing)').count()) { o.note(`déconnexion : ${await g.texteFenetre(t)}`); await g.repondre(t, 'Se déconnecter'); }
    await g.attendreVue(t, 'view-login', 15000);
    await o.cap(t, 'apres-deconnexion', { plein: false });
    await o.google(t, { email: 'tanguy.pro@gmail.com', nom: 'Tanguy Pro' });
    await t.page.waitForTimeout(3000);
    o.note(`2e compte : vue ${await g.vue(t)}`);
    await o.cap(t, '2e-compte-arrivee');
    if ((await g.vue(t)) === 'view-moi') {
      o.note(`2e compte : Vos informations pré-remplies avec celles du 1er compte ? prénom « ${await t.page.inputValue('#moi-prenom')} », tel « ${await t.page.inputValue('#moi-tel')} », photo ${await t.page.locator('#moi-photo').isVisible()}`);
      await c.remplirMoi(t, { prenom: 'Tanguy', tel: '0745917717', genre: 'homme' });
      await t.page.waitForTimeout(2500);
      o.note(`2e compte après Continuer : vue ${await g.vue(t)}`);
      await o.cap(t, '2e-compte-apres-infos');
    }
    if ((await g.vue(t)) === 'view-join') {
      await t.page.fill('#join-code', code);
      await t.page.click('#form-join button[type=submit]');
      await t.page.waitForTimeout(3000);
      o.note(`2e compte, code famille : vue ${await g.vue(t)} ; erreur « ${await t.page.locator('#join-error').innerText().catch(() => '')} »`);
      await o.cap(t, '2e-compte-code');
    }
    // retour au 1er compte
    await t.page.locator('main > section:not([hidden]) [data-action="logout"]').first().click().catch(() => {});
    await t.page.waitForTimeout(800);
    if (await t.page.locator('.dialog-back:not(.closing)').count()) await g.repondre(t, 'Se déconnecter');
    await g.attendreVue(t, 'view-login', 15000);
    await o.google(t, { email, nom: 'Tanguy' });
    await t.page.waitForTimeout(3500);
    o.note(`retour 1er compte : vue ${await g.vue(t)}`);
    await o.cap(t, 'retour-1er-compte');
  });
  o.ecrireJournal('B');
});
