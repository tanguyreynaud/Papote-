// Jeton de l'app Android (?natif=) et notifications coupées : app famille réelle (web/), faux Firebase.
//   W-a : un lien https://app.mapapote.fr/?natif=<jeton d'un autre> ne doit jamais ranger ce jeton
//         avec le compte (sinon les appels de la tablette et le jeton de connexion partent chez lui).
//   W-b : l'app Android dit ?notifs=0 quand Android bloque ses notifications : la page ne doit pas
//         dire « Votre téléphone sonne », ni laisser le jeton natif compter comme « prévenu ».
// Lancer : node --test outils/galerie/natif.test.js   (playwright installé, NODE_PATH si global)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { chromium } = require('playwright');
const { servir, RACINE } = require('./commun');
const F = require('./famille');

const UID = 'u-julie';
const PUSH = `families/${F.FID}/members/${UID}/private/push`;
const APP = 'android-app://fr.mapapote.famille/';
// Jetons FCM plausibles (Android : 140 à 200 caractères [A-Za-z0-9_:-]).
const VRAI = 'cVraiJeton:APA91b' + 'V'.repeat(140);
const PIRATE = 'dJetonPirate:APA91b' + 'P'.repeat(140);

let browser, srv;
test.before(async () => {
  browser = await chromium.launch();
  srv = await servir(path.join(RACINE, 'web'));
});
test.after(async () => { srv.close(); await browser.close(); });

// Ouvre l'accueil (famille pleine, connectée) à cette adresse, avec ce document.referrer.
async function ouvrir(query, { referrer = '', local = {}, push = null } = {}) {
  const d = F.SCENES.find((s) => s.titre === 'Accueil').donnees();
  Object.assign(d.local, local);
  if (push) d.docs[PUSH] = push;
  const ctx = await browser.newContext({ locale: 'fr-FR', serviceWorkers: 'block', isMobile: true, hasTouch: true,
    viewport: { width: 412, height: 915 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' });
  const page = await ctx.newPage();
  const erreurs = [];
  page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
  await page.addInitScript(F.poserDonnees, d);
  // Chrome met android-app://<paquet>/ quand une app ouvre la page (TWA) ; ici on le simule.
  await page.addInitScript((r) => { Object.defineProperty(Document.prototype, 'referrer', { get: () => r, configurable: true }); }, referrer);
  await page.route('https://www.gstatic.com/firebasejs/**', (r) => r.fulfill({
    contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' },
    body: r.request().url().endsWith('/faux-sdk.js') ? F.SDK : "export * from 'https://www.gstatic.com/firebasejs/faux-sdk.js';",
  }));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|www\.gstatic\.com\/firebasejs)/, (r) => r.abort());
  await page.goto(`${srv.url}/index.html${query}`);
  await page.waitForTimeout(2000);
  const etat = await page.evaluate(async (chemin) => {
    const m = await import('https://www.gstatic.com/firebasejs/faux-sdk.js');
    const s = await m.getDoc(m.doc(m.getFirestore(), chemin));
    const carte = document.getElementById('notifs-nudge');
    return {
      push: s.exists() ? s.data() : null,
      stocke: localStorage.getItem('papote.jetonNatif'),
      carte: carte ? { visible: !carte.hidden, href: carte.getAttribute('href') } : null,
    };
  }, PUSH);
  return { ctx, page, erreurs, ...etat };
}

const natifs = (push) => (push && push.natifs) || [];

test('W-a : lien piégé ouvert dans un navigateur : le jeton n’est ni gardé ni rangé', async () => {
  const r = await ouvrir(`?natif=${PIRATE}`);
  await r.ctx.close();
  assert.deepStrictEqual(natifs(r.push), [], 'jeton pirate rangé dans private/push');
  assert.notStrictEqual(r.stocke, PIRATE, 'jeton pirate gardé dans localStorage');
  assert.deepStrictEqual(r.erreurs, []);
});

test('W-a : lien piégé ouvert par l’app (App Link) : seul le dernier natif, celui de l’app, compte', async () => {
  // Ouverture (ancienne version) ajoute son propre natif APRÈS celui du lien.
  const r = await ouvrir(`?natif=${PIRATE}&quitter=1&natif=${VRAI}`, { referrer: APP });
  await r.ctx.close();
  assert.deepStrictEqual(natifs(r.push), [VRAI]);
});

test('W-a : faux referrer ressemblant (autre paquet) : refusé', async () => {
  const r = await ouvrir(`?natif=${PIRATE}&quitter=1`, { referrer: 'android-app://fr.mapapote.famille.pirate/' });
  await r.ctx.close();
  assert.deepStrictEqual(natifs(r.push), []);
});

test('W-a : jeton pirate déjà gardé avant le correctif : plus jamais rangé', async () => {
  const r = await ouvrir('', { local: { 'papote.jetonNatif': PIRATE } });
  await r.ctx.close();
  assert.deepStrictEqual(natifs(r.push), []);
});

test('W-a (non-régression) : lancement normal par l’app : jeton rangé', async () => {
  const r = await ouvrir(`?natif=${VRAI}&quitter=1`, { referrer: APP });
  await r.ctx.close();
  assert.deepStrictEqual(natifs(r.push), [VRAI]);
  assert.strictEqual(r.push.natifsV, 2, 'sans natifsV, le serveur corrigé ignore ce jeton (functions/push.js)');
  assert.deepStrictEqual(r.erreurs, []);
});

test('W-b : notifications Android coupées : jeton natif retiré, carte rouge vers les réglages', async () => {
  const r = await ouvrir(`?natif=${VRAI}&quitter=1&notifs=0`, { referrer: APP, push: { natifs: [VRAI] } });
  await r.page.locator('.tile[data-page="settings"]').first().click().catch(() => {});
  await r.page.waitForTimeout(800);
  const texte = await r.page.evaluate(() => document.getElementById('phone-push-text').textContent);
  await r.ctx.close();
  assert.deepStrictEqual(natifs(r.push), [], 'le serveur compterait ce téléphone comme prévenu');
  assert.ok(r.carte && r.carte.visible, 'pas de carte rouge');
  assert.match(r.carte.href, /^intent:\/\/notifications#Intent;scheme=papote;package=fr\.mapapote\.famille;end$/);
  assert.doesNotMatch(texte, /sonne quand/, `texte trompeur : ${texte}`);
});

test('W-b (non-régression) : notifications autorisées : pas de carte rouge', async () => {
  const r = await ouvrir(`?natif=${VRAI}&quitter=1`, { referrer: APP });
  await r.ctx.close();
  assert.ok(!r.carte || !r.carte.visible);
  assert.deepStrictEqual(natifs(r.push), [VRAI]);
});
