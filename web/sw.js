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
