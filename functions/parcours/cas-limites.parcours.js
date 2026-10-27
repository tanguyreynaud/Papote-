// Cas limites du parcours client : colis non retiré, abonnement pris depuis l'appli, paiements SEPA,
// annulations, résiliation et tablette non rendue, installation reprise ou annulée, stock épuisé…

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, mailsA, commande } = require('./commun');

brancher();

// Famille déjà installée avec une tablette du stock : renvoie { fid, tablette }.
async function familleInstallee(proche, { tablette } = {}) {
  const t = tablette || await a.tablettePreparee();
  await a.afficherCode(t);
  const fid = await a.installer(proche, t);
  return { fid, tablette: t };
}

test('colis non retiré : rappels à J+5 et J+12, alerte à J+20, annulation refusée après le délai', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(id, t);
  s.boite.length = 0;

  s.avancer(5.1);
  await s.tache('rappelsJumelage');
  let c = await commande(id);
  assert.strictEqual(c.rappels, 1);
  assert.strictEqual(mailsA(paul.email).length, 1, 'premier rappel');
  s.avancer(7);
  await s.tache('rappelsJumelage');
  assert.strictEqual((await commande(id)).rappels, 2);
  await s.tache('rappelsJumelage');
  assert.strictEqual(mailsA(paul.email).length, 2, 'pas de rappel en double le même jour');
  s.avancer(8);
  await s.tache('rappelsJumelage');
  c = await commande(id);
  assert.strictEqual(c.alerteJumelage, true, 'Tanguy est prévenu dans l\'admin');
  assert.strictEqual(mailsA(paul.email).length, 2, 'pas de 3e rappel');

  // Délai pour changer d'avis : 30 jours après la réception estimée (envoi + 3 jours), soit J+33.
  assert.ok(require('../abonnement').retractationPossible(c, Date.now()), 'encore possible à J+20');
  s.avancer(14);
  assert.ok(!require('../abonnement').retractationPossible(await commande(id), Date.now()), 'plus possible à J+34');
});

test('abonnement pris depuis l\'appli avec la tablette déjà installée : rien à envoyer, premier prélèvement à 30 jours', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const { fid, tablette } = await familleInstallee(julie);
  let fam = await s.lire(`families/${fid}`);
  assert.strictEqual(fam.abonnement.statut, 'installation', 'tablette hors commande : 48 h pour la relier, abonnement à prendre');
  let fiche = await s.lire(`stock/${tablette.fiche}`);
  assert.strictEqual(fiche.alerteJumelage, 'jumelée sans commande');

  const { url } = await s.appeler('creerPaiement', { fid, formule: 'wifi', tablette: 'incluse' }, julie);
  const session = url.split('/').pop();
  const params = s.stripe.etat.sessions.get(session).params;
  // Stripe n'accepte pas plus d'un mois sur la page de paiement : départ à 27 jours, la vraie date est posée au paiement.
  assert.ok(Math.abs(params.subscription_data.billing_cycle_anchor * 1000 - (Date.now() + 27 * s.JOUR)) < 3600e3, 'page de paiement : 27 jours au plus');
  assert.ok(Math.abs(Number(params.subscription_data.metadata.premier) * 1000 - (Date.now() + 30 * s.JOUR)) < 3600e3, 'date voulue : 30 jours');
  assert.match(params.custom_text.submit.message, /dans 30 jours/);
  assert.strictEqual(params.subscription_data.metadata.dejaInstallee, '1');
  assert.strictEqual(params.shipping_address_collection, undefined, 'pas d\'adresse de livraison demandée');
  assert.strictEqual((await s.db.collection('reservations').get()).size, 0, 'aucune tablette mise de côté');

  const { abonnement: id } = s.stripe.payerSession(session, { email: julie.email, nom: 'Julie Martin' });
  await s.calme();
  const c = await commande(id);
  assert.strictEqual(c.expedition, 'envoyee', 'rien à préparer');
  assert.strictEqual(c.fid, fid);
  assert.strictEqual(c.preparation.recuPar, 'déjà installée');
  fam = await s.lire(`families/${fid}`);
  assert.strictEqual(fam.abonnement.statut, 'actif');
  fiche = await s.lire(`stock/${tablette.fiche}`);
  assert.strictEqual(fiche.commande, id, 'la tablette installée prend la commande');
  assert.strictEqual(fiche.etat, 'chez-client');
  assert.strictEqual(fiche.alerteJumelage, null, 'plus d\'alerte « jumelée sans commande » dans l\'admin');
  const abo = s.stripe.etat.abonnements.get(id);
  assert.ok(Math.abs(require('../abonnement').premierPrelevementDe(abo, Date.now()) - (Date.now() + 30 * s.JOUR)) < 3600e3, 'premier prélèvement 30 jours plus tard, posé au paiement');
  assert.ok(Math.abs(fam.abonnement.essaiJusqua.toMillis() - (Date.now() + 30 * s.JOUR)) < 3600e3, 'l\'appli montre la date du premier prélèvement');
  assert.ok(mailsA(julie.email).some((m) => /abonnement/i.test(m)), 'confirmation');
  const stock = await s.requete('stockDisponible');
  assert.strictEqual(stock.json.precommande, true, 'la tablette installée ne compte plus dans le stock');
});

test('31e proche : le compteur lu par les règles suit les arrivées (les demandes en attente ne comptent pas)', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const { fid } = await familleInstallee(julie);
  assert.strictEqual((await s.lire(`families/${fid}`)).nbProches, 1);
  for (let i = 2; i <= 30; i++) {
    await a.rejoindre({ uid: `proche-${i}`, prenom: `Proche ${i}`, email: `proche${i}@exemple.fr` }, fid);
  }
  await a.rejoindre({ uid: 'proche-attente', prenom: 'En attente', email: 'attente@exemple.fr' }, fid, { attente: true });
  await s.calme();
  assert.strictEqual((await s.lire(`families/${fid}`)).nbProches, 30, '30 proches : la règle refuse le suivant');
  await s.db.doc(`families/${fid}/members/proche-30`).delete();
  await s.calme();
  assert.strictEqual((await s.lire(`families/${fid}`)).nbProches, 29, 'une place se libère au départ d\'un proche');
});

test('prélèvement SEPA refusé par la banque : commande annulée, abonnement arrêté, tablette de nouveau libre', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  await a.tablettePreparee();
  const { session, abonnement: id } = await a.commanderEtPayer({ email: paul.email, sepaEnAttente: true });
  assert.strictEqual((await commande(id)).expedition, 'paiement-en-attente');
  assert.strictEqual(mailsA(paul.email).length, 0, 'pas de confirmation avant la banque');
  assert.strictEqual((await s.requete('stockDisponible')).json.precommande, true, 'la tablette lui est gardée');

  s.stripe.banqueRefuse(session);
  await s.calme();
  const c = await commande(id);
  assert.strictEqual(c.expedition, 'annulee');
  assert.strictEqual(c.annulation, 'sepa-refuse');
  assert.strictEqual(s.stripe.etat.abonnements.get(id).status, 'canceled');
  assert.strictEqual(c.dernierMois, undefined);
  assert.strictEqual(mailsA(paul.email).length, 1, 'client prévenu');
  assert.strictEqual((await s.requete('stockDisponible')).json.precommande, false, 'tablette rendue au stock');
});

test('prélèvement SEPA accepté quelques jours après : la commande passe « à préparer » et la confirmation part', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  await a.tablettePreparee();
  const { session, abonnement: id } = await a.commanderEtPayer({ email: paul.email, sepaEnAttente: true });
  s.avancer(3);
  s.stripe.banqueAccepte(session);
  await s.calme();
  const c = await commande(id);
  assert.strictEqual(c.expedition, 'a-preparer');
  assert.ok(c.mailConfirmation);
  assert.strictEqual(mailsA(paul.email).length, 1);
  assert.strictEqual(mailsA('contact@mapapote.fr').length, 1, 'une seule alerte « nouvelle commande »');
});

test('page de paiement abandonnée : la tablette mise de côté est libérée', async () => {
  await a.tablettePreparee();
  const session = await a.commanderSurLeSite({ email: 'hesite@exemple.fr' });
  assert.strictEqual((await s.requete('stockDisponible')).json.precommande, true, 'tablette gardée pendant le paiement');
  s.stripe.expirerSession(session);
  await s.calme();
  assert.strictEqual((await s.db.collection('reservations').get()).size, 0);
  assert.strictEqual((await s.requete('stockDisponible')).json.precommande, false);
});

test('stock épuisé : précommande jusqu\'à stock + 10, puis « 3 à 4 semaines », jamais fermé', async () => {
  let session = await a.commanderSurLeSite({ email: 'a@exemple.fr' });
  assert.strictEqual(s.stripe.etat.sessions.get(session).params.subscription_data.metadata.delai, 'precommande');
  s.stripe.expirerSession(session);
  await s.calme();
  for (let i = 0; i < 10; i++) {
    await s.db.collection('commandes').add({ expedition: 'a-preparer', email: `c${i}@exemple.fr`, fid: null });
  }
  assert.deepStrictEqual((await s.requete('stockDisponible')).json, { disponible: true, precommande: false, attenteLongue: true });
  session = await a.commanderSurLeSite({ email: 'b@exemple.fr' });
  assert.strictEqual(s.stripe.etat.sessions.get(session).params.subscription_data.metadata.delai, 'long');
});

test('webhook Stripe avec une fausse signature : refusé', async () => {
  const r = await s.requete('stripeWebhook', {
    corps: { type: 'checkout.session.completed', data: { object: { subscription: 'sub_pirate' } } },
    entetes: { 'stripe-signature': 'pirate' },
  });
  assert.strictEqual(r.statut, 400);
  assert.strictEqual((await s.db.collection('commandes').get()).size, 0);
});

test('Tanguy annule une commande pas encore partie : 60 € remboursés, la tablette choisie revient au stock', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { commande: id } }, a.TANGUY);
  const r = await s.appeler('gestionAnnulerCommande', { commande: id }, a.TANGUY);
  assert.strictEqual(r.rembourse, 6000);
  await s.calme();
  assert.strictEqual(s.stripe.rembourse(id), 6000);
  assert.strictEqual((await commande(id)).expedition, 'annulee');
  assert.strictEqual((await s.lire(`stock/${t.fiche}`)).commande, null);
  assert.strictEqual((await s.requete('stockDisponible')).json.precommande, false);
  // Rejoué (double clic) : refusé, rien de remboursé deux fois.
  await assert.rejects(s.appeler('gestionAnnulerCommande', { commande: id }, a.TANGUY), /déjà annulée/);
  assert.strictEqual(s.stripe.rembourse(id), 6000);
});

test('client qui recommande et annule depuis l\'appli avant l\'envoi : remboursé tout de suite, tablette rendue au stock', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  // Ancienne famille de Paul, abonnement terminé.
  const fam = s.db.collection('families').doc();
  await fam.set({ name: 'Papy Jean', code: 'ABCD2345', createdBy: paul.uid, abonnement: { statut: 'resilie' } });
  await fam.collection('members').doc(paul.uid).set({ uid: paul.uid, name: 'Paul', role: 'famille', email: paul.email, status: 'active' });
  await s.calme();
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  assert.strictEqual((await commande(id)).fid, fam.id, 'commande reliée à sa famille par son e-mail');
  assert.strictEqual((await s.lire(`families/${fam.id}`)).abonnement.statut, 'actif');
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { commande: id } }, a.TANGUY);

  const r = await s.appeler('retracter', { fid: fam.id }, paul);
  assert.deepStrictEqual(r, { ok: true, remboursement: 'fait', montant: 6000 });
  await s.calme();
  assert.strictEqual(s.stripe.rembourse(id), 6000);
  const c = await commande(id);
  assert.strictEqual(c.expedition, 'annulee');
  assert.strictEqual(c.restitution, undefined, 'rien à rendre');
  assert.ok(mailsA('contact@mapapote.fr').some((m) => /annul/i.test(m)), 'Tanguy prévenu : ne pas envoyer');
  assert.strictEqual((await s.lire(`stock/${t.fiche}`)).commande, null, 'la tablette choisie revient au stock');
  assert.strictEqual((await s.requete('stockDisponible')).json.precommande, false);
});

test('résiliation après le premier mois : dernier mois prélevé, rappel de retour, 140 € si la tablette ne revient pas', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(id, t);
  s.avancer(2);
  const { fid } = await familleInstallee(julie, { tablette: t });
  assert.strictEqual((await s.lire(`families/${fid}`)).abonnement.statut, 'actif');

  s.avancer(31);
  s.stripe.finirEssai(id);
  await s.calme();
  await assert.rejects(s.appeler('retracter', { fid }, julie), /30 jours/);
  const { le } = await s.appeler('resilierAbonnement', { fid }, julie);
  assert.ok(le > Date.now(), 'arrêt à la fin du mois en cours');
  await s.calme();
  assert.ok((await s.lire(`families/${fid}`)).abonnement.resiliationLe, 'date d\'arrêt affichée dans l\'appli');

  s.avancer(30);
  s.stripe.arreterALaDate(id);
  await s.calme();
  assert.strictEqual((await s.lire(`families/${fid}`)).abonnement.statut, 'resilie');
  let c = await commande(id);
  assert.strictEqual(c.dernierMois.statut, 'fait', 'mois écoulé prélevé à l\'arrêt');
  assert.strictEqual(c.dernierMois.montant, 2000);
  assert.strictEqual(c.restitution.statut, 'attendue');
  assert.ok(mailsA(paul.email).some((m) => /rendre la tablette/i.test(m)));

  s.avancer(24);
  await s.tache('restitutions');
  c = await commande(id);
  assert.ok(c.restitution.rappelLe, 'rappel 7 jours avant');
  assert.strictEqual(c.restitution.statut, 'attendue');
  s.avancer(7);
  await s.tache('restitutions');
  c = await commande(id);
  assert.strictEqual(c.restitution.statut, 'facturee');
  const pi = s.stripe.etat.paiements.get(c.restitution.paiement);
  assert.strictEqual(pi.amount, 14000, 'tablette 130 € + chargeur 10 € (pas d\'enceinte dans le colis)');
});

test('installation abandonnée en route : un autre proche la reprend 30 minutes après', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  await a.afficherCode(t);
  await s.appeler('reserverTablette', { code: t.code, prenom: 'Julie' }, julie);
  const { fid } = await s.appeler('nommerFamille', { code: t.code, nom: 'Mamie Emma' }, julie);
  await s.calme();
  await a.entrerDansLaFamille(t);
  assert.deepStrictEqual(await s.appeler('reserverTablette', { code: t.code, prenom: 'Paul' }, paul), { etat: 'occupe', par: 'Julie' });

  s.avancer(31 / 60 / 24);
  const r = await s.appeler('reserverTablette', { code: t.code, prenom: 'Paul' }, paul);
  assert.deepStrictEqual(r, { etat: 'reserve', fid });
  await s.calme();
  const fam = await s.lire(`families/${fid}`);
  assert.strictEqual(fam.createdBy, paul.uid, 'Paul devient propriétaire');
  assert.ok(fam.admins.includes(julie.uid), 'Julie reste responsable');
  assert.ok(await s.lire(`families/${fid}/members/${julie.uid}`), 'Julie reste membre');
  const avis = s.notifications.find((n) => n.type === 'alerte' && /a repris/.test(n.titre));
  assert.ok(avis, 'Julie est prévenue');
  assert.deepStrictEqual(avis.uids, [julie.uid]);
  assert.strictEqual(avis.fid, fid);
  await s.appeler('finirInstallation', { fid }, paul);
  await s.calme();
  assert.strictEqual((await s.lire(`families/${fid}`)).installation.etape, 'fini');
});

test('« Annuler l\'installation » : famille effacée, la tablette se réinstalle et garde sa commande', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const t = await a.tablettePreparee();
  await a.afficherCode(t);
  await s.appeler('reserverTablette', { code: t.code, prenom: 'Julie' }, julie);
  const { fid } = await s.appeler('nommerFamille', { code: t.code, nom: 'Mamei Ema' }, julie);
  await s.calme();
  await a.entrerDansLaFamille(t);
  await s.appeler('annulerInstallation', { fid }, julie);
  await s.calme();
  assert.strictEqual(await s.lire(`families/${fid}`), undefined);
  assert.strictEqual(await s.lire(`pairings/${t.code}`), undefined);
  assert.strictEqual((await s.lire(`stock/${t.fiche}`)).fid, null);
  assert.ok(s.fichiersEffaces.includes(`families/${fid}/`), 'photos effacées');

  await a.afficherCode(t);
  const fid2 = await a.installer(julie, t, { nom: 'Mamie Emma' });
  assert.notStrictEqual(fid2, fid);
  assert.strictEqual((await s.lire(`families/${fid2}`)).name, 'Mamie Emma');
});

test('« Annuler l\'installation » refusée quand la commande payée est déjà reliée', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(id, t);
  await a.afficherCode(t);
  await s.appeler('reserverTablette', { code: t.code, prenom: 'Paul' }, paul);
  const { fid } = await s.appeler('nommerFamille', { code: t.code, nom: 'Mamie Emma' }, paul);
  await s.calme();
  await assert.rejects(s.appeler('annulerInstallation', { fid }, paul), /commande est déjà reliée/);
  assert.ok(await s.lire(`families/${fid}`));
});

test('commande reliée à la main avec son code XXXX-XXXX (tablette pas reconnue)', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  // Tablette qui n'est pas dans le stock (n° de série inconnu) : rien ne relie la commande tout seul.
  const t = { serie: 'INCONNUE', tabletUid: 'tablette-inconnue', callsUid: 'appels-inconnue' };
  await a.afficherCode(t);
  s.boite.length = 0;
  const fid = await a.installer(julie, t);
  // Pas de commande à l'e-mail de Julie : 48 h de tolérance (rien de bloqué chez Mamie), Tanguy prévenu.
  let fam = await s.lire(`families/${fid}`);
  assert.strictEqual(fam.abonnement.statut, 'installation');
  assert.ok(Math.abs(fam.abonnement.toleranceJusqua.toMillis() - (Date.now() + 2 * s.JOUR)) < 60e3);
  assert.ok(mailsA('contact@mapapote.fr').some((m) => /sans commande reliée/.test(m)));
  await s.tache('finDeGrace');
  assert.strictEqual((await s.lire(`families/${fid}`)).abonnement.statut, 'installation', 'toujours tolérée');
  s.avancer(2.1);
  await s.tache('finDeGrace');
  await s.calme();
  assert.strictEqual((await s.lire(`families/${fid}`)).abonnement.statut, 'aucun', 'après 48 h : Papote en pause');
  await a.rejoindre(paul, fid);
  await s.calme();
  await assert.rejects(s.appeler('rattacherCommande', { fid, code: 'ZZZZ-ZZZZ' }, julie), /Aucune commande/);
  const { code } = await commande(id);
  await s.appeler('rattacherCommande', { fid, code: `${code.slice(0, 4)}-${code.slice(4)}` }, julie);
  await s.calme();
  fam = await s.lire(`families/${fid}`);
  assert.strictEqual(fam.abonnement.statut, 'actif');
  assert.strictEqual((await commande(id)).fid, fid);
  assert.ok(fam.admins.includes(paul.uid), 'Paul, qui a payé, devient responsable');
});

test('commande offerte (les mamies) : tablette envoyée, installée par un proche, famille offerte, jamais en pause', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const t = await a.tablettePreparee();
  const { id } = await s.appeler('gestionCommandeOfferte', { nom: 'Mamie B', formule: 'wifi', tablette: t.fiche }, a.TANGUY);
  assert.strictEqual((await commande(id)).expedition, 'a-preparer');
  await a.preparerEtEnvoyer(id, t);
  await a.afficherCode(t);
  const fid = await a.installer(julie, t);
  const fam = await s.lire(`families/${fid}`);
  assert.strictEqual(fam.abonnement.statut, 'offert', 'famille offerte dès l\'installation');
  assert.strictEqual((await commande(id)).fid, fid);
  assert.strictEqual(s.stripe.etat.abonnements.size, 0, 'rien chez Stripe');
});

test('SOS sans réponse au 2e essai : toute la famille est alertée', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { fid, tablette } = await familleInstallee(julie);
  await s.appeler('gestionFamilleOfferte', { fid, offerte: true }, a.TANGUY);
  await a.rejoindre(paul, fid);
  await s.calme();
  for (const essai of [1, 2]) {
    const cid = await a.appelerDepuisLaTablette(tablette, { sos: essai });
    const sonne = s.notifications.find((n) => n.type === 'appel' && n.cid === cid);
    assert.deepStrictEqual(sonne.uids.sort(), [julie.uid, paul.uid].sort(), 'tous les proches sonnent');
    assert.match(sonne.nom, /^SOS/);
    await s.db.doc(`families/${fid}/calls/${cid}`).update({ state: 'missed' });
    await s.calme();
  }
  const alertes = s.notifications.filter((n) => n.type === 'alerte' && /SOS/.test(n.titre));
  assert.strictEqual(alertes.length, 1, 'une seule alerte, après le 2e essai');
});
