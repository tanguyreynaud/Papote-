// Filmer dans Papote (29/10, choix de Tanguy) : la caméra dans la page plutôt que l'appareil photo du
// téléphone, dont l'écran d'après-film (refaire / revoir / valider) n'était pas clair. La vidéo sort
// déjà légère (960 px, 1,1 Mbit/s) : pas de « Préparation de la vidéo… » après.

import { pickMime } from './video.js';

const MAX_SIDE = 960;
const $ = (id) => document.getElementById(id);

let flux = null;
let enregistreur = null;
let face = 'environment';
let minuteur = null;
let rendre = null; // ({ blob, mime, thumb, duration }) => void
let fini = null; // () => void : la caméra est fermée (vidéo ou non)
let maxSecondes = 60;
let jeter = false; // « Annuler » pendant le film : ce qui a été filmé n'est pas gardé

/** La caméra dans la page est possible dans ce navigateur. */
export const filmerPossible = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

/** La caméra est ouverte. */
export const filmerOuvert = () => !$('filmer').hidden;

function temps(s) {
  const n = Math.floor(s);
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

function afficherTemps(s) {
  $('filmer-temps').textContent = `${temps(s)} / ${temps(maxSecondes)}`;
}

function arreterFlux() {
  flux?.getTracks().forEach((t) => t.stop());
  flux = null;
  $('filmer-live').srcObject = null;
}

function etat(nom) {
  // nom : 'attente' (caméra qui s'ouvre), 'pret', 'film', 'erreur'
  $('filmer').dataset.etat = nom;
  $('filmer-rec').disabled = nom !== 'pret' && nom !== 'film';
  $('filmer-rec').setAttribute('aria-label', nom === 'film' ? 'Arrêter' : 'Filmer');
  $('filmer-rec-label').textContent = nom === 'film' ? 'Arrêter' : 'Filmer';
  $('filmer-tourner').disabled = nom !== 'pret';
  $('filmer-erreur').hidden = nom !== 'erreur';
}

async function ouvrirFlux() {
  arreterFlux();
  etat('attente');
  try {
    flux = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: face, width: { ideal: MAX_SIDE }, height: { ideal: 540 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    console.warn('Caméra indisponible', err);
    etat('erreur');
    return;
  }
  if (!filmerOuvert()) { arreterFlux(); return; }
  $('filmer-live').classList.toggle('miroir', face === 'user');
  $('filmer-live').srcObject = flux;
  $('filmer-live').play().catch(() => {});
  // « Filmer » seulement une fois l'image arrivée (sinon l'aperçu de la vidéo serait vide).
  const live = $('filmer-live');
  if (!live.videoWidth) await new Promise((r) => { live.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 3000); });
  if (!filmerOuvert() || live.srcObject !== flux) return;
  afficherTemps(0);
  etat('pret');
}

/**
 * Ouvre la caméra. onVideo reçoit { blob, mime, thumb, duration } quand on arrête de filmer ;
 * onFin est appelé quand la caméra se ferme, avec ou sans vidéo.
 */
export function ouvrirFilmer({ max = 60, onVideo, onFin } = {}) {
  maxSecondes = max;
  jeter = false;
  rendre = onVideo;
  fini = onFin;
  $('filmer').hidden = false;
  ouvrirFlux();
}

/** Ferme la caméra ; un film en cours est gardé (onVideo) avant la fermeture. */
export function fermerFilmer() {
  if (!filmerOuvert()) return;
  if (enregistreur && enregistreur.state !== 'inactive') {
    enregistreur.onstop = null;
    terminer(true);
  }
  clearInterval(minuteur);
  minuteur = null;
  arreterFlux();
  $('filmer').hidden = true;
  const f = fini;
  fini = null;
  f?.();
}

// Image d'aperçu (fil et tablette) : une image de la caméra, au plus 960 px.
function vignette() {
  const v = $('filmer-live');
  if (!v.videoWidth) return '';
  const k = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * k);
  c.height = Math.round(v.videoHeight * k);
  const g = c.getContext('2d');
  if (face === 'user') { g.translate(c.width, 0); g.scale(-1, 1); }
  g.drawImage(v, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

let morceaux = [];
let debut = 0;
let thumb = '';

function demarrer() {
  if (!flux) return;
  const mimeType = pickMime();
  try {
    enregistreur = new MediaRecorder(flux, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 1_100_000,
      audioBitsPerSecond: 64_000,
    });
  } catch (err) {
    console.warn('Enregistrement impossible', err);
    etat('erreur');
    return;
  }
  morceaux = [];
  thumb = vignette();
  enregistreur.ondataavailable = (e) => { if (e.data.size) morceaux.push(e.data); };
  enregistreur.onstop = () => terminer(false);
  enregistreur.start(500);
  debut = performance.now();
  etat('film');
  afficherTemps(0);
  minuteur = setInterval(() => {
    const s = (performance.now() - debut) / 1000;
    afficherTemps(Math.min(s, maxSecondes));
    // Une image un peu après le début : la première est souvent sombre (caméra qui s'ajuste).
    if (s > 0.6 && s < 1) thumb = vignette() || thumb;
    if (s >= maxSecondes) arreter();
  }, 200);
}

function arreter() {
  clearInterval(minuteur);
  minuteur = null;
  if (enregistreur && enregistreur.state !== 'inactive') enregistreur.stop();
}

// Le film est fini : la vidéo part vers l'aperçu (onVideo), puis la caméra se ferme (sauf si c'est déjà fait).
function terminer(enFermant) {
  const rec = enregistreur;
  enregistreur = null;
  clearInterval(minuteur);
  minuteur = null;
  const duree = Math.max(1, Math.round(Math.min((performance.now() - debut) / 1000, maxSecondes)));
  const mime = (rec.mimeType || 'video/webm').split(';')[0];
  const remettre = (parts) => {
    const blob = new Blob(parts, { type: mime });
    if (blob.size && !jeter) rendre?.({ blob, mime, thumb, duration: duree });
  };
  if (enFermant) {
    // Fermeture pendant le film (appel qui arrive, app quittée…) : on garde ce qui a été filmé.
    const parts = morceaux;
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    rec.onstop = () => remettre(parts);
    rec.stop();
    return;
  }
  remettre(morceaux);
  if (filmerOuvert()) history.back();
}

$('filmer-rec').addEventListener('click', () => {
  if (enregistreur) arreter(); else demarrer();
});
$('filmer-tourner').addEventListener('click', () => {
  face = face === 'environment' ? 'user' : 'environment';
  ouvrirFlux();
});
$('filmer-annuler').addEventListener('click', () => {
  jeter = true;
  history.back();
});
$('filmer-reessayer').addEventListener('click', () => ouvrirFlux());
// Papote passe derrière (écran éteint, autre app) : on arrête de filmer et on garde la vidéo.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && enregistreur) arreter();
});
