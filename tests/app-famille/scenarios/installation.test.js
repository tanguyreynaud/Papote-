// Premier proche : connexion par e-mail, « Vos informations », installation de la tablette pas à pas.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

test('Connexion, vos informations et installation complète de la tablette', async () => {
  const julie = await banc.telephone('Julie');
  await g.inscrire(julie, 'julie@exemple.fr', 'Julie');
  const tab = await g.tabletteAllumee({ commande: { email: 'julie@exemple.fr' } });
  const fid = await g.installer(julie, tab, { nom: 'Mamie Emma' });
  const famille = await g.lire(`families/${fid}`);
  assert.strictEqual(famille.name, 'Mamie Emma');
  assert.strictEqual(famille.installation.etape, 'fini');
  assert.strictEqual(famille.abonnement.statut, 'actif', 'commande reliée');
  const posts = await g.liste(`families/${fid}/posts`);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].type, 'photo');
  assert.strictEqual(posts[0].text, 'Bonjour Mamie');
  assert.ok(posts[0].storagePath, 'photo rangée dans Storage');
});
