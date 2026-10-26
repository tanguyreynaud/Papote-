// Réglages communs à chaque fichier de scénarios : simulation démarrée une fois, remise à zéro avant
// chaque scénario, et aucune erreur tolérée à la fin (déclencheur, webhook ou logger.error).

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');

function brancher() {
  test.before(() => s.demarrer());
  test.after(() => s.arreter());
  test.beforeEach(() => s.remettreAZero());
  test.afterEach(async () => {
    await s.calme();
    assert.deepStrictEqual(s.erreurs, [], 'erreurs pendant le scénario');
  });
}

const mailsA = (email) => s.boite.filter((m) => m.a === email).map((m) => m.sujet);
const commande = (id) => s.lire(`commandes/${id}`);

module.exports = { brancher, mailsA, commande };
