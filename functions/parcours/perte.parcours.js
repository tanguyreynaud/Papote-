// Tablette perdue ou volée (Tanguy, 8/11) : « Tablette volée : tout couper », puis sur le même écran la remplaçante.
// Prélever d'abord (140 €, 150 € avec l'enceinte) : la remplaçante et sa carte SIM ne partent que si c'est payé ;
// refusé, rien ne part et la famille est prévenue. Double clic : un seul prélèvement. Stock vide : la tablette
// achetée est réservée à la commande, et le prélèvement se fait quand elle part (perte.js, tabletteRemplacement).

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, mailsA, commande } = require('./commun');

brancher();

const MAIL_OK = 'Tablette perdue ou volée : une nouvelle tablette part chez vous';
const MAIL_REFUS = 'Tablette perdue ou volée : le paiement n\'a pas abouti';
const prelevements = () => [...s.stripe.etat.paiements.values()].filter((p) => /perdue ou volée/.test(p.description || ''));
const fiche = (id) => s.lire(`stock/${id}`);

// Famille abonnée et installée, tablette (avec sa carte SIM) coupée par « Tablette volée : tout couper ».
async function tabletteVolee(acheteur) {
  await s.db.doc('gestion/reglages').set({ expediteur: { nom: 'Papote', adresse: '1 rue de test', cp: '07000', ville: 'Privas' } }, { merge: true });
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: acheteur.email });
  await a.preparerEtEnvoyer(id, t);
  s.avancer(2);
  await a.afficherCode(t);
  const fid = await a.installer(acheteur, t);
  s.avancer(31);
  s.stripe.finirEssai(id);
  await s.calme();
  const simAvant = (await fiche(t.fiche)).simId;
  assert.ok(simAvant, 'la tablette a sa carte SIM');
  const r = await s.appeler('tabletteVolee', { serie: t.serie }, a.TANGUY);
  assert.ok(r.ok);
  await s.calme();
  assert.strictEqual((await fiche(t.fiche)).etat, 'perdue');
  return { id, fid, t, simAvant };
}

// Carte SIM neuve en stock (Stock, Cartes SIM).
async function simLibre() {
  const { id } = await s.appeler('gestionSim', { action: 'ajouter', champs: { statut: 'stock', operateur: 'Lyca', numero: '07 45 99 88 77', prix: 499 } }, a.TANGUY);
  return id;
}

test('tablette libre : prélevé d\'abord, puis remplaçante et carte SIM ; double clic = un seul prélèvement ; étiquette d\'envoi', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, t, simAvant } = await tabletteVolee(paul);
  const t2 = await a.tablettePreparee();
  const sim = await simLibre();
  const demande = { action: 'envoyer', commande: id, ancienne: t.fiche, nouveau: t2.fiche, sim };
  // Double clic : les deux appels en même temps.
  const r = await Promise.allSettled([
    s.appeler('tabletteRemplacement', demande, a.TANGUY),
    s.appeler('tabletteRemplacement', demande, a.TANGUY),
  ]);
  await s.calme();
  const reussis = r.filter((x) => x.status === 'fulfilled' && x.value.ok && !x.value.deja);
  assert.strictEqual(reussis.length, 1, JSON.stringify(r.map((x) => x.reason ? x.reason.message : x.value)));
  for (const x of r.filter((y) => y.status === 'rejected')) assert.match(x.reason.message, /déjà en cours/);
  assert.strictEqual(reussis[0].value.perte.statut, 'envoyee');
  assert.strictEqual(reussis[0].value.simErreur, null);
  assert.strictEqual(prelevements().length, 1);
  assert.strictEqual(prelevements()[0].amount, 14000);
  assert.strictEqual(prelevements()[0].cle, `perte-${id}-${t.fiche}-1`);
  // Kit : la tablette perdue quitte la commande (rien à récupérer), la remplaçante part avec la nouvelle carte SIM.
  const perdue = await fiche(t.fiche);
  assert.strictEqual(perdue.etat, 'perdue');
  assert.strictEqual(perdue.commande, null);
  assert.strictEqual(perdue.perdueDe, id);
  const neuve = await fiche(t2.fiche);
  assert.strictEqual(neuve.etat, 'envoyee');
  assert.strictEqual(neuve.commande, id);
  assert.strictEqual(neuve.simId, sim);
  assert.strictEqual((await s.lire(`sims/${simAvant}`)).statut, 'suspendue');
  assert.strictEqual((await s.lire(`sims/${sim}`)).tablette, t2.fiche);
  assert.deepStrictEqual(mailsA(paul.email).filter((m) => /perdue/.test(m)), [MAIL_OK]);
  // L'étiquette d'envoi de la remplaçante, sur une commande déjà envoyée.
  const e = await s.appeler('gestionEtiquette', { commande: id, sens: 'aller' }, a.TANGUY);
  assert.ok(e.ok && e.suivi);
  await assert.rejects(s.appeler('gestionEtiquette', { commande: id, sens: 'aller' }, a.TANGUY), /existe déjà/);
  // Vieil onglet : un nouveau clic ne fait rien de plus.
  const encore = await s.appeler('tabletteRemplacement', demande, a.TANGUY);
  assert.strictEqual(encore.deja, true);
  assert.strictEqual(prelevements().length, 1);
  // Encaissement facturé la nuit comme un matériel non rendu.
  await s.calme();
});

test('prélèvement refusé : rien ne part, la famille et Papote sont prévenus ; nouvel essai une fois la carte changée', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, t, simAvant } = await tabletteVolee(paul);
  const t2 = await a.tablettePreparee();
  const sim = await simLibre();
  s.stripe.carteExpiree(id);
  const demande = { action: 'envoyer', commande: id, ancienne: t.fiche, nouveau: t2.fiche, sim };
  const r = await s.appeler('tabletteRemplacement', demande, a.TANGUY);
  await s.calme();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.perte.statut, 'echec');
  assert.match(r.perte.erreur, /expired/);
  assert.strictEqual(prelevements().length, 0);
  // Rien n'est remplacé : la remplaçante reste au stock, la carte SIM aussi.
  assert.strictEqual((await fiche(t2.fiche)).etat, 'preparee');
  assert.strictEqual((await fiche(t2.fiche)).commande, null);
  assert.strictEqual((await fiche(t.fiche)).commande, id);
  assert.strictEqual((await s.lire(`sims/${sim}`)).tablette, null);
  assert.notStrictEqual((await s.lire(`sims/${simAvant}`)).statut, 'suspendue');
  assert.deepStrictEqual(mailsA(paul.email).filter((m) => /perdue/.test(m)), [MAIL_REFUS]);
  assert.ok(mailsA('contact@mapapote.fr').some((m) => /Tablette perdue ou volée, prélèvement refusé/.test(m)));
  assert.strictEqual((await commande(id)).perte.statut, 'echec');
  // Carte changée : nouvel essai, nouvelle clé, cette fois payé et parti.
  const abo = s.stripe.etat.abonnements.get(id);
  s.stripe.etat.clients.get(abo.customer).carteExpiree = false;
  const r2 = await s.appeler('tabletteRemplacement', demande, a.TANGUY);
  await s.calme();
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.perte.statut, 'envoyee');
  assert.strictEqual(prelevements().length, 1);
  assert.strictEqual(prelevements()[0].cle, `perte-${id}-${t.fiche}-2`);
  assert.strictEqual((await fiche(t2.fiche)).commande, id);
});

test('stock vide : tablette achetée réservée à la commande (deux clics, une fiche), pas à vendre ; 150 € prélevés quand elle part', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, t } = await tabletteVolee(paul);
  await s.db.doc(`commandes/${id}`).update({ enceinteFournie: true });
  const achat = { action: 'acheter', commande: id, ancienne: t.fiche };
  const [r1, r2] = await Promise.all([
    s.appeler('tabletteRemplacement', achat, a.TANGUY).catch((e) => ({ erreur: e.message })),
    s.appeler('tabletteRemplacement', achat, a.TANGUY).catch((e) => ({ erreur: e.message })),
  ]);
  await s.calme();
  const reservees = (await s.db.collection('stock').where('reserveePour', '==', id).get()).docs;
  assert.strictEqual(reservees.length, 1, JSON.stringify([r1, r2]));
  const achetee = reservees[0];
  assert.strictEqual(achetee.get('etat'), 'commandee');
  assert.strictEqual(achetee.get('remplacePerdue'), t.fiche);
  assert.strictEqual((await commande(id)).perte.statut, 'achat');
  assert.strictEqual(prelevements().length, 0, 'rien prélevé tant que rien ne part');
  // Reçue : en stock, mais pas à vendre, ni reliable à la main.
  await s.appeler('gestionParcours', { type: 'reception', id: achetee.id, reception: { etape: 1, faits: {} } }, a.TANGUY);
  assert.strictEqual((await fiche(achetee.id)).etat, 'en-stock');
  const dispo = await s.requete('stockDisponible');
  assert.strictEqual(dispo.json.disponible, false);
  await assert.rejects(s.appeler('gestionStock', { action: 'modifier', id: achetee.id, champs: { commande: id } }, a.TANGUY), /réservée/);
  // Elle part : prélevé d'abord (avec l'enceinte), puis remplacement.
  const r = await s.appeler('tabletteRemplacement', { action: 'envoyer', commande: id, ancienne: t.fiche, nouveau: achetee.id }, a.TANGUY);
  await s.calme();
  assert.strictEqual(r.perte.statut, 'envoyee');
  assert.strictEqual(prelevements().length, 1);
  assert.strictEqual(prelevements()[0].amount, 15000);
  const partie = await fiche(achetee.id);
  assert.strictEqual(partie.etat, 'envoyee');
  assert.strictEqual(partie.commande, id);
  assert.strictEqual(partie.reserveePour, undefined);
  assert.deepStrictEqual(mailsA(paul.email).filter((m) => /perdue/.test(m)), [MAIL_OK]);
});
