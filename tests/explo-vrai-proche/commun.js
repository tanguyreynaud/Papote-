// Gestes communs du testeur « vrai proche ».
const banc = require('../app-famille/banc');
const g = require('../app-famille/gestes');
const o = require('./outil');
const { s, acteurs } = banc;

async function etape(t, nom, fn) {
  try { await fn(); return true; } catch (e) {
    o.note(`ÉCHEC « ${nom} » : ${String(e.message).split('\n')[0].slice(0, 300)}`);
    await o.cap(t, `ECHEC-${nom}`, { plein: false }).catch(() => {});
    return false;
  }
}
/** Ferme intro / guide en capturant chaque étape (sauf si muet). */
async function passerDialogues(t, tag, { capturer = false } = {}) {
  for (let i = 0; i < 14; i++) {
    await t.page.waitForTimeout(400);
    if (await t.page.locator('.intro-back .intro-next').count()) {
      if (capturer) await o.cap(t, `${tag}-intro-${i}`, { plein: false });
      const lib = await t.page.locator('.intro-back .intro-next').innerText();
      await t.page.click(/Inviter la famille/.test(lib) ? '.intro-back .intro-prev' : '.intro-back .intro-next');
      continue;
    }
    if (await t.page.locator('.guide-back .guide-skip').count()) {
      if (capturer) await o.cap(t, `${tag}-guide-${i}`, { plein: false });
      await t.page.click('.guide-back .guide-skip');
      continue;
    }
    return;
  }
}
/** Écran de retour : flèche de la page, sinon Accueil de la barre. */
async function accueil(t) {
  const fl = t.page.locator('main > section:not([hidden]) .page-head .back').filter({ visible: true });
  if (await fl.count()) await fl.first().click();
  else await t.page.click('.nav-item[data-tab="home"]');
  await g.attendreVue(t, 'view-home');
}
async function profil(t) {
  if (!(await t.page.locator('.nav-item[data-tab="profile"]').isVisible())) await accueil(t);
  await t.page.click('.nav-item[data-tab="profile"]');
  await g.attendreVue(t, 'view-profile');
}
/** Cartes à faire visibles sur l'accueil, dans l'ordre. */
async function cartes(t) {
  return t.page.evaluate(() => [...document.querySelectorAll('#badges [data-badge], #photo-nudge, #nom-prepare, #tablette-en-route, #abo-banner, #pending-banner')]
    .filter((e) => !e.hidden && e.offsetParent !== null).map((e) => `${e.id}: ${e.innerText.replace(/\s+/g, ' ').slice(0, 90)}`));
}
/** Famille prête par le vrai chemin (commande, lien ?code, Google, Vos informations, invitation, nom, tablette). */
async function familleParGoogle(t, { email, prenom, tel, nom = 'Mamie Rose', genre = 'homme' }) {
  const tab = await g.tabletteAllumee({ commande: { email } });
  const { fid } = await g.lire(`pairings/${tab.code}`);
  const fam = await g.lire(`families/${fid}`);
  await g.ouvrir(t, `?code=${fam.code}`);
  await g.attendreVue(t, 'view-login');
  await o.google(t, { email, nom: prenom });
  await g.attendreVue(t, 'view-moi');
  await remplirMoi(t, { prenom, tel, genre });
  await g.attendreVue(t, 'view-invited', 20000);
  await t.page.locator('#invitations form button[type=submit]').first().click();
  await g.attendreVue(t, 'view-home', 30000);
  await passerDialogues(t, 'x');
  await t.page.fill('#nom-prepare-input', nom);
  await t.page.click('#nom-prepare-btn');
  await t.page.waitForTimeout(1200);
  await passerDialogues(t, 'x');
  await acteurs.entrerDansLaFamille(tab);
  await t.page.waitForTimeout(1500);
  await passerDialogues(t, 'x');
  t.uid = (await banc.admin.auth().getUserByEmail(email)).uid;
  return { fid, tab, code: fam.code };
}
async function remplirMoi(t, { prenom, tel, genre = 'homme', texte }) {
  await t.page.fill('#moi-prenom', prenom);
  await t.page.click(`#form-moi .genre-btn[data-genre="${genre}"]`);
  if (!(await t.page.locator('#moi-photo').isVisible())) {
    await t.page.setInputFiles('#moi-in', await g.photo({ largeur: 800, hauteur: 800, texte: texte || prenom }));
    await t.page.locator('#moi-photo').waitFor({ state: 'visible' });
  }
  await t.page.fill('#moi-tel', tel);
  await t.page.selectOption('#moi-jour', '12');
  await t.page.selectOption('#moi-mois', '5');
  await t.page.selectOption('#moi-annee', '1985');
  await t.page.click('#form-moi button[type=submit]');
  t.prenom = prenom;
}

/**
 * Tout ce qui a l'air touchable sur l'écran ouvert par ouvrirPage() : touché un par un ; ce qui ne change rien
 * de visible dans la seconde est noté. Les liens tel:/intent:/mailto: ne sont pas suivis (notés à part).
 */
async function balayer(t, nomPage, ouvrirPage) {
  await ouvrirPage();
  const etat = () => t.page.evaluate(() => {
    const vue = [...document.querySelectorAll('main > section, #loading')].filter((e) => !e.hidden).map((e) => e.id).join();
    const vis = (e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed';
    const fen = [...document.querySelectorAll('.dialog-back, .sheet, .intro-back, .guide-back, .remote-panel, .setting-edit, details')].filter(vis)
      .map((e) => `${e.className}${e.open ? ':open' : ''}`).join('|');
    const coches = [...document.querySelectorAll('input[type=checkbox], input[type=radio]')].map((i) => (i.checked ? 1 : 0)).join('');
    const toast = document.getElementById('toast');
    return JSON.stringify({ vue, fen, coches, url: location.href, txt: document.body.innerText.length, toast: toast && !toast.hidden && toast.innerText, y: Math.round(scrollY), focus: document.activeElement && document.activeElement.id, pressed: [...document.querySelectorAll('[aria-pressed],[aria-checked],[aria-expanded]')].map((e) => e.getAttribute('aria-pressed') + e.getAttribute('aria-checked') + e.getAttribute('aria-expanded')).join('') });
  });
  const liste = await t.page.evaluate(() => {
    const vue = [...document.querySelectorAll('main > section')].find((e) => !e.hidden);
    const zone = [...vue.querySelectorAll('*')];
    const ok = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 && e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden'; };
    const touchable = (e) => ['BUTTON', 'A', 'SUMMARY', 'SELECT', 'LABEL'].includes(e.tagName)
      || (e.tagName === 'INPUT' && ['checkbox', 'radio', 'range', 'file'].includes(e.type))
      || /^(button|switch|radio|tab|link|checkbox)$/.test(e.getAttribute('role') || '')
      || getComputedStyle(e).cursor === 'pointer';
    const res = [];
    let i = 0;
    for (const e of zone) {
      if (!ok(e) || !touchable(e)) continue;
      // un enfant d'un élément déjà retenu (texte d'un bouton) : ignoré
      if (res.some((r) => r.el.contains(e))) continue;
      e.dataset.sonde = String(i++);
      res.push({ el: e, id: e.dataset.sonde, quoi: `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''} « ${(e.innerText || e.getAttribute('aria-label') || e.value || '').replace(/\s+/g, ' ').trim().slice(0, 50)} »${e.disabled ? ' [désactivé]' : ''}`, href: e.getAttribute('href') || '' });
    }
    return res.map(({ id, quoi, href }) => ({ id, quoi, href }));
  });
  o.note(`BALAYAGE ${nomPage} : ${liste.length} éléments touchables`);
  const muets = [];
  for (const c of liste) {
    if (/^(tel:|intent:|mailto:|sms:)/.test(c.href)) { o.note(`  lien ${c.quoi} -> ${c.href.slice(0, 40)} (non suivi)`); continue; }
    const sel = `[data-sonde="${c.id}"]`;
    if (!(await t.page.locator(sel).count())) { await ouvrirPage(); await renumeroter(t); }
    const el = t.page.locator(sel).first();
    if (!(await el.count()) || !(await el.isVisible().catch(() => false))) continue;
    const avant = await etat();
    try { await el.scrollIntoViewIfNeeded({ timeout: 1500 }); await el.click({ timeout: 1500, force: false }); } catch (e) {
      muets.push(`${c.quoi} (impossible à toucher : ${String(e.message).split('\n')[0].slice(0, 80)})`); continue;
    }
    await t.page.waitForTimeout(700);
    const apres = await etat();
    if (avant === apres) muets.push(c.quoi);
    else { await ouvrirPage(); await renumeroter(t); }
  }
  o.note(`  SANS EFFET VISIBLE sur ${nomPage} : ${muets.length ? muets.join(' ; ') : 'aucun'}`);
  return muets;
  async function renumeroter() {
    await t.page.evaluate(() => {
      const vue = [...document.querySelectorAll('main > section')].find((e) => !e.hidden);
      const zone = [...vue.querySelectorAll('*')];
      const ok = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 && e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden'; };
      const touchable = (e) => ['BUTTON', 'A', 'SUMMARY', 'SELECT', 'LABEL'].includes(e.tagName)
        || (e.tagName === 'INPUT' && ['checkbox', 'radio', 'range', 'file'].includes(e.type))
        || /^(button|switch|radio|tab|link|checkbox)$/.test(e.getAttribute('role') || '')
        || getComputedStyle(e).cursor === 'pointer';
      const res = [];
      let i = 0;
      for (const e of zone) {
        if (!ok(e) || !touchable(e)) continue;
        if (res.some((r) => r.contains(e))) continue;
        e.dataset.sonde = String(i++);
        res.push(e);
      }
    });
  }
}
module.exports = { etape, passerDialogues, accueil, profil, cartes, familleParGoogle, remplirMoi, balayer };
