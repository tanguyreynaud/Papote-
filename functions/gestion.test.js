const test = require('node:test');
const assert = require('node:assert');
const { regles: g } = require('./gestion');

test('nature des mouvements Stripe', () => {
  assert.strictEqual(g.natureMouvement({ type: 'charge', source: { description: 'Subscription update' } }), 'abonnement');
  assert.strictEqual(g.natureMouvement({ type: 'charge', source: { description: 'Papote : tablette non rendue' } }),
    'tablette-non-rendue');
  assert.strictEqual(g.natureMouvement({ type: 'payment_refund', source: 're_1' }), 'remboursement');
  assert.strictEqual(g.natureMouvement({ type: 'refund' }), 'remboursement');
  assert.strictEqual(g.natureMouvement({ type: 'payout' }), 'virement');
  assert.strictEqual(g.natureMouvement({ type: 'stripe_fee' }), 'frais');
  assert.strictEqual(g.natureMouvement({ type: 'adjustment' }), 'autre');
});

test('montant mensuel d\'un abonnement', () => {
  const prix = (unit_amount, interval, extra = {}) => ({ price: { unit_amount, recurring: { interval, interval_count: 1 } }, ...extra });
  assert.strictEqual(g.mensuel({ items: { data: [prix(2000, 'month')] } }), 2000);
  assert.strictEqual(g.mensuel({ items: { data: [prix(24000, 'year')] } }), 2000);
  // Les 50 € de mise en service ne sont pas récurrents.
  assert.strictEqual(g.mensuel({ items: { data: [prix(3000, 'month'), { price: { unit_amount: 5000 } }] } }), 3000);
  assert.strictEqual(g.mensuel({ items: { data: [prix(1000, 'month', { quantity: 2 })] } }), 2000);
  assert.strictEqual(g.mensuel({}), 0);
});

test('saisies : montants et liens', () => {
  assert.strictEqual(g.centimes(8990), 8990);
  assert.strictEqual(g.centimes('8990'), 8990);
  assert.strictEqual(g.centimes(-1), null);
  assert.strictEqual(g.centimes(12.5), null);
  assert.strictEqual(g.centimes('abc'), null);
  assert.strictEqual(g.centimes(null), null);
  assert.strictEqual(g.centimes(''), null);
  assert.strictEqual(g.lien('https://exemple.fr/facture.pdf'), 'https://exemple.fr/facture.pdf');
  assert.strictEqual(g.lien('javascript:alert(1)'), null);
  assert.strictEqual(g.lien(''), null);
});

test('nom de fichier des pièces jointes', () => {
  assert.strictEqual(g.nomFichier('Facture Cdiscount n°12 été.pdf'), 'Facture-Cdiscount-n-12-ete.pdf');
  assert.strictEqual(g.nomFichier('../../secret'), '..-..-secret');
  assert.strictEqual(g.nomFichier(''), 'piece');
});

test('échéance suivante d\'une dépense mensuelle', () => {
  const jour = (s) => new Date(s).toISOString().slice(0, 10);
  assert.strictEqual(jour(g.moisSuivant(Date.UTC(2026, 0, 15, 12), 15)), '2026-02-15');
  // Le 31 devient le 28 en février, puis revient au 31 en mars.
  const fevrier = g.moisSuivant(Date.UTC(2026, 0, 31, 12), 31);
  assert.strictEqual(jour(fevrier), '2026-02-28');
  assert.strictEqual(jour(g.moisSuivant(fevrier, 31)), '2026-03-31');
  assert.strictEqual(jour(g.moisSuivant(Date.UTC(2026, 11, 5, 12), 5)), '2027-01-05');
});

test('lecture d\'une facture vers le formulaire', () => {
  const f = g.lectureVersFormulaire({
    estUneFacture: true,
    fournisseur: ' Cdiscount ',
    numero: 'F-123',
    date: '2026-10-02',
    totalTTC: 359.7,
    tva: 59.95,
    devise: 'EUR',
    categorie: 'tablettes',
    libelle: '3 tablettes',
    tablettes: { quantite: 3, modele: 'M107', prixUnitaireTTC: 119.9, numerosSerie: ['A1', ' ', 'A2', 'A3', 'A4'] },
    remarque: null,
  });
  assert.strictEqual(f.fournisseur, 'Cdiscount');
  assert.strictEqual(f.date, Date.UTC(2026, 9, 2, 12));
  assert.strictEqual(f.montant, 35970);
  assert.strictEqual(f.tva, 5995);
  assert.deepStrictEqual(f.tablettes, { quantite: 3, modele: 'M107', prixAchat: 11990, numeros: ['A1', 'A2', 'A3'] });
  // Valeurs absentes ou fantaisistes : rien plutôt qu'une erreur.
  const v = g.lectureVersFormulaire({ categorie: 'inconnue', date: 'hier', totalTTC: -3, tablettes: { quantite: 0 } });
  assert.strictEqual(v.categorie, 'autre');
  assert.strictEqual(v.date, null);
  assert.strictEqual(v.montant, null);
  assert.strictEqual(v.tablettes, null);
});

test('réglages de la gestion', () => {
  assert.strictEqual(g.lireReglages(undefined).seuilTva, 3750000);
  const r = g.lireReglages({ seuilTva: 4000000, tauxUrssaf: -1, forfaitSim: 'x' });
  assert.strictEqual(r.seuilTva, 4000000);
  assert.strictEqual(r.tauxUrssaf, 21.2);
  assert.strictEqual(r.forfaitSim, 700);
});

test('forfait SIM à résilier', () => {
  const J = 864e5, now = Date.UTC(2026, 9, 20);
  const ilYA = (jours) => [{ le: now - jours * J }];
  assert.strictEqual(g.simAResilier({ sim: null, etat: 'en-stock' }), false);
  assert.strictEqual(g.simAResilier({ sim: '0612', etat: 'en-stock' }), true);
  assert.strictEqual(g.simAResilier({ sim: '0612', etat: 'envoyee' }, { abonnement: 'actif' }), false);
  assert.strictEqual(g.simAResilier({ sim: '0612', etat: 'envoyee' }, { abonnement: 'resilie' }), true);
  assert.strictEqual(g.simAResilier({ sim: '0612', etat: 'en-retour' }, { restitution: { statut: 'rendue' } }), true);
  // Carte pas encore activée : elle ne coûte rien, pas d'alerte.
  assert.strictEqual(g.simAResilier({ simId: 's', etat: 'en-stock', historique: ilYA(90) }, null, { statut: 'stock' }, now), false);
  // Ligne active : alerte seulement après 30 jours sans client.
  assert.strictEqual(g.simAResilier({ simId: 's', etat: 'en-stock', historique: ilYA(10) }, null, { statut: 'active' }, now), false);
  assert.strictEqual(g.simAResilier({ simId: 's', etat: 'en-stock', historique: ilYA(31) }, null, { statut: 'active' }, now), true);
});

test('liste à faire du récapitulatif', () => {
  const maintenant = Date.UTC(2026, 9, 12);
  const liste = g.aFaire({
    maintenant,
    commandes: [
      { id: 'a', expedition: 'a-preparer' },
      { id: 'b', expedition: 'a-preparer' },
      { id: 'c', expedition: 'envoyee', envoyeeLe: maintenant - 25 * 864e5 },
      { id: 'd', expedition: 'annulee' },
    ],
    stock: [{ etat: 'en-stock', commande: null }, { etat: 'revenue', sim: '06' }],
    depenses: [{ date: maintenant - 864e5 }, { date: maintenant - 864e5, pieces: [{}] }],
    automatique: { erreurs: [] },
  });
  assert.deepStrictEqual(liste, [
    '2 tablettes à envoyer',
    '1 tablette manquante en stock pour les envoyer',
    '1 tablette reçue mais pas jumelée après 20 jours',
    '1 tablette revenue à vérifier',
    '1 forfait SIM payé depuis 30 jours pour une tablette sans client : à résilier ou suspendre',
    '1 dépense des 3 derniers mois sans justificatif',
  ]);
});

test('pièces jointes lues comme factures', () => {
  const ko = 1024;
  const pieces = g.piecesFacture([
    { contentType: 'application/pdf', size: 80 * ko },
    { contentType: 'image/png', size: 5 * ko }, // logo de signature
    { contentType: 'image/jpeg', size: 900 * ko, contentDisposition: 'inline' },
    { contentType: 'image/jpeg', size: 900 * ko, contentDisposition: 'attachment' },
    { contentType: 'application/zip', size: 80 * ko },
    { contentType: 'application/pdf', size: 9 * 1024 * ko },
  ]);
  assert.deepStrictEqual(pieces.map((p) => p.contentType), ['application/pdf', 'image/jpeg']);
  assert.deepStrictEqual(g.piecesFacture(undefined), []);
});

test('mois à Paris pour la clôture', () => {
  // Minuit à Paris : 23 h UTC la veille en hiver, 22 h en été.
  assert.strictEqual(new Date(g.debutMoisParis(2026, 1)).toISOString(), '2025-12-31T23:00:00.000Z');
  assert.strictEqual(new Date(g.debutMoisParis(2026, 7)).toISOString(), '2026-06-30T22:00:00.000Z');
  assert.strictEqual(new Date(g.debutMoisParis(2026, 13)).toISOString(), '2026-12-31T23:00:00.000Z');
  assert.deepStrictEqual(g.moisPrecedent(Date.parse('2026-11-01T03:00:00Z')), { annee: 2026, mois: 10 });
  // 31 décembre 23 h 30 UTC = déjà le 1er janvier à Paris.
  assert.deepStrictEqual(g.moisPrecedent(Date.parse('2026-12-31T23:30:00Z')), { annee: 2026, mois: 12 });
  assert.deepStrictEqual(g.moisPrecedent(Date.parse('2027-01-15T12:00:00Z')), { annee: 2026, mois: 12 });
});

test('livre des recettes et registre des achats', () => {
  assert.strictEqual(g.csvTexte(['a', 'b'], [['x;y', 'il dit "oui"'], [null, 3]]),
    '﻿a;b\r\n"x;y";"il dit ""oui"""\r\n;3\r\n');
  const le = Date.parse('2026-10-05T10:00:00Z');
  const r = g.livreDesRecettes([
    { id: 'txn_2', le: le + 1000, nature: 'remboursement', montant: -2000, frais: 0, net: -2000, source: 're_1' },
    { id: 'txn_1', le, nature: 'abonnement', montant: 5000, frais: 90, net: 4910, facture: 'in_1', client: 'Jean', source: 'ch_1' },
    { id: 'txn_3', le, nature: 'virement', montant: -4000, frais: 0, net: -4000 },
  ], new Map([['in_1', 'PAP-0001']]));
  assert.strictEqual(r.nombre, 2);
  assert.strictEqual(r.total, 3000);
  const lignes = r.csv.trim().split('\r\n');
  assert.strictEqual(lignes[1], '05/10/2026;PAP-0001;Jean;;Abonnement Papote;Carte bancaire (Stripe);50,00;0,90;49,10;ch_1');
  assert.ok(lignes[2].startsWith('05/10/2026;;;;Remboursement;'));
  assert.ok(lignes[3].includes(';30,00;'));
  const a = g.registreDesAchats([
    { date: Date.parse('2026-10-20T10:00:00Z'), fournisseur: 'Free', libelle: 'Forfait', categorie: 'sim', montant: 200 },
    { date: le, fournisseur: 'Cdiscount', numero: 'F1', libelle: 'Tablettes', categorie: 'tablettes', montant: 30000, tva: 5000,
      pieces: [{ nom: 'f1.pdf' }] },
  ]);
  assert.strictEqual(a.total, 30200);
  assert.strictEqual(a.csv.trim().split('\r\n')[1], '05/10/2026;Cdiscount;F1;Tablettes;Achat de tablettes;300,00;50,00;f1.pdf');
});

test('le stock suit les commandes', () => {
  const partie = { etat: 'envoyee', commande: 'sub_1' };
  assert.strictEqual(g.stockAJour(partie, undefined), null);
  assert.strictEqual(g.stockAJour(partie, { expedition: 'envoyee', fid: null }), null);
  assert.deepStrictEqual(g.stockAJour(partie, { expedition: 'envoyee', fid: 'f1' }), { etat: 'chez-client' });
  assert.strictEqual(g.stockAJour({ etat: 'chez-client' }, { fid: 'f1' }), null);
  assert.deepStrictEqual(g.stockAJour({ etat: 'chez-client' }, { fid: 'f1', restitution: { statut: 'facturee' } }), { etat: 'perdue' });
  assert.deepStrictEqual(g.stockAJour({ etat: 'en-retour' }, { restitution: { statut: 'rendue' } }), { etat: 'revenue' });
  assert.strictEqual(g.stockAJour({ etat: 'revenue' }, { restitution: { statut: 'rendue' } }), null);
  assert.deepStrictEqual(g.stockAJour({ etat: 'preparee' }, { expedition: 'annulee' }), { etat: 'en-stock', commande: null });
  assert.strictEqual(g.stockAJour({ etat: 'envoyee' }, { expedition: 'annulee' }), null);
});

test('cartes SIM : coût et alertes', () => {
  const J = 24 * 3600 * 1000;
  const now = Date.parse('2026-10-13T12:00:00Z');
  assert.strictEqual(g.coutLigne({ prix: 299, prixApres: 999, finPromo: now + J }, now), 299);
  assert.strictEqual(g.coutLigne({ prix: 299, prixApres: 999, finPromo: now - J }, now), 999);
  assert.strictEqual(g.coutLigne({}, now), null);
  assert.deepStrictEqual(g.alertesSim({ statut: 'active', prix: 299 }, now), []);
  assert.deepStrictEqual(g.alertesSim({ statut: 'active', finPromo: now + 10 * J }, now), ['promo finie dans 10 j']);
  assert.deepStrictEqual(g.alertesSim({ statut: 'active', prix: 299, prixApres: 999, finPromo: now - J }, now), ['promo terminée']);
  assert.deepStrictEqual(g.alertesSim({ statut: 'stock', activerAvant: now + 20 * J }, now), ['à activer dans les 20 j']);
  assert.deepStrictEqual(g.alertesSim({ statut: 'stock', activerAvant: now - J }, now), ['date limite d\'activation dépassée']);
  assert.deepStrictEqual(g.alertesSim({ statut: 'active', cb: '1234', cbExp: '2026-11' }, now), ['carte bancaire 1234 expire dans 49 j']);
  assert.deepStrictEqual(g.alertesSim({ statut: 'active', cbExp: '2026-09' }, now), ['carte bancaire expirée']);
  assert.deepStrictEqual(g.alertesSim({ statut: 'resiliee', cbExp: '2026-09' }, now), []);
  assert.deepStrictEqual(g.champsSim({ iccid: '8933 0123 4567', cb: '4970 1234 5678 9012', prix: 299, go: 50, cbExp: 'x' }),
    { iccid: '893301234567', cb: '9012', prix: 299, go: 50, cbExp: null });
});

test('forfaits SIM prépayés : rappel de recharge et facture rangée sur sa ligne', () => {
  const J = 24 * 3600 * 1000;
  const now = Date.UTC(2026, 9, 28, 10);
  const lyca = { statut: 'active', operateur: 'Lyca Mobile', prix: 499 };
  assert.deepStrictEqual(g.alertesSim({ ...lyca, prochaineRecharge: now + 10 * J }, now), []);
  assert.deepStrictEqual(g.alertesSim({ ...lyca, prochaineRecharge: now + 2.5 * J }, now), ['à recharger dans 3 j']);
  assert.deepStrictEqual(g.alertesSim({ ...lyca, prochaineRecharge: now + 1000 }, now), ['à recharger dans 1 j']);
  assert.deepStrictEqual(g.alertesSim({ ...lyca, prochaineRecharge: now - 1000 }, now), ['à recharger aujourd\'hui']);
  assert.deepStrictEqual(g.alertesSim({ ...lyca, prochaineRecharge: now - 2 * J }, now), ['forfait fini : à recharger']);
  // Renouvelé par l'opérateur : rien tant que la recharge peut encore arriver.
  assert.deepStrictEqual(g.alertesSim({ ...lyca, renouvellementAuto: true, prochaineRecharge: now - J }, now), []);
  assert.deepStrictEqual(g.alertesSim({ ...lyca, renouvellementAuto: true, prochaineRecharge: now - 3 * J }, now),
    ['renouvellement pas vu : vérifier chez l\'opérateur']);
  // Carte en stock ou résiliée : aucun rappel.
  assert.deepStrictEqual(g.alertesSim({ ...lyca, statut: 'stock', prochaineRecharge: now - 2 * J }, now), []);
  assert.deepStrictEqual(g.alertesSim({ ...lyca, statut: 'resiliee', prochaineRecharge: now - 2 * J }, now), []);

  assert.strictEqual(g.finApresRecharge({}, now), now + 30 * J);
  assert.strictEqual(g.finApresRecharge({ dureeForfait: 28 }, now), now + 28 * J);
  // Facture arrivée en retard : la fin déjà notée ne recule pas.
  assert.strictEqual(g.finApresRecharge({ prochaineRecharge: now + 40 * J }, now - 20 * J), now + 40 * J);

  assert.deepStrictEqual(g.champsSim({ prochaineRecharge: now, dureeForfait: 30, renouvellementAuto: true }),
    { prochaineRecharge: now, dureeForfait: 30, renouvellementAuto: true });
  assert.deepStrictEqual(g.champsSim({ dureeForfait: 0, renouvellementAuto: 'oui' }), { dureeForfait: null, renouvellementAuto: false });

  const sims = [
    { id: 'a', statut: 'active', operateur: 'Lyca', numero: '07 51 23 45 67', iccid: '8944110068251234567' },
    { id: 'b', statut: 'active', operateur: 'YouPrice', numero: '06 12 34 56 78' },
    { id: 'c', statut: 'resiliee', operateur: 'Lyca', numero: '07 00 00 00 00' },
  ];
  assert.strictEqual(g.simDeFacture(sims, { ligne: '+33 7 51 23 45 67', fournisseur: 'Lycamobile' }).id, 'a');
  assert.strictEqual(g.simDeFacture(sims, { ligne: '8944 1100 6825 1234 567' }).id, 'a');
  assert.strictEqual(g.simDeFacture(sims, { ligne: null, fournisseur: 'Lyca Mobile France' }).id, 'a');
  assert.strictEqual(g.simDeFacture(sims, { ligne: '07 00 00 00 00', fournisseur: 'Lyca' }), null);
  assert.strictEqual(g.simDeFacture(sims, { ligne: null, fournisseur: 'Free' }), null);
  // Deux lignes actives chez le même opérateur sans numéro sur la facture : à relier à la main.
  assert.strictEqual(g.simDeFacture([...sims, { id: 'd', statut: 'active', operateur: 'Lyca' }], { fournisseur: 'Lyca' }), null);
  assert.strictEqual(g.lectureVersFormulaire({ estUneFacture: true, categorie: 'sim', ligneMobile: '07 51 23 45 67' }).ligne, '07 51 23 45 67');
});

test('garde-fou du forfait recopié sur la famille', () => {
  // Pass de 30 jours qui finit le 27/11 à 10 h (Paris) : commencé le 28/10.
  assert.deepStrictEqual(g.forfaitFamille({ go: 1, prochaineRecharge: Date.UTC(2026, 10, 27, 9) }), { mo: 1000, debut: '2026-10-28' });
  assert.deepStrictEqual(g.forfaitFamille({ go: 2, dureeForfait: 28, prochaineRecharge: Date.UTC(2026, 10, 25, 9) }), { mo: 2000, debut: '2026-10-28' });
  // Juste avant minuit à Paris (23 h 30 en hiver = 22 h 30 UTC) : le jour de Paris.
  assert.deepStrictEqual(g.forfaitFamille({ derniereRecharge: Date.UTC(2026, 9, 30, 23, 30) }), { mo: 1000, debut: '2026-10-31' });
  assert.deepStrictEqual(g.forfaitFamille({ go: 0.5, activation: Date.UTC(2026, 9, 30, 12) }), { mo: 500, jour: 28 });
  assert.deepStrictEqual(g.forfaitFamille({ activation: Date.UTC(2026, 9, 12, 12) }), { mo: 1000, jour: 12 });
  assert.deepStrictEqual(g.forfaitFamille({}), { mo: 1000, jour: 1 });
});

test('accessoires à prévoir pour les envois', () => {
  const aEnvoyer = [{ formule: 'sim' }, { formule: 'sim' }, { formule: 'wifi' }];
  const r = g.accessoiresAPrevoir([
    { nom: 'Clé 4G', parEnvoi: 'sim', quantite: 1 },
    { nom: 'Prise USB', parEnvoi: 'tous', quantite: 10, seuil: 7 },
    { nom: 'Câble', parEnvoi: 'tous', quantite: 10, seuil: 2 },
    { nom: 'Support', parEnvoi: '', quantite: 0 },
  ], aEnvoyer);
  assert.deepStrictEqual(r.map((a) => [a.nom, a.besoin, a.manque, a.bas]), [['Clé 4G', 2, 1, false], ['Prise USB', 3, 0, true]]);
});

test('cartes SIM et accessoires lus sur une facture', () => {
  const r = g.lectureVersFormulaire({
    estUneFacture: true, totalTTC: 60, categorie: 'sim', libelle: 'Kits SIM',
    cartesSim: { quantite: 2, operateur: 'YouPrice', iccids: ['8933 0100 0000 0000 001', '8933010000000000002', 'en trop'], numeros: [],
      prixCarteTTC: 10, forfaitMensuelTTC: 2.99 },
    accessoires: [{ nom: 'Clé 4G USB', quantite: 3, prixUnitaireTTC: 9.9 }, { nom: '', quantite: 1, prixUnitaireTTC: 1 }],
  });
  assert.deepStrictEqual(r.cartesSim, {
    quantite: 2, operateur: 'YouPrice', iccids: ['8933010000000000001', '8933010000000000002'], numeros: [], prixCarte: 1000, forfait: 299,
  });
  assert.deepStrictEqual(r.accessoires, [{ nom: 'Clé 4G USB', quantite: 3, prixUnitaire: 990 }]);
  assert.strictEqual(g.lectureVersFormulaire({ cartesSim: null }).cartesSim, null);
  // Depuis la page : montants déjà en centimes.
  assert.strictEqual(g.materielLu({ cartesSim: { quantite: 1, iccids: [], numeros: [], forfait: 299 } }, true).cartesSim.forfait, 299);
  assert.ok(g.memeAccessoire('Clé 4G', 'Clé USB 4G LTE'));
  assert.ok(g.memeAccessoire('cle 4g', 'Clé 4G'));
  assert.ok(!g.memeAccessoire('Prise USB double', 'Clé 4G USB'));
});

test('clients, tablettes et SIM qui ne collent pas', () => {
  const r = g.incoherences({
    commandes: [{ id: 'c1', formule: 'sim' }, { id: 'c2', formule: 'sim' }, { id: 'c3', formule: 'wifi' }],
    stock: [{ commande: 'c1', etat: 'chez-client', sim: null }, { commande: 'c2', etat: 'envoyee', sim: '06' }, { commande: 'c3', etat: 'envoyee' }],
    sims: [{ statut: 'active', tablette: null }, { statut: 'active', tablette: 't' }, { statut: 'stock', tablette: null }],
  });
  assert.deepStrictEqual(r, ['1 client Internet inclus sans carte SIM notée sur sa tablette', '1 ligne SIM active reliée à aucune tablette']);
});

// ---------- Étiquettes Sendcloud ----------
const sendcloud = require('./sendcloud');

test('adresse Sendcloud du client : point relais ou adresse Stripe', () => {
  const relais = sendcloud.adresseClient({ nom: 'Jeanne', email: 'j@x.fr', livraison: { transporteur: 'mondial-relay', id: '123', nom: 'Tabac', adresse: '1 rue', cp: '75001', ville: 'Paris', pays: 'FR' } });
  assert.equal(relais.pointRelais, '123');
  assert.equal(relais.adresse.postal_code, '75001');
  assert.equal(relais.adresse.email, 'j@x.fr');
  assert.equal(relais.adresse.name, 'Jeanne');
  const retrait = sendcloud.adresseClient({ nom: 'Jeanne', livraison: { transporteur: 'mondial-relay', id: '123', cp: '75001', ville: 'Paris', destinataire: 'Marc Dupont' } });
  assert.equal(retrait.adresse.name, 'Marc Dupont');
  const maison = sendcloud.adresseClient({ email: 'a@x.fr', livraison: { nom: 'Paul', adresse: { line1: '2 av', postal_code: '69001', city: 'Lyon', country: 'FR' } } });
  assert.equal(maison.pointRelais, null);
  assert.equal(maison.adresse.name, 'Paul');
  assert.equal(sendcloud.adresseClient({ livraison: null }), null);
});

test('adresse de Papote complète obligatoire', () => {
  assert.equal(sendcloud.adressePapote({ nom: 'Papote', adresse: '', cp: '1', ville: 'x' }), null);
  assert.equal(sendcloud.adressePapote({ nom: 'Papote', adresse: '3 rue', cp: '35000', ville: 'Rennes' }).country_code, 'FR');
});

test('choix de l\'offre Mondial Relay selon le poids et le besoin', () => {
  const poids = (min, max) => ({ min: { value: String(min), unit: 'kg' }, max: { value: String(max), unit: 'kg' } });
  const options = [
    { code: 'colissimo:x', carrier: { code: 'colissimo' }, functionalities: { last_mile: 'service_point' }, weight: poids(0, 30) },
    { code: 'mr:petit', carrier: { code: 'mondial_relay' }, functionalities: { last_mile: 'service_point' }, weight: poids(0, 1) },
    { code: 'mr:relais', carrier: { code: 'mondial_relay' }, functionalities: { last_mile: 'service_point' }, weight: poids(1, 30) },
    { code: 'mr:retour', carrier: { code: 'mondial_relay' }, functionalities: { returns: true, last_mile: 'service_point' }, weight: poids(0, 30) },
    { code: 'mr:domicile', carrier: { code: 'mondial_relay' }, functionalities: { last_mile: 'home_delivery' }, weight: poids(0, 30) },
  ];
  assert.equal(sendcloud.choisirOption(options, 1.5, 'relais').code, 'mr:relais');
  assert.equal(sendcloud.choisirOption(options, 1.5, 'retour').code, 'mr:retour');
  assert.equal(sendcloud.choisirOption(options, 1.5, 'domicile').code, 'mr:domicile');
  assert.equal(sendcloud.choisirOption(options, 40, 'relais'), null);
});

test('erreurs Sendcloud lisibles', () => {
  assert.equal(sendcloud.erreurLisible({ errors: [{ field: 'to_address.postal_code', detail: 'invalide' }] }), 'to_address.postal_code : invalide');
  assert.equal(sendcloud.erreurLisible({ error: { message: 'Contrat absent' } }), 'Contrat absent');
});

test('une tablette réservée à une commande à envoyer compte pour elle', () => {
  const liste = g.aFaire({
    maintenant: Date.UTC(2026, 9, 12),
    commandes: [{ id: 'a', expedition: 'a-preparer' }],
    stock: [{ etat: 'en-stock', commande: 'a' }],
    depenses: [],
    automatique: { erreurs: [] },
  });
  assert.deepStrictEqual(liste, ['1 tablette à envoyer']);
});

test('confirmation de commande lue dans le corps de l\'e-mail', () => {
  const html = `<html><style>p{color:red}</style><body><p>Merci pour votre commande n° 123&nbsp;!</p>${'<p>Tablette 10 pouces x2 — 159,80 &euro;</p>'.repeat(5)}</body></html>`;
  const p = g.corpsDuMail({ html, subject: 'Votre commande Cdiscount', from: { text: 'Cdiscount <ne-pas-repondre@cdiscount.com>' }, date: new Date(Date.UTC(2026, 9, 13)) });
  const t = p.content.toString('utf8');
  assert.strictEqual(p.contentType, 'text/plain');
  assert.match(t, /Objet : Votre commande Cdiscount/);
  assert.match(t, /159,80 €/);
  assert.doesNotMatch(t, /color:red|<p>/);
  assert.strictEqual(g.corpsDuMail({ text: 'Bonjour' }), null);
});

test('la facture rejoint la confirmation du même achat', () => {
  const jour = 864e5;
  const conf = { confirmation: true, fournisseur: 'CDISCOUNT', montant: 15980, date: Date.UTC(2026, 9, 1) };
  assert.ok(g.memeAchat(conf, { fournisseur: 'Cdiscount', montant: 15980, date: conf.date + 10 * jour }));
  assert.ok(!g.memeAchat(conf, { fournisseur: 'Cdiscount', montant: 15990, date: conf.date }));
  assert.ok(!g.memeAchat(conf, { fournisseur: 'Temu', montant: 15980, date: conf.date }));
  assert.ok(!g.memeAchat({ ...conf, confirmation: false }, { fournisseur: 'Cdiscount', montant: 15980, date: conf.date }));
  assert.ok(!g.memeAchat(conf, { fournisseur: 'Cdiscount', montant: 15980, date: conf.date + 40 * jour }));
});

test('rappel des factures à télécharger après une confirmation de commande', () => {
  const maintenant = Date.UTC(2026, 9, 20);
  const liste = g.aFaire({
    maintenant,
    commandes: [],
    stock: [],
    depenses: [
      { date: maintenant - 10 * 864e5, confirmation: true, fournisseur: 'Cdiscount', numero: '123', pieces: [{}] },
      { date: maintenant - 864e5, confirmation: true, fournisseur: 'Temu', pieces: [{}] },
    ],
    automatique: { erreurs: [] },
  });
  assert.deepStrictEqual(liste, ['Facture à télécharger chez le vendeur puis à envoyer à factures@ : Cdiscount (commande 123)']);
});

test('suite du jumelage d\'une tablette du stock', () => {
  assert.deepStrictEqual(g.suiteJumelage({ etat: 'perdue', commande: 'c' }, { fid: null }, 'f'), { refuser: true });
  assert.deepStrictEqual(g.suiteJumelage({ etat: 'envoyee', commande: 'c' }, { fid: null }, 'f'), { relier: true });
  assert.deepStrictEqual(g.suiteJumelage({ etat: 'envoyee', commande: 'c' }, { fid: 'f' }, 'f'), {});
  assert.deepStrictEqual(g.suiteJumelage({ etat: 'envoyee', commande: 'c' }, { fid: 'autre' }, 'f'),
    { alerte: 'jumelée à une autre famille que celle de sa commande' });
  assert.deepStrictEqual(g.suiteJumelage({ etat: 'preparee', commande: null }, null, 'f'), { alerte: 'jumelée sans commande' });
});

test('clients : fusion par e-mail, statut et accord pour les e-mails', () => {
  const { fusionnerContacts } = g;
  const liste = fusionnerContacts({
    commandes: [
      { email: 'Jeanne@X.fr', nom: 'Jeanne Martin', fid: 'f1', formule: 'wifi', creeLe: 2000, marketing: true },
      { email: 'paul@x.fr', nom: 'Paul', fid: 'f2', creeLe: 1000 },
      { email: 'annule@x.fr', expedition: 'annulee', creeLe: 500, marketing: true },
    ],
    paniers: [
      { email: 'jeanne@x.fr', creeLe: 100 },
      { email: 'prospect@x.fr', nom: 'Léa', creeLe: 3000, marketing: true },
    ],
    contacts: [
      { email: 'paul@x.fr', consentement: true },
      { email: 'annule@x.fr', consentement: false, desinscritLe: 9 },
      { email: 'inconnu@x.fr', jeton: 'a' },
      { email: 'curieux@x.fr', nom: 'Marc Petit', telephone: '0612345678', chatLe: 50, chatDepuis: 40 },
      { email: 'jeanne@x.fr', nom: 'Autre nom', chatLe: 60 },
    ],
    statutFamille: (fid) => ({ f1: 'actif', f2: 'resilie' }[fid]),
  });
  const par = Object.fromEntries(liste.map((c) => [c.email, c]));
  assert.equal(liste.length, 5);
  assert.equal(par['curieux@x.fr'].type, 'chat');
  assert.equal(par['curieux@x.fr'].telephone, '0612345678');
  assert.equal(par['curieux@x.fr'].depuis, 40);
  assert.equal(par['curieux@x.fr'].consentement, false);
  assert.equal(par['jeanne@x.fr'].nom, 'Jeanne Martin');
  assert.equal(par['jeanne@x.fr'].type, 'client');
  assert.equal(par['jeanne@x.fr'].consentement, true);
  assert.equal(par['paul@x.fr'].type, 'ancien');
  assert.equal(par['paul@x.fr'].consentement, true);
  assert.equal(par['annule@x.fr'].desinscrit, true);
  assert.equal(par['annule@x.fr'].consentement, false);
  assert.equal(par['prospect@x.fr'].type, 'panier');
  assert.equal(liste[0].email, 'prospect@x.fr');
});

test('e-mail d\'information : prénom, paragraphes échappés, lien de désinscription', () => {
  const m = g.emailInformation({ objet: ' Nouveauté ', message: 'Bonjour {prenom},\n\n<b>Une</b> nouvelle', nom: 'Jeanne Martin', lienDesinscription: 'https://x/d?c=1' });
  assert.equal(m.subject, 'Nouveauté');
  assert.match(m.html, /Bonjour Jeanne,/);
  assert.match(m.html, /&lt;b&gt;Une/);
  assert.match(m.text, /Se désinscrire : https:\/\/x\/d\?c=1/);
  assert.equal(m.headers['List-Unsubscribe'], '<https://x/d?c=1>');
  assert.equal(g.cleContact('A@x.fr'), g.cleContact(' a@x.fr '));
});

test('matériel non rendu : nature du prélèvement et ligne de facture', () => {
  assert.equal(g.natureMouvement({ type: 'charge', source: { description: 'Tablette Papote non rendue' } }), 'tablette-non-rendue');
  assert.equal(g.natureMouvement({ type: 'charge', source: { description: 'Matériel Papote non rendu : routeur, chargeur' } }), 'tablette-non-rendue');
  assert.equal(g.descriptionNonRendu({ description: 'Matériel Papote non rendu : routeur' }), 'Matériel Papote non rendu : routeur (indemnité prévue au contrat)');
  assert.equal(g.descriptionNonRendu({}), 'Matériel Papote non rendu (indemnité prévue au contrat)');
});

test('suppression de famille : Mamie protégée, abonnement en cours refusé, nom à retaper', () => {
  assert.equal(g.refusSuppression({ name: 'Mamie', abonnement: { statut: 'offert' } }, 'Mamie'), null);
  assert.match(g.refusSuppression({ name: 'Durand', abonnement: { statut: 'actif' } }, 'Durand'), /résiliez/);
  assert.match(g.refusSuppression({ name: 'Durand', abonnement: { statut: 'resilie' } }, 'Dupont'), /ne correspond pas/);
  assert.match(g.refusSuppression({ name: 'Durand' }, ''), /ne correspond pas/);
  assert.equal(g.refusSuppression({ name: 'Famille Hélène', abonnement: { statut: 'aucun' } }, ' famille  helene '), null);
});

test('avancement des parcours nettoyé', () => {
  const a = g.avancementPropre({ etape: 99, faits: { carton: 5, 'pas bien!': 3, routeur: 'x' }, fini: 0, tablette: 'abc', autre: 'x' }, ['tablette']);
  assert.deepEqual(a, { etape: 30, faits: { carton: 5 }, fini: null, tablette: 'abc' });
  assert.deepEqual(g.avancementPropre(null), { etape: 0, faits: {}, fini: null });
});

test('batterie : relevé de la tablette et usure', () => {
  const b = g.releveBatterie({ battery: { level: 80, charging: true, health: 'bonne', temperature: 31.5, at: 5 }, lastSeen: 4 });
  assert.deepStrictEqual(b, { niveau: 80, enCharge: true, sante: 'bonne', temperature: 31.5, cycles: null, le: 5, vueLe: 4, enLigneLe: null });
  assert.strictEqual(g.usureBatterie(b), null);
  assert.strictEqual(g.usureBatterie(null), null);
  assert.strictEqual(g.usureBatterie({ sante: 'morte' }), 'batterie morte');
  assert.strictEqual(g.usureBatterie({ sante: 'bonne', cycles: 650 }), 'batterie usée (650 cycles)');
  assert.strictEqual(g.usureBatterie({ sante: 'surchauffe', cycles: 120 }), null);
  // Compteur aberrant ignoré : plus de 1 500 cycles, ou plus de 2 par jour depuis l'achat.
  assert.strictEqual(g.usureBatterie({ sante: 'bonne', cycles: 2235 }), null);
  const maintenant = Date.parse('2026-10-27T12:00:00Z');
  assert.strictEqual(g.usureBatterie({ cycles: 650 }, maintenant - 10 * 864e5, maintenant), null);
  assert.strictEqual(g.usureBatterie({ cycles: 650 }, maintenant - 400 * 864e5, maintenant), 'batterie usée (650 cycles)');
});

test('à faire : tablette revenue avec une batterie usée', () => {
  const liste = g.aFaire({
    commandes: [], depenses: [], automatique: null, maintenant: Date.now(),
    stock: [{ ref: 'T-004', etat: 'revenue', batterie: { sante: 'panne' } }, { ref: 'T-005', etat: 'chez-client', batterie: { sante: 'panne' } }],
  });
  assert.ok(liste.includes('Tablette T-004 revenue : batterie en panne, à retirer du parc'));
  assert.ok(!liste.some((l) => l.includes('T-005')));
});

test('achat enregistré après l\'installation : complète les fiches sans facture', () => {
  const sans = [{ id: 'b', creeLe: 2, serieAndroid: 'AK26 0612' }, { id: 'a', creeLe: 1 }];
  assert.deepStrictEqual(g.fichesARattacher(sans, ['ak260612'], 1), ['b']);
  assert.deepStrictEqual(g.fichesARattacher(sans, [], 1), ['a']);
  assert.deepStrictEqual(g.fichesARattacher(sans, ['X', '', 'Y'], 3), ['a', 'b', null]);
  assert.deepStrictEqual(g.fichesARattacher([], ['X'], 2), [null, null]);
  // Tablette déjà envoyée à un client : seulement par son n° de série.
  const partie = [{ id: 'c', creeLe: 1, etat: 'envoyee', commande: 'cmd', numero: 'S1' }];
  assert.deepStrictEqual(g.fichesARattacher(partie, [], 1), [null]);
  assert.deepStrictEqual(g.fichesARattacher(partie, ['s1'], 1), ['c']);
});

test('tablette reçue sans facture depuis 5 jours', () => {
  const maintenant = Date.UTC(2026, 9, 20);
  const vieille = maintenant - 6 * 86400000;
  assert.strictEqual(g.sansFacture({ etat: 'en-stock', prixAchat: null, creeLe: vieille }, maintenant), true);
  assert.strictEqual(g.sansFacture({ etat: 'preparee', prixAchat: null, preparee: maintenant - 86400000 }, maintenant), false);
  assert.strictEqual(g.sansFacture({ etat: 'en-stock', prixAchat: 8000, creeLe: vieille }, maintenant), false);
  assert.strictEqual(g.sansFacture({ etat: 'perdue', prixAchat: null, creeLe: vieille }, maintenant), false);
});

test('colis livré d\'après Sendcloud', () => {
  const { colisLivre } = require('./sendcloud');
  assert.strictEqual(colisLivre({ parcel: { status: { id: 11, message: 'Delivered' } } }), true);
  assert.strictEqual(colisLivre({ parcel: { status: { id: 12, message: 'Awaiting customer pickup' } } }), false);
  assert.strictEqual(colisLivre(null), false);
});

test('suiviColis : n° et lien de suivi, étape, livré', () => {
  const { suiviColis } = require('./sendcloud');
  assert.deepStrictEqual(suiviColis({ parcel: { tracking_number: 'MR1', tracking_url: 'https://t/MR1', status: { id: 12, message: 'Awaiting customer pickup' } } }),
    { suivi: 'MR1', lien: 'https://t/MR1', etape: 'Awaiting customer pickup', statut: 12, livre: false });
  assert.deepStrictEqual(suiviColis(null), { suivi: null, lien: null, etape: null, statut: null, livre: false });
});

test('retour sans impression : seulement les offres de retour « labelless » ; colis pas encore déposé', () => {
  const { optionsPossibles, nonDepose } = require('./sendcloud');
  const kgs = { min: { value: '0', unit: 'kg' }, max: { value: '30', unit: 'kg' } };
  const options = [
    { code: 'mr:retour', carrier: { code: 'mondial_relay' }, functionalities: { returns: true }, weight: kgs },
    { code: 'mr:retour-qr', carrier: { code: 'mondial_relay' }, functionalities: { returns: true, labelless: true }, weight: kgs },
  ];
  assert.deepStrictEqual(optionsPossibles(options, 1.5, 'retour-qr').map((o) => o.code), ['mr:retour-qr']);
  assert.strictEqual(optionsPossibles(options, 1.5, 'retour').length, 2);
  assert.strictEqual(nonDepose(1000), true, 'Ready to send');
  assert.strictEqual(nonDepose(999), true, 'No label');
  assert.strictEqual(nonDepose(3), false, 'en route : déposé');
  assert.strictEqual(nonDepose(11), false, 'livré');
  assert.strictEqual(nonDepose(null), false);
});

test('transitionPermise : la vie logique d\'une tablette, sans retour en arrière', () => {
  assert.equal(g.transitionPermise('commandee', 'en-stock'), true);
  assert.equal(g.transitionPermise('en-stock', 'commandee'), false);
  assert.equal(g.transitionPermise('revenue', 'en-stock'), true);
  assert.equal(g.transitionPermise('chez-client', 'en-stock'), false);
  assert.equal(g.transitionPermise('hors-service', 'en-stock'), false);
  assert.equal(g.transitionPermise('en-stock', 'en-stock'), true);
});

test('à faire : l\'argent d\'abord (familles impayées ou suspendues, prélèvements refusés, SEPA en attente, contestations, colis revenu)', () => {
  const maintenant = Date.UTC(2026, 9, 27, 12);
  const j = (n) => maintenant - n * 864e5;
  const liste = g.aFaire({
    maintenant,
    familles: [
      { id: 'f1', nom: 'Mamie Emma', statut: 'impaye', graceJusqua: maintenant + 3 * 864e5 },
      { id: 'f2', nom: 'Papi Jean', statut: 'suspendu', suspenduLe: j(12) },
      { id: 'f3', nom: 'Mamie B', statut: 'suspendu', suspenduLe: j(31) },
      { id: 'f4', nom: 'Actif', statut: 'actif' },
    ],
    commandes: [
      { id: 'a', expedition: 'envoyee', fid: 'f4', dernierMois: { statut: 'echec' } },
      { id: 'b', expedition: 'envoyee', fid: 'f4', restitution: { statut: 'echec' } },
      { id: 'c', expedition: 'paiement-en-attente', creeLe: j(11) },
      { id: 'd', expedition: 'paiement-en-attente', creeLe: j(2) },
      { id: 'e', expedition: 'annulee', contestations: [{ id: 'dp_1' }] },
      { id: 'g', nom: 'Paul Martin', expedition: 'envoyee', fid: null, envoyeeLe: j(12), etiquettes: { aller: { colis: 1, retourExpediteur: true } } },
    ],
    stock: [],
    depenses: [],
    automatique: { erreurs: [] },
  });
  assert.deepStrictEqual(liste, [
    '1 famille en retard de paiement : Mamie Emma (pause le 30 octobre)',
    'Famille Papi Jean suspendue pour impayé depuis 12 jours',
    'Famille Mamie B suspendue pour impayé depuis 31 jours : demander le retour de la tablette (« Arrêter l\'abonnement » sur la commande)',
    '1 dernier mois refusé par la banque, à relancer depuis Stripe',
    '1 prélèvement du matériel non rendu refusé, à relancer depuis Stripe',
    '1 paiement SEPA en attente depuis plus de 10 jours',
    '1 commande avec un prélèvement contesté à la banque',
    'Colis de Paul Martin en retour chez vous (jamais retiré) : « Colis revenu » sur la commande l\'annule et rembourse',
    '1 tablette à récupérer',
  ]);
});

test('colis renvoyé à l\'expéditeur d\'après l\'étape Sendcloud', () => {
  assert.strictEqual(sendcloud.retourExpediteur('Returned to sender'), true);
  assert.strictEqual(sendcloud.retourExpediteur('Return to sender'), true);
  assert.strictEqual(sendcloud.retourExpediteur('Retour à l\'expéditeur'), true);
  assert.strictEqual(sendcloud.retourExpediteur('Delivered'), false);
  assert.strictEqual(sendcloud.retourExpediteur(null), false);
});

test('Stripe en mode test : seuls les essais encore en base sont comptés', () => {
  const factures = [{ id: 'in_1', abonnement: 'sub_garde' }, { id: 'in_2', abonnement: 'sub_efface' }, { id: 'in_3', abonnement: null }];
  const mouvements = [{ id: 'm1', facture: 'in_1' }, { id: 'm2', facture: 'in_2' }, { id: 'm3', facture: null }];
  const abonnements = [{ id: 'sub_garde' }, { id: 'sub_efface' }];
  const commandes = new Set(['sub_garde']);
  const r = g.sansEssaisEffaces({ factures, mouvements, abonnements, test: true, commandes });
  assert.deepStrictEqual(r.factures.map((f) => f.id), ['in_1']);
  assert.deepStrictEqual(r.mouvements.map((m) => m.id), ['m1']);
  assert.deepStrictEqual(r.abonnements.map((a) => a.id), ['sub_garde']);
  const reel = g.sansEssaisEffaces({ factures, mouvements, abonnements, test: false, commandes });
  assert.strictEqual(reel.factures.length, 3);
  assert.strictEqual(reel.mouvements.length, 3);
});

test('garde-fous : lignes « GARDE-FOU » du journal de la tablette, par sorte, datées à l\'heure de Paris', () => {
  const journal = [
    '29/10 14:02:11  Forfait SIM : 300 Mo sur 1000, palier 0 (normal)',
    '29/10 14:05:00  GARDE-FOU : écran bloqué 3 min (diaporama), retour à l’accueil',
    '29/10 15:10:00  GARDE-FOU : la page ne répond plus depuis 3 min, rechargée (1/3)',
    '29/10 15:20:00  GARDE-FOU : la page ne répond plus depuis 30 s, moteur relancé',
    '29/10 15:30:00  GARDE-FOU : page morte, 3 relances en 30 min : la tablette redémarre',
    '29/10 15:31:00  GARDE-FOU : redémarrage impossible (SecurityException), Papote relancée',
    '29/10 15:32:00  GARDE-FOU : la page ne répond plus, « en ligne » n\'est plus envoyé',
    '31/12 23:59:00  GARDE-FOU : écran bloqué 3 min (rappel), retour à l’accueil',
  ].join('\n');
  const maintenant = Date.parse('2026-10-29T15:00:00Z');
  const l = g.gardeFous(journal, maintenant);
  assert.deepStrictEqual(l.map((x) => x.genre), ['autre', 'appli', 'redemarrage', 'page', 'page', 'ecran', 'ecran']);
  // 15:32 à Paris le 29/10 (heure d'hiver depuis le 25/10) = 14:32 UTC.
  assert.strictEqual(new Date(l[0].le).toISOString(), '2026-10-29T14:32:00.000Z');
  // 31/12 vu le 29/10 : l'année d'avant.
  assert.strictEqual(new Date(l[l.length - 1].le).toISOString(), '2025-12-31T22:59:00.000Z');
  assert.deepStrictEqual(g.gardeFous('', maintenant), []);
  assert.deepStrictEqual(g.gardeFous(undefined, maintenant), []);
});
