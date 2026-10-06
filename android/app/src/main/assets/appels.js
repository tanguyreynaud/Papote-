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

const ICE_SERVERS = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};
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

  let target = saved;
  if (!target) {
    const invite = await getDoc(doc(db, 'invites', code));
    if (!invite.exists()) return null;
    target = invite.data().fid;
  }
  const memberRef = doc(db, 'families', target, 'members', u.uid);
  let member = null;
  try { member = await getDoc(memberRef); } catch (e) { /* pas encore membre */ }
  if (member && member.exists()) {
    if (!member.data().canCall) await updateDoc(memberRef, { canCall: true });
  } else {
    if (!code) return null;
    await setDoc(memberRef, {
      name: 'Tablette', role: 'tablette', code, joinedAt: serverTimestamp(), canCall: true,
    });
  }
  try { localStorage.setItem(FID_KEY, target); } catch (e) { /* pas de stockage */ }
  return target;
}

// ---------- Sonnerie ----------

function showRing(id, data) {
  ringing = { id, data };
  if (window.Papote && window.Papote.closeOverlayForCall) window.Papote.closeOverlayForCall();
  $('ring-name').textContent = `${data.callerName} vous appelle`;
  $('call-ring').hidden = false;
  if (android()) android().ring(true);
}

function hideRing() {
  ringing = null;
  $('call-ring').hidden = true;
  if (android()) android().ring(false);
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

function setStatus(text) {
  $('call-status').textContent = text;
  $('call-status').hidden = !text;
}

async function answer() {
  if (!ringing) return;
  const { id, data } = ringing;
  hideRing();
  const callRef = doc(db, 'families', fid, 'calls', id);
  $('call-view').hidden = false;
  setStatus('Connexion…');
  if (android()) android().inCall(true);

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    console.error(e);
    setStatus('La caméra ne répond pas.');
    updateDoc(callRef, { state: 'ended', endedAt: serverTimestamp() }).catch(() => {});
    setTimeout(closeView, 3000);
    return;
  }
  $('call-local').srcObject = stream;

  const pc = new RTCPeerConnection(ICE_SERVERS);
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
    if (pc.connectionState === 'connected') setStatus('');
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
  $('call-remote').srcObject = null;
  $('call-local').srcObject = null;
  if (android()) android().inCall(false);
}

function decline() {
  if (!ringing) return;
  updateDoc(doc(db, 'families', fid, 'calls', ringing.id), { state: 'declined', endedAt: serverTimestamp() }).catch(() => {});
  hideRing();
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
$('ring-decline').addEventListener('click', decline);
$('call-hangup').addEventListener('click', () => hangup());

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
  watchFamily();
}

start();
