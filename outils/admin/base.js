// Base Firestore des outils d'administration. Tant que la migration Europe n'est pas faite, c'est la
// base « (default) » (US). À la bascule, le document config/base = { database: 'eu' } est écrit dans
// l'ancienne base : les outils (comme les tablettes) passent alors d'eux-mêmes sur la base « eu ».
// PAPOTE_BASE=eu (ou (default)) force une base, par exemple pour vérifier la copie avant la bascule.
const { getFirestore } = require('firebase-admin/firestore');

async function ouvrirBase(app) {
  let nom = process.env.PAPOTE_BASE;
  if (!nom) {
    const config = await getFirestore(app).doc('config/base').get();
    nom = (config.exists && config.get('database')) || '(default)';
  }
  return getFirestore(app, nom);
}

module.exports = { ouvrirBase };
