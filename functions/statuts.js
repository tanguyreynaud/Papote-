// Garde-fous des actions de l'admin selon l'état réel (Tanguy, 30/10 : « impossible d'envoyer une étiquette de
// retour sur une tablette pas commandée ni reçue »). L'admin ne montre déjà que les bons boutons ; le serveur
// revérifie ici, pour un double-clic, un vieil onglet ou une erreur. Chaque règle rend '' si l'action est
// permise, sinon le message à montrer. Sans dépendance (statuts.test.js).
'use strict';

const { materielParti } = require('./abonnement');

const restitutionDe = (c) => (c && c.restitution && c.restitution.statut) || null;
// Matériel à récupérer chez le client : fin de contrat, changement d'avis, commande offerte d'une famille supprimée.
const RESTITUTION_EN_COURS = ['attendue', 'echec', 'a-recuperer'];
const aRecuperer = (c) => RESTITUTION_EN_COURS.includes(restitutionDe(c));
// Tablette partie de chez Papote (chez le client ou sur la route).
const ETATS_PARTIS = ['envoyee', 'chez-client', 'en-retour'];
// Une tablette dans ces états ne part chez aucun client.
const ETATS_INUTILISABLES = ['perdue', 'hors-service', 'a-reparer'];

// Étiquette Mondial Relay. Aller : seulement pour une commande à envoyer. Retour : seulement s'il y a quelque
// chose à récupérer (fin de contrat, ou tablette remplacée encore chez le client : remplacee = true).
function refusEtiquette(c, sens, { remplacee = false } = {}) {
  if (sens === 'aller') {
    if (c.expedition === 'a-preparer') return '';
    if (c.expedition === 'envoyee') return 'Cette commande est déjà envoyée.';
    if (c.expedition === 'paiement-en-attente') return 'Paiement en attente (SEPA) : la commande ne part pas encore.';
    return "Cette commande n'est pas à envoyer.";
  }
  if (remplacee || restitutionDe(c) === 'a-recuperer') return '';
  // Retour attendu d'une tablette jamais partie (annulée avant l'envoi) : rien à renvoyer.
  if (aRecuperer(c) && materielParti(c)) return '';
  return "Rien à récupérer chez ce client : pas de fin de contrat ni de tablette remplacée. Pas d'étiquette de retour.";
}

// « Colis envoyé » avec un n° de suivi : commande à envoyer, ou déjà envoyée (numéro corrigé).
// Remise en main propre : seulement une commande à envoyer.
function refusEnvoi(c, { mainPropre = false } = {}) {
  if (c.expedition === 'a-preparer') return '';
  if (c.expedition === 'envoyee') return mainPropre ? 'Cette commande est déjà envoyée.' : '';
  if (c.expedition === 'paiement-en-attente') return 'Paiement en attente (SEPA) : la commande ne part pas encore.';
  if (c.expedition === 'annulee') return 'Cette commande est annulée.';
  return "Cette commande n'est pas à envoyer.";
}

// Offre unique avec carte SIM (Tanguy, 2026-10-30) : un premier envoi part seulement avec sa tablette reliée
// à la commande (Stock) et une carte SIM reliée à cette tablette. tablettes : fiches stock de la commande.
function refusEnvoiSansSim(c, tablettes) {
  if (c.expedition === 'envoyee' || c.formule !== 'sim') return '';
  const t = tablettes.find((x) => ['en-stock', 'preparee', 'envoyee'].includes(x.etat));
  if (!t) return "Reliez d'abord la tablette à cette commande (Stock).";
  if (!t.simId) return `Reliez d'abord une carte SIM à la tablette ${t.ref || ''}`.trim() + ' (Stock, Cartes SIM).';
  return '';
}

// « Le client a reçu le colis » : fait partir les 30 jours et le premier prélèvement, donc colis parti seulement.
function refusReception(c) {
  if (c.expedition === 'envoyee') return '';
  if (c.expedition === 'annulee') return 'Cette commande est annulée.';
  return "Le colis n'est pas encore parti.";
}

// « Matériel reçu » (avec, peut-être, des éléments manquants facturés) : seulement un retour attendu.
function refusRetourMateriel(c) {
  const r = restitutionDe(c);
  if (RESTITUTION_EN_COURS.includes(r)) return '';
  if (r === 'rendue') return 'Le matériel de cette commande est déjà noté rendu.';
  if (r === 'facturee') return 'Le matériel non rendu a déjà été prélevé : remboursez depuis Stripe si besoin.';
  return "Aucun retour de matériel n'est attendu pour cette commande.";
}

// Tablette reliée à une commande : pas une tablette perdue, hors service ou à réparer, ni une commande annulée.
function refusLienCommande(tablette, etat, c) {
  if (ETATS_INUTILISABLES.includes(etat)) return 'Cette tablette est perdue, hors service ou à réparer : elle ne part chez aucun client.';
  if (c && c.expedition === 'annulee') return 'Cette commande est annulée.';
  return '';
}

// Cartes SIM : la vie d'une ligne, sans retour en arrière une fois résiliée.
const SUITES_SIM = {
  stock: ['active', 'resiliee'],
  active: ['suspendue', 'resiliee'],
  suspendue: ['active', 'resiliee'],
  resiliee: [],
};
const NOMS_SIM = { stock: 'en stock', active: 'active', suspendue: 'suspendue', resiliee: 'résiliée' };
function refusStatutSim(de, vers) {
  if (!de || !vers || de === vers || (SUITES_SIM[de] || []).includes(vers)) return '';
  return `Une ligne ${NOMS_SIM[de] || de} ne peut pas passer ${NOMS_SIM[vers] || vers}.`;
}
function refusRecharge(ligne) {
  return ligne.statut === 'active' ? '' : "Seule une ligne active se recharge : activez-la d'abord.";
}
// Supprimer une carte (erreur de saisie) : pas celle d'une tablette partie chez un client.
function refusSuppressionSim(ligne, tablette) {
  if (tablette && ETATS_PARTIS.includes(tablette.etat)) {
    return 'Cette carte est dans une tablette chez un client : résiliez la ligne ou retirez-la de la tablette d\'abord.';
  }
  return '';
}

module.exports = {
  refusEnvoiSansSim,
  refusEtiquette, refusEnvoi, refusReception, refusRetourMateriel, refusLienCommande,
  refusStatutSim, refusRecharge, refusSuppressionSim, SUITES_SIM, RESTITUTION_EN_COURS,
};
