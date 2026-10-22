// Service worker : nécessaire pour que Chrome Android propose l'installation.
// Il garde une copie de l'interface (pages, styles, scripts, Firebase, polices) pour que l'app
// s'ouvre même sans réseau et affiche son message « Pas de connexion » au lieu de la page
// d'erreur du navigateur. Réseau d'abord : en ligne, on sert toujours la dernière version.
// Les données (Firestore, photos) ne passent pas par ici.
// « Partager vers Papote » : les photos ou la vidéo partagées sont gardées dans un cache,
// puis l'app s'ouvre avec ?partage=1 pour les envoyer.
const CACHE = 'papote-app-1';
const FIREBASE = 'https://www.gstatic.com/firebasejs/12.19.0/';
const PRECACHE = [
  '/', 'manifest.webmanifest', 'css/famille.css', 'icons/icon.svg', 'icons/icon-192.png',
  'js/famille.js', 'js/firebase.js', 'js/ui.js', 'js/dialogue.js', 'js/guide.js', 'js/appel.js',
  'js/push.js', 'js/video.js', 'js/agenda.js', 'js/abonnement.js', 'js/compte.js', 'js/notifs.js',
  'js/parcours.js', 'js/sim.js', 'js/gestion-api.js', 'vendor/qrcode.js',
  ...['app', 'app-check', 'auth', 'firestore', 'functions', 'messaging', 'storage']
    .map((m) => `${FIREBASE}firebase-${m}.js`),
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // Chaque fichier à part : un fichier manquant ne doit pas empêcher l'installation.
  event.waitUntil(caches.open(CACHE).then((cache) =>
    Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})))));
});
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  const noms = await caches.keys();
  await Promise.all(noms.filter((n) => n.startsWith('papote-app-') && n !== CACHE).map((n) => caches.delete(n)));
  await self.clients.claim();
})()));

// Réseau d'abord, copie gardée en secours. Pour l'ouverture de l'app (navigation), si le
// réseau traîne plus de 6 s on sert la copie : l'app vérifie ensuite la connexion elle-même.
async function reseauDabord(request, cle, attente) {
  const cache = await caches.open(CACHE);
  const reseau = fetch(request).then((rep) => {
    if (rep.ok || rep.type === 'opaque') cache.put(cle, rep.clone()).catch(() => {});
    return rep;
  });
  const copie = () => cache.match(cle, { ignoreSearch: true });
  if (attente) {
    const viteFait = new Promise((ok) => setTimeout(ok, attente)).then(copie);
    const premier = await Promise.race([reseau.catch(() => null), viteFait]);
    if (premier) return premier;
  }
  try {
    return await reseau;
  } catch (e) {
    const garde = await copie();
    if (garde) return garde;
    if (request.mode === 'navigate') return pageHorsLigne();
    throw e;
  }
}

// Fichiers qui ne changent jamais (Firebase versionné, polices) : la copie suffit.
async function copieDabord(request) {
  const garde = await caches.match(request);
  if (garde) return garde;
  const rep = await fetch(request);
  if (rep.ok || rep.type === 'opaque') {
    const cache = await caches.open(CACHE);
    cache.put(request, rep.clone()).catch(() => {});
  }
  return rep;
}

// Page jamais ouverte en ligne (rare) : un message simple plutôt que l'erreur du navigateur.
function pageHorsLigne() {
  return new Response(`<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Papote</title>
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
gap:12px;padding:24px;box-sizing:border-box;background:#fdfaf5;color:#24212f;font:18px/1.45 system-ui,sans-serif;text-align:center}
h1{margin:0;font-size:24px}p{margin:0;max-width:22em;color:#5f5a6b}</style></head><body>
<h1>Pas de connexion internet</h1><p>Papote s'ouvrira dès que la connexion reviendra.</p>
<script>addEventListener('online',()=>location.reload());setInterval(()=>{if(navigator.onLine)location.reload()},10000)</script>
</body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function receiveShare(request) {
  const form = await request.formData();
  const files = form.getAll('media').filter((f) => f && f.size);
  const text = [form.get('title'), form.get('text')].filter(Boolean).join(' ');
  await caches.delete('papote-partage');
  const cache = await caches.open('papote-partage');
  await Promise.all(files.map((f, i) => cache.put(`/partage/${i}`, new Response(f, {
    headers: { 'Content-Type': f.type, 'X-Name': encodeURIComponent(f.name || '') },
  }))));
  await cache.put('/partage/meta', new Response(JSON.stringify({ count: files.length, text })));
  return Response.redirect('/?partage=1', 303);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/partage') {
    event.respondWith(receiveShare(event.request));
    return;
  }
  if (event.request.method !== 'GET') return;
  if (url.origin === self.location.origin) {
    // /__/ : connexion Google et réglages Firebase ; ?verif= : test de connexion de l'app.
    if (url.pathname.startsWith('/__/') || url.searchParams.has('verif')) return;
    const nav = event.request.mode === 'navigate';
    const cle = url.origin + (url.pathname === '/index.html' ? '/' : url.pathname);
    event.respondWith(reseauDabord(event.request, cle, nav ? 6000 : 0));
  } else if (url.href.startsWith(FIREBASE) || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(copieDabord(event.request));
  } else if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(reseauDabord(event.request, event.request.url, 0));
  }
});

// Notifications push (voir js/push.js et la fonction serveur appelsPush) :
//   { type: 'appel', cid, nom }  la tablette appelle : notification qui sonne, « Répondre »
//   { type: 'manque', cid, nom } personne n'a répondu : la sonnerie devient « Appel manqué »
self.addEventListener('push', (event) => {
  let data = {};
  try { data = (event.data && event.data.json()) || {}; } catch (e) { /* message illisible */ }
  data = data.data || data;
  const nom = data.nom || 'Mamie';
  const tag = `appel-${data.cid || ''}`;
  let shown;
  if (data.type === 'appel') {
    shown = self.registration.showNotification(`${nom} vous appelle`, {
      body: 'Touchez pour répondre',
      tag,
      renotify: true,
      requireInteraction: true,
      // Le plus long qu'Android accepte ; le serveur renvoie l'appel toutes les 12 s tant qu'il
      // sonne, et renotify refait sonner et vibrer le téléphone à chaque fois.
      vibrate: [1000, 500, 1000, 500, 1000, 500, 1000, 500, 1000],
      silent: false,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      actions: [{ action: 'repondre', title: 'Répondre' }],
      data: { url: `/?appel=${encodeURIComponent(data.cid || '')}` },
    });
  } else if (data.type === 'manque') {
    shown = self.registration.showNotification(`Appel manqué de ${nom}`, {
      body: 'Touchez pour la rappeler',
      tag,
      renotify: false,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      actions: [{ action: 'rappeler', title: 'Rappeler' }],
      // « Rappeler » ne vaut que 24 h ; après, la notification ouvre simplement l'app.
      data: { url: '/?rappeler=1', rappelJusqua: Date.now() + 24 * 3600_000 },
    });
  } else {
    // Alerte sur la tablette (débranchée, hors ligne…) : { type: 'alerte', titre, texte }.
    shown = self.registration.showNotification(data.titre || 'Papote', {
      body: data.texte || '',
      tag: data.type === 'alerte' ? 'alerte-tablette' : undefined,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { url: '/' },
    });
  }
  event.waitUntil(shown);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const info = event.notification.data || {};
  const perime = info.rappelJusqua && Date.now() > info.rappelJusqua;
  const url = new URL((!perime && info.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      open.postMessage({ type: 'appel-ouvert', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
