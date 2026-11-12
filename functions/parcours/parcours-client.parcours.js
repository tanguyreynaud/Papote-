// Parcours client complet, du site vitrine au retour de la tablette, joué avec les vraies fonctions
// (simulation.js). Lancer : « npm run parcours » dans functions/.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');

const { brancher, mailsA, commande } = require('./commun');

brancher();

test('commande, famille préparée au paiement, envoi, la tablette entre seule dans la famille, envois, appel, annulation et remboursement des 60 €', async () => {
  const paul = await s.compte('Paul', 'paul.acheteur@exemple.fr');
  const julie = await s.compte('Julie', 'julie.installe@exemple.fr');
  const tablette = await a.tablettePreparee();

  // 1. Le site annonce une tablette en stock.
  const stock = await s.requete('stockDisponible');
  assert.deepStrictEqual(stock.json, { disponible: true, precommande: false, attenteLongue: false });

  // 2. Paul commande sur le site et paie (carte en premier, SEPA en second, pas de TVA : 26/10).
  const session = await a.commanderSurLeSite({ email: paul.email });
  const params = s.stripe.etat.sessions.get(session).params;
  assert.deepStrictEqual(params.payment_method_types, ['card', 'link', 'sepa_debit']);
  assert.strictEqual(params.tax_id_collection, undefined, 'plus de numéro de TVA sur la page de paiement');
  assert.strictEqual(params.subscription_data.trial_period_days, undefined, 'plus d\'« essai gratuit » sur la page de paiement');
  assert.ok(Math.abs(Number(params.subscription_data.metadata.premier) * 1000 - (Date.now() + 37 * s.JOUR)) < 3600e3, 'premier prélèvement estimé : envoi 7 jours + 30');
  // Stripe refuse plus d'un mois sur la page de paiement : 27 jours, puis la date voulue posée au paiement reçu.
  assert.ok(Math.abs(params.subscription_data.billing_cycle_anchor * 1000 - (Date.now() + 27 * s.JOUR)) < 3600e3, 'page de paiement : 27 jours au plus');
  assert.strictEqual(params.subscription_data.proration_behavior, 'none', 'rien pour l\'abonnement aujourd\'hui');
  assert.match(params.custom_text.submit.message, /réception de la tablette/);
  assert.match(params.custom_text.submit.message, /\[conditions générales de vente\]\(https:\/\/[^)]+\/cgv\.html\)/, 'CGV acceptées sur la page de paiement');
  assert.strictEqual(params.subscription_data.metadata.delai, 'stock');
  assert.ok(params.expires_at, 'la page de paiement expire (tablette mise de côté)');
  assert.strictEqual((await s.db.collection('reservations').get()).size, 1);

  const { abonnement: id } = s.stripe.payerSession(session, { email: paul.email, nom: 'Paul Martin' });
  await s.calme();
  let c = await commande(id);
  assert.strictEqual(c.expedition, 'a-preparer');
  assert.ok(Math.abs(require('../abonnement').premierPrelevementDe(s.stripe.etat.abonnements.get(id), Date.now()) - (Date.now() + 37 * s.JOUR)) < 3600e3,
    'au paiement reçu, le premier prélèvement passe à la date voulue (37 jours : envoi + 30)');
  assert.strictEqual(c.email, paul.email);
  assert.strictEqual(c.livraison.ville, 'SAINT MARTIN DE VALAMAS');
  // Famille préparée tout de suite (05/11) : nom d'attente, aucun responsable, Paul invité à son e-mail.
  assert.ok(c.fid, 'famille créée au paiement');
  assert.strictEqual(c.famillePreparee, true);
  // Badge « Couverture à vérifier » (12/11) : Saint-Martin-de-Valamas a moins de 2 000 habitants.
  assert.deepStrictEqual(c.couvertureAVerifier.raisons, ['petite-commune']);
  assert.strictEqual(c.couvertureAVerifier.commune, 'Saint-Martin-de-Valamas');
  assert.strictEqual(c.couvertureAVerifier.carte, 'https://monreseaumobile.arcep.fr/');
  await assert.rejects(s.appeler('gestionCommande', { commande: id, action: 'couvertureVue' }, paul), /admin|Papote|permission/i, 'réservé à Tanguy');
  // « Vu » coché deux fois (double clic) : une seule date ; décoché, puis recoché.
  await Promise.all([1, 2].map(() => s.appeler('gestionCommande', { commande: id, action: 'couvertureVue', vu: true }, a.TANGUY)));
  assert.ok((await commande(id)).couvertureVueLe, 'vu noté');
  assert.deepStrictEqual(await s.appeler('gestionCommande', { commande: id, action: 'couvertureVue', vu: false }, a.TANGUY), { ok: true, vu: false });
  assert.strictEqual((await commande(id)).couvertureVueLe, undefined, 'coche retirée');
  await s.appeler('gestionCommande', { commande: id, action: 'couvertureVue' }, a.TANGUY);
  const vue = (await s.appeler('gestionDonnees', {}, a.TANGUY)).commandes.find((x) => x.id === id);
  assert.deepStrictEqual(vue.couvertureAVerifier.raisons, ['petite-commune'], 'l\'admin reçoit le badge');
  assert.ok(vue.couvertureVueLe && vue.proche && vue.proche.adresse, 'et la coche, avec l\'adresse du proche');
  const fid = c.fid;
  let fam = await s.lire(`families/${fid}`);
  assert.strictEqual(fam.nomAChoisir, true);
  assert.strictEqual(fam.createdBy, null);
  assert.strictEqual(fam.installation.preparee, true);
  assert.strictEqual(fam.installation.etape, 'fini', 'la tablette ne montrera jamais les écrans d\'installation');
  assert.strictEqual(fam.abonnement.statut, 'actif', 'la commande est déjà reliée');
  assert.strictEqual(fam.abonnement.stripeSubscriptionId, id);
  assert.strictEqual(fam.meteoVille.nom, 'Saint-Martin-de-Valamas', 'météo de la ville du point relais');
  assert.ok(await s.lire(`families/${fid}/invitations/${paul.email}`), 'Paul invité dans sa famille');
  assert.ok(/^[A-Z0-9]{8}$/.test(c.code), 'code de commande');
  assert.strictEqual((await s.db.collection('reservations').get()).size, 0, 'réservation remplacée par la commande');
  assert.ok(mailsA(paul.email).some((m) => /commande/i.test(m)), 'e-mail de confirmation au client');
  const confirmation = s.boite.find((m) => m.a === paul.email && /commande/i.test(m.sujet));
  assert.match(JSON.stringify(confirmation), /espace famille Papote est déjà prêt/, 'l\'e-mail ouvre l\'espace famille');
  assert.ok(mailsA('contact@mapapote.fr').some((m) => /commande/i.test(m)), 'e-mail de nouvelle commande à Papote');

  // merci.html affiche le code de commande.
  const merci = await s.requete('codeCommande', { query: { session } });
  assert.strictEqual(merci.json.code.replace('-', ''), c.code);

  // 3. Avant l'arrivée de la tablette, Paul ouvre l'appli : il entre par son invitation, devient responsable,
  //    donne le nom et envoie une première photo.
  await a.entrerParInvitation(paul, fid);
  assert.strictEqual((await s.lire(`families/${fid}`)).createdBy, paul.uid, 'Paul responsable de la famille');
  await assert.rejects(s.appeler('nommerFamillePreparee', { fid, nom: 'Mamie Emma' }, julie), /membres/, 'Julie n\'est pas encore de la famille');
  await s.appeler('nommerFamillePreparee', { fid, nom: '  Mamie   Emma ' }, paul);
  fam = await s.lire(`families/${fid}`);
  assert.strictEqual(fam.name, 'Mamie Emma');
  assert.strictEqual(fam.nomAChoisir, undefined);
  await a.envoyer(paul, fid, 'photo', 'Au parc');

  // La tablette allumée chez Tanguy pendant la préparation n'entre pas encore dans la famille.
  await s.appeler('gestionStock', { action: 'modifier', id: tablette.fiche, champs: { commande: id } }, a.TANGUY);
  await a.afficherCode(tablette);
  assert.strictEqual((await s.lire(`pairings/${tablette.code}`)).status, 'waiting', 'colis pas encore parti : pas de famille');

  // 4. Tanguy prépare l'envoi : une autre tablette lue au dépôt est refusée (A14-4), puis il dépose le colis.
  await a.simSurTablette(tablette);
  await assert.rejects(s.appeler('tabletteEnvoyee', { commande: id, suivi: '12345678', tablette: 'T-999' }, a.TANGUY), /pas celle de cette commande/);
  assert.strictEqual((await commande(id)).expedition, 'a-preparer');
  await a.preparerEtEnvoyer(id, tablette);
  c = await commande(id);
  assert.strictEqual(c.expedition, 'envoyee');
  assert.strictEqual(c.suivi, '12345678');
  assert.ok(c.mailEnvoiLe, 'e-mail « colis parti » envoyé');
  const colis = s.boite.find((m) => m.a === paul.email && /en route/i.test(m.sujet));
  assert.match(JSON.stringify(colis), /retrouve votre famille toute seule/, 'plus de QR code à scanner');
  assert.strictEqual((await s.lire(`stock/${tablette.fiche}`)).etat, 'envoyee');
  // Premier prélèvement recalé : 30 jours après la réception estimée (envoi + 3 jours).
  const premier = require('../abonnement').premierPrelevementDe(s.stripe.etat.abonnements.get(id), Date.now());
  assert.ok(Math.abs(premier - (Date.now() + 33 * s.JOUR)) < 3600e3, 'premier prélèvement 30 jours après la réception estimée');

  // 5. La tablette arrive chez Mamie : on la branche, elle entre seule dans sa famille, sans scanner.
  await a.afficherCode(tablette);
  const p = await s.lire(`pairings/${tablette.code}`);
  assert.strictEqual(p.status, 'confirmed');
  assert.strictEqual(p.fid, fid);
  assert.strictEqual(p.familyName, 'Mamie Emma');
  await a.entrerDansLaFamille(tablette);
  c = await commande(id);
  assert.ok(c.preparation.recuLe, 'tablette reçue');
  assert.ok(c.tabletteRelieeLe, 'plus de rappel « votre tablette vous attend »');
  const fiche = await s.lire(`stock/${tablette.fiche}`);
  assert.strictEqual(fiche.etat, 'chez-client');
  assert.strictEqual(fiche.fid, fid);
  assert.strictEqual(fiche.alerteJumelage, null);
  fam = await s.lire(`families/${fid}`);
  assert.strictEqual(fam.abonnement.statut, 'actif');
  assert.strictEqual(fam.createdBy, paul.uid);

  // Julie rejoint la famille (invitation acceptée) ; envois de photo, message et vidéo.
  await a.rejoindre(julie, fid);
  await s.calme();
  assert.strictEqual((await s.lire(`families/${fid}`)).createdBy, paul.uid, 'Paul reste responsable');
  assert.strictEqual((await s.lire(`families/${fid}`)).nbProches, 2);
  assert.ok(s.notifications.some((n) => n.type === 'arrivee' && n.uids.includes(paul.uid)), 'Paul prévenu de l\'arrivée de Julie');
  await a.envoyer(paul, fid, 'message', 'Bonjour Mamie !');
  await a.envoyer(julie, fid, 'photo');
  await a.envoyer(julie, fid, 'video');
  assert.strictEqual((await s.db.collection(`families/${fid}/posts`).get()).size, 4, 'aucun envoi effacé');
  // 6. Mamie appelle Julie : son téléphone sonne ; Julie décroche puis raccroche.
  const appel = await a.appelerDepuisLaTablette(tablette, { vers: julie });
  const sonnerie = s.notifications.filter((n) => n.type === 'appel' && n.cid === appel);
  assert.ok(sonnerie.length >= 1 && sonnerie.every((n) => n.uids.join() === julie.uid), 'seule Julie sonne');
  await s.db.doc(`families/${fid}/calls/${appel}`).update({ state: 'accepted', answer: { type: 'answer', sdp: 'x' } });
  await s.calme();
  assert.ok(s.notifications.some((n) => n.type === 'fin' && n.cid === appel), 'les autres téléphones arrêtent de sonner');
  // Appel sans réponse : « Appel manqué ».
  const manque = await a.appelerDepuisLaTablette(tablette, { vers: paul });
  await s.db.doc(`families/${fid}/calls/${manque}`).update({ state: 'missed' });
  await s.calme();
  assert.ok(s.notifications.some((n) => n.type === 'manque' && n.cid === manque && n.uids.includes(paul.uid)));

  // 7. Dix jours plus tard, Paul annule la commande (moins de 30 jours après la réception).
  s.avancer(10);
  const fin = await s.appeler('finDeContrat', { fid }, paul);
  assert.strictEqual(fin.retractation.montant, 6000, '60 € de mise en service à rembourser');
  const r = await s.appeler('retracter', { fid }, paul);
  assert.deepStrictEqual(r, { ok: true, remboursement: 'au-retour', montant: 6000 });
  await s.calme();
  assert.strictEqual(s.stripe.etat.abonnements.get(id).status, 'canceled');
  fam = await s.lire(`families/${fid}`);
  assert.strictEqual(fam.abonnement.statut, 'resilie');
  c = await commande(id);
  assert.strictEqual(c.restitution.statut, 'attendue');
  assert.strictEqual(c.remboursement.statut, 'au-retour');
  assert.strictEqual(c.dernierMois, undefined, 'rien prélevé pour une annulation dans les 30 jours');
  assert.ok(mailsA(paul.email).some((m) => /rendre la tablette/i.test(m)), 'mode d\'emploi du retour envoyé à l\'acheteur');
  assert.strictEqual(s.stripe.rembourse(id), 0, 'remboursé seulement au retour de la tablette');
  assert.strictEqual(s.sendcloud.colis.size, 0, 'aucune étiquette créée d\'office');
  assert.strictEqual((await s.appeler('finDeContrat', { fid }, paul)).restitution.qr, null);

  // Paul est prêt à déposer le colis : « Je renvoie la tablette » crée le QR code (sans impression), une seule fois.
  await s.db.doc('gestion/reglages').set({ expediteur: { nom: 'Papote', adresse: '1 rue de test', cp: '07000', ville: 'Privas' } }, { merge: true });
  const qr = await s.appeler('renvoyerTablette', { fid }, paul);
  assert.ok(qr.qr && qr.etiquette, 'QR code et PDF');
  assert.strictEqual([...s.sendcloud.colis.values()][0].livraison, 'drop_off_labelless');
  assert.deepStrictEqual(await s.appeler('renvoyerTablette', { fid }, paul), qr, 'le même QR, pas un second');
  assert.strictEqual(s.sendcloud.colis.size, 1);
  await s.calme();
  assert.strictEqual((await s.appeler('finDeContrat', { fid }, paul)).restitution.qr, qr.qr);
  assert.ok(mailsA(paul.email).some((m) => /QR code/.test(m)), 'QR code envoyé par e-mail');

  // Pas déposé en 30 jours : la nuit, le QR est annulé (remboursé par Sendcloud) et Paul peut en redemander un.
  const nuit = async () => {
    const bilan = { erreurs: [] };
    await require('../gestion').retoursNonDeposes(bilan, Date.now());
    assert.deepStrictEqual(bilan.erreurs, []);
  };
  s.avancer(29);
  await nuit();
  assert.strictEqual([...s.sendcloud.colis.values()][0].annule, false, 'pas avant 30 jours');
  s.avancer(2);
  await nuit();
  await s.calme();
  assert.strictEqual([...s.sendcloud.colis.values()][0].annule, true, 'QR pas déposé annulé');
  c = await commande(id);
  assert.strictEqual(c.restitution.qr, undefined);
  assert.strictEqual(c.etiquettes.retour, undefined);
  const qr2 = await s.appeler('renvoyerTablette', { fid }, paul);
  assert.notStrictEqual(qr2.qr, qr.qr, 'nouveau QR code');

  // 8. La tablette revient complète : les 60 € sont remboursés.
  await s.appeler('tabletteRendue', { commande: id }, a.TANGUY);
  await s.calme();
  c = await commande(id);
  assert.strictEqual(c.restitution.statut, 'rendue');
  assert.strictEqual(c.remboursement.statut, 'fait');
  assert.strictEqual(c.remboursement.montant, 6000);
  assert.strictEqual(s.stripe.rembourse(id), 6000);
  assert.ok(mailsA(paul.email).some((m) => /reçu|rembours/i.test(m)), 'e-mail « tablette reçue »');
});
