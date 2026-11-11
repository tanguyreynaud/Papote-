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

// Deuxième étiquette pour le même sens alors qu'une étiquette payée existe (double clic, vieil onglet) : refusée,
// sauf si l'ancienne a servi (colis livré) ou date de plus de 30 jours (annulée par la nuit si pas déposée).
const ETIQUETTE_JOURS = 30;
function refusEtiquetteEnDouble(c, sens, maintenant) {
  const e = c && c.etiquettes && c.etiquettes[sens];
  if (!e || !e.colis || e.livre) return '';
  if (e.le && maintenant - e.le >= ETIQUETTE_JOURS * 864e5) return '';
  return sens === 'aller'
    ? "Une étiquette d'envoi existe déjà pour cette commande : annulez-la d'abord pour en refaire une."
    : 'Une étiquette de retour existe déjà pour cette commande (lien sur la commande) : annulez-la d\'abord pour en refaire une.';
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

// Une tablette ne part jamais sans carte SIM qui a son numéro de ligne (Tanguy, 8/11) : sans numéro, pas de fiche
// contact pour la famille ni de ligne à retrouver. t : fiche stock ; ligne : la carte SIM (sims/{t.simId}) ou null.
// Blocages à demander à l'opérateur sur chaque carte SIM avant son premier départ (Tanguy, 11/11) : seule protection
// qui tient si quelqu'un contourne l'appli de la tablette. Cochés une fois sur la fiche de la carte (sims/{id}.blocages).
const BLOCAGES_SIM = {
  surtaxes: 'appels vers les numéros surtaxés',
  smsPlus: 'SMS+',
  internetPlus: 'achats sur facture (Internet+)',
  etranger: 'appels et SMS vers l\'étranger',
};
const blocagesManquants = (ligne) => Object.keys(BLOCAGES_SIM).filter((k) => !(ligne && ligne.blocages && ligne.blocages[k] === true));

function refusSimSansNumero(t, ligne) {
  const nom = `la tablette ${(t && t.ref) || ''}`.trim();
  if (!t || !t.simId) return `Reliez d'abord une carte SIM à ${nom} (Stock, Cartes SIM).`;
  if (!ligne || !String(ligne.numero || '').replace(/\s/g, '')) {
    return `Notez d'abord le numéro de ligne de la carte SIM de ${nom} (Stock, Cartes SIM).`;
  }
  const manquants = blocagesManquants(ligne);
  if (manquants.length) {
    return `Activez d'abord chez l'opérateur, puis cochez sur la carte SIM de ${nom} (Stock, Cartes SIM), le blocage : ${manquants.map((k) => BLOCAGES_SIM[k]).join(', ')}.`;
  }
  return '';
}

// Offre unique avec carte SIM (Tanguy, 2026-10-30) : un premier envoi part seulement avec sa tablette reliée
// à la commande (Stock) et une carte SIM, avec son numéro, reliée à cette tablette. tablettes : fiches stock de la
// commande ; lignes : cartes SIM par id.
function refusEnvoiSansSim(c, tablettes, lignes = {}) {
  if (c.expedition === 'envoyee' || c.formule === 'wifi') return '';
  const t = tablettes.find((x) => ['en-stock', 'preparee', 'envoyee'].includes(x.etat));
  if (!t) return "Reliez d'abord la tablette à cette commande (Stock).";
  return refusSimSansNumero(t, t.simId ? lignes[t.simId] : null);
}

// « Colis déposé » avec le numéro T-… lu sur la tablette du carton (A14-4) : il doit être celui de la tablette
// reliée à la commande. Sans numéro saisi (anciens écrans de l'admin), rien n'est vérifié.
function refusAutreTablette(saisie, tablettes) {
  const norme = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^T0*(\d)/, 'T$1');
  const lu = norme(saisie);
  if (!lu) return '';
  const reliees = tablettes.filter((x) => ['en-stock', 'preparee', 'envoyee'].includes(x.etat));
  if (reliees.some((x) => norme(x.ref) === lu)) return '';
  const attendue = reliees.map((x) => x.ref).filter(Boolean).join(' ou ');
  return `La tablette du carton (${String(saisie).trim()}) n'est pas celle de cette commande${attendue ? ` (${attendue})` : ''} : vérifiez le numéro T-… collé sur la tablette.`;
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
  // Matériel prélevé puis arrivé quand même (colis en route à la date limite) : reçu, et remboursé d'office.
  if (r === 'facturee') return '';
  return "Aucun retour de matériel n'est attendu pour cette commande.";
}

// Tablette reliée à une commande : pas une tablette perdue, hors service ou à réparer, ni une commande annulée.
function refusLienCommande(tablette, etat, c) {
  if (ETATS_INUTILISABLES.includes(etat)) return 'Cette tablette est perdue, hors service ou à réparer : elle ne part chez aucun client.';
  if (c && c.expedition === 'annulee') return 'Cette commande est annulée.';
  // Tablette jumelée à une famille (la tablette de test de Tanguy) : jamais à vendre, sauf à la commande de cette
  // même famille (abonnement pris ensuite depuis l'appli).
  if (tablette && tablette.fid && c && c.fid !== tablette.fid) return 'Cette tablette est dans une famille : pas à vendre. Choisissez-en une autre.';
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
  refusEnvoiSansSim, refusSimSansNumero, refusAutreTablette, BLOCAGES_SIM, blocagesManquants,
  refusEtiquette, refusEtiquetteEnDouble, refusEnvoi, refusReception, refusRetourMateriel, refusLienCommande,
  refusStatutSim, refusRecharge, refusSuppressionSim, SUITES_SIM, RESTITUTION_EN_COURS,
};
