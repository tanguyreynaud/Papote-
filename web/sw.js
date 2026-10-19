// Service worker : nécessaire pour que Chrome Android propose l'installation.
// Il laisse passer toutes les requêtes vers le réseau (les données viennent de Firestore),
// sauf « Partager vers Papote » : les photos ou la vidéo partagées sont gardées dans un cache,
// puis l'app s'ouvre avec ?partage=1 pour les envoyer.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

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
      vibrate: [800, 400, 800, 400, 800, 400, 800],
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      actions: [{ action: 'repondre', title: 'Répondre' }],
      data: { url: `/?appel=${encodeURIComponent(data.cid || '')}` },
    });
  } else if (data.type === 'manque') {
    shown = self.registration.showNotification(`Appel manqué de ${nom}`, {
      body: 'Touchez pour ouvrir Papote',
      tag,
      renotify: false,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { url: '/' },
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
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
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
