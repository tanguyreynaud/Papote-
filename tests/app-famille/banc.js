// Banc d'essai de l'app famille (web/) : la vraie page dans un vrai navigateur (Chromium sans écran),
// branchée sur les émulateurs Firebase et sur les vraies fonctions serveur (simulation du parcours client
// de functions/parcours, prise sur la branche main). Rien ne part en ligne.
//
//   page        web/ servi tel quel sur http://localhost:<port>
//   Firebase    le SDK (même version que l'app) est servi depuis node_modules/firebase ; une petite couche
//               le branche sur les émulateurs (Firestore, Auth, Storage) et coupe App Check et les notifications
//   fonctions   les appels onCall de l'app arrivent ici et passent aux vraies fonctions (simulation.js) ;
//               les déclencheurs Firestore tournent aussi, Stripe et les e-mails sont simulés
//   tablette    jouée par les gestes de functions/parcours/acteurs.js (QR code, entrée dans la famille, appel)
//
// Chaque téléphone est un navigateur à part (stockage, base locale, compte). Une erreur JavaScript dans la
// page, une erreur dans une fonction ou un déclencheur fait échouer le scénario.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');

const RACINE = path.join(__dirname, '..', '..');
const WEB = path.join(RACINE, 'web');
const FONCTIONS = process.env.PAPOTE_FONCTIONS || path.join(__dirname, '.fonctions', 'functions');
const SDK = path.join(__dirname, 'node_modules', 'firebase');
const VERSION_SDK = '12.19.0';
const PROJET = 'demo-papote';

if (!fs.existsSync(path.join(FONCTIONS, 'parcours', 'simulation.js'))) {
  throw new Error(`Fonctions introuvables dans ${FONCTIONS} : lancez « npm test » (il les prépare).`);
}

const s = require(path.join(FONCTIONS, 'parcours', 'simulation.js'));
const acteurs = require(path.join(FONCTIONS, 'parcours', 'acteurs.js'));
const deFonctions = (m) => require(require.resolve(m, { paths: [FONCTIONS] }));
const admin = deFonctions('firebase-admin');
const { getFirestore } = deFonctions('firebase-admin/firestore');

let playwright;
try {
  playwright = require('playwright');
} catch (e) {
  playwright = require(require.resolve('playwright', { paths: [process.env.NODE_PATH || '', '/opt/node-tools/node_modules'] }));
}

// Moteur du navigateur : chromium (Chrome d'Android, par défaut) ou webkit (Safari d'iPhone).
// PAPOTE_MOTEUR=webkit ouvre chaque téléphone comme un iPhone (PAPOTE_APPAREIL, « iPhone 15 » par défaut :
// taille, écran, agent Safari, doigt) ; un ordinateur (largeur > 600) comme Safari sur Mac. Voir WEBKIT.md.
const MOTEUR = process.env.PAPOTE_MOTEUR || 'chromium';
if (!['chromium', 'webkit'].includes(MOTEUR)) throw new Error(`PAPOTE_MOTEUR inconnu : ${MOTEUR} (chromium ou webkit)`);
const WEBKIT = MOTEUR === 'webkit';
const APPAREIL = process.env.PAPOTE_APPAREIL || 'iPhone 15';
if (WEBKIT && !playwright.devices[APPAREIL]) throw new Error(`PAPOTE_APPAREIL inconnu de Playwright : ${APPAREIL}`);

/**
 * Saut d'un essai (ou d'une partie) qui ne peut pas tourner dans ce moteur : jamais en silence. La raison est
 * écrite dans le compte rendu et chaque saut est listé dans WEBKIT.md (vérifié par webkit-liste.test.js).
 */
function nonCouvert(moteur, raison) {
  if (MOTEUR !== moteur) return false;
  console.log(`# NON COUVERT sous ${moteur} : ${raison}`);
  return raison;
}

const hote = (variable) => {
  const v = process.env[variable];
  if (!v) throw new Error(`${variable} absent : lancez les tests avec « npm test » (émulateurs).`);
  const [h, p] = v.replace(/^https?:\/\//, '').split(':');
  return { h: h === 'localhost' ? '127.0.0.1' : h, p: Number(p) };
};

// ---------- Le SDK Firebase branché sur les émulateurs ----------

const GSTATIC = `https://www.gstatic.com/firebasejs/${VERSION_SDK}/`;

function couches(port) {
  const fs_ = hote('FIRESTORE_EMULATOR_HOST');
  const au = hote('FIREBASE_AUTH_EMULATOR_HOST');
  const st = hote('FIREBASE_STORAGE_EMULATOR_HOST');
  const branche = 'const _branches = (globalThis.__papoteBranches ||= new WeakSet());';
  return {
    'firebase-app.js': `
      export * from './vrai/firebase-app.js';
      import { initializeApp as _init } from './vrai/firebase-app.js';
      export function initializeApp(options, nom) {
        return _init({ ...options, projectId: '${PROJET}', apiKey: 'cle-de-test' }, nom);
      }`,
    'firebase-firestore.js': `
      export * from './vrai/firebase-firestore.js';
      import { initializeFirestore as _init, getFirestore as _get, connectFirestoreEmulator } from './vrai/firebase-firestore.js';
      ${branche}
      const _brancher = (db) => { if (!_branches.has(db)) { _branches.add(db); connectFirestoreEmulator(db, '${fs_.h}', ${fs_.p}); } return db; };
      export function initializeFirestore(app, reglages, id) { return _brancher(_init(app, reglages, id)); }
      export function getFirestore(...a) { return _brancher(_get(...a)); }`,
    'firebase-auth.js': `
      export * from './vrai/firebase-auth.js';
      import { getAuth as _get, initializeAuth as _init, connectAuthEmulator } from './vrai/firebase-auth.js';
      ${branche}
      const _brancher = (a) => { if (!_branches.has(a)) { _branches.add(a); connectAuthEmulator(a, 'http://${au.h}:${au.p}', { disableWarnings: true }); } return a; };
      export function getAuth(...a) { return _brancher(_get(...a)); }
      export function initializeAuth(...a) { return _brancher(_init(...a)); }
      // Connexion Google : la fenêtre et la redirection de Google ont besoin de apis.google.com (coupé ici). Un compte
      // posé par le scénario (globalThis.__papoteGoogle = { email, nom, bloque }) est connecté par l'émulateur comme
      // Google le ferait ; bloque : la fenêtre est refusée (app installée), l'app passe par la redirection, qui
      // revient sur l'app (page rechargée) déjà connectée. Sans compte posé : le vrai SDK (gestes.google).
      import { signInWithCredential as _cred, GoogleAuthProvider as _G, signInWithPopup as _popup, signInWithRedirect as _redir } from './vrai/firebase-auth.js';
      const _jeton = (c) => _G.credential(JSON.stringify({ sub: 'g-' + c.email, email: c.email, email_verified: true, name: c.nom }));
      export async function signInWithPopup(auth, fournisseur, r) {
        const c = globalThis.__papoteGoogle;
        if (!c) return _popup(auth, fournisseur, r);
        if (c.bloque) throw Object.assign(new Error('Firebase: Error (auth/popup-blocked).'), { code: 'auth/popup-blocked' });
        return _cred(auth, _jeton(c));
      }
      export async function signInWithRedirect(auth, fournisseur, r) {
        const c = globalThis.__papoteGoogle;
        if (!c) return _redir(auth, fournisseur, r);
        await _cred(auth, _jeton(c));
        location.reload();
        return new Promise(() => {});
      }`,
    'firebase-storage.js': `
      export * from './vrai/firebase-storage.js';
      import { getStorage as _get, connectStorageEmulator } from './vrai/firebase-storage.js';
      ${branche}
      export function getStorage(...a) { const s = _get(...a); if (!_branches.has(s)) { _branches.add(s); connectStorageEmulator(s, '${st.h}', ${st.p}); } return s; }
      // Adresse de téléchargement comme en ligne (les règles n'acceptent que firebasestorage.googleapis.com) ;
      // le banc renvoie ces adresses vers l'émulateur.
      import { getDownloadURL as _url } from './vrai/firebase-storage.js';
      export async function getDownloadURL(r) {
        return (await _url(r)).replace('http://${st.h}:${st.p}/', 'https://firebasestorage.googleapis.com/');
      }`,
    'firebase-functions.js': `
      export * from './vrai/firebase-functions.js';
      import { getFunctions as _get, connectFunctionsEmulator } from './vrai/firebase-functions.js';
      ${branche}
      export function getFunctions(...a) { const f = _get(...a); if (!_branches.has(f)) { _branches.add(f); connectFunctionsEmulator(f, 'localhost', ${port}); } return f; }`,
    // App Check : pas de reCAPTCHA en test.
    'firebase-app-check.js': `
      export * from './vrai/firebase-app-check.js';
      export function initializeAppCheck() { return {}; }`,
    // Notifications : pas de service de push dans le navigateur de test.
    'firebase-messaging.js': `
      export * from './vrai/firebase-messaging.js';
      export async function isSupported() { return false; }
      export async function getToken() { throw new Error('Pas de notifications en test'); }`,
  };
}

// ---------- Serveur : les fichiers de web/ et les appels onCall ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ico': 'image/x-icon',
};

// Les appels faits par l'app, gardés pour les vérifications : [{ nom, data, uid }].
const appels = [];
// Pannes à jouer : nom de fonction -> erreur renvoyée (ex. { status: 'UNAVAILABLE' }).
const pannes = new Map();

function jetonVersAuth(entete) {
  const m = /^Bearer (.+)$/.exec(entete || '');
  if (!m) return undefined;
  const charge = JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url').toString('utf8'));
  const uid = charge.user_id || charge.sub;
  return { uid, token: { ...charge, uid } };
}

async function appelOnCall(nom, req, res) {
  let corps = '';
  for await (const morceau of req) corps += morceau;
  const repondre = (statut, json) => {
    res.writeHead(statut, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  };
  const f = s.fonctions[nom];
  if (!f || typeof f.run !== 'function') {
    s.erreurs.push(`L'app appelle une fonction inconnue : ${nom}`);
    return repondre(404, { error: { status: 'NOT_FOUND', message: 'NOT_FOUND' } });
  }
  const data = corps ? JSON.parse(corps).data : null;
  const auth = jetonVersAuth(req.headers.authorization);
  appels.push({ nom, data, uid: auth?.uid || null });
  if (pannes.has(nom)) {
    const p = pannes.get(nom);
    return repondre(p.code || 503, { error: { status: p.status || 'UNAVAILABLE', message: p.message || 'panne simulée' } });
  }
  try {
    const result = await f.run({ data, auth, rawRequest: { headers: req.headers, ip: '127.0.0.1' } });
    return repondre(200, { result: result === undefined ? null : result });
  } catch (e) {
    if (e && e.httpErrorCode && typeof e.toJSON === 'function') {
      return repondre(e.httpErrorCode.status, { error: e.toJSON() });
    }
    // Erreur imprévue dans une fonction : en ligne, l'app reçoit « INTERNAL » ; ici, c'est un échec.
    s.erreurs.push(`${nom} : ${e && e.stack ? e.stack : e}`);
    return repondre(500, { error: { status: 'INTERNAL', message: 'INTERNAL' } });
  }
}

let serveur;
let port;
let origine;
let fichiersSdk;

function demarrerServeur() {
  serveur = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const appel = new RegExp(`^/${PROJET}/[a-z0-9-]+/([A-Za-z0-9_]+)$`).exec(url.pathname);
    if (appel) {
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      appelOnCall(appel[1], req, res).catch((e) => { s.erreurs.push(String(e)); res.writeHead(500); res.end(); });
      return;
    }
    // Page vide (même origine que l'app) : la tablette simulée y fait ses appels WebRTC.
    if (url.pathname === '/__vide.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>Tablette simulée</title><audio id="son" autoplay></audio>');
      return;
    }
    let fichier = decodeURIComponent(url.pathname);
    if (fichier.endsWith('/')) fichier += 'index.html';
    const complet = path.join(WEB, path.normalize(fichier));
    if (!complet.startsWith(WEB) || !fs.existsSync(complet) || fs.statSync(complet).isDirectory()) {
      res.writeHead(404); res.end('absent'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(complet)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(complet).pipe(res);
  });
  return new Promise((pret) => serveur.listen(0, '127.0.0.1', () => {
    port = serveur.address().port;
    origine = `http://localhost:${port}`;
    fichiersSdk = couches(port);
    pret();
  }));
}

// ---------- Navigateur ----------

let navigateur;
const telephones = [];
// Requêtes vers internet coupées (ni Google, ni météo, ni radio) : gardées pour information.
const sorties = new Set();

// Erreurs de la console tolérées : messages prévus par l'app quand on coupe le réseau exprès, etc.
const TOLERE = [
  /Failed to load resource: net::ERR_INTERNET_DISCONNECTED/,
  /Failed to load resource: net::ERR_FAILED/,
  // Internet coupé par le banc (Google, chat d'aide du site…) : voir sorties.
  /Failed to load resource: net::ERR_BLOCKED_BY_CLIENT/,
  // Fermeture du canal d'écriture Firestore (TYPE=terminate) quand le banc ferme la page ou l'émulateur
  // pendant un envoi : simple ménage du SDK, refusé (400) par l'émulateur. Vu 1 fois sur 4 dans mauvais-jours (12/11).
  // (le motif est essayé sur « message (adresse) »)
  // Même ménage pour le canal d'écoute (Listen, TYPE=terminate) quand l'app change de famille ou se déconnecte et
  // arrête ses écoutes : l'émulateur a parfois déjà fermé la session et répond 400. Vu 1 fois dans « Deux familles »
  // (Chromium, 18/11) : rien de l'app, seulement l'adieu du SDK à une session finie (audit/tests-instables-18-11.md).
  /status of 400 \(Bad Request\) \(http:\/\/127\.0\.0\.1:\d+\/google\.firestore\.v1\.Firestore\/(Write|Listen)\/channel\?[^)]*TYPE=terminate/,
  // Les mêmes, avec les mots de Safari (WebKit) : réseau coupé exprès, requête coupée par le banc.
  ...(WEBKIT ? [
    /Failed to load resource: (The Internet connection appears to be offline|The network connection was lost|Could not connect to the server|A server with the specified hostname could not be found|cancelled)\.?/i,
    /Failed to load resource: (Blocked by client|Request intercepted|The operation couldn.t be completed)/i,
    // Réseau coupé (setOffline) ou requête coupée par le banc : le WebKit de Playwright le dit ainsi.
    /Failed to load resource: WebKit encountered an internal error/,
    // Fermeture d'un canal Firestore (TYPE=terminate, envoyée par sendBeacon) pendant que le réseau est coupé.
    /^Beacon API cannot load http:\/\/127\.0\.0\.1:\d+\/google\.firestore\.v1\.Firestore\/(Listen|Write)\/channel\?[^ ]*TYPE=terminate/,
    // Safari ne connaît pas interactive-widget (balise viewport, pour Chrome d'Android) : il le dit et l'ignore.
    /Viewport argument key "interactive-widget" not recognized and ignored/,
  ] : []),
];

// Erreurs « non rattrapées » que Safari signale sans qu'aucun code de l'app ne soit en faute : le SDK Firestore
// abandonne ses longues requêtes d'écoute et d'écriture (changement de base, fin d'écoute, page qui part) et WebKit
// note chaque abandon d'une requête vers une autre origine comme « Fetch API cannot load … due to access control
// checks ». Chromium n'en dit rien. Seulement les canaux de Firestore, mot pour mot.
const TOLERE_PAGE = WEBKIT ? [
  /^Fetch API cannot load http:\/\/127\.0\.0\.1:\d+\/google\.firestore\.v1\.Firestore\/(Listen|Write)\/channel\?\S* due to access control checks\./,
] : [];

async function routerInternet(context) {
  await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, async (route) => {
    const url = route.request().url();
    if (url.startsWith(GSTATIC)) {
      const nom = url.slice(GSTATIC.length).split('?')[0];
      const entetes = { 'content-type': 'text/javascript; charset=utf-8', 'access-control-allow-origin': '*' };
      if (fichiersSdk[nom]) return route.fulfill({ status: 200, headers: entetes, body: fichiersSdk[nom] });
      const vrai = nom.replace(/^vrai\//, '');
      const f = path.join(SDK, vrai);
      if (/^firebase-[a-z-]+\.js$/.test(vrai) && fs.existsSync(f)) {
        return route.fulfill({ status: 200, headers: entetes, body: fs.readFileSync(f, 'utf8') });
      }
    }
    if (url.startsWith('https://firebasestorage.googleapis.com/')) {
      const st = hote('FIREBASE_STORAGE_EMULATOR_HOST');
      try {
        const r = await fetch(url.replace('https://firebasestorage.googleapis.com/', `http://${st.h}:${st.p}/`));
        return route.fulfill({
          status: r.status,
          headers: { 'content-type': r.headers.get('content-type') || 'application/octet-stream', 'access-control-allow-origin': '*' },
          body: Buffer.from(await r.arrayBuffer()),
        });
      } catch (e) {
        return route.abort('failed');
      }
    }
    if (/fonts\.(googleapis|gstatic)\.com/.test(url)) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/css', 'access-control-allow-origin': '*' }, body: '' });
    }
    if (url === 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js') {
      return route.fulfill({
        status: 200, headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' },
        body: fs.readFileSync(path.join(__dirname, 'node_modules', 'jszip', 'dist', 'jszip.min.js'), 'utf8'),
      });
    }
    if (url.startsWith('https://geo.api.gouv.fr/')) {
      // Communes aux noms longs (passage à la ligne, jamais coupés) pour 69650 et 51290 ; sinon Saint-Martin.
      const cp = new URL(url).searchParams.get('codePostal');
      const communes = {
        69650: [
          { nom: 'Saint-Germain-au-Mont-d\'Or', code: '69207', departement: { nom: 'Rhône' }, centre: { coordinates: [4.80, 45.88] } },
          { nom: 'Quincieux', code: '69163', departement: { nom: 'Rhône' }, centre: { coordinates: [4.78, 45.91] } },
        ],
        51290: [{ nom: 'Saint-Remy-en-Bouzemont-Saint-Genest-et-Isson', code: '51513', departement: { nom: 'Marne' }, centre: { coordinates: [4.65, 48.63] } }],
      }[cp] || [{ nom: 'Saint-Martin-de-Valamas', code: '07292', codesPostaux: ['07310'], centre: { coordinates: [4.37, 44.94] } }];
      return route.fulfill({
        status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        body: JSON.stringify(communes),
      });
    }
    sorties.add(new URL(url).host);
    return route.abort('blockedbyclient');
  });
}

// Note dans window.__toastsVus chaque texte du petit message (#toast) au moment où il est affiché : { texte, a }.
function NOTER_TOASTS() {
  if (window.top !== window || window.__toastsVus) return;
  window.__toastsVus = [];
  const brancher = () => {
    const el = document.getElementById('toast');
    if (!el) return;
    const noter = () => { if (!el.hidden && el.textContent) window.__toastsVus.push({ texte: el.textContent, a: Date.now() }); };
    new MutationObserver(noter).observe(el, { attributes: true, attributeFilter: ['hidden'], childList: true, characterData: true, subtree: true });
    noter();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', brancher, { once: true });
  else brancher();
}

/**
 * Un téléphone : un navigateur à part, comme le téléphone d'un proche.
 * options : { largeur, hauteur, hauteurEcran } (iPhone 13 par défaut) ; fuseau : fuseau horaire (heure de Paris par
 * défaut), pour qu'il soit une autre heure sur cet appareil sans toucher à l'horloge (comptes, serveur).
 */
async function telephone(nom, { largeur, hauteur, fuseau = 'Europe/Paris' } = {}) {
  let reglages;
  if (!WEBKIT) {
    reglages = {
      viewport: { width: largeur || 390, height: hauteur || 844 },
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
      hasTouch: true,
      isMobile: true,
    };
  } else if (largeur > 600) {
    // L'admin, sur un ordinateur : Safari sur Mac.
    const { defaultBrowserType, ...mac } = playwright.devices['Desktop Safari'];
    reglages = { ...mac, viewport: { width: largeur, height: hauteur || 900 } };
  } else {
    // Un iPhone : sa taille (Safari, barres comprises), son écran, son agent, son doigt ; une taille demandée
    // par le scénario (petit téléphone) est gardée.
    const { defaultBrowserType, ...iphone } = playwright.devices[APPAREIL];
    reglages = { ...iphone, viewport: largeur ? { width: largeur, height: hauteur } : iphone.viewport };
  }
  const context = await navigateur.newContext({
    ...reglages,
    locale: 'fr-FR',
    timezoneId: fuseau,
    serviceWorkers: 'block',
  });
  // Caméra et micro permis, comme Chromium avec --use-fake-ui-for-media-stream (le proche a dit « Autoriser »).
  if (WEBKIT) await context.grantPermissions(['camera', 'microphone']);
  // Safari d'iPhone n'a pas le plein écran d'un élément (seulement celui d'une vidéo, webkitEnterFullscreen), que le
  // WebKit de Playwright (Linux) a : on l'enlève, pour que l'app prenne le chemin d'un iPhone.
  if (WEBKIT && reglages.isMobile) {
    await context.addInitScript(() => {
      for (const nom of ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen']) delete Element.prototype[nom];
      Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false, configurable: true });
    });
  }
  await routerInternet(context);
  // Chaque petit message (#toast) affiché est noté dans la page (window.__toastsVus) : il ne reste que 2,5 s à
  // l'écran, et une CI chargée pouvait le laisser apparaître et disparaître entre deux regards de Playwright
  // (gestes.js toast, audit/tests-instables-18-11.md).
  await context.addInitScript(NOTER_TOASTS);
  const page = await context.newPage();
  const t = {
    nom, context, page, erreurs: [], console: [],
    largeur: reglages.viewport.width, hauteur: reglages.viewport.height,
  };
  page.on('pageerror', (e) => {
    // Première ligne : WebKit met la pile sous le message.
    const lignes = [e.message, e.stack].map((x) => String(x || '').split('\n')[0].replace(/^(Type)?Error: /, ''));
    if (lignes.some((l) => TOLERE_PAGE.some((r) => r.test(l)))) return;
    t.erreurs.push(`[${nom}] erreur non rattrapée : ${e.stack || e.message}`);
  });
  page.on('console', (m) => {
    const texte = m.text();
    t.console.push(`${m.type()} : ${texte}`);
    // Refus prévus d'une fonction (HttpsError) : le navigateur note la réponse 4xx, l'app l'affiche.
    const refusPrevu = /status of 4\d\d/.test(texte) && new RegExp(`/${PROJET}/`).test(m.location().url || '');
    const complet = `${texte} (${m.location().url || ''})`;
    if (m.type() === 'error' && !refusPrevu && !TOLERE.some((r) => r.test(complet))) {
      t.erreurs.push(`[${nom}] console.error : ${complet}`);
    }
  });
  page.on('dialog', (d) => {
    // Jamais de fenêtre grise du navigateur (confirm/alert) dans l'app : c'est une erreur.
    t.erreurs.push(`[${nom}] fenêtre du navigateur : ${d.type()} « ${d.message()} »`);
    d.dismiss().catch(() => {});
  });
  telephones.push(t);
  return t;
}

/** Les erreurs de console attendues dans ce scénario (ex. hors ligne) : retirées de la liste. */
function tolerer(t, motif) {
  t.erreurs = t.erreurs.filter((e) => !motif.test(e));
}

// ---------- Base ----------

// L'app lit config/base dans la base d'origine puis passe sur « europe » et le bucket papote-famille-eu.
async function preparerBase() {
  await getFirestore().doc('config/base').set({ database: 'europe', bucket: 'papote-famille-eu' });
}

async function viderStorage() {
  const st = hote('FIREBASE_STORAGE_EMULATOR_HOST');
  await fetch(`http://${st.h}:${st.p}/internal/reset`, { method: 'POST' }).catch(() => {});
}

// ---------- Réglages des scénarios ----------

function brancher() {
  test.before(async () => {
    await s.demarrer();
    await demarrerServeur();
    navigateur = WEBKIT
      // WebKit de Playwright : caméra et micro simulés d'office (MockCaptureDevices), autorisés sans question.
      ? await playwright.webkit.launch()
      : await playwright.chromium.launch({
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
      });
  });
  test.after(async () => {
    await navigateur?.close();
    await new Promise((r) => serveur.close(r));
    await s.arreter();
  });
  test.beforeEach(async () => {
    await s.remettreAZero();
    await viderStorage();
    await preparerBase();
    appels.length = 0;
    pannes.clear();
  });
  test.afterEach(async (ctx) => {
    // Safari d'iPhone : un écran resté zoomé (double appui) est une erreur.
    if (WEBKIT) {
      for (const t of telephones) {
        if (t.page.isClosed()) continue;
        // Seulement une page à la largeur du téléphone (balise viewport) : une page sans elle (atelier, tablette
        // simulée) s'ouvre réduite à 980 px, sans geste.
        const zoom = await t.page.evaluate(() => (window.visualViewport && document.querySelector('meta[name=viewport][content*="width=device-width"]')
          ? window.visualViewport.scale : 1)).catch(() => 1);
        if (Math.abs(zoom - 1) > 0.01) t.erreurs.push(`[${t.nom}] écran resté zoomé (×${zoom.toFixed(2)}) : le double appui de Safari`);
      }
    }
    const erreursPages = telephones.flatMap((t) => t.erreurs);
    // Dernier écran de chaque téléphone, dans captures/ : pour comprendre un échec sans relancer.
    const dossier = path.join(__dirname, 'captures', (ctx?.name || 'test').replace(/[^\p{L}\p{N} -]+/gu, '_').slice(0, 80));
    for (const t of telephones) {
      if (t.page.isClosed()) continue;
      await fs.promises.mkdir(dossier, { recursive: true });
      await t.page.screenshot({ path: path.join(dossier, `${t.nom}.png`) }).catch(() => {});
    }
    // PAPOTE_JOURNAL=1 : la fin de la console de chaque téléphone dans le compte rendu (la CI, sans les captures).
    if (process.env.PAPOTE_JOURNAL) {
      for (const t of telephones) {
        console.log(`# --- console de ${t.nom} (${ctx?.name || ''}) ---`);
        for (const l of t.console.slice(-25)) console.log(`#   ${l.slice(0, 300).replace(/\n/g, ' ')}`);
      }
    }
    for (const t of telephones.splice(0)) await t.context.close().catch(() => {});
    await s.calme();
    assert.deepStrictEqual(erreursPages, [], 'erreurs dans l\'app');
    assert.deepStrictEqual(s.erreurs, [], 'erreurs dans les fonctions');
  });
}

module.exports = {
  s, acteurs, admin, brancher, telephone, tolerer, appels, pannes, sorties,
  get origine() { return origine; },
  get port() { return port; },
  PROJET, hote, MOTEUR, WEBKIT, APPAREIL, nonCouvert,
};
