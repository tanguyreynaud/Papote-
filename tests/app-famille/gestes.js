// Les gestes d'un proche dans l'app famille, faits dans la vraie page (clics, saisie, fichiers choisis),
// et les fichiers de test (photos, vidéo) fabriqués par le navigateur.

const assert = require('node:assert');
const banc = require('./banc');

const { s, acteurs } = banc;

// ---------- Écrans ----------

/** L'écran affiché (id de la section visible : view-home, view-login…). */
async function vue(t) {
  return t.page.evaluate(() => [...document.querySelectorAll('main > section, #loading')]
    .filter((e) => !e.hidden).map((e) => e.id).join(','));
}

/** Attend que l'écran voulu soit affiché (et lui seul). */
async function attendreVue(t, id, delai = 20_000) {
  try {
    await t.page.waitForFunction((v) => {
      const vues = [...document.querySelectorAll('main > section, #loading')].filter((e) => !e.hidden).map((e) => e.id);
      return vues.length === 1 && vues[0] === v;
    }, id, { timeout: delai });
  } catch (e) {
    throw new Error(`[${t.nom}] écran ${id} attendu, affiché : ${await vue(t)}\n${t.console.slice(-15).join('\n')}`);
  }
  await verifierLargeur(t, id);
}

/**
 * Aucun écran plus large que le téléphone (bug du 27/10 : la page défilait de côté et le téléphone la dézoomait).
 * Contrôlé à chaque écran atteint ; un débordement est une erreur du scénario.
 */
async function verifierLargeur(t, ecran) {
  const d = await t.page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= W) return null;
    const fautif = [...document.querySelectorAll('body *')].find((el) => el.getBoundingClientRect().right > W + 1 && el.offsetParent !== null);
    return { large: document.documentElement.scrollWidth, W, fautif: fautif ? `${fautif.tagName.toLowerCase()}${fautif.id ? '#' + fautif.id : ''}${typeof fautif.className === 'string' && fautif.className ? '.' + fautif.className.trim().split(/\s+/).join('.') : ''}` : '?' };
  }).catch(() => null);
  if (d) t.erreurs.push(`[${t.nom}] écran ${ecran} plus large que le téléphone : ${d.large} px pour ${d.W} px (${d.fautif})`);
}

const visible = (t, selecteur) => t.page.locator(selecteur).filter({ visible: true });

/** Touche le bouton « OK », « Supprimer »… d'une fenêtre de l'app (ui.js). */
async function repondre(t, libelle) {
  const bouton = t.page.locator('.dialog-back:not(.closing) .dialog button', { hasText: libelle }).first();
  await bouton.click();
  await t.page.locator('.dialog-back').first().waitFor({ state: 'detached' }).catch(() => {});
}

/** Texte de la fenêtre ouverte (notice, confirmation). */
async function texteFenetre(t) {
  const d = t.page.locator('.dialog-back:not(.closing) .dialog').first();
  await d.waitFor();
  return d.innerText();
}

// ---------- Fichiers ----------

let atelier = null; // une page qui fabrique les photos et vidéos de test

async function pageAtelier() {
  if (!atelier || atelier.page.isClosed()) atelier = await banc.telephone('atelier');
  // Pas d'erreur attendue ici : l'atelier n'est pas l'app.
  return atelier.page;
}

/** Une photo JPEG (largeur x hauteur), avec un dégradé et un texte pour la reconnaître. */
async function photo({ largeur = 1200, hauteur = 900, texte = 'Photo', nom = 'photo.jpg' } = {}) {
  const page = await pageAtelier();
  const base64 = await page.evaluate(async ({ largeur: l, hauteur: h, texte: tx }) => {
    const c = document.createElement('canvas');
    c.width = l; c.height = h;
    const g = c.getContext('2d');
    const d = g.createLinearGradient(0, 0, l, h);
    d.addColorStop(0, '#4f46e5'); d.addColorStop(1, '#fdfaf5');
    g.fillStyle = d; g.fillRect(0, 0, l, h);
    g.fillStyle = '#111'; g.font = `${Math.round(h / 8)}px sans-serif`; g.fillText(tx, l / 10, h / 2);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (const b of buf) bin += String.fromCharCode(b);
    return btoa(bin);
  }, { largeur, hauteur, texte });
  return { name: nom, mimeType: 'image/jpeg', buffer: Buffer.from(base64, 'base64') };
}

/** Une petite vidéo WebM (secondes), filmée par le navigateur. */
async function video({ secondes = 2, nom = 'video.webm' } = {}) {
  const page = await pageAtelier();
  const base64 = await page.evaluate(async (sec) => {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 240;
    const g = c.getContext('2d');
    const flux = c.captureStream(25);
    const rec = new MediaRecorder(flux, { mimeType: 'video/webm' });
    const parts = [];
    rec.ondataavailable = (e) => parts.push(e.data);
    const fini = new Promise((r) => { rec.onstop = r; });
    rec.start(100);
    const debut = performance.now();
    await new Promise((r) => {
      const dessiner = () => {
        const t = (performance.now() - debut) / 1000;
        g.fillStyle = `hsl(${(t * 120) % 360} 70% 50%)`; g.fillRect(0, 0, 320, 240);
        g.fillStyle = '#fff'; g.font = '40px sans-serif'; g.fillText(t.toFixed(1), 100, 130);
        if (t >= sec) r(); else setTimeout(dessiner, 40);
      };
      dessiner();
    });
    rec.stop();
    await fini;
    const buf = new Uint8Array(await new Blob(parts, { type: 'video/webm' }).arrayBuffer());
    let bin = '';
    for (const b of buf) bin += String.fromCharCode(b);
    return btoa(bin);
  }, secondes);
  return { name: nom, mimeType: 'video/webm', buffer: Buffer.from(base64, 'base64') };
}

// ---------- Connexion ----------

async function codesEmail(email) {
  const au = banc.hote('FIREBASE_AUTH_EMULATOR_HOST');
  const r = await fetch(`http://${au.h}:${au.p}/emulator/v1/projects/${banc.PROJET}/oobCodes`);
  const { oobCodes = [] } = await r.json();
  return oobCodes.filter((c) => c.email === email && c.requestType === 'EMAIL_SIGNIN');
}

/** Ouvre l'app (adresse + paramètres éventuels, ex. « ?code=ABCD1234 »). */
async function ouvrir(t, suite = '') {
  await t.page.goto(`${banc.origine}/${suite}`);
}

/** Connexion par lien e-mail, comme un proche : adresse tapée, lien reçu, lien touché. */
async function seConnecter(t, email, suite = '') {
  if (!t.page.url().startsWith(banc.origine)) await ouvrir(t, suite);
  await attendreVue(t, 'view-login');
  const avant = (await codesEmail(email)).length;
  await t.page.fill('#login-email', email);
  await t.page.click('#btn-email');
  await t.page.locator('#email-sent').waitFor({ state: 'visible' });
  assert.match(await t.page.locator('#email-sent').innerText(), new RegExp(email.replace('.', '\\.')));
  let codes = [];
  for (let i = 0; i < 50 && codes.length <= avant; i++) {
    codes = await codesEmail(email);
    if (codes.length <= avant) await new Promise((r) => setTimeout(r, 100));
  }
  const { oobCode } = codes[codes.length - 1];
  // Le lien de l'e-mail ramène sur l'app avec le code de connexion.
  await t.page.goto(`${banc.origine}/?lien=1&mode=signIn&oobCode=${oobCode}&apiKey=cle-de-test&lang=fr`);
  t.email = email;
}

/** « Vos informations » : prénom, femme/homme, photo, numéro de téléphone, anniversaire. */
async function remplirMoi(t, { prenom, genre = 'femme', tel = '0612345678', jour = '12', mois = '5', annee = '1985' }) {
  await attendreVue(t, 'view-moi');
  await t.page.fill('#moi-prenom', prenom);
  await t.page.fill('#moi-tel', tel);
  await t.page.click(`#form-moi .genre-btn[data-genre="${genre}"]`);
  await t.page.setInputFiles('#moi-in', await photo({ largeur: 800, hauteur: 800, texte: prenom }));
  await t.page.locator('#moi-photo').waitFor({ state: 'visible' });
  await t.page.selectOption('#moi-jour', jour);
  await t.page.selectOption('#moi-mois', mois);
  await t.page.selectOption('#moi-annee', annee);
  await t.page.click('#form-moi button[type=submit]');
  t.prenom = prenom;
}

/** Nouveau proche : connexion puis « Vos informations ». */
async function inscrire(t, email, prenom, options = {}) {
  await seConnecter(t, email, options.suite || '');
  await remplirMoi(t, { prenom, ...options });
}

// ---------- Installation de la tablette ----------

/**
 * Une tablette préparée par Tanguy, allumée chez la mamie : elle affiche son code.
 * commande : { email } = commandée et payée sur le site avec cette adresse, puis envoyée (sinon, sans commande).
 */
async function tabletteAllumee({ commande = null } = {}) {
  const tab = await acteurs.tablettePreparee();
  if (commande) {
    const { abonnement } = await acteurs.commanderEtPayer({ email: commande.email, formule: commande.formule || 'sim' });
    await acteurs.preparerEtEnvoyer(abonnement, tab);
    tab.commande = abonnement;
  }
  await acteurs.afficherCode(tab);
  return tab;
}

/**
 * Installation complète depuis le téléphone (écran « Installer la tablette ») :
 * code, nom, photo, son, options. Renvoie l'id de la famille.
 */
async function installer(t, tab, { nom = 'Mamie Emma', sos = null } = {}) {
  await attendreVue(t, 'view-join');
  await t.page.click('#btn-join-pair');
  await attendreVue(t, 'view-setup');
  await t.page.fill('#setup-code-input', tab.code);
  await t.page.click('#setup-code button[type=submit]');
  await visible(t, '#setup-nom-input').waitFor();
  await t.page.fill('#setup-nom-input', nom);
  await t.page.click('#setup-nom button[type=submit]');
  await visible(t, '#setup-photo').waitFor({ timeout: 20_000 });
  const fid = await t.page.evaluate(() => localStorage.getItem('papote.fid'));
  // La tablette reçoit la confirmation et entre dans la famille.
  await s.calme();
  tab.code = tab.code || null;
  await acteurs.entrerDansLaFamille(tab);
  await t.page.locator('#setup-tablet-wait').waitFor({ state: 'hidden' });
  await t.page.setInputFiles('#setup-in-gallery', await photo({ texte: 'Coucou' }));
  await visible(t, '#setup-photo-send').waitFor();
  await t.page.fill('#setup-photo-text', 'Bonjour Mamie');
  await t.page.click('#setup-photo-send');
  await visible(t, '#setup-son').waitFor({ timeout: 20_000 });
  await t.page.click('.setup-essai[data-essai="sonnerie"]');
  await visible(t, '#setup-son-status').waitFor();
  await t.page.click('#setup-son-ok');
  await visible(t, '#setup-options').waitFor();
  if (sos !== null) await t.page.locator('#setup-opt-sos').setChecked(sos);
  await t.page.click('#setup-fin');
  await attendreVue(t, 'view-home', 30_000);
  await s.calme();
  return fid;
}

/** Ferme le réglage pas à pas (« Plus tard ») et le petit guide (« Passer ») s'ils s'affichent. */
async function fermerAccueil(t) {
  await t.page.waitForTimeout(300);
  for (let i = 0; i < 4; i++) {
    const fenetre = t.page.locator('.dialog-back:not(.closing) .dialog');
    if (await fenetre.count()) throw new Error(`[${t.nom}] fenêtre inattendue sur l'accueil : « ${await fenetre.first().innerText()} »`);
    if (await t.page.locator('.intro-back').count()) { await t.page.click('.intro-back .intro-prev'); continue; }
    if (await t.page.locator('.guide-back').count()) { await t.page.click('.guide-back .guide-skip'); continue; }
    return;
  }
}

/**
 * Famille prête : le proche s'inscrit, commande (même adresse), installe la tablette, ferme le guide.
 * Renvoie { fid, tab }.
 */
async function familleInstallee(t, { email, prenom, nom = 'Mamie Emma', genre = 'femme' }) {
  await inscrire(t, email, prenom, { genre });
  const tab = await tabletteAllumee({ commande: { email } });
  const fid = await installer(t, tab, { nom });
  await fermerAccueil(t);
  return { fid, tab };
}

/** Un proche rejoint la famille avec le code famille ; la responsable (t déjà sur l'accueil) accepte. */
async function rejoindre(responsable, fid, t, { email, prenom, genre = 'homme' }) {
  const { code } = await lire(`families/${fid}`);
  await inscrire(t, email, prenom, { genre, suite: `?code=${code}` });
  await attendreVue(t, 'view-join');
  await t.page.click('#form-join button[type=submit]');
  await attendreVue(t, 'view-pending');
  await responsable.page.locator('#pending-banner .join-card', { hasText: prenom }).locator('.join-ok').click();
  await attendreVue(t, 'view-home');
  await fermerAccueil(t);
  const membre = await attendreBase(async () => (await liste(`families/${fid}/members`)).find((m) => m.email === email), 'membre');
  t.uid = membre.id;
  return membre.id;
}

/** Dernier e-mail reçu (simulé) par cette adresse : { sujet, texte }. */
function dernierMail(email) {
  const m = s.boite.filter((x) => x.a === email);
  return m[m.length - 1] || null;
}

/** Le texte d'un toast (petit message en bas). */
async function toast(t, motif) {
  await t.page.locator('#toast').filter({ hasText: motif }).waitFor({ state: 'visible', timeout: 15_000 });
}

// ---------- Accueil et pages ----------

async function ouvrirTuile(t, pageNom) {
  await t.page.click(`.tile[data-page="${pageNom}"]`);
  await attendreVue(t, `view-${pageNom}`);
}

async function retourAccueil(t) {
  await t.page.click('.nav-item[data-tab="home"]');
  await attendreVue(t, 'view-home');
}

/** Lit un document de la base (europe) tel que le serveur le voit. */
const lire = (chemin) => s.lire(chemin);

async function liste(chemin) {
  const snap = await s.db.collection(chemin).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Attend qu'une condition sur la base devienne vraie (écritures de l'app en cours). */
async function attendreBase(fn, message, delai = 15_000) {
  const debut = Date.now();
  let dernier;
  for (;;) {
    dernier = await fn();
    if (dernier) return dernier;
    if (Date.now() - debut > delai) throw new Error(`Base : ${message}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

module.exports = {
  verifierLargeur,
  vue, attendreVue, visible, repondre, texteFenetre, photo, video,
  ouvrir, seConnecter, remplirMoi, inscrire, tabletteAllumee, installer, fermerAccueil, familleInstallee, rejoindre, dernierMail, toast,
  ouvrirTuile, retourAccueil, lire, liste, attendreBase, codesEmail,
};
