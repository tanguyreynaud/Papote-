const test = require('node:test');
const assert = require('node:assert');
const { familleDuFichier, depasse, envoiEnTrop } = require('./quota');

test('seuls les fichiers des familles sont comptés', () => {
  assert.strictEqual(familleDuFichier('families/abc/media/x.jpg'), 'abc');
  assert.strictEqual(familleDuFichier('families/abc/autre/x.jpg'), null);
  assert.strictEqual(familleDuFichier('families/abc/media/sous/x.jpg'), null);
  assert.strictEqual(familleDuFichier(undefined), null);
});

test('plafond : 2 Go ou 1 500 fichiers', () => {
  assert.strictEqual(depasse({ octets: 800 * 1024 ** 2, fichiers: 1100 }), false);
  assert.strictEqual(depasse({ octets: 2 * 1024 ** 3 + 1, fichiers: 10 }), true);
  assert.strictEqual(depasse({ octets: 10, fichiers: 1501 }), true);
});

test('envois : 300 photos et 60 vidéos au plus, messages libres', () => {
  assert.strictEqual(envoiEnTrop('photo', 300), false);
  assert.strictEqual(envoiEnTrop('photo', 301), true);
  assert.strictEqual(envoiEnTrop('video', 61), true);
  assert.strictEqual(envoiEnTrop('message', 5000), false);
});
