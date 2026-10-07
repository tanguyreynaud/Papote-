// App famille : envoyer photos, vidéos et messages vers la tablette.
import {
  query, where, orderBy, limit, getDocs, getCountFromServer,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getStorage, ref, uploadBytes, getDownloadURL, deleteObject,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';
import {
  db, doc, updateDoc, deleteDoc, collection, onSnapshot, writeBatch, serverTimestamp, bumpRev,
  loadMembership, createFamily, joinFamily, leaveFamily, watchMembers, currentUser, savedFamilyId, saveFamilyId,
  addPost, deletePost, loadMedia, formatCode, normalizeCode, toDate, CodeInconnuError,
  MAX_VIDEO_CHUNKS, VIDEO_CHUNK,
} from './firebase.js';
import { startCall } from './appel.js';
import { prepareVideo } from './video.js';
import { startAgenda, stopAgenda } from './agenda.js';
import {
  isRealAccount, myEmail, signInGoogle, finishRedirect, sendEmailLink, isEmailLink, completeEmailLink, logOut,
  myMemberships, familyName, tagLegacyMember, myInvitations, acceptInvitation,
  inviteByEmail, cancelInvitation, acceptMember, createTabletCode, changeFamilyCode,
} from './compte.js';
import {
  startNotifs, stopNotifs, markNotifsRead, setNotifMembers, setNotifReminders,
} from './notifs.js';

const $ = (id) => document.getElementById(id);
const MAX_IMAGE_CHARS = 900_000; // un document Firestore est limité à 1 Mo

let session = null; // { fid, family, member, uid }
let stopMembers = null;

const VIEWS = ['loading', 'view-login', 'view-link-email', 'view-invited', 'view-pending', 'view-join', 'view-home', 'view-photos', 'view-videos', 'view-messages', 'view-agenda', 'view-settings', 'view-notifs', 'view-support'];

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
  settings: () => { renderSettings(); return null; },
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

function amFamilyAdmin() {
  const f = session?.family;
  return !!f && (f.createdBy === session.uid || (f.admins || []).includes(session.uid));
}

async function confirmDelete(post, what) {
  if (!confirm(`Supprimer ${what} de la tablette ?`)) return;
  try {
    await removePost(post);
  } catch (err) {
    console.error(err);
    alert("La suppression a échoué. Vérifiez la connexion.");
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
  if (!confirm(`Supprimer ${what} de la tablette ?`)) return;
  history.back();
  try { await removePost(post); } catch (err) { console.error(err); alert('La suppression a échoué. Vérifiez la connexion.'); }
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
      alert("L'enregistrement a échoué. Vérifiez la connexion.");
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
  return { full: fullSize(img), thumb: resize(img, 800, 0.72) };
}

function openAdd(kind) {
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

async function addPhotoFiles(files) {
  if (!files.length) return;
  setStatus('Préparation…');
  for (const file of files) {
    try {
      pendingPhotos.push(await compressPhoto(file));
    } catch (err) {
      console.error(err);
      alert(`La photo « ${file.name} » n'a pas pu être lue.`);
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
    : pendingPhotos.map((photo, i) => ({ kind, text: i === 0 ? text : '', photo, author }));
  let sent = 0;
  try {
    for (const item of items) {
      if (!navigator.onLine) throw new Error('hors ligne');
      setBusy(kind === 'video' ? 'Envoi de la vidéo…' : items.length > 1 ? `Photo ${sent + 1} sur ${items.length}…` : 'Envoi…');
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
  return sendPhoto(item.photo, item.text, item.author);
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
    alert("L'envoi a échoué. Vérifiez la connexion et réessayez.");
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

const MAX_VIDEO_SECONDS = 120;
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
  if (post.storagePath && storage) {
    try { await deleteObject(ref(storage, post.storagePath)); } catch (err) { console.warn('Fichier déjà absent', err); }
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
    alert("La photo n'a pas pu être enregistrée. Vérifiez la connexion.");
  }
}

$('face-camera').addEventListener('click', () => $('in-face-camera').click());
$('face-gallery').addEventListener('click', () => $('in-face-gallery').click());
$('in-face-camera').addEventListener('change', onFaceChosen);
$('in-face-gallery').addEventListener('change', onFaceChosen);
$('face-remove').addEventListener('click', async () => {
  if (!confirm('Retirer votre photo ?')) return;
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
    alert('Lien copié. Collez-le dans un SMS ou un e-mail.');
  }
});

$('btn-leave').addEventListener('click', async () => {
  if (!confirm(`Quitter la famille de ${session.family.name} ? Il faudra une nouvelle invitation pour revenir.`)) return;
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
function enterCallScreen() {
  const el = document.documentElement;
  if (!el.requestFullscreen || document.fullscreenElement) return;
  el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}

function leaveCallScreen() {
  $('call').hidden = true;
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
        setTimeout(() => { if (!currentCall) leaveCallScreen(); }, 2000);
      },
    });
  } catch (err) {
    console.error(err);
    currentCall = null;
    setCallStatus(callErrorMessage(err));
    setTimeout(() => { if (!currentCall) leaveCallScreen(); }, 4000);
  }
});

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
    alert("Le changement n'a pas pu être enregistré.");
  }
}

async function removeMember(m) {
  if (!confirm(`Retirer ${m.name} de la famille ? Son téléphone ne recevra plus rien. Il pourra revenir avec le code famille.`)) return;
  try {
    await deleteDoc(doc(db, 'families', session.fid, 'members', m.id));
    if ((session.family.admins || []).includes(m.id)) await setFamilyAdmin(m.id, false);
  } catch (err) {
    console.error(err);
    alert("Ce membre n'a pas pu être retiré.");
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
      try { await acceptMember(session.fid, m.id); toast(`${m.name} a rejoint la famille`); } catch (err) { console.error(err); alert("L'acceptation a échoué."); }
    });
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'link danger small';
    no.textContent = 'Refuser';
    no.addEventListener('click', async () => {
      if (!confirm(`Refuser la demande de ${m.name} ?`)) return;
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
    alert("L'invitation n'a pas pu être enregistrée.");
  }
});

$('btn-tablet-code').addEventListener('click', async () => {
  $('btn-tablet-code').disabled = true;
  try {
    const code = await createTabletCode(session.fid);
    $('tablet-code').textContent = formatCode(code);
    $('tablet-code').hidden = false;
  } catch (err) {
    console.error(err);
    alert("Le code n'a pas pu être créé.");
  } finally {
    $('btn-tablet-code').disabled = false;
  }
});

$('btn-new-code').addEventListener('click', async () => {
  if (!confirm("Changer le code famille ? L'ancien code et l'ancien QR code ne permettront plus de rejoindre la famille.")) return;
  try {
    await changeFamilyCode(session.fid, session.family.code);
    toast('Nouveau code famille');
  } catch (err) {
    console.error(err);
    alert("Le code n'a pas pu être changé.");
  }
});

function applyFamily() {
  const admin = amFamilyAdmin();
  $('invite-email-card').hidden = !admin;
  $('tablet-card').hidden = !admin;
  $('btn-new-code').hidden = !admin || !CHANGE_CODE_READY;
  if (admin && !stopInvitations) watchInvitations();
  if (!$('view-settings').hidden) renderSettings();
  const name = session.family.name;
  $('family-title').textContent = `Pour ${name}`;
  document.querySelectorAll('.grand-name').forEach((el) => { el.textContent = name; });
  $('message-text').placeholder = `Écrire à ${name}…`;
  $('family-name-card').hidden = !amFamilyAdmin();
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
    alert("Le nom n'a pas pu être enregistré.");
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
  $('install-card').hidden = true;
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
  $('install-card').hidden = knownInstalled();
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
  const help = $('install-help');
  help.hidden = false;
  if (isIos()) {
    help.innerHTML = '<p>Sur iPhone, il faut passer par Safari :</p><ol>'
      + '<li>Touchez le bouton <strong>Partager</strong> (le carré avec une flèche vers le haut) en bas de l\'écran</li>'
      + '<li>Choisissez <strong>« Sur l\'écran d\'accueil »</strong></li>'
      + '<li>Touchez <strong>Ajouter</strong></li></ol>'
      + '<p class="small muted">Au premier lancement, entrez à nouveau le code famille.</p>';
  } else {
    help.innerHTML = '<p>Dans Chrome, touchez le menu <strong>⋮</strong> en haut à droite, '
      + 'puis <strong>« Ajouter à l\'écran d\'accueil »</strong> ou <strong>« Installer l\'application »</strong>.</p>';
  }
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
  if (now - online > 45 * 60_000) {
    el.classList.add('warn');
    el.textContent = `La tablette ne répond plus depuis ${ago(online).replace('il y a ', '')}. Est-elle branchée et connectée au wifi ?`;
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
  if (!confirm('Se déconnecter de Papote sur ce téléphone ?')) return;
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
      if (pending) showPending(pending.fid);
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
  if (sharedPending) { sharedPending = false; openShared(); }
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
