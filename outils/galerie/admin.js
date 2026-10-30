// Écrans de l'admin (web/admin.html) sur un ordinateur et un téléphone. Firebase est remplacé par faux-firebase.js
// (connecté en admin) et les fonctions de gestion (gestionDonnees, gestionStripe, gestionClients…) par de fausses
// réponses écrites ici : de fausses commandes, tablettes, cartes SIM et dépenses. Rien ne part sur internet.
'use strict';

const { famillePleine, membre, poserDonnees, SDK, ilYa, FID } = require('./famille');
const clavier = require('./clavier');

const TAILLES = {
  pc: { nom: 'ordinateur', width: 1280, height: 800, mobile: false },
  tel: { nom: 'telephone', width: 390, height: 844, mobile: true },
};
const MAINTENANT = new Date('2026-10-26T10:30:00+01:00').getTime();
const J = 864e5;
const il = (jours) => MAINTENANT - jours * J; // il y a n jours (négatif : dans n jours)
const ADMIN = { uid: 'u-admin', email: 'tanguy@mapapote.fr', displayName: 'Tanguy Reynaud', claims: { admin: true } };

const RELAIS = { transporteur: 'mondial-relay', nom: 'Tabac de la Gare', id: '012345', adresse: '4 rue de la Gare', cp: '69003', ville: 'Lyon', pays: 'FR' };
const cmd = (id, o) => ({
  id, code: o.code || id.replace('CMD-', 'PAPO-'), nom: o.nom, email: o.email, telephone: o.telephone || '06 12 34 56 78', formule: o.formule || 'sim',
  tablette: 'pretee', livraison: { ...RELAIS, destinataire: o.nom }, expedition: o.expedition || 'a-preparer', suivi: o.suivi || null,
  envoyeeLe: o.envoyeeLe || null, creeLe: o.creeLe, fid: o.fid || null, famille: o.famille || null, abonnement: o.abonnement || null,
  resiliationLe: null, restitution: null, remboursement: null, retractation: null, dernierMois: null, contestations: null, pause: null,
  alerteDoublon: null, titulaire: o.nom, etiquettes: null, preparation: null, stripeCustomerId: 'cus_faux', offerte: false, remise: null,
  annulation: null, reprise: false, ...o.extra,
});

// Toutes les situations à la fois : chaque ligne « À faire » et chaque état de commande, de tablette et de carte SIM.
function gestionDonnees(o = {}) {
  const commandes = [
    cmd('CMD-AB12', { nom: 'Claire Dupont', email: 'claire@exemple.fr', creeLe: il(1) }),
    cmd('CMD-CD34', { nom: 'Marc Petit', email: 'marc@exemple.fr', creeLe: il(0.1), extra: { alerteDoublon: { mauvaisPayeur: false, raisons: ['même adresse'], commandes: [{ id: 'CMD-RB10', code: 'PAPO-RB10', nom: 'Chantal Blanc' }] } } }),
    cmd('CMD-SE01', { nom: 'Hélène Roux', email: 'helene@exemple.fr', expedition: 'paiement-en-attente', creeLe: il(12) }),
    cmd('CMD-EF56', { nom: 'Sophie Bernard', email: 'sophie@exemple.fr', expedition: 'envoyee', envoyeeLe: il(3), suivi: '12345678', creeLe: il(5) }),
    cmd('CMD-RT22', { nom: 'Paul Garnier', email: 'paul@exemple.fr', expedition: 'envoyee', envoyeeLe: il(24), suivi: '87654321', creeLe: il(26) }),
    cmd('CMD-GH78', { nom: 'Julie Martin', email: 'julie@exemple.fr', expedition: 'envoyee', envoyeeLe: il(28), creeLe: il(30), fid: FID, famille: 'Mamie Jeanne', abonnement: 'actif' }),
    cmd('CMD-IM90', { nom: 'Nicolas Faure', email: 'nicolas@exemple.fr', expedition: 'envoyee', envoyeeLe: il(40), creeLe: il(42), fid: 'f-henri', famille: 'Papi Henri', abonnement: 'impaye' }),
    cmd('CMD-RS45', { nom: 'Isabelle Morel', email: 'isabelle@exemple.fr', expedition: 'envoyee', envoyeeLe: il(70), creeLe: il(72), fid: 'f-odette', famille: 'Mamie Odette', abonnement: 'resilie',
      extra: { restitution: { statut: 'attendue', avant: il(-9) } } }),
    cmd('CMD-OF01', { nom: 'Tanguy Reynaud', email: 'tanguy@exemple.fr', formule: 'wifi', expedition: 'envoyee', envoyeeLe: il(20), creeLe: il(21), fid: 'f-mamies', famille: 'Mamie Lucette', abonnement: 'offert', extra: { offerte: true } }),
    cmd('CMD-AN77', { nom: 'Bruno Lefèvre', email: 'bruno@exemple.fr', expedition: 'annulee', creeLe: il(15), extra: { annulation: { le: il(14), par: 'client' }, remboursement: { statut: 'fait', montant: 6000, le: il(14) } } }),
    cmd('CMD-RB10', { nom: 'Chantal Blanc', email: 'chantal@exemple.fr', expedition: 'envoyee', envoyeeLe: il(35), creeLe: il(37), fid: 'f-rose', famille: 'Mamie Rose', abonnement: 'resilie',
      extra: { restitution: { statut: 'rendue' }, remboursement: { statut: 'echec', montant: 6000, le: il(2) } } }),
  ];
  const stock = [
    { id: 'T-001', ref: 'T-001', numero: 'BV60P-0001', modele: 'Blackview Tab 60 Pro', etat: 'chez-client', commande: 'CMD-GH78', fid: FID, sim: '07 45 12 34 56', simId: 'S1', batterie: { niveau: 82, le: il(0.01) }, tabletUid: 'tab-jeanne',
      gardeFous: [
        { le: il(0.2), genre: 'page', texte: 'la page ne répond plus depuis 3 min, rechargée (1/3)' },
        { le: il(1.5), genre: 'ecran', texte: 'écran bloqué 3 min (diaporama), retour à l’accueil' },
        { le: il(4), genre: 'ecran', texte: 'écran bloqué 3 min (rappel), retour à l’accueil' },
        { le: il(6), genre: 'appli', texte: 'page morte, Papote relancée' },
      ], prixAchat: 12999, acheteeLe: il(40), depense: 'D-A1', creeLe: il(40) },
    { id: 'T-002', ref: 'T-002', numero: 'BV60P-0002', modele: 'Blackview Tab 60 Pro', etat: 'en-stock', prixAchat: 12999, acheteeLe: il(40), depense: 'D-A1', creeLe: il(40) },
    { id: 'T-003', ref: 'T-003', numero: 'Tab60P15EEA026347', modele: 'Blackview Tab 60 Pro', etat: 'preparee', commande: 'CMD-AB12', prixAchat: 12999, acheteeLe: il(6), depense: 'D-A2', creeLe: il(6) },
    { id: 'T-004', ref: 'T-004', numero: 'BV60P-0004', modele: 'Blackview Tab 60 Pro', etat: 'envoyee', commande: 'CMD-EF56', sim: '07 45 98 76 54', simId: 'S2', prixAchat: 12999, acheteeLe: il(6), depense: 'D-A2', creeLe: il(6) },
    { id: 'T-005', ref: 'T-005', numero: 'BV60P-0005', modele: 'Blackview Tab 60 Pro', etat: 'envoyee', commande: 'CMD-RT22', sim: '06 98 76 54 32', simId: 'S3', prixAchat: 12999, acheteeLe: il(30), depense: 'D-A0', creeLe: il(30) },
    { id: 'T-006', ref: 'T-006', numero: 'BV60P-0006', modele: 'Blackview Tab 60 Pro', etat: 'chez-client', commande: 'CMD-IM90', fid: 'f-henri', sim: '07 51 23 45 67', simId: 'S4', batterie: { niveau: 15, le: il(0.2) }, prixAchat: 12999, acheteeLe: il(45), depense: 'D-A0', creeLe: il(45) },
    { id: 'T-007', ref: 'T-007', numero: 'BV60P-0007', modele: 'Blackview Tab 60 Pro', etat: 'chez-client', commande: 'CMD-RS45', fid: 'f-odette', sim: '07 51 00 11 22', simId: 'S5', prixAchat: 12999, acheteeLe: il(80), depense: 'D-A0', creeLe: il(80) },
    { id: 'T-008', ref: 'T-008', numero: 'BV60P-0008', modele: 'Blackview Tab 60 Pro', etat: 'revenue', prixAchat: 12999, acheteeLe: il(80), depense: 'D-A0', creeLe: il(80), batterie: { niveau: 64, le: il(2) } },
    { id: 'T-009', ref: 'T-009', numero: 'BV60P-0009', modele: 'Blackview Tab 60 Pro', etat: 'revenue', usure: 'batterie usée (62 % de sa capacité)', prixAchat: 12999, acheteeLe: il(200), depense: 'D-A0', creeLe: il(200) },
    { id: 'T-010', ref: 'T-010', numero: '', modele: 'Blackview Tab 60 Pro', etat: 'en-stock', creeLe: il(9) },
    { id: 'T-011', ref: 'T-011', numero: 'BV60P-0011', modele: 'Blackview Tab 60 Pro', etat: 'a-reparer', notes: 'Écran fissuré au retour', prixAchat: 12999, acheteeLe: il(90), depense: 'D-A0', creeLe: il(90) },
    { id: 'T-012', ref: 'T-012', numero: 'BV60P-0012', modele: 'Blackview Tab 60 Pro', etat: 'chez-client', commande: 'CMD-OF01', fid: 'f-mamies', prixAchat: 12999, acheteeLe: il(25), depense: 'D-A0', creeLe: il(25) },
  ];
  const sims = [
    { id: 'S1', operateur: 'Lyca', numero: '07 45 12 34 56', iccid: '8933150000000001', statut: 'active', prix: 499, go: 1, dureeForfait: 30, activation: il(25), prochaineRecharge: il(-5), tablette: 'T-001', depense: 'D-S1' },
    { id: 'S2', operateur: 'Lyca', numero: '07 45 98 76 54', iccid: '8933150000000002', statut: 'active', prix: 499, go: 1, dureeForfait: 30, activation: il(28), prochaineRecharge: il(-2), tablette: 'T-004', depense: 'D-S2' },
    { id: 'S3', operateur: 'NRJ Mobile', numero: '06 98 76 54 32', iccid: '8933010000000003', statut: 'active', prix: 299, prixApres: 799, finPromo: il(-12), go: 2, renouvellementAuto: true, activation: il(30), tablette: 'T-005' },
    { id: 'S4', operateur: 'Lyca', numero: '07 51 23 45 67', iccid: '8933150000000004', statut: 'active', prix: 499, go: 1, dureeForfait: 30, activation: il(33), prochaineRecharge: il(1), tablette: 'T-006', depense: 'D-S4', cb: 'Visa …4242', cbExp: '2026-11' },
    { id: 'S5', operateur: 'Lyca', numero: '07 51 00 11 22', iccid: '8933150000000005', statut: 'suspendue', prix: 499, go: 1, tablette: 'T-007', depense: 'D-S4' },
    { id: 'S6', operateur: 'Cdiscount Mobile', iccid: '8933010000000006', statut: 'stock', prix: 199, go: 1, activerAvant: il(-20) },
    { id: 'S7', operateur: 'Lyca', numero: '07 00 00 00 07', iccid: '8933150000000007', statut: 'resiliee', prix: 499, go: 1, depense: 'D-S1' },
    { id: 'S8', operateur: 'Lyca', numero: '07 12 12 12 12', iccid: '8933150000000008', statut: 'active', prix: 499, go: 1, activation: il(3), prochaineRecharge: il(-27) },
  ];
  const depenses = [
    { id: 'D-A0', date: il(80), categorie: 'tablettes', fournisseur: 'Cdiscount', libelle: '8 Blackview Tab 60 Pro', montant: 103992, quantite: 8, pieces: [{ nom: 'facture.pdf', chemin: 'x', type: 'application/pdf', le: il(80) }] },
    { id: 'D-A1', date: il(40), categorie: 'tablettes', fournisseur: 'Cdiscount', libelle: '2 Blackview Tab 60 Pro', montant: 25998, quantite: 2, pieces: [] },
    { id: 'D-A2', date: il(6), categorie: 'tablettes', fournisseur: 'Cdiscount', libelle: '2 Blackview Tab 60 Pro', montant: 25998, quantite: 2, numero: 'CD-778899', confirmation: true, pieces: [] },
    { id: 'D-S1', date: il(25), categorie: 'sim', fournisseur: 'Lyca', libelle: 'Recharge du forfait Lyca 07 45 12 34 56', montant: 499, sim: 'S1', pieces: [] },
    { id: 'D-S2', date: il(28), categorie: 'sim', fournisseur: 'Lyca', libelle: 'Recharge du forfait Lyca 07 45 98 76 54', montant: 499, sim: 'S2', pieces: [] },
    { id: 'D-S4', date: il(3), categorie: 'sim', fournisseur: 'Lyca', libelle: 'Recharge du forfait Lyca 07 51 23 45 67', montant: 499, sim: 'S4', pieces: [] },
    { id: 'D-E1', date: il(10), categorie: 'envoi', fournisseur: 'Sendcloud', libelle: 'Étiquettes Mondial Relay', montant: 1490, pieces: [] },
    { id: 'D-L1', date: il(16), categorie: 'logiciel', fournisseur: 'OVH', libelle: 'Nom de domaine mapapote.fr', montant: 1199, recurrence: 'annuel', pieces: [] },
    { id: 'D-M1', date: il(1), categorie: 'accessoires', fournisseur: 'Amazon', libelle: 'Supports de tablette', montant: 3596, aVerifier: true, pieces: [{ nom: 'facture-amazon.pdf', chemin: 'y', type: 'application/pdf', le: il(1) }] },
  ];
  const familles = [
    { id: FID, nom: 'Mamie Jeanne', statut: 'actif', formule: 'sim', majLe: il(5) },
    { id: 'f-henri', nom: 'Papi Henri', statut: 'impaye', formule: 'sim', graceJusqua: il(-6), majLe: il(2) },
    { id: 'f-paulette', nom: 'Mamie Paulette', statut: 'suspendu', formule: 'sim', suspenduLe: il(34), majLe: il(34) },
    { id: 'f-odette', nom: 'Mamie Odette', statut: 'resilie', formule: 'sim', majLe: il(10) },
    { id: 'f-mamies', nom: 'Mamie Lucette', statut: 'offert', formule: 'wifi', majLe: il(20) },
    { id: 'f-rose', nom: 'Mamie Rose', statut: 'resilie', formule: 'sim', majLe: il(30) },
  ];
  const alertes = [
    { id: 'al1', genre: 'debranchee', le: il(0.05), fid: FID, famille: 'Mamie Jeanne', telephones: 3, fiche: 'T-001' },
    { id: 'al2', genre: 'neRepondPlus', le: il(0.4), fid: 'f-henri', famille: 'Papi Henri', telephones: 2, fiche: 'T-006' },
    { id: 'al3', genre: 'pasVue', le: il(2), fid: FID, famille: 'Mamie Jeanne', telephones: 3, fiche: 'T-001' },
    { id: 'al4', genre: 'sos', le: il(4), fid: 'f-henri', famille: 'Papi Henri', telephones: 2, fiche: 'T-006' },
    { id: 'al5', genre: 'forfait', le: il(6), fid: 'f-henri', famille: 'Papi Henri', telephones: 2, fiche: 'T-006' },
  ];
  const d = {
    aVendre: 2, commandes, stock, depenses, familles, sims, alertes,
    accessoires: [
      { id: 'X1', nom: 'Chargeur + câble USB-C', quantite: 6, envoi: 'tous', depenses: ['D-M1'] },
      { id: 'X2', nom: 'Support de tablette', quantite: 1, envoi: 'tous', depenses: [] },
      { id: 'X3', nom: 'Notice imprimée', quantite: 0, envoi: 'tous', depenses: [] },
    ],
    etats: { commandee: 'Commandée, pas encore reçue', 'en-stock': 'En stock', preparee: 'Préparée', envoyee: 'Envoyée', 'chez-client': 'Chez le client', 'en-retour': 'En retour', revenue: 'Revenue, à vérifier', 'a-reparer': 'À réparer', perdue: 'Perdue', 'hors-service': 'Hors service' },
    categories: { tablettes: 'Achat de tablettes', sim: 'Cartes SIM et forfaits', accessoires: 'Accessoires', envoi: 'Envois et retours', logiciel: 'Logiciels et services', autre: 'Autre' },
    statutsSim: { stock: 'En stock, pas activée', active: 'Active', suspendue: 'Suspendue', resiliee: 'Résiliée' },
    envoisAccessoire: { wifi: 'Wi-Fi', sim: 'Carte SIM', tous: 'Tous les envois' },
    genresAlerte: { debranchee: 'Tablette débranchée', neRepondPlus: 'Tablette qui ne répond plus', pasVue: 'Photo pas vue depuis 48 h', sos: 'SOS famille', forfait: 'Forfait internet presque épuisé' },
    alertesJours: 90,
    genresGardeFou: { ecran: 'écran bloqué', page: 'page rechargée', appli: 'appli relancée', redemarrage: 'tablette redémarrée', autre: 'autre' },
    reglages: { seuilTva: 3750000, tauxUrssaf: 21.2, forfaitSim: 499, vieTablette: 24, poidsColis: 1500, miseEnService: 6000, fraisEnvoi: 799, fraisRetour: 800, masquees: [], expediteur: { nom: 'Papote', adresse: '1 rue de la Paix', cp: '69001', ville: 'Lyon', telephone: '06 00 00 00 00', email: 'contact@mapapote.fr' } },
    automatique: { le: il(0.2), factures: ['PAP-0004'], avoirs: [], depenses: 1, stock: ['T-001 chez le client'], etiquettes: [], livres: ['Sophie Bernard'],
      erreurs: ['Relance du colis CMD-RT22 : Sendcloud n’a pas répondu'] },
    courrier: { le: il(0.1), boite: 'factures@mapapote.fr', recus: 5, pourFactures: 2, rangees: ['Lyca, recharge 4,99 €'], ignorees: ['Publicité Cdiscount'], erreurs: [], precedent: null },
    archives: { mois: { '2026-09': { recettes: { total: 8500 }, achats: { total: 129980 }, le: il(25), fichiers: [{ nom: 'livre-des-recettes-2026-09.csv', chemin: 'a' }, { nom: 'registre-des-achats-2026-09.csv', chemin: 'b' }] } } },
  };
  if (o.vide) {
    for (const k of ['commandes', 'stock', 'depenses', 'familles', 'sims', 'alertes', 'accessoires']) d[k] = [];
    d.automatique = null; d.aVendre = 0;
  }
  return d;
}

const STRIPE = {
  factures: [
    { id: 'in_1', numero: 'PAP-0004', le: il(3), client: 'Julie Martin', email: 'julie@exemple.fr', abonnement: 'sub_1', statut: 'paid', total: 2500, ht: 2500, tva: 0, paye: 2500, du: 0, lignes: 'Papote tout compris', lienPdf: 'https://exemple.invalid/f.pdf' },
    { id: 'in_2', numero: 'PAP-0003', le: il(5), client: 'Nicolas Faure', email: 'nicolas@exemple.fr', abonnement: 'sub_2', statut: 'open', total: 2500, ht: 2500, tva: 0, paye: 0, du: 2500, lignes: 'Papote tout compris' },
    { id: 'in_3', numero: 'PAP-0002', le: il(1), client: 'Claire Dupont', email: 'claire@exemple.fr', abonnement: 'sub_3', statut: 'paid', total: 6000, ht: 6000, tva: 0, paye: 6000, du: 0, lignes: 'Mise en service' },
  ],
  mouvements: [
    { id: 'tx1', le: il(1), type: 'charge', nature: 'abonnement', montant: 6000, frais: 115, net: 5885, client: 'Claire Dupont', description: 'Mise en service' },
    { id: 'tx2', le: il(3), type: 'charge', nature: 'abonnement', montant: 2500, frais: 63, net: 2437, client: 'Julie Martin' },
    { id: 'tx3', le: il(14), type: 'refund', nature: 'remboursement', montant: -6000, frais: 0, net: -6000, client: 'Bruno Lefèvre' },
    { id: 'tx4', le: il(8), type: 'payout', nature: 'virement', montant: -8000, frais: 0, net: -8000 },
  ],
  abonnements: [
    { id: 'sub_1', statut: 'active', debut: il(28), finEssai: il(-2), formule: 'sim', tablette: 'pretee', mensuel: 2500 },
    { id: 'sub_2', statut: 'past_due', debut: il(40), formule: 'sim', tablette: 'pretee', mensuel: 2500 },
    { id: 'sub_3', statut: 'trialing', debut: il(1), finEssai: il(-35), formule: 'sim', tablette: 'pretee', mensuel: 2500 },
  ],
};

const CLIENTS = {
  contacts: [
    { email: 'julie@exemple.fr', nom: 'Julie Martin', telephone: '06 12 34 56 78', type: 'client', statut: 'actif', formule: 'sim', depuis: il(30), consentement: true, desinscrit: false },
    { email: 'nicolas@exemple.fr', nom: 'Nicolas Faure', telephone: '06 22 33 44 55', type: 'client', statut: 'impaye', formule: 'sim', depuis: il(42), consentement: false, desinscrit: false },
    { email: 'claire@exemple.fr', nom: 'Claire Dupont', telephone: '06 12 34 56 78', type: 'client', statut: null, formule: 'sim', depuis: il(1), consentement: true, desinscrit: false },
    { email: 'tanguy@exemple.fr', nom: 'Tanguy Reynaud', type: 'client', statut: 'offert', formule: 'wifi', depuis: il(21), consentement: false, desinscrit: false },
    { email: 'bruno@exemple.fr', nom: 'Bruno Lefèvre', type: 'ancien', statut: 'annulee', formule: 'sim', depuis: il(15), consentement: false, desinscrit: true },
    { email: 'isabelle@exemple.fr', nom: 'Isabelle Morel', type: 'ancien', statut: 'resilie', formule: 'sim', depuis: il(72), consentement: true, desinscrit: false },
    { email: 'gerard@exemple.fr', nom: 'Gérard Simon', telephone: '06 55 44 33 22', type: 'panier', statut: 'panier', formule: 'sim', depuis: il(4), consentement: false, desinscrit: false },
    { email: 'marie@exemple.fr', nom: 'Marie Dupont', telephone: '06 12 34 56 78', type: 'chat', depuis: il(2), consentement: true, desinscrit: false },
  ],
  campagnes: [{ id: 'c1', le: il(7), objet: 'Papote arrive bientôt', envoyes: 12 }],
  envoisMax: 300,
};

// Commande ouverte : factures et paiements Stripe (gestionCommande).
const COMMANDE = {
  factures: [STRIPE.factures[2]],
  paiements: [{ id: 'ch_1', le: il(1), montant: 6000, rembourse: 0, statut: 'succeeded', description: 'Mise en service', recu: 'https://exemple.invalid/r' }],
};

function donnees(o = {}) {
  const docs = famillePleine({ sim: true });
  docs['families/f-henri'] = { name: 'Papi Henri', createdBy: 'u-nicolas', abonnement: { statut: 'impaye', formule: 'sim', graceJusqua: { __ms: il(-6) } } };
  docs['families/f-henri/members/u-nicolas'] = membre('u-nicolas', 'Nicolas');
  docs['families/f-henri/members/t-henri'] = membre('t-henri', 'Tablette', { role: 'tablette', email: '', lastOnline: { __ms: il(0.3) }, lastActive: { __ms: il(0.9) }, appVersion: '2.99.88' });
  docs['families/f-paulette'] = { name: 'Mamie Paulette', code: 'PAUL2345', createdBy: 'u-luc', createdAt: { __ms: il(60) }, abonnement: { statut: 'suspendu', formule: 'sim' } };
  docs['families/f-paulette/members/u-luc'] = membre('u-luc', 'Luc');
  docs['families/f-paulette/members/t-paulette'] = membre('t-paulette', 'Tablette', { role: 'tablette', email: '', lastOnline: { __ms: il(3) }, lastActive: { __ms: il(3) }, appVersion: '2.99.80' });
  docs['families/f-odette'] = { name: 'Mamie Odette', code: 'ODET2345', createdBy: 'u-isa', createdAt: { __ms: il(70) }, abonnement: { statut: 'resilie', formule: 'sim' } };
  docs['families/f-odette/members/u-isa'] = membre('u-isa', 'Isabelle');
  docs['families/f-mamies'] = { name: 'Mamie Lucette', createdBy: 'u-tanguy', abonnement: { statut: 'offert' } };
  // Les commandes sont aussi dans la base : les listes « à envoyer », « en route » et « à récupérer » la lisent directement.
  for (const c of (o.donnees || gestionDonnees(o)).commandes) {
    const { id, famille, abonnement, ...reste } = c;
    docs[`commandes/${id}`] = { ...reste, creeLe: { __ms: c.creeLe }, envoyeeLe: c.envoyeeLe ? { __ms: c.envoyeeLe } : null,
      ...(c.restitution && c.restitution.avant ? { restitution: { ...c.restitution, avant: { __ms: c.restitution.avant } } } : {}) };
  }
  return {
    user: o.user === null ? null : ADMIN,
    docs,
    fonctions: {
      gestionDonnees: o.donnees || gestionDonnees(o),
      gestionStripe: o.vide ? { factures: [], mouvements: [], abonnements: [] } : STRIPE,
      gestionClients: o.vide ? { contacts: [], campagnes: [], envoisMax: 300 } : CLIENTS,
      gestionCommande: COMMANDE,
      gestionReglages: { ok: true, masquees: [] },
      stockDisponible: { disponible: 2 },
      ...(o.fonctions || {}),
    },
  };
}

const pause = (p, ms = 700) => p.waitForTimeout(ms);
const toucher = (...sels) => async (p) => { for (const sel of sels) { await p.locator(sel).first().click(); await pause(p); } };
const onglet = (t) => async (p) => { await p.locator('#kpi-commandes .onglet').filter({ hasText: t }).first().click(); await pause(p); };

// page : adresse dans l'admin (#…) ; tailles : pc et/ou tel ; plein : toute la page.
const SCENES = [
  { groupe: 'Connexion', titre: 'Se connecter', page: '#accueil', tailles: ['pc', 'tel'], donnees: () => donnees({ user: null }) },
  { groupe: 'Connexion', titre: 'Compte sans droit d’admin', page: '#accueil', tailles: ['pc'], donnees: () => ({ ...donnees({ fonctions: Object.fromEntries(['gestionDonnees', 'gestionStripe', 'gestionClients'].map((f) => [f, { erreur: 'Réservé à l’administrateur.', code: 'functions/permission-denied' }])) }), user: { ...ADMIN, claims: {} } }) },

  { groupe: 'Accueil', titre: 'Accueil : à faire, chiffres du mois, alertes', page: '#accueil', tailles: ['pc', 'tel'], plein: true, donnees: () => donnees() },
  { groupe: 'Accueil', titre: 'Accueil : rien à faire', page: '#accueil', tailles: ['pc'], plein: true, donnees: () => donnees({ vide: true }) },
  { groupe: 'Accueil', titre: 'Accueil : menu d’une ligne (masquer 7 jours)', page: '#accueil', tailles: ['pc'], donnees: () => donnees(), faire: toucher('#a-faire .menu-points button, #a-faire [aria-label="Actions pour cette ligne"]') },
  { groupe: 'Accueil', titre: 'Téléphone : menu ☰ ouvert', page: '#accueil', tailles: ['tel'], donnees: () => donnees(), faire: toucher('#nav-menu') },
  { groupe: 'Accueil', titre: 'Données illisibles (erreur du serveur)', page: '#accueil', tailles: ['pc'], donnees: () => donnees({ fonctions: { gestionDonnees: { erreur: 'Le serveur ne répond pas' } } }) },

  { groupe: 'Commandes', titre: 'Commandes : à envoyer', page: '#commandes', tailles: ['pc', 'tel'], plein: true, donnees: () => donnees() },
  { groupe: 'Commandes', titre: 'Préparer l’envoi : les étapes', page: '#commandes', tailles: ['pc', 'tel'], plein: true, donnees: () => donnees(), faire: toucher('text=Préparer l\'envoi') },
  { groupe: 'Commandes', titre: 'Préparer l’envoi : étape 2, choisir la tablette', page: '#commandes', tailles: ['pc'], plein: true, donnees: () => donnees(), faire: toucher('text=Préparer l\'envoi', 'text=C\'est fait') },
  { groupe: 'Commandes', titre: 'Commandes : en route', page: '#commandes', tailles: ['pc'], plein: true, donnees: () => donnees(), faire: onglet('en route') },
  { groupe: 'Commandes', titre: 'Commandes : à récupérer', page: '#commandes', tailles: ['pc'], plein: true, donnees: () => donnees(), faire: onglet('à récupérer') },
  { groupe: 'Commandes', titre: 'Commandes : toutes', page: '#commandes', tailles: ['pc'], plein: true, donnees: () => donnees(), faire: onglet('commandes au total') },
  { groupe: 'Commandes', titre: 'Commande à envoyer (2e commande du même client)', page: '#commande/CMD-CD34', tailles: ['pc', 'tel'], plein: true, donnees: () => donnees() },
  { groupe: 'Commandes', titre: 'Commande à envoyer, tablette préparée', page: '#commande/CMD-AB12', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Commandes', titre: 'Commande : paiement SEPA en attente', page: '#commande/CMD-SE01', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Commandes', titre: 'Commande en route', page: '#commande/CMD-EF56', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Commandes', titre: 'Commande en route depuis 24 jours, pas jumelée', page: '#commande/CMD-RT22', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Commandes', titre: 'Commande en service', page: '#commande/CMD-GH78', tailles: ['pc', 'tel'], plein: true, donnees: () => donnees() },
  { groupe: 'Commandes', titre: 'Commande en service, paiement en retard', page: '#commande/CMD-IM90', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Commandes', titre: 'Commande résiliée, tablette à récupérer', page: '#commande/CMD-RS45', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Commandes', titre: 'Commande offerte', page: '#commande/CMD-OF01', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Commandes', titre: 'Commande annulée et remboursée', page: '#commande/CMD-AN77', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Commandes', titre: 'Commande terminée, remboursement échoué', page: '#commande/CMD-RB10', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Commandes', titre: 'Commande : menu ⋮ des actions', page: '#commande/CMD-GH78', tailles: ['pc'], donnees: () => donnees(), faire: toucher('#dc-corps .menu-points > button, #dc-corps [aria-haspopup]') },
  { groupe: 'Commandes', titre: 'Nouvelle commande offerte', page: '#commandes', tailles: ['pc'], plein: true, donnees: () => donnees(), faire: toucher('#b-offerte') },

  { groupe: 'Clients', titre: 'Clients : liste', page: '#clients/liste', tailles: ['pc', 'tel'], plein: true, donnees: () => donnees() },
  { groupe: 'Clients', titre: 'Clients : familles et tablettes', page: '#clients/familles', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Clients', titre: 'Clients : toutes les familles', page: '#clients/familles', tailles: ['pc'], plein: true, donnees: () => donnees(), faire: toucher('[data-panneau="clients"] :text("toutes les familles")') },
  { groupe: 'Clients', titre: 'Une famille', page: `#clients/familles/${FID}`, tailles: ['pc', 'tel'], plein: true, donnees: () => donnees() },
  { groupe: 'Clients', titre: 'Une famille en retard de paiement', page: '#clients/familles/f-henri', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Clients', titre: 'Un client', page: '#client/julie%40exemple.fr', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Clients', titre: 'Un panier abandonné', page: '#client/gerard%40exemple.fr', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Clients', titre: 'Un contact venu du chat (sans commande)', page: '#client/marie%40exemple.fr', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Clients', titre: 'E-mail d’information', page: '#clients/email', tailles: ['pc'], plein: true, donnees: () => donnees() },

  { groupe: 'Stock', titre: 'Stock : tablettes', page: '#stock/tablettes', tailles: ['pc', 'tel'], plein: true, donnees: () => donnees() },
  { groupe: 'Stock', titre: 'Tablette chez le client (batterie, SIM, famille)', page: '#tablette/T-001', tailles: ['pc', 'tel'], plein: true, donnees: () => donnees() },
  { groupe: 'Stock', titre: 'Tablette en stock', page: '#tablette/T-002', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Stock', titre: 'Tablette préparée pour une commande', page: '#tablette/T-003', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Stock', titre: 'Tablette revenue, à vérifier', page: '#tablette/T-008', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Stock', titre: 'Tablette revenue, batterie usée', page: '#tablette/T-009', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Stock', titre: 'Tablette reçue sans facture', page: '#tablette/T-010', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Stock', titre: 'Tablette à réparer', page: '#tablette/T-011', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Stock', titre: 'Tablette introuvable', page: '#tablette/T-999', tailles: ['pc'], donnees: () => donnees() },
  { groupe: 'Stock', titre: 'Stock : cartes SIM', page: '#stock/sim', tailles: ['pc', 'tel'], plein: true, donnees: () => donnees() },
  { groupe: 'Stock', titre: 'Carte SIM active, forfait Lyca (recharge dans 5 jours)', page: '#sim/S1', tailles: ['pc', 'tel'], plein: true, donnees: () => donnees() },
  { groupe: 'Stock', titre: 'Carte SIM : à recharger demain, carte bancaire qui expire', page: '#sim/S4', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Stock', titre: 'Carte SIM : promo qui finit dans 12 jours, renouvellement automatique', page: '#sim/S3', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Stock', titre: 'Carte SIM suspendue', page: '#sim/S5', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Stock', titre: 'Carte SIM en stock, à activer', page: '#sim/S6', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Stock', titre: 'Carte SIM active reliée à aucune tablette, sans achat', page: '#sim/S8', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Stock', titre: 'Nouvelle carte SIM', page: '#sim/nouvelle', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Stock', titre: 'Stock : accessoires', page: '#stock/accessoires', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Stock', titre: 'Un accessoire', page: '#accessoire/X2', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Stock', titre: 'Stock : achats', page: '#stock/achats', tailles: ['pc'], plein: true, donnees: () => donnees() },

  { groupe: 'Comptabilité', titre: 'Bilan', page: '#compta/bilan', tailles: ['pc', 'tel'], plein: true, donnees: () => donnees() },
  { groupe: 'Comptabilité', titre: 'Factures', page: '#compta/factures', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Comptabilité', titre: 'Dépenses', page: '#compta/depenses', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Comptabilité', titre: 'Une dépense (achat de tablettes, facture attendue)', page: '#depense/D-A2', tailles: ['pc'], plein: true, donnees: () => donnees() },
  // Vérifie aussi que le bouton ouvre bien le choix du fichier (Tanguy, 29/10 : « je ne peux pas ajouter une facture »).
  { groupe: 'Comptabilité', titre: 'Achat : « Ajouter la facture » ouvre le choix du fichier', page: '#depense/D-A2', tailles: ['pc', 'tel'], donnees: () => donnees(), faire: async (p) => {
    const [choix] = await Promise.all([p.waitForEvent('filechooser', { timeout: 4000 }), p.click('#dd-ajouter-facture')]);
    if (!choix.isMultiple()) throw new Error('le choix du fichier devrait accepter plusieurs fichiers');
  } },
  { groupe: 'Comptabilité', titre: 'Une dépense reçue par e-mail, à vérifier', page: '#depense/D-M1', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Comptabilité', titre: 'URSSAF et TVA', page: '#compta/urssaf', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Comptabilité', titre: 'Rentabilité', page: '#compta/rentabilite', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Comptabilité', titre: 'Registres', page: '#compta/registres', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Comptabilité', titre: 'Ajouter une dépense', page: '#nouveau/depense', tailles: ['pc', 'tel'], plein: true, donnees: () => donnees() },
  { groupe: 'Comptabilité', titre: 'Ajouter un achat de tablettes', page: '#nouveau/achat', tailles: ['pc'], plein: true, donnees: () => donnees() },

  { groupe: 'Outils', titre: 'Outils : automatique', page: '#outils/automatique', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Outils', titre: 'Outils : expédition', page: '#outils/expedition', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Outils', titre: 'Outils : calculs', page: '#outils/calculs', tailles: ['pc'], plein: true, donnees: () => donnees() },
  { groupe: 'Outils', titre: 'Outils : maintenance', page: '#outils/maintenance', tailles: ['pc'], plein: true, donnees: () => donnees() },
];

async function capturer({ browser, base, dossierImages, progression }) {
  const travaux = [];
  let n = 0;
  for (const scene of SCENES) for (const t of scene.tailles) travaux.push({ scene, taille: TAILLES[t], n: ++n });
  const n0 = travaux.length;
  const resultats = [];
  let faits = 0;
  async function ouvrier() {
    for (let job = travaux.shift(); job; job = travaux.shift()) {
      const { scene, taille, n } = job;
      const ctx = await browser.newContext({
        viewport: { width: taille.width, height: taille.height }, deviceScaleFactor: taille.mobile ? 2 : 1, isMobile: taille.mobile, hasTouch: taille.mobile,
        locale: 'fr-FR', timezoneId: 'Europe/Paris', serviceWorkers: 'block',
      });
      const page = await ctx.newPage();
      page.setDefaultTimeout(8000);
      const erreurs = [];
      page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
      if (process.env.CONSOLE) page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text(), m.location().url, m.location().lineNumber); });
      await page.clock.install({ time: new Date(MAINTENANT) });
      await page.addInitScript(poserDonnees, scene.donnees());
      await page.route('https://www.gstatic.com/firebasejs/**', (r) => r.fulfill({
        contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' },
        body: r.request().url().endsWith('/faux-sdk.js') ? SDK : "export * from 'https://www.gstatic.com/firebasejs/faux-sdk.js';",
      }));
      await page.route(/^https?:\/\/(?!127\.0\.0\.1|fonts\.googleapis\.com|fonts\.gstatic\.com|www\.gstatic\.com\/firebasejs)/, (r) => r.abort());
      try {
        await page.goto(`${base}/admin.html${scene.page}`);
        await page.waitForTimeout(2000);
        if (scene.faire) await scene.faire(page);
      } catch (e) {
        erreurs.push('Scène : ' + e.message.split('\n')[0]);
      }
      const fichier = `admin-${String(n).padStart(3, '0')}.jpg`;
      if (scene.plein) {
        const h = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => taille.height);
        if (h > taille.height) { await page.setViewportSize({ width: taille.width, height: Math.min(h, taille.height * 4) }); await pause(page, 400); }
      }
      await page.screenshot({ path: `${dossierImages}/${fichier}`, type: 'jpeg', quality: 62 }).catch((e) => erreurs.push('Capture : ' + e.message.split('\n')[0]));
      resultats.push({ n, groupe: scene.groupe, titre: scene.titre, note: scene.note, taille: taille.nom, fichier, erreurs, scene: SCENES.indexOf(scene) });
      // Téléphone : clavier ouvert sur les champs de l'écran (clavier.js).
      if (taille.mobile) {
        await page.setViewportSize({ width: taille.width, height: taille.height });
        await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
        const fc = `admin-${String(n).padStart(3, '0')}-clavier.jpg`;
        const { problemes, capture } = await clavier.verifier(page, taille, `${dossierImages}/${fc}`);
        if (capture) resultats.push({ n: n + 0.5, groupe: scene.groupe, titre: scene.titre, note: scene.note, taille: 'clavier ouvert', fichier: fc, erreurs: problemes, scene: SCENES.indexOf(scene) });
      }
      await ctx.close();
      progression(`admin ${++faits}/${n0}`);
    }
  }
  await Promise.all([ouvrier(), ouvrier(), ouvrier(), ouvrier()]);
  return resultats.sort((a, b) => a.n - b.n);
}

module.exports = { capturer, SCENES };
