// Casse, perte et impayé (Tanguy, 11/11) :
//   - remplacement de la tablette : panne gratuite, casse 130 €, perte ou vol 140 € ; prélevé avant tout changement,
//     une seule fois (double appui), carte refusée = rien ne bouge ;
//   - famille suspendue pour impayé depuis 30 jours : abonnement arrêté tout seul, puis retour de la tablette ;
//     prélèvement du matériel refusé = mise en demeure.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, commande } = require('./commun');
const regles = require('../abonnement');

brancher();

const famille = (fid) => s.lire(`families/${fid}`);
const mailsA = (email) => s.boite.filter((m) => m.a === email).map((m) => `${m.sujet}\n${m.texte}`);
const fiche = (t) => s.lire(`stock/${t.fiche}`);
const preleve = (id) => [...s.stripe.etat.paiements.values()]
  .filter((p) => p.metadata && p.metadata.commande === id && /remplacée|non rendu/.test(p.description || ''));

async function familleAbonnee(acheteur) {
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: acheteur.email });
  await a.preparerEtEnvoyer(id, t);
  s.avancer(2);
  await a.afficherCode(t);
  const fid = await a.installer(acheteur, t);
  assert.strictEqual((await famille(fid)).abonnement.statut, 'actif');
  return { id, fid, t };
}

// Tablette de remplacement prête en stock, avec sa propre carte SIM.
async function remplacante({ sim = true } = {}) {
  const t = await a.tablettePreparee();
  if (sim) await a.simSurTablette(t);
  return t;
}

const remplacer = (id, neuve, raison) => s.appeler('gestionStock', {
  action: 'remplacer', commande: id, element: 'tablette', nouveau: neuve.fiche, raison, motif: 'écran',
}, a.TANGUY);

test('remplacement : panne gratuite, casse 130 € prélevés une seule fois même en double appui, e-mail au client', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, t } = await familleAbonnee(paul);

  // Sans raison : refusé, rien ne bouge.
  await assert.rejects(remplacer(id, await remplacante(), undefined), /raison du remplacement/);
  assert.strictEqual((await fiche(t)).commande, id);

  // Panne : rien de prélevé, l'ancienne revient.
  const n1 = await remplacante();
  const r1 = await remplacer(id, n1, 'panne');
  assert.deepStrictEqual([r1.montant, r1.retour], [0, true]);
  assert.strictEqual(preleve(id).length, 0);
  assert.strictEqual((await fiche(t)).etat, 'en-retour');
  assert.strictEqual((await fiche(n1)).commande, id);

  // Casse, deux appuis en même temps : un seul prélèvement de 130 €.
  s.boite.length = 0;
  const n2 = await remplacante();
  const resultats = await Promise.allSettled([remplacer(id, n2, 'casse'), remplacer(id, n2, 'casse')]);
  assert.ok(resultats.some((r) => r.status === 'fulfilled' && r.value.montant === 13000), JSON.stringify(resultats));
  await s.calme();
  assert.deepStrictEqual(preleve(id).map((p) => [p.amount, p.description]), [[13000, 'Papote : tablette cassée, remplacée']]);
  assert.strictEqual((await fiche(n1)).etat, 'en-retour', 'la tablette cassée revient');
  assert.strictEqual((await fiche(n2)).commande, id);
  assert.strictEqual((await commande(id)).remplacement.statut, 'preleve');
  assert.ok(mailsA(paul.email).some((m) => /130 €/.test(m) && /cassée/.test(m)), 'e-mail du prélèvement');
});

test('remplacement : carte refusée, rien ne bouge ; perte ou vol 140 €, ancienne tablette perdue et sa carte SIM à résilier', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, t } = await familleAbonnee(paul);
  const simAncienne = (await fiche(t)).simId;

  // Carte refusée : message clair, aucun changement dans le stock.
  s.stripe.carteExpiree(id);
  const neuve = await remplacante();
  await assert.rejects(remplacer(id, neuve, 'perte'), /140 € refusé.*rien n'a été remplacé/);
  assert.strictEqual((await fiche(t)).commande, id);
  assert.strictEqual((await fiche(neuve)).commande, null);
  assert.strictEqual((await commande(id)).remplacement.statut, 'refuse');

  // Perte : la remplaçante doit avoir sa propre carte SIM.
  const abo = s.stripe.etat.abonnements.get(id);
  s.stripe.etat.clients.get(abo.customer).carteExpiree = false;
  await assert.rejects(remplacer(id, await remplacante({ sim: false }), 'perte'), /carte SIM de la tablette perdue/);
  assert.strictEqual(preleve(id).length, 0, 'rien prélevé tant que la remplaçante ne peut pas partir');

  // Carte changée : 140 € prélevés, l'ancienne passe « perdue », sa carte SIM « suspendue ».
  const r = await remplacer(id, neuve, 'perte');
  assert.deepStrictEqual([r.montant, r.retour], [regles.PENALITE_NON_RESTITUTION, false]);
  assert.deepStrictEqual(preleve(id).map((p) => p.amount), [14000]);
  assert.strictEqual((await fiche(t)).etat, 'perdue');
  assert.strictEqual((await s.lire(`sims/${simAncienne}`)).statut, 'suspendue');
  assert.strictEqual((await fiche(neuve)).etat, 'envoyee');
});

test('impayé : suspendue depuis 30 jours, l\'abonnement s\'arrête tout seul ; matériel refusé, mise en demeure', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await familleAbonnee(paul);
  s.avancer(31);
  s.stripe.finirEssai(id);
  await s.calme();
  s.avancer(30);
  s.stripe.banqueRefusePrelevement(id);
  await s.calme();
  s.avancer(8);
  await s.tache('finDeGrace');
  await s.calme();
  assert.strictEqual((await famille(fid)).abonnement.statut, 'suspendu');

  // 29 jours : rien.
  s.avancer(29);
  await s.tache('restitutions');
  await s.calme();
  assert.ok(!(await famille(fid)).abonnement.resiliationLe);

  // 30 jours : arrêté par Papote, un seul e-mail même si la tâche repasse.
  s.avancer(1.1);
  s.boite.length = 0;
  await s.tache('restitutions');
  await s.calme();
  await s.tache('restitutions');
  await s.calme();
  const ab = (await famille(fid)).abonnement;
  assert.ok(ab.resiliationLe, 'arrêt prévu');
  assert.strictEqual(ab.arretPar, 'papote');
  const arrets = mailsA(paul.email).filter((m) => /Papote arrête votre abonnement/.test(m));
  assert.strictEqual(arrets.length, 1);
  assert.match(arrets[0], /aucun nouveau mois ne sera prélevé[\s\S]*140 €/);

  // Fin de l'abonnement, puis 30 jours sans retour, carte refusée : mise en demeure.
  s.avancer((ab.resiliationLe.toMillis() - Date.now()) / s.JOUR + 0.1);
  s.stripe.arreterALaDate(id);
  await s.calme();
  assert.strictEqual((await commande(id)).restitution.statut, 'attendue');
  s.stripe.carteExpiree(id);
  s.avancer(31);
  s.boite.length = 0;
  await s.tache('restitutions');
  await s.calme();
  assert.strictEqual((await commande(id)).restitution.statut, 'echec');
  const demeure = mailsA(paul.email).filter((m) => /Mise en demeure/.test(m));
  assert.strictEqual(demeure.length, 1);
  assert.match(demeure[0], /sous 8 jours[\s\S]*Je renvoie la tablette[\s\S]*140 €, ainsi que les mois d'abonnement restés impayés/);
});

// Audit 8 (N4, 11/11) : Stripe a prélevé mais sa réponse se perd. L'admin ne doit jamais faire prélever deux fois.
test('remplacement payant : réponse de Stripe perdue après le débit, le 2e essai retrouve le paiement et ne prélève pas à nouveau', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, t } = await familleAbonnee(paul);
  const neuve = await remplacante();
  const api = s.stripe.api.paymentIntents;
  const creer = api.create;
  let perdu = false;
  api.create = async (...args) => {
    const r = await creer(...args);
    if (!perdu) { perdu = true; throw Object.assign(new Error('socket hang up'), { type: 'StripeConnectionError' }); }
    return r;
  };
  try {
    await assert.rejects(remplacer(id, neuve, 'casse'), /Pas de réponse claire de Stripe.*ne prélève jamais deux fois/);
    assert.strictEqual((await commande(id)).remplacement.statut, 'incertain');
    assert.strictEqual((await fiche(t)).commande, id, 'rien remplacé tant que ce n\'est pas sûr');
    assert.strictEqual(preleve(id).length, 1, 'Stripe a bien prélevé une fois');
    const r = await remplacer(id, neuve, 'casse');
    assert.strictEqual(r.montant, 13000);
    assert.strictEqual(preleve(id).length, 1, 'pas de 2e prélèvement');
    assert.strictEqual((await commande(id)).remplacement.statut, 'preleve');
    assert.strictEqual((await fiche(neuve)).commande, id);
    // Relancé encore (vieil onglet) : rien de plus.
    await assert.rejects(remplacer(id, neuve, 'casse'), /disponible du stock/);
    assert.strictEqual(preleve(id).length, 1);
  } finally {
    api.create = creer;
  }
});
