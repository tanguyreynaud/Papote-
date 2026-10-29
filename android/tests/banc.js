// Banc d'essai des écrans de la tablette (tablette.html) dans un vrai navigateur, sans tablette :
// la page est servie depuis android/app/src/main/assets, l'app Android est remplacée par une
// imitation (window.PapoteAndroid) qui note chaque appel, et l'heure est pilotée (page.clock).
// Utilisé par ecrans.test.js. Lancement : node --test android/tests/
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ASSETS = path.join(__dirname, '..', 'app', 'src', 'main', 'assets');
const PHOTO = fs.readFileSync(path.join(__dirname, '..', 'app', 'src', 'main', 'res', 'mipmap-xxxhdpi', 'ic_launcher.png'));
const ORIGIN = 'https://appassets.androidplatform.net';
const FAUX_FIREBASE = fs.readFileSync(path.join(__dirname, 'faux-firebase.js'));

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg',
};

// Imitation de l'app Android, posée avant le chargement de la page.
function imitation(etat) {
  window.__etat = etat;
  window.__appels = [];
  const note = (nom) => (...args) => { window.__appels.push({ nom, args }); };
  window.PapoteAndroid = {
    ready: note('ready'), markSeen: note('markSeen'), sendHeart: note('sendHeart'), reply: note('reply'),
    playVoice: note('playVoice'), playVideo: note('playVideo'), playVideoAt: note('playVideoAt'), stopVideo: note('stopVideo'),
    stopVoice: note('stopVoice'), setSleep: note('setSleep'), setDim: note('setDim'), realtime: note('realtime'),
    changed: note('changed'), morePhotos: note('morePhotos'), touched: note('touched'), seen: note('seen'),
    ackReminder: note('ackReminder'), seenReminder: note('seenReminder'), alert: note('alert'),
    carillonStop: note('carillonStop'), carillonEnCours: () => false, fenetre: (o) => { window.__fenetre = o; },
    getCode: () => window.__etat.code || null,
    callsAccount: () => JSON.stringify(window.__etat.code ? { email: 'tablette-appels-essai@tablettes.papote-famille.web.app', password: 'secret' } : {}),
    setTabletName: note('setTabletName'),
    meteoSearch: () => '[]', meteoChoose: note('meteoChoose'), meteoSkip: note('meteoSkip'),
    wifiScan: () => '[]', wifiConnect: () => true,
    speak: note('speak'), speakGuide: note('speakGuide'), stopSpeaking: note('stopSpeaking'),
    checkUpdate: note('checkUpdate'), hasAppCheckKey: () => false, appCheckToken: () => '',
    firestoreDatabase: () => 'eu', isCharging: () => window.__etat.secteur !== false,
    wifiStatus: () => JSON.stringify(window.__etat.reseau || { wifi: 'Box', internet: true, mobile: false, sim: false }),
    pushReady: () => !!window.__etat.push,
    simBudget: () => JSON.stringify(window.__etat.forfait || { plafondMo: 1000, consoMo: 0, niveau: 0, sim: false, cycleDebut: '2026-10-01' }),
    logError: note('logError'), wifiDone: note('wifiDone'), confirmPairing: note('confirmPairing'),
    welcomeBack: note('welcomeBack'), welcomeSeen: note('welcomeSeen'), cancelPairing: note('cancelPairing'),
    testSon: note('testSon'), getPairing: () => null, ring: note('ring'), inCall: note('inCall'),
    // Appels par la carte SIM (etat.telephone : la tablette sait téléphoner) ; phoneCall renvoie false avec etat.telephoneKo,
    // phoneHangup avec etat.raccrocherKo (plus d'appel côté Android) ; phoneState lit etat.appelGsm.
    phoneReady: () => !!window.__etat.telephone,
    phoneCall: (...args) => { window.__appels.push({ nom: 'phoneCall', args }); return !window.__etat.telephoneKo; },
    phoneAnswer: note('phoneAnswer'), phoneHangup: (...args) => { window.__appels.push({ nom: 'phoneHangup', args }); return !window.__etat.raccrocherKo; }, sendSms: (...args) => { window.__appels.push({ nom: 'sendSms', args }); return true; },
    phoneState: () => JSON.stringify(window.__etat.appelGsm || {}), phoneNumbers: () => '[]',
    qrCode: () => 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    // Chien de garde (Gardien.java) et garde-fous de la page.
    pouls: note('pouls'), gardeFou: note('gardeFou'),
  };
  // Caméra : window.__visage() fait « voir » un visage à toutes les surveillances en cours.
  window.__surveillances = new Set();
  window.papoteWatchPresence = (onSeen) => {
    const w = { onSeen };
    window.__surveillances.add(w);
    return () => window.__surveillances.delete(w);
  };
  window.__visage = () => { [...window.__surveillances].forEach((w) => w.onSeen()); };
  // Les sons de la page (voix MP3) : lecture simulée, finie aussitôt.
  window.Audio = function (src) {
    const a = { src, paused: true, onended: null, onerror: null };
    a.play = () => { a.paused = false; window.__appels.push({ nom: 'audio', args: [src] }); setTimeout(() => a.onended && a.onended(), 10); return Promise.resolve(); };
    a.pause = () => { a.paused = true; };
    return a;
  };
  window.addEventListener('error', (e) => { window.__appels.push({ nom: 'erreurJS', args: [String(e.message)] }); });
}

// Ouvre la page à l'heure donnée (heure de Paris). etat : { reseau, secteur, firebase, code, appelsKo }.
async function ouvrir(heure = '2026-10-26T10:00:00', etat = {}) {
  // Caméra et micro imités par Chromium (mire et bip) pour les appels.
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: 'Europe/Paris', locale: 'fr-FR', permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  await page.clock.install({ time: new Date(heure + '+01:00') });
  await page.addInitScript(imitation, etat);
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    // Firebase imité (etat.firebase) : appels.js tourne sur une base en mémoire (faux-firebase.js).
    if (etat.firebase && url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
      return route.fulfill({ body: FAUX_FIREBASE, contentType: 'text/javascript' });
    }
    if (url.origin !== ORIGIN) return route.abort(); // internet (Firebase, CDN) : jamais pendant les essais
    // Essais des écrans seuls : appels.js remplacé par un module vide (la caméra est imitée plus haut),
    // sauf pour imiter des appels qui ne se chargent pas (etat.appelsKo).
    if (url.pathname === '/appels.js' && !etat.firebase && !etat.appelsKo) return route.fulfill({ body: '', contentType: 'text/javascript' });
    if (url.pathname.startsWith('/photos/')) return route.fulfill({ body: PHOTO, contentType: 'image/png' });
    const file = path.join(ASSETS, decodeURIComponent(url.pathname));
    if (!file.startsWith(ASSETS) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
  });
  await page.goto(`${ORIGIN}/tablette.html`);
  const banc = {
    page,
    fermer: () => browser.close(),
    appels: (nom) => page.evaluate((n) => window.__appels.filter((a) => !n || a.nom === n), nom),
    vider: () => page.evaluate(() => { window.__appels = []; }),
    // Message d'Android vers la page (comme MainActivity.callPage).
    android: (fonction, donnees) => page.evaluate(([f, d]) => window.Papote[f](d), [fonction, donnees]),
    visible: (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.hidden && !e.closest('[hidden]') && getComputedStyle(e).display !== 'none'; }, sel),
    texte: (sel) => page.evaluate((s) => ((document.querySelector(s) || {}).textContent || '').replace(/\u00a0/g, ' '), sel),
    toucher: (sel) => page.evaluate((s) => document.querySelector(s).click(), sel),
    avancer: (ms) => page.clock.runFor(ms),
    // Heure de la page ET vrai temps qui passe : pour la caméra, le micro et WebRTC, qui ne suivent pas l'horloge imitée.
    patienter: async (ms) => {
      for (let t = 0; t < ms; t += 250) { await page.clock.runFor(250); await new Promise((r) => setTimeout(r, 60)); }
    },
    etat: (e) => page.evaluate((x) => Object.assign(window.__etat, x), e),
    // Base Firebase imitée (avec etat.firebase).
    ecrire: (chemin, donnees) => page.evaluate(([c, d]) => window.__fs.ecrire(c, d), [chemin, donnees]),
    lire: (chemin) => page.evaluate((c) => window.__fs.lire(c), chemin),
  };
  await banc.avancer(100);
  return banc;
}

// Un envoi tel que Sync.publishPosts le donne à la page.
let n = 0;
function envoi(champs = {}) {
  n++;
  return {
    id: `envoi${n}`, type: 'photo', text: '', authorName: 'Julie', authorUid: 'julie', createdAt: Date.parse('2026-10-26T09:00:00+01:00') + n * 60000,
    seen: false, hearts: 0, image: `${ORIGIN}/photos/envoi${n}.jpg`, images: [], audio: null, video: null,
    voice: null, announce: null, duration: 0, ...champs,
  };
}

function lot(posts, champs = {}) {
  return {
    familyName: 'Mamie', familyCode: 'ABCD-2345', textSize: '', subscription: 'actif',
    options: { lecture: true, sos: true, meteo: true, rappelsAccueil: true },
    veille: { active: true, de: 23 * 60, a: 7 * 60 }, posts, ...champs, // en minutes, comme Sync.java
  };
}

module.exports = { ouvrir, envoi, lot, ORIGIN };
