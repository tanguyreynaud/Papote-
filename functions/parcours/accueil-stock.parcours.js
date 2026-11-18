// Page d'accueil (Tanguy, 17/11 : « les boutons Commander et Être prévenu doivent apparaître en même temps que le
// reste ») : la fonction accueil écrit l'état du stock dans la page, gardée 60 s comme /api/stock.

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
  assert.strictEqual(vide.entetes['cache-control'], 'public, max-age=60, s-maxage=60', 'même durée que /api/stock');
  await a.tablettePreparee();
  const plein = await s.requete('accueil');
  assert.match(plein.texte, /<html lang="fr" data-stock="ok">/);
  assert.strictEqual((await s.requete('stockDisponible')).json.disponible, true, 'la page et /api/stock disent la même chose');
});
