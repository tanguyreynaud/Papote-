// Appels vidéo entre la famille et la tablette, en WebRTC (dans les deux sens).
// La signalisation passe par Firestore : families/{fid}/calls/{cid} et ses sous-collections de candidats.
import {
  db, doc, collection, setDoc, addDoc, updateDoc, onSnapshot, serverTimestamp,
} from './firebase.js';
import { query, where } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

export const ICE_SERVERS = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

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

  const pc = new RTCPeerConnection(ICE_SERVERS);
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

const FRESH_MS = 60_000;

/** Écoute les appels de la tablette destinés à cette personne ; cb(call | null). */
export function watchIncoming(fid, uid, cb) {
  const q = query(collection(db, 'families', fid, 'calls'),
    where('calleeUid', '==', uid), where('state', '==', 'ringing'));
  return onSnapshot(q, (snap) => {
    const now = Date.now();
    const fresh = snap.docs
      .map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }))
      .filter((c) => c.createdAt && now - c.createdAt.toMillis() < FRESH_MS);
    cb(fresh.length ? fresh[fresh.length - 1] : null);
  }, (err) => console.error('Écoute des appels', err));
}

export function declineCall(fid, call) {
  return updateDoc(doc(db, 'families', fid, 'calls', call.id), { state: 'declined', endedAt: serverTimestamp() });
}

/** Décroche un appel venant de la tablette. Même interface que startCall. */
export async function answerCall(fid, call, ui) {
  const callRef = doc(db, 'families', fid, 'calls', call.id);
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  ui.local.srcObject = stream;
  const pc = new RTCPeerConnection(ICE_SERVERS);
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  pc.ontrack = (e) => {
    ui.remote.srcObject = e.streams[0];
    ui.remote.play().catch(() => {});
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) addDoc(collection(callRef, 'calleeCandidates'), e.candidate.toJSON()).catch(() => {});
  };
  await pc.setRemoteDescription(call.offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await updateDoc(callRef, { answer: { type: answer.type, sdp: answer.sdp }, state: 'accepted' });
  ui.onState('accepted');

  let finished = false;
  const stops = [];
  const finish = (reason, notify) => {
    if (finished) return;
    finished = true;
    stops.forEach((stop) => stop());
    pc.close();
    stream.getTracks().forEach((t) => t.stop());
    if (notify) updateDoc(callRef, { state: notify, endedAt: serverTimestamp() }).catch(() => {});
    ui.onEnd(reason);
  };
  stops.push(onSnapshot(collection(callRef, 'callerCandidates'), (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === 'added') pc.addIceCandidate(change.doc.data()).catch(() => {});
    });
  }));
  stops.push(onSnapshot(callRef, (snap) => {
    const state = snap.data() && snap.data().state;
    if (state === 'ended' || state === 'missed') finish('ended', null);
  }));
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') ui.onState('connected');
    if (pc.connectionState === 'failed') finish('failed', 'ended');
  };
  return { hangup: () => finish('ended', 'ended') };
}
