// Préparation d'une vidéo avant envoi : réduite (640 px, 30 s au plus par défaut) et réencodée dans le
// navigateur, pour qu'elle soit légère et lisible par la tablette.

const MAX_SECONDS = 30;
const MAX_SIDE = 640;

function pickMime() {
  // WebM (VP8) d'abord : lisible même par les tablettes anciennes ; MP4 pour iPhone (Safari).
  const candidates = [
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
  ];
  return candidates.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

function waitFor(el, event) {
  return new Promise((resolve, reject) => {
    el.addEventListener(event, resolve, { once: true });
    el.addEventListener('error', reject, { once: true });
  });
}

/**
 * Renvoie { blob, mime, thumb, duration }. onProgress(secondes traitées, durée totale).
 * Le traitement se fait en temps réel : une vidéo de 20 s prend environ 20 s.
 */
export async function prepareVideo(file, onProgress, maxSeconds = MAX_SECONDS) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  await waitFor(video, 'loadedmetadata');

  // Certaines vidéos (WebM) n'indiquent pas leur durée : on mesure pendant la lecture.
  const duration = Number.isFinite(video.duration) ? Math.min(video.duration, maxSeconds) : maxSeconds;
  let played = 0;
  const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round((video.videoWidth * scale) / 2) * 2;
  canvas.height = Math.round((video.videoHeight * scale) / 2) * 2;
  const ctx = canvas.getContext('2d');

  // Aperçu pour le fil et la tablette.
  video.currentTime = Number.isFinite(video.duration) ? Math.min(0.5, duration / 2) : 0.1;
  await waitFor(video, 'seeked');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const thumb = canvas.toDataURL('image/jpeg', 0.7);
  video.currentTime = 0;
  await waitFor(video, 'seeked');

  // Image (canvas) + son (Web Audio, sans passer par le haut-parleur) -> enregistreur.
  const stream = canvas.captureStream(25);
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaElementSource(video);
  const dest = audioCtx.createMediaStreamDestination();
  source.connect(dest);
  dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));

  const mimeType = pickMime();
  const recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: 900_000,
    audioBitsPerSecond: 64_000,
  });
  const parts = [];
  recorder.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

  let done = false;
  const draw = () => {
    if (done) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    played = Math.max(played, video.currentTime);
    onProgress?.(Math.min(video.currentTime, duration), Number.isFinite(video.duration) ? duration : maxSeconds);
    if (video.currentTime >= duration || video.ended) {
      done = true;
      video.pause();
      recorder.stop();
      return;
    }
    // requestAnimationFrame s'arrête si la page passe en arrière-plan : on garde un minuteur.
    if (document.hidden) setTimeout(draw, 40); else requestAnimationFrame(draw);
  };

  recorder.start(500);
  await video.play();
  draw();
  await stopped;

  audioCtx.close();
  URL.revokeObjectURL(url);
  const mime = (recorder.mimeType || mimeType || 'video/webm').split(';')[0];
  return { blob: new Blob(parts, { type: mime }), mime, thumb, duration: Math.max(1, Math.round(Math.min(played, duration))) };
}
