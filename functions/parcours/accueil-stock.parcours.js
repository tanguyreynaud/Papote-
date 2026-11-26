// Page d'accueil (Tanguy, 17/11 : « les boutons Commander et Être prévenu doivent apparaître en même temps que le
// reste ») : la fonction accueil écrit l'état du stock dans la page, gardée 10 minutes (Tanguy, 20/11).

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher } = require('./commun');

brancher();

test('accueil : plus de tablette → la page arrive déjà en « complet » ; une tablette au stock → « ok »', async () => {
  const vide = await s.requete('accueil');
  assert.strictEqual(vide.statut, 200);
  assert.match(vide.texte, /<html lang="fr" data-stock="complet">/);
  assert.strictEqual(vide.entetes['cache-control'], 'public, max-age=600, s-maxage=600', 'gardée 10 minutes');
  await a.tablettePreparee();
  const plein = await s.requete('accueil');
  assert.match(plein.texte, /<html lang="fr" data-stock="ok">/);
  assert.strictEqual((await s.requete('stockDisponible')).json.disponible, true, 'la page et /api/stock disent la même chose');
});

test('tablette ajoutée au stock : pas vendue par le site tant qu\'elle n\'est pas mise en vente (Tanguy, 25/11)', async () => {
  await s.appeler('gestionStock', { action: 'ajouter', quantite: 1, prixAchat: 12000, modele: 'Blackview Tab 60 Pro', fournisseur: 'Cdiscount' }, a.TANGUY);
  const fiche = (await s.db.collection('stock').where('enVente', '==', false).get()).docs[0];
  assert.ok(fiche, 'la fiche naît « pas en vente »');
  assert.strictEqual((await s.requete('stockDisponible')).json.disponible, false, 'le site ne la compte pas');
  const modifier = (champs) => s.appeler('gestionStock', { action: 'modifier', id: fiche.id, champs }, a.TANGUY);
  await modifier({ enVente: true });
  assert.strictEqual((await s.lire(`stock/${fiche.id}`)).historique.at(-1).motif, 'mise en vente');
  assert.strictEqual((await s.requete('stockDisponible')).json.disponible, true, 'mise en vente : le site la vend');
  await modifier({ enVente: false });
  assert.strictEqual((await s.requete('stockDisponible')).json.disponible, false, 'retirée de la vente');
  await modifier({ etat: 'a-reparer' });
  await assert.rejects(modifier({ enVente: true }), /en stock ou préparée/);
});
