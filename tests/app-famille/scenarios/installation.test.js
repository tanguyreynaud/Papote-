// Premier proche : connexion par e-mail, « Vos informations », puis sa famille avec la tablette.
// Commande du site : famille préparée dès le paiement, la tablette y entre seule, le proche donne le nom.
// L'installation pas à pas avec le code de la tablette n'existe plus dans l'appli (Tanguy 12/11, A29) : seul Papote
// relie une tablette ; les scénarios de mise-en-route.test.js vérifient qu'il n'en reste aucune trace.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

test('Connexion, vos informations et famille préparée à la commande : le nom, la tablette entrée seule, la première photo', async () => {
  const julie = await banc.telephone('Julie');
  await g.inscrire(julie, 'julie@exemple.fr', 'Julie');
  const tab = await g.tabletteAllumee({ commande: { email: 'julie@exemple.fr' } });
  const fid = await g.installer(julie, tab, { nom: 'Mamie Emma' });
  const famille = await g.lire(`families/${fid}`);
  assert.strictEqual(famille.name, 'Mamie Emma');
  assert.ok(!famille.nomAChoisir, 'nom donné');
  assert.strictEqual(famille.installation.etape, 'fini');
  assert.strictEqual(famille.installation.preparee, true);
  assert.strictEqual(famille.createdBy, (await g.liste(`families/${fid}/members`)).find((m) => m.email === 'julie@exemple.fr').id, 'celle qui a payé est responsable');
  const tablettes = (await g.liste(`families/${fid}/members`)).filter((m) => m.role === 'tablette');
  assert.strictEqual(tablettes.length, 2, 'la tablette est entrée (ses deux comptes)');
  assert.strictEqual(famille.abonnement.statut, 'actif', 'commande reliée');
  const posts = await g.liste(`families/${fid}/posts`);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].type, 'photo');
  assert.strictEqual(posts[0].text, 'Bonjour Mamie');
  assert.ok(posts[0].storagePath, 'photo rangée dans Storage');
});
