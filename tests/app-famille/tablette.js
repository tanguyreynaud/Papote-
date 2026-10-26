// La tablette pendant un appel : une vraie liaison WebRTC (caméra et micro simulés par Chromium),
// dans une page à part. La signalisation suit le protocole de web/js/appel.js et de la tablette :
// families/{fid}/calls/{cid} (offer, answer, state) et ses sous-collections callerCandidates /
// calleeCandidates, écrite ici avec les droits du serveur, comme le fait l'appli Android.

const banc = require('./banc');

const { s } = banc;

async function attendre(fn, message, delai = 20_000) {
  const debut = Date.now();
  for (;;) {
    const r = await fn();
    if (r) return r;
    if (Date.now() - debut > delai) throw new Error(`Tablette : ${message}`);
    await new Promise((ok) => setTimeout(ok, 150));
  }
}

/** Une tablette prête à téléphoner : { page, fid, tab }. */
async function ouvrir(fid, tab) {
  const t = await banc.telephone('Tablette (appels)');
  await t.page.goto(`${banc.origine}/__vide.html`);
  return { ...t, fid, tab };
}

const ref = (tablette, cid) => s.db.doc(`families/${tablette.fid}/calls/${cid}`);

// Relaie les candidats ICE dans les deux sens jusqu'à la connexion (ou l'arrêt).
function relayer(tablette, cid, mesCandidats, siensCandidats) {
  let fini = false;
  const envoyes = new Set();
  const recus = new Set();
  const boucle = (async () => {
    while (!fini) {
      try {
        const miens = await tablette.page.evaluate(() => window.candidats.splice(0));
        for (const c of miens) {
          const cle = JSON.stringify(c);
          if (envoyes.has(cle)) continue;
          envoyes.add(cle);
          await ref(tablette, cid).collection(mesCandidats).add(c);
        }
        const siens = await ref(tablette, cid).collection(siensCandidats).get();
        for (const d of siens.docs) {
          if (recus.has(d.id)) continue;
          recus.add(d.id);
          await tablette.page.evaluate((c) => window.pc.addIceCandidate(c).catch(() => {}), d.data());
        }
      } catch (e) {
        if (!fini) throw e;
      }
      await new Promise((ok) => setTimeout(ok, 150));
    }
  })();
  return () => { fini = true; return boucle.catch(() => {}); };
}

const PREPARER = async () => {
  window.candidats = [];
  window.pistes = [];
  const pc = new RTCPeerConnection({ iceServers: [] });
  window.pc = pc;
  pc.onicecandidate = (e) => { if (e.candidate) window.candidats.push(e.candidate.toJSON()); };
  pc.ontrack = (e) => { window.pistes.push(e.track.kind); };
};

/** La tablette décroche un appel vidéo d'un proche (appel.js startCall). */
async function decrocher(tablette, cid) {
  const appel = await attendre(async () => { const d = (await ref(tablette, cid).get()).data(); return d && d.offer && d; }, 'offre absente');
  const answer = await tablette.page.evaluate(async ({ offer, preparer }) => {
    // eslint-disable-next-line no-eval
    await (0, eval)(`(${preparer})`)();
    const flux = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    flux.getTracks().forEach((t) => window.pc.addTrack(t, flux));
    await window.pc.setRemoteDescription(offer);
    const a = await window.pc.createAnswer();
    await window.pc.setLocalDescription(a);
    return { type: a.type, sdp: a.sdp };
  }, { offer: appel.offer, preparer: PREPARER.toString() });
  tablette.arreterRelais = relayer(tablette, cid, 'calleeCandidates', 'callerCandidates');
  await ref(tablette, cid).update({ answer, state: 'accepted' });
  await attendre(() => tablette.page.evaluate(() => window.pc.connectionState === 'connected'), 'liaison non établie');
}

/**
 * La tablette appelle (audio, voie vidéo prête) : vers un proche ou toute la famille (vers = null).
 * Renvoie l'id de l'appel.
 */
async function appeler(tablette, { vers = null, nom = 'Mamie Emma' } = {}) {
  const callRef = s.db.collection(`families/${tablette.fid}/calls`).doc();
  // Comme la tablette : l'appel est écrit tout de suite (sonnerie), l'offre juste après.
  await callRef.set({
    callerUid: tablette.tab.callsUid, callerName: nom, calleeUid: vers, calleeName: null,
    state: 'ringing', offer: null, answer: null, createdAt: s.FieldValue.serverTimestamp(), endedAt: null,
  });
  const offer = await tablette.page.evaluate(async (preparer) => {
    // eslint-disable-next-line no-eval
    await (0, eval)(`(${preparer})`)();
    const flux = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    flux.getTracks().forEach((t) => window.pc.addTrack(t, flux));
    window.voieVideo = window.pc.addTransceiver('video', { direction: 'sendrecv' });
    const o = await window.pc.createOffer();
    await window.pc.setLocalDescription(o);
    return { type: o.type, sdp: o.sdp };
  }, PREPARER.toString());
  await callRef.update({ offer });
  tablette.arreterRelais = relayer(tablette, callRef.id, 'callerCandidates', 'calleeCandidates');
  return callRef.id;
}

/** Le proche a décroché (answer écrite) : la tablette prend sa réponse et attend la liaison. */
async function prendreReponse(tablette, cid) {
  const appel = await attendre(async () => { const d = (await ref(tablette, cid).get()).data(); return d && d.answer && d; }, 'pas de réponse');
  await tablette.page.evaluate((a) => window.pc.setRemoteDescription({ type: a.type, sdp: a.sdp }), appel.answer);
  await attendre(() => tablette.page.evaluate(() => window.pc.connectionState === 'connected'), 'liaison non établie');
  return appel.answer;
}

/** La tablette raccroche. */
async function raccrocher(tablette, cid) {
  await ref(tablette, cid).update({ state: 'ended', endedAt: s.FieldValue.serverTimestamp() });
  await tablette.page.evaluate(() => window.pc && window.pc.close());
  await tablette.arreterRelais?.();
}

/** Pistes reçues par la tablette (« audio », « video »). */
const pistes = (tablette) => tablette.page.evaluate(() => window.pistes);

module.exports = { ouvrir, decrocher, appeler, prendreReponse, raccrocher, pistes, ref };
