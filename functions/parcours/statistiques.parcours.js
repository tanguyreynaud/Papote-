// Statistiques du site (Tanguy, 17/11/2026 : « combien de personnes cliquent sur mon site vs le nombre de
// commandes, et où elles s'arrêtent ») : compteurs sans cookie du site, paiement et « Être prévenu » comptés par le
// serveur, page « Statistiques » de l'admin (gestionStatistiques).

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher } = require('./commun');
const { jourDeParis } = require('../statistiques');

brancher();

const jour = () => s.lire(`statistiques/${jourDeParis()}`);

test('un visiteur parcourt le site : visite avec provenance, chaque étape du tunnel, rien d\'autre gardé', async () => {
  const avant = (await jour()) || {};
  const etapes = ['accueil', 'commande', 'adresse', 'couverture-ok', 'relais', 'coordonnees', 'paiement'];
  assert.strictEqual((await s.requete('compter', { query: { e: 'visite', r: 'www.google.fr', u: '' }, corps: '{}' })).statut, 204);
  assert.strictEqual((await s.requete('compter', { query: { e: 'visite', r: 'quelque-blog.fr' }, corps: '{}' })).statut, 204);
  for (const e of etapes) assert.strictEqual((await s.requete('compter', { query: { e }, corps: '{}' })).statut, 204, e);
  const d = await jour();
  assert.strictEqual(d.visite - (avant.visite || 0), 2);
  assert.strictEqual(d.sources.google - ((avant.sources || {}).google || 0), 1);
  assert.strictEqual(d.sources.autre - ((avant.sources || {}).autre || 0), 1);
  for (const e of etapes) assert.strictEqual(d[e] - (avant[e] || 0), 1, e);
  assert.doesNotMatch(JSON.stringify(d), /quelque-blog|203\.0\.113/, 'ni le site exact ni l\'adresse internet');
});

test('étape inventée, ou « payé » envoyé par un petit malin : refusé, rien n\'est écrit', async () => {
  const avant = JSON.stringify((await jour()) || {});
  for (const e of ['paye', 'prevenir', 'n-importe-quoi', '__proto__', '']) {
    assert.strictEqual((await s.requete('compter', { query: { e }, corps: '{}' })).statut, 400, e);
  }
  assert.strictEqual(JSON.stringify((await jour()) || {}), avant);
});

test('paiement reçu et « Être prévenu » comptés par le serveur (une fois par inscription), lus par l\'admin seul', async () => {
  const avant = (await jour()) || {};
  await s.requete('compter', { query: { e: 'visite', r: 'l.facebook.com' }, corps: '{}' });
  await a.commanderEtPayer({ email: 'stats-acheteur@exemple.fr' });
  assert.strictEqual((await s.requete('listeAttente', { corps: { email: 'stats-curieux@exemple.fr', accord: true } })).statut, 204);
  assert.strictEqual((await s.requete('listeAttente', { corps: { email: 'stats-curieux@exemple.fr', accord: true } })).statut, 204);
  await s.calme();
  const d = await jour();
  assert.strictEqual(d.paye - (avant.paye || 0), 1);
  assert.strictEqual(d.prevenir - (avant.prevenir || 0), 1, 'la même personne inscrite deux fois compte une fois');

  const tanguy = await s.compte('Tanguy', 'stats-admin@exemple.fr', { admin: true });
  const r = await s.appeler('gestionStatistiques', { jours: 7 }, tanguy);
  assert.strictEqual(r.periode, 7);
  assert.strictEqual(r.jours.length >= 1 && r.jours[r.jours.length - 1].jour, jourDeParis(), 'aujourd\'hui en dernier');
  assert.deepStrictEqual([r.total.visite, r.total.paye, r.total.prevenir], [1, 1, 1]);
  assert.deepStrictEqual(r.sources, { facebook: 1 });

  const paul = await s.compte('Paul', 'stats-paul@exemple.fr');
  await assert.rejects(s.appeler('gestionStatistiques', { jours: 7 }, paul), /administrateur/);
  await assert.rejects(s.appeler('gestionStatistiques', { jours: 7 }), /administrateur/);
});
