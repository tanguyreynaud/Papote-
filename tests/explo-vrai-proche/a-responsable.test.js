// Parcours réel d'un responsable (comme Tanguy) : commande, Google, Vos informations, famille, chaque page,
// Mes informations relues après actualisation, changement de compte Google avec le même numéro.
const test = require('node:test');
const banc = require('../app-famille/banc');
const g = require('../app-famille/gestes');
const o = require('./outil');
const c = require('./commun');
const { s, acteurs } = banc;
banc.brancher();

async function etape(t, nom, fn) {
  try { await fn(); } catch (e) {
    o.note(`ÉCHEC « ${nom} » : ${String(e.message).split('\n')[0]}`);
    await o.cap(t, `ECHEC-${nom}`).catch(() => {});
  }
}
async function texte(t, sel) { return t.page.locator(sel).first().innerText().catch(() => '(absent)'); }
async function tousLesDialogues(t, tag) {
  // capture et ferme ce qui s'ouvre (intro, guide) en passant par chaque étape
  for (let i = 0; i < 12; i++) {
    await t.page.waitForTimeout(500);
    if (await t.page.locator('.intro-back .intro-next').count()) {
      await o.cap(t, `${tag}-intro-${i}`, { plein: false });
      const lib = await t.page.locator('.intro-back .intro-next').innerText();
      if (/Inviter la famille/.test(lib)) { await t.page.click('.intro-back .intro-prev'); continue; }
      await t.page.click('.intro-back .intro-next'); continue;
    }
    if (await t.page.locator('.guide-back .guide-skip').count()) {
      await o.cap(t, `${tag}-guide-${i}`, { plein: false });
      const suiv = t.page.locator('.guide-back button.primary');
      if (await suiv.count() && await suiv.isVisible()) { await suiv.click(); continue; }
      await t.page.click('.guide-back .guide-skip'); continue;
    }
    if (await t.page.locator('.dialog-back:not(.closing) .dialog').count()) {
      await o.cap(t, `${tag}-fenetre-${i}`, { plein: false });
      o.note(`fenêtre : ${await g.texteFenetre(t)}`);
      return;
    }
    return;
  }
}

test('A. Responsable : de la commande à tous les écrans', async () => {
  const t = await o.telephone('tanguy');
  t.page.setDefaultTimeout(8000);
  const email = 'tanguy.reynaud@gmail.com';
  const tab = await g.tabletteAllumee({ commande: { email } });
  const { fid } = await g.lire(`pairings/${tab.code}`);
  const fam = await g.lire(`families/${fid}`);
  o.note(`famille préparée ${fid}, code ${fam.code}`);
  await etape(t, 'ouverture-lien-commande', async () => {
    await g.ouvrir(t, `?code=${fam.code}`);
    await g.attendreVue(t, 'view-login');
    await o.cap(t, 'connexion');
  });
  await etape(t, 'google', async () => {
    await o.google(t, { email, nom: 'Tanguy Reynaud' });
    await g.attendreVue(t, 'view-moi');
    await o.cap(t, 'vos-informations-vide');
  });
  await etape(t, 'vos-informations-continuer-vide', async () => {
    await t.page.click('#form-moi button[type=submit]');
    await o.cap(t, 'vos-informations-continuer-vide');
    o.note(`erreur affichée : ${await texte(t, '#moi-error')}`);
  });
  await etape(t, 'vos-informations-tel-faux', async () => {
    await t.page.fill('#moi-prenom', 'Tanguy');
    await t.page.click('#form-moi .genre-btn[data-genre="homme"]');
    await t.page.fill('#moi-tel', '0412345678');
    await t.page.click('#form-moi button[type=submit]');
    await o.cap(t, 'vos-informations-tel-fixe');
    o.note(`erreur tel fixe : ${await texte(t, '#moi-error')}`);
  });
  await etape(t, 'vos-informations-rempli', async () => {
    await t.page.fill('#moi-tel', '06 08 99 16 12');
    o.note(`collé « 06 08 99 16 12 » -> champ « ${await t.page.inputValue('#moi-tel')} »`);
    await t.page.fill('#moi-tel', '+33 6 08 99 16 12');
    o.note(`collé « +33 6 08 99 16 12 » -> champ « ${await t.page.inputValue('#moi-tel')} »`);
    await t.page.fill('#moi-tel', '');
    await t.page.type('#moi-tel', '06 08 99 16 12');
    o.note(`tapé « 06 08 99 16 12 » -> champ « ${await t.page.inputValue('#moi-tel')} »`);
    await t.page.setInputFiles('#moi-in', await g.photo({ largeur: 900, hauteur: 1200, texte: 'Tanguy' }));
    await t.page.waitForTimeout(800);
    await t.page.selectOption('#moi-jour', '22');
    await t.page.selectOption('#moi-mois', '3');
    await t.page.selectOption('#moi-annee', '1995');
    await o.cap(t, 'vos-informations-rempli');
    await t.page.click('#form-moi button[type=submit]');
    await t.page.waitForTimeout(1500);
    await o.cap(t, 'apres-vos-informations');
    o.note(`vue après Vos informations : ${await g.vue(t)}`);
  });
  await etape(t, 'invitation', async () => {
    await g.attendreVue(t, 'view-invited', 20000);
    await t.page.locator('#invitations form').first().waitFor();
    await o.cap(t, 'invitation');
    await t.page.locator('#invitations form button[type=submit]').first().click();
    await g.attendreVue(t, 'view-home', 30000);
    await tousLesDialogues(t, 'entree');
    await o.cap(t, 'accueil-nom-a-donner');
  });
  await etape(t, 'nom-vide', async () => {
    await t.page.click('#nom-prepare-btn');
    await o.cap(t, 'nom-vide');
    o.note(`nom vide : ${await texte(t, '#nom-prepare-error')}`);
  });
  await etape(t, 'nom', async () => {
    await t.page.fill('#nom-prepare-input', 'Mamie Rose');
    await t.page.click('#nom-prepare-btn');
    await t.page.waitForTimeout(1500);
    await tousLesDialogues(t, 'apres-nom');
    await o.cap(t, 'accueil-tablette-en-route');
  });
  await etape(t, 'tablette-arrive', async () => {
    await acteurs.entrerDansLaFamille(tab);
    await t.page.waitForTimeout(2500);
    await tousLesDialogues(t, 'tablette-arrivee');
    await o.cap(t, 'accueil-tablette-arrivee');
  });
  // Profil (Mes informations)
  const lireProfil = async (tag) => {
    await c.profil(t);
    await t.page.waitForTimeout(800);
    const p = await t.page.evaluate(() => ({
      prenom: document.getElementById('my-name-value').innerText,
      tel: document.getElementById('my-tel-value').innerText,
      genre: document.getElementById('my-genre-value').innerText,
      photo: !document.getElementById('face-img').hidden && document.getElementById('face-img').naturalWidth > 0,
      photoSrc: (document.getElementById('face-img').src || '').slice(0, 60),
      compte: document.getElementById('account-email').innerText,
    }));
    o.note(`PROFIL ${tag} : ${JSON.stringify(p)}`);
    await o.cap(t, `profil-${tag}`);
    return p;
  };
  await etape(t, 'profil-apres-inscription', async () => {
    const p = await lireProfil('apres-inscription');
    const m = await g.lire(`families/${fid}/members/${(await banc.admin.auth().getUserByEmail(email)).uid}`);
    o.note(`BASE membre : ${JSON.stringify({ name: m.name, tel: m.tel || m.telephone, genre: m.genre, photo: m.photo || m.face || m.photoUrl || null, anniv: m.birthday || m.anniversaire || null, keys: Object.keys(m) })}`);
  });
  await etape(t, 'profil-modifier-prenom', async () => {
    await t.page.click('#my-name-card .setting-modify');
    await o.cap(t, 'profil-prenom-ouvert', { plein: false });
    await t.page.fill('#my-name', 'Tanguy R.');
    await t.page.click('#form-my-name button[type=submit]');
    await t.page.waitForTimeout(800);
    await o.cap(t, 'profil-prenom-enregistre', { plein: false });
  });
  await etape(t, 'profil-modifier-tel', async () => {
    await t.page.click('#my-tel-card .setting-modify');
    await t.page.fill('#my-tel', '0745917717');
    await t.page.click('#form-my-tel button[type=submit]');
    await t.page.waitForTimeout(800);
    await o.cap(t, 'profil-tel-enregistre', { plein: false });
  });
  await etape(t, 'profil-modifier-genre', async () => {
    await t.page.click('#my-genre-card .setting-modify');
    await t.page.check('input[name="my-genre"][value="femme"]');
    await t.page.click('#form-my-genre button[type=submit]');
    await t.page.waitForTimeout(800);
  });
  await etape(t, 'profil-photo-galerie', async () => {
    await t.page.setInputFiles('#in-face-gallery', await g.photo({ largeur: 1000, hauteur: 1000, texte: 'NOUVELLE' }));
    await t.page.waitForTimeout(400);
    await o.cap(t, 'profil-photo-choisie', { plein: false });
    await t.page.waitForTimeout(3000);
    await o.cap(t, 'profil-photo-apres-3s', { plein: false });
  });
  await etape(t, 'profil-actualiser', async () => {
    await t.page.reload();
    await g.attendreVue(t, 'view-home', 30000);
    await tousLesDialogues(t, 'reload');
    await lireProfil('apres-actualiser');
  });
  await etape(t, 'profil-retirer-photo', async () => {
    await t.page.click('#face-remove');
    await t.page.waitForTimeout(600);
    await o.cap(t, 'profil-retirer-photo', { plein: false });
    if (await t.page.locator('.dialog-back:not(.closing)').count()) { o.note(`retirer : ${await g.texteFenetre(t)}`); await g.repondre(t, 'Retirer').catch(() => g.repondre(t, 'Oui')); }
    await t.page.reload();
    await g.attendreVue(t, 'view-home', 30000);
    await lireProfil('apres-retrait-actualiser');
  });
  await etape(t, 'theme-sombre', async () => {
    await t.page.click('[data-theme-choice="dark"]');
    await t.page.waitForTimeout(500);
    await o.cap(t, 'profil-sombre');
    await c.accueil(t);
    await o.cap(t, 'accueil-sombre');
    await t.page.click('.nav-item[data-tab="profile"]');
    await t.page.click('[data-theme-choice="light"]');
  });
  // Toutes les pages
  await etape(t, 'pages', async () => {
    await c.accueil(t);
    await o.cap(t, 'accueil');
    for (const p of ['photos', 'videos', 'messages', 'agenda', 'settings']) {
      await etape(t, `page-${p}`, async () => {
        await g.ouvrirTuile(t, p);
        await o.cap(t, `page-${p}`);
        await c.accueil(t);
      });
    }
    await t.page.click('#btn-invite');
    await t.page.waitForTimeout(800);
    await o.cap(t, 'page-inviter');
    await c.accueil(t);
    await t.page.click('#btn-bell');
    await t.page.waitForTimeout(800);
    await o.cap(t, 'page-notifications');
    await c.accueil(t);
  });
  await etape(t, 'envoyer-photo', async () => {
    await t.page.click('#photo-nudge');
    await t.page.waitForTimeout(800);
    await o.cap(t, 'photo-nudge-touche', { plein: false });
    if (!(await t.page.locator('#sheet-post').isVisible())) { await g.ouvrirTuile(t, 'photos'); await t.page.click('.fab[data-add="photo"]'); }
    await t.page.locator('#sheet-post').waitFor({ state: 'visible' });
    await o.cap(t, 'feuille-envoi', { plein: false });
    await t.page.setInputFiles('#in-photo-gallery', await g.photo({ texte: 'Bisous' }));
    await t.page.waitForTimeout(800);
    await o.cap(t, 'feuille-envoi-photo-choisie', { plein: false });
    await t.page.fill('#post-text', 'Coucou Mamie');
    await g.doubleAppui(t, '#btn-send');
    await t.page.waitForTimeout(300);
    await o.cap(t, 'envoi-en-cours', { plein: false });
    await g.toast(t, 'Envoyé');
    await o.cap(t, 'envoye', { plein: false });
    await s.calme();
    const posts = await g.liste(`families/${fid}/posts`);
    o.note(`posts après double appui sur Envoyer : ${posts.filter((p) => p.text === 'Coucou Mamie').length}`);
    await t.page.waitForTimeout(800);
    await o.cap(t, 'photos-apres-envoi');
  });
  await etape(t, 'envoyer-video', async () => {
    await c.accueil(t);
    await g.ouvrirTuile(t, 'videos');
    await t.page.click('.fab[data-add="video"]');
    await t.page.waitForTimeout(800);
    await o.cap(t, 'video-feuille', { plein: false });
    const inp = await t.page.$('#in-video-gallery') ? '#in-video-gallery' : 'input[type=file][accept*=video]';
    await t.page.setInputFiles(inp, await g.video({ secondes: 2 }));
    await t.page.waitForTimeout(1500);
    await o.cap(t, 'video-choisie', { plein: false });
    await t.page.click('#btn-send');
    await g.toast(t, 'Envoyé');
    await t.page.waitForTimeout(1500);
    await o.cap(t, 'videos-apres-envoi');
  });
  await etape(t, 'message', async () => {
    await c.accueil(t);
    await g.ouvrirTuile(t, 'messages');
    await t.page.fill('#message-text', 'Je viens dimanche');
    await t.page.click('#btn-message');
    await t.page.waitForTimeout(1000);
    await o.cap(t, 'message-envoye');
    await g.doubleAppui(t, '.quick-msg');
    await t.page.waitForTimeout(1500);
    await s.calme();
    const n = (await g.liste(`families/${fid}/posts`)).filter((p) => p.text === 'Bonne journée').length;
    o.note(`message rapide double appui : ${n} message(s)`);
    await o.cap(t, 'message-rapide-double');
  });
  await etape(t, 'agenda', async () => {
    await c.accueil(t);
    await g.ouvrirTuile(t, 'agenda');
    await t.page.click('#add-reminder');
    await t.page.waitForTimeout(800);
    await o.cap(t, 'agenda-ajout', { plein: false });
    await t.page.keyboard.press('Escape');
    const ferme = t.page.locator('.sheet:not([hidden]) .sheet-close, .sheet:not([hidden]) button[aria-label=Fermer]');
    if (await ferme.count()) await ferme.first().click();
    await t.page.waitForTimeout(500);
    await o.cap(t, 'agenda-apres-fermer', { plein: false });
  });
  await etape(t, 'appel-video', async () => {
    await t.page.goto(`${banc.origine}/`);
    await g.attendreVue(t, 'view-home', 30000);
    await t.page.click('#tile-call');
    await t.page.waitForTimeout(1500);
    await o.cap(t, 'appel-video-1', { plein: false });
    await t.page.waitForTimeout(4000);
    await o.cap(t, 'appel-video-5s', { plein: false });
    const fin = t.page.locator('#call-hangup, .call-hangup, button:has-text("Raccrocher")').filter({ visible: true });
    if (await fin.count()) await fin.first().click();
    await t.page.waitForTimeout(1500);
    await o.cap(t, 'appel-video-raccroche', { plein: false });
  });
  await etape(t, 'tablette-appelle', async () => {
    await g.attendreVue(t, 'view-home', 15000).catch(() => {});
    const uid = (await banc.admin.auth().getUserByEmail(email)).uid;
    await acteurs.appelerDepuisLaTablette(tab, { vers: { uid, prenom: 'Tanguy' } });
    await t.page.waitForTimeout(2500);
    await o.cap(t, 'mamie-appelle', { plein: false });
  });
  await etape(t, 'reglages-detail', async () => {
    await t.page.goto(`${banc.origine}/`);
    await g.attendreVue(t, 'view-home', 30000);
    await g.ouvrirTuile(t, 'settings');
    const details = await t.page.locator('#view-settings .card').count();
    o.note(`réglages : ${details} cartes`);
    await o.cap(t, 'reglages-complet');
  });
  await etape(t, 'abonnement', async () => {
    await c.accueil(t);
    await t.page.click('.nav-item[data-tab="profile"]');
    await t.page.waitForTimeout(800);
    const b = t.page.locator('#btn-abo-page').filter({ visible: true });
    if (await b.count()) { await b.click(); await t.page.waitForTimeout(1200); await o.cap(t, 'page-abonnement'); }
    const r = t.page.locator('button:has-text("Résilier")').filter({ visible: true });
    if (await r.count()) {
      await r.first().click(); await t.page.waitForTimeout(800); await o.cap(t, 'resilier-1', { plein: false });
    } else o.note('pas de bouton Résilier visible');
  });
  o.ecrireJournal('A');
});
