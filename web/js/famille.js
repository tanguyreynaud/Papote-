// App famille : envoyer photos, vidéos et messages vers la tablette.
import {
  query, where, orderBy, limit, getDocs, getCountFromServer,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getStorage, ref, uploadBytes, getDownloadURL, deleteObject,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';
import {
  db, doc, getDoc, updateDoc, deleteDoc, collection, onSnapshot, writeBatch, serverTimestamp, bumpRev, increment,
  loadMembership, createFamily, joinFamily, leaveFamily, watchMembers, currentUser, savedFamilyId, saveFamilyId,
  addPost, deletePost, loadMedia, formatCode, normalizeCode, toDate, CodeInconnuError,
  MAX_VIDEO_CHUNKS, VIDEO_CHUNK,
  choisirBase, bucketUrl,
} from './firebase.js';
import { askConfirm, notice, avantDePartir, chooseAction } from './ui.js';
import { showGuideOnce } from './guide.js';
import {
  abonnementOk, FORMULES, LIBELLES, ouvrirPortail, payer, rattacherCommande, resilier, annulerResiliation,
  finDeContrat, retracter, inviterParEmail, jetonAppelNatif,
} from './abonnement.js';
import { startCall, watchTabletBusy, watchIncomingCalls, answerIncoming, warmUpCalls, declineIncoming, reportCallIncident } from './appel.js';
import { pushSupported, pushAllowed, pushRefused, enablePush, closeCallNotification, rememberNativeToken, inNativeApp } from './push.js';
import { prepareVideo } from './video.js';
import { startAgenda, stopAgenda } from './agenda.js';
import {
  isRealAccount, myEmail, connexionParJeton, signInGoogle, finishRedirect, sendEmailLink, isEmailLink, completeEmailLink, logOut,
  myMemberships, familyName, tagLegacyMember, myInvitations, acceptInvitation,
  inviteByEmail, cancelInvitation, acceptMember, changeFamilyCode,
} from './compte.js';
import {
  startNotifs, stopNotifs, markNotifsRead, setNotifMembers, setNotifReminders,
} from './notifs.js';

const $ = (id) => document.getElementById(id);
// Adresse publique de l'app pour les liens et QR codes partagés (la version test garde la sienne).
const APP_URL = /--|localhost/.test(location.hostname) ? location.origin : 'https://app.mapapote.fr';
// Réglages « Modifier / Enregistrer » : { fill, save } par carte (voir plus bas).
const SETTINGS = {};
const MAX_IMAGE_CHARS = 900_000; // un document Firestore est limité à 1 Mo

let session = null; // { fid, family, member, uid }
let stopMembers = null;
let stopTabletBusy = null;
let stopIncoming = null;

const VIEWS = ['view-invite', 'view-profile', 'view-pair', 'loading', 'view-login', 'view-link-email', 'view-invited', 'view-pending', 'view-join', 'view-home', 'view-photos', 'view-videos', 'view-messages', 'view-agenda', 'view-settings', 'view-notifs', 'view-support'];

function show(view) {
  for (const id of VIEWS) $(id).hidden = id !== view;
  document.body.classList.toggle('on-support', view === 'view-support');
  // La barre du bas n'apparaît que sur Accueil, Notifications et Support.
  $('nav').hidden = !$(view).classList.contains('tab-page');
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', `view-${b.dataset.tab}` === view));
  if (view === 'view-notifs') markNotifsRead();
  window.scrollTo(0, 0);
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $('toast').hidden = true; }, 2500);
}

// ---------- Rejoindre / créer ----------

$('form-join').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = e.target.querySelector('button[type=submit]');
  button.disabled = true;
  showError($('join-error'), '');
  try {
    const fidRejoint = await joinFamily($('join-code').value, $('join-name').value.trim());
    // Invité aussi par e-mail : l'invitation est remplie, on l'efface.
    if (myEmail()) deleteDoc(doc(db, 'families', fidRejoint, 'invitations', myEmail())).catch(() => {});
    forgetInviteCode();
    await enterApp();
  } catch (err) {
    console.error(err);
    showError($('join-error'), err instanceof CodeInconnuError
      ? 'Ce code ne correspond à aucune famille. Vérifiez-le.'
      : 'Impossible de rejoindre pour le moment. Vérifiez la connexion internet.');
  } finally {
    button.disabled = false;
  }
});

$('form-create').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = e.target.querySelector('button[type=submit]');
  button.disabled = true;
  showError($('create-error'), '');
  try {
    await createFamily($('create-grand').value.trim(), $('create-name').value.trim());
    await enterApp();
    openPage('settings');
  } catch (err) {
    console.error(err);
    showError($('create-error'), 'Impossible de créer la famille. Vérifiez la connexion internet.');
  } finally {
    button.disabled = false;
  }
});

// ---------- Navigation : l'accueil et une page par type d'envoi ----------
// Chaque page ouverte ajoute une entrée d'historique : le bouton retour d'Android ramène à l'accueil.

let page = null;
let stopPage = null;

// Photos et vidéos : 10 envois au départ, 10 de plus quand on arrive en bas du fil.
const FEED_STEP = 10;
let feedLimit = FEED_STEP;
let feedCount = 0;

function watchFeed(type, render) {
  feedLimit = FEED_STEP;
  let stop = null;
  const subscribe = () => {
    stop?.();
    stop = watchType([type], feedLimit, (posts) => { feedCount = posts.length; render(posts); });
  };
  subscribe();
  const sentinel = $(`${type === 'photo' ? 'photos' : 'videos'}-more`);
  const observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && feedCount >= feedLimit) {
      feedLimit += FEED_STEP;
      subscribe();
    }
  }, { rootMargin: '600px' });
  observer.observe(sentinel);
  return () => { observer.disconnect(); stop?.(); };
}

const PAGES = {
  photos: () => watchFeed('photo', renderPhotos),
  videos: () => watchFeed('video', renderVideos),
  messages: () => watchType(['message', 'reply', 'voice'], 60, renderMessages),
  agenda: () => null,
  pair: () => { resetPairing(); return () => { stopPair?.(); stopPair = null; }; },
  settings: () => { renderSettings(); return null; },
  invite: () => { renderSettings(); return null; },
};

function openPage(name, push = true) {
  stopPage?.();
  stopPage = PAGES[name]();
  page = name;
  if (push) history.pushState({ page: name }, '');
  show(`view-${name}`);
}

function goHome() {
  stopPage?.();
  stopPage = null;
  page = null;
  closeSheets();
  closeViewer();
  if (session) show('view-home');
}

// Barre du bas : on change d'onglet sans empiler l'historique.
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'home') goHome();
    else show(`view-${btn.dataset.tab}`);
  });
});

$('btn-invite').addEventListener('click', () => openPage('invite'));

document.querySelectorAll('.tile[data-page]').forEach((tile) => {
  tile.addEventListener('click', () => openPage(tile.dataset.page));
});
document.querySelectorAll('.page .back').forEach((btn) => {
  btn.addEventListener('click', () => history.back());
});
window.addEventListener('popstate', (e) => {
  // Une feuille ou la visionneuse ouverte se ferme d'abord.
  if (!$('viewer').hidden || !$('sheet-post').hidden || !$('sheet-reminder').hidden || !$('sheet-wifi').hidden) {
    closeSheets();
    closeViewer();
    return;
  }
  const next = e.state?.page;
  if (next && session) openPage(next, false);
  else goHome();
});

// Les derniers envois d'un type, du plus récent au plus ancien.
// Sans l'index Firestore (type + date), on lit les derniers envois et on trie ici.
function watchType(types, max, callback) {
  const posts = collection(db, 'families', session.fid, 'posts');
  const read = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }));
  let stop = onSnapshot(
    query(posts, where('type', 'in', types), orderBy('createdAt', 'desc'), limit(max)),
    (snap) => callback(read(snap)),
    (err) => {
      if (err.code !== 'failed-precondition') { console.error('Lecture des envois impossible', err); return; }
      stop = onSnapshot(query(posts, orderBy('createdAt', 'desc'), limit(150)), (snap) => {
        callback(read(snap).filter((p) => types.includes(p.type)).slice(0, max));
      }, (e) => console.error('Lecture des envois impossible', e));
    },
  );
  return () => stop();
}

function timeLabel(date) {
  if (!date) return '';
  const now = new Date();
  const hm = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return `aujourd'hui à ${hm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `hier à ${hm}`;
  return `${date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} à ${hm}`;
}

// Version courte pour les galeries : « 09:34 », « hier », « 12 oct. ».
function shortLabel(date) {
  if (!date) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'hier';
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

// L'auteur supprime ses envois ; un responsable de la famille peut tout supprimer.
function canDelete(post) {
  return post.authorUid === session.uid || amFamilyAdmin();
}

// Propriétaire : celui qui a créé la famille (et payé la tablette) ; lui seul règle la tablette.
function amOwner() {
  return !!session?.family && session.family.createdBy === session.uid;
}

function amFamilyAdmin() {
  const f = session?.family;
  return !!f && (f.createdBy === session.uid || (f.admins || []).includes(session.uid));
}

async function confirmDelete(post, what) {
  if (!await askConfirm(`Supprimer ${what} de la tablette ?`)) return;
  try {
    await removePost(post);
  } catch (err) {
    console.error(err);
    notice("La suppression a échoué. Vérifiez la connexion.");
  }
}

// ---------- Photos et vidéos : galerie ----------

function galleryItem(post, what, onOpen) {
  const li = document.createElement('li');
  li.className = 'shot';
  const frame = document.createElement('button');
  frame.type = 'button';
  frame.className = 'shot-frame';
  frame.setAttribute('aria-label', `Voir ${what}`);
  const img = document.createElement('img');
  img.src = post.thumb || post.image || '';
  img.alt = '';
  img.loading = 'lazy';
  frame.append(img);
  if (post.type === 'video') {
    const play = document.createElement('span');
    play.className = 'shot-play';
    play.append(icon('play'));
    frame.append(play);
    if (post.duration) {
      const d = document.createElement('span');
      d.className = 'shot-duration';
      d.textContent = `${post.duration} s`;
      frame.append(d);
    }
  }
  frame.addEventListener('click', onOpen);
  li.append(frame);
  // Plusieurs photos dans un envoi : on les fait défiler du doigt, avec « 2 / 5 ».
  if (post.photos?.length > 1) {
    const strip = document.createElement('div');
    strip.className = 'shot-strip';
    post.photos.forEach((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'shot-frame';
      b.setAttribute('aria-label', `Voir la photo ${i + 1}`);
      const im = document.createElement('img');
      im.src = i === 0 ? (post.thumb || p.thumb) : p.thumb;
      im.alt = '';
      im.loading = 'lazy';
      b.append(im);
      b.addEventListener('click', () => openPhoto({ ...post, thumb: p.thumb, imageUrl: p.imageUrl }));
      strip.append(b);
    });
    const count = document.createElement('span');
    count.className = 'shot-count';
    count.textContent = `1 / ${post.photos.length}`;
    strip.addEventListener('scroll', () => {
      count.textContent = `${Math.round(strip.scrollLeft / strip.clientWidth) + 1} / ${post.photos.length}`;
    }, { passive: true });
    const wrap = document.createElement('div');
    wrap.className = 'shot-multi';
    wrap.append(strip, count);
    frame.replaceWith(wrap);
  }

  const meta = document.createElement('div');
  meta.className = 'shot-meta';
  const info = document.createElement('div');
  info.className = 'shot-info';
  if (post.text) {
    const caption = document.createElement('p');
    caption.className = 'shot-caption';
    caption.textContent = post.text;
    info.append(caption);
  }
  const who = document.createElement('p');
  who.className = 'muted small';
  who.textContent = `${post.authorName} · ${timeLabel(toDate(post.createdAt))}`;
  info.append(who);
  meta.append(info);
  const badge = document.createElement('span');
  badge.className = `read-badge ${post.seenAt ? 'read' : 'unread'}`;
  badge.textContent = post.seenAt ? 'Lu' : 'Non lu';
  meta.append(badge);
  if (canDelete(post)) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn del';
    del.setAttribute('aria-label', `Supprimer ${what}`);
    del.append(icon('trash'));
    del.addEventListener('click', () => confirmDelete(post, what));
    meta.append(del);
  }
  li.append(meta);
  return li;
}

function renderPhotos(posts) {
  $('photos').replaceChildren(...posts.map((p) => galleryItem(p, 'cette photo', () => openPhoto(p))));
  $('photos-empty').hidden = posts.length > 0;
}

function renderVideos(posts) {
  $('videos').replaceChildren(...posts.map((p) => galleryItem(p, 'cette vidéo', () => openVideo(p))));
  $('videos-empty').hidden = posts.length > 0;
}

// ---------- Visionneuse ----------

let viewerPost = null;

function openViewer(post) {
  viewerPost = post;
  $('viewer-delete').hidden = !canDelete(post);
  $('viewer').hidden = false;
  $('viewer-caption').textContent = post.text || '';
  history.pushState({ page, viewer: true }, '');
}

function closeViewer() {
  $('viewer').hidden = true;
  $('viewer-video').pause();
  $('viewer-video').removeAttribute('src');
  $('viewer-video').hidden = true;
  $('viewer-img').hidden = true;
  $('viewer-img').removeAttribute('src');
}

async function openPhoto(post) {
  openViewer(post);
  $('viewer-img').hidden = false;
  $('viewer-img').src = post.thumb || post.image;
  try {
    const src = post.imageUrl || await loadMedia(session.fid, post, 'image');
    if (src && !$('viewer').hidden) $('viewer-img').src = src;
  } catch (err) {
    console.error(err);
  }
}

async function openVideo(post) {
  openViewer(post);
  $('viewer-caption').textContent = 'Chargement de la vidéo…';
  try {
    const src = post.videoUrl || await loadMedia(session.fid, post, 'video');
    if ($('viewer').hidden) return;
    $('viewer-caption').textContent = post.text || '';
    $('viewer-video').hidden = false;
    $('viewer-video').src = src;
    $('viewer-video').play().catch(() => {});
  } catch (err) {
    console.error(err);
    $('viewer-caption').textContent = "La vidéo n'a pas pu être chargée.";
  }
}

$('viewer-close').addEventListener('click', () => history.back());

$('viewer-delete').addEventListener('click', async () => {
  const post = viewerPost;
  const what = post.type === 'video' ? 'cette vidéo' : 'cette photo';
  if (!await askConfirm(`Supprimer ${what} de la tablette ?`)) return;
  history.back();
  try { await removePost(post); } catch (err) { console.error(err); notice('La suppression a échoué. Vérifiez la connexion.'); }
});

// Enregistrer sur le téléphone : feuille de partage sur iPhone (« Enregistrer l'image »),
// téléchargement ailleurs (la photo arrive dans la galerie, dossier Téléchargements).
$('viewer-save').addEventListener('click', async () => {
  const post = viewerPost;
  const video = post.type === 'video';
  $('viewer-save').disabled = true;
  try {
    const src = (video ? post.videoUrl : post.imageUrl) || await loadMedia(session.fid, post, video ? 'video' : 'image');
    let blob;
    try {
      blob = await (await fetch(src)).blob();
    } catch (err) {
      // Storage refuse la lecture depuis la page (réglage CORS absent) : on ouvre le fichier,
      // un appui long permet alors de l'enregistrer.
      window.open(src, '_blank');
      toast("Appuyez longuement sur la photo pour l'enregistrer");
      return;
    }
    const ext = video ? ((post.mime || blob.type).includes('mp4') ? 'mp4' : 'webm') : 'jpg';
    const file = new File([blob], `papote-${post.id}.${ext}`, { type: blob.type || (video ? 'video/mp4' : 'image/jpeg') });
    if (isIos() && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file] });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      toast('Enregistré dans le téléphone');
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
      notice("L'enregistrement a échoué. Vérifiez la connexion.");
    }
  } finally {
    $('viewer-save').disabled = false;
  }
});

// ---------- Messages ----------

function renderMessages(posts) {
  const list = $('messages');
  const grand = session.family.name;
  // Anciens vocaux sans fichier (avant la refonte) : on ne les montre pas.
  const shown = posts.filter((p) => p.type !== 'voice' || p.audioUrl);
  const items = shown.slice().reverse().map((post) => {
    const mine = post.authorUid === session.uid;
    const vocal = post.type === 'voice';
    const li = document.createElement('li');
    li.className = `bubble ${mine ? 'mine' : 'theirs'}${post.type === 'reply' || vocal ? ' reply' : ''}`;
    if (!mine && post.type !== 'reply' && !vocal && faces[post.authorUid]) {
      li.classList.add('with-face');
      li.append(avatar(faces[post.authorUid]));
    }
    if (!mine) {
      const who = document.createElement('p');
      who.className = 'bubble-who';
      who.textContent = post.type === 'reply' || vocal ? grand : post.authorName;
      li.append(who);
    }
    if (vocal) li.append(...bulleVocale(post));
    if (post.text) {
      const text = document.createElement('p');
      text.className = 'bubble-text';
      text.textContent = post.text;
      li.append(text);
    }
    const foot = document.createElement('p');
    foot.className = 'bubble-foot';
    let label = timeLabel(toDate(post.createdAt));
    if (post.type === 'message') label += post.seenAt ? ' · Vu' : '';
    foot.textContent = label;
    if (canDelete(post)) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'bubble-del';
      del.setAttribute('aria-label', 'Supprimer ce message');
      del.append(icon('trash'));
      del.addEventListener('click', () => confirmDelete(post, 'ce message'));
      foot.prepend(del);
    }
    li.append(foot);
    return li;
  });
  list.replaceChildren(...items);
  $('messages-empty').hidden = shown.length > 0;
  requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
}

// Réponse vocale de la tablette : lecteur audio, et la photo à laquelle elle répond.
function bulleVocale(post) {
  const parts = [];
  if (post.replyTo) {
    const ref = document.createElement('div');
    ref.className = 'vocal-ref';
    ref.textContent = 'En réponse à une photo';
    getDoc(doc(db, 'families', session.fid, 'posts', post.replyTo)).then((snap) => {
      const p = snap.data();
      if (!p) return;
      const quoi = p.type === 'video' ? 'une vidéo' : p.type === 'message' ? 'un message' : 'une photo';
      ref.textContent = `En réponse à ${quoi} de ${p.authorUid === session.uid ? 'vous' : p.authorName}`;
      if (p.thumb) {
        const img = document.createElement('img');
        img.src = p.thumb;
        img.alt = '';
        ref.prepend(img);
      }
    }).catch(() => {});
    parts.push(ref);
  }
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'none';
  audio.src = post.audioUrl;
  audio.className = 'vocal-audio';
  parts.push(audio);
  return parts;
}

function updateCount() {
  const left = 160 - $('message-text').value.length;
  $('message-count').textContent = left <= 40 ? `${left}` : '';
  // La zone de texte grandit avec le message.
  $('message-text').style.height = 'auto';
  $('message-text').style.height = `${$('message-text').scrollHeight}px`;
}
$('message-text').addEventListener('input', updateCount);

$('form-message').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('message-text').value.trim();
  if (!text) { $('message-text').focus(); return; }
  if (paused()) return;
  $('btn-message').disabled = true;
  const item = { kind: 'message', text, author: { authorUid: session.uid, authorName: session.member.name } };
  try {
    if (!navigator.onLine) throw new Error('hors ligne');
    await sendItem(item);
  } catch (err) {
    console.warn('Message mis en attente', err);
    await queue(item);
  } finally {
    $('message-text').value = '';
    updateCount();
    $('btn-message').disabled = false;
  }
});

// ---------- Première installation : régler la tablette pas à pas (propriétaire) ----------
// Une famille toute neuve (ni veille, ni options) : on propose de tout régler d'un coup.
// La ville de la météo est choisie sur la tablette à son installation.
// Tout reste modifiable ensuite dans Réglages > La tablette.
const INTRO_KEY = 'papote.introTablette.';

function introAFaire() {
  const f = session.family;
  if (!amOwner() || f.veille || f.options) return false;
  try { return localStorage.getItem(INTRO_KEY + session.fid) !== '1'; } catch (e) { return false; }
}

function introVue() {
  try { localStorage.setItem(INTRO_KEY + session.fid, '1'); } catch (e) { /* rien */ }
}

function showIntroTablette() {
  if (!introAFaire()) return false;
  const nom = session.family.name;
  const choix = { veille: { active: true, de: 23, a: 7 }, volume: 80,
    options: { lecture: true, reponseVocale: false, radio: { active: false, nom: RADIOS[0].nom, url: RADIOS[0].url } } };
  const back = document.createElement('div');
  back.className = 'guide-back intro-back';
  back.innerHTML = `<form class="guide intro" role="dialog" aria-modal="true" novalidate>
      <div class="guide-dots"></div>
      <div class="intro-step" data-step="0">
        <span class="guide-icon"><svg><use href="#i-settings"/></svg></span>
        <h2>Réglons la tablette</h2>
        <p></p>
      </div>
      <div class="intro-step" data-step="2" hidden>
        <h2>La nuit</h2>
        <p class="muted">L'écran s'éteint la nuit ; un toucher le rallume, et un appel le réveille.</p>
        <div class="toggle-list"><label class="toggle-row"><span class="toggle-text"><strong>Éteindre l'écran la nuit</strong></span><input type="checkbox" class="toggle" id="intro-veille" checked></label></div>
        <div id="intro-heures" class="sleep-hours">
          <label>De <select id="intro-de">HOURS</select></label>
          <label>à <select id="intro-a">HOURS</select></label>
        </div>
      </div>
      <div class="intro-step" data-step="3" hidden>
        <h2>Le son</h2>
        <p class="muted">Volume du son : <strong id="intro-volume-val"></strong></p>
        <input id="intro-volume" type="range" min="10" max="100" step="5" aria-label="Volume">
      </div>
      <div class="intro-step" data-step="4" hidden>
        <h2>Les options</h2>
        <div class="toggle-list">
          <label class="toggle-row"><span class="toggle-text"><strong>Lecture à voix haute</strong><span>Un bouton « Écouter » lit les messages</span></span><input type="checkbox" class="toggle" id="intro-lecture"></label>
          <label class="toggle-row"><span class="toggle-text"><strong>Réponse vocale</strong><span>Répondre à une photo en parlant</span></span><input type="checkbox" class="toggle" id="intro-vocal"></label>
          <label class="toggle-row"><span class="toggle-text"><strong>Radio</strong><span>Un bouton « Radio » à côté de « Appeler »</span></span><input type="checkbox" class="toggle" id="intro-radio"></label>
          <label class="station" id="intro-station-wrap" hidden>Station <select id="intro-station"></select></label>
        </div>
      </div>
      <div class="intro-step" data-step="5" hidden>
        <span class="guide-icon"><svg><use href="#i-user-plus"/></svg></span>
        <h2>C'est prêt</h2>
        <p></p>
      </div>
      <p class="error small intro-error" hidden></p>
      <div class="guide-buttons">
        <button type="button" class="link intro-prev">Retour</button>
        <button type="submit" class="primary intro-next"></button>
      </div>
    </form>`.replaceAll('HOURS', `<option value="0">0 h</option><option value="1">1 h</option><option value="2">2 h</option><option value="3">3 h</option><option value="4">4 h</option><option value="5">5 h</option><option value="6">6 h</option><option value="7">7 h</option><option value="8">8 h</option><option value="9">9 h</option><option value="10">10 h</option><option value="11">11 h</option><option value="12">12 h</option><option value="13">13 h</option><option value="14">14 h</option><option value="15">15 h</option><option value="16">16 h</option><option value="17">17 h</option><option value="18">18 h</option><option value="19">19 h</option><option value="20">20 h</option><option value="21">21 h</option><option value="22">22 h</option><option value="23">23 h</option>`);
  const $i = (sel) => back.querySelector(sel);
  const steps = [...back.querySelectorAll('.intro-step')];
  $i('.guide-dots').innerHTML = steps.map(() => '<span></span>').join('');
  $i('[data-step="0"] p').textContent = `Quelques questions pour que la tablette de ${nom} soit prête : nuit, son, options. Une minute, et tout reste modifiable dans Réglages.`;
  $i('[data-step="5"] p').textContent = `La tablette de ${nom} est réglée. Invitez maintenant la famille pour qu'elle envoie des photos.`;
  back.querySelectorAll('.intro-nom').forEach((e) => { e.textContent = nom; });
  $i('#intro-de').value = '23';
  $i('#intro-a').value = '7';
  $i('#intro-volume').value = String(choix.volume);
  $i('#intro-volume-val').textContent = `${choix.volume} %`;
  $i('#intro-lecture').checked = choix.options.lecture;
  const nat = document.createElement('optgroup');
  nat.label = 'Nationales';
  const loc = document.createElement('optgroup');
  loc.label = 'Locales (ex-France Bleu)';
  RADIOS.forEach((r, k) => (r.locale ? loc : nat).append(new Option(r.nom, String(k))));
  $i('#intro-station').append(nat, loc);
  $i('#intro-volume').addEventListener('input', () => { $i('#intro-volume-val').textContent = `${$i('#intro-volume').value} %`; });
  $i('#intro-veille').addEventListener('change', () => { $i('#intro-heures').hidden = !$i('#intro-veille').checked; });
  $i('#intro-radio').addEventListener('change', () => { $i('#intro-station-wrap').hidden = !$i('#intro-radio').checked; });

  let i = 0;
  const render = () => {
    steps.forEach((s, k) => { s.hidden = k !== i; });
    back.querySelectorAll('.guide-dots span').forEach((d, k) => d.classList.toggle('on', k === i));
    $i('.intro-next').textContent = i === 0 ? 'Commencer' : i === steps.length - 1 ? 'Inviter la famille' : 'Suivant';
    $i('.intro-prev').textContent = i === 0 ? 'Plus tard' : i === steps.length - 1 ? 'Terminer' : 'Retour';
    $i('.intro-error').hidden = true;
  };
  const close = () => { introVue(); back.remove(); };

  async function enregistrer() {
    choix.veille = { active: $i('#intro-veille').checked, de: Number($i('#intro-de').value), a: Number($i('#intro-a').value) };
    choix.volume = Number($i('#intro-volume').value);
    const r = RADIOS[Number($i('#intro-station').value)] || RADIOS[0];
    choix.options = {
      lecture: $i('#intro-lecture').checked,
      reponseVocale: $i('#intro-vocal').checked,
      radio: { active: $i('#intro-radio').checked, nom: r.nom, url: r.url },
    };
    // Une écriture par réglage : chaque règle n'accepte qu'un champ (avec rev) à la fois.
    const ecrire = (data) => updateDoc(doc(db, 'families', session.fid), { ...data, rev: increment(1) });
    await ecrire({ veille: choix.veille });
    await ecrire({ volume: choix.volume });
    await ecrire({ options: choix.options });
  }

  $i('.intro-prev').addEventListener('click', () => {
    if (i === 0 || i === steps.length - 1) close();
    else { i--; render(); }
  });
  $i('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (steps[i].dataset.step === '2' && $i('#intro-veille').checked && $i('#intro-de').value === $i('#intro-a').value) {
      showError($i('.intro-error'), "L'heure de fin doit être différente de l'heure de début.");
      return;
    }
    if (i === steps.length - 2) {
      $i('.intro-next').disabled = true;
      try {
        await enregistrer();
      } catch (err) {
        console.error(err);
        showError($i('.intro-error'), "L'enregistrement a échoué. Vérifiez la connexion et réessayez.");
        return;
      } finally {
        $i('.intro-next').disabled = false;
      }
    }
    if (i === steps.length - 1) { close(); openPage('invite'); return; }
    i++;
    render();
  });
  render();
  document.body.append(back);
  return true;
}

// ---------- Télécharger toutes les photos (fichier .zip) ----------
// Toutes les photos de la famille, pour les garder avant l'effacement au-delà des 200 dernières.

function chargerJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = () => resolve(window.JSZip);
    s.onerror = reject;
    document.head.append(s);
  });
}

$('btn-photos-zip').addEventListener('click', async () => {
  const btn = $('btn-photos-zip');
  btn.disabled = true;
  try {
    const [JSZip, snap] = await Promise.all([
      chargerJSZip(),
      getDocs(query(collection(db, 'families', session.fid, 'posts'), where('type', '==', 'photo'))),
    ]);
    const posts = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (toDate(a.createdAt)?.getTime() || 0) - (toDate(b.createdAt)?.getTime() || 0));
    const sources = [];
    for (const p of posts) {
      const quand = toDate(p.createdAt) || new Date();
      const base = `${quand.toISOString().slice(0, 10)} ${(p.authorName || 'Papote').replace(/[\/:*?"<>|]/g, '')}`;
      const urls = (p.photos || []).map((x) => x.imageUrl).filter(Boolean);
      if (!urls.length && p.imageUrl) urls.push(p.imageUrl);
      if (urls.length) urls.forEach((u, i) => sources.push({ nom: `${base} ${p.id.slice(0, 4)}-${i + 1}.jpg`, url: u }));
      else sources.push({ nom: `${base} ${p.id.slice(0, 4)}.jpg`, post: p });
    }
    if (!sources.length) { notice("Il n'y a encore aucune photo à télécharger."); return; }
    const zip = new JSZip();
    let n = 0;
    for (const src of sources) {
      n += 1;
      btn.lastChild.textContent = `${n} / ${sources.length}`;
      try {
        const url = src.url || await loadMedia(session.fid, src.post, 'image');
        if (!url) continue;
        const blob = await (await fetch(url)).blob();
        zip.file(src.nom, blob);
      } catch (err) {
        console.warn('Photo non récupérée', src.nom, err);
      }
    }
    btn.lastChild.textContent = 'Préparation…';
    const fichier = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(fichier);
    a.download = `Photos Papote - ${session.family.name}.zip`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    toast(`${sources.length} photo${sources.length > 1 ? 's' : ''} téléchargée${sources.length > 1 ? 's' : ''}`);
  } catch (err) {
    console.error(err);
    notice("Le téléchargement n'a pas pu se faire. Vérifiez la connexion et réessayez.");
  } finally {
    btn.disabled = false;
    btn.lastChild.textContent = 'Tout télécharger';
  }
});

// Messages rapides : un toucher envoie le message tel quel.
document.querySelectorAll('.quick-msg').forEach((b) => b.addEventListener('click', () => {
  if ($('btn-message').disabled) return;
  $('message-text').value = b.textContent;
  $('form-message').requestSubmit();
}));

// ---------- Ajouter une photo ou une vidéo ----------

let addMode = null; // 'photo' | 'video'
let pendingPhotos = []; // { full, thumb } : data URLs prêtes à envoyer
let pendingVideo = null; // { base64, mime, thumb, duration }

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (err) => { URL.revokeObjectURL(url); reject(err); };
    img.src = url;
  });
}

function resize(img, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

// Avec Storage, pas de limite de 1 Mo : photo plus nette (2048 px). Sinon, on reste sous 1 Mo.
function fullSize(img, forBase = false) {
  if (storage && !forBase) return resize(img, 2048, 0.88);
  let maxSide = 1600;
  let quality = 0.82;
  for (;;) {
    const dataUrl = resize(img, maxSide, quality);
    if (dataUrl.length <= MAX_IMAGE_CHARS || maxSide <= 600) return dataUrl;
    if (quality > 0.6) quality -= 0.1;
    else maxSide -= 200;
  }
}

async function compressPhoto(file) {
  const img = await loadImage(file);
  // small : aperçu léger quand la photo fait partie d'un envoi de plusieurs photos.
  return { full: fullSize(img), thumb: resize(img, 800, 0.72), small: resize(img, 480, 0.65) };
}

function openAdd(kind) {
  if (paused()) return;
  addMode = kind;
  pendingPhotos = [];
  pendingVideo = null;
  $('post-title').textContent = kind === 'photo' ? 'Envoyer une photo' : 'Envoyer une vidéo';
  $('pick-camera-label').textContent = kind === 'photo' ? 'Prendre une photo' : 'Filmer';
  $('pick-gallery-label').textContent = kind === 'photo' ? 'Choisir dans la galerie' : 'Choisir une vidéo';
  $('post-text').value = '';
  setStatus('');
  syncAddSheet();
  $('sheet-post').hidden = false;
  history.pushState({ page, sheet: true }, '');
}

// Avant le choix : les deux boutons ; après : l'aperçu, la légende et « Envoyer ».
function syncAddSheet() {
  const chosen = addMode === 'photo' ? pendingPhotos.length > 0 : !!pendingVideo;
  $('pickers').hidden = chosen;
  $('video-hint').hidden = addMode !== 'video' || chosen;
  $('post-extra').hidden = !chosen;
  $('previews').hidden = addMode !== 'photo';
  $('video-preview').hidden = addMode !== 'video' || !chosen;
  renderPreviews();
}

function closeSheets() {
  $('sheet-post').hidden = true;
  $('sheet-reminder').hidden = true;
  $('sheet-wifi').hidden = true;
  stopScan?.();
  stopScan = null;
  $('video-preview').removeAttribute('src');
  pendingPhotos = [];
  pendingVideo = null;
}

document.querySelectorAll('.fab[data-add]').forEach((fab) => {
  fab.addEventListener('click', () => openAdd(fab.dataset.add));
});
$('post-close').addEventListener('click', () => history.back());
$('sheet-post').addEventListener('click', (e) => { if (e.target === $('sheet-post')) history.back(); });

$('pick-camera').addEventListener('click', () => $(addMode === 'photo' ? 'in-photo-camera' : 'in-video-camera').click());
$('pick-gallery').addEventListener('click', () => $(addMode === 'photo' ? 'in-photo-gallery' : 'in-video-gallery').click());

function renderPreviews() {
  const box = $('previews');
  box.replaceChildren();
  pendingPhotos.forEach((photo, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'preview';
    const img = document.createElement('img');
    img.src = photo.thumb;
    img.alt = '';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.append(icon('close'));
    remove.setAttribute('aria-label', 'Retirer cette photo');
    remove.addEventListener('click', () => {
      pendingPhotos.splice(i, 1);
      syncAddSheet();
    });
    wrap.append(img, remove);
    box.append(wrap);
  });
}

function setBusy(label) {
  const btn = $('btn-send');
  for (const id of ['btn-send', 'post-text', 'pick-camera', 'pick-gallery']) $(id).disabled = !!label;
  $('form-post').classList.toggle('busy', !!label);
  btn.replaceChildren();
  if (label) {
    const spin = document.createElement('span');
    spin.className = 'spinner';
    btn.append(spin, label);
  } else {
    btn.textContent = 'Envoyer';
  }
}

function setStatus(text) {
  $('post-status').textContent = text;
  $('post-status').hidden = !text;
}

async function onPhotosChosen(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  await addPhotoFiles(files);
}

const MAX_PHOTOS = 5;

async function addPhotoFiles(all) {
  if (!all.length) return;
  const room = MAX_PHOTOS - pendingPhotos.length;
  const files = all.slice(0, Math.max(0, room));
  if (all.length > room) notice(`${MAX_PHOTOS} photos au plus par envoi : les ${files.length} premières sont gardées.`);
  setStatus('Préparation…');
  for (const file of files) {
    try {
      pendingPhotos.push(await compressPhoto(file));
    } catch (err) {
      console.error(err);
      notice(`La photo « ${file.name} » n'a pas pu être lue.`);
    }
  }
  setStatus('');
  syncAddSheet();
}

async function onVideoChosen(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  await addVideoFile(file);
}

async function addVideoFile(file) {
  if (!file) return;
  $('pickers').hidden = true;
  try {
    const result = await prepareVideo(file, (done, total) => {
      setStatus(`Préparation de la vidéo… ${Math.round(done)} / ${Math.round(total)} s`);
    }, MAX_VIDEO_SECONDS);
    pendingVideo = { blob: result.blob, mime: result.mime, thumb: result.thumb, duration: result.duration };
    $('video-preview').src = URL.createObjectURL(result.blob);
    setStatus('');
  } catch (err) {
    console.error(err);
    setStatus("Cette vidéo n'a pas pu être préparée.");
  }
  syncAddSheet();
}

$('in-photo-camera').addEventListener('change', onPhotosChosen);
$('in-photo-gallery').addEventListener('change', onPhotosChosen);
$('in-video-camera').addEventListener('change', onVideoChosen);
$('in-video-gallery').addEventListener('change', onVideoChosen);

// ---------- « Partager vers Papote » depuis la galerie du téléphone (Android) ----------
// Le service worker reçoit les fichiers partagés, les garde dans un cache et rouvre l'app avec ?partage=1.

async function openShared() {
  try {
    const cache = await caches.open('papote-partage');
    const meta = await cache.match('/partage/meta');
    if (!meta) return;
    const { count, text } = await meta.json();
    const files = [];
    for (let i = 0; i < count; i++) {
      const res = await cache.match(`/partage/${i}`);
      if (!res) continue;
      const blob = await res.blob();
      files.push(new File([blob], decodeURIComponent(res.headers.get('X-Name') || `partage-${i}`), { type: blob.type }));
    }
    await caches.delete('papote-partage');
    const video = files.find((f) => f.type.startsWith('video/'));
    const photos = files.filter((f) => f.type.startsWith('image/'));
    if (!video && !photos.length) return;
    openPage(video ? 'videos' : 'photos');
    openAdd(video ? 'video' : 'photo');
    if (text) $('post-text').value = text.slice(0, 30);
    if (video) await addVideoFile(video);
    else await addPhotoFiles(photos);
  } catch (err) {
    console.error('Partage illisible', err);
  }
}

$('form-post').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('post-text').value.trim();
  const author = { authorUid: session.uid, authorName: session.member.name };
  setStatus('');
  const kind = addMode;
  if (kind === 'video' ? !pendingVideo : !pendingPhotos.length) return;
  // Une photo à la fois : en cas de coupure, seules les photos restantes sont mises en attente.
  const items = kind === 'video'
    ? [{ kind, text, video: pendingVideo, author }]
    : [{ kind, text, photos: pendingPhotos.slice(0, MAX_PHOTOS), author }];
  let sent = 0;
  try {
    for (const item of items) {
      if (!navigator.onLine) throw new Error('hors ligne');
      setBusy(kind === 'video' ? 'Envoi de la vidéo…' : pendingPhotos.length > 1 ? `Envoi des ${pendingPhotos.length} photos…` : 'Envoi…');
      await sendItem(item);
      sent++;
    }
    setBusy('');
    history.back();
    toast('Envoyé');
    pruneOld(kind);
  } catch (err) {
    setBusy('');
    if (/trop lourde/.test(err.message)) {
      setStatus('Cette vidéo est trop longue pour le moment : gardez-la sous 30 secondes.');
      return;
    }
    console.warn('Envoi mis en attente', err);
    for (const item of items.slice(sent)) await queue(item);
    history.back();
  } finally {
    setBusy('');
  }
});

// ---------- Envois en attente de réseau ----------
// Sans réseau (ou si l'envoi échoue), l'envoi est gardé sur le téléphone et part tout seul
// dès que la connexion revient, même si l'app a été fermée entre-temps.

function sendItem(item) {
  if (item.kind === 'message') return addPost(session.fid, { type: 'message', text: item.text, ...item.author });
  if (item.kind === 'video') return sendVideo(item.video, item.text, item.author);
  return sendPhotos(item.photos || [item.photo], item.text, item.author);
}

function outboxDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('papote-envois', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('envois', { keyPath: 'id', autoIncrement: true });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function outbox(mode, fn) {
  const dbi = await outboxDb();
  return new Promise((resolve, reject) => {
    const tx = dbi.transaction('envois', mode);
    const req = fn(tx.objectStore('envois'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

async function queue(item) {
  try {
    await outbox('readwrite', (store) => store.add({ ...item, fid: session.fid }));
    toast("Pas de réseau : l'envoi partira tout seul");
  } catch (err) {
    console.error(err);
    notice("L'envoi a échoué. Vérifiez la connexion et réessayez.");
  }
  renderOutbox();
}

async function renderOutbox() {
  let count = 0;
  try { count = await outbox('readonly', (store) => store.count()); } catch (e) { /* stockage indisponible */ }
  $('outbox').hidden = !count;
  $('outbox').textContent = count > 1 ? `${count} envois en attente de réseau…` : '1 envoi en attente de réseau…';
}

let flushing = false;
async function flushOutbox() {
  if (flushing || !session || !navigator.onLine) return;
  flushing = true;
  try {
    const items = await outbox('readonly', (store) => store.getAll());
    for (const item of items) {
      if (item.fid !== session.fid) { await outbox('readwrite', (store) => store.delete(item.id)); continue; }
      await sendItem(item);
      await outbox('readwrite', (store) => store.delete(item.id));
      pruneOld(item.kind === 'message' ? null : item.kind);
    }
    if (items.length) toast(items.length > 1 ? 'Envois en attente partis' : 'Envoi en attente parti');
  } catch (err) {
    console.warn('Envois en attente : nouvel essai plus tard', err);
  } finally {
    flushing = false;
    renderOutbox();
  }
}

window.addEventListener('online', flushOutbox);
setInterval(flushOutbox, 60_000);

// ---------- Fichiers dans Firebase Storage ----------
// Photos et vidéos vont dans Storage (moins cher, vidéos jusqu'à 2 minutes) ; l'envoi garde un petit
// aperçu (thumb) et l'adresse du fichier. Si Storage n'est pas disponible, on repasse par la base.

const MAX_VIDEO_SECONDS = 60;
let storage = null;
function ouvrirStorage(bucket) {
  storage = getStorage(getApp(), bucket);
  // Sans réponse de Storage, on bascule vite sur la base plutôt que de réessayer 10 minutes.
  storage.maxUploadRetryTime = 10_000;
  storage.maxOperationRetryTime = 10_000;
}
try {
  ouvrirStorage(bucketUrl());
} catch (e) { /* Storage indisponible */ }

async function upload(blob, ext) {
  const path = `families/${session.fid}/media/${doc(collection(db, 'families')).id}.${ext}`;
  const fileRef = ref(storage, path);
  await uploadBytes(fileRef, blob, { contentType: blob.type });
  return { path, url: await getDownloadURL(fileRef) };
}

async function addStoragePost(data) {
  const batch = writeBatch(db);
  batch.set(doc(collection(db, 'families', session.fid, 'posts')), {
    ...data, image: null, createdAt: serverTimestamp(), seenAt: null, hearts: 0,
  });
  bumpRev(batch, session.fid);
  await batch.commit();
}

// Jusqu'à 5 photos dans un seul envoi : la première reste dans imageUrl/thumb (les anciennes
// tablettes l'affichent seule), la liste complète est dans photos[] { imageUrl, storagePath, thumb }.
async function sendPhotos(photos, text, author) {
  if (photos.length === 1 || !storage) {
    for (let i = 0; i < photos.length; i++) await sendPhoto(photos[i], i === 0 ? text : '', author);
    return;
  }
  const uploaded = [];
  try {
    for (const photo of photos) {
      const file = await upload(await (await fetch(photo.full)).blob(), 'jpg');
      uploaded.push({ imageUrl: file.url, storagePath: file.path, thumb: photo.small || photo.thumb });
    }
  } catch (err) {
    if (!navigator.onLine) throw err;
    console.warn('Storage indisponible, une photo par envoi', err);
    for (const f of uploaded) deleteObject(ref(storage, f.storagePath)).catch(() => {});
    storage = null;
    for (let i = 0; i < photos.length; i++) await sendPhoto(photos[i], i === 0 ? text : '', author);
    return;
  }
  await addStoragePost({
    type: 'photo', text, thumb: photos[0].thumb, imageUrl: uploaded[0].imageUrl,
    storagePath: uploaded[0].storagePath, photos: uploaded, ...author,
  });
}

async function sendPhoto(photo, text, author) {
  if (storage) {
    try {
      const file = await upload(await (await fetch(photo.full)).blob(), 'jpg');
      await addStoragePost({ type: 'photo', text, thumb: photo.thumb, imageUrl: file.url, storagePath: file.path, ...author });
      return;
    } catch (err) {
      console.warn('Storage indisponible, envoi par la base', err);
      if (!navigator.onLine) throw err;
      storage = null; // pour les envois suivants de cette session
    }
  }
  // Repli sur la base : la photo doit tenir sous 1 Mo.
  const full = photo.full.length <= MAX_IMAGE_CHARS ? photo.full
    : fullSize(await loadImage(await (await fetch(photo.full)).blob()), true);
  await addPost(session.fid, { type: 'photo', text, image: full, thumb: photo.thumb, ...author });
}

function toBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    reader.readAsDataURL(blob);
  });
}

async function sendVideo(video, text, author) {
  const ext = video.mime.includes('mp4') ? 'mp4' : 'webm';
  if (storage) {
    try {
      const file = await upload(new Blob([video.blob], { type: video.mime }), ext);
      await addStoragePost({
        type: 'video', text, thumb: video.thumb, videoUrl: file.url, storagePath: file.path,
        mime: video.mime, duration: video.duration, ...author,
      });
      return;
    } catch (err) {
      console.warn('Storage indisponible, envoi par la base', err);
      if (!navigator.onLine) throw err;
      storage = null; // pour les envois suivants de cette session
    }
  }
  const base64 = await toBase64(video.blob);
  if (base64.length > MAX_VIDEO_CHUNKS * VIDEO_CHUNK) throw new Error('Vidéo trop lourde pour la base');
  await addPost(session.fid, {
    type: 'video', text, video: base64, mime: video.mime, thumb: video.thumb, duration: video.duration, ...author,
  });
}

async function removePost(post) {
  const paths = new Set([post.storagePath, ...(post.photos || []).map((p) => p.storagePath)].filter(Boolean));
  if (storage) {
    for (const path of paths) {
      try { await deleteObject(ref(storage, path)); } catch (err) { console.warn('Fichier déjà absent', err); }
    }
  }
  await deletePost(session.fid, post);
}

// ---------- Support ----------

// Le chat d'aide « Une question ? » n'apparaît que sur la page Support (voir famille.css).

// ---------- Photo de profil ----------
// Petite photo carrée gardée dans la fiche du membre : la tablette l'affiche à côté des envois et des appels.

let faces = {}; // uid -> photo
let myFace = null;

function avatar(src) {
  const img = document.createElement('img');
  img.className = 'avatar';
  img.src = src;
  img.alt = '';
  return img;
}

function renderFace() {
  $('face-img').hidden = !myFace;
  $('face-empty').hidden = !!myFace;
  $('face-remove').hidden = !myFace;
  if (myFace) $('face-img').src = myFace;
  $('face-nudge').hidden = !!myFace;
}

async function saveFace(face) {
  await updateDoc(doc(db, 'families', session.fid, 'members', session.uid), { face });
}

async function onFaceChosen(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const img = await loadImage(file);
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 320;
    // Carré pris au centre, sans déformer le visage.
    canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 320, 320);
    myFace = canvas.toDataURL('image/jpeg', 0.8);
    renderFace();
    await saveFace(myFace);
    toast('Photo enregistrée');
  } catch (err) {
    console.error(err);
    notice("La photo n'a pas pu être enregistrée. Vérifiez la connexion.");
  }
}

// Photo de la personne qui a la tablette : écrite sur ses fiches (role 'tablette') par un responsable.
function renderTabletFace() {
  const face = tabletMembers.map((m) => m.face).find(Boolean) || null;
  $('tablet-face-card').hidden = !amFamilyAdmin() || !tabletMembers.length;
  $('tface-img').hidden = !face;
  if (face) $('tface-img').src = face;
  $('tface-empty').hidden = !!face;
  $('tface-remove').hidden = !face;
}

async function saveTabletFace(face) {
  const batch = writeBatch(db);
  tabletMembers.forEach((m) => batch.update(doc(db, 'families', session.fid, 'members', m.id), { face }));
  await batch.commit();
}

async function onTabletFaceChosen(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const img = await loadImage(file);
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 320;
    canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 320, 320);
    await saveTabletFace(canvas.toDataURL('image/jpeg', 0.8));
    toast('Photo enregistrée');
  } catch (err) {
    console.error(err);
    notice("La photo n'a pas pu être enregistrée. Vérifiez la connexion.");
  }
}

$('tface-camera').addEventListener('click', () => $('in-tface-camera').click());
$('tface-gallery').addEventListener('click', () => $('in-tface-gallery').click());
$('in-tface-camera').addEventListener('change', onTabletFaceChosen);
$('in-tface-gallery').addEventListener('change', onTabletFaceChosen);
$('tface-remove').addEventListener('click', async () => {
  if (!await askConfirm(`Retirer la photo de ${session.family.name} ?`, 'Retirer')) return;
  try { await saveTabletFace(null); } catch (err) { console.error(err); notice("La photo n'a pas pu être retirée."); }
});

$('face-camera').addEventListener('click', () => $('in-face-camera').click());
$('face-gallery').addEventListener('click', () => $('in-face-gallery').click());
$('in-face-camera').addEventListener('change', onFaceChosen);
$('in-face-gallery').addEventListener('change', onFaceChosen);
$('face-remove').addEventListener('click', async () => {
  if (!await askConfirm('Retirer votre photo ?')) return;
  myFace = null;
  renderFace();
  try { await saveFace(null); } catch (err) { console.error(err); }
});
$('face-nudge').addEventListener('click', () => document.querySelector('.nav-item[data-tab="profile"]').click());

// ---------- Nettoyage : rester dans le quota gratuit de Firebase ----------
// On garde les dernières photos et vidéos ; au-delà, les plus anciennes (plus de 7 jours) sont effacées.
// Environ 0,5 Mo par photo et 7 Mo au plus par vidéo : moins de 400 Mo sur le Go gratuit.

const KEEP = { photo: 200, video: 40 };
const WEEK = 7 * 86_400_000;

async function pruneOld(type) {
  if (!KEEP[type]) return;
  try {
    const posts = collection(db, 'families', session.fid, 'posts');
    const count = (await getCountFromServer(query(posts, where('type', '==', type)))).data().count;
    const excess = count - KEEP[type];
    if (excess <= 0) return;
    const oldest = await getDocs(query(posts, where('type', '==', type), orderBy('createdAt', 'asc'), limit(Math.min(excess, 20))));
    for (const d of oldest.docs) {
      const post = { id: d.id, ...d.data() };
      if (!post.createdAt || Date.now() - toDate(post.createdAt).getTime() < WEEK) break;
      await removePost(post);
    }
  } catch (err) {
    console.warn('Nettoyage des anciens envois impossible', err);
  }
}

// ---------- Réglages ----------

function inviteLink() {
  return `${APP_URL}/?code=${formatCode(session.family.code)}&pour=${encodeURIComponent(session.family.name)}`;
}

let qrLoading = null;
function loadQr() {
  qrLoading = qrLoading || new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/qrcode.js';
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
  return qrLoading;
}

async function renderSettings() {
  $('settings-code').textContent = formatCode(session.family.code);
  // QR code du lien d'invitation : l'appareil photo du téléphone ouvre l'app avec le code déjà rempli.
  try {
    await loadQr();
    const qr = window.qrcode(0, 'M');
    qr.addData(inviteLink());
    qr.make();
    $('invite-qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  } catch (err) {
    console.error(err);
  }
}

$('btn-share').addEventListener('click', async () => {
  const text = `Rejoins la famille sur Papote pour envoyer des photos à ${session.family.name} ! Code famille : ${formatCode(session.family.code)}`;
  const url = inviteLink();
  if (navigator.share) {
    try { await navigator.share({ title: 'Papote', text, url }); } catch (e) { /* annulé */ }
  } else {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    notice('Lien copié. Collez-le dans un SMS ou un e-mail.');
  }
});

$('btn-leave').addEventListener('click', async () => {
  if (!await askConfirm(`Quitter la famille de ${session.family.name} ? Il faudra une nouvelle invitation pour revenir.`)) return;
  const { fid, uid } = session;
  stopSession();
  await leaveFamily(fid, uid);
  await enterApp();
});

// ---------- Appel vidéo ----------

let currentCall = null;

const CALL_MESSAGES = {
  ringing: () => `Ça sonne chez ${session.family.name}…`,
  accepted: () => 'Connexion…',
  connected: () => '',
};
const END_MESSAGES = {
  ended: 'Appel terminé',
  declined: `L'appel a été refusé`,
  missed: 'Pas de réponse',
  failed: 'La connexion vidéo a échoué',
};

// ---------- Appel dans l'app Android : notification d'appel en cours, micro en arrière-plan ----------
// Dans l'écran d'appel natif (WebView, window.PapoteNatif), on tient l'app au courant. Dans la TWA
// (app Android, hors appel), on lui passe la main pour décrocher ou appeler.
const pont = () => window.PapoteNatif || null;
function natifEtat(etat, nom, video) {
  try { pont()?.etat(etat, nom || session?.family?.name || '', !!video); } catch (e) { /* rien */ }
}
function natifFin() {
  try { pont()?.fin(); } catch (e) { /* rien */ }
}
window.papoteRaccrocher = () => {
  const enCours = !!currentCall;
  hangupCall();
  if (!enCours) { leaveCallScreen(); }
};

let jetonNatif = null;
async function rafraichirJetonNatif() {
  if (!inNativeApp() || pont() || !session) return;
  try { jetonNatif = (await jetonAppelNatif()).connexion || null; } catch (e) { console.warn('Jeton d\'appel natif indisponible', e); }
}
setInterval(rafraichirJetonNatif, 50 * 60_000);

/** TWA : ouvre l'écran d'appel de l'app sur ce chemin. Renvoie false s'il faut rester dans la page. */
function passerAuNatif(chemin) {
  if (!inNativeApp() || pont() || !jetonNatif) return false;
  location.href = `intent://appel?u=${encodeURIComponent(chemin)}&connexion=${encodeURIComponent(jetonNatif)}`
    + '#Intent;scheme=papote;package=fr.mapapote.famille;end';
  return true;
}

function setCallStatus(text) {
  $('call-status').textContent = text;
  $('call-status').hidden = !text;
}

// Pendant l'appel : plein écran. L'écran n'est pas forcé à l'horizontale : un téléphone tenu
// debout filmerait alors de travers. L'image envoyée est mise à l'horizontale dans appel.js.
// Pendant l'appel : plein écran et toujours à l'horizontale, même sans rotation automatique.
// Android : l'écran est verrouillé à l'horizontale. Sinon (iPhone), l'écran d'appel est tourné
// d'un quart de tour tant que le téléphone est tenu debout. L'image envoyée reste à l'horizontale (appel.js).
function enterCallScreen() {
  $('call').classList.add('force-landscape');
  const el = document.documentElement;
  if (!el.requestFullscreen || document.fullscreenElement) return;
  el.requestFullscreen({ navigationUI: 'hide' })
    .then(() => screen.orientation?.lock?.('landscape'))
    .then(() => $('call').classList.remove('force-landscape'))
    .catch(() => {});
}

function leaveCallScreen() {
  $('call').hidden = true;
  $('call').classList.remove('audio');
  $('call-video').disabled = false;
  $('call-remote').srcObject = null;
  $('call-local').srcObject = null;
  $('call').classList.remove('force-landscape');
  try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) { /* rien */ }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  natifFin();
}

// Caméra et micro déjà autorisés ? Sinon, la demande d'autorisation passe avant le plein écran,
// qui la ferait disparaître en faisant tourner l'écran.
async function cameraAllowed() {
  try {
    const [cam, mic] = await Promise.all(['camera', 'microphone'].map((name) => navigator.permissions.query({ name })));
    return cam.state === 'granted' && mic.state === 'granted';
  } catch (e) {
    return false;
  }
}

function callErrorMessage(err) {
  if (err && err.name === 'BusyError') return `${session.family.name} est déjà en communication avec un proche. Réessayez un peu plus tard.`;
  if (err && err.name === 'NotAllowedError') return "La caméra ou le micro est refusé. Autorisez-les dans les réglages du navigateur, puis réessayez.";
  if (err && (err.name === 'NotReadableError' || err.name === 'AbortError')) return 'La caméra est déjà utilisée par une autre application.';
  if (err && err.name === 'NotFoundError') return "Aucune caméra ou aucun micro n'a été trouvé.";
  // Le détail aide à comprendre une panne signalée par la famille.
  const detail = err ? ` (${err.name || 'Erreur'} : ${String(err.message || err).slice(0, 80)})` : '';
  return `L'appel n'a pas pu démarrer. Réessayez dans un instant.${detail}`;
}

// Bouton d'appel : grisé si la tablette ne sait pas recevoir d'appel, ou si elle est déjà
// en communication avec un proche (« Déjà en appel »).
let tabletCanCall = false;
let tabletInCall = false;
function renderCallTile() {
  const tile = $('tile-call');
  const busy = tabletInCall && !currentCall && !callStarting;
  tile.disabled = !tabletCanCall || busy;
  tile.classList.toggle('busy', busy);
  tile.querySelector('span').textContent = busy ? 'Déjà en appel' : 'Appel vidéo';
}

// ---------- Mamie appelle (audio) ----------
// Photo de la tablette (ou initiale) et durée de l'appel, pour un écran comme un vrai téléphone.
function setCallFace(el, name) {
  const face = tabletMembers.map((m) => m.face).find(Boolean);
  el.replaceChildren();
  if (face) {
    const img = document.createElement('img');
    img.src = face;
    img.alt = '';
    el.appendChild(img);
  } else {
    el.textContent = (name || '?').trim().charAt(0).toUpperCase();
  }
}

let callTimer = null;
function startCallTimer() {
  stopCallTimer();
  const start = Date.now();
  const show = () => {
    const s = Math.floor((Date.now() - start) / 1000);
    $('call-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  show();
  callTimer = setInterval(show, 1000);
}
function stopCallTimer() {
  clearInterval(callTimer);
  callTimer = null;
  $('call-timer').textContent = '';
}
// Une sonnerie en plein écran tant que l'appel sonne pour moi ; « Répondre » ouvre un appel
// audio. Si un autre proche répond avant, la sonnerie s'arrête toute seule.
let incoming = null;   // appel qui sonne (données de la tablette)
let ringTone = null;   // { ctx, timer }

function startRingTone() {
  if (ringTone) return;
  let ctx = null;
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* pas de son */ }
  const beep = () => {
    try { navigator.vibrate?.([600, 300, 600]); } catch (e) { /* pas de vibreur */ }
    if (!ctx) return;
    [0, 0.45].forEach((at) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.25;
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.3);
    });
  };
  beep();
  ringTone = { ctx, timer: setInterval(beep, 2000) };
}

function stopRingTone() {
  if (!ringTone) return;
  clearInterval(ringTone.timer);
  try { navigator.vibrate?.(0); } catch (e) { /* rien */ }
  ringTone.ctx?.close().catch(() => {});
  ringTone = null;
}

function showIncoming(call) {
  if (currentCall || callStarting) call = null; // déjà en communication
  if (call && incoming && incoming.id === call.id) return;
  incoming = call;
  // « Répondre » déjà touché sur la notification ou l'app Android : on décroche directement.
  if (call && answerPending === call.id) {
    answerPending = null;
    answerFromTablet();
    return;
  }
  // Dans l'app Android, le téléphone sonne déjà par elle : pas de deuxième sonnerie, et l'écran
  // « X vous appelle » de l'app seulement si on est dessus (sinon on répond depuis Android).
  const natif = inNativeApp();
  $('incoming').hidden = !call || (natif && document.visibilityState !== 'visible');
  if (!call) { stopRingTone(); return; }
  const caller = call.callerName || session.family.name;
  $('incoming-name').textContent = caller;
  setCallFace($('incoming-face'), caller);
  warmUpCalls();
  if (!natif) startRingTone();
}

async function answerFromTablet() {
  const call = incoming;
  if (!call) return;
  showIncoming(null);
  closeCallNotification(call.id);
  callStarting = true;
  const caller = call.callerName || session.family.name;
  // Écran remis à neuf : un appel précédent passé en vidéo ne doit rien laisser derrière lui.
  $('call-video').disabled = false;
  $('call-remote').srcObject = null;
  $('call-local').srcObject = null;
  $('call').classList.add('audio');
  $('call-name').textContent = caller;
  setCallFace($('call-face'), caller);
  $('call').hidden = false;
  setCallStatus('Connexion…');
  natifEtat('connexion', caller, false);
  try {
    currentCall = await answerIncoming(session.fid, call.id, { uid: session.uid, name: session.member.name }, {
      audio: $('call-audio'),
      onState: () => { setCallStatus(''); startCallTimer(); natifEtat('en_cours', caller, !!$('call-local').srcObject); },
      // Mamie répond à notre caméra : on passe à l'écran vidéo.
      onVideo: (track) => {
        $('call-remote').srcObject = new MediaStream([track]);
        $('call-remote').play().catch(() => {});
        $('call').classList.remove('audio');
        setCallStatus('');
      },
      onEnd: (reason) => {
        currentCall = null;
        stopCallTimer();
        setCallStatus(reason === 'failed' ? 'La connexion a été perdue' : 'Appel terminé');
        renderCallTile();
        setTimeout(() => { if (!currentCall) leaveCallScreen(); }, 2000);
      },
    });
  } catch (err) {
    currentCall = null;
    if (!err || err.name !== 'TakenError') reportCallIncident('reponse-audio', `${err && err.name}: ${err && err.message}`, call.id);
    setCallStatus(err && err.name === 'TakenError'
      ? 'Un autre proche a déjà répondu.'
      : callErrorMessage(err));
    setTimeout(() => { if (!currentCall) leaveCallScreen(); }, 3000);
  } finally {
    callStarting = false;
    renderCallTile();
  }
}

$('incoming-answer').addEventListener('click', () => {
  // App Android : l'écran d'appel natif décroche (notification d'appel, micro en arrière-plan).
  if (incoming && passerAuNatif(`/?appel=${incoming.id}`)) { stopRingTone(); $('incoming').hidden = true; return; }
  answerFromTablet();
});

// Ouvert par « Répondre » (?appel=<id>) : l'écran d'appel s'affiche tout de suite, avant même
// l'accueil, et l'appel est pris dès qu'il arrive. S'il ne sonne plus, on le dit.
let answerPending = null;
function answerOnArrival(cid) {
  answerPending = cid;
  if (incoming && incoming.id === cid) {
    answerPending = null;
    answerFromTablet();
    return;
  }
  $('call-video').disabled = true;
  $('call').classList.add('audio');
  $('call-name').textContent = '';
  $('call-face').replaceChildren();
  $('call').hidden = false;
  setCallStatus('Connexion…');
  setTimeout(() => {
    if (answerPending !== cid) return;
    answerPending = null;
    if (currentCall || callStarting) return;
    setCallStatus("L'appel est terminé");
    setTimeout(() => { if (!currentCall && !callStarting) leaveCallScreen(); }, 2000);
  }, 15000);
}

// Appel audio de Mamie : « Passer en vidéo » allume la caméra, la tablette suit toute seule.
$('call-video').addEventListener('click', async () => {
  if (!currentCall || !currentCall.enableVideo) return;
  // Comme un appel vidéo lancé depuis l'app : écran à l'horizontale (plein écran et verrouillage,
  // sinon l'écran d'appel tourné en CSS), même si la rotation automatique est bloquée.
  enterCallScreen();
  $('call-video').disabled = true;
  try {
    $('call-local').srcObject = await currentCall.enableVideo();
    $('call').classList.remove('audio');
    natifEtat('en_cours', $('call-name').textContent, true);
    if (!$('call-remote').srcObject) setCallStatus(`${session.family.name} va vous voir…`);
  } catch (err) {
    console.error(err);
    reportCallIncident('camera-audio', `${err && err.name}: ${err && err.message}`);
    $('call-video').disabled = false;
    notice("La caméra n'a pas pu s'allumer. Vérifiez qu'elle est autorisée pour Papote.");
  }
});

// Notifications : sans elles, la tablette ne peut faire sonner le téléphone que si l'app est ouverte.
async function renderPushNudge() {
  const card = $('push-nudge');
  card.hidden = !session || pushAllowed() || pushRefused() || !await pushSupported();
}
$('push-nudge').addEventListener('click', async () => {
  // La carte disparaît dès l'autorisation donnée ; le jeton s'enregistre ensuite en arrière-plan.
  const ok = await enablePush(session.fid, session.uid, () => {
    $('push-nudge').hidden = true;
    toast(`Notifications activées : ${session.family.name} pourra vous appeler`);
  });
  renderPushNudge();
  if (!ok && pushRefused()) {
    notice(`Les notifications sont bloquées pour Papote. Autorisez-les dans les réglages du téléphone pour que ${session.family.name} puisse vous appeler.`);
  }
});
// App Android : tant qu'Android peut la mettre en pause (?pause=1), elle risque de ne plus sonner
// si on ne l'ouvre pas pendant quelques mois. La carte ouvre le bon réglage par l'app elle-même.
function renderPauseNudge() {
  let pausable = false;
  try { pausable = sessionStorage.getItem('papote.pause') === '1'; } catch (e) { /* rien */ }
  $('pause-nudge').hidden = !session || !pausable;
}
$('pause-nudge').addEventListener('click', () => {
  try { sessionStorage.removeItem('papote.pause'); } catch (e) { /* rien */ }
  renderPauseNudge();
  location.href = 'intent://sans-pause#Intent;scheme=papote;package=fr.mapapote.famille;end';
});
// « Plus tard » : la sonnerie s'arrête ici, les autres proches peuvent encore répondre.
// « Refuser » : l'appel s'arrête tout de suite, la tablette affiche que vous n'avez pas pu répondre.
$('incoming-decline').addEventListener('click', () => {
  const call = incoming;
  showIncoming(null);
  if (call) {
    closeCallNotification(call.id);
    declineIncoming(session.fid, call.id);
  }
});

let callAbort = null; // annule un appel encore en train de démarrer
let callStarting = false; // un seul démarrage à la fois, même annulé

$('tile-call').addEventListener('click', async () => {
  if (currentCall || callStarting) return;
  if (paused()) return;
  if (passerAuNatif('/?appeler=video')) return;
  callStarting = true;
  const abort = new AbortController();
  callAbort = abort;
  const allowed = await cameraAllowed();
  if (abort.signal.aborted) { callStarting = false; return; }
  if (allowed) enterCallScreen();
  $('call').hidden = false;
  setCallStatus('Préparation de la caméra…');
  try {
    currentCall = await startCall(session.fid, { uid: session.uid, name: session.member.name }, {
      signal: abort.signal,
      local: $('call-local'),
      remote: $('call-remote'),
      onState: (state) => {
        if (!allowed && state === 'ringing') enterCallScreen();
        setCallStatus(CALL_MESSAGES[state]());
        natifEtat(state === 'ringing' ? 'sonne' : state === 'connected' ? 'en_cours' : 'connexion', session.family.name, true);
      },
      onEnd: (reason) => {
        currentCall = null;
        callAbort = null;
        setCallStatus(END_MESSAGES[reason] || 'Appel terminé');
        setTimeout(() => {
          if (currentCall) return;
          leaveCallScreen();
          if (reason === 'missed' || reason === 'declined') offerVideoMessage();
        }, 2000);
      },
    });
  } catch (err) {
    currentCall = null;
    callAbort = null;
    if (err && err.name === 'AbortError') {
      leaveCallScreen();
      return;
    }
    console.error(err);
    if (!err || err.name !== 'BusyError') reportCallIncident('depart-video', `${err && err.name}: ${err && err.message}`);
    setCallStatus(callErrorMessage(err));
    setTimeout(() => { if (!currentCall) leaveCallScreen(); }, 4000);
  } finally {
    callStarting = false;
  }
});

// « Rappeler » depuis la notification d'appel manqué : une confirmation (qui sert aussi de geste
// pour la caméra et le plein écran), puis l'appel vidéo part comme avec la tuile.
async function offerCallBack() {
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* rien */ }
  if (!session || currentCall || callStarting || $('tile-call').disabled) return;
  if (!await askConfirm(`Rappeler ${session.family.name} en vidéo ?`, 'Appeler')) return;
  $('tile-call').click();
}
// App déjà ouverte : le service worker la prévient au lieu de la rouvrir.
navigator.serviceWorker?.addEventListener('message', (e) => {
  const url = e.data && e.data.type === 'appel-ouvert' ? String(e.data.url || '') : '';
  if (url.includes('rappeler=1') && session) offerCallBack();
  const cid = url && new URL(url, location.origin).searchParams.get('appel');
  if (cid && session) answerOnArrival(cid);
});

// Mamie n'a pas répondu : proposer de lui laisser un petit message vidéo à la place.
async function offerVideoMessage() {
  const name = session.family.name;
  if (!await askConfirm(`${name} n'a pas répondu. Lui laisser un message vidéo ?`, 'Filmer')) return;
  openPage('videos');
  openAdd('video');
  $('in-video-camera').click();
}

// Raccrocher, même pendant le démarrage : l'appel est annulé, la caméra s'éteint.
function hangupCall() {
  const abort = callAbort;
  callAbort = null;
  if (abort) abort.abort();
  if (currentCall) currentCall.hangup();
}

// L'app fermée : on raccroche. Passer en arrière-plan ne coupe pas l'appel.
window.addEventListener('pagehide', hangupCall);

$('call-hangup').addEventListener('click', () => {
  const wasConnected = !!currentCall;
  hangupCall();
  if (!wasConnected) leaveCallScreen();
});

let allMembers = [];

// 30 proches au plus par famille (la tablette ne compte pas) : vérifié aussi par les règles.
const MAX_PROCHES = 30;
let familyFull = false;

function renderMembers(all) {
  allMembers = all;
  // Les demandes en attente sont à part : seuls les responsables les voient et les acceptent.
  const pending = all.filter((m) => m.status === 'pending');
  const members = all.filter((m) => m.status !== 'pending');
  familyFull = members.filter((m) => m.role === 'famille').length >= MAX_PROCHES;
  $('family-full').hidden = !familyFull || !pending.length;
  $('invite-full').hidden = !familyFull;
  $('invite-email-card').classList.toggle('disabled-card', familyFull);
  renderRequests(pending);
  tabletMembers = members.filter((m) => m.role === 'tablette');
  renderTabletFace();
  renderMeteo();
  renderWifi();
  faces = Object.fromEntries(members.filter((m) => m.face).map((m) => [m.id, m.face]));
  myFace = faces[session.uid] || null;
  renderFace();
  setNotifMembers(members);
  renderActivity();
  renderRemote();
  // Le bouton d'appel n'apparaît que si une tablette sait recevoir les appels (Android 5 et plus).
  const canCall = members.some((m) => m.role === 'tablette' && m.canCall);
  tabletCanCall = canCall && !!navigator.mediaDevices;
  renderCallTile();
  const list = $('members');
  list.replaceChildren();
  let tabletShown = false;
  for (const m of members) {
    if (m.role === 'tablette') {
      if (tabletShown) continue;
      tabletShown = true;
    }
    const li = document.createElement('li');
    if (m.face) li.append(avatar(m.face));
    else {
      const empty = document.createElement('span');
      empty.className = 'avatar avatar-empty';
      empty.innerHTML = `<svg><use href="#i-${m.role === 'tablette' ? 'home' : 'user'}"/></svg>`;
      li.append(empty);
    }
    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = m.role === 'tablette' ? `Tablette de ${session.family.name}` : m.name;
    li.append(name);
    if (m.role === 'famille') {
      const f = session.family;
      const isCreator = f.createdBy === m.id;
      const isAdmin = isCreator || (f.admins || []).includes(m.id);
      if (isAdmin) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'Responsable';
        name.append(badge);
      }
      // Les responsables gèrent les autres membres (le créateur reste toujours responsable).
      if (amFamilyAdmin() && m.id !== session.uid) {
        // Un bouton « ⋮ » ouvre les actions possibles, chacune confirmée avant d'agir.
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'icon-btn member-more';
        more.setAttribute('aria-label', `Actions pour ${m.name}`);
        more.textContent = '⋮';
        more.addEventListener('click', async () => {
          const options = [];
          if (!isCreator) options.push({ label: isAdmin ? 'Retirer le rôle de responsable' : 'Rendre responsable', value: 'admin' });
          options.push({ label: 'Retirer de la famille', value: 'remove', danger: true });
          const choix = await chooseAction(m.name, options);
          if (choix === 'admin') {
            const msg = isAdmin
              ? `Retirer le rôle de responsable à ${m.name} ? Cette personne ne pourra plus accepter de membres ni changer les réglages.`
              : `Rendre ${m.name} responsable ? Cette personne pourra accepter des membres et changer les réglages de la tablette.`;
            if (await askConfirm(msg, isAdmin ? 'Retirer le rôle' : 'Rendre responsable')) setFamilyAdmin(m.id, !isAdmin);
          } else if (choix === 'remove') {
            removeMember(m);
          }
        });
        li.append(more);
      }
    }
    list.append(li);
  }
}

async function setFamilyAdmin(uid, on) {
  const admins = new Set(session.family.admins || []);
  if (on) admins.add(uid); else admins.delete(uid);
  try {
    await updateDoc(doc(db, 'families', session.fid), { admins: [...admins] });
  } catch (err) {
    console.error(err);
    notice("Le changement n'a pas pu être enregistré.");
  }
}

async function removeMember(m) {
  if (!await askConfirm(`Retirer ${m.name} de la famille ? Son téléphone ne recevra plus rien. Pour revenir, il faudra l'inviter de nouveau.`)) return;
  try {
    await deleteDoc(doc(db, 'families', session.fid, 'members', m.id));
    if ((session.family.admins || []).includes(m.id)) await setFamilyAdmin(m.id, false);
  } catch (err) {
    console.error(err);
    notice("Ce membre n'a pas pu être retiré.");
  }
}

// ---------- Famille : nom de la personne, responsables ----------

// ---------- Responsables : demandes, invitations par e-mail, tablette, code ----------

// Le code famille ne se change qu'une fois toutes les tablettes à jour (elles retenaient l'ancien code).
const CHANGE_CODE_READY = false;
let stopInvitations = null;

function renderRequests(pending) {
  const admin = amFamilyAdmin();
  $('requests-card').hidden = !admin || !pending.length;
  $('pending-banner').hidden = !admin || !pending.length;
  if (!admin) return;
  // Accueil : une carte par demande, bien en vue, avec Refuser / Accepter. Même chose dans Réglages.
  $('pending-banner').replaceChildren(...pending.map(requestCard));
  $('requests').replaceChildren(...pending.map(requestCard));
}

function requestCard(m) {
  const card = document.createElement('article');
  card.className = 'join-card';
  const head = document.createElement('div');
  head.className = 'join-head';
  const av = document.createElement('span');
  av.className = 'avatar join-avatar';
  if (m.face) {
    const img = document.createElement('img');
    img.src = m.face;
    img.alt = '';
    av.append(img);
  } else {
    av.textContent = (m.name || '?').trim().charAt(0).toUpperCase();
  }
  const txt = document.createElement('div');
  txt.className = 'join-text';
  const who = document.createElement('strong');
  who.textContent = m.name;
  const what = document.createElement('span');
  what.textContent = 'veut rejoindre la famille';
  txt.append(who, what);
  if (m.email) {
    const mail = document.createElement('span');
    mail.className = 'join-mail';
    mail.textContent = m.email;
    txt.append(mail);
  }
  head.append(av, txt);
  const actions = document.createElement('div');
  actions.className = 'join-actions';
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'secondary join-no';
  no.textContent = 'Refuser';
  no.addEventListener('click', async () => {
    if (!await askConfirm(`Refuser la demande de ${m.name} ?`, 'Refuser')) return;
    try { await deleteDoc(doc(db, 'families', session.fid, 'members', m.id)); toast('Demande refusée'); } catch (err) { console.error(err); notice("Le refus n'a pas pu être enregistré."); }
  });
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'primary join-ok';
  ok.textContent = 'Accepter';
  ok.disabled = familyFull;
  ok.addEventListener('click', async () => {
    if (familyFull) { notice('La famille est complète : 30 proches au maximum.'); return; }
    ok.disabled = true;
    try { await acceptMember(session.fid, m.id); toast(`${m.name} a rejoint la famille`); } catch (err) { console.error(err); notice("L'acceptation a échoué."); ok.disabled = false; }
  });
  actions.append(no, ok);
  card.append(head, actions);
  return card;
}

function watchInvitations() {
  stopInvitations?.();
  stopInvitations = null;
  if (!amFamilyAdmin()) return;
  stopInvitations = onSnapshot(collection(db, 'families', session.fid, 'invitations'), (snap) => {
    // Une personne invitée qui est déjà dans la famille (arrivée par le code, par exemple) :
    // son invitation n'a plus lieu d'être, on l'efface.
    const deja = new Set(allMembers.map((m) => (m.email || '').toLowerCase()).filter(Boolean));
    const restantes = snap.docs.filter((d) => {
      const email = (d.data().email || '').toLowerCase();
      if (!deja.has(email)) return true;
      cancelInvitation(session.fid, email).catch((err) => console.warn('Invitation non effacée', err));
      return false;
    });
    $('invitations-sent').replaceChildren(...restantes.map((d) => {
      const inv = d.data();
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'member-name';
      name.textContent = `${inv.email} · invitation envoyée`;
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'link danger small';
      cancel.textContent = 'Annuler';
      cancel.addEventListener('click', () => cancelInvitation(session.fid, inv.email).catch(console.error));
      li.append(name, cancel);
      return li;
    }));
  }, (err) => console.warn('Invitations illisibles', err));
}

$('form-invite').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('invite-email').value.trim();
  if (familyFull) { notice('La famille est complète : 30 proches au maximum.'); return; }
  try {
    await inviteByEmail(session.fid, session.family, email, session.member.name);
  } catch (err) {
    console.error(err);
    notice("L'invitation n'a pas pu être enregistrée.");
    return;
  }
  // Un vrai e-mail part de Papote ; si l'envoi n'est pas possible, on partage le lien soi-même.
  try {
    await inviterParEmail(session.fid, email);
    $('invite-email').value = '';
    toast(`Invitation envoyée à ${email}`);
  } catch (err) {
    console.warn('E-mail d\'invitation non envoyé', err);
    const code = err.code || '';
    if (code.endsWith('invalid-argument')) { notice("Cette adresse e-mail ne semble pas correcte."); return; }
    if (code.endsWith('resource-exhausted')) { notice("Trop d'invitations aujourd'hui. Réessayez demain."); return; }
    $('invite-email').value = '';
    toast(`Invitation prête : ${email} peut se connecter à Papote`);
    if (navigator.share) {
      navigator.share({
        title: 'Papote',
        text: `Je t'invite sur Papote pour envoyer des photos à ${session.family.name}. Connecte-toi avec ${email} :`,
        url: inviteLink(),
      }).catch(() => {});
    }
  }
});


$('btn-new-code').addEventListener('click', async () => {
  if (!await askConfirm("Changer le code famille ? L'ancien code et l'ancien QR code ne permettront plus de rejoindre la famille.")) return;
  try {
    await changeFamilyCode(session.fid, session.family.code);
    toast('Nouveau code famille');
  } catch (err) {
    console.error(err);
    notice("Le code n'a pas pu être changé.");
  }
});

// ---------- Apparence : clair, sombre ou automatique (propre à ce téléphone) ----------

const THEME_KEY = 'papote.theme';

function currentTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { return 'auto'; }
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  document.querySelectorAll('[data-theme-choice]').forEach((b) => b.classList.toggle('active', b.dataset.themeChoice === theme));
}

document.querySelectorAll('[data-theme-choice]').forEach((btn) => btn.addEventListener('click', () => {
  try { localStorage.setItem(THEME_KEY, btn.dataset.themeChoice); } catch (e) { /* rien */ }
  applyTheme(btn.dataset.themeChoice);
}));
applyTheme(currentTheme());

// ---------- Abonnement ----------

const ABO_OK_KEY = 'papote.retourPaiement';
const dateLongue = (ts) => (ts ? toDate(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

// Abonnement en pause : envois, agenda et appels bloqués, avec une explication.
function paused() {
  if (abonnementOk(session?.family)) return false;
  notice(amOwner()
    ? "Papote est en pause : l'abonnement de la famille doit être réglé. Allez dans Réglages > Abonnement."
    : "Papote est en pause : l'abonnement de la famille doit être réglé par un responsable de la famille.");
  return true;
}

async function withAboError(fn) {
  $('abo-error').hidden = true;
  try {
    await fn();
  } catch (err) {
    console.error(err);
    $('abo-error').textContent = err.code === 'functions/not-found'
      ? `Aucun paiement trouvé pour ${myEmail()}. Utilisez la même adresse que sur le site.`
      : "L'opération n'a pas pu aboutir. Réessayez dans un instant.";
    $('abo-error').hidden = false;
  }
}

$('btn-portail').addEventListener('click', () => withAboError(() => ouvrirPortail(session.fid)));
// Commande payée sur le site : le propriétaire la relie avec son code, ou avec l'e-mail du compte.
document.querySelectorAll('[data-order-form]').forEach((form) => form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = form.querySelector('.order-code');
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    await rattacherCommande(session.fid, input.value);
    input.value = '';
    toast('Commande reliée : la tablette va démarrer');
  } catch (err) {
    console.error(err);
    const code = err.code || '';
    notice(code.endsWith('not-found')
      ? (input.value.trim()
        ? 'Ce code de commande est inconnu. Vérifiez-le sur la page de confirmation ou la facture.'
        : `Aucune commande trouvée pour ${myEmail()}. Entrez le code de commande, il est sur la page de confirmation et sur la facture.`)
      : code.endsWith('invalid-argument') ? 'Ce code de commande n\'a pas le bon format (8 lettres, comme ABCD-EFGH).'
        : code.endsWith('failed-precondition') ? 'Cette famille a déjà un abonnement.'
          : code.endsWith('permission-denied') ? 'Seul le propriétaire de la famille peut relier une commande.'
            : 'La vérification a échoué. Réessayez dans un instant.');
  } finally {
    btn.disabled = false;
  }
}));

$('abo-banner-btn').addEventListener('click', () => {
  if (session.family.abonnement?.statut === 'impaye') withAboError(() => ouvrirPortail(session.fid));
  else openPage('settings');
});
// Date d'arrêt annoncée avant de résilier : fin d'engagement, sinon fin de la période payée.
function dateArret(abo) {
  const fin = [abo.engagementJusqua, abo.finPeriode].map((t) => (t ? toDate(t) : null)).filter(Boolean)
    .sort((a, b) => b - a)[0];
  return fin ? fin.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
}

$('btn-resilier').addEventListener('click', async () => {
  const quand = dateArret(session.family.abonnement);
  const nom = session.family.name;
  // Une seule étape avant la résiliation (la loi veut une résiliation en ligne simple).
  const suite = [quand
    ? `Votre abonnement s'arrêtera le ${quand} (fin de l'engagement ou du mois payé).`
    : "Votre abonnement s'arrêtera à la fin de la période payée."];
  if (session.family.abonnement?.tablette !== 'achetee') suite.push('La tablette sera à nous renvoyer, l\'étiquette est offerte.');
  const partir = await avantDePartir({
    intro: `En résiliant, ${nom} perdra :`,
    perdu: [
      'les photos et les vidéos de la famille sur sa tablette',
      `les appels vidéo avec ${nom}`,
      'les messages et les rappels de l\'agenda',
    ],
    suite,
  });
  if (!partir) { toast('Merci de rester avec Papote'); return; }
  withAboError(async () => {
    const { le } = await resilier(session.fid);
    notice(`Résiliation enregistrée. Papote fonctionnera jusqu'au ${dateLongue(le) || quand || 'terme de la période payée'}.`);
  });
});

$('btn-garder').addEventListener('click', () => withAboError(async () => {
  await annulerResiliation(session.fid);
  toast('Abonnement gardé');
}));


$('abo-formules').replaceChildren(...FORMULES.map((f) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'abo-formule';
  b.innerHTML = '<strong></strong><span></span>';
  b.querySelector('strong').textContent = f.titre;
  b.querySelector('span').textContent = f.prix;
  b.addEventListener('click', () => withAboError(() => payer(session.fid, f.formule, f.tablette)));
  return b;
}));

// Code de commande arrivé par le lien du site : prérempli, et relié tout seul si la famille l'attend.
let autoLinkTried = false;
async function useOrderCodeFromSite(statut, owner) {
  let code = null;
  try { code = localStorage.getItem('papote.codeCommande'); } catch (e) { /* rien */ }
  if (!code) return;
  document.querySelectorAll('.order-code').forEach((input) => { if (!input.value) input.value = code; });
  if (!owner || statut !== 'aucun' || autoLinkTried) return;
  autoLinkTried = true;
  try {
    await rattacherCommande(session.fid, code);
    try { localStorage.removeItem('papote.codeCommande'); } catch (e) { /* rien */ }
    toast('Commande reliée : la tablette va démarrer');
  } catch (err) {
    console.warn('Commande du site non reliée', err);
  }
}

// ---------- Fin de contrat : annulation de commande et tablette à rendre ----------

let finCle = null;
let finInfo = null;
const euros = (centimes) => `${(centimes / 100).toLocaleString('fr-FR', { minimumFractionDigits: centimes % 100 ? 2 : 0 })} €`;
const jourMois = (ms) => new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

// Demandé au serveur une fois par état d'abonnement (pas à chaque mise à jour de la famille).
async function renderFinDeContrat(abo) {
  const cle = `${session.fid}|${JSON.stringify(abo || null)}`;
  if (!abo || !amFamilyAdmin()) {
    finCle = cle;
    finInfo = null;
  } else if (cle !== finCle) {
    finCle = cle;
    try { finInfo = await finDeContrat(session.fid); } catch (err) { console.warn('Fin de contrat illisible', err); finInfo = null; }
    if (cle !== finCle) return;
  }
  const r = finInfo?.retractation;
  $('btn-retracter').hidden = !r;
  $('retract-info').hidden = !r?.jusqua;
  if (r?.jusqua) $('retract-info').textContent = `Annulation possible jusqu'au ${jourMois(r.jusqua)}.`;
  const rest = finInfo?.restitution;
  const remb = finInfo?.remboursement;
  const box = $('retour-box');
  box.hidden = true;
  $('retour-etiquette').hidden = true;
  $('retour-info').hidden = true;
  if (rest && ['attendue', 'echec'].includes(rest.statut)) {
    box.hidden = false;
    $('retour-text').textContent = rest.avant ? `Tablette à nous rendre avant le ${jourMois(rest.avant)}` : 'Tablette à nous rendre';
    if (rest.etiquette) {
      $('retour-etiquette').href = rest.etiquette;
      $('retour-etiquette').hidden = false;
    }
    const infos = [];
    if (!rest.etiquette) infos.push("L'étiquette de retour prépayée arrive par e-mail.");
    if (remb?.statut === 'au-retour') infos.push(`${euros(remb.montant)} remboursés dès réception de la tablette.`);
    $('retour-info').textContent = infos.join(' ');
    $('retour-info').hidden = !infos.length;
  } else if (rest?.statut === 'rendue') {
    box.hidden = false;
    $('retour-text').textContent = 'Tablette bien reçue, merci';
    if (remb && ['en-cours', 'fait'].includes(remb.statut)) {
      $('retour-info').textContent = `${euros(remb.montant)} remboursés.`;
      $('retour-info').hidden = false;
    }
  }
}

$('btn-retracter').addEventListener('click', async () => {
  const r = finInfo?.retractation;
  if (!r) return;
  const quand = r.jusqua === null || r.jusqua === undefined ? 'tout de suite' : 'dès que la tablette nous revient';
  const montant = r.montant ? ` Vous serez remboursé de ${euros(r.montant)} ${quand}.` : '';
  if (!await askConfirm(`Annuler votre commande ? Votre abonnement s'arrête tout de suite.${montant}`, 'Annuler ma commande')) return;
  withAboError(async () => {
    const res = await retracter(session.fid);
    finCle = null;
    notice(res?.remboursement === 'fait'
      ? `Commande annulée. ${res.montant ? `${euros(res.montant)} vous sont remboursés.` : ''}`
      : "Commande annulée. Vous recevez par e-mail les instructions pour nous renvoyer la tablette ; le remboursement suit sa réception.");
  });
});

function renderAbonnement() {
  const abo = session.family.abonnement;
  renderFinDeContrat(abo);
  useOrderCodeFromSite(abo?.statut, amOwner());
  const admin = amOwner(); // l'abonnement est l'affaire du propriétaire, celui qui paie
  const statut = abo?.statut;
  // Bloc Abonnement du Profil (avant « Mon compte ») : tout le monde voit l'état,
  // seul le propriétaire peut payer, changer de carte ou résilier.
  $('abo-card').hidden = false;
  $('abo-readonly').hidden = admin || !abo;
  if (!abo) {
    $('abo-status').textContent = 'Formule d\u2019origine, sans abonnement payant';
    $('abo-status').className = 'abo-status s-offert';
    $('abo-details').textContent = 'Rien à régler pour cette famille.';
    for (const id of ['btn-portail', 'btn-resilier', 'btn-garder']) $(id).hidden = true;
    $('abo-choices').hidden = true;
  }
  if (abo) {
    $('abo-status').textContent = LIBELLES[statut] || statut;
    $('abo-status').className = `abo-status s-${statut}`;
    const details = [];
    if (abo.formule) details.push(`${abo.formule === 'sim' ? 'Internet inclus, 30 € par mois' : 'Avec le Wi-Fi de la maison, 20 € par mois'}, ${abo.tablette === 'achetee' ? 'tablette achetée' : 'tablette prêtée'}`);
    const futur = (t) => t && toDate(t) > new Date();
    if (futur(abo.essaiJusqua)) details.push(`Essai gratuit jusqu'au ${dateLongue(abo.essaiJusqua)}`);
    if (futur(abo.engagementJusqua)) details.push(`Engagement jusqu'au ${dateLongue(abo.engagementJusqua)}`);
    if (abo.resiliationLe) details.push(`Résiliation prévue le ${dateLongue(abo.resiliationLe)}`);
    else if (abo.finPeriode && statut === 'actif' && !futur(abo.essaiJusqua)) details.push(`Prochaine échéance le ${dateLongue(abo.finPeriode)}`);
    $('abo-details').textContent = details.join(' · ');
    const enCours = ['actif', 'impaye'].includes(statut);
    $('btn-portail').hidden = !admin || !abo.stripeCustomerId || statut === 'offert';
    $('btn-resilier').hidden = !admin || !enCours || !!abo.resiliationLe || !abo.stripeSubscriptionId;
    $('btn-garder').hidden = !admin || !enCours || !abo.resiliationLe;
    $('abo-choices').hidden = !admin || !['aucun', 'resilie', 'suspendu'].includes(statut);
  }
  // Bandeaux : retard de paiement (responsables), pause (tout le monde).
  let text = '';
  if (statut === 'impaye' && admin) {
    text = `Le dernier paiement a échoué. La tablette se mettra en pause le ${dateLongue(abo.graceJusqua)}.`;
  } else if (!abonnementOk(session.family)) {
    text = admin
      ? "Papote est en pause : l'abonnement de la famille doit être réglé. Tout reviendra automatiquement."
      : "Papote est en pause : l'abonnement de la famille doit être réglé par un responsable.";
  }
  // Sans abonnement en cours : le propriétaire peut relier une commande déjà payée sur le site.
  const sansAbo = ['aucun', 'resilie', 'suspendu'].includes(statut) && admin;
  if (statut === 'aucun' && admin) text = 'La tablette attend son abonnement.';
  $('abo-banner').hidden = !text;
  $('abo-banner-text').textContent = text;
  $('abo-banner-btn').hidden = !admin || statut === 'aucun';
  $('abo-banner-paid').hidden = !sansAbo;
  // Retour de la page de paiement : on confirme dès que le serveur a activé l'abonnement.
  let waiting = false;
  try { waiting = localStorage.getItem(ABO_OK_KEY) === '1'; } catch (e) { /* rien */ }
  if (waiting && statut === 'actif') {
    try { localStorage.removeItem(ABO_OK_KEY); } catch (e) { /* rien */ }
    notice('Abonnement activé. Merci !');
  }
}

// ---------- Tablette à distance (responsables) ----------
// families/{fid}/commands/{cid} : la tablette exécute la commande à sa prochaine synchro
// (le changement de rev l'appelle tout de suite), puis écrit state, result et doneAt.

let stopCommand = null;

// La tablette visée : sa fiche la plus récemment en ligne (elle en a deux, synchro et appels).
function targetTablet() {
  return tabletMembers.filter((m) => m.lastOnline)
    .sort((a, b) => toDate(b.lastOnline) - toDate(a.lastOnline))[0] || tabletMembers[0] || null;
}

function showRemote(text, cls = '') {
  $('remote-result').textContent = text;
  $('remote-result').className = `remote-result ${cls}`;
  $('remote-result-box').hidden = !text;
}

async function sendCommand(type, extra = {}) {
  const tablet = targetTablet();
  if (!tablet) { showRemote("Aucune tablette n'est reliée à cette famille.", 'warn'); return; }
  const ref2 = doc(collection(db, 'families', session.fid, 'commands'));
  const batch = writeBatch(db);
  batch.set(ref2, {
    type, target: tablet.id, createdBy: session.uid, createdAt: serverTimestamp(), state: 'pending', ...extra,
  });
  bumpRev(batch, session.fid);
  try {
    await batch.commit();
  } catch (err) {
    console.error(err);
    showRemote("La commande n'a pas pu être envoyée.", 'warn');
    return;
  }
  showRemote('Envoyé, en attente de la tablette…');
  stopCommand?.();
  let timer = setTimeout(() => showRemote("La tablette n'a pas encore répondu. Elle exécutera la commande dès qu'elle sera connectée.", 'warn'), 90_000);
  stopCommand = onSnapshot(ref2, (snap) => {
    const cmd = snap.data();
    if (!cmd || cmd.state === 'pending') return;
    clearTimeout(timer);
    stopCommand?.();
    stopCommand = null;
    showRemote(cmd.result || (cmd.state === 'done' ? 'C\'est fait.' : 'La tablette n\'a pas pu le faire.'), cmd.state === 'done' ? 'ok' : 'warn');
    // Résultat affiché : la commande n'a plus besoin d'être gardée.
    deleteDoc(ref2).catch(() => {});
  }, (err) => console.warn('Commande illisible', err));
}

document.querySelectorAll('[data-cmd]').forEach((btn) => btn.addEventListener('click', async () => {
  if (btn.dataset.cmd === 'restart' && !await askConfirm('Redémarrer la tablette ? Elle sera indisponible une minute.', 'Redémarrer')) return;
  sendCommand(btn.dataset.cmd);
}));

// Journal de la tablette : ses dernières lignes d'erreur, envoyées au plus toutes les heures
// (et juste après une demande d'état).
$('btn-logs').addEventListener('click', async () => {
  if (!$('logs-box').hidden) { $('logs-box').hidden = true; return; }
  $('logs-box').hidden = false;
  $('logs-info').textContent = 'Chargement…';
  $('logs').textContent = '';
  try {
    const snap = await getDocs(collection(db, 'families', session.fid, 'logs'));
    const latest = snap.docs.map((d) => d.data())
      .sort((a, b) => (toDate(b.updatedAt)?.getTime() || 0) - (toDate(a.updatedAt)?.getTime() || 0))[0];
    if (!latest) { $('logs-info').textContent = "La tablette n'a encore envoyé aucun journal."; return; }
    $('logs-info').textContent = `Envoyé ${ago(toDate(latest.updatedAt).getTime())}${latest.version ? ` · version ${latest.version}` : ''}. Touchez « État » pour en recevoir un tout neuf.`;
    $('logs').textContent = latest.lines || '(vide)';
  } catch (err) {
    console.error(err);
    $('logs-info').textContent = "Le journal n'a pas pu être lu.";
  }
});

// Chaque encadré (état, journal, Wi-Fi) se ferme par sa croix.
document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => {
  $(btn.dataset.close).hidden = true;
}));

// Wi-Fi : une fenêtre comme celle d'un téléphone. La tablette cherche les réseaux (commande
// wifiScan, réponse reseaux [{ ssid, security, signal 0-4 }]) ; on touche un réseau, on tape
// le mot de passe s'il en faut un, et « Se connecter » envoie la commande wifi.
let stopScan = null;

function wifiCourant() { return tabletMembers.map((m) => m.wifi?.ssid).find(Boolean) || null; }

function barres(signal) {
  const n = Math.max(1, Math.min(4, signal || 1));
  return `<span class="bars" aria-label="Signal ${n} sur 4">${[1, 2, 3, 4].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
}

function ouvrirWifi() {
  $('sheet-wifi').hidden = false;
  history.pushState({ page: 'settings', sheet: true }, '');
  chercherReseaux();
}
$('wifi-modify').addEventListener('click', ouvrirWifi);
$('wifi-close').addEventListener('click', () => history.back());
$('sheet-wifi').addEventListener('click', (e) => { if (e.target === $('sheet-wifi')) history.back(); });

async function connecter(r, password) {
  await sendCommand('wifi', { ssid: r.ssid, security: r.security, ...(r.security === 'open' ? {} : { password }) });
  toast(`La tablette se connecte à « ${r.ssid} »`);
  history.back();
}

function ligneReseau(r, actuel) {
  const li = document.createElement('li');
  li.className = 'wifi-item';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'wifi-choice';
  b.innerHTML = '<span class="wifi-text"><span class="wifi-name"></span><span class="wifi-state"></span></span><span class="wifi-meta"></span>';
  b.querySelector('.wifi-name').textContent = r.ssid;
  b.querySelector('.wifi-state').textContent = actuel ? 'Connectée' : '';
  b.querySelector('.wifi-meta').innerHTML = (r.security === 'open' ? '' : '<svg><use href="#i-lock"/></svg>') + barres(r.signal);
  li.append(b);
  if (actuel) { b.disabled = true; return li; }
  b.addEventListener('click', () => {
    const ouvert = li.querySelector('.wifi-join');
    document.querySelectorAll('.wifi-join').forEach((x) => x.remove());
    if (ouvert) return;
    const form = document.createElement('form');
    form.className = 'wifi-join';
    form.innerHTML = (r.security === 'open'
      ? '<p class="muted small">Réseau ouvert, sans mot de passe.</p>'
      : '<input type="password" autocomplete="off" placeholder="Mot de passe" aria-label="Mot de passe du Wi-Fi" required>')
      + '<button type="submit" class="primary wide">Se connecter</button><p class="error small" hidden></p>';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = form.querySelector('input');
      const err = form.querySelector('.error');
      if (input && input.value.length < 8) { showError(err, 'Le mot de passe Wi-Fi fait au moins 8 caractères.'); return; }
      form.querySelector('button').disabled = true;
      try {
        await connecter(r, input?.value || '');
      } catch (error) {
        console.error(error);
        showError(err, "L'envoi a échoué. Vérifiez la connexion.");
        form.querySelector('button').disabled = false;
      }
    });
    li.append(form);
    form.querySelector('input')?.focus();
  });
  return li;
}

async function chercherReseaux() {
  const tablet = targetTablet();
  const info = $('wifi-scan-info');
  $('wifi-list').replaceChildren();
  $('btn-wifi-scan').hidden = true;
  if (!tablet) { info.textContent = "Aucune tablette n'est reliée à cette famille."; return; }
  const cmdRef = doc(collection(db, 'families', session.fid, 'commands'));
  const batch = writeBatch(db);
  batch.set(cmdRef, { type: 'wifiScan', target: tablet.id, createdBy: session.uid, createdAt: serverTimestamp(), state: 'pending' });
  bumpRev(batch, session.fid);
  try {
    await batch.commit();
  } catch (err) {
    console.error(err);
    info.textContent = "La demande n'a pas pu être envoyée. Vérifiez la connexion.";
    $('btn-wifi-scan').hidden = false;
    return;
  }
  info.innerHTML = '<span class="spinner-inline"></span>La tablette cherche les réseaux autour d\'elle…';
  stopScan?.();
  const timer = setTimeout(() => {
    stopScan?.();
    stopScan = null;
    info.textContent = "La tablette n'a pas répondu.";
    $('btn-wifi-scan').hidden = false;
    deleteDoc(cmdRef).catch(() => {});
  }, 60_000);
  stopScan = onSnapshot(cmdRef, (snap) => {
    const cmd = snap.data();
    if (!cmd || cmd.state === 'pending') return;
    clearTimeout(timer);
    stopScan?.();
    stopScan = null;
    deleteDoc(cmdRef).catch(() => {});
    $('btn-wifi-scan').hidden = false;
    const vus = new Map();
    for (const r of cmd.reseaux || []) {
      if (r?.ssid && (!vus.has(r.ssid) || (r.signal || 0) > (vus.get(r.ssid).signal || 0))) vus.set(r.ssid, r);
    }
    const actuel = wifiCourant();
    const reseaux = [...vus.values()]
      .map((r) => ({ ...r, security: ['wpa2', 'wpa3', 'open'].includes(r.security) ? r.security : 'wpa2' }))
      .sort((x, y) => (y.ssid === actuel) - (x.ssid === actuel) || (y.signal || 0) - (x.signal || 0));
    if (cmd.state !== 'done') { info.textContent = 'La tablette n\'a pas pu chercher les réseaux.'; return; }
    if (!reseaux.length) { info.textContent = 'Aucun réseau trouvé autour de la tablette.'; return; }
    info.textContent = 'Réseaux autour de la tablette';
    $('wifi-list').replaceChildren(...reseaux.map((r) => ligneReseau(r, r.ssid === actuel)));
  }, (err) => console.warn('Recherche Wi-Fi illisible', err));
}
$('btn-wifi-scan').addEventListener('click', chercherReseaux);

// Réseau actuel (la tablette le publie sur sa fiche : wifi = { ssid }). Hors ligne, elle ne
// recevrait pas le changement : il se fait alors directement sur la tablette.
function renderWifi() {
  const enLigne = tabletteEnLigne();
  $('wifi-modify').hidden = !enLigne;
  $('wifi-current').textContent = enLigne
    ? (wifiCourant() || 'Réseau actuel pas encore connu')
    : 'Tablette hors ligne : changez le Wi-Fi directement sur la tablette, dans ses réglages.';
}


function renderRemote() {
  const admin = amFamilyAdmin();
  const tablet = targetTablet();
  $('remote-card').hidden = !amOwner() || !tablet;
  $('wifi-card').hidden = !amOwner() || !tablet;
  renderWifi();
  $('group-tablet').hidden = !amOwner();
  if (tablet) {
    const online = tablet.lastOnline ? toDate(tablet.lastOnline) : null;
    $('remote-tablet').textContent = online ? `Tablette vue en ligne ${ago(online.getTime())}.` : 'Tablette reliée.';
  }
}

// ---------- Réglages : chaque valeur s'affiche, « Modifier » ouvre le champ, « Enregistrer » envoie ----------


function openSetting(card) {
  document.querySelectorAll('.setting.editing').forEach((other) => { if (other !== card) closeSetting(other); });
  SETTINGS[card.id]?.fill?.();
  card.classList.add('editing');
  card.querySelector('.setting-edit').hidden = false;
  card.querySelector('.setting-value').hidden = true;
  card.querySelector('.setting-modify').hidden = true;
  card.querySelector('.setting-edit input:not([type=checkbox]), .setting-edit select')?.focus();
}

function closeSetting(card) {
  card.classList.remove('editing');
  card.querySelector('.setting-edit').hidden = true;
  card.querySelector('.setting-value').hidden = false;
  card.querySelector('.setting-modify').hidden = false;
}

document.querySelectorAll('.setting').forEach((card) => {
  card.querySelector('.setting-modify').addEventListener('click', () => openSetting(card));
  card.querySelector('.setting-cancel').addEventListener('click', () => closeSetting(card));
  card.querySelector('.setting-edit').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = card.querySelector('.setting-edit button[type=submit]');
    btn.disabled = true;
    try {
      if (await SETTINGS[card.id].save() !== false) closeSetting(card);
    } catch (err) {
      console.error(err);
      notice("Le réglage n'a pas pu être enregistré. Vérifiez la connexion.");
    } finally {
      btn.disabled = false;
    }
  });
});

const saveFamily = (data, message) => updateDoc(doc(db, 'families', session.fid), { ...data, rev: increment(1) })
  .then(() => toast(message));

// Prénom de la personne (nom de la famille).
SETTINGS['family-name-card'] = {
  fill() { $('family-name').value = session.family.name; },
  async save() {
    const name = $('family-name').value.trim();
    if (!name) return false;
    if (name === session.family.name) return true;
    await updateDoc(doc(db, 'families', session.fid), { name });
    toast('Prénom enregistré');
    return true;
  },
};

// Mon prénom (Profil).
SETTINGS['my-name-card'] = {
  fill() { $('my-name').value = session.member.name; },
  async save() {
    const name = $('my-name').value.trim();
    if (!name) return false;
    if (name === session.member.name) return true;
    await updateDoc(doc(db, 'families', session.fid, 'members', session.uid), { name });
    session.member.name = name;
    $('my-name-value').textContent = name;
    toast('Prénom enregistré');
    return true;
  },
};

// Mise en veille : families/{fid}.veille = { active, de, a } ; par défaut l'écran s'éteint de 23 h à 7 h.
const veilleActuelle = () => session.family.veille || { active: true, de: 23, a: 7 };

function renderSleep() {
  const v = veilleActuelle();
  $('sleep-value').textContent = v.active === false ? "Jamais : l'écran reste allumé" : `De ${v.de ?? 23} h à ${v.a ?? 7} h`;
}

$('sleep-on').addEventListener('change', () => { $('sleep-hours').hidden = !$('sleep-on').checked; });
SETTINGS['sleep-card'] = {
  fill() {
    const v = veilleActuelle();
    $('sleep-on').checked = v.active !== false;
    $('sleep-from').value = String(v.de ?? 23);
    $('sleep-to').value = String(v.a ?? 7);
    $('sleep-hours').hidden = !$('sleep-on').checked;
  },
  async save() {
    const veille = { active: $('sleep-on').checked, de: Number($('sleep-from').value), a: Number($('sleep-to').value) };
    if (veille.active && veille.de === veille.a) { notice("L'heure de fin doit être différente de l'heure de début."); return false; }
    await saveFamily({ veille }, 'Mise en veille enregistrée');
    return true;
  },
};

// Options de la tablette : families/{fid}.options = { lecture, reponseVocale, radio { active, nom, url } }.
const RADIOS = [
  { nom: 'France Inter', url: 'https://icecast.radiofrance.fr/franceinter-midfi.mp3' },
  { nom: 'franceinfo', url: 'https://icecast.radiofrance.fr/franceinfo-midfi.mp3' },
  { nom: 'ici chanson française', url: 'https://icecast.radiofrance.fr/fbchansonfrancaise-midfi.mp3' },
  { nom: 'France Musique', url: 'https://icecast.radiofrance.fr/francemusique-midfi.mp3' },
  { nom: 'FIP', url: 'https://icecast.radiofrance.fr/fip-midfi.mp3' },
  { nom: 'RTL', url: 'https://icecast.rtl.fr/rtl-1-44-128' },
  { nom: 'RTL2', url: 'https://icecast.rtl2.fr/rtl2-1-44-128' },
  { nom: 'Europe 1', url: 'https://stream.europe1.fr/europe1.mp3' },
  { nom: 'Nostalgie', url: 'https://streaming.nrjaudio.fm/oug7girb92oc' },
  { nom: 'Chérie FM', url: 'https://cdnradio.streamakaci.com/cheriefm1.mp3' },
  { nom: 'RFM', url: 'https://stream.rfm.fr/rfm.mp3' },
  { nom: 'Radio Classique', url: 'https://radioclassique.ice.infomaniak.ch/radioclassique-high.mp3' },
  { nom: 'Rire et Chansons', url: 'https://streaming.nrjaudio.fm/ou8o8xgk7oiu' },
  { nom: 'ici Paris', url: 'https://icecast.radiofrance.fr/fb1071-midfi.mp3', locale: true },
  { nom: 'ici Alsace', url: 'https://icecast.radiofrance.fr/fbalsace-midfi.mp3', locale: true },
  { nom: 'ici Armorique', url: 'https://icecast.radiofrance.fr/fbarmorique-midfi.mp3', locale: true },
  { nom: 'ici Auxerre', url: 'https://icecast.radiofrance.fr/fbauxerre-midfi.mp3', locale: true },
  { nom: 'ici Azur', url: 'https://icecast.radiofrance.fr/fbazur-midfi.mp3', locale: true },
  { nom: 'ici Béarn Bigorre', url: 'https://icecast.radiofrance.fr/fbbearn-midfi.mp3', locale: true },
  { nom: 'ici Belfort-Montbéliard', url: 'https://icecast.radiofrance.fr/fbbelfort-midfi.mp3', locale: true },
  { nom: 'ici Berry', url: 'https://icecast.radiofrance.fr/fbberry-midfi.mp3', locale: true },
  { nom: 'ici Besançon', url: 'https://icecast.radiofrance.fr/fbbesancon-midfi.mp3', locale: true },
  { nom: 'ici Bourgogne', url: 'https://icecast.radiofrance.fr/fbbourgogne-midfi.mp3', locale: true },
  { nom: 'ici Breizh Izel', url: 'https://icecast.radiofrance.fr/fbbreizizel-midfi.mp3', locale: true },
  { nom: 'ici Champagne-Ardenne', url: 'https://icecast.radiofrance.fr/fbchampagne-midfi.mp3', locale: true },
  { nom: 'ici Cotentin', url: 'https://icecast.radiofrance.fr/fbcotentin-midfi.mp3', locale: true },
  { nom: 'ici Creuse', url: 'https://icecast.radiofrance.fr/fbcreuse-midfi.mp3', locale: true },
  { nom: 'ici Drôme Ardèche', url: 'https://icecast.radiofrance.fr/fbdromeardeche-midfi.mp3', locale: true },
  { nom: 'ici Gard Lozère', url: 'https://icecast.radiofrance.fr/fbgardlozere-midfi.mp3', locale: true },
  { nom: 'ici Gascogne', url: 'https://icecast.radiofrance.fr/fbgascogne-midfi.mp3', locale: true },
  { nom: 'ici Gironde', url: 'https://icecast.radiofrance.fr/fbgironde-midfi.mp3', locale: true },
  { nom: 'ici Hérault', url: 'https://icecast.radiofrance.fr/fbherault-midfi.mp3', locale: true },
  { nom: 'ici Isère', url: 'https://icecast.radiofrance.fr/fbisere-midfi.mp3', locale: true },
  { nom: 'ici La Rochelle', url: 'https://icecast.radiofrance.fr/fblarochelle-midfi.mp3', locale: true },
  { nom: 'ici Limousin', url: 'https://icecast.radiofrance.fr/fblimousin-midfi.mp3', locale: true },
  { nom: 'ici Loire Océan', url: 'https://icecast.radiofrance.fr/fbloireocean-midfi.mp3', locale: true },
  { nom: 'ici Lorraine Nord', url: 'https://icecast.radiofrance.fr/fblorrainenord-midfi.mp3', locale: true },
  { nom: 'ici Maine', url: 'https://icecast.radiofrance.fr/fbmaine-midfi.mp3', locale: true },
  { nom: 'ici Mayenne', url: 'https://icecast.radiofrance.fr/fbmayenne-midfi.mp3', locale: true },
  { nom: 'ici Nord', url: 'https://icecast.radiofrance.fr/fbnord-midfi.mp3', locale: true },
  { nom: 'ici Normandie (Caen)', url: 'https://icecast.radiofrance.fr/fbbassenormandie-midfi.mp3', locale: true },
  { nom: 'ici Normandie (Rouen)', url: 'https://icecast.radiofrance.fr/fbhautenormandie-midfi.mp3', locale: true },
  { nom: 'ici Orléans', url: 'https://icecast.radiofrance.fr/fborleans-midfi.mp3', locale: true },
  { nom: 'ici Pays Basque', url: 'https://icecast.radiofrance.fr/fbpaysbasque-midfi.mp3', locale: true },
  { nom: "ici Pays d'Auvergne", url: 'https://icecast.radiofrance.fr/fbpaysdauvergne-midfi.mp3', locale: true },
  { nom: 'ici Pays de Savoie', url: 'https://icecast.radiofrance.fr/fbpaysdesavoie-midfi.mp3', locale: true },
  { nom: 'ici Périgord', url: 'https://icecast.radiofrance.fr/fbperigord-midfi.mp3', locale: true },
  { nom: 'ici Picardie', url: 'https://icecast.radiofrance.fr/fbpicardie-midfi.mp3', locale: true },
  { nom: 'ici Poitou', url: 'https://icecast.radiofrance.fr/fbpoitou-midfi.mp3', locale: true },
  { nom: 'ici Provence', url: 'https://icecast.radiofrance.fr/fbprovence-midfi.mp3', locale: true },
  { nom: 'ici Roussillon', url: 'https://icecast.radiofrance.fr/fbroussillon-midfi.mp3', locale: true },
  { nom: 'ici Sud Lorraine', url: 'https://icecast.radiofrance.fr/fbsudlorraine-midfi.mp3', locale: true },
  { nom: 'ici Toulouse', url: 'https://icecast.radiofrance.fr/fbtoulouse-midfi.mp3', locale: true },
  { nom: 'ici Touraine', url: 'https://icecast.radiofrance.fr/fbtouraine-midfi.mp3', locale: true },
  { nom: 'ici Vaucluse', url: 'https://icecast.radiofrance.fr/fbvaucluse-midfi.mp3', locale: true },
];

(function remplirRadios() {
  const nat = document.createElement('optgroup');
  nat.label = 'Nationales';
  const loc = document.createElement('optgroup');
  loc.label = 'Locales (ex-France Bleu)';
  RADIOS.forEach((r, i) => (r.locale ? loc : nat).append(new Option(r.nom, String(i))));
  $('opt-radio-station').append(nat, loc);
}());

const optionsActuelles = () => session.family.options || {};

function renderOptions() {
  const o = optionsActuelles();
  const lignes = [
    ['Lecture à voix haute', o.lecture ? 'Activée' : 'Désactivée', !!o.lecture],
    ['Réponse vocale', o.reponseVocale ? 'Activée' : 'Désactivée', !!o.reponseVocale],
    ['Radio', o.radio?.active ? (o.radio.nom || 'Activée') : 'Désactivée', !!o.radio?.active],
  ];
  $('options-value').replaceChildren(...lignes.map(([nom, etat, on]) => {
    const li = document.createElement('span');
    li.className = 'option-line';
    const a = document.createElement('span');
    a.textContent = nom;
    const b = document.createElement('span');
    b.className = `option-state${on ? ' on' : ''}`;
    b.textContent = etat;
    li.append(a, b);
    return li;
  }));
}

$('opt-radio').addEventListener('change', () => { $('opt-radio-wrap').hidden = !$('opt-radio').checked; });

// Écouter la station choisie ici, sur le téléphone, pour vérifier qu'elle marche.
let ecouteRadio = null;
function arreterEcoute() {
  ecouteRadio?.pause();
  ecouteRadio = null;
  $('opt-radio-test').textContent = 'Écouter ici';
}
$('opt-radio-test').addEventListener('click', () => {
  if (ecouteRadio) { arreterEcoute(); return; }
  const r = RADIOS[Number($('opt-radio-station').value)] || RADIOS[0];
  ecouteRadio = new Audio(r.url);
  $('opt-radio-test').textContent = 'Chargement…';
  ecouteRadio.addEventListener('playing', () => { $('opt-radio-test').textContent = 'Arrêter'; });
  ecouteRadio.play().catch(() => { arreterEcoute(); notice(`${r.nom} ne répond pas pour le moment.`); });
});
$('opt-radio-station').addEventListener('change', () => { if (ecouteRadio) arreterEcoute(); });
document.querySelectorAll('#options-card .setting-cancel, #form-options').forEach((el) => el.addEventListener(el.tagName === 'FORM' ? 'submit' : 'click', arreterEcoute));
SETTINGS['options-card'] = {
  fill() {
    const o = optionsActuelles();
    $('opt-lecture').checked = !!o.lecture;
    $('opt-vocal').checked = !!o.reponseVocale;
    $('opt-radio').checked = !!o.radio?.active;
    const i = RADIOS.findIndex((r) => r.url === o.radio?.url);
    $('opt-radio-station').value = String(i >= 0 ? i : 0);
    $('opt-radio-wrap').hidden = !$('opt-radio').checked;
  },
  async save() {
    const r = RADIOS[Number($('opt-radio-station').value)] || RADIOS[0];
    const options = {
      lecture: $('opt-lecture').checked,
      reponseVocale: $('opt-vocal').checked,
      radio: { active: $('opt-radio').checked, nom: r.nom, url: r.url },
    };
    await saveFamily({ options }, 'Options envoyées à la tablette');
    return true;
  },
};

// Volume : families/{fid}.volume (0 à 100), appliqué au son des vidéos et des appels.
const volumeActuel = () => (Number.isInteger(session.family.volume) ? session.family.volume : 80);

function renderVolume() { $('volume-text').textContent = `${volumeActuel()} %`; }

$('volume').addEventListener('input', () => { $('volume-value').textContent = `${$('volume').value} %`; });
SETTINGS['volume-card'] = {
  fill() {
    $('volume').value = String(volumeActuel());
    $('volume-value').textContent = `${volumeActuel()} %`;
  },
  async save() {
    await saveFamily({ volume: Number($('volume').value) }, 'Volume envoyé à la tablette');
    return true;
  },
};

// Taille du texte sur la tablette.
const TEXT_SIZES = ['normal', 'grande', 'tres-grande'];
const TEXT_SIZE_LABELS = { normal: 'Normale', grande: 'Grande', 'tres-grande': 'Très grande' };
const tailleActuelle = () => (TEXT_SIZES.includes(session.family.textSize) ? session.family.textSize : 'normal');
let tailleChoisie = 'normal';

function renderTextSize() { $('text-size-value').textContent = TEXT_SIZE_LABELS[tailleActuelle()]; }

function markSize() {
  document.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('active', b.dataset.size === tailleChoisie));
}
document.querySelectorAll('[data-size]').forEach((btn) => btn.addEventListener('click', () => {
  tailleChoisie = btn.dataset.size;
  markSize();
}));
SETTINGS['text-size-card'] = {
  fill() { tailleChoisie = tailleActuelle(); markSize(); },
  async save() {
    await saveFamily({ textSize: tailleChoisie }, 'Taille du texte changée sur la tablette');
    return true;
  },
};

// Ville de la météo : families/{fid}.meteoVille = { nom, lat, lon }, choisie par code postal ;
// la tablette publie la sienne sur sa fiche membre, celle de la famille l'emporte.
let communes = [];

function renderMeteo() {
  const famille = session.family.meteoVille;
  const tablette = tabletMembers.map((m) => m.meteoVille).find(Boolean);
  $('meteo-current').textContent = famille?.nom
    || (tablette?.nom ? `${tablette.nom} (choisie sur la tablette)` : 'Pas encore choisie');
}

async function chercherCommunes() {
  const cp = $('meteo-cp').value.trim();
  communes = [];
  $('meteo-commune-wrap').hidden = true;
  $('meteo-error').hidden = true;
  if (!/^\d{5}$/.test(cp)) return;
  try {
    const r = await fetch(`https://geo.api.gouv.fr/communes?codePostal=${cp}&fields=nom,centre,departement&format=json`);
    communes = (await r.json()).filter((c) => c.centre?.coordinates);
  } catch (err) {
    console.warn('Recherche de commune impossible', err);
    showError($('meteo-error'), 'La recherche a échoué. Vérifiez la connexion.');
    return;
  }
  if ($('meteo-cp').value.trim() !== cp) return;
  if (!communes.length) { showError($('meteo-error'), 'Aucune commune pour ce code postal.'); return; }
  $('meteo-commune').replaceChildren(...communes.map((c, i) => new Option([c.nom, cp, c.departement?.nom].filter(Boolean).join(' · '), String(i))));
  $('meteo-commune-wrap').hidden = false;
}

$('meteo-cp').addEventListener('input', () => {
  $('meteo-cp').value = $('meteo-cp').value.replace(/\D/g, '').slice(0, 5);
  chercherCommunes();
});
SETTINGS['meteo-card'] = {
  fill() {
    $('meteo-cp').value = '';
    communes = [];
    $('meteo-commune-wrap').hidden = true;
    $('meteo-error').hidden = true;
  },
  async save() {
    const c = communes[Number($('meteo-commune').value)];
    if (!c) { showError($('meteo-error'), 'Tapez le code postal puis choisissez la commune.'); return false; }
    const [lon, lat] = c.centre.coordinates;
    await saveFamily({ meteoVille: { nom: c.nom.slice(0, 80), lat, lon } }, 'Ville envoyée à la tablette');
    return true;
  },
};

// ---------- Supprimer la famille et toutes ses données ----------

// Suppression de la famille : sur demande au support, jamais en un bouton (c'est définitif pour tous).
$('btn-delete-family').addEventListener('click', () => {
  const sujet = `Suppression des données de la famille de ${session.family.name}`;
  const corps = `Bonjour,

Je souhaite supprimer la famille de ${session.family.name} et toutes ses données.

---
Code famille : ${session.family.code || session.fid}
Prénom : ${session.member.name}`;
  $('btn-delete-family').href = `mailto:contact@mapapote.fr?subject=${encodeURIComponent(sujet)}&body=${encodeURIComponent(corps)}`;
});

function applyFamily() {
  renderAbonnement();
  renderRemote();
  const admin = amFamilyAdmin();
  // Réglages : responsables seulement (Profil est pour tout le monde).
  $('tile-settings').hidden = !admin;
  // Un responsable ne quitte pas sa famille (il pourrait ne plus jamais revenir).
  $('btn-leave').hidden = admin;
  $('my-name-value').textContent = session.member.name;
  $('text-size-card').hidden = true; // plus réglable : le texte débordait sur la tablette
  $('sleep-card').hidden = !amOwner();
  renderSleep();
  $('volume-card').hidden = !amOwner();
  renderVolume();
  $('options-card').hidden = !amOwner();
  renderOptions();
  $('meteo-card').hidden = !amOwner();
  renderMeteo();
  $('delete-family-info').hidden = !amOwner();
  renderTextSize();
  $('invite-email-card').hidden = !admin;
  $('btn-new-code').hidden = !admin || !CHANGE_CODE_READY;
  if (admin && !stopInvitations) watchInvitations();
  if (!$('view-settings').hidden) renderSettings();
  const name = session.family.name;
  $('family-title').textContent = `Pour ${name}`;
  document.querySelectorAll('.grand-name').forEach((el) => { el.textContent = name; });
  $('message-text').placeholder = `Écrire à ${name}…`;
  $('family-name-card').hidden = !amOwner();
  $('family-name-value').textContent = name;
  if (allMembers.length) renderMembers(allMembers);
}

let stopFamily = null;
function watchFamily() {
  stopFamily?.();
  stopFamily = onSnapshot(doc(db, 'families', session.fid), (snap) => {
    if (!snap.exists()) return;
    session.family = { ...session.family, ...snap.data() };
    applyFamily();
  }, (err) => console.error('Famille illisible', err));
}

// ---------- Ajouter à l'écran d'accueil ----------

let installPrompt = null;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Lancée depuis l'icône de l'écran d'accueil (Android, iPhone) ?
function launchedFromHomeScreen() {
  return ['standalone', 'fullscreen', 'minimal-ui'].some((m) => window.matchMedia(`(display-mode: ${m})`).matches)
    || navigator.standalone === true
    || document.referrer.startsWith('android-app://');
}

function rememberInstalled() {
  $('btn-install').hidden = true;
}

// Chrome Android propose l'installation : on garde l'invitation pour notre bouton.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});
window.addEventListener('appinstalled', rememberInstalled);

// La carte « Installez Papote » ne s'affiche que si l'app n'est pas déjà sur l'écran d'accueil.
async function renderInstallCard() {
  if (launchedFromHomeScreen()) { rememberInstalled(); return; }
  // L'ancien souvenir « déjà installée » cachait le bouton même après une désinstallation.
  try { localStorage.removeItem('papote.installed'); } catch (e) { /* rien */ }
  $('btn-install').hidden = false;
  // Chrome Android sait dire si l'app est déjà installée, même ouverte dans le navigateur.
  try {
    const apps = await navigator.getInstalledRelatedApps?.();
    if (apps && apps.length) rememberInstalled();
  } catch (e) { /* non pris en charge */ }
}

// App Android famille sur le Play Store : à remplir une fois validée. Tant que c'est vide,
// tout le monde (Android, iPhone, ordinateur) installe l'app web.
const PLAY_STORE_URL = '';
const isAndroid = () => /android/i.test(navigator.userAgent);

$('btn-install').addEventListener('click', async () => {
  if (PLAY_STORE_URL && isAndroid() && !inNativeApp()) {
    const code = session?.family?.code ? `&referrer=${encodeURIComponent(`code=${session.family.code}`)}` : '';
    location.href = PLAY_STORE_URL + code;
    return;
  }
  if (installPrompt) {
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null;
    if (outcome === 'accepted') rememberInstalled();
    return;
  }
  // Pas d'invitation du navigateur (iPhone, ou Chrome qui ne l'a pas proposée) : on explique.
  notice(isIos()
    ? "Sur iPhone, dans Safari : touchez le bouton Partager (le carré avec une flèche vers le haut), choisissez « Sur l'écran d'accueil », puis « Ajouter »."
    : "Dans Chrome : touchez le menu ⋮ en haut à droite, puis « Installer l'application » ou « Ajouter à l'écran d'accueil ».");
});

// ---------- Veille : activité de la tablette ----------

let tabletMembers = [];

function ago(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 2) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = new Date(ms);
  return `le ${d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

// Petit indicateur de l'accueil : en ligne (Wi-Fi ou carte SIM), branchée, batterie.
const EN_LIGNE_MS = 45 * 60_000;
// Fiches des membres (dont l'état de la tablette) : écoute relancée si elle tombe en erreur
// ou au retour sur l'app, pour ne jamais afficher un état périmé.
let membresDuCache = true;
let relanceMembres = null;
function abonnerMembres() {
  stopMembers?.();
  clearTimeout(relanceMembres);
  membresDuCache = true;
  const fid = session.fid;
  stopMembers = watchMembers(fid, (all, fromCache) => {
    membresDuCache = fromCache;
    // Retiré de la famille par un responsable : on quitte tout de suite, sans attendre un rechargement.
    if (!fromCache && !all.some((m) => m.id === session.uid)) { quitterFamilleRetire(fid); return; }
    renderMembers(all);
    renderActivity();
  }, async (err) => {
    // Plus le droit de lire : on vérifie si l'on fait encore partie de la famille.
    if (err?.code === 'permission-denied') {
      try {
        const moi = await getDoc(doc(db, 'families', fid, 'members', session.uid));
        if (!moi.exists()) { quitterFamilleRetire(fid); return; }
      } catch (e) { quitterFamilleRetire(fid); return; }
    }
    console.warn('Membres illisibles, nouvelle écoute dans 5 s', err);
    relanceMembres = setTimeout(() => { if (session?.fid === fid) abonnerMembres(); }, 5000);
  });
}

let quitteEnCours = false;
async function quitterFamilleRetire(fid) {
  if (quitteEnCours || session?.fid !== fid) return;
  quitteEnCours = true;
  const nom = session.family?.name || '';
  stopSession();
  if (savedFamilyId() === fid) saveFamilyId(null);
  await notice(`Vous ne faites plus partie de la famille${nom ? ` de ${nom}` : ''}. Un responsable vous a retiré.`);
  quitteEnCours = false;
  enterApp();
}

let cacheDepuis = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { cacheDepuis = Date.now(); return; }
  if (session && cacheDepuis && Date.now() - cacheDepuis > 60_000) abonnerMembres();
});

function tabletteEnLigne() {
  const t = targetTablet();
  return !!(t?.lastOnline && Date.now() - toDate(t.lastOnline).getTime() < EN_LIGNE_MS);
}

function renderTabletChip() {
  const chip = $('tablet-chip');
  const t = targetTablet();
  if (!t?.lastOnline) { chip.hidden = true; return; }
  // Tant que le serveur n'a pas confirmé (retour sur l'app), pas de rouge.
  const enLigne = tabletteEnLigne() || membresDuCache;
  const b = t.battery || {};
  const parSim = !t.wifi?.ssid && !!t.sim;
  const niveau = Number.isFinite(b.level) ? Math.max(0, Math.min(100, b.level)) : null;
  const bas = niveau !== null && niveau < 15 && !b.charging;
  chip.className = `tablet-chip${enLigne ? '' : ' off'}`;
  chip.innerHTML = `<span class="chip-part${enLigne ? ' ok' : ' bad'}"><svg><use href="#${parSim ? 'i-signal' : 'i-wifi'}"/></svg></span>`
    + (b.charging ? '<span class="chip-part ok"><svg><use href="#i-plug"/></svg></span>' : '')
    + (niveau !== null ? `<span class="chip-part${bas ? ' bad' : ''}"><span class="batt"><span style="width:${niveau}%"></span></span>${niveau} %</span>` : '');
  chip.hidden = false;
}

$('tablet-chip').addEventListener('click', () => {
  const t = targetTablet();
  if (!t) return;
  const b = t.battery || {};
  const lignes = [];
  if (tabletteEnLigne()) lignes.push(t.wifi?.ssid ? `En ligne par le Wi-Fi « ${t.wifi.ssid} ».` : t.sim ? 'En ligne par la carte SIM.' : 'En ligne.');
  else lignes.push(`Hors ligne depuis ${ago(toDate(t.lastOnline).getTime()).replace('il y a ', '')}.`);
  if (b.charging === true) lignes.push('Branchée sur son chargeur.');
  else if (b.charging === false) lignes.push('Débranchée.');
  if (Number.isFinite(b.level)) lignes.push(`Batterie : ${b.level} %.`);
  notice(lignes.join(' '));
});

function renderActivity() {
  renderTabletChip();
  renderWifi();
  const el = $('activity');
  const latest = (field) => Math.max(0, ...tabletMembers.map((m) => (m[field] ? toDate(m[field]).getTime() : 0)));
  const online = latest('lastOnline');
  const active = latest('lastActive');
  const copies = ['support-status', 'notifs-status'];
  if (!online) { el.hidden = true; copies.forEach((id) => { $(id).hidden = true; }); return; }
  const name = session.family.name;
  const now = Date.now();
  const hour = new Date().getHours();
  el.hidden = false;
  el.classList.remove('warn');
  // Batterie : envoyée par la tablette ({ level, charging, unpluggedAt }).
  const battery = tabletMembers.filter((m) => m.battery && m.lastOnline)
    .sort((a, b) => toDate(b.lastOnline) - toDate(a.lastOnline))[0]?.battery;
  if (now - online > 45 * 60_000 && membresDuCache) {
    // Données pas encore confirmées par le serveur (retour sur l'app) : on ne crie pas au loup.
    el.textContent = "Mise à jour de l'état de la tablette…";
  } else if (now - online > 45 * 60_000) {
    el.classList.add('warn');
    el.textContent = `La tablette de ${name} ne répond plus depuis ${ago(online).replace('il y a ', '')}. Est-elle branchée et connectée au wifi ?`;
  } else if (battery && battery.charging === false && battery.unpluggedAt) {
    // Débranchée (tablette 2.50+) : unpluggedAt est posé dès que le chargeur est retiré.
    el.classList.add('warn');
    const depuis = ago(toDate(battery.unpluggedAt).getTime()).replace('il y a ', '');
    el.textContent = (depuis === "à l'instant"
      ? `La tablette de ${name} vient d'être débranchée`
      : `La tablette de ${name} est débranchée depuis ${depuis}`)
      + `${Number.isFinite(battery.level) ? ` (${battery.level} %)` : ''}. Pensez à rebrancher son chargeur.`;
  } else if (battery && battery.level < 15 && !battery.charging) {
    el.classList.add('warn');
    el.textContent = `Batterie faible sur la tablette de ${name} (${battery.level} %). Pensez à la brancher.`;
  } else if (active && now - active > 12 * 3600_000 && hour >= 10 && hour < 21) {
    el.classList.add('warn');
    el.textContent = `${name} n'a pas touché la tablette depuis ${ago(active).replace('il y a ', '')}.`;
  } else {
    el.textContent = active
      ? `Tablette en ligne. ${name} l'a utilisée ${ago(active)}.`
      : 'Tablette en ligne.';
  }
  // Même état de la tablette en haut de Notifications et dans Support.
  for (const id of copies) {
    $(id).hidden = false;
    $(id).classList.toggle('warn', el.classList.contains('warn'));
    $(id).textContent = el.textContent;
  }
}

setInterval(() => { if (session) renderActivity(); }, 60_000);

// ---------- Démarrage ----------

// ---------- Ajouter ma tablette : jumelage par code ou QR code ----------
// La tablette crée pairings/{code} ; un responsable la réclame pour une famille, la tablette confirme.

const PAIR_KEY = 'papote.codeTablette';
let pairing = null; // { code, data }
let stopPair = null;
let adminFamilies = [];

function rememberPairCode(code) { try { localStorage.setItem(PAIR_KEY, code); } catch (e) { /* rien */ } }
function pairCode() { try { return localStorage.getItem(PAIR_KEY); } catch (e) { return null; } }
function forgetPairCode() { try { localStorage.removeItem(PAIR_KEY); } catch (e) { /* rien */ } }

function pairStep(step) {
  for (const id of ['form-pair-code', 'form-pair-claim', 'pair-wait', 'pair-done']) $(id).hidden = id !== step;
}

function resetPairing() {
  pairing = null;
  $('pair-error').hidden = true;
  const code = pairCode();
  $('pair-code').value = code ? formatCode(normalizeCode(code)) : '';
  pairStep('form-pair-code');
  if (code) $('form-pair-code').requestSubmit();
}

// La famille se crée avec la première tablette : le client qui scanne le QR code n'a rien d'autre à faire.
const NEW_FAMILY = '__nouvelle__';

async function loadAdminFamilies() {
  const list = [];
  for (const f of myFamilies) {
    try {
      const snap = await getDoc(doc(db, 'families', f.fid));
      const data = snap.data();
      if (data && (data.createdBy === authUser.uid || (data.admins || []).includes(authUser.uid))) list.push({ fid: f.fid, name: data.name });
    } catch (e) { /* famille illisible */ }
  }
  return list;
}

// Sans famille : la page de jumelage s'ouvre hors de toute famille (pas de session).
function openPairingWithoutFamily() {
  resetPairing();
  show('view-pair');
}
$('btn-join-pair').addEventListener('click', openPairingWithoutFamily);
$('pair-back').addEventListener('click', () => { if (page === 'pair') history.back(); else showJoin(myFamilies.length > 0); });
// Retour : dans la famille qui vient d'être reliée (ou créée), sinon à l'accueil.
$('btn-pair-home').addEventListener('click', () => enterApp());

$('form-pair-code').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = normalizeCode($('pair-code').value);
  const fail = (msg) => { $('pair-error').textContent = msg; $('pair-error').hidden = false; };
  $('pair-error').hidden = true;
  try {
    const snap = await getDoc(doc(db, 'pairings', code));
    const data = snap.data();
    if (!data) return fail("Aucune tablette allumée n'affiche ce code. Vérifiez les 8 caractères sur l'écran de la tablette : elle doit être allumée et connectée à Internet.");
    if (toDate(data.expiresAt) < new Date()) return fail('Ce code a expiré. La tablette en affichera un nouveau.');
    if (data.status !== 'waiting') return fail('Cette tablette est déjà en cours d\'installation.');
    adminFamilies = await loadAdminFamilies();
    pairing = { code, data };
    forgetPairCode();
    $('pair-name').textContent = `Tablette « ${data.name} »`;
    // Responsable d'une ou plusieurs familles : la tablette rejoint l'une d'elles (la famille ouverte
    // d'abord). Une nouvelle famille seulement pour qui n'en a aucune.
    const ordered = [...adminFamilies].sort((x, y) => (y.fid === session?.fid) - (x.fid === session?.fid));
    $('pair-family').replaceChildren(...(ordered.length
      ? ordered.map((f, i) => new Option(`Famille de ${f.name}`, f.fid, false, i === 0))
      : [new Option('Une nouvelle famille', NEW_FAMILY, false, true)]));
    $('pair-family-wrap').hidden = ordered.length < 2;
    $('pair-grand').value = data.name || '';
    // Première tablette : la famille porte le nom donné sur la tablette, il ne reste que son prénom.
    $('pair-grand-wrap').hidden = !!data.name;
    $('pair-myname').value = session?.member.name || (authUser.displayName || '').split(' ')[0];
    syncClaimLabel();
    pairStep('form-pair-claim');
  } catch (err) {
    console.error(err);
    fail('Impossible de lire ce code. Vérifiez la connexion internet.');
  }
});

function syncClaimLabel() {
  const isNew = $('pair-family').value === NEW_FAMILY;
  $('pair-new').hidden = !isNew;
  const fam = adminFamilies.find((f) => f.fid === $('pair-family').value);
  $('btn-pair-claim').textContent = isNew ? 'Valider' : `Relier à la famille de ${fam.name}`;
}
$('pair-family').addEventListener('change', syncClaimLabel);

$('form-pair-claim').addEventListener('submit', async (e) => {
  e.preventDefault();
  let fam = adminFamilies.find((f) => f.fid === $('pair-family').value);
  let myName = session?.member.name;
  const ref2 = doc(db, 'pairings', pairing.code);
  try {
    if ($('pair-family').value === NEW_FAMILY) {
      const grand = $('pair-grand').value.trim();
      myName = $('pair-myname').value.trim();
      if (!grand || !myName) { notice('Indiquez le prénom de la personne qui aura la tablette, et le vôtre.'); return; }
      const fid = await createFamily(grand, myName);
      fam = { fid, name: grand };
      adminFamilies.push(fam);
    }
    await updateDoc(ref2, {
      status: 'claimed', fid: fam.fid, familyName: fam.name, claimedBy: authUser.uid, claimedName: myName,
    });
  } catch (err) {
    console.error(err);
    $('pair-error').textContent = "La tablette n'a pas pu être réclamée. Le code a peut-être expiré.";
    $('pair-error').hidden = false;
    pairStep('form-pair-code');
    return;
  }
  $('pair-wait-text').textContent = `La tablette « ${pairing.data.name} » affiche « ${myName} veut relier cette tablette à la famille de ${fam.name} ». Touchez Accepter sur la tablette.`;
  pairStep('pair-wait');
  stopPair?.();
  stopPair = onSnapshot(ref2, (snap) => {
    const status = snap.data()?.status;
    if (status !== 'confirmed' && status !== 'refused') return;
    stopPair?.();
    stopPair = null;
    $('pair-done-title').textContent = status === 'confirmed' ? 'Tablette reliée' : 'Tablette non reliée';
    if (status === 'confirmed') saveFamilyId(fam.fid);
    $('pair-done-text').textContent = status === 'confirmed'
      ? `La tablette « ${pairing.data.name} » fait maintenant partie de la famille de ${fam.name}. Elle affichera les photos et messages dans un instant.`
      : 'La tablette a refusé. Si ce n\'était pas une erreur, recommencez avec le nouveau code affiché.';
    pairStep('pair-done');
  }, (err) => console.warn('Jumelage illisible', err));
});

// ---------- Connexion et choix de la famille ----------

const INVITE_CODE_KEY = 'papote.codeInvite';
let myFamilies = []; // [{ fid, name }]
let skipInvites = false;
let stopPending = null;
let sharedPending = false;
let rappelerPending = false; // ouvert par « Rappeler » sur une notification d'appel manqué

function rememberInviteCode(code, pour) {
  try {
    localStorage.setItem(INVITE_CODE_KEY, code);
    if (pour) localStorage.setItem(`${INVITE_CODE_KEY}.pour`, pour.slice(0, 40));
  } catch (e) { /* rien */ }
}
function invitePour() {
  try { return localStorage.getItem(`${INVITE_CODE_KEY}.pour`); } catch (e) { return null; }
}
function inviteCode() {
  try { return localStorage.getItem(INVITE_CODE_KEY); } catch (e) { return null; }
}
function forgetInviteCode() {
  try { localStorage.removeItem(INVITE_CODE_KEY); localStorage.removeItem(`${INVITE_CODE_KEY}.pour`); } catch (e) { /* rien */ }
}

function stopSession() {
  stopPage?.();
  stopPage = null;
  stopMembers?.();
  stopMembers = null;
  stopTabletBusy?.();
  stopTabletBusy = null;
  stopIncoming?.();
  stopIncoming = null;
  showIncoming(null);
  stopFamily?.();
  stopFamily = null;
  stopInvitations?.();
  stopInvitations = null;
  stopPending?.();
  stopPending = null;
  stopAgenda();
  stopNotifs();
  session = null;
}

function showLoginError(message) {
  $('login-error').textContent = message;
  $('login-error').hidden = !message;
}

$('btn-google').addEventListener('click', async () => {
  showLoginError('');
  try {
    // null : la page part vers Google et reviendra (redirection).
    if (await signInGoogle()) await enterApp();
  } catch (err) {
    if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return;
    console.error(err);
    showLoginError(err.code === 'auth/popup-blocked'
      ? 'Le téléphone a bloqué la fenêtre de connexion. Autorisez les fenêtres pour Papote et réessayez.'
      : 'La connexion a échoué. Vérifiez la connexion internet et réessayez.');
  }
});

$('form-email').addEventListener('submit', async (e) => {
  e.preventDefault();
  showLoginError('');
  const email = $('login-email').value.trim();
  $('btn-email').disabled = true;
  try {
    await sendEmailLink(email);
    $('email-sent').textContent = `Lien envoyé à ${email}. Ouvrez l'e-mail sur ce téléphone et touchez le lien (pensez aux courriers indésirables).`;
    $('email-sent').hidden = false;
  } catch (err) {
    console.error(err);
    showLoginError("L'e-mail n'a pas pu être envoyé. Vérifiez l'adresse.");
  } finally {
    $('btn-email').disabled = false;
  }
});

$('form-link-email').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('link-error').hidden = true;
  try {
    await completeEmailLink($('link-email').value.trim());
    await enterApp();
  } catch (err) {
    console.error(err);
    $('link-error').textContent = 'Ce lien ne fonctionne plus. Demandez-en un nouveau.';
    $('link-error').hidden = false;
  }
});

document.querySelectorAll('[data-action=logout]').forEach((btn) => btn.addEventListener('click', async () => {
  if (!await askConfirm('Se déconnecter de Papote sur ce téléphone ?')) return;
  stopSession();
  await logOut();
  showLogin(false);
}));

document.querySelectorAll('[data-action=other-family]').forEach((btn) => btn.addEventListener('click', () => {
  showJoin(myFamilies.length > 0);
}));

$('btn-join-back').addEventListener('click', () => enterApp());
$('btn-skip-invites').addEventListener('click', () => { skipInvites = true; enterApp(); });

$('family-switch').addEventListener('change', () => {
  saveFamilyId($('family-switch').value);
  enterApp();
});

function showLogin(legacy) {
  $('login-legacy').hidden = !legacy;
  $('email-sent').hidden = true;
  showLoginError('');
  show('view-login');
}

function showJoin(canGoBack) {
  $('join-account').textContent = `Connecté avec ${myEmail()}`;
  $('btn-join-back').hidden = !canGoBack;
  // Venu de sa famille : « Retour » en haut à droite, pas de déconnexion ici.
  $('join-logout').hidden = canGoBack;
  const code = inviteCode();
  const pour = code ? invitePour() : null;
  if (code) $('join-code').value = formatCode(normalizeCode(code));
  // Lien d'invitation d'un proche : seulement le prénom à donner, pas l'installation de la tablette.
  $('join-pair-card').hidden = !!code;
  $('join-code-wrap').hidden = !!code;
  $('join-title').textContent = code
    ? (pour ? `Rejoindre la famille de ${pour}` : 'Rejoindre la famille')
    : 'Vous êtes invité dans une famille';
  $('join-help').textContent = code
    ? 'Donnez votre prénom : un responsable de la famille acceptera votre arrivée.'
    : "Pour les proches. Entrez le code famille qu'on vous a envoyé ; un responsable acceptera votre arrivée. Le plus simple : demandez-lui de vous inviter avec votre adresse e-mail.";
  show('view-join');
  if (code) $('join-name').focus();
}

function defaultName() {
  const user = currentAuthUser();
  return (user?.displayName || '').split(' ')[0] || '';
}

let authUser = null;
const currentAuthUser = () => authUser;

function showInvitations(invitations) {
  const box = $('invitations');
  box.replaceChildren(...invitations.map((inv) => {
    const card = document.createElement('form');
    card.className = 'card';
    card.innerHTML = '<h2></h2><p class="muted"></p><label>Votre prénom<input maxlength="40" required></label>'
      + '<button type="submit" class="primary wide">Rejoindre la famille</button><p class="error" hidden></p>';
    card.querySelector('h2').textContent = `Famille de ${inv.familyName}`;
    card.querySelector('p.muted').textContent = `${inv.invitedBy || 'Un responsable'} vous invite à rejoindre la famille.`;
    const input = card.querySelector('input');
    input.value = defaultName();
    card.addEventListener('submit', async (e) => {
      e.preventDefault();
      card.querySelector('button').disabled = true;
      try {
        await acceptInvitation(inv, input.value.trim());
        saveFamilyId(inv.fid);
        await enterApp();
      } catch (err) {
        console.error(err);
        const p = card.querySelector('.error');
        p.textContent = "Impossible de rejoindre pour le moment. L'invitation a peut-être été annulée.";
        p.hidden = false;
        card.querySelector('button').disabled = false;
      }
    });
    return card;
  }));
  $('btn-skip-invites').hidden = false;
  show('view-invited');
}

// En attente : on écoute sa propre fiche, l'app s'ouvre dès qu'un responsable accepte.
function showPending(fid) {
  stopPending?.();
  stopPending = onSnapshot(doc(db, 'families', fid, 'members', authUser.uid), (snap) => {
    if (!snap.exists()) { stopPending?.(); stopPending = null; enterApp(); return; }
    if (snap.data().status !== 'pending') {
      stopPending?.();
      stopPending = null;
      saveFamilyId(fid);
      enterApp();
    }
  }, () => {});
  show('view-pending');
}

async function enterApp() {
  stopSession();
  show('loading');
  authUser = await currentUser();
  if (!isRealAccount(authUser)) { showLogin(!!savedFamilyId()); return; }
  // Bascule en Europe : la bonne base et le bon bucket avant toute lecture.
  await choisirBase();
  if (bucketUrl()) ouvrirStorage(bucketUrl());
  try {
    const saved = savedFamilyId();
    if (saved) await tagLegacyMember(saved);
    const memberships = await myMemberships();
    const invitations = (await myInvitations()).filter((inv) => !memberships.some((m) => m.fid === inv.fid));
    if (invitations.length && !skipInvites) { showInvitations(invitations); return; }
    const active = memberships.filter((m) => m.status !== 'pending');
    if (!active.length) {
      const pending = memberships.find((m) => m.status === 'pending');
      if (pairCode()) openPairingWithoutFamily();
      else if (pending) showPending(pending.fid);
      else showJoin(false);
      return;
    }
    const chosen = active.find((m) => m.fid === saved) || active[0];
    saveFamilyId(chosen.fid);
    myFamilies = await Promise.all(active.map(async (m) => ({ fid: m.fid, name: await familyName(m.fid) || 'Famille' })));
    renderFamilySwitch(chosen.fid);
  } catch (err) {
    console.error('Familles illisibles', err);
  }
  session = await loadMembership();
  if (!session) { showJoin(false); return; }
  forgetInviteCode();
  applyFamily();
  watchFamily();
  abonnerMembres();
  stopTabletBusy?.();
  stopTabletBusy = watchTabletBusy(session.fid, (busy) => { tabletInCall = busy; renderCallTile(); });
  stopIncoming?.();
  stopIncoming = watchIncomingCalls(session.fid, session.uid,
    (uid) => tabletMembers.some((m) => m.id === uid), (list) => showIncoming(list[list.length - 1] || null));
  renderPushNudge();
  renderPauseNudge();
  if (pushAllowed()) enablePush(session.fid, session.uid);
  warmUpCalls();
  startAgenda(session, setNotifReminders);
  startNotifs(session);
  renderInstallCard();
  renderAccount();
  goHome();
  renderOutbox();
  flushOutbox();
  // Famille toute neuve : d'abord régler la tablette ; sinon le petit guide habituel.
  if (!showIntroTablette()) showGuideOnce(session.family.name);
  if (sharedPending) { sharedPending = false; openShared(); }
  rafraichirJetonNatif();
  if (appelerPending) { appelerPending = false; $('tile-call').click(); }
  if (rappelerPending) { rappelerPending = false; offerCallBack(); }
  else if (pairCode()) openPage('pair');
}

function renderFamilySwitch(current) {
  const select = $('family-switch');
  select.replaceChildren(...myFamilies.map((f) => new Option(`Famille de ${f.name}`, f.fid, false, f.fid === current)));
  select.hidden = myFamilies.length < 2;
  $('family-title').hidden = myFamilies.length >= 2;
}

function renderAccount() {
  $('account-email').textContent = `Connecté avec ${myEmail()}`;
}

let appelerPending = false; // ouvert par l'app Android pour appeler la tablette en vidéo

async function start() {
  // Écran d'appel de l'app Android : #connexion=<jeton> pour être connecté sans écran de connexion.
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('connexion')) {
    const jeton = hash.get('connexion');
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* rien */ }
    try { await connexionParJeton(jeton); } catch (err) { console.warn('Connexion par jeton impossible', err); }
  }
  const params = new URLSearchParams(location.search);
  appelerPending = params.get('appeler') === 'video';
  sharedPending = params.has('partage');
  rappelerPending = params.has('rappeler');
  if (params.get('appel')) answerOnArrival(params.get('appel'));
  // Ouvert par l'app Android Papote : ce téléphone sonnera par elle (voir push.js).
  if (params.get('natif')) rememberNativeToken(params.get('natif'));
  // Rouvert par l'app Android : ?pause=1 tant que le réglage n'est pas fait (sinon absent).
  if (params.get('natif') || params.get('pause')) {
    try { sessionStorage.setItem('papote.pause', params.get('pause') === '1' ? '1' : '0'); } catch (e) { /* rien */ }
  }
  // Arrivé par le lien ou le QR code d'invitation : le code est gardé le temps de se connecter.
  if (params.get('code')) rememberInviteCode(params.get('code'), params.get('pour'));
  // Lien du site après une commande : le code est gardé jusqu'à ce que la famille existe.
  if (params.get('commande')) {
    try { localStorage.setItem('papote.codeCommande', params.get('commande')); } catch (e) { /* rien */ }
  }
  if (params.get('abonnement') === 'ok') {
    try { localStorage.setItem('papote.retourPaiement', '1'); } catch (e) { /* rien */ }
  }
  // QR code affiché par une nouvelle tablette : on ouvre « Ajouter ma tablette » après la connexion.
  if (params.get('tablette')) rememberPairCode(params.get('tablette'));
  try {
    await finishRedirect();
  } catch (err) {
    console.error('Retour de connexion Google', err);
  }
  if (isEmailLink()) {
    try {
      const user = await completeEmailLink();
      if (!user) { show('view-link-email'); return; }
    } catch (err) {
      console.error(err);
      history.replaceState(null, '', location.pathname);
      showLogin(false);
      showLoginError('Ce lien de connexion ne fonctionne plus. Demandez-en un nouveau.');
      return;
    }
  } else if (params.toString()) {
    history.replaceState(null, '', location.pathname);
  }
  await enterApp();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

start();

// ---------- Barres de défilement visibles ----------
// Le téléphone cache sa barre : on en dessine une (rail clair, curseur indigo) sur les listes
// qui peuvent dépasser, comme sur la tablette.
function barreDefilement(el) {
  const wrap = document.createElement('div');
  wrap.className = `defil${el.classList.contains('sheet-body') ? ' defil-sheet' : ''}`;
  el.parentNode.insertBefore(wrap, el);
  wrap.append(el);
  el.classList.add('defil-zone');
  const rail = document.createElement('div');
  rail.className = 'defil-rail';
  rail.innerHTML = '<span></span>';
  wrap.append(rail);
  const pouce = rail.firstChild;
  const maj = () => {
    const { scrollHeight: h, clientHeight: c, scrollTop: t } = el;
    rail.hidden = h <= c + 2;
    if (rail.hidden) return;
    const H = rail.clientHeight;
    const ph = Math.max(28, (H * c) / h);
    pouce.style.height = `${ph}px`;
    pouce.style.transform = `translateY(${((H - ph) * t) / (h - c)}px)`;
  };
  el.addEventListener('scroll', maj, { passive: true });
  new ResizeObserver(maj).observe(el);
  new MutationObserver(maj).observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  maj();
}
['wifi-list', 'logs', 'form-post', 'form-reminder'].forEach((id) => barreDefilement($(id)));
barreDefilement(document.querySelector('#sheet-wifi .sheet-body'));
