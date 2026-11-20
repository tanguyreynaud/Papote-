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

test('envoi en trop : seuls les fichiers de cette famille sont effacés, jamais ceux d\'une autre', () => {
  const { fichiersDeLEnvoi } = require('./quota');
  const post = {
    storagePath: 'families/abc/media/a.mp4',
    photos: [{ storagePath: 'families/abc/media/b.jpg' }, { storagePath: 'families/autre/media/c.jpg' }, null, {}],
  };
  assert.deepStrictEqual([...fichiersDeLEnvoi(post, 'abc')].sort(), ['families/abc/media/a.mp4', 'families/abc/media/b.jpg']);
  // Un envoi qui ne nomme que les fichiers d'une autre famille, ou un chemin hors du dossier des envois : rien.
  assert.strictEqual(fichiersDeLEnvoi({ storagePath: 'families/autre/media/x.jpg' }, 'abc').size, 0);
  assert.strictEqual(fichiersDeLEnvoi({ storagePath: 'families/abc/declarations/x.jpg' }, 'abc').size, 0);
  assert.strictEqual(fichiersDeLEnvoi({ storagePath: '../families/abc/media/x.jpg' }, 'abc').size, 0);
  // Champs mal formés (écrits par une appli modifiée) : pas d'erreur, rien d'effacé.
  assert.strictEqual(fichiersDeLEnvoi({ photos: 'families/abc/media/x.jpg' }, 'abc').size, 0);
  assert.strictEqual(fichiersDeLEnvoi({ storagePath: 42 }, 'abc').size, 0);
  assert.strictEqual(fichiersDeLEnvoi({ storagePath: 'families/abc/media/a.jpg' }, '').size, 0);
});
