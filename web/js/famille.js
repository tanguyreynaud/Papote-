// App famille : envoyer photos, vidéos et messages vers la tablette.
import {
  query, where, orderBy, limit,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import {
  db, doc, updateDoc, collection, onSnapshot,
  loadMembership, createFamily, joinFamily, leaveFamily, watchMembers,
  addPost, deletePost, loadMedia, formatCode, normalizeCode, toDate, CodeInconnuError,
  MAX_VIDEO_CHUNKS, VIDEO_CHUNK,
} from './firebase.js';
import { startCall } from './appel.js';
import { prepareVideo } from './video.js';
import { startAgenda, stopAgenda } from './agenda.js';
import {
  startNotifs, stopNotifs, markNotifsRead, setNotifMembers, setNotifReminders,
} from './notifs.js';

const $ = (id) => document.getElementById(id);
const MAX_IMAGE_CHARS = 900_000; // un document Firestore est limité à 1 Mo

let session = null; // { fid, family, member, uid }
let stopMembers = null;

const VIEWS = ['loading', 'view-join', 'view-home', 'view-photos', 'view-videos', 'view-messages', 'view-agenda', 'view-settings', 'view-notifs', 'view-support'];

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
    await start();
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
    await start();
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

const PAGES = {
  photos: () => watchType(['photo'], 60, renderPhotos),
  videos: () => watchType(['video'], 30, renderVideos),
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

async function confirmDelete(post, what) {
  if (!confirm(`Supprimer ${what} de la tablette ?`)) return;
  try {
    await deletePost(session.fid, post);
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
  who.textContent = `${post.authorName} · ${shortLabel(toDate(post.createdAt))}`;
  info.append(who);
  if (post.seenAt) {
    const seen = document.createElement('p');
    seen.className = 'seen small';
    seen.textContent = 'Vu ✓';
    info.append(seen);
  }
  meta.append(info);
  if (post.authorUid === session.uid) {
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

function openViewer(post) {
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
    const src = await loadMedia(session.fid, post, 'image');
    if (src && !$('viewer').hidden) $('viewer-img').src = src;
  } catch (err) {
    console.error(err);
  }
}

async function openVideo(post) {
  openViewer(post);
  $('viewer-caption').textContent = 'Chargement de la vidéo…';
  try {
    const src = await loadMedia(session.fid, post, 'video');
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
    li.append(foot);
    if (mine) {
      li.addEventListener('click', () => confirmDelete(post, 'ce message'));
      li.title = 'Toucher pour supprimer';
    }
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
  try {
    await addPost(session.fid, { type: 'message', text, authorUid: session.uid, authorName: session.member.name });
    $('message-text').value = '';
    updateCount();
  } catch (err) {
    console.error(err);
    alert("Le message n'est pas parti. Vérifiez la connexion et réessayez.");
  } finally {
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

function fullSize(img) {
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
  return { full: fullSize(img), thumb: resize(img, 480, 0.7) };
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
  if (!file) return;
  $('pickers').hidden = true;
  try {
    const result = await prepareVideo(file, (done, total) => {
      setStatus(`Préparation de la vidéo… ${Math.round(done)} / ${Math.round(total)} s`);
    });
    const base64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
      reader.readAsDataURL(result.blob);
    });
    if (base64.length > MAX_VIDEO_CHUNKS * VIDEO_CHUNK) {
      setStatus('La vidéo est trop lourde. Essayez une vidéo plus courte.');
      syncAddSheet();
      return;
    }
    pendingVideo = { base64, mime: result.mime, thumb: result.thumb, duration: result.duration };
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

$('form-post').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('post-text').value.trim();
  const author = { authorUid: session.uid, authorName: session.member.name };
  setStatus('');
  try {
    if (addMode === 'video') {
      if (!pendingVideo) return;
      setBusy('Envoi de la vidéo…');
      await addPost(session.fid, {
        type: 'video', text, video: pendingVideo.base64, mime: pendingVideo.mime,
        thumb: pendingVideo.thumb, duration: pendingVideo.duration, ...author,
      });
    } else {
      if (!pendingPhotos.length) return;
      for (let i = 0; i < pendingPhotos.length; i++) {
        setBusy(pendingPhotos.length > 1 ? `Photo ${i + 1} sur ${pendingPhotos.length}…` : 'Envoi…');
        // La légende accompagne la première photo.
        await addPost(session.fid, {
          type: 'photo', text: i === 0 ? text : '', image: pendingPhotos[i].full, thumb: pendingPhotos[i].thumb, ...author,
        });
      }
    }
    setBusy('');
    history.back();
    toast('Envoyé');
  } catch (err) {
    console.error(err);
    setStatus("L'envoi a échoué. Vérifiez la connexion et réessayez.");
  } finally {
    setBusy('');
  }
});

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

// ---------- Réglages ----------

function inviteLink() {
  return `${location.origin}/?code=${formatCode(session.family.code)}`;
}

function renderSettings() {
  $('settings-code').textContent = formatCode(session.family.code);
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
  if (!confirm('Quitter la famille sur ce téléphone ? Vous pourrez revenir avec le code famille.')) return;
  stopPage?.();
  stopMembers?.();
  stopAgenda();
  stopNotifs();
  await leaveFamily(session.fid, session.uid);
  session = null;
  $('family-title').textContent = '';
  show('view-join');
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

// Pendant l'appel : plein écran et téléphone à l'horizontale, comme l'écran de la tablette.
// Le verrouillage n'est possible qu'en plein écran ; sinon on reste tel quel.
function enterCallScreen() {
  const el = document.documentElement;
  if (!el.requestFullscreen || document.fullscreenElement) return;
  el.requestFullscreen({ navigationUI: 'hide' })
    .then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'))
    .catch(() => {});
}

function leaveCallScreen() {
  $('call').hidden = true;
  try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) { /* rien */ }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

$('tile-call').addEventListener('click', async () => {
  if (currentCall) return;
  enterCallScreen();
  $('call').hidden = false;
  setCallStatus('Préparation de la caméra…');
  try {
    currentCall = await startCall(session.fid, { uid: session.uid, name: session.member.name }, {
      local: $('call-local'),
      remote: $('call-remote'),
      onState: (state) => setCallStatus(CALL_MESSAGES[state]()),
      onEnd: (reason) => {
        currentCall = null;
        setCallStatus(END_MESSAGES[reason] || 'Appel terminé');
        setTimeout(() => { if (!currentCall) leaveCallScreen(); }, 2000);
      },
    });
  } catch (err) {
    console.error(err);
    currentCall = null;
    setCallStatus("Impossible d'accéder à la caméra ou au micro. Autorisez-les dans les réglages du navigateur.");
    setTimeout(() => { if (!currentCall) leaveCallScreen(); }, 4000);
  }
});

$('call-hangup').addEventListener('click', () => {
  if (currentCall) currentCall.hangup();
  else leaveCallScreen();
});

function renderMembers(members) {
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
    li.append(m.role === 'tablette' ? `Tablette de ${session.family.name}` : m.name);
    list.append(li);
  }
}

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

async function start() {
  session = await loadMembership();
  if (!session) {
    const code = new URLSearchParams(location.search).get('code');
    if (code) $('join-code').value = formatCode(normalizeCode(code));
    show('view-join');
    return;
  }
  $('family-title').textContent = `Pour ${session.family.name}`;
  document.querySelectorAll('.grand-name').forEach((el) => { el.textContent = session.family.name; });
  $('message-text').placeholder = `Écrire à ${session.family.name}…`;
  stopMembers?.();
  stopMembers = watchMembers(session.fid, renderMembers);
  history.replaceState(null, '', location.pathname);
  startAgenda(session, setNotifReminders);
  startNotifs(session);
  renderInstallCard();
  goHome();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

start();
