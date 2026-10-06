// App famille : envoyer photos et messages vers la tablette.
import {
  loadMembership, createFamily, joinFamily, leaveFamily, watchPosts, watchMembers,
  addPost, deletePost, formatCode, normalizeCode, toDate, CodeInconnuError,
} from './firebase.js';
import { startCall } from './appel.js';

const $ = (id) => document.getElementById(id);
const MAX_IMAGE_CHARS = 900_000; // un document Firestore est limité à 1 Mo

let session = null; // { fid, family, member, uid }
let pendingPhotos = []; // data URLs prêtes à envoyer
let stopFeed = null;
let stopMembers = null;

function show(view) {
  for (const id of ['loading', 'view-join', 'view-app', 'view-settings']) {
    $(id).hidden = id !== view;
  }
  $('btn-settings').hidden = view !== 'view-app';
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

async function compressPhoto(file) {
  const img = await loadImage(file);
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
  pendingPhotos.forEach((src, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'preview';
    const img = document.createElement('img');
    img.src = src;
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
$('btn-photo').addEventListener('click', () => { $('photo-menu').hidden = !$('photo-menu').hidden; });
$('photo-from-camera').addEventListener('click', () => { $('photo-menu').hidden = true; $('post-camera').click(); });
$('photo-from-gallery').addEventListener('click', () => { $('photo-menu').hidden = true; $('post-photos').click(); });

// Bouton « Envoyer » transformé en indicateur de chargement pendant l'envoi.
function setBusy(label) {
  const btn = $('btn-send');
  btn.disabled = !!label;
  $('post-text').disabled = !!label;
  $('post-photos').disabled = !!label;
  $('post-camera').disabled = !!label;
  $('btn-photo').disabled = !!label;
  if (label) $('photo-menu').hidden = true;
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
  if (!text && !pendingPhotos.length) return;
  setBusy('Envoi…');
  const author = { authorUid: session.uid, authorName: session.member.name };
  try {
    if (pendingPhotos.length) {
      for (let i = 0; i < pendingPhotos.length; i++) {
        setBusy(pendingPhotos.length > 1 ? `Photo ${i + 1} sur ${pendingPhotos.length}…` : 'Envoi…');
        // Le texte accompagne la première photo.
        await addPost(session.fid, {
          type: 'photo', text: i === 0 ? text : '', image: pendingPhotos[i], ...author,
        });
      }
    } else {
      await addPost(session.fid, { type: 'message', text, ...author });
    }
    pendingPhotos = [];
    renderPreviews();
    $('post-text').value = '';
    setStatus('Envoyé ✓');
    setTimeout(() => setStatus(''), 2500);
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
    li.className = 'card post';
    if (post.image) {
      const img = document.createElement('img');
      img.src = post.image;
      img.alt = '';
      img.loading = 'lazy';
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
        if (confirm('Supprimer cet envoi de la tablette ?')) await deletePost(session.fid, post.id);
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

$('btn-call').addEventListener('click', async () => {
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
  // Le bouton d'appel n'apparaît que si une tablette sait recevoir les appels (Android 5 et plus).
  const canCall = members.some((m) => m.role === 'tablette' && m.canCall);
  $('btn-call').hidden = !canCall || !navigator.mediaDevices;
  $('btn-call').textContent = `📞 Appeler ${session.family.name} en vidéo`;
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
  renderInstallCard();
  show('view-app');
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

start();
