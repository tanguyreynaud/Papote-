// Service worker minimal : nécessaire pour que Chrome Android propose l'installation.
// Il laisse passer toutes les requêtes vers le réseau (les données viennent de Firestore).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
