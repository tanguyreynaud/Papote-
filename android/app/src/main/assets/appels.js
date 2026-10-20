// Appels vidéo sur la tablette : sonnerie, « Décrocher », appel en WebRTC.
// Chargé seulement si le navigateur de la tablette sait faire de la vidéo (Android 5 et plus, à jour).
// La tablette a ici sa propre identité Firebase (SDK web, en temps réel) ; le reste de l'écran
// passe par l'app Android (Sync.java).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { initializeAppCheck, CustomProvider } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app-check.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc, collection, query, where,
  onSnapshot, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const app = initializeApp({
  apiKey: 'AIzaSyAvoivJR8p-u2VxUWzlyHzTgP20-5ZG_-E',
  authDomain: 'papote-famille.firebaseapp.com',
  projectId: 'papote-famille',
  storageBucket: 'papote-famille.firebasestorage.app',
  messagingSenderId: '807031084851',
  appId: '1:807031084851:web:b8048e2952cb1e893b1046',
});
// App Check : la tablette prouve qu'elle est une vraie tablette Papote (jeton fourni par l'app
// Android, PapoteAndroid.appCheckToken). Seulement si la tablette a reçu sa clé à l'installation ;
// sans clé, rien ne change. (Pas de « await » au premier niveau : les WebView d'avant 89 refusent tout le fichier.)
try {
  if (window.PapoteAndroid && window.PapoteAndroid.hasAppCheckKey && window.PapoteAndroid.hasAppCheckKey()) {
    initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: async () => {
          const t = JSON.parse(window.PapoteAndroid.appCheckToken() || 'null');
          if (!t || !t.token) throw new Error('pas de jeton App Check');
          return { token: t.token, expireTimeMillis: t.expireTimeMillis };
        },
      }),
      isTokenAutoRefreshEnabled: true,
    });
  }
} catch (e) {
  console.warn('App Check', e);
}
const auth = getAuth(app);
// Base Firestore : « (default) » (États-Unis) puis « eu » (Europe) après la migration.
// C'est l'app Android qui décide (pont firestoreDatabase()), la page suit au chargement.
function firestoreDatabase() {
  try {
    const name = window.PapoteAndroid && window.PapoteAndroid.firestoreDatabase
      ? String(window.PapoteAndroid.firestoreDatabase() || '').trim() : '';
    return name || '(default)';
  } catch (e) {
    return '(default)';
  }
}
const DATABASE = firestoreDatabase();
const db = DATABASE === '(default)' ? getFirestore(app) : getFirestore(app, DATABASE);

// Sans relais TURN, la vidéo ne passe pas entre deux réseaux différents (4G, box…).
// Le relais est décrit dans Firestore (config/turn), pas dans le code, qui est public :
//   { url: 'https://…' }  service qui renvoie la liste des relais (identifiants à jour, voir turn-worker/)
//   ou { urls: 'turn:… turn:…', username, credential }                       identifiants fixes
const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

// Relais gardé 30 minutes (identifiants valables 4 heures) : un appel part sans attendre.
let iceCache = null;
async function iceServers() {
  if (iceCache && Date.now() - iceCache.at < 30 * 60_000) return iceCache.value;
  const value = await loadIceServers();
  if (value.iceServers.length > STUN.length) iceCache = { at: Date.now(), value };
  return value;
}

async function loadIceServers() {
  try {
    const conf = (await getDoc(doc(db, 'config', 'turn'))).data() || {};
    // Tolérant aux saisies dans la console : liste ou texte, et une adresse https rangée
    // par erreur dans `urls` est prise pour l'adresse du service.
    const all = [].concat(conf.urls || []).join(' ').split(/[\s,]+/).filter(Boolean);
    const relayUrls = all.filter((u) => /^(stun|turns?):/.test(u));
    const serviceUrl = conf.url || all.find((u) => /^https:\/\//.test(u));
    let relays = [];
    if (relayUrls.length && conf.username) {
      relays = [{ urls: relayUrls, username: conf.username, credential: conf.credential }];
    }
    if (serviceUrl) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        // Le service des identifiants (Cloudflare) n'en donne qu'aux apps connectées.
        const token = auth.currentUser ? await auth.currentUser.getIdToken() : '';
        const res = await fetch(serviceUrl, { signal: ctrl.signal, headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) {
          const list = await res.json();
          if (Array.isArray(list) && list.length) relays = list;
        }
      } catch (e) {
        console.warn('Service des identifiants injoignable, relais de secours', e);
      } finally {
        clearTimeout(timer);
      }
    }
    if (Array.isArray(relays) && relays.length) return { iceServers: [...STUN, ...relays] };
  } catch (e) {
    console.warn('Relais TURN indisponible, appel sans relais', e);
  }
  return { iceServers: STUN };
}
// Relevé des appels qui échouent (fonction serveur incidentAppel), pour repérer les pannes.
let incidentFn = null;
function reportCallIncident(raison, detail = '', cid = null) {
  (async () => {
    if (!incidentFn) {
      const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js');
      incidentFn = httpsCallable(getFunctions(app, 'europe-west1'), 'incidentAppel');
    }
    await incidentFn({
      cote: 'tablette',
      raison: String(raison).slice(0, 60),
      detail: String(detail || '').slice(0, 300),
      cid,
      relais: !!(iceCache && iceCache.value.iceServers.length > STUN.length),
      navigateur: navigator.userAgent.slice(0, 200),
    });
  })().catch(() => {});
}

// Chemin de la liaison : « host » (même réseau), « srflx » (direct par internet) ou « relay ».
async function cheminChoisi(pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((r) => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r; });
    if (!pair) return 'inconnu';
    const local = stats.get(pair.localCandidateId) || {};
    const distant = stats.get(pair.remoteCandidateId) || {};
    return `${local.candidateType || '?'}/${local.protocol || '?'}-${distant.candidateType || '?'}`;
  } catch (e) {
    return 'inconnu';
  }
}

const FRESH_MS = 60_000; // un appel plus ancien n'est plus considéré comme en train de sonner
const FID_KEY = 'papote.appels.fid';

const $ = (id) => document.getElementById(id);
const android = () => window.PapoteAndroid;

let fid = null;
let ringing = null;  // { id, data }
let active = null;   // { id, pc, stream, stops }


function user() {
  return new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, (u) => { stop(); resolve(u); });
  });
}

// Compte de la tablette pour les appels : une adresse et un mot de passe créés une fois par
// l'app Android (pont callsAccount()). Plus de compte anonyme : la tablette se connecte avec
// ce compte (créé côté Firebase au premier démarrage), puis s'inscrit avec son code de tablette.
function callsAccount() {
  try {
    const account = JSON.parse(android().callsAccount());
    return account && account.email && account.password ? account : null;
  } catch (e) {
    return null;
  }
}

async function signIn() {
  const current = await user();
  const account = android() && android().callsAccount ? callsAccount() : null;
  if (!account) return null;
  if (current && !current.isAnonymous && current.email === account.email) return current;
  try {
    return (await signInWithEmailAndPassword(auth, account.email, account.password)).user;
  } catch (e) {
    if (e.code !== 'auth/invalid-credential' && e.code !== 'auth/user-not-found') throw e;
    // Premier démarrage : le compte n'existe pas encore.
    return (await createUserWithEmailAndPassword(auth, account.email, account.password)).user;
  }
}

// Jumelage (nouvelle tablette) : la tablette affiche un code, un responsable la réclame,
// puis elle confirme à l'écran. On attend en direct que pairings/{code} passe à « confirmed ».
// Renvoie le document de jumelage confirmé, ou null s'il est refusé ou expiré.
function waitPairing(pairing) {
  return new Promise((resolve) => {
    let stop = () => {};
    const done = (value) => { stop(); resolve(value); };
    stop = onSnapshot(doc(db, 'pairings', pairing), (snap) => {
      const data = snap.data();
      if (!data) { done(null); return; }
      if (data.status === 'confirmed' && data.fid) { done(data); return; }
      if (!['waiting', 'claimed'].includes(data.status)) done(null);
    }, (err) => {
      console.warn('Appels : jumelage illisible', err && err.code);
      done(null);
    });
  });
}

// La famille vient toujours du jumelage, jamais d'une famille d'avant gardée en mémoire :
// une tablette rejumelée chez un autre client ne doit pas rester dans l'ancienne famille.
async function joinByPairing(u, pairing) {
  const data = await waitPairing(pairing);
  if (!data) return null;
  const memberRef = doc(db, 'families', data.fid, 'members', u.uid);
  let member = null;
  try { member = await getDoc(memberRef); } catch (e) { /* pas encore membre */ }
  if (!member || !member.exists()) {
    // Les règles n'acceptent cette fiche que dans l'heure qui suit l'expiration du code.
    await setDoc(memberRef, {
      name: (data.name || 'Tablette').slice(0, 40), role: 'tablette', pairing, joinedAt: serverTimestamp(), canCall: true,
    });
  }
  try { localStorage.setItem(FID_KEY, data.fid); } catch (e) { /* pas de stockage */ }
  return data.fid;
}

async function joinFamily() {
  const u = await signIn();
  if (!u) return null;
  let saved = null;
  try { saved = localStorage.getItem(FID_KEY); } catch (e) { /* pas de stockage */ }
  const code = ((android() && android().getCode()) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // Un jumelage en cours ou fait passe avant un ancien code resté en mémoire.
  const pairing = android() && android().getPairing ? (android().getPairing() || '') : '';
  if (pairing) return joinByPairing(u, pairing);
  if (!saved && !code) return null;

  // Le code saisi à l'installation est un code de tablette (invites/{code}, kind 'tablette') :
  // le code famille ne permet plus d'y inscrire une tablette.
  let invite = null;
  const readInvite = async () => {
    if (!invite && code) invite = await getDoc(doc(db, 'invites', code));
    return invite && invite.exists() ? invite.data() : null;
  };
  let target = saved;
  if (!target) {
    const data = await readInvite();
    if (!data) return null;
    target = data.fid;
  }
  const memberRef = doc(db, 'families', target, 'members', u.uid);
  let member = null;
  try { member = await getDoc(memberRef); } catch (e) { /* pas encore membre */ }
  if (member && member.exists()) {
    if (!member.data().canCall) await updateDoc(memberRef, { canCall: true });
  } else {
    const data = await readInvite();
    if (!data || data.fid !== target || data.kind !== 'tablette') {
      console.warn('Appels : code de tablette absent ou invalide, inscription impossible');
      return null;
    }
    await setDoc(memberRef, {
      name: 'Tablette', role: 'tablette', code, joinedAt: serverTimestamp(), canCall: true,
    });
  }
  try { localStorage.setItem(FID_KEY, target); } catch (e) { /* pas de stockage */ }
  return target;
}

// ---------- Sonnerie ----------

const CAMERA = {
  // 4:3 comme le capteur (1600x1200) : sur la tablette UNISOC, le 16:9 est découpé sur un bord
  // et rate la personne assise en face.
  // 640x480 suffit pour voir Mamie sur un téléphone et ménage la carte SIM (avec capVideo).
  video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, aspectRatio: { ideal: 4 / 3 }, frameRate: { ideal: 20, max: 24 } },
  audio: { echoCancellation: true, noiseSuppression: true },
};

// Vidéo envoyée par la tablette plafonnée (~300 kbit/s, 20 images/s) : environ 350 Mo par heure
// de visio au total au lieu de ~550, soit ~14 h par mois avec 5 Go. À appeler après la négociation.
const VIDEO_MAX_BITRATE = 300_000;
function capVideo(pc) {
  try {
    pc.getSenders().forEach((s) => {
      if (!s.track || s.track.kind !== 'video' || !s.getParameters) return;
      const p = s.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
      p.encodings[0].maxFramerate = 20;
      s.setParameters(p).catch(() => {});
    });
  } catch (e) { /* navigateur trop ancien : pas de plafond */ }
}

function showRing(id, data) {
  ringing = { id, data };
  if (window.Papote && window.Papote.closeOverlayForCall) window.Papote.closeOverlayForCall();
  $('ring-name').textContent = data.callerName;
  $('call-ring').hidden = false;
  if (android()) android().ring(true);
  stopPresence(); // la caméra passe à la sonnerie
  showCallerFace(id, data.callerUid);
  watchFace();
}

// Photo de profil de l'appelant (rond JPEG), à côté de son prénom ; sans photo, le prénom seul.
async function showCallerFace(callId, uid) {
  ['ring-caller', 'call-wait-face'].forEach((el) => { $(el).hidden = true; $(el).removeAttribute('src'); });
  if (!uid) return;
  let face = null;
  try {
    const snap = await getDoc(doc(db, 'families', fid, 'members', uid));
    face = snap.exists() ? snap.data().face : null;
  } catch (e) { /* pas de photo */ }
  if (!face || typeof face !== 'string' || !face.startsWith('data:image/')) return;
  if (!(ringing && ringing.id === callId) && !(active && active.id === callId)) return;
  ['ring-caller', 'call-wait-face'].forEach((el) => { $(el).src = face; $(el).hidden = false; });
}

// `keepStream` : la caméra déjà ouverte sert pour l'appel qu'on vient de décrocher.
function hideRing(keepStream) {
  ringing = null;
  $('call-ring').hidden = true;
  if (android()) android().ring(false);
  return stopFaceWatch(keepStream);
}

// ---------- Décrocher en regardant l'écran ----------
// Pendant la sonnerie, la caméra s'allume et Mamie se voit dans le rond.
// Dès qu'un visage reste bien en face un petit moment, l'appel est décroché.
// L'image est analysée sur la tablette, rien n'est envoyé. Si la détection
// ne se charge pas, le bouton « Décrocher » reste là.

const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
const FACE_HOLD_MS = 1200;   // visage vu sans interruption pendant ce temps
const FACE_MIN_WIDTH = 0.12; // visage assez grand : quelqu'un devant la tablette, pas au fond de la pièce

let detectorPromise = null;
let faceWatch = null; // { stream, timer, since }

function faceDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const { FilesetResolver, FaceDetector } = await import(`${VISION}/vision_bundle.mjs`);
      const files = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
      return FaceDetector.createFromOptions(files, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'CPU' },
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.6,
      });
    })().catch((e) => {
      console.warn('Détection du visage indisponible', e);
      detectorPromise = null;
      return null;
    });
  }
  return detectorPromise;
}

// Pour l'écran Bienvenue (« Placez la tablette ») : le même détecteur, et une aide qui passe
// par une copie réduite de l'image. Sur la tablette UNISOC, analyser la <video> directement
// échoue (erreurs graphiques) : préférer papoteLocateFace.
window.papoteFaceDetector = faceDetector;
const locateFrame = document.createElement('canvas');
// Renvoie le visage le plus grand { x, y, width, height } en fractions de l'image (0 à 1), ou null.
window.papoteLocateFace = async (video) => {
  const detector = await faceDetector();
  if (!detector || !video || video.readyState < 2 || !video.videoWidth) return null;
  const k = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
  locateFrame.width = Math.round(video.videoWidth * k);
  locateFrame.height = Math.round(video.videoHeight * k);
  locateFrame.getContext('2d').drawImage(video, 0, 0, locateFrame.width, locateFrame.height);
  const { detections } = detector.detectForVideo(locateFrame, performance.now());
  const box = detections
    .map((d) => d.boundingBox)
    .filter(Boolean)
    .sort((a, c) => c.width * c.height - a.width * a.height)[0];
  if (!box) return null;
  return {
    x: box.originX / locateFrame.width,
    y: box.originY / locateFrame.height,
    width: box.width / locateFrame.width,
    height: box.height / locateFrame.height,
  };
};

// Renvoie une fonction qui dit si un visage est bien en face sur l'image actuelle de `video`.
// L'image est réduite (plus rapide sur une petite tablette) et, si aucun visage n'est vu,
// essayée tournée d'un quart de tour : avec la caméra sur le côté, certaines tablettes
// livrent une image couchée. Le bon sens trouvé est gardé ; sinon on passe au suivant.
function makeLooker(video, detector) {
  const frame = document.createElement('canvas');
  const fctx = frame.getContext('2d');
  const angles = [0, 90, 270];
  let turn = 0;
  const lookAt = (angle) => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    const k = Math.min(1, 480 / Math.max(w, h));
    const fw = Math.round(w * k);
    const fh = Math.round(h * k);
    const side = angle === 0 ? fw : fh;
    frame.width = side;
    frame.height = angle === 0 ? fh : fw;
    fctx.save();
    fctx.translate(frame.width / 2, frame.height / 2);
    fctx.rotate((angle * Math.PI) / 180);
    fctx.drawImage(video, -fw / 2, -fh / 2, fw, fh);
    fctx.restore();
    const { detections } = detector.detectForVideo(frame, performance.now());
    return detections.some((d) => d.boundingBox && d.boundingBox.width / side >= FACE_MIN_WIDTH);
  };
  return () => {
    const seen = lookAt(angles[turn]);
    if (!seen) turn = (turn + 1) % angles.length;
    return seen;
  };
}

async function watchFace() {
  const callId = ringing && ringing.id;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(CAMERA);
  } catch (e) {
    console.warn('Caméra indisponible pendant la sonnerie', e);
    return;
  }
  if (!ringing || ringing.id !== callId || faceWatch) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  // Le micro attend l'appel : on ne l'ouvre que pour éviter une deuxième demande.
  stream.getAudioTracks().forEach((t) => { t.enabled = false; });
  const video = $('ring-face');
  video.srcObject = stream;
  video.hidden = false;
  faceWatch = { stream, timer: null, since: 0 };

  const detector = await faceDetector();
  if (!detector || !faceWatch || faceWatch.stream !== stream) return;
  $('ring-hint').hidden = false;

  const look = makeLooker(video, detector);

  const tick = () => {
    if (!faceWatch || faceWatch.stream !== stream) return;
    if (video.readyState >= 2 && video.videoWidth) {
      let seen = false;
      try {
        seen = look();
      } catch (e) {
        console.warn('Détection du visage', e);
      }
      const now = Date.now();
      faceWatch.since = seen ? (faceWatch.since || now) : 0;
      video.classList.toggle('seen', seen);
      if (seen && now - faceWatch.since >= FACE_HOLD_MS) {
        answer();
        return;
      }
    }
    faceWatch.timer = setTimeout(tick, 150);
  };
  tick();
}

function stopFaceWatch(keepStream) {
  const watch = faceWatch;
  faceWatch = null;
  const video = $('ring-face');
  video.hidden = true;
  video.classList.remove('seen');
  video.srcObject = null;
  $('ring-hint').hidden = true;
  if (!keepStream) setTimeout(startPresence, 500); // sonnerie finie sans appel : on reprend
  if (!watch) return null;
  clearTimeout(watch.timer);
  if (keepStream) {
    watch.stream.getAudioTracks().forEach((t) => { t.enabled = true; });
    return watch.stream;
  }
  watch.stream.getTracks().forEach((t) => t.stop());
  return null;
}

// ---------- Présence devant l'écran ----------
// Pour tablette.js : un envoi ou un rappel affiché se ferme tout seul un moment après que
// Mamie a été vue. window.papoteWatchPresence(onSeen) renvoie stop(). La caméra (image seule,
// sans micro) est partagée entre les surveillances, et laissée à la sonnerie quand un appel arrive.

const presence = { watchers: new Set(), stream: null, video: null, timer: null, starting: false };

window.papoteWatchPresence = (onSeen) => {
  const watcher = { onSeen, since: 0, done: false };
  presence.watchers.add(watcher);
  startPresence();
  return () => {
    presence.watchers.delete(watcher);
    if (!presence.watchers.size) stopPresence();
  };
};

async function startPresence() {
  if (presence.stream || presence.starting || ringing || active) return;
  if (![...presence.watchers].some((w) => !w.done)) return;
  presence.starting = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: CAMERA.video, audio: false });
    if (!presence.watchers.size || ringing || active) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.play().catch(() => {});
    presence.stream = stream;
    presence.video = video;

    const detector = await faceDetector();
    if (!detector || presence.stream !== stream) return;
    const look = makeLooker(video, detector);
    const tick = () => {
      if (presence.stream !== stream) return;
      if (video.readyState >= 2 && video.videoWidth) {
        let seen = false;
        try { seen = look(); } catch (e) { console.warn('Présence : détection', e); }
        const now = Date.now();
        presence.watchers.forEach((w) => {
          if (w.done) return;
          w.since = seen ? (w.since || now) : 0;
          if (seen && now - w.since >= FACE_HOLD_MS) {
            w.done = true;
            try { w.onSeen(); } catch (e) { console.warn('Présence : onSeen', e); }
          }
        });
        // Tout le monde a été servi : la caméra s'éteint.
        if (![...presence.watchers].some((w) => !w.done)) { stopPresence(); return; }
      }
      presence.timer = setTimeout(tick, 500);
    };
    tick();
  } catch (e) {
    console.warn('Présence : caméra indisponible', e);
  } finally {
    presence.starting = false;
  }
}

function stopPresence() {
  clearTimeout(presence.timer);
  if (presence.stream) presence.stream.getTracks().forEach((t) => t.stop());
  if (presence.video) presence.video.srcObject = null;
  presence.stream = null;
  presence.video = null;
}

// ---------- Pause (abonnement suspendu) ----------
// L'app Android met window.papotePaused à true pendant la pause.

const paused = () => window.papotePaused === true;

function refuseCall(id) {
  updateDoc(doc(db, 'families', fid, 'calls', id), { state: 'missed', endedAt: serverTimestamp() }).catch(() => {});
}

// La pause peut commencer pendant une sonnerie ou un appel : on coupe aussitôt.
setInterval(() => {
  if (!paused()) return;
  if (ringing) {
    const { id } = ringing;
    hideRing();
    refuseCall(id);
  }
  if (active) (active.finish ? active.finish('failed', 'ended') : hangup(''));
}, 2000);

// Au démarrage, la tablette n'est en communication avec personne : un appel resté
// « décroché » (coupure, redémarrage) est terminé pour ne pas bloquer les suivants.
async function closeStaleCalls() {
  try {
    const snap = await getDocs(query(collection(db, 'families', fid, 'calls'), where('state', '==', 'accepted')));
    snap.docs.forEach((d) => {
      if (active && active.id === d.id) return;
      updateDoc(d.ref, { state: 'ended', endedAt: serverTimestamp() }).catch(() => {});
    });
  } catch (e) {
    console.warn('Appels : nettoyage des appels oubliés', e && e.code);
  }
}

function watchCalls() {
  const q = query(collection(db, 'families', fid, 'calls'), where('state', '==', 'ringing'));
  onSnapshot(q, (snap) => {
    const now = Date.now();
    const fresh = snap.docs.filter((d) => {
      const data = d.data({ serverTimestamps: 'estimate' });
      const mine = auth.currentUser && data.callerUid === auth.currentUser.uid;
      return !mine && !data.calleeUid && data.createdAt && now - data.createdAt.toMillis() < FRESH_MS;
    });
    // Abonnement suspendu : la tablette est en pause, aucun appel. L'appelant voit « Pas de réponse ».
    if (paused()) {
      fresh.forEach((d) => refuseCall(d.id));
      return;
    }
    // L'appel qui sonnait a été annulé par l'appelant.
    if (ringing && !fresh.some((d) => d.id === ringing.id)) hideRing();
    // Déjà en communication : un deuxième appel est refusé tout de suite (« Pas de réponse »).
    const current = (active && active.id) || (ringing && ringing.id);
    if (current) fresh.filter((d) => d.id !== current).forEach((d) => refuseCall(d.id));
    if (!ringing && !active && fresh.length) {
      const latest = fresh[fresh.length - 1];
      showRing(latest.id, latest.data());
    }
  }, (err) => console.error('Écoute des appels', err));
}

// ---------- Appel ----------

// Tant que la vidéo de la famille n'est pas là, l'écran d'attente reste affiché.
function setStatus(text) {
  $('call-status').textContent = text;
  if (text) $('call-wait').hidden = false;
}

async function answer() {
  if (!ringing || paused()) return;
  const { id, data } = ringing;
  let stream = hideRing(true);
  const callRef = doc(db, 'families', fid, 'calls', id);
  $('call-wait-name').textContent = data.callerName;
  $('call-wait').hidden = false;
  $('call-view').hidden = false;
  setStatus('Connexion…');
  if (android()) android().inCall(true);

  try {
    if (!stream) stream = await navigator.mediaDevices.getUserMedia(CAMERA);
  } catch (e) {
    console.error(e);
    reportCallIncident('camera', `${e && e.name}: ${e && e.message}`, id);
    setStatus('La caméra ne répond pas.');
    updateDoc(callRef, { state: 'ended', endedAt: serverTimestamp() }).catch(() => {});
    setTimeout(closeView, 3000);
    return;
  }
  $('call-local').srcObject = stream;

  const pc = new RTCPeerConnection(await iceServers());
  active = { id, pc, stream, stops: [] };
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  pc.ontrack = (e) => {
    $('call-remote').srcObject = e.streams[0];
    $('call-remote').play().catch(() => {});
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) addDoc(collection(callRef, 'calleeCandidates'), e.candidate.toJSON()).catch(() => {});
  };
  // Si la famille disparaît sans raccrocher (app fermée, réseau coupé), la caméra de Mamie
  // ne reste pas allumée : on raccroche après quelques secondes sans liaison.
  let lostTimer = null;
  pc.onconnectionstatechange = () => {
    clearTimeout(lostTimer);
    if (pc.connectionState === 'connected') { $('call-status').textContent = ''; capVideo(pc); }
    if (pc.connectionState === 'disconnected') lostTimer = setTimeout(() => {
      reportCallIncident('video-coupee', 'liaison perdue 8 s', id);
      hangup('La connexion a été perdue.');
    }, 8000);
    if (pc.connectionState === 'failed') {
      reportCallIncident('liaison-video', `ice=${pc.iceConnectionState}`, id);
      hangup('La connexion a été perdue.');
    }
  };

  await pc.setRemoteDescription(data.offer);
  const reply = await pc.createAnswer();
  await pc.setLocalDescription(reply);
  capVideo(pc);
  await updateDoc(callRef, { answer: { type: reply.type, sdp: reply.sdp }, state: 'accepted' });

  active.stops.push(onSnapshot(collection(callRef, 'callerCandidates'), (snap) => {
    snap.docChanges().forEach((c) => {
      if (c.type === 'added') pc.addIceCandidate(c.doc.data()).catch(() => {});
    });
  }));
  active.stops.push(onSnapshot(callRef, (snap) => {
    const state = snap.data() && snap.data().state;
    if (state === 'ended' || state === 'missed') hangup('Appel terminé', true);
  }));
}

function hangup(message, remoteEnded) {
  if (!active) return;
  const { id, pc, stream, stops } = active;
  active = null;
  stops.forEach((stop) => stop());
  pc.close();
  stream.getTracks().forEach((t) => t.stop());
  if (!remoteEnded) {
    updateDoc(doc(db, 'families', fid, 'calls', id), { state: 'ended', endedAt: serverTimestamp() }).catch(() => {});
  }
  setStatus(message || 'Appel terminé');
  setTimeout(closeView, 2000);
}

function closeView() {
  setTimeout(startPresence, 500);
  $('call-view').hidden = true;
  $('call-wait').hidden = false;
  $('call-remote').srcObject = null;
  $('call-local').srcObject = null;
  if (android()) android().inCall(false);
}

// ---------- Appel de Mamie vers la famille (audio seulement) ----------
// window.papoteCallFamily({ to, onState }) -> { hangup() } pour tablette.js.
//   to : uid d'un proche, ou null pour toute la famille (le premier qui décroche a l'appel).
//   onState(state, info) : 'ringing' { names } | 'connected' { uid, name, face } | 'ended'
//                          | 'missed' | 'busy' | 'failed'.
// Le proche qui décroche écrit son uid et son prénom dans answer (seul champ modifiable).

const OUT_RING_MS = 60_000; // le temps qu'un téléphone ouvre l'app depuis la notification

async function familyPeople() {
  const snap = await getDocs(collection(db, 'families', fid, 'members'));
  return snap.docs
    .map((d) => ({ uid: d.id, ...d.data() }))
    .filter((m) => m.role === 'famille' && (m.status === undefined || m.status === 'active'));
}

window.papoteCallFamily = ({ to = null, toName = null, onState = () => {} } = {}) => {
  let done = false;
  let call = null; // { ref, pc, stream, stops, timer, audio }
  const emit = (state, info = {}) => {
    try { onState(state, info); } catch (e) { console.warn('Appel sortant : onState', e); }
  };
  const finish = (state, notify, info) => {
    if (done) return;
    done = true;
    if (call) {
      clearTimeout(call.timer);
      clearTimeout(call.lostTimer);
      call.stops.forEach((stop) => stop());
      if (call.pc) call.pc.close();
      if (call.stream) call.stream.getTracks().forEach((t) => t.stop());
      if (call.audio) call.audio.srcObject = null;
      if (call.cam) call.cam.getTracks().forEach((t) => t.stop());
      if (call.cam || !$('call-out-hangup').hidden) {
        $('call-out-hangup').hidden = true;
        $('call-view').hidden = true;
        $('call-remote').srcObject = null;
        $('call-local').srcObject = null;
      }
      // L'appel est peut-être encore en cours d'écriture : on attend qu'il existe pour le clore.
      if (notify && call.ref) {
        (call.ready || Promise.resolve()).then(() => updateDoc(call.ref, { state: notify, endedAt: serverTimestamp() })).catch(() => {});
      }
    }
    if (active && active.outgoing) active = null;
    if (android()) android().inCall(false);
    setTimeout(startPresence, 500);
    emit(state, info);
  };

  (async () => {
    if (paused() || !fid || !auth.currentUser) { finish('failed'); return; }
    if (active || ringing) { finish('busy'); return; }
    stopPresence();
    call = { ref: null, pc: null, stream: null, stops: [], timer: null, lostTimer: null, audio: null, video: null, cam: null };
    active = { id: null, outgoing: true, finish, stops: call.stops };
    if (android()) android().inCall(true);

    // L'appel est écrit TOUT DE SUITE, sans offre : les téléphones sonnent pendant que la tablette
    // ouvre le micro et prépare la liaison. L'offre suit dans le même document (le proche l'attend
    // s'il répond très vite).
    const t0 = performance.now();
    const ref = doc(collection(db, 'families', fid, 'calls'));
    call.ref = ref;
    active.id = ref.id;
    const familyName = familyNameCache || 'Mamie';
    call.ready = setDoc(ref, {
      callerUid: auth.currentUser.uid,
      callerName: familyName,
      calleeUid: to || null, // jamais toute la famille par erreur
      calleeName: toName || null,
      state: 'ringing',
      offer: null,
      answer: null,
      createdAt: serverTimestamp(),
      endedAt: null,
    });

    // En même temps : micro, relais (déjà en mémoire) et la fiche du proche appelé.
    // La liste de la famille (avec les photos, lourde) se lit à côté.
    const peopleP = familyPeople().catch(() => []);
    // « Ça sonne » dès que l'appel est écrit (les téléphones sont prévenus à ce moment-là).
    call.ready.then(() => {
      if (done) return;
      emit('ringing', { names: toName ? [toName] : [] });
      call.timer = setTimeout(() => finish('missed', 'missed'), OUT_RING_MS);
    }).catch(() => {});
    const [, stream, ice, target] = await Promise.all([
      call.ready,
      navigator.mediaDevices.getUserMedia({ audio: CAMERA.audio, video: false }),
      iceServers(),
      to ? getDoc(doc(db, 'families', fid, 'members', to)).then((d) => (d.exists() ? { uid: d.id, ...d.data() } : null)).catch(() => null) : null,
    ]);
    call.stream = stream;
    if (done) { call.stream.getTracks().forEach((t) => t.stop()); return; }
    const tEcrit = Math.round(performance.now() - t0);
    peopleP.then((people) => { if (!done && !call.answered) emit('ringing', { names: (target ? [target] : people).map((m) => m.name) }); });
    const pc = new RTCPeerConnection(ice);
    call.pc = pc;
    if (done) { pc.close(); return; }
    call.stream.getTracks().forEach((t) => pc.addTrack(t, call.stream));
    // Une voie vidéo prévue dès le départ, vide : le proche peut allumer sa caméra pendant
    // l'appel sans renégociation, et la tablette répond alors avec la sienne.
    call.video = pc.addTransceiver('video', { direction: 'sendrecv' });
    call.audio = new Audio();
    call.audio.autoplay = true;
    pc.ontrack = (e) => {
      if (e.track.kind === 'audio') {
        call.audio.srcObject = e.streams[0] || new MediaStream([e.track]);
        call.audio.play().catch(() => {});
        return;
      }
      // Voie vidéo du proche, gardée de côté. La caméra de Mamie ne s'allume JAMAIS d'elle-même :
      // seulement quand le proche a appuyé sur « Passer en vidéo » (answer.video, plus bas).
      call.remoteVideo = e.track;
    };
    const startOutgoingVideo = async (remoteTrack) => {
      if (done || call.cam || call.videoStarting) return;
      call.videoStarting = true;
      try {
        call.cam = await navigator.mediaDevices.getUserMedia({ video: CAMERA.video, audio: false });
      } catch (e) {
        reportCallIncident('camera-sortant', `${e && e.name}: ${e && e.message}`, call.ref && call.ref.id);
        call.cam = null;
      }
      if (done) { if (call.cam) call.cam.getTracks().forEach((t) => t.stop()); return; }
      if (call.cam) call.video.sender.replaceTrack(call.cam.getVideoTracks()[0]).then(() => capVideo(call.pc)).catch(() => {});
      $('call-remote').srcObject = new MediaStream([remoteTrack]);
      $('call-local').srcObject = call.cam;
      $('call-wait').hidden = true;
      $('call-out-hangup').hidden = false;
      $('call-view').hidden = false;
      emit('video', {});
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) addDoc(collection(ref, 'callerCandidates'), e.candidate.toJSON()).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      clearTimeout(call.lostTimer);
      // Mise en relation lente (de la réponse du proche à la liaison) : détail et chemin notés.
      if (pc.connectionState === 'connected' && call.answeredAt) {
        const ms = Math.round(performance.now() - call.answeredAt);
        if (ms > 3000) cheminChoisi(pc).then((chemin) => reportCallIncident('lent', `liaison=${ms}ms chemin=${chemin}`, ref.id));
      }
      if (pc.connectionState === 'disconnected') call.lostTimer = setTimeout(() => {
        reportCallIncident('audio-coupe', 'liaison perdue 8 s', ref.id);
        finish('ended', 'ended');
      }, 8000);
      if (pc.connectionState === 'failed') {
        reportCallIncident('liaison-audio', `ice=${pc.iceConnectionState}`, ref.id);
        finish('failed', 'ended');
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (done) return;
    await updateDoc(ref, { offer: { type: offer.type, sdp: offer.sdp } });
    const tOffre = Math.round(performance.now() - t0);
    if (tOffre > 3000) reportCallIncident('depart-lent', `appel-ecrit+micro=${tEcrit}ms offre=${tOffre}ms`, ref.id);

    // Les candidats du proche peuvent arriver avant sa réponse : on les garde jusque-là
    // (sinon ils sont refusés et la liaison échoue une fois sur deux).
    let answered = false;
    const early = [];
    call.stops.push(onSnapshot(ref, async (snap) => {
      const data = snap.data();
      if (!data || done) return;
      if (data.answer && !answered) {
        answered = true;
        call.answered = true;
        call.answeredAt = performance.now();
        clearTimeout(call.timer);
        try {
          await pc.setRemoteDescription({ type: data.answer.type, sdp: data.answer.sdp });
        } catch (e) {
          finish('failed', 'ended');
          return;
        }
        early.splice(0).forEach((c) => pc.addIceCandidate(c).catch(() => {}));
        // La photo du proche si la liste est déjà là (au plus 1,5 s d'attente), sinon son prénom seul.
        const people = await Promise.race([peopleP, new Promise((r) => setTimeout(() => r([]), 1500))]);
        const who = people.find((m) => m.uid === data.answer.uid) || (target && target.uid === data.answer.uid ? target : {});
        emit('connected', { uid: data.answer.uid || null, name: data.answer.name || who.name || '', face: who.face || null });
      }
      // Le proche a allumé sa caméra (geste volontaire sur son téléphone) : Mamie passe en vidéo.
      if (answered && data.answer && data.answer.video === true && !call.cam && call.remoteVideo) {
        startOutgoingVideo(call.remoteVideo);
      }
      if (data.state === 'ended') finish('ended');
      if (data.state === 'declined' || data.state === 'missed') finish('missed');
    }));
    call.stops.push(onSnapshot(collection(ref, 'calleeCandidates'), (snap) => {
      snap.docChanges().forEach((c) => {
        if (c.type !== 'added') return;
        if (pc.remoteDescription) pc.addIceCandidate(c.doc.data()).catch(() => {});
        else early.push(c.doc.data());
      });
    }));
  })().catch((e) => {
    console.warn('Appel sortant', e);
    reportCallIncident('depart-audio', `${e && e.name}: ${e && e.message}`, call && call.ref ? call.ref.id : null);
    finish('failed', call && call.ref ? 'ended' : null);
  });

  return { hangup: () => finish('ended', 'ended') };
};

// Maintenance : la tablette quitte la famille (commande ADB « leave »).
window.papoteAppelsLeave = async () => {
  try {
    const u = auth.currentUser;
    if (fid && u) await deleteDoc(doc(db, 'families', fid, 'members', u.uid));
  } catch (e) { console.error(e); }
  try { localStorage.removeItem(FID_KEY); } catch (e) { /* pas de stockage */ }
  fid = null;
};

$('ring-answer').addEventListener('click', answer);
$('call-out-hangup').addEventListener('click', () => { if (active && active.finish) active.finish('ended', 'ended'); });
$('call-remote').addEventListener('playing', () => { if (active) $('call-wait').hidden = true; });

// Écoute en direct du marqueur de changement : la tablette se met à jour aussitôt,
// et l'app Android peut espacer ses vérifications (moins de lectures, donc moins de coûts).
// Nom de la famille (« Mamie »), gardé pour les appels sortants : pas de lecture au moment d'appeler.
let familyNameCache = '';

function watchFamily() {
  let first = true;
  onSnapshot(doc(db, 'families', fid), (snap) => {
    familyNameCache = (snap.data() && snap.data().name) || familyNameCache;
    if (first) { first = false; return; }
    if (android() && android().changed) android().changed();
  }, (err) => {
    console.error('Écoute de la famille', err);
    if (android() && android().realtime) android().realtime(false);
  });
  if (android() && android().realtime) android().realtime(true);
}

async function start() {
  try {
    fid = await joinFamily();
  } catch (e) {
    console.error('Appels : connexion impossible', e);
  }
  if (!fid) {
    setTimeout(start, 60_000); // tablette pas encore reliée ou hors ligne : on réessaie
    return;
  }
  closeStaleCalls();
  watchCalls();
  iceServers().catch(() => {}); // relais prêt avant le premier appel
  // Détection du visage chargée à l'avance (puis gardée en cache) pour décrocher sans attendre.
  setTimeout(faceDetector, 20_000);
  watchFamily();
}

// Sur une tablette faite pour être tenue debout, la caméra se retrouve sur le côté une fois
// couchée. On range alors Mamie (son rond et sa petite vidéo) du côté de la caméra :
// elle regarde vers l'objectif et se voit de face.
function placeCamera() {
  const o = screen.orientation;
  const angle = o ? o.angle : (window.orientation || 0);
  const landscape = o ? o.type.startsWith('landscape') : window.innerWidth > window.innerHeight;
  // Paysage à 90° ou 270° : la tablette est « debout » à l'origine, caméra sur le bord court.
  const side = landscape && angle === 90 ? 'left' : landscape && angle === 270 ? 'right' : '';
  document.body.classList.toggle('cam-left', side === 'left');
  document.body.classList.toggle('cam-right', side === 'right');
}
placeCamera();
if (screen.orientation) screen.orientation.addEventListener('change', placeCamera);
else window.addEventListener('orientationchange', placeCamera);

start();
