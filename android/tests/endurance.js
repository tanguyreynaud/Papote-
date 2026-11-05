// Endurance de la tablette (audit du 05/11/2026) : la page vit des semaines sans redémarrage de l'appli
// (seul le rechargement du dimanche 3 h la remet à neuf, et il est sauté si quelque chose est en cours).
// Ce module rejoue des journées entières, en accéléré, avec tous les gestes de la vie (envois photo et
// vidéo, rappel, appels internet décrochés et manqués, appel téléphone manqué, SOS, coupure de réseau et
// d'écoute Firebase, diaporama avec vidéos, changements de réglages de la famille, soir, nuit) et mesure
// chaque jour, après un passage du ramasse-miettes, ce qui peut fuir.
// Utilisé par endurance.test.js (et ENDURANCE_JOURS=30 pour la mesure longue).
const { ouvrir, lot, envoi, ORIGIN } = require('./banc');

// Compteurs posés avant la page : minuteries vivantes (setInterval, setTimeout pas encore partis,
// requestAnimationFrame), adresses blob: jamais rendues, connexions WebRTC ouvertes, flux caméra/micro.
function instrumenter() {
  const M = window.__mesure = {
    intervalles: new Map(), delais: new Map(), images: new Map(), blobs: new Set(),
    pc: new Set(), flux: [],
  };
  const etiquette = (fn) => String(fn).replace(/\s+/g, ' ').slice(0, 90);
  const si = window.setInterval, ci = window.clearInterval, st = window.setTimeout, ct = window.clearTimeout;
  window.setInterval = function (fn, ms, ...a) { const id = si.call(window, fn, ms, ...a); M.intervalles.set(id, etiquette(fn)); return id; };
  window.clearInterval = function (id) { M.intervalles.delete(id); M.delais.delete(id); return ci.call(window, id); };
  window.setTimeout = function (fn, ms, ...a) {
    let id;
    const f = typeof fn === 'function' ? function (...x) { M.delais.delete(id); return fn.apply(this, x); } : fn;
    id = st.call(window, f, ms, ...a);
    M.delais.set(id, etiquette(fn));
    return id;
  };
  window.clearTimeout = function (id) { M.delais.delete(id); M.intervalles.delete(id); return ct.call(window, id); };
  if (window.requestAnimationFrame) {
    const raf = window.requestAnimationFrame, caf = window.cancelAnimationFrame;
    window.requestAnimationFrame = function (fn) { let id; id = raf.call(window, (t) => { M.images.delete(id); fn(t); }); M.images.set(id, etiquette(fn)); return id; };
    window.cancelAnimationFrame = function (id) { M.images.delete(id); return caf.call(window, id); };
  }
  const cou = URL.createObjectURL, rou = URL.revokeObjectURL;
  URL.createObjectURL = function (o) { const u = cou.call(URL, o); M.blobs.add(u); return u; };
  URL.revokeObjectURL = function (u) { M.blobs.delete(u); return rou.call(URL, u); };
  if (window.RTCPeerConnection) {
    const PC = window.RTCPeerConnection;
    window.RTCPeerConnection = function (...a) {
      const pc = new PC(...a);
      M.pc.add(pc);
      pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'closed') M.pc.delete(pc); });
      const close = pc.close.bind(pc);
      pc.close = () => { M.pc.delete(pc); return close(); };
      return pc;
    };
    window.RTCPeerConnection.prototype = PC.prototype;
  }
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => { const s = await gum(c); M.flux.push(new WeakRef(s)); return s; };
  }
}

const FAMILLE = {
  firebase: true, telephone: true, code: 'ABCD2345',
  base: {
    'invites/ABCD2345': { fid: 'F1', kind: 'tablette' },
    'families/F1': { name: 'Mamie' },
    'families/F1/members/julie': { name: 'Julie', role: 'famille', status: 'active' },
  },
};
const PROCHES = (v) => ({
  faces: { julie: `${ORIGIN}/photos/visage-julie-${v}.jpg` }, birthdays: [],
  people: [
    { uid: 'julie', name: 'Julie', tel: '0612345678', responsable: true },
    { uid: 'paul', name: 'Paul', tel: '0700000000' },
  ],
});
const RAPPELS = (v) => ({ reminders: [{ id: 'r1', title: 'Cachet du matin' + (v % 2 ? '' : ' (2)'), kind: 'medicament', time: '09:00', repeat: 'daily', date: '', days: [], lastAck: '', avanceMin: 0, finLe: '', enPauseJusquau: '', voice: '' }] });
const H = 3600 * 1000;

async function mesurer(b) {
  const cdp = await b.page.context().newCDPSession(b.page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  // Objets vivants d'un type (après ramasse-miettes), et combien ne sont plus dans la page (détachés).
  const vivants = async (proto) => {
    const p = await cdp.send('Runtime.evaluate', { expression: proto });
    if (!p.result.objectId) return [0, 0];
    const q = await cdp.send('Runtime.queryObjects', { prototypeObjectId: p.result.objectId });
    const r = await cdp.send('Runtime.callFunctionOn', {
      objectId: q.objects.objectId, returnByValue: true,
      functionDeclaration: 'function () { return [this.length, this.filter((e) => e && e.isConnected === false).length]; }',
    });
    return r.result.value;
  };
  const [videos, videosDetachees] = await vivants('HTMLVideoElement.prototype');
  const [imgs, imgsDetachees] = await vivants('HTMLImageElement.prototype');
  const [canvas] = await vivants('HTMLCanvasElement.prototype');
  const [pcVivantes] = await vivants('RTCPeerConnection.prototype');
  const [fluxVivants] = await vivants('MediaStream.prototype');
  await cdp.detach();
  const page = await b.page.evaluate(() => {
    const M = window.__mesure;
    M.flux = M.flux.filter((r) => r.deref());
    const fluxActifs = M.flux.map((r) => r.deref()).filter((s) => s && s.getTracks().some((t) => t.readyState === 'live')).length;
    let ls = 0;
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls += k.length + (localStorage.getItem(k) || '').length; } } catch (e) { }
    return {
      intervalles: M.intervalles.size, delais: M.delais.size, raf: M.images.size, blobs: M.blobs.size,
      pcOuvertes: M.pc.size, fluxActifs,
      ecoutesFirestore: window.__fs ? window.__fs.ecoutes.size : 0,
      localStorage: ls, overlayOuvert: !document.getElementById('overlay').hidden, fileEnvois: document.querySelectorAll('#overlay').length,
      detailIntervalles: [...M.intervalles.values()].reduce((o, k) => { o[k] = (o[k] || 0) + 1; return o; }, {}),
      detailDelais: [...M.delais.values()].reduce((o, k) => { o[k] = (o[k] || 0) + 1; return o; }, {}),
    };
  });
  return {
    tas: m.JSHeapUsedSize, noeuds: m.Nodes, ecouteurs: m.JSEventListeners, documents: m.Documents, cadres: m.Frames,
    videos, videosDetachees, imgs, imgsDetachees, canvas, pcVivantes, fluxVivants, ...page,
  };
}

async function demarrer(b, posts, v = 0) {
  await b.android('onPosts', lot(posts));
  await b.android('onFamily', PROCHES(v));
  await b.android('onReminders', RAPPELS(v));
  await b.avancer(3000);
}

// Offre WebRTC d'un « téléphone » de la famille (créée dans la page, refermée ensuite par le banc).
const offre = (b) => b.page.evaluate(async () => {
  const pc = new RTCPeerConnection();
  pc.addTransceiver('audio');
  pc.addTransceiver('video');
  const o = await pc.createOffer();
  await pc.setLocalDescription(o);
  (window.__telephones = window.__telephones || []).push(pc);
  return { type: o.type, sdp: o.sdp };
});
const raccrocherTelephones = (b) => b.page.evaluate(() => { (window.__telephones || []).forEach((pc) => pc.close()); window.__telephones = []; });

async function appelInternet(b, id, decroche) {
  const o = await offre(b);
  await b.ecrire(`families/F1/calls/${id}`, {
    callerUid: 'julie', callerName: 'Julie', state: 'ringing', offer: o, answer: null,
    createdAt: { __serverTimestamp: true }, endedAt: null,
  });
  await b.avancer(500);
  if (decroche) {
    await b.toucher('#ring-answer');
    await b.patienter(2500);
    const appel = await b.lire(`families/F1/calls/${id}`);
    await b.ecrire(`families/F1/calls/${id}`, { ...appel, state: 'ended' });
    await b.patienter(2000);
  } else {
    await b.avancer(62000); // personne ne décroche : « manqué » au bout d'une minute
  }
  await raccrocherTelephones(b);
}

// Avance jusqu'à l'heure h du jour (bond : chaque minuterie part une fois), puis 2 s normales.
async function jusqua(b, h) {
  const now = await b.page.evaluate(() => Date.now());
  const d = new Date(now);
  const paris = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  let cible = new Date(paris); cible.setHours(h, 0, 0, 0);
  if (cible <= paris) cible.setDate(cible.getDate() + 1);
  const ms = cible - paris;
  if (ms > 0) await b.page.clock.fastForward(ms);
  await b.avancer(2000);
}

// Une journée complète, de 7 h à 7 h le lendemain.
async function journee(b, etat, jour) {
  const { posts } = etat;
  await jusqua(b, 8);
  // Envois du matin : deux photos, un envoi de 3 photos (diaporama dans la grande carte), un message,
  // une vidéo un jour sur deux.
  posts.unshift(envoi({ text: `Photo ${jour}` }));
  posts.unshift(envoi({ images: [`${ORIGIN}/photos/m${jour}a.jpg`, `${ORIGIN}/photos/m${jour}b.jpg`] }));
  posts.unshift(envoi({ type: 'message', image: null, text: 'Bonne journée Mamie !' }));
  if (jour % 2 === 0) posts.unshift(envoi({ type: 'video', image: null, video: `${ORIGIN}/photos/v${jour}.mp4` }));
  posts.splice(60);
  await b.android('onPosts', lot(posts));
  for (let i = 0; i < 4; i++) { await b.avancer(3000); await b.toucher('#overlay-close').catch(() => {}); await b.avancer(4000); }
  await jusqua(b, 9);
  await b.avancer(60000);
  if (await b.visible('#reminder-alert')) await b.toucher('#reminder-done');
  await jusqua(b, 11);
  // Appel téléphone (carte SIM) manqué.
  await b.android('onGsm', { etat: 'sonne', sortant: false, numero: '0612345678', uid: 'julie', name: 'Julie' });
  await b.avancer(30000);
  await b.android('onGsm', { etat: 'fin', sortant: false, cause: 'manque', uid: 'julie', name: 'Julie' });
  await b.avancer(10000);
  await jusqua(b, 12);
  await appelInternet(b, `c${jour}a`, true);
  await jusqua(b, 13);
  await appelInternet(b, `c${jour}b`, false);
  await jusqua(b, 14);
  // SOS (essai hebdomadaire, ici chaque jour) : décompte, SMS, Paul ne répond pas, Julie décroche.
  await b.toucher('#sos-btn');
  await b.avancer(5500);
  await b.android('onGsm', { etat: 'appel', sortant: true, numero: '0700000000', uid: 'paul', name: 'Paul' });
  await b.avancer(46000);
  await b.android('onGsm', { etat: 'fin', sortant: true, cause: 'raccroche', numero: '0700000000', uid: 'paul', name: 'Paul' });
  await b.android('onGsm', { etat: 'enLigne', sortant: true, uid: 'julie', name: 'Julie' });
  await b.avancer(20000);
  await b.android('onGsm', { etat: 'fin', sortant: true, cause: 'raccroche', uid: 'julie', name: 'Julie' });
  await b.avancer(10000);
  await jusqua(b, 15);
  // Box coupée 2 minutes : la carte « Pas d'internet », l'écoute Firebase des appels tombe puis repart.
  await b.etat({ reseau: { wifi: '', internet: false, mobile: false, sim: false } });
  await b.page.evaluate(() => window.__fs.casser('families/F1/calls'));
  await b.avancer(100000);
  await b.etat({ reseau: { wifi: 'Box', internet: true, mobile: false, sim: false } });
  await b.avancer(35000);
  await jusqua(b, 16);
  // Mamie ouvre le diaporama (photos et vidéos), il défile 5 minutes puis revient seul.
  await b.toucher('#home-frame').catch(() => {});
  for (let i = 0; i < 30; i++) await b.avancer(10500);
  await b.avancer(5 * 60000);
  await jusqua(b, 17);
  // La famille change ses réglages (taille du texte, options, veille, photos de profil, rappel).
  etat.v++;
  posts.forEach((p) => { p.seen = true; }); // Android renvoie les envois vus (les vidéos vues passent au diaporama)
  await b.android('onPosts', lot(posts, { textSize: etat.v % 2 ? 'grand' : '', options: { lecture: true, sos: true, meteo: etat.v % 3 !== 0, rappelsAccueil: true }, veille: { active: true, de: (22 + (etat.v % 2)) * 60, a: 7 * 60 } }));
  await b.android('onFamily', PROCHES(etat.v));
  await b.android('onReminders', RAPPELS(etat.v));
  await b.android('onWeather', { now: { temp: 12 + (jour % 5), code: 3 }, days: [] }).catch(() => {});
  await b.avancer(5000);
  await jusqua(b, 23);
  // 3 h : la nuit du samedi au dimanche, la page se recharge (rechargementDuDimanche). Avec
  // etat.sansRechargement, on saute 3 h ce jour-là : c'est le cas d'un appel, d'une vidéo ou d'un écran
  // ouvert à ce moment, et c'est ce qui laisse voir la vraie pente de la mémoire.
  const dimanche = new Date(await b.page.evaluate(() => Date.now())).getDay() === 6;
  if (!(dimanche && etat.sansRechargement)) await jusqua(b, 3);
  await jusqua(b, 7);
  await b.avancer(35000); // le coup d'œil de présence de 7 h (30 s de caméra) est fini
}

async function ouvrirEndurance() {
  const b = await ouvrir('2026-10-26T07:00:00', FAMILLE); // lundi
  await b.page.addInitScript(instrumenter);
  await b.page.reload();
  await b.avancer(100);
  const etat = { posts: [], v: 0 };
  await demarrer(b, etat.posts);
  return { b, etat };
}

async function erreurs(b) {
  return (await b.appels('erreurJS')).map((a) => a.args.join(' '));
}

module.exports = { ouvrirEndurance, journee, mesurer, erreurs };
