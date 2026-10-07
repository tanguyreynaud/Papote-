// Appel vidéo de la famille vers la tablette, en WebRTC.
// La signalisation passe par Firestore : families/{fid}/calls/{cid} et ses sous-collections de candidats.
import {
  db, auth, doc, getDoc, collection, setDoc, addDoc, updateDoc, onSnapshot, serverTimestamp,
} from './firebase.js';

// Sans relais TURN, la vidéo ne passe pas entre deux réseaux différents (4G, box…).
// Le relais est décrit dans Firestore (config/turn), pas dans le code, qui est public :
//   { url: 'https://…' }  service qui renvoie la liste des relais (identifiants à jour, voir turn-worker/)
//   ou { urls: 'turn:… turn:…', username, credential }                       identifiants fixes
const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

async function iceServers() {
  try {
    const conf = (await getDoc(doc(db, 'config', 'turn'))).data() || {};
    let relays = [];
    if (conf.urls && conf.username) {
      relays = [{ urls: String(conf.urls).split(/[\s,]+/).filter(Boolean), username: conf.username, credential: conf.credential }];
    }
    if (conf.url) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        // Le service des identifiants (Cloudflare) n'en donne qu'aux apps connectées.
        const token = auth.currentUser ? await auth.currentUser.getIdToken() : '';
        const res = await fetch(conf.url, { signal: ctrl.signal, headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) relays = await res.json();
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

const RING_TIMEOUT_MS = 45_000;

/**
 * Lance un appel. `ui` reçoit les vidéos et les changements d'état :
 *   ui.local / ui.remote : éléments <video>
 *   ui.onState(state)    : 'ringing' | 'accepted' | 'connected'
 *   ui.onEnd(reason)     : 'ended' | 'declined' | 'missed' | 'failed'
 * Renvoie { hangup() }.
 */
export async function startCall(fid, caller, ui) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  ui.local.srcObject = stream;

  const pc = new RTCPeerConnection(await iceServers());
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  pc.ontrack = (e) => {
    ui.remote.srcObject = e.streams[0];
    ui.remote.play().catch(() => {});
  };

  const callRef = doc(collection(db, 'families', fid, 'calls'));
  pc.onicecandidate = (e) => {
    if (e.candidate) addDoc(collection(callRef, 'callerCandidates'), e.candidate.toJSON()).catch(() => {});
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await setDoc(callRef, {
    callerUid: caller.uid,
    callerName: caller.name,
    state: 'ringing',
    offer: { type: offer.type, sdp: offer.sdp },
    answer: null,
    createdAt: serverTimestamp(),
    endedAt: null,
  });
  ui.onState('ringing');

  let finished = false;
  const stops = [];
  const finish = (reason, notify) => {
    if (finished) return;
    finished = true;
    clearTimeout(ringTimer);
    stops.forEach((stop) => stop());
    pc.close();
    stream.getTracks().forEach((t) => t.stop());
    if (notify) updateDoc(callRef, { state: notify, endedAt: serverTimestamp() }).catch(() => {});
    ui.onEnd(reason);
  };

  const ringTimer = setTimeout(() => finish('missed', 'missed'), RING_TIMEOUT_MS);

  stops.push(onSnapshot(callRef, async (snap) => {
    const data = snap.data();
    if (!data) return;
    if (data.answer && !pc.currentRemoteDescription) {
      clearTimeout(ringTimer);
      await pc.setRemoteDescription(data.answer);
      ui.onState('accepted');
    }
    if (['ended', 'declined', 'missed'].includes(data.state)) finish(data.state, null);
  }));

  stops.push(onSnapshot(collection(callRef, 'calleeCandidates'), (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === 'added') pc.addIceCandidate(change.doc.data()).catch(() => {});
    });
  }));

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') ui.onState('connected');
    if (pc.connectionState === 'failed') finish('failed', 'ended');
  };

  return { hangup: () => finish('ended', 'ended') };
}

