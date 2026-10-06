// Écran de la tablette : horloge, date, météo, photos et messages de la famille.
import {
  loadMembership, joinFamily, watchPosts, markSeen, sendHeart, toDate, CodeInconnuError,
} from './firebase.js';

const $ = (id) => document.getElementById(id);

// Saint-Martin-de-Valamas (Ardèche). Modifiable par ?lat=..&lon=.. dans l'adresse.
const params = new URLSearchParams(location.search);
const LAT = Number(params.get('lat')) || 44.9372;
const LON = Number(params.get('lon')) || 4.3687;

const IDLE_MS = 90_000; // retour à l'accueil après 1 min 30 sans toucher l'écran
const FRAME_MS = 12_000; // changement de photo sur l'accueil
const WEATHER_MS = 30 * 60_000;

let session = null;
let posts = [];
let photos = [];
let photoIndex = 0;
let frameIndex = 0;
let overlayQueue = [];
let overlayPost = null;
let shownInOverlay = new Set();
let idleTimer = null;

// ---------- Navigation ----------

function show(view) {
  for (const id of ['view-home', 'view-photos', 'view-messages', 'view-setup']) {
    $(id).hidden = id !== view;
  }
  resetIdle();
}

function resetIdle() {
  clearTimeout(idleTimer);
  if ($('view-home').hidden && $('view-setup').hidden) {
    idleTimer = setTimeout(() => show('view-home'), IDLE_MS);
  }
}

document.addEventListener('pointerdown', resetIdle, { passive: true });
document.querySelectorAll('[data-home]').forEach((b) => b.addEventListener('click', () => show('view-home')));
$('btn-photos').addEventListener('click', () => openPhotos(0));
$('home-frame').addEventListener('click', () => openPhotos(frameIndex));
$('btn-messages').addEventListener('click', () => { renderMessages(); show('view-messages'); });

// ---------- Horloge, date, mode nuit ----------

const fmtTime = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const fmtDate = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function greetingFor(hour) {
  if (hour < 6 || hour >= 22) return 'Bonne nuit';
  if (hour < 12) return 'Bonjour';
  if (hour < 18) return 'Bon après-midi';
  return 'Bonsoir';
}

function tick() {
  const now = new Date();
  const time = fmtTime.format(now);
  $('clock').textContent = time;
  $('setup-clock').textContent = time;
  $('date').textContent = capitalize(fmtDate.format(now));
  const name = session?.family?.name;
  $('greeting').textContent = name ? `${greetingFor(now.getHours())} ${name}` : greetingFor(now.getHours());
  const hour = now.getHours();
  document.body.classList.toggle('night', hour >= 21 || hour < 7);
}

tick();
setInterval(tick, 1000);

// ---------- Météo (Open-Meteo, gratuit et sans clé) ----------

const WEATHER_CODES = {
  0: ['☀️', 'Grand soleil'],
  1: ['🌤️', 'Plutôt ensoleillé'],
  2: ['⛅', 'Quelques nuages'],
  3: ['☁️', 'Couvert'],
  45: ['🌫️', 'Brouillard'],
  48: ['🌫️', 'Brouillard givrant'],
  51: ['🌦️', 'Bruine légère'],
  53: ['🌦️', 'Bruine'],
  55: ['🌧️', 'Forte bruine'],
  56: ['🌧️', 'Bruine verglaçante'],
  57: ['🌧️', 'Bruine verglaçante'],
  61: ['🌦️', 'Petite pluie'],
  63: ['🌧️', 'Pluie'],
  65: ['🌧️', 'Forte pluie'],
  66: ['🌧️', 'Pluie verglaçante'],
  67: ['🌧️', 'Pluie verglaçante'],
  71: ['🌨️', 'Un peu de neige'],
  73: ['🌨️', 'Neige'],
  75: ['❄️', 'Forte neige'],
  77: ['🌨️', 'Grains de neige'],
  80: ['🌦️', 'Averses'],
  81: ['🌧️', 'Averses'],
  82: ['⛈️', 'Fortes averses'],
  85: ['🌨️', 'Averses de neige'],
  86: ['❄️', 'Fortes averses de neige'],
  95: ['⛈️', 'Orage'],
  96: ['⛈️', 'Orage avec grêle'],
  99: ['⛈️', 'Orage avec grêle'],
};

function describe(code, isDay = 1) {
  const [icon, label] = WEATHER_CODES[code] || ['🌡️', ''];
  if (!isDay && code <= 1) return ['🌙', code === 0 ? 'Ciel dégagé' : 'Peu nuageux'];
  return [icon, label];
}

async function refreshWeather() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}`
    + '&current=temperature_2m,weather_code,is_day'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min'
    + '&timezone=Europe%2FParis&forecast_days=2';
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    const [icon, label] = describe(data.current.weather_code, data.current.is_day);
    $('weather-icon').textContent = icon;
    $('weather-temp').textContent = `${Math.round(data.current.temperature_2m)}°`;
    $('weather-label').textContent = label;
    $('weather-minmax').textContent = `Aujourd'hui : de ${Math.round(data.daily.temperature_2m_min[0])}° à ${Math.round(data.daily.temperature_2m_max[0])}°`;
    const [tIcon, tLabel] = describe(data.daily.weather_code[1]);
    $('weather-tomorrow').textContent = `Demain : ${tIcon} ${tLabel.toLowerCase()}, ${Math.round(data.daily.temperature_2m_max[1])}°`;
    $('weather').hidden = false;
  } catch (e) {
    console.warn('Météo indisponible', e);
  }
}

refreshWeather();
setInterval(refreshWeather, WEATHER_MS);

// ---------- Son de notification ----------

let audioCtx = null;
function chime() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
    const t = audioCtx.currentTime;
    [[784, 0], [1047, 0.18]].forEach(([freq, delay]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.4, t + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.8);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 0.9);
    });
  } catch (e) { /* pas de son disponible */ }
}

// ---------- Textes ----------

function whenLabel(date) {
  if (!date) return '';
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const hm = fmtTime.format(date);
  if (date.toDateString() === now.toDateString()) return `aujourd'hui à ${hm}`;
  if (date.toDateString() === yesterday.toDateString()) return `hier à ${hm}`;
  return `le ${date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}`;
}

// ---------- Accueil : cadre photo ----------

function renderFrame() {
  const has = photos.length > 0;
  $('frame-img').hidden = !has;
  $('frame-caption').hidden = !has;
  $('frame-empty').hidden = has;
  if (!has) return;
  frameIndex %= photos.length;
  const p = photos[frameIndex];
  $('frame-img').src = p.image;
  $('frame-caption').textContent = `De ${p.authorName}`;
}

setInterval(() => {
  if (!photos.length || $('view-home').hidden) return;
  // On fait tourner les 20 photos les plus récentes.
  frameIndex = (frameIndex + 1) % Math.min(photos.length, 20);
  renderFrame();
}, FRAME_MS);

function renderBadges() {
  const unseenPhotos = posts.filter((p) => p.type === 'photo' && !p.seenAt).length;
  const unseenMessages = posts.filter((p) => p.text && !p.seenAt).length;
  setBadge('badge-photos', unseenPhotos);
  setBadge('badge-messages', unseenMessages);
}

function setBadge(id, n) {
  $(id).hidden = n === 0;
  $(id).textContent = n > 9 ? '9+' : String(n);
}

// ---------- Photos ----------

function openPhotos(index) {
  if (!photos.length) return;
  photoIndex = Math.max(0, Math.min(index, photos.length - 1));
  renderPhoto();
  show('view-photos');
}

function renderPhoto() {
  const p = photos[photoIndex];
  if (!p) return;
  $('photo-img').src = p.image;
  const caption = `${p.authorName}, ${whenLabel(toDate(p.createdAt))}`;
  $('photo-caption').textContent = p.text ? `« ${p.text} » ${caption}` : caption;
  $('photo-prev').disabled = photoIndex >= photos.length - 1;
  $('photo-next').disabled = photoIndex === 0;
  if (!p.seenAt) markSeen(session.fid, p.id).catch(() => {});
}

// La plus récente est à l'index 0 : « suivante » remonte vers les plus récentes.
$('photo-prev').addEventListener('click', () => { photoIndex = Math.min(photoIndex + 1, photos.length - 1); renderPhoto(); });
$('photo-next').addEventListener('click', () => { photoIndex = Math.max(photoIndex - 1, 0); renderPhoto(); });
$('photo-heart').addEventListener('click', () => heart(photos[photoIndex], $('photo-heart')));

let swipeX = null;
$('photo-img').addEventListener('pointerdown', (e) => { swipeX = e.clientX; });
$('photo-img').addEventListener('pointerup', (e) => {
  if (swipeX === null) return;
  const dx = e.clientX - swipeX;
  swipeX = null;
  if (Math.abs(dx) < 60) return;
  (dx > 0 ? $('photo-prev') : $('photo-next')).click();
});

function heart(post, button) {
  if (!post) return;
  sendHeart(session.fid, post.id).catch(() => {});
  button.textContent = '❤️ Envoyé !';
  button.disabled = true;
  setTimeout(() => {
    button.textContent = button === $('photo-heart') ? '❤️ Bisou' : '❤️ Envoyer un bisou';
    button.disabled = false;
  }, 2500);
}

// ---------- Messages ----------

function renderMessages() {
  const list = $('message-list');
  list.replaceChildren();
  const withText = posts.filter((p) => p.text);
  $('message-empty').hidden = withText.length > 0;
  for (const p of withText) {
    const li = document.createElement('li');
    li.className = p.seenAt ? 'message' : 'message unseen';
    const head = document.createElement('p');
    head.className = 'message-head';
    head.textContent = `${p.authorName}, ${whenLabel(toDate(p.createdAt))}`;
    const body = document.createElement('p');
    body.className = 'message-body';
    body.textContent = p.text;
    li.append(head, body);
    if (p.image) {
      const img = document.createElement('img');
      img.src = p.image;
      img.alt = '';
      img.loading = 'lazy';
      li.append(img);
    }
    list.append(li);
    if (!p.seenAt) markSeen(session.fid, p.id).catch(() => {});
  }
}

// ---------- Fenêtre « nouveau » ----------

function queueUnseen() {
  for (const p of [...posts].reverse()) {
    if (!p.seenAt && !shownInOverlay.has(p.id)) {
      shownInOverlay.add(p.id);
      overlayQueue.push(p);
    }
  }
  if (!overlayPost) nextOverlay();
}

function nextOverlay() {
  overlayPost = overlayQueue.shift() || null;
  if (!overlayPost) {
    $('overlay').hidden = true;
    return;
  }
  const p = overlayPost;
  $('overlay-title').textContent = p.type === 'photo'
    ? `Nouvelle photo de ${p.authorName}`
    : `Message de ${p.authorName}`;
  $('overlay-img').hidden = !p.image;
  if (p.image) $('overlay-img').src = p.image;
  $('overlay-text').hidden = !p.text;
  $('overlay-text').textContent = p.text || '';
  $('overlay-heart').disabled = false;
  $('overlay-heart').textContent = '❤️ Envoyer un bisou';
  $('overlay').hidden = false;
  chime();
}

$('overlay-close').addEventListener('click', () => {
  if (overlayPost) markSeen(session.fid, overlayPost.id).catch(() => {});
  nextOverlay();
});
$('overlay-heart').addEventListener('click', () => {
  if (!overlayPost) return;
  heart(overlayPost, $('overlay-heart'));
  setTimeout(nextOverlay, 1200);
});

// ---------- Données ----------

function onPosts(list) {
  posts = list;
  photos = posts.filter((p) => p.image);
  renderFrame();
  renderBadges();
  if (!$('view-messages').hidden) renderMessages();
  if (!$('view-photos').hidden) {
    photoIndex = Math.min(photoIndex, Math.max(photos.length - 1, 0));
    if (photos.length) renderPhoto(); else show('view-home');
  }
  queueUnseen();
}

async function start() {
  session = await loadMembership();
  const code = params.get('code');
  if (!session && code) {
    try {
      await joinFamily(code, 'Tablette', 'tablette');
      session = await loadMembership();
    } catch (e) {
      console.error(e);
      $('setup-detail').textContent = e instanceof CodeInconnuError
        ? `Le code famille « ${code} » est inconnu.`
        : 'Pas de connexion internet. Nouvel essai dans une minute.';
      show('view-setup');
      setTimeout(start, 60_000);
      return;
    }
  }
  if (!session) {
    $('setup-detail').textContent = 'Relancez le script d\'installation avec le code famille.';
    show('view-setup');
    return;
  }
  // Retire le code de l'adresse pour qu'un rechargement n'essaie pas de rejoindre à nouveau.
  if (code) {
    params.delete('code');
    history.replaceState(null, '', `${location.pathname}${params.toString() ? `?${params}` : ''}`);
  }
  tick();
  show('view-home');
  watchPosts(session.fid, 60, onPosts);
}

start();
