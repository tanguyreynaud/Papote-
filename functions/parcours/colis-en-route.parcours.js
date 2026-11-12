// Colis parti, tablette pas encore entrée dans la famille (audit de l'admin du 11/11/2026, section 1, décision de
// Tanguy du 12/11). Depuis la « famille préparée », la commande a sa famille dès le paiement : « tablette installée »
// se lit avec tabletteDansLaFamille (famille-preparee.js), jamais avec « la commande a une famille ».
// Ce que l'admin lit (gestionDonnees), ce que la nuit corrige (stock) et le récap du lundi.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, commande } = require('./commun');

brancher();

const ligne = async (id) => (await s.appeler('gestionDonnees', {}, a.TANGUY)).commandes.find((c) => c.id === id);
const recap = async () => {
  s.boite.length = 0;
  await s.tache('gestionRecap');
  const m = s.boite.find((x) => x.a === 'contact@mapapote.fr');
  assert.ok(m, 'récap envoyé');
  return m.texte;
};

test('colis déposé : la tablette reste « envoyée » la nuit, le récap dit « pas jumelée » après 20 jours, puis elle entre', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(id, t);
  const c = await commande(id);
  assert.ok(c.fid && c.famillePreparee && !c.tabletteRelieeLe, 'famille préparée, tablette pas entrée');

  // L'admin reçoit de quoi appliquer la même règle que le serveur.
  const l = await ligne(id);
  assert.strictEqual(l.famillePreparee, true);
  assert.strictEqual(l.tabletteRelieeLe, null);

  // La nuit ne la croit pas « chez le client » parce que la commande a une famille.
  await s.tache('gestionAutomatique');
  assert.strictEqual((await s.lire(`stock/${t.fiche}`)).etat, 'envoyee');

  s.avancer(21);
  assert.match(await recap(), /1 tablette reçue mais pas jumelée après 20 jours/);

  // Mamie allume la tablette : elle entre seule dans sa famille.
  await a.afficherCode(t);
  await a.entrerDansLaFamille(t);
  assert.ok((await ligne(id)).tabletteRelieeLe, 'date d\'entrée transmise à l\'admin');
  await s.tache('gestionAutomatique');
  assert.strictEqual((await s.lire(`stock/${t.fiche}`)).etat, 'chez-client');
  assert.doesNotMatch(await recap(), /pas jumelée/);
});

test('colis jamais retiré, revenu chez Tanguy : le récap le dit et « Colis revenu » annule et rembourse', async () => {
  const lea = await s.compte('Léa', 'lea@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: lea.email, nom: 'Léa Durand' });
  await a.preparerEtEnvoyer(id, t);
  // Sendcloud : « Returned to sender » (livraison.js), noté sur l'étiquette aller.
  await s.db.doc(`commandes/${id}`).update({ 'etiquettes.aller.retourExpediteur': true });
  assert.match(await recap(), /Colis de Léa Durand en retour chez vous \(jamais retiré\)/);

  const r = await s.appeler('gestionAnnulerCommande', { commande: id, colisRevenu: true }, a.TANGUY);
  assert.ok(r, 'annulation acceptée');
  await s.calme();
  assert.strictEqual((await commande(id)).expedition, 'annulee');
  // Son propre e-mail (A4, Tanguy 12/11), plus « la tablette ne partira pas ».
  const m = s.boite.filter((x) => x.a === lea.email).at(-1);
  assert.strictEqual(m.sujet, 'Votre colis Papote nous est revenu');
  assert.match(m.texte, /Votre colis n'a pas été retiré et nous est revenu\.\n\nNous vous remboursons les 60 €\.\n\nÉcrivez-nous si vous voulez un nouvel envoi\./);
  assert.doesNotMatch(m.texte, /ne partira pas/);
  assert.deepStrictEqual(m.entetes, {}, 'e-mail de service : pas de désinscription');
});
