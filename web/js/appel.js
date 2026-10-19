// Appel vidéo de la famille vers la tablette, en WebRTC.
// La signalisation passe par Firestore : families/{fid}/calls/{cid} et ses sous-collections de candidats.
import {
  db, auth, doc, getDoc, collection, setDoc, addDoc, updateDoc, onSnapshot, serverTimestamp,
} from './firebase.js';
import { query, where, getDocs, runTransaction } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

// Sans relais TURN, la vidéo ne passe pas entre deux réseaux différents (4G, box…).
// Le relais est décrit dans Firestore (config/turn), pas dans le code, qui est public :
//   { url: 'https://…' }  service qui renvoie la liste des relais (identifiants à jour, voir turn-worker/)
//   ou { urls: 'turn:… turn:…', username, credential }                       identifiants fixes
const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

// Le relais est demandé une fois puis gardé 30 minutes (ses identifiants valent 4 heures) :
// c'était l'étape la plus lente au moment de répondre.
let iceCache = null;
async function iceServers() {
  if (iceCache && Date.now() - iceCache.at < 30 * 60_000) return iceCache.value;
  const value = await loadIceServers();
  if (value.iceServers.length > STUN.length) iceCache = { at: Date.now(), value };
  return value;
}

// À l'ouverture de l'app et dès qu'un appel sonne : le relais est prêt avant « Répondre ».
export function warmUpCalls() {
  iceServers().catch(() => {});
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

const RING_TIMEOUT_MS = 45_000;

// La tablette est couchée : on lui envoie toujours une image à l'horizontale (16/9),
// même si le téléphone est tenu debout. On garde alors le haut du buste, là où est le visage.
function landscapeStream(camera) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = camera;
  video.play().catch(() => {});
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  let running = true;
  const next = () => {
    if (!running) return;
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(draw);
    else requestAnimationFrame(draw);
  };
  // Écran resté en portrait mais appel tourné en CSS (famille.js, .force-landscape) : le téléphone
  // est tenu couché alors que la caméra livre l'image dans le sens de l'écran, donc couchée.
  // On la redresse d'un quart de tour (le haut du monde est à gauche de l'image brute).
  const forcedTurn = () => !!document.querySelector('.call.force-landscape')
    && window.matchMedia('(orientation: portrait)').matches;
  const draw = () => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw && vh) {
      const turn = forcedTurn() && vh > vw;
      // Dimensions de l'image une fois redressée.
      const w = turn ? vh : vw;
      const h = turn ? vw : vh;
      let sw = w;
      let sh = (w * 9) / 16;
      if (sh > h) { sh = h; sw = (h * 16) / 9; }
      const sx = (w - sw) / 2;
      const sy = Math.max(0, Math.min(h - sh, h * 0.4 - sh / 2));
      if (turn) {
        const k = canvas.width / sw;
        ctx.save();
        ctx.scale(k, k);
        ctx.translate(-sx, -sy);
        ctx.translate(w, 0);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(video, 0, 0, vw, vh);
        ctx.restore();
      } else {
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      }
    }
    next();
  };
  next();
  const out = canvas.captureStream(30);
  camera.getAudioTracks().forEach((t) => out.addTrack(t));
  return {
    stream: out,
    stop: () => {
      running = false;
      out.getVideoTracks().forEach((t) => t.stop());
      camera.getTracks().forEach((t) => t.stop());
    },
  };
}

// Mamie est-elle déjà en communication (ou un autre proche est-il en train de l'appeler) ?
// Un appel décroché sans fin depuis plus de 2 h est considéré comme oublié (panne).
const busyQuery = (fid) => query(collection(db, 'families', fid, 'calls'), where('state', 'in', ['ringing', 'accepted']));

function isBusyCall(data) {
  const at = data.createdAt && data.createdAt.toMillis ? data.createdAt.toMillis() : Date.now();
  const age = Date.now() - at;
  return data.state === 'ringing' ? age < 60_000 : age < 2 * 3600_000;
}

export async function tabletBusy(fid) {
  const snap = await getDocs(busyQuery(fid));
  return snap.docs.some((d) => isBusyCall(d.data({ serverTimestamps: 'estimate' })));
}

// En direct, pour griser le bouton d'appel tant que la tablette est en communication.
// onChange(busy) ; renvoie stop().
export function watchTabletBusy(fid, onChange) {
  let calls = [];
  let last = null;
  const evaluate = () => {
    const busy = calls.some(isBusyCall);
    if (busy !== last) { last = busy; onChange(busy); }
  };
  const stop = onSnapshot(busyQuery(fid), (snap) => {
    calls = snap.docs.map((d) => d.data({ serverTimestamps: 'estimate' }));
    evaluate();
  }, () => { calls = []; evaluate(); });
  // Une sonnerie sans réponse cesse de compter au bout d'une minute.
  const timer = setInterval(evaluate, 10_000);
  return () => { stop(); clearInterval(timer); };
}

/**
 * Lance un appel. `ui` reçoit les vidéos et les changements d'état :
 *   ui.local / ui.remote : éléments <video>
 *   ui.onState(state)    : 'ringing' | 'accepted' | 'connected'
 *   ui.onEnd(reason)     : 'ended' | 'declined' | 'missed' | 'failed'
 *   ui.signal            : AbortSignal ; « Raccrocher » avant la fin du démarrage annule tout
 * Renvoie { hangup() }, ou lève une AbortError si l'appel a été annulé pendant le démarrage.
 */
export async function startCall(fid, caller, ui) {
  // Raccrocher pendant le démarrage ne doit jamais laisser la caméra tourner ni l'appel sonner
  // chez Mamie (elle peut décrocher toute seule en regardant l'écran).
  const signal = ui.signal;
  const cancelled = () => !!(signal && signal.aborted);
  const abortError = () => new DOMException('Appel annulé', 'AbortError');
  // Une seule communication à la fois avec la tablette.
  if (await tabletBusy(fid).catch(() => false)) {
    const busy = new Error('La tablette est déjà en communication');
    busy.name = 'BusyError';
    throw busy;
  }
  if (cancelled()) throw abortError();
  const camera = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  const sent = landscapeStream(camera);
  const stream = sent.stream;
  ui.local.srcObject = stream; // l'appelant voit exactement l'image envoyée
  if (cancelled()) { sent.stop(); throw abortError(); }

  const ice = await iceServers();
  if (cancelled()) { sent.stop(); throw abortError(); }
  const pc = new RTCPeerConnection(ice);
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
  if (cancelled()) { pc.close(); sent.stop(); throw abortError(); }
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
    sent.stop();
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

  // Annulé pendant l'écriture de l'appel, ou plus tard : on raccroche pour de bon.
  if (signal) {
    if (cancelled()) finish('ended', 'ended');
    else signal.addEventListener('abort', () => finish('ended', 'ended'), { once: true });
  }

  return { hangup: () => finish('ended', 'ended') };
}


// ---------- Mamie appelle la famille (audio seulement) ----------
// La tablette crée l'appel avec calleeUid = un proche, ou null pour toute la famille.
// Le premier qui répond l'emporte (transaction) et écrit son uid et son prénom dans answer.

const INCOMING_FRESH_MS = 60_000;

// En direct : les appels de la tablette qui sonnent pour moi. isTablet(uid) dit si l'appelant
// est une tablette de la famille (les appels vidéo des proches vers Mamie sont ignorés).
export function watchIncomingCalls(fid, uid, isTablet, onChange) {
  let calls = [];
  let last = '';
  const evaluate = () => {
    const now = Date.now();
    const list = calls.filter((c) => c.callerUid !== uid && isTablet(c.callerUid)
      && (!c.calleeUid || c.calleeUid === uid)
      && c.createdAt && now - c.createdAt.toMillis() < INCOMING_FRESH_MS);
    const key = list.map((c) => c.id).join(',');
    if (key !== last) { last = key; onChange(list); }
  };
  const stop = onSnapshot(query(collection(db, 'families', fid, 'calls'), where('state', '==', 'ringing')), (snap) => {
    calls = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }));
    evaluate();
  }, () => { calls = []; evaluate(); });
  const timer = setInterval(evaluate, 5000);
  return () => { stop(); clearInterval(timer); };
}

/**
 * Répond à un appel de la tablette. ui.audio : élément <audio> ; ui.onState('connected') ;
 * ui.onEnd(reason) : 'ended' | 'failed'. Lève une erreur nommée TakenError si un autre
 * proche a répondu avant. Renvoie { hangup() }.
 */
export async function answerIncoming(fid, callId, me, ui) {
  const ref = doc(db, 'families', fid, 'calls', callId);
  const taken = () => { const e = new Error('Un autre proche a déjà répondu'); e.name = 'TakenError'; return e; };
  const first = (await getDoc(ref)).data();
  if (!first || first.state !== 'ringing') throw taken();

  const [stream, ice] = await Promise.all([
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }),
    iceServers(),
  ]);
  const pc = new RTCPeerConnection(ice);
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  pc.ontrack = (e) => { ui.audio.srcObject = e.streams[0]; ui.audio.play().catch(() => {}); };
  let accepted = false;
  const pending = [];
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const c = e.candidate.toJSON();
    if (accepted) addDoc(collection(ref, 'calleeCandidates'), c).catch(() => {});
    else pending.push(c);
  };

  const stops = [];
  let finished = false;
  let lostTimer = null;
  const finish = (reason, notify) => {
    if (finished) return;
    finished = true;
    clearTimeout(lostTimer);
    stops.forEach((stop) => stop());
    pc.close();
    stream.getTracks().forEach((t) => t.stop());
    ui.audio.srcObject = null;
    if (notify) updateDoc(ref, { state: notify, endedAt: serverTimestamp() }).catch(() => {});
    ui.onEnd(reason);
  };

  try {
    await pc.setRemoteDescription(first.offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await runTransaction(db, async (tx) => {
      const cur = await tx.get(ref);
      if (!cur.exists() || cur.data().state !== 'ringing') throw taken();
      tx.update(ref, { state: 'accepted', answer: { type: answer.type, sdp: answer.sdp, uid: me.uid, name: me.name } });
    });
  } catch (e) {
    pc.close();
    stream.getTracks().forEach((t) => t.stop());
    throw e;
  }
  accepted = true;
  pending.forEach((c) => addDoc(collection(ref, 'calleeCandidates'), c).catch(() => {}));

  stops.push(onSnapshot(collection(ref, 'callerCandidates'), (snap) => {
    snap.docChanges().forEach((c) => {
      if (c.type === 'added') pc.addIceCandidate(c.doc.data()).catch(() => {});
    });
  }));
  stops.push(onSnapshot(ref, (snap) => {
    const state = snap.data() && snap.data().state;
    if (['ended', 'missed', 'declined'].includes(state)) finish('ended', null);
  }));
  pc.onconnectionstatechange = () => {
    clearTimeout(lostTimer);
    if (pc.connectionState === 'connected') ui.onState('connected');
    if (pc.connectionState === 'disconnected') lostTimer = setTimeout(() => finish('failed', 'ended'), 8000);
    if (pc.connectionState === 'failed') finish('failed', 'ended');
  };
  return { hangup: () => finish('ended', 'ended') };
}
