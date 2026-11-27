// Page « Notifications » : les derniers événements de la famille, racontés en phrases.
import {
  query, orderBy, limit,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import {
  db, collection, onSnapshot, toDate, doc, updateDoc, serverTimestamp,
} from './firebase.js';
import { heureFr, deOuD } from './ui.js';

const $ = (id) => document.getElementById(id);
const WHAT = { photo: 'une photo', video: 'une vidéo', message: 'un message' };
// Appels d'un même SOS (« SOS », « SOS 2 », relances) : regroupés sur 30 min, comme le suivi du SOS dans l'app.
const SOS_MEME_MS = 30 * 60_000;
const WHAT_OF = { photo: 'la photo', video: 'la vidéo', message: 'le message' };

let session = null;
let stops = [];
let posts = [];
let calls = [];
let members = [];
let reminders = [];
// Notifications vues : l'heure du dernier passage est gardée sur ma fiche (notifsVues, horodatage serveur), et non
// plus sur le téléphone. Avant, la déconnexion l'effaçait avec le reste du compte et tout revenait en non lu à la
// reconnexion (Tanguy 20/11) ; elle suit aussi le compte sur un autre téléphone, et un autre compte connecté ensuite
// sur ce téléphone n'hérite de rien. vuIci : passage de cette session, le temps que la fiche revienne de la base.
let vuIci = 0;
let envoisLus = false;
let dessinee = null; // la liste affichée, pour ne pas la redessiner à l'identique
// Déjà vu ailleurs que sur la cloche (Tanguy, 24/11 : « le badge ne doit compter que ce que je n'ai pas vu, où que ce
// soit ») : ouvrir Messages, Photos, Vidéos, Rappels ou Réglages (par la tuile, la barre ou une notification du
// téléphone) vaut lecture de ce qui y mène. L'heure de chaque page est gardée sur ce téléphone, pour ce compte et cette
// famille ; la cloche, elle, reste gardée sur la fiche (tous les téléphones).
const PAGES_LUES = ['photos', 'videos', 'messages', 'agenda', 'settings'];
let vuPages = {};
const clePages = () => `papote.notifsPages.${session.fid}.${session.uid}`;
function lirePages() {
  vuPages = {};
  try {
    const lu = JSON.parse(localStorage.getItem(clePages()) || '{}');
    if (lu && typeof lu === 'object') for (const p of PAGES_LUES) if (Number.isFinite(lu[p])) vuPages[p] = lu[p];
  } catch (e) { /* stockage indisponible : la cloche seule */ }
}
export function pageVue(page) {
  if (!session || !PAGES_LUES.includes(page)) return;
  vuPages[page] = Date.now();
  try { localStorage.setItem(clePages(), JSON.stringify(vuPages)); } catch (e) { /* rien */ }
  render();
}

const heure = (ts) => toDate(ts)?.getTime() || 0;
// Copie sur ce téléphone de l'heure du dernier passage (Tanguy, 27/11 : sur son Pixel, le « 9+ » revenait à chaque
// actualisation). Quand l'écriture sur la fiche est refusée ou n'est pas encore partie (hors ligne, fiche ancienne),
// la cloche ne retombe plus en « non lu » : le plus récent des deux fait foi.
const cleVues = () => `papote.notifsVues.${session.fid}.${session.uid}`;
let vuLocal = 0;
function lireVues() {
  vuLocal = 0;
  try {
    const lu = Number(localStorage.getItem(cleVues()));
    if (Number.isFinite(lu) && lu > 0 && lu <= Date.now() + 60_000) vuLocal = lu;
  } catch (e) { /* stockage indisponible : la fiche seule */ }
}
function lastRead() {
  const moi = members.find((m) => m.id === session.uid);
  return Math.max(vuIci, vuLocal, heure(session.member?.notifsVues), heure(moi?.notifsVues));
}

// Page Notifications ouverte : une écriture au plus par ouverture, et seulement s'il y avait du nouveau (données
// mobiles comptées).
export function markNotifsRead() {
  if (!session) return;
  const avant = lastRead();
  const nouveau = !envoisLus || !avant || events().some((e) => !e.mine && !e.info && e.date.getTime() > avant);
  vuIci = Date.now();
  vuLocal = vuIci;
  try { localStorage.setItem(cleVues(), String(vuIci)); } catch (e) { /* rien */ }
  render();
  if (!nouveau) return;
  updateDoc(doc(db, 'families', session.fid, 'members', session.uid), { notifsVues: serverTimestamp() })
    .catch((err) => console.warn('Notifications vues non enregistrées', err));
}

// Page ouverte quand on touche la notification (famille.js) : ce dont elle parle.
const PAGE = {
  photo: 'photos', video: 'videos', message: 'messages', call: 'home', phone: 'home', sos: 'home', member: 'settings', agenda: 'agenda',
};

function who(uid, name) {
  return uid === session.uid ? 'Vous' : name;
}

function events() {
  const grand = session.family.name;
  const list = [];
  // mine : ce que vous avez fait vous-même ne compte pas comme nouveau.
  // missed : appel manqué, affiché en rouge.
  // info : simple nouvelle (« Mamie a vu… », appel décroché, rappel confirmé) : dans la liste, mais pas dans le chiffre
  // de la cloche. Avant, tout comptait : quelques envois vus par Mamie dans la journée et la cloche affichait « 9+ » à
  // chaque ouverture de l'app, sans rien à lire (Tanguy, 24/11). Le chiffre ne compte plus que ce qui vous attend :
  // réponse de Mamie, envoi d'un autre proche, appel manqué ou SOS, nouveau proche.
  const add = (date, icon, text, mine = false, missed = false, page = PAGE[icon], info = false) => {
    if (date) list.push({ date, icon, text, mine, missed, page, info });
  };
  const addInfo = (date, icon, text, page = PAGE[icon]) => add(date, icon, text, false, false, page, true);
  for (const p of posts) {
    if (p.type === 'reply') {
      add(toDate(p.createdAt), 'message', `${grand} a répondu : « ${p.text} »`);
      continue;
    }
    if (!WHAT[p.type]) continue; // anciens messages vocaux : plus montrés
    const author = who(p.authorUid, p.authorName);
    const verb = author === 'Vous' ? 'avez' : 'a';
    const text = p.type === 'message'
      ? `${author} ${verb} écrit : « ${p.text} »`
      : `${author} ${verb} envoyé ${p.photos?.length > 1 ? `${p.photos.length} photos` : WHAT[p.type]}${p.text ? ` : « ${p.text} »` : ''}`;
    add(toDate(p.createdAt), p.type, text, author === 'Vous');
    if (p.seenAt) {
      const of = p.authorUid === session.uid
        ? `que vous avez ${p.type === 'message' ? 'envoyé' : 'envoyée'}`
        : `de ${p.authorName}`;
      addInfo(toDate(p.seenAt), 'seen', `${grand} a vu ${WHAT_OF[p.type]} ${of}`, PAGE[p.type]);
    }
  }
  // La tablette appelle un proche (calleeUid), ou toute la famille et le SOS (sans calleeUid, comme les appels
  // des proches vers la tablette : on les reconnaît à l'appelant).
  const tablettes = new Set(members.filter((m) => m.role === 'tablette').map((m) => m.id));
  // SOS : une seule ligne par SOS, avec sa vraie fin. Avant, chaque essai d'appel (« SOS », « SOS 2 ») faisait sa
  // ligne, et un SOS réglé au téléphone ou par « Je m'en occupe » restait écrit « personne n'a pu répondre », ou
  // n'apparaissait pas s'il n'était plus dans les derniers appels (Tanguy, 27/11). Le dernier SOS est lu sur la fiche
  // de la tablette (sos : { debut, fin, uid, nom }) et sur families.sosPris ; les plus anciens, sur leurs appels.
  const soses = []; // { debut, fin, uid, nom } du plus récent au plus ancien
  const sosFiche = members.filter((m) => m.role === 'tablette').map((m) => m.sos)
    .filter((x) => x && Number.isSafeInteger(x.debut) && x.debut > 0).sort((a, b) => b.debut - a.debut)[0];
  if (sosFiche) {
    const pris = session.family.sosPris;
    const s = { debut: sosFiche.debut, fin: sosFiche.fin || '', uid: sosFiche.uid || '', nom: sosFiche.nom || '' };
    if (!s.fin && pris && pris.debut === s.debut) Object.assign(s, { fin: 'pris', uid: pris.uid || '', nom: pris.nom || '' });
    soses.push(s);
  }
  const appelsSos = calls.filter((c) => !c.calleeUid && tablettes.has(c.callerUid) && /^SOS/.test(c.calleeName || '') && toDate(c.createdAt))
    .sort((a, b) => toDate(a.createdAt) - toDate(b.createdAt));
  for (const c of appelsSos) {
    const t = toDate(c.createdAt).getTime();
    // Les appels d'un même SOS se suivent en quelques minutes (horloge de la tablette : 2 min d'écart tolérées).
    let s = soses.find((x) => t > x.debut - 2 * 60_000 && t < x.debut + SOS_MEME_MS);
    if (!s) { s = { debut: t, fin: '', uid: '', nom: '' }; soses.push(s); }
    if (c.state === 'ringing') s.sonne = true;
    else s.essais = (s.essais || 0) + 1;
    if (!s.fin && c.answer?.uid) Object.assign(s, { fin: 'repondu', uid: c.answer.uid, nom: c.answer.name || '' });
  }
  for (const s of soses) {
    const moi = !!s.uid && s.uid === session.uid;
    const qui = s.nom || 'un proche';
    const suite = s.fin === 'repondu' ? (moi ? 'vous avez répondu' : `${qui} a répondu`)
      : s.fin === 'pris' ? (moi ? 'vous vous en occupez' : `${qui} s'en occupe`)
        : s.fin === 'arrete' ? 'SOS arrêté sur la tablette'
          // Sans fin connue : rien de plus tant que ça sonne, ou tant qu'aucun essai n'est fini sur un SOS récent.
          : s.sonne || (!s.essais && Date.now() - s.debut < SOS_MEME_MS) ? '' : 'personne n\'a pu répondre';
    add(new Date(s.debut), 'sos', `${grand} a appuyé sur SOS${suite ? ` : ${suite}` : ''}`, moi, !s.fin);
  }
  // La tablette appelle un proche (calleeUid), ou toute la famille (sans calleeUid, comme les appels des proches vers
  // la tablette : on les reconnaît à l'appelant). Ces appels sont en audio : icône téléphone, pas caméra.
  for (const c of calls) {
    const fromTablet = !!c.calleeUid || tablettes.has(c.callerUid);
    const date = toDate(c.endedAt) || toDate(c.createdAt);
    // Un appel sans réponse (personne n'a décroché, ou refusé) est un appel manqué.
    const manque = !c.answer && ['missed', 'declined', 'ended'].includes(c.state);
    if (fromTablet && !c.calleeUid) {
      if (c.state === 'ringing' || /^SOS/.test(c.calleeName || '')) continue;
      const moi = c.answer?.uid === session.uid;
      const qui = c.answer?.uid ? who(c.answer.uid, c.answer.name) : null;
      const repondu = qui && (qui === 'Vous' ? 'vous avez répondu' : `${qui} a répondu`);
      if (repondu) add(date, 'phone', `${grand} a appelé toute la famille : ${repondu}`, moi, false, PAGE.call, true);
      else if (manque) add(date, 'phone', `Appel manqué ${deOuD(grand)}${grand}`, false, true);
    } else if (fromTablet) {
      if (c.state === 'ringing') continue;
      const to = who(c.calleeUid, c.calleeName);
      if (manque) add(date, 'phone', `Appel manqué ${deOuD(grand)}${grand}${to === 'Vous' ? '' : ` pour ${to}`}`, false, true);
      else add(date, 'phone', `${grand} ${to === 'Vous' ? 'vous a appelé' : `a appelé ${to}`}`, false, false, PAGE.call, true);
    } else {
      // Mon propre appel (même sans réponse de la tablette) n'est pas une nouveauté pour moi : hors du chiffre.
      const moi = c.callerUid === session.uid;
      const from = who(c.callerUid, c.callerName);
      const verb = from === 'Vous' ? 'avez' : 'a';
      if (c.state === 'missed') add(date, 'call', `${grand} n'a pas répondu à ${moi ? 'votre appel' : `l'appel ${deOuD(from)}${from}`}`, moi, true);
      else if (c.state === 'declined') add(date, 'call', `${grand} a refusé ${moi ? 'votre appel' : `l'appel ${deOuD(from)}${from}`}`, moi, true);
      else if (c.state !== 'ringing') add(date, 'call', `${from} ${verb} appelé ${grand}`, moi, false, PAGE.call, true);
    }
  }
  for (const m of members) {
    if (m.role === 'tablette' || !m.joinedAt) continue;
    add(toDate(m.joinedAt), 'member', m.id === session.uid ? 'Vous avez rejoint la famille' : `${m.name} a rejoint la famille`, m.id === session.uid);
  }
  for (const r of reminders) {
    if (!r.lastAck) continue;
    const date = new Date(`${r.lastAck.slice(0, 10)}T${r.lastAck.slice(11, 16) || '00:00'}`);
    if (!Number.isNaN(date.getTime())) addInfo(date, 'agenda', `${grand} a confirmé le rappel « ${r.title} »`);
  }
  return list.sort((a, b) => b.date - a.date).slice(0, 50);
}

function when(date) {
  const now = new Date();
  const hm = heureFr(date);
  if (date.toDateString() === now.toDateString()) return hm;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `hier, ${hm}`;
  return `${date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}, ${hm}`;
}

function render() {
  if (!session) return;
  const list = events();
  const read = lastRead();
  // Arrivé pendant qu'on regarde la page où il s'affiche (réponse de Mamie, Messages ouvert) : vu aussi.
  const ouverte = PAGES_LUES.find((p) => document.getElementById(`view-${p}`)?.hidden === false);
  if (ouverte && document.visibilityState === 'visible') {
    vuPages[ouverte] = Date.now();
    try { localStorage.setItem(clePages(), JSON.stringify(vuPages)); } catch (e) { /* rien */ }
  }
  const isFresh = (e) => !e.mine && !e.info && e.date.getTime() > Math.max(read, vuPages[e.page] || 0);
  const fresh = list.filter(isFresh).length;
  $('nav-badge').textContent = fresh > 9 ? '9+' : String(fresh);
  $('nav-badge').hidden = fresh === 0;
  $('notifs-empty').hidden = list.length > 0;
  // À l'ouverture de l'app, chaque arrivée (envois, appels, membres, rappels, puis leur version du serveur) redemandait
  // toute la liste : elle n'est redessinée que si elle a changé.
  const cle = list.map((e) => `${e.date.getTime()}|${e.text}|${isFresh(e)}|${e.missed}`).join('\n');
  if (cle === dessinee) return;
  dessinee = cle;
  $('notifs').replaceChildren(...list.map((e) => {
    const li = document.createElement('li');
    li.className = `notif n-${e.icon}${isFresh(e) ? ' fresh' : ''}${e.missed ? ' missed' : ''}`;
    if (e.page) li.dataset.page = e.page;
    li.innerHTML = `<span class="notif-icon"><svg><use href="#i-${{
      photo: 'photo', video: 'video', message: 'message', seen: 'eye', call: 'call', phone: 'phone', sos: 'sos', member: 'user', agenda: 'agenda',
    }[e.icon]}"/></svg></span>`;
    const body = document.createElement('div');
    body.className = 'notif-body';
    const text = document.createElement('p');
    text.textContent = e.text;
    const time = document.createElement('p');
    time.className = 'muted small';
    time.textContent = when(e.date);
    body.append(text, time);
    li.append(body);
    return li;
  }));
}

export function setNotifMembers(list) { members = list; render(); }
export function setNotifReminders(list) { reminders = list; render(); }

export function startNotifs(current) {
  stopNotifs();
  session = current;
  vuIci = 0;
  lirePages();
  lireVues();
  const base = (name) => collection(db, 'families', session.fid, name);
  const read = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }));
  stops.push(onSnapshot(query(base('posts'), orderBy('createdAt', 'desc'), limit(30)),
    (snap) => { posts = read(snap); envoisLus = true; render(); },
    (err) => console.error('Notifications : envois illisibles', err)));
  stops.push(onSnapshot(query(base('calls'), orderBy('createdAt', 'desc'), limit(30)),
    (snap) => { calls = read(snap); render(); },
    (err) => console.error('Notifications : appels illisibles', err)));
}

export function stopNotifs() {
  stops.forEach((stop) => stop());
  stops = [];
  posts = [];
  calls = [];
  vuIci = 0;
  envoisLus = false;
  dessinee = null;
  vuPages = {};
  vuLocal = 0;
}
