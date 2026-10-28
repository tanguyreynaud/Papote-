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
// Vidéo envoyée à la tablette, selon le réseau de la tablette (champ « reseau » de l'appel, écrit par
// elle : 'sim' ou 'wifi') et celui du téléphone. Tablette sur SIM, ou téléphone lui-même en 4G (Android
// seulement : navigator.connection) : 500 kbit/s, 640x360, 15 images/s, pour ménager les forfaits.
// Tablette en Wi-Fi : pleine qualité, 1,2 Mbit/s, 960x540, 20 images/s. Réseau inconnu (tablette pas
// encore à jour) : comme avant, 500 kbit/s en 960x540 à 20 images/s.
// À appliquer après setLocalDescription, à la connexion, après replaceTrack et quand un réseau change.
const REGLAGES_VIDEO = {
  sim: { maxBitrate: 500_000, maxFramerate: 15, scaleResolutionDownBy: 1.5 },
  wifi: { maxBitrate: 1_200_000, maxFramerate: 20, scaleResolutionDownBy: 1 },
  inconnu: { maxBitrate: 500_000, maxFramerate: 20, scaleResolutionDownBy: 1 },
};
const reseauTablette = new WeakMap(); // pc -> 'sim' | 'wifi'
function telephoneEnDonneesMobiles() {
  const c = navigator.connection;
  return !!c && c.type === 'cellular';
}
function reglagesVideo(pc) {
  const reseau = reseauTablette.get(pc);
  if (reseau === 'sim') return REGLAGES_VIDEO.sim;
  if (reseau === 'wifi') return telephoneEnDonneesMobiles() ? REGLAGES_VIDEO.sim : REGLAGES_VIDEO.wifi;
  return REGLAGES_VIDEO.inconnu;
}
async function limiterVideo(pc) {
  const reglages = reglagesVideo(pc);
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      Object.assign(params.encodings[0], reglages);
      await sender.setParameters(params);
    } catch (e) { /* navigateur sans réglage de débit : on garde le comportement par défaut */ }
  }
}
// Réseau de la tablette, écrit par elle dans sa réponse (appel du proche) ou dans son offre (appel de
// Mamie) : on règle de nouveau la vidéo s'il change.
function noterReseau(pc, data) {
  const reseau = [data && data.answer && data.answer.reseau, data && data.offer && data.offer.reseau]
    .find((r) => r === 'sim' || r === 'wifi');
  if (!reseau || reseauTablette.get(pc) === reseau) return;
  reseauTablette.set(pc, reseau);
  limiterVideo(pc);
}
function limiterALaConnexion(pc) {
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'connected') limiterVideo(pc);
  });
  // Le téléphone passe du Wi-Fi à la 4G (ou l'inverse) pendant l'appel.
  const c = navigator.connection;
  if (c && c.addEventListener) {
    const changer = () => {
      if (pc.connectionState === 'closed') c.removeEventListener('change', changer);
      else limiterVideo(pc);
    };
    c.addEventListener('change', changer);
  }
}

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
  // 960x540 suffit pour l'écran de la tablette (1280x800) et réduit la consommation de données.
  canvas.width = 960;
  canvas.height = 540;
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
  const out = canvas.captureStream(20);
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
    video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 20, max: 24 } },
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

  limiterALaConnexion(pc);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  limiterVideo(pc);
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

  // Les candidats de la tablette peuvent arriver avant sa réponse : on les garde jusque-là.
  let answered = false;
  const early = [];
  stops.push(onSnapshot(callRef, async (snap) => {
    const data = snap.data();
    if (!data) return;
    noterReseau(pc, data);
    if (data.answer && !answered) {
      answered = true;
      clearTimeout(ringTimer);
      try {
        await pc.setRemoteDescription({ type: data.answer.type, sdp: data.answer.sdp });
      } catch (e) {
        finish('failed', 'ended');
        return;
      }
      early.splice(0).forEach((c) => pc.addIceCandidate(c).catch(() => {}));
      ui.onState('accepted');
    }
    if (['ended', 'declined', 'missed'].includes(data.state)) finish(data.state, null);
  }));

  stops.push(onSnapshot(collection(callRef, 'calleeCandidates'), (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type !== 'added') return;
      if (pc.remoteDescription) pc.addIceCandidate(change.doc.data()).catch(() => {});
      else early.push(change.doc.data());
    });
  }));

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') ui.onState('connected');
    if (pc.connectionState === 'failed') {
      reportCallIncident('liaison-video', `ice=${pc.iceConnectionState}`, callRef.id);
      finish('failed', 'ended');
    }
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

const INCOMING_FRESH_MS = 60_000; // la tablette sonne 60 s

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
  const t0 = performance.now();
  const temps = {};
  const taken = () => { const e = new Error('Un autre proche a déjà répondu'); e.name = 'TakenError'; return e; };
  let first = (await getDoc(ref)).data();
  if (!first || first.state !== 'ringing') throw taken();
  // La tablette écrit l'appel avant d'avoir préparé la liaison (pour faire sonner plus tôt) :
  // si on répond très vite, on attend son offre quelques secondes.
  if (!first.offer) first = await attendreOffre(ref);
  if (!first || first.state !== 'ringing' || !first.offer) throw taken();

  const [stream, ice] = await Promise.all([
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }),
    iceServers(),
  ]);
  temps.microRelais = Math.round(performance.now() - t0);
  const pc = new RTCPeerConnection(ice);
  let videoTx = null;
  limiterALaConnexion(pc);
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  pc.ontrack = (e) => {
    if (e.track.kind === 'audio') {
      ui.audio.srcObject = e.streams[0] || new MediaStream([e.track]);
      ui.audio.play().catch(() => {});
      return;
    }
    // Vidéo de la tablette : elle arrive quand Mamie répond à notre caméra.
    // On ne montre la vidéo de Mamie que si l'on a soi-même allumé sa caméra.
    remoteVideo = e.track;
    e.track.onunmute = () => { if (cam && ui.onVideo) ui.onVideo(e.track); };
  };
  let cam = null; // caméra allumée pendant l'appel (« Passer en vidéo »)
  let remoteVideo = null;
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
    if (cam) cam.stop();
    if (notify) updateDoc(ref, { state: notify, endedAt: serverTimestamp() }).catch(() => {});
    ui.onEnd(reason);
  };

  try {
    noterReseau(pc, first);
    await pc.setRemoteDescription(first.offer);
    // La tablette prévoit une voie vidéo vide : on l'accepte dans les deux sens pour pouvoir
    // allumer la caméra plus tard sans renégocier.
    videoTx = pc.getTransceivers().find((t) => t.receiver && t.receiver.track && t.receiver.track.kind === 'video') || null;
    if (videoTx) videoTx.direction = 'sendrecv';
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    limiterVideo(pc);
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
  temps.reponse = Math.round(performance.now() - t0);
  pending.forEach((c) => addDoc(collection(ref, 'calleeCandidates'), c).catch(() => {}));

  stops.push(onSnapshot(collection(ref, 'callerCandidates'), (snap) => {
    snap.docChanges().forEach((c) => {
      if (c.type === 'added') pc.addIceCandidate(c.doc.data()).catch(() => {});
    });
  }));
  stops.push(onSnapshot(ref, (snap) => {
    noterReseau(pc, snap.data());
    const state = snap.data() && snap.data().state;
    if (['ended', 'missed', 'declined'].includes(state)) finish('ended', null);
  }));
  pc.onconnectionstatechange = () => {
    clearTimeout(lostTimer);
    if (pc.connectionState === 'connected') {
      ui.onState('connected');
      temps.liaison = Math.round(performance.now() - t0);
      // Mise en relation lente : on note le détail de chaque étape et le chemin choisi.
      if (temps.liaison > 4000) {
        cheminChoisi(pc).then((chemin) => reportCallIncident('lent',
          `micro+relais=${temps.microRelais}ms reponse=${temps.reponse}ms liaison=${temps.liaison}ms chemin=${chemin}`, callId));
      }
    }
    if (pc.connectionState === 'disconnected') lostTimer = setTimeout(() => {
      reportCallIncident('audio-coupe', 'liaison perdue 8 s', callId);
      finish('failed', 'ended');
    }, 8000);
    if (pc.connectionState === 'failed') {
      reportCallIncident('liaison-audio', `ice=${pc.iceConnectionState}`, callId);
      finish('failed', 'ended');
    }
  };
  return {
    hangup: () => finish('ended', 'ended'),
    canVideo: () => !!videoTx,
    // Allume la caméra du téléphone et l'envoie à la tablette ; renvoie l'image envoyée.
    enableVideo: async () => {
      if (!videoTx || finished) throw new Error('Vidéo indisponible');
      if (cam) return cam.stream;
      const camera = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 20, max: 24 } }, audio: false,
      });
      cam = landscapeStream(camera);
      await videoTx.sender.replaceTrack(cam.stream.getVideoTracks()[0]);
      limiterVideo(pc);
      // Signal explicite pour la tablette : elle n'allume sa caméra qu'à ce moment-là.
      updateDoc(ref, { 'answer.video': true }).catch(() => {});
      if (remoteVideo && !remoteVideo.muted && ui.onVideo) ui.onVideo(remoteVideo);
      return cam.stream;
    },
  };
}

// Refuser un appel de la tablette : il s'arrête aussitôt pour Mamie (« n'a pas pu répondre »).
export function declineIncoming(fid, callId) {
  return updateDoc(doc(db, 'families', fid, 'calls', callId), { state: 'declined', endedAt: serverTimestamp() }).catch(() => {});
}

// ---------- Relevé des appels qui échouent ----------
// Chaque échec part au serveur (fonction incidentAppel) avec sa raison, pour repérer les pannes
// avant qu'une famille les signale. Jamais bloquant.
let incidentFn = null;
export function reportCallIncident(raison, detail = '', cid = null) {
  (async () => {
    if (!incidentFn) {
      const { getApp } = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js');
      const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js');
      incidentFn = httpsCallable(getFunctions(getApp(), 'europe-west1'), 'incidentAppel');
    }
    await incidentFn({
      cote: 'famille',
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

// Attend que l'appel de la tablette contienne son offre (au plus 15 s).
function attendreOffre(ref) {
  return new Promise((resolve) => {
    let stop = () => {};
    const timer = setTimeout(() => { stop(); resolve(null); }, 15_000);
    stop = onSnapshot(ref, (snap) => {
      const data = snap.data();
      if (!data || data.offer || data.state !== 'ringing') {
        clearTimeout(timer);
        stop();
        resolve(data || null);
      }
    }, () => { clearTimeout(timer); resolve(null); });
  });
}
