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
} from './firebase.js';
import { askConfirm, notice } from './ui.js';
import { showGuideOnce } from './guide.js';
import {
  abonnementOk, FORMULES, LIBELLES, ouvrirPortail, payer, rattacherCommande, resilier, annulerResiliation,
} from './abonnement.js';
import { startCall } from './appel.js';
import { prepareVideo } from './video.js';
import { startAgenda, stopAgenda } from './agenda.js';
import {
  isRealAccount, myEmail, signInGoogle, finishRedirect, sendEmailLink, isEmailLink, completeEmailLink, logOut,
  myMemberships, familyName, tagLegacyMember, myInvitations, acceptInvitation,
  inviteByEmail, cancelInvitation, acceptMember, changeFamilyCode,
} from './compte.js';
import {
  startNotifs, stopNotifs, markNotifsRead, setNotifMembers, setNotifReminders,
} from './notifs.js';

const $ = (id) => document.getElementById(id);
const MAX_IMAGE_CHARS = 900_000; // un document Firestore est limité à 1 Mo

let session = null; // { fid, family, member, uid }
let stopMembers = null;

const VIEWS = ['view-invite', 'view-profile', 'view-pair', 'loading', 'view-login', 'view-link-email', 'view-invited', 'view-pending', 'view-join', 'view-home', 'view-photos', 'view-videos', 'view-messages', 'view-agenda', 'view-settings', 'view-notifs', 'view-support'];

function show(view) {
  for (const id of VIEWS) $(id).hidden = id !== view;
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
    await joinFamily($('join-code').value, $('join-name').value.trim());
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
  messages: () => watchType(['message', 'reply'], 60, renderMessages),
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
  if (!$('viewer').hidden || !$('sheet-post').hidden || !$('sheet-reminder').hidden) {
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
  const items = posts.slice().reverse().map((post) => {
    const mine = post.authorUid === session.uid;
    const li = document.createElement('li');
    li.className = `bubble ${mine ? 'mine' : 'theirs'}${post.type === 'reply' ? ' reply' : ''}`;
    if (!mine && post.type !== 'reply' && faces[post.authorUid]) {
      li.classList.add('with-face');
      li.append(avatar(faces[post.authorUid]));
    }
    if (!mine) {
      const who = document.createElement('p');
      who.className = 'bubble-who';
      who.textContent = post.type === 'reply' ? grand : post.authorName;
      li.append(who);
    }
    const text = document.createElement('p');
    text.className = 'bubble-text';
    text.textContent = post.text;
    li.append(text);
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
  $('messages-empty').hidden = posts.length > 0;
  requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
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
    if (text) $('post-text').value = text.slice(0, 80);
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
try {
  storage = getStorage(getApp());
  // Sans réponse de Storage, on bascule vite sur la base plutôt que de réessayer 10 minutes.
  storage.maxUploadRetryTime = 10_000;
  storage.maxOperationRetryTime = 10_000;
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

// L'e-mail part avec le nom de la famille et le téléphone utilisé, pour aider à comprendre le souci.
$('btn-contact').addEventListener('click', () => {
  const body = [
    'Bonjour,', '', '(Décrivez votre problème ici)', '', '---',
    `Famille : ${session.family.name}`,
    `Prénom : ${session.member.name}`,
    `Téléphone : ${navigator.userAgent}`,
  ].join('\n');
  $('btn-contact').href = `mailto:tanguyreynaud22@gmail.com?subject=${encodeURIComponent("Papote : besoin d'aide")}`
    + `&body=${encodeURIComponent(body)}`;
});

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
$('face-nudge').addEventListener('click', () => openPage('settings'));

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
  return `${location.origin}/?code=${formatCode(session.family.code)}`;
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
  $('call').classList.remove('force-landscape');
  try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) { /* rien */ }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
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
  if (err && err.name === 'NotAllowedError') return "La caméra ou le micro est refusé. Autorisez-les dans les réglages du navigateur, puis réessayez.";
  if (err && (err.name === 'NotReadableError' || err.name === 'AbortError')) return 'La caméra est déjà utilisée par une autre application.';
  if (err && err.name === 'NotFoundError') return "Aucune caméra ou aucun micro n'a été trouvé.";
  // Le détail aide à comprendre une panne signalée par la famille.
  const detail = err ? ` (${err.name || 'Erreur'} : ${String(err.message || err).slice(0, 80)})` : '';
  return `L'appel n'a pas pu démarrer. Réessayez dans un instant.${detail}`;
}

$('tile-call').addEventListener('click', async () => {
  if (currentCall) return;
  if (paused()) return;
  const allowed = await cameraAllowed();
  if (allowed) enterCallScreen();
  $('call').hidden = false;
  setCallStatus('Préparation de la caméra…');
  try {
    currentCall = await startCall(session.fid, { uid: session.uid, name: session.member.name }, {
      local: $('call-local'),
      remote: $('call-remote'),
      onState: (state) => {
        if (!allowed && state === 'ringing') enterCallScreen();
        setCallStatus(CALL_MESSAGES[state]());
      },
      onEnd: (reason) => {
        currentCall = null;
        setCallStatus(END_MESSAGES[reason] || 'Appel terminé');
        setTimeout(() => {
          if (currentCall) return;
          leaveCallScreen();
          if (reason === 'missed' || reason === 'declined') offerVideoMessage();
        }, 2000);
      },
    });
  } catch (err) {
    console.error(err);
    currentCall = null;
    setCallStatus(callErrorMessage(err));
    setTimeout(() => { if (!currentCall) leaveCallScreen(); }, 4000);
  }
});

// Mamie n'a pas répondu : proposer de lui laisser un petit message vidéo à la place.
async function offerVideoMessage() {
  const name = session.family.name;
  if (!await askConfirm(`${name} n'a pas répondu. Lui laisser un message vidéo ?`, 'Filmer')) return;
  openPage('videos');
  openAdd('video');
  $('in-video-camera').click();
}

$('call-hangup').addEventListener('click', () => {
  if (currentCall) currentCall.hangup();
  else leaveCallScreen();
});

let allMembers = [];

function renderMembers(all) {
  allMembers = all;
  // Les demandes en attente sont à part : seuls les responsables les voient et les acceptent.
  const pending = all.filter((m) => m.status === 'pending');
  const members = all.filter((m) => m.status !== 'pending');
  renderRequests(pending);
  tabletMembers = members.filter((m) => m.role === 'tablette');
  faces = Object.fromEntries(members.filter((m) => m.face).map((m) => [m.id, m.face]));
  myFace = faces[session.uid] || null;
  renderFace();
  setNotifMembers(members);
  renderActivity();
  renderRemote();
  // Le bouton d'appel n'apparaît que si une tablette sait recevoir les appels (Android 5 et plus).
  const canCall = members.some((m) => m.role === 'tablette' && m.canCall);
  $('tile-call').disabled = !(canCall && !!navigator.mediaDevices);
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
        const menu = document.createElement('div');
        menu.className = 'member-actions';
        if (!isCreator) {
          const toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'link small';
          toggle.textContent = isAdmin ? 'Retirer responsable' : 'Rendre responsable';
          toggle.addEventListener('click', () => setFamilyAdmin(m.id, !isAdmin));
          menu.append(toggle);
        }
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'link danger small';
        remove.textContent = 'Retirer';
        remove.addEventListener('click', () => removeMember(m));
        menu.append(remove);
        li.append(menu);
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
  $('pending-banner').textContent = pending.length === 1
    ? `${pending[0].name} veut rejoindre la famille`
    : `${pending.length} personnes veulent rejoindre la famille`;
  $('requests').replaceChildren(...pending.map((m) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'member-name';
    name.textContent = m.email ? `${m.name} (${m.email})` : m.name;
    const actions = document.createElement('div');
    actions.className = 'member-actions';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'primary small-btn';
    ok.textContent = 'Accepter';
    ok.addEventListener('click', async () => {
      try { await acceptMember(session.fid, m.id); toast(`${m.name} a rejoint la famille`); } catch (err) { console.error(err); notice("L'acceptation a échoué."); }
    });
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'link danger small';
    no.textContent = 'Refuser';
    no.addEventListener('click', async () => {
      if (!await askConfirm(`Refuser la demande de ${m.name} ?`)) return;
      try { await deleteDoc(doc(db, 'families', session.fid, 'members', m.id)); } catch (err) { console.error(err); }
    });
    actions.append(ok, no);
    li.append(name, actions);
    return li;
  }));
}

$('pending-banner').addEventListener('click', () => openPage('settings'));

function watchInvitations() {
  stopInvitations?.();
  stopInvitations = null;
  if (!amFamilyAdmin()) return;
  stopInvitations = onSnapshot(collection(db, 'families', session.fid, 'invitations'), (snap) => {
    $('invitations-sent').replaceChildren(...snap.docs.map((d) => {
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
  try {
    await inviteByEmail(session.fid, session.family, email, session.member.name);
    $('invite-email').value = '';
    toast(`Invitation prête : ${email} peut se connecter à Papote`);
    if (navigator.share) {
      navigator.share({
        title: 'Papote',
        text: `Je t'invite sur Papote pour envoyer des photos à ${session.family.name}. Connecte-toi avec ${email} :`,
        url: location.origin,
      }).catch(() => {});
    }
  } catch (err) {
    console.error(err);
    notice("L'invitation n'a pas pu être enregistrée.");
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
  const msg = quand
    ? `Résilier l'abonnement ? Papote continuera de fonctionner jusqu'au ${quand}, puis la tablette se mettra en pause.`
    : "Résilier l'abonnement ? La tablette se mettra en pause à la fin de la période payée.";
  if (!await askConfirm(msg, 'Résilier')) return;
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

function renderAbonnement() {
  const abo = session.family.abonnement;
  useOrderCodeFromSite(abo?.statut, amOwner());
  const admin = amOwner(); // l'abonnement est l'affaire du propriétaire, celui qui paie
  const statut = abo?.statut;
  // Bloc Abonnement en haut du Profil, pour le propriétaire, même sans abonnement payant.
  $('abo-card').hidden = !amOwner();
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
    if (abo.formule) details.push(`Formule ${abo.formule === 'sim' ? 'carte SIM' : 'Wi-Fi'}, tablette ${abo.tablette === 'incluse' ? 'incluse' : 'achetée'}`);
    const futur = (t) => t && toDate(t) > new Date();
    if (futur(abo.essaiJusqua)) details.push(`Essai gratuit jusqu'au ${dateLongue(abo.essaiJusqua)}`);
    if (futur(abo.engagementJusqua)) details.push(`Engagement jusqu'au ${dateLongue(abo.engagementJusqua)}`);
    if (abo.resiliationLe) details.push(`Résiliation prévue le ${dateLongue(abo.resiliationLe)}`);
    else if (abo.finPeriode && statut === 'actif' && !futur(abo.essaiJusqua)) details.push(`Prochaine échéance le ${dateLongue(abo.finPeriode)}`);
    $('abo-details').textContent = details.join(' · ');
    const enCours = ['actif', 'impaye'].includes(statut);
    $('btn-portail').hidden = !abo.stripeCustomerId || statut === 'offert';
    $('btn-resilier').hidden = !enCours || !!abo.resiliationLe || !abo.stripeSubscriptionId;
    $('btn-garder').hidden = !enCours || !abo.resiliationLe;
    $('abo-choices').hidden = !['aucun', 'resilie', 'suspendu'].includes(statut);
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
  $('remote-result').hidden = !text;
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

$('wifi-security').addEventListener('change', () => {
  $('wifi-password-wrap').hidden = $('wifi-security').value === 'open';
});

$('form-wifi').addEventListener('submit', async (e) => {
  e.preventDefault();
  const security = $('wifi-security').value;
  const password = $('wifi-password').value;
  if (security !== 'open' && password.length < 8) { showRemote('Le mot de passe Wi-Fi fait au moins 8 caractères.', 'warn'); return; }
  if (!await askConfirm(`Envoyer le réseau « ${$('wifi-ssid').value.trim()} » à la tablette ? Si le nom ou le mot de passe est faux, elle garde son Wi-Fi actuel.`, 'Envoyer')) return;
  await sendCommand('wifi', { ssid: $('wifi-ssid').value.trim(), security, ...(security === 'open' ? {} : { password }) });
  $('wifi-password').value = '';
});

function renderRemote() {
  const admin = amFamilyAdmin();
  const tablet = targetTablet();
  $('remote-card').hidden = !amOwner() || !tablet;
  if (tablet) {
    const online = tablet.lastOnline ? toDate(tablet.lastOnline) : null;
    $('remote-tablet').textContent = online ? `Tablette vue en ligne ${ago(online.getTime())}.` : 'Tablette reliée.';
  }
}

// ---------- Taille du texte sur la tablette ----------

const TEXT_SIZES = ['normal', 'grande', 'tres-grande'];
document.querySelectorAll('[data-size]').forEach((btn) => btn.addEventListener('click', async () => {
  try {
    // Le changement de rev prévient la tablette, qui relit la famille.
    await updateDoc(doc(db, 'families', session.fid), { textSize: btn.dataset.size, rev: increment(1) });
    toast('Taille du texte changée sur la tablette');
  } catch (err) {
    console.error(err);
    notice("Le réglage n'a pas pu être enregistré.");
  }
}));

function renderTextSize() {
  const size = TEXT_SIZES.includes(session.family.textSize) ? session.family.textSize : 'normal';
  document.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('active', b.dataset.size === size));
}

// ---------- Supprimer la famille et toutes ses données (responsable) ----------

async function deleteAllIn(path, each) {
  const snap = await getDocs(collection(db, ...path));
  for (const d of snap.docs) {
    if (each) await each(d);
    await deleteDoc(d.ref);
  }
}

$('btn-delete-family').addEventListener('click', async () => {
  const name = session.family.name;
  if (!await askConfirm(`Supprimer la famille de ${name} ? Toutes les photos, vidéos, messages, rappels et membres seront effacés pour tout le monde, et la tablette sera déconnectée. C'est définitif.`, 'Tout supprimer')) return;
  if (!await askConfirm(`Dernière vérification : effacer définitivement toutes les données de la famille de ${name} ?`, 'Effacer')) return;
  const { fid, uid } = session;
  toast('Suppression en cours…');
  try {
    await deleteAllIn(['families', fid, 'posts'], async (d) => {
      const post = { id: d.id, ...d.data() };
      if (post.storagePath && storage) await deleteObject(ref(storage, post.storagePath)).catch(() => {});
      await deleteAllIn(['families', fid, 'posts', d.id, 'media']);
    });
    for (const name2 of ['reminders', 'birthdays', 'invitations']) await deleteAllIn(['families', fid, name2]);
    await deleteAllIn(['families', fid, 'calls'], async (d) => {
      await deleteAllIn(['families', fid, 'calls', d.id, 'callerCandidates']);
      await deleteAllIn(['families', fid, 'calls', d.id, 'calleeCandidates']);
    });
    const codes = await getDocs(query(collection(db, 'invites'), where('fid', '==', fid)));
    for (const d of codes.docs) await deleteDoc(d.ref);
    const members = await getDocs(collection(db, 'families', fid, 'members'));
    for (const d of members.docs) if (d.id !== uid) await deleteDoc(d.ref);
    await deleteDoc(doc(db, 'families', fid));
    await deleteDoc(doc(db, 'families', fid, 'members', uid));
    saveFamilyId(null);
    await notice(`La famille de ${name} et toutes ses données ont été supprimées.`);
    enterApp();
  } catch (err) {
    console.error(err);
    notice("La suppression n'a pas pu aller jusqu'au bout. Réessayez avec une bonne connexion.");
  }
});

$('form-my-name').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('my-name').value.trim();
  if (!name || name === session.member.name) return;
  try {
    await updateDoc(doc(db, 'families', session.fid, 'members', session.uid), { name });
    session.member.name = name;
    toast('Prénom enregistré');
  } catch (err) {
    console.error(err);
    notice("Le prénom n'a pas pu être enregistré.");
  }
});

function applyFamily() {
  renderAbonnement();
  renderRemote();
  const admin = amFamilyAdmin();
  // Réglages : responsables seulement (Profil est pour tout le monde).
  $('tile-settings').hidden = !admin;
  // Un responsable ne quitte pas sa famille (il pourrait ne plus jamais revenir).
  $('btn-leave').hidden = admin;
  if (document.activeElement !== $('my-name')) $('my-name').value = session.member.name;
  $('text-size-card').hidden = !amOwner();
  $('btn-delete-family').hidden = !amOwner();
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
  if (document.activeElement !== $('family-name')) $('family-name').value = name;
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

$('form-family-name').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('family-name').value.trim();
  if (!name || name === session.family.name) return;
  try {
    await updateDoc(doc(db, 'families', session.fid), { name });
    toast('Nom enregistré');
  } catch (err) {
    console.error(err);
    notice("Le nom n'a pas pu être enregistré.");
  }
});

// ---------- Ajouter à l'écran d'accueil ----------

let installPrompt = null;
const INSTALLED_KEY = 'papote.installed';
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Lancée depuis l'icône de l'écran d'accueil (Android, iPhone) ?
function launchedFromHomeScreen() {
  return ['standalone', 'fullscreen', 'minimal-ui'].some((m) => window.matchMedia(`(display-mode: ${m})`).matches)
    || navigator.standalone === true
    || document.referrer.startsWith('android-app://');
}

function rememberInstalled() {
  try { localStorage.setItem(INSTALLED_KEY, '1'); } catch (e) { /* stockage indisponible */ }
  $('btn-install').hidden = true;
}

function knownInstalled() {
  try { return localStorage.getItem(INSTALLED_KEY) === '1'; } catch (e) { return false; }
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
  $('btn-install').hidden = knownInstalled();
  // Chrome Android sait dire si l'app est déjà installée, même ouverte dans le navigateur.
  try {
    const apps = await navigator.getInstalledRelatedApps?.();
    if (apps && apps.length) rememberInstalled();
  } catch (e) { /* non pris en charge */ }
}

$('btn-install').addEventListener('click', async () => {
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

function renderActivity() {
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
  // Batterie : envoyée par la tablette avec son signal « en ligne » ({ level, charging }).
  const battery = tabletMembers.filter((m) => m.battery && m.lastOnline)
    .sort((a, b) => toDate(b.lastOnline) - toDate(a.lastOnline))[0]?.battery;
  if (now - online > 45 * 60_000) {
    el.classList.add('warn');
    el.textContent = `La tablette de ${name} ne répond plus depuis ${ago(online).replace('il y a ', '')}. Est-elle branchée et connectée au wifi ?`;
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
    if (!data) return fail('Ce code ne correspond à aucune tablette. Vérifiez-le sur l\'écran de la tablette.');
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

function rememberInviteCode(code) {
  try { localStorage.setItem(INVITE_CODE_KEY, code); } catch (e) { /* rien */ }
}
function inviteCode() {
  try { return localStorage.getItem(INVITE_CODE_KEY); } catch (e) { return null; }
}
function forgetInviteCode() {
  try { localStorage.removeItem(INVITE_CODE_KEY); } catch (e) { /* rien */ }
}

function stopSession() {
  stopPage?.();
  stopPage = null;
  stopMembers?.();
  stopMembers = null;
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
  const code = inviteCode();
  if (code) $('join-code').value = formatCode(normalizeCode(code));
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
  stopMembers = watchMembers(session.fid, renderMembers);
  startAgenda(session, setNotifReminders);
  startNotifs(session);
  renderInstallCard();
  renderAccount();
  goHome();
  renderOutbox();
  flushOutbox();
  showGuideOnce(session.family.name);
  if (sharedPending) { sharedPending = false; openShared(); }
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

async function start() {
  const params = new URLSearchParams(location.search);
  sharedPending = params.has('partage');
  // Arrivé par le lien ou le QR code d'invitation : le code est gardé le temps de se connecter.
  if (params.get('code')) rememberInviteCode(params.get('code'));
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
