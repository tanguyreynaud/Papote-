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
  assert.strictEqual(g.simAResilier({ sim: null, etat: 'en-stock' }), false);
  assert.strictEqual(g.simAResilier({ sim: '0612', etat: 'en-stock' }), true);
  assert.strictEqual(g.simAResilier({ sim: '0612', etat: 'envoyee' }, { abonnement: 'actif' }), false);
  assert.strictEqual(g.simAResilier({ sim: '0612', etat: 'envoyee' }, { abonnement: 'resilie' }), true);
  assert.strictEqual(g.simAResilier({ sim: '0612', etat: 'en-retour' }, { restitution: { statut: 'rendue' } }), true);
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
    '1 forfait SIM à résilier ou suspendre',
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
