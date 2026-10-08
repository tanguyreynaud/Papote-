// Page « Notifications » : les derniers événements de la famille, racontés en phrases.
import {
  query, orderBy, limit,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { db, collection, onSnapshot, toDate } from './firebase.js';

const $ = (id) => document.getElementById(id);
const READ_KEY = 'papote.notifsLues';
const WHAT = { photo: 'une photo', video: 'une vidéo', message: 'un message' };
const WHAT_OF = { photo: 'la photo', video: 'la vidéo', message: 'le message' };

let session = null;
let stops = [];
let posts = [];
let calls = [];
let members = [];
let reminders = [];

function lastRead() {
  try { return Number(localStorage.getItem(READ_KEY)) || 0; } catch (e) { return 0; }
}

export function markNotifsRead() {
  try { localStorage.setItem(READ_KEY, String(Date.now())); } catch (e) { /* stockage indisponible */ }
  render();
}

function who(uid, name) {
  return uid === session.uid ? 'Vous' : name;
}

function events() {
  const grand = session.family.name;
  const list = [];
  // mine : ce que vous avez fait vous-même ne compte pas comme nouveau.
  const add = (date, icon, text, mine = false) => { if (date) list.push({ date, icon, text, mine }); };
  for (const p of posts) {
    if (p.type === 'reply') {
      add(toDate(p.createdAt), 'message', `${grand} a répondu : « ${p.text} »`);
      continue;
    }
    if (!WHAT[p.type]) continue; // anciens vocaux
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
      add(toDate(p.seenAt), 'seen', `${grand} a vu ${WHAT_OF[p.type]} ${of}`);
    }
  }
  for (const c of calls) {
    const fromTablet = !!c.calleeUid;
    const date = toDate(c.endedAt) || toDate(c.createdAt);
    if (fromTablet) {
      const to = who(c.calleeUid, c.calleeName);
      add(date, 'call', c.state === 'missed' || c.state === 'ringing'
        ? `Appel manqué de ${grand}${to === 'Vous' ? '' : ` pour ${to}`}`
        : `${grand} a appelé ${to === 'Vous' ? 'vous' : to}`);
    } else {
      const from = who(c.callerUid, c.callerName);
      const verb = from === 'Vous' ? 'avez' : 'a';
      if (c.state === 'missed') add(date, 'call', `${grand} n'a pas répondu à l'appel de ${from === 'Vous' ? 'vous' : from}`);
      else if (c.state === 'declined') add(date, 'call', `${grand} a refusé l'appel de ${from === 'Vous' ? 'vous' : from}`);
      else if (c.state !== 'ringing') add(date, 'call', `${from} ${verb} appelé ${grand}`, from === 'Vous');
    }
  }
  for (const m of members) {
    if (m.role === 'tablette' || !m.joinedAt) continue;
    add(toDate(m.joinedAt), 'member', m.id === session.uid ? 'Vous avez rejoint la famille' : `${m.name} a rejoint la famille`, m.id === session.uid);
  }
  for (const r of reminders) {
    if (!r.lastAck) continue;
    const date = new Date(`${r.lastAck.slice(0, 10)}T${r.lastAck.slice(11, 16) || '00:00'}`);
    if (!Number.isNaN(date.getTime())) add(date, 'agenda', `${grand} a confirmé le rappel « ${r.title} »`);
  }
  return list.sort((a, b) => b.date - a.date).slice(0, 50);
}

function when(date) {
  const now = new Date();
  const hm = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
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
  const isFresh = (e) => !e.mine && e.date.getTime() > read;
  const fresh = list.filter(isFresh).length;
  $('nav-badge').textContent = fresh > 9 ? '9+' : String(fresh);
  $('nav-badge').hidden = fresh === 0;
  $('notifs-empty').hidden = list.length > 0;
  $('notifs').replaceChildren(...list.map((e) => {
    const li = document.createElement('li');
    li.className = `notif n-${e.icon}${isFresh(e) ? ' fresh' : ''}`;
    li.innerHTML = `<span class="notif-icon"><svg><use href="#i-${{
      photo: 'photo', video: 'video', message: 'message', seen: 'eye', call: 'call', member: 'user', agenda: 'agenda',
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
  const base = (name) => collection(db, 'families', session.fid, name);
  const read = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }));
  stops.push(onSnapshot(query(base('posts'), orderBy('createdAt', 'desc'), limit(30)),
    (snap) => { posts = read(snap); render(); },
    (err) => console.error('Notifications : envois illisibles', err)));
  stops.push(onSnapshot(query(base('calls'), orderBy('createdAt', 'desc'), limit(10)),
    (snap) => { calls = read(snap); render(); },
    (err) => console.error('Notifications : appels illisibles', err)));
}

export function stopNotifs() {
  stops.forEach((stop) => stop());
  stops = [];
  posts = [];
  calls = [];
}
