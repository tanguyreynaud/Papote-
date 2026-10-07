// Appels vidéo sur la tablette : sonnerie, « Décrocher », appel en WebRTC.
// Chargé seulement si le navigateur de la tablette sait faire de la vidéo (Android 5 et plus, à jour).
// La tablette a ici sa propre identité Firebase (SDK web, en temps réel) ; le reste de l'écran
// passe par l'app Android (Sync.java).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc, collection, query, where,
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
const auth = getAuth(app);
const db = getFirestore(app);

// Sans relais TURN, la vidéo ne passe pas entre deux réseaux différents (4G, box…).
// Le relais est décrit dans Firestore (config/turn), pas dans le code, qui est public :
//   { url: 'https://…' }  service qui renvoie la liste des relais (identifiants à jour, voir turn-worker/)
//   ou { urls: 'turn:… turn:…', username, credential }                       identifiants fixes
const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

async function iceServers() {
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

async function joinFamily() {
  const u = (await user()) || (await signInAnonymously(auth)).user;
  let saved = null;
  try { saved = localStorage.getItem(FID_KEY); } catch (e) { /* pas de stockage */ }
  const code = ((android() && android().getCode()) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
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
  video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
  audio: { echoCancellation: true, noiseSuppression: true },
};

function showRing(id, data) {
  ringing = { id, data };
  if (window.Papote && window.Papote.closeOverlayForCall) window.Papote.closeOverlayForCall();
  $('ring-name').textContent = data.callerName;
  $('call-ring').hidden = false;
  if (android()) android().ring(true);
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

  // L'image est réduite (plus rapide sur une petite tablette) et, si aucun visage n'est vu,
  // essayée tournée d'un quart de tour : avec la caméra sur le côté, certaines tablettes
  // livrent une image couchée.
  const frame = document.createElement('canvas');
  const fctx = frame.getContext('2d');
  const angles = [0, 90, 270];
  let turn = 0;
  const look = (angle) => {
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

  const tick = () => {
    if (!faceWatch || faceWatch.stream !== stream) return;
    if (video.readyState >= 2 && video.videoWidth) {
      let seen = false;
      try {
        // Le bon sens trouvé est gardé ; sinon on passe au suivant à chaque coup d'œil.
        seen = look(angles[turn]);
        if (!seen) turn = (turn + 1) % angles.length;
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
  if (!watch) return null;
  clearTimeout(watch.timer);
  if (keepStream) {
    watch.stream.getAudioTracks().forEach((t) => { t.enabled = true; });
    return watch.stream;
  }
  watch.stream.getTracks().forEach((t) => t.stop());
  return null;
}

function watchCalls() {
  const q = query(collection(db, 'families', fid, 'calls'), where('state', '==', 'ringing'));
  onSnapshot(q, (snap) => {
    const now = Date.now();
    const fresh = snap.docs.filter((d) => {
      const data = d.data({ serverTimestamps: 'estimate' });
      return !data.calleeUid && data.createdAt && now - data.createdAt.toMillis() < FRESH_MS;
    });
    // L'appel qui sonnait a été annulé par l'appelant.
    if (ringing && !fresh.some((d) => d.id === ringing.id)) hideRing();
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
  if (!ringing) return;
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
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') $('call-status').textContent = '';
    if (pc.connectionState === 'failed') hangup('La connexion a été perdue.');
  };

  await pc.setRemoteDescription(data.offer);
  const reply = await pc.createAnswer();
  await pc.setLocalDescription(reply);
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
  $('call-view').hidden = true;
  $('call-wait').hidden = false;
  $('call-remote').srcObject = null;
  $('call-local').srcObject = null;
  if (android()) android().inCall(false);
}

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
$('call-remote').addEventListener('playing', () => { if (active) $('call-wait').hidden = true; });

// Écoute en direct du marqueur de changement : la tablette se met à jour aussitôt,
// et l'app Android peut espacer ses vérifications (moins de lectures, donc moins de coûts).
function watchFamily() {
  let first = true;
  onSnapshot(doc(db, 'families', fid), () => {
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
  watchCalls();
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
