// App famille : envoyer photos et messages vers la tablette.
import {
  loadMembership, createFamily, joinFamily, leaveFamily, watchPosts, watchMembers,
  addPost, deletePost, loadMedia, formatCode, normalizeCode, toDate, CodeInconnuError,
} from './firebase.js';
import { startCall } from './appel.js';
import { prepareVideo } from './video.js';
import { MAX_VIDEO_CHUNKS, VIDEO_CHUNK } from './firebase.js';
import { startAgenda, stopAgenda } from './agenda.js';

const $ = (id) => document.getElementById(id);
const MAX_IMAGE_CHARS = 900_000; // un document Firestore est limité à 1 Mo

let session = null; // { fid, family, member, uid }
let pendingPhotos = []; // { full, thumb } : data URLs prêtes à envoyer
let pendingVoice = null; // { dataUrl, duration }
let pendingVideo = null; // { base64, mime, thumb, duration }
let stopFeed = null;
let stopMembers = null;

function show(view) {
  for (const id of ['loading', 'view-join', 'view-app', 'view-settings']) {
    $(id).hidden = id !== view;
  }
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = !message;
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
    show('view-settings');
    renderSettings();
  } catch (err) {
    console.error(err);
    showError($('create-error'), 'Impossible de créer la famille. Vérifiez la connexion internet.');
  } finally {
    button.disabled = false;
  }
});

// ---------- Photos ----------

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

async function compressPhoto(file) {
  const img = await loadImage(file);
  return { full: fullSize(img), thumb: resize(img, 480, 0.7) };
}

function fullSize(img) {
  let maxSide = 1600;
  let quality = 0.82;
  for (;;) {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (dataUrl.length <= MAX_IMAGE_CHARS || maxSide <= 600) return dataUrl;
    if (quality > 0.6) quality -= 0.1;
    else maxSide -= 200;
  }
}

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
    remove.textContent = '×';
    remove.setAttribute('aria-label', 'Retirer cette photo');
    remove.addEventListener('click', () => {
      pendingPhotos.splice(i, 1);
      renderPreviews();
    });
    wrap.append(img, remove);
    box.append(wrap);
  });
}

// Même traitement pour une photo prise avec la caméra ou choisie dans la galerie.
async function onPhotosChosen(e) {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length) return;
  setBusy('Préparation…');
  for (const file of files) {
    try {
      pendingPhotos.push(await compressPhoto(file));
    } catch (err) {
      console.error(err);
      alert(`La photo « ${file.name} » n'a pas pu être lue.`);
    }
  }
  setBusy('');
  renderPreviews();
}

$('post-photos').addEventListener('change', onPhotosChosen);
$('post-camera').addEventListener('change', onPhotosChosen);

// Un seul bouton « Photo » qui propose la caméra ou la galerie.
$('photo-from-camera').addEventListener('click', () => $('post-camera').click());
$('photo-from-gallery').addEventListener('click', () => $('post-photos').click());

// ---------- Écran d'envoi (photo, message ou vocal) ----------

let mode = null;

const MODES = {
  photo: { title: 'Envoyer une photo', placeholder: 'Ajouter une légende (facultatif)' },
  message: { title: 'Écrire un message', placeholder: null },
  voice: { title: 'Message vocal', placeholder: null },
  video: { title: 'Envoyer une vidéo', placeholder: 'Ajouter une légende (facultatif)' },
};

function openComposer(next) {
  mode = next;
  $('composer-title').textContent = MODES[mode].title;
  $('photo-pickers').hidden = mode !== 'photo';
  $('video-pickers').hidden = mode !== 'video' || !!pendingVideo;
  $('video-hint').hidden = mode !== 'video' || !!pendingVideo;
  $('previews').hidden = mode !== 'photo';
  $('voice-recorder').hidden = mode !== 'voice' || !!pendingVoice;
  $('post-text').hidden = mode === 'voice';
  $('post-text').placeholder = MODES[mode].placeholder || `Écrire un message à ${session.family.name}…`;
  $('post-text').maxLength = mode === 'photo' || mode === 'video' ? 80 : 160;
  updateCount();
  $('actions').hidden = true;
  $('form-post').hidden = false;
  setStatus('');
  if (mode === 'message') $('post-text').focus();
}

function closeComposer() {
  if (recorder) recorder.stop();
  mode = null;
  pendingPhotos = [];
  renderPreviews();
  clearVoice();
  clearVideo();
  $('post-text').value = '';
  $('form-post').hidden = true;
  $('actions').hidden = false;
}

document.querySelectorAll('.tile[data-mode]').forEach((tile) => {
  tile.addEventListener('click', () => openComposer(tile.dataset.mode));
});
$('composer-close').addEventListener('click', closeComposer);

function updateCount() {
  const max = $('post-text').maxLength;
  const left = max - $('post-text').value.length;
  $('text-count').textContent = `${left} caractère${left > 1 ? 's' : ''} restant${left > 1 ? 's' : ''}`;
  $('text-count').hidden = mode === 'voice';
}
$('post-text').addEventListener('input', updateCount);

function showSent() {
  $('sent-toast').hidden = false;
  setTimeout(() => { $('sent-toast').hidden = true; }, 2500);
}

// Bouton « Envoyer » transformé en indicateur de chargement pendant l'envoi.
function setBusy(label) {
  const btn = $('btn-send');
  btn.disabled = !!label;
  $('post-text').disabled = !!label;
  $('post-photos').disabled = !!label;
  $('post-camera').disabled = !!label;
  $('btn-voice').disabled = !!label;
  $('photo-from-camera').disabled = !!label;
  $('photo-from-gallery').disabled = !!label;
  $('video-from-camera').disabled = !!label;
  $('video-from-gallery').disabled = !!label;
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

$('form-post').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('post-text').value.trim();
  if (mode === 'photo' && !pendingPhotos.length) { setStatus('Choisissez d\'abord une photo.'); return; }
  if (mode === 'message' && !text) { setStatus('Écrivez d\'abord votre message.'); return; }
  if (mode === 'voice' && !pendingVoice) { setStatus('Enregistrez d\'abord votre message vocal.'); return; }
  if (mode === 'video' && !pendingVideo) { setStatus('Choisissez d\'abord une vidéo.'); return; }
  setBusy('Envoi…');
  const author = { authorUid: session.uid, authorName: session.member.name };
  try {
    if (mode === 'video') {
      setBusy('Envoi de la vidéo…');
      await addPost(session.fid, {
        type: 'video', text, video: pendingVideo.base64, mime: pendingVideo.mime,
        thumb: pendingVideo.thumb, duration: pendingVideo.duration, ...author,
      });
    } else if (mode === 'voice') {
      await addPost(session.fid, {
        type: 'voice', text: '', audio: pendingVoice.dataUrl, duration: pendingVoice.duration, ...author,
      });
    } else if (mode === 'photo') {
      for (let i = 0; i < pendingPhotos.length; i++) {
        setBusy(pendingPhotos.length > 1 ? `Photo ${i + 1} sur ${pendingPhotos.length}…` : 'Envoi…');
        // La légende accompagne la première photo.
        await addPost(session.fid, {
          type: 'photo', text: i === 0 ? text : '', image: pendingPhotos[i].full, thumb: pendingPhotos[i].thumb, ...author,
        });
      }
    } else {
      await addPost(session.fid, { type: 'message', text, ...author });
    }
    setBusy('');
    closeComposer();
    showSent();
  } catch (err) {
    console.error(err);
    setStatus("L'envoi a échoué. Vérifiez la connexion et réessayez.");
  } finally {
    setBusy('');
  }
});

// ---------- Fil des envois ----------

function timeLabel(date) {
  if (!date) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const hm = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `aujourd'hui à ${hm}`;
  return `${date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} à ${hm}`;
}

function renderFeed(posts) {
  const feed = $('feed');
  feed.replaceChildren();
  $('feed-empty').hidden = posts.length > 0;
  const grand = session.family?.name || 'la tablette';
  for (const post of posts) {
    const li = document.createElement('li');
    if (post.type === 'reply') {
      li.className = 'card post reply';
      const p = document.createElement('p');
      p.className = 'reply-text';
      p.textContent = `${grand} : ${post.text}`;
      const when = document.createElement('p');
      when.className = 'muted small';
      when.textContent = timeLabel(toDate(post.createdAt));
      li.append(p, when);
      feed.append(li);
      continue;
    }
    li.className = `card post post-${post.type}`;
    const kind = document.createElement('p');
    kind.className = 'post-kind';
    kind.textContent = { photo: '📷 Photo', message: '✉️ Message', voice: '🎤 Message vocal', video: '🎥 Vidéo' }[post.type] || '';
    li.append(kind);
    if (post.type === 'voice') {
      const play = document.createElement('button');
      play.className = 'action-btn wide voice-play';
      play.textContent = `▶ Écouter le vocal${post.duration ? ` (${Math.floor(post.duration / 60)}:${String(post.duration % 60).padStart(2, '0')})` : ''}`;
      play.addEventListener('click', async () => {
        play.disabled = true;
        play.textContent = 'Chargement…';
        try {
          const src = await loadMedia(session.fid, post, 'audio');
          const audio = document.createElement('audio');
          audio.controls = true;
          audio.className = 'post-audio';
          audio.src = src;
          play.replaceWith(audio);
          audio.play().catch(() => {});
        } catch (err) {
          console.error(err);
          play.disabled = false;
          play.textContent = 'Réessayer';
        }
      });
      li.append(play);
    }
    if (post.type === 'video') {
      const watch = document.createElement('button');
      watch.className = 'action-btn wide video-play';
      watch.textContent = `▶ Regarder la vidéo${post.duration ? ` (${post.duration} s)` : ''}`;
      watch.addEventListener('click', async () => {
        watch.disabled = true;
        watch.textContent = 'Chargement…';
        try {
          const src = await loadMedia(session.fid, post, 'video');
          const v = document.createElement('video');
          v.controls = true;
          v.playsInline = true;
          v.className = 'feed-video';
          v.src = src;
          li.querySelector('.post-thumb')?.remove();
          watch.replaceWith(v);
          v.play().catch(() => {});
        } catch (err) {
          console.error(err);
          watch.disabled = false;
          watch.textContent = 'Réessayer';
        }
      });
      li.append(watch);
    }
    const preview = post.thumb || post.image;
    if (preview) {
      const img = document.createElement('img');
      img.src = preview;
      img.alt = '';
      img.loading = 'lazy';
      img.className = 'post-thumb';
      if (post.type !== 'video') img.addEventListener('click', () => openPhoto(post));
      li.append(img);
    }
    if (post.text) {
      const p = document.createElement('p');
      p.className = 'post-text';
      p.textContent = post.text;
      li.append(p);
    }
    const meta = document.createElement('div');
    meta.className = 'post-meta';
    const who = document.createElement('span');
    who.textContent = `${post.authorName}, ${timeLabel(toDate(post.createdAt))}`;
    const seen = document.createElement('span');
    seen.className = post.seenAt ? 'seen' : 'muted';
    seen.textContent = post.seenAt ? `Vu par ${grand} ✓` : 'Pas encore vu';
    if (post.hearts > 0) seen.textContent += `  ${'❤️'.repeat(Math.min(post.hearts, 5))}`;
    meta.append(who, seen);
    li.append(meta);
    if (post.authorUid === session.uid) {
      const del = document.createElement('button');
      del.className = 'link danger small';
      del.textContent = 'Supprimer';
      del.addEventListener('click', async () => {
        if (confirm('Supprimer cet envoi de la tablette ?')) await deletePost(session.fid, post);
      });
      li.append(del);
    }
    feed.append(li);
  }
}

// ---------- Réglages ----------

function inviteLink() {
  return `${location.origin}/?code=${formatCode(session.family.code)}`;
}

function renderSettings() {
  $('settings-code').textContent = formatCode(session.family.code);
}

$('btn-settings').addEventListener('click', () => {
  renderSettings();
  show('view-settings');
});

$('btn-back').addEventListener('click', () => show('view-app'));

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
  stopFeed?.();
  stopMembers?.();
  stopAgenda();
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

$('tile-call').addEventListener('click', async () => {
  if (currentCall) return;
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
        setTimeout(() => { if (!currentCall) $('call').hidden = true; }, 2000);
      },
    });
  } catch (err) {
    console.error(err);
    currentCall = null;
    setCallStatus("Impossible d'accéder à la caméra ou au micro. Autorisez-les dans les réglages du navigateur.");
    setTimeout(() => { if (!currentCall) $('call').hidden = true; }, 4000);
  }
});

$('call-hangup').addEventListener('click', () => {
  if (currentCall) currentCall.hangup();
  else $('call').hidden = true;
});

function renderMembers(members) {
  tabletMembers = members.filter((m) => m.role === 'tablette');
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
    li.textContent = m.role === 'tablette' ? `📺 Tablette de ${session.family.name}` : `👤 ${m.name}`;
    list.append(li);
  }
}

// ---------- Ajouter à l'écran d'accueil ----------

let installPrompt = null;
const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Chrome Android propose l'installation : on garde l'invitation pour notre bouton.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});
window.addEventListener('appinstalled', () => { $('install-card').hidden = true; });

function renderInstallCard() {
  $('install-card').hidden = isInstalled();
}

$('btn-install').addEventListener('click', async () => {
  if (installPrompt) {
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null;
    if (outcome === 'accepted') $('install-card').hidden = true;
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

// ---------- Vidéo ----------

function clearVideo() {
  pendingVideo = null;
  $('video-preview').hidden = true;
  $('video-preview').removeAttribute('src');
  $('video-pickers').hidden = mode !== 'video';
  $('video-hint').hidden = mode !== 'video';
}

async function onVideoChosen(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  setBusy('Préparation…');
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
      return;
    }
    pendingVideo = { base64, mime: result.mime, thumb: result.thumb, duration: result.duration };
    $('video-preview').src = URL.createObjectURL(result.blob);
    $('video-preview').hidden = false;
    $('video-pickers').hidden = true;
    $('video-hint').hidden = true;
    setStatus('');
  } catch (err) {
    console.error(err);
    setStatus("Cette vidéo n'a pas pu être préparée.");
  } finally {
    setBusy('');
  }
}

$('video-from-camera').addEventListener('click', () => $('post-video-camera').click());
$('video-from-gallery').addEventListener('click', () => $('post-video-gallery').click());
$('post-video-camera').addEventListener('change', onVideoChosen);
$('post-video-gallery').addEventListener('change', onVideoChosen);

// ---------- Photo en grand ----------

async function openPhoto(post) {
  $('lightbox').hidden = false;
  $('lightbox-img').src = post.thumb || post.image;
  try {
    const src = await loadMedia(session.fid, post, 'image');
    if (src && !$('lightbox').hidden) $('lightbox-img').src = src;
  } catch (err) {
    console.error(err);
  }
}

$('lightbox').addEventListener('click', () => { $('lightbox').hidden = true; });

// ---------- Message vocal ----------

const MAX_VOICE_S = 120;
let recorder = null;
let recordTimer = null;

function pickMime() {
  // AAC (mp4) se lit partout, y compris sur les tablettes anciennes ; sinon WebM/Opus.
  for (const m of ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

// Les tablettes anciennes (Android 4.4) ne lisent ni le WebM ni le MP4 des navigateurs :
// on convertit l'enregistrement en MP3 mono 16 kHz, lisible partout.
let lameLoading = null;
function loadLame() {
  if (window.lamejs) return Promise.resolve();
  lameLoading = lameLoading || new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/lame.min.js';
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
  return lameLoading;
}

async function toMp3(blob) {
  const RATE = 16000;
  await loadLame();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * RATE), RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const mono = (await offline.startRendering()).getChannelData(0);
  const pcm = new Int16Array(mono.length);
  for (let i = 0; i < mono.length; i++) pcm[i] = Math.max(-1, Math.min(1, mono[i])) * 0x7fff;
  const encoder = new window.lamejs.Mp3Encoder(1, RATE, 32);
  const parts = [];
  for (let i = 0; i < pcm.length; i += 1152) {
    const out = encoder.encodeBuffer(pcm.subarray(i, i + 1152));
    if (out.length) parts.push(new Uint8Array(out));
  }
  const end = encoder.flush();
  if (end.length) parts.push(new Uint8Array(end));
  return new Blob(parts, { type: 'audio/mpeg' });
}

function clearVoice() {
  pendingVoice = null;
  $('voice-preview').hidden = true;
  $('voice-recorder').hidden = mode !== 'voice';
  $('voice-audio').removeAttribute('src');
}

$('voice-remove').addEventListener('click', clearVoice);

$('btn-voice').addEventListener('click', async () => {
  if (recorder) { recorder.stop(); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    setStatus("Impossible d'accéder au micro. Autorisez-le dans les réglages du navigateur.");
    return;
  }
  const mimeType = pickMime();
  recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32000 } : undefined);
  const chunks = [];
  const started = Date.now();
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    clearInterval(recordTimer);
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
    const duration = Math.round((Date.now() - started) / 1000);
    recorder = null;
    $('btn-voice').textContent = '🎤';
    $('btn-voice').classList.remove('recording');
    $('voice-hint').textContent = 'Touchez pour enregistrer (2 minutes maximum)';
    setStatus('Préparation du vocal…');
    let mp3;
    try {
      mp3 = await toMp3(blob);
    } catch (err) {
      console.error(err);
      setStatus("Le vocal n'a pas pu être préparé. Réessayez.");
      return;
    }
    setStatus('');
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result.length > 950_000) {
        setStatus('Le message vocal est trop long. Gardez-le sous 2 minutes.');
        return;
      }
      pendingVoice = { dataUrl: reader.result, duration };
      $('voice-audio').src = reader.result;
      $('voice-preview').hidden = false;
      $('voice-recorder').hidden = true;
    };
    reader.readAsDataURL(mp3);
  };
  recorder.start();
  $('btn-voice').textContent = '⏹';
  $('btn-voice').classList.add('recording');
  $('voice-hint').textContent = 'Touchez pour arrêter';
  const tick = () => {
    const s = Math.round((Date.now() - started) / 1000);
    setStatus(`🔴 Enregistrement… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} (touchez Arrêter pour finir)`);
    if (s >= MAX_VOICE_S && recorder) recorder.stop();
  };
  tick();
  recordTimer = setInterval(tick, 500);
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
  if (!online) { el.hidden = true; return; }
  const name = session.family.name;
  const now = Date.now();
  const hour = new Date().getHours();
  el.hidden = false;
  el.classList.remove('warn');
  if (now - online > 45 * 60_000) {
    el.classList.add('warn');
    el.textContent = `⚠️ La tablette ne répond plus depuis ${ago(online).replace('il y a ', '')}. Est-elle branchée et connectée au wifi ?`;
  } else if (active && now - active > 12 * 3600_000 && hour >= 10 && hour < 21) {
    el.classList.add('warn');
    el.textContent = `⚠️ ${name} n'a pas touché la tablette depuis ${ago(active).replace('il y a ', '')}.`;
  } else {
    el.textContent = active
      ? `✅ Tablette en ligne. ${name} l'a utilisée ${ago(active)}.`
      : '✅ Tablette en ligne.';
  }
}

setInterval(() => { if (session) renderActivity(); }, 60_000);

// ---------- Onglets Messages / Agenda ----------

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('tab-messages').hidden = tab.dataset.tab !== 'messages';
    $('tab-agenda').hidden = tab.dataset.tab !== 'agenda';
  });
});

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
  $('post-text').placeholder = `Écrire un message à ${session.family.name}…`;
  stopFeed?.();
  stopMembers?.();
  stopFeed = watchPosts(session.fid, 30, renderFeed);
  stopMembers = watchMembers(session.fid, renderMembers);
  history.replaceState(null, '', location.pathname);
  startAgenda(session);
  renderInstallCard();
  show('view-app');
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

start();
