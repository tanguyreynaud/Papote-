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
      export function initializeAuth(...a) { return _brancher(_init(...a)); }`,
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
];

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
      return route.fulfill({
        status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        body: JSON.stringify([{ nom: 'Saint-Martin-de-Valamas', code: '07292', codesPostaux: ['07310'], centre: { coordinates: [4.37, 44.94] } }]),
      });
    }
    sorties.add(new URL(url).host);
    return route.abort('blockedbyclient');
  });
}

/**
 * Un téléphone : un navigateur à part, comme le téléphone d'un proche.
 * options : { largeur, hauteur, hauteurEcran } (iPhone 13 par défaut).
 */
async function telephone(nom, { largeur = 390, hauteur = 844 } = {}) {
  const context = await navigateur.newContext({
    viewport: { width: largeur, height: hauteur },
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    serviceWorkers: 'block',
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
    hasTouch: true,
    isMobile: true,
  });
  await routerInternet(context);
  const page = await context.newPage();
  const t = { nom, context, page, erreurs: [], console: [] };
  page.on('pageerror', (e) => t.erreurs.push(`[${nom}] erreur non rattrapée : ${e.stack || e.message}`));
  page.on('console', (m) => {
    const texte = m.text();
    t.console.push(`${m.type()} : ${texte}`);
    // Refus prévus d'une fonction (HttpsError) : le navigateur note la réponse 4xx, l'app l'affiche.
    const refusPrevu = /status of 4\d\d/.test(texte) && new RegExp(`/${PROJET}/`).test(m.location().url || '');
    if (m.type() === 'error' && !refusPrevu && !TOLERE.some((r) => r.test(texte))) {
      t.erreurs.push(`[${nom}] console.error : ${texte} (${m.location().url || ''})`);
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
    navigateur = await playwright.chromium.launch({
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
  test.afterEach(async () => {
    const erreursPages = telephones.flatMap((t) => t.erreurs);
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
  PROJET, hote,
};
