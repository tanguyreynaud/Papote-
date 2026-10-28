// Forfaits SIM prépayés (Lyca, 30 jours) : recharge notée depuis l'admin, rappel avant la fin, facture reçue
// rangée sur sa ligne.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const { brancher } = require('./commun');
const { regles: g } = require('../gestion');

brancher();

const TANGUY = { uid: 'tanguy-admin', email: 'tanguy@mapapote.fr', prenom: 'Tanguy', admin: true };

test('« J\'ai rechargé » : dépense reliée à la carte, fin du forfait 30 jours plus tard, rappel 3 jours avant', async () => {
  const { id } = await s.appeler('gestionSim', { action: 'ajouter', champs: {
    statut: 'active', operateur: 'Lyca', numero: '07 51 23 45 67', prix: 499, prochaineRecharge: Date.now() + 2 * s.JOUR,
  } }, TANGUY);
  const alertes = async () => g.alertesSim(await s.lire(`sims/${id}`), Date.now());
  assert.deepStrictEqual(await alertes(), ['à recharger dans 2 j']);

  const avant = Date.now();
  const r = await s.appeler('gestionSim', { action: 'recharger', id }, TANGUY);
  const depense = await s.lire(`depenses/${r.depense}`);
  assert.strictEqual(depense.sim, id);
  assert.strictEqual(depense.categorie, 'sim');
  assert.strictEqual(depense.montant, 499);
  assert.strictEqual(depense.libelle, 'Recharge du forfait Lyca 07 51 23 45 67');
  const ligne = await s.lire(`sims/${id}`);
  assert.ok(ligne.prochaineRecharge >= avant + 30 * s.JOUR && ligne.prochaineRecharge <= Date.now() + 30 * s.JOUR);
  assert.deepStrictEqual(await alertes(), [], 'plus de rappel après la recharge');
  const donnees = await s.appeler('gestionDonnees', {}, TANGUY);
  assert.strictEqual(donnees.depenses.find((d) => d.id === r.depense).sim, id, 'la page voit la recharge sur la carte');

  s.avancer(27.5);
  assert.deepStrictEqual(await alertes(), ['à recharger dans 3 j']);
  s.avancer(4);
  assert.deepStrictEqual(await alertes(), ['forfait fini : à recharger']);
});

test('facture de forfait reliée à la main depuis sa page : la fin du forfait suit', async () => {
  const { id } = await s.appeler('gestionSim', { action: 'ajouter', champs: { statut: 'active', operateur: 'Lyca', prix: 499 } }, TANGUY);
  const { id: dep } = await s.appeler('gestionDepense', {
    action: 'ajouter', categorie: 'sim', libelle: 'Lyca Pass', montant: 499, date: Date.now() - 5 * s.JOUR,
  }, TANGUY);
  await s.appeler('gestionDepense', { action: 'modifier', id: dep, champs: { sim: id } }, TANGUY);
  const ligne = await s.lire(`sims/${id}`);
  assert.ok(Math.abs(ligne.prochaineRecharge - (Date.now() + 25 * s.JOUR)) < 60000);
  await assert.rejects(s.appeler('gestionDepense', { action: 'modifier', id: dep, champs: { sim: 'inconnue' } }, TANGUY), /introuvable/);
});
