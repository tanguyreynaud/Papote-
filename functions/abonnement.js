// Règles d'abonnement de Papote, sans dépendance : testées par abonnement.test.js.
//
// families/{fid}.abonnement.statut :
//   offert    : famille offerte (celle de Tanguy), jamais suspendue
//   actif     : abonnement payé
//   impaye    : paiement échoué, tout fonctionne encore jusqu'à graceJusqua
//   suspendu  : délai de grâce dépassé, tablette en pause et envois bloqués
//   resilie   : abonnement terminé, comme suspendu
//   aucun     : famille créée sans abonnement, comme suspendu
// Champ absent : famille d'avant les abonnements, traitée comme active.

const JOUR = 24 * 60 * 60 * 1000;
const DELAI_GRACE_JOURS = 7;
// Sans engagement, chaque mois payé une fois écoulé (Tanguy, 2026-10-21) : pas de prélèvement avant la
// réception, puis, à l'envoi, premier prélèvement recalé sur la fin des 30 jours pour changer d'avis
// (limiteRetractation) ; le dernier mois est prélevé à l'arrêt.
// Sur la page de paiement, plus d'« essai gratuit » (Tanguy, 2026-10-27 : « 90 jours gratuits » se lisait comme une
// promesse) : une date de premier prélèvement (billing_cycle_anchor), estimée d'après le délai annoncé.
// Un seul délai annoncé depuis le 29/10/2026 : expédiée sous 3 à 5 jours ouvrés, quel que soit le stock (delai n'est
// plus lu). 7 jours : 5 jours ouvrés et un week-end.
const ATTENTE_ENVOI = 7;
function premierPrelevementMs(delai, maintenant, { dejaInstallee = false } = {}) {
  const attente = dejaInstallee ? 0 : ATTENTE_ENVOI;
  return maintenant + (attente + RETRACTATION_JOURS) * JOUR;
}
// Stripe refuse une date de départ (billing_cycle_anchor) au-delà de la prochaine échéance naturelle, un mois après
// le paiement (« le paiement n'a pas pu s'ouvrir », 27/10). La page de paiement part donc au plus à 27 jours (février
// compris), et la vraie date (premierPrelevementMs) est posée dès le paiement reçu (trial_end, paiementTermine).
const ANCRE_MAX_JOURS = 27;
function ancrePaiement(premier, maintenant) {
  return Math.min(premier, maintenant + ANCRE_MAX_JOURS * JOUR);
}
// Date du premier prélèvement d'un abonnement Stripe qui n'a encore rien prélevé (ms), sinon null :
// « trial » recalé à l'envoi, ou date de départ posée au paiement et pas encore atteinte.
function premierPrelevementDe(abo, maintenant) {
  if (!abo) return null;
  if (abo.status === 'trialing' && abo.trial_end) return abo.trial_end * 1000;
  if (abo.status === 'active' && abo.billing_cycle_anchor && abo.billing_cycle_anchor * 1000 > maintenant) return abo.billing_cycle_anchor * 1000;
  return null;
}
// Tablette incluse : à rendre dans les 30 jours après la fin de l'abonnement, sinon facturée
// (Tanguy, 2026-10-20, comme les conditions de vente) : tablette 130 €, chargeur et câble 10 €,
// enceinte 10 € seulement si elle était dans le colis. Plus de routeur 4G ; le socle n'est pas facturé.
const RESTITUTION_JOURS = 30;
// Prix de chaque élément prêté, en centimes : un élément manquant au retour est facturé seul.
const PRIX_MATERIEL = { tablette: 13000, chargeur: 1000, enceinte: 1000 };
const NOMS_MATERIEL = { tablette: 'tablette', chargeur: 'chargeur et câble', enceinte: 'enceinte' };
// commande : { enceinteFournie } (noté à la préparation du colis, voir gestionParcours).
const materielPrete = (commande) => (commande && commande.enceinteFournie === true
  ? ['tablette', 'chargeur', 'enceinte'] : ['tablette', 'chargeur']);
// Montant des éléments manquants (seulement ceux prêtés avec cette commande).
function montantManquants(commande, manquants) {
  const pretes = materielPrete(commande);
  return [...new Set(manquants || [])].filter((m) => pretes.includes(m))
    .reduce((total, m) => total + PRIX_MATERIEL[m], 0);
}
// Rien de rendu : tout le matériel prêté (140 €, 150 € avec l'enceinte).
const penaliteRestitution = (commande) => montantManquants(commande, materielPrete(commande));
const PENALITE_NON_RESTITUTION = penaliteRestitution({});

const STATUTS_OK = ['offert', 'actif', 'impaye'];

// Famille suspendue (impayé au-delà du délai de grâce) depuis plus de 30 jours : le retour de la tablette est
// à demander, à la main (Tanguy, 2026-10-27, C2 ; les CGV le disent).
const SUSPENSION_RETOUR_JOURS = 30;
function suspendueDepuisTrop(abonnement, maintenant) {
  if (!abonnement || abonnement.statut !== 'suspendu') return false;
  const depuis = enMillis(abonnement.suspenduLe != null ? abonnement.suspenduLe : abonnement.majLe);
  return depuis != null && maintenant - depuis >= SUSPENSION_RETOUR_JOURS * JOUR;
}

// Fin d'installation sans commande reliée : 48 h de tolérance, tout fonctionne, pendant lesquelles Tanguy
// relie la commande à la main (statut « installation » gardé, abonnement.toleranceJusqua), puis « aucun ».
const TOLERANCE_INSTALLATION_MS = 48 * 60 * 60 * 1000;
function toleranceDepassee(abonnement, maintenant) {
  if (!abonnement || abonnement.statut !== 'installation') return false;
  const fin = enMillis(abonnement.toleranceJusqua);
  return fin != null && fin <= maintenant;
}

// Changement de statut qui mérite de prévenir la famille (C1) : 'impaye' (paiement échoué, pause dans 7 jours)
// ou 'suspendu' (Papote en pause), une seule fois par épisode.
function avisPaiement(avant, apres) {
  const a = (avant && avant.statut) || null;
  if (apres === 'impaye' && !['impaye', 'suspendu'].includes(a)) return 'impaye';
  if (apres === 'suspendu' && a !== 'suspendu') return 'suspendu';
  return null;
}

// Tarifs Stripe, retrouvés par leur « lookup key » (créés par outils/stripe/installer-stripe.js).
const TARIFS = {
  wifi: { achetee: 'papote_wifi_achetee', incluse: 'papote_wifi_incluse' },
  sim: { achetee: 'papote_sim_achetee', incluse: 'papote_sim_incluse' },
};
const TARIF_TABLETTE = 'papote_tablette';
// Tablette prêtée (incluse) : 60 € une fois à la commande, puis l'abonnement.
const TARIF_MISE_EN_SERVICE = 'papote_mise_en_service';

// La tablette n'est plus vendue (Tanguy, 2026-10-22) : seule la tablette prêtée (« incluse ») se commande.
// Les tarifs « achetee » restent dans TARIFS pour lire les anciennes commandes de test.
function formuleValide(formule, tablette) {
  return tablette === 'incluse' && Boolean(TARIFS[formule] && TARIFS[formule][tablette]);
}
// Offre unique depuis le 29/10/2026 (Tanguy) : 25 € par mois tout compris, carte SIM toujours fournie.
// Plus de formule Wi-Fi : un ancien lien (formule=wifi, ou sans formule) donne aussi l'offre unique.
const FORMULE = 'sim';
// → 'sim', ou null si la demande ne correspond à rien (tablette achetée, formule inconnue).
function formuleVendue(formule, tablette = 'incluse') {
  if (formule != null && formule !== '' && !TARIFS[formule]) return null;
  return formuleValide(FORMULE, tablette) ? FORMULE : null;
}

// La tablette fonctionne et la famille peut envoyer.
function estActif(abonnement) {
  if (!abonnement || !abonnement.statut) return true;
  return STATUTS_OK.includes(abonnement.statut);
}

function enMillis(date) {
  if (date == null) return null;
  if (typeof date === 'number') return date;
  if (date instanceof Date) return date.getTime();
  if (typeof date.toMillis === 'function') return date.toMillis();
  return null;
}

// Nouvel état de la famille d'après le statut de l'abonnement Stripe.
// actuel : families/{fid}.abonnement avant l'événement ; maintenant : en millisecondes.
// Renvoie { statut, graceJusqua (millisecondes ou null) }.
function statutDepuisStripe(statutStripe, actuel, maintenant) {
  switch (statutStripe) {
    case 'active':
    case 'trialing':
      return { statut: 'actif', graceJusqua: null };
    case 'past_due': {
      const dejaEnRetard = actuel && ['impaye', 'suspendu'].includes(actuel.statut);
      const graceActuelle = dejaEnRetard ? enMillis(actuel.graceJusqua) : null;
      const grace = graceActuelle != null ? graceActuelle : maintenant + DELAI_GRACE_JOURS * JOUR;
      return { statut: grace <= maintenant ? 'suspendu' : 'impaye', graceJusqua: grace };
    }
    case 'unpaid':
    case 'paused':
      return { statut: 'suspendu', graceJusqua: null };
    case 'canceled':
    case 'incomplete_expired':
      return { statut: 'resilie', graceJusqua: null };
    default:
      // incomplete : le premier paiement n'est pas encore passé.
      return { statut: 'aucun', graceJusqua: null };
  }
}

// Le délai de grâce est-il dépassé ?
function graceDepassee(abonnement, maintenant) {
  if (!abonnement || abonnement.statut !== 'impaye') return false;
  const grace = enMillis(abonnement.graceJusqua);
  return grace != null && grace <= maintenant;
}

// Date d'arrêt d'une résiliation demandée maintenant : fin du mois déjà payé (sans engagement).
function dateResiliation(finPeriodeMs, maintenant) {
  return Math.max(finPeriodeMs || 0, maintenant);
}

// Date limite de retour d'une tablette incluse, à partir de la fin de l'abonnement.
function limiteRestitution(finMs) {
  return finMs + RESTITUTION_JOURS * JOUR;
}

// « Annuler ma commande » : 30 jours après la réception de la tablette (CGV : le délai légal
// de 14 jours est porté à 30 : rien à payer pour l'abonnement et les 60 € remboursés).
// Réception : la vraie date quand on la connaît (colis « livré » au suivi Mondial Relay, tablette reliée à
// la famille, ou cochée dans l'admin : preparation.recuLe), sinon estimée à l'envoi + 3 jours.
// Avant l'envoi, toujours possible. Au plus tôt, 30 jours après la commande.
const RETRACTATION_JOURS = 30;
const ACHEMINEMENT_JOURS = 3;
// Rappel avant de prélever le montant d'une tablette non rendue.
const RAPPEL_RESTITUTION_JOURS = 7;

function limiteRetractation(creeMs, envoyeeMs, recueMs) {
  const reception = recueMs != null ? recueMs : (envoyeeMs != null ? envoyeeMs + ACHEMINEMENT_JOURS * JOUR : 0);
  return Math.max(creeMs || 0, reception) + RETRACTATION_JOURS * JOUR;
}

// Date de réception connue d'une commande (millisecondes), sinon null.
function receptionDe(commande) {
  return enMillis(commande && commande.preparation && commande.preparation.recuLe);
}

// La tablette est-elle partie chez le client ? Pas tant que la commande est à préparer ou que la banque
// n'a pas encore confirmé le prélèvement SEPA (« paiement-en-attente ») : rien à rendre dans ce cas.
const AVANT_ENVOI = ['a-preparer', 'paiement-en-attente'];
function materielParti(commande) {
  if (!commande) return false;
  if (commande.envoyeeLe || commande.expedition === 'envoyee') return true;
  return !AVANT_ENVOI.includes(commande.expedition) && commande.expedition !== 'annulee';
}

// La commande peut-elle encore être annulée et remboursée ?
// commande : commandes/{id} (expedition, creeLe, envoyeeLe, retractation).
// Reprise d'un abonnement résilié (tablette restée chez le proche, pas de mise en service) : ce n'est pas
// une nouvelle vente, rien à annuler (Tanguy, 2026-10-27, C3).
function retractationPossible(commande, maintenant) {
  if (!commande || commande.retractation || commande.expedition === 'annulee' || commande.reprise) return false;
  if (!materielParti(commande)) return true;
  return maintenant <= limiteRetractation(enMillis(commande.creeLe), enMillis(commande.envoyeeLe), receptionDe(commande));
}

// Rappel « dernière semaine pour rendre la tablette » : une seule fois, 7 jours avant la limite.
function rappelRestitutionDu(restitution, maintenant) {
  if (!restitution || restitution.statut !== 'attendue' || restitution.rappelLe) return false;
  const limite = enMillis(restitution.avant);
  return limite != null && limite - RAPPEL_RESTITUTION_JOURS * JOUR <= maintenant && maintenant < limite;
}

// Faut-il prélever la pénalité ? Seulement si la tablette est attendue et le délai dépassé.
function restitutionEchue(restitution, maintenant) {
  if (!restitution || restitution.statut !== 'attendue') return false;
  const limite = enMillis(restitution.avant);
  return limite != null && limite <= maintenant;
}

// Ancienne commande d'un client qui recommande (même IBAN, e-mail, téléphone ou adresse) : raisons d'en faire
// un mauvais payeur (Tanguy, 2026-10-22 : « grosse signalisation » avant d'envoyer une 2e tablette).
// commande : commandes/{id} ; statutFamille : families/{fid}.abonnement.statut ou null.
function raisonsMauvaisPayeur(commande, statutFamille) {
  const c = commande || {};
  const r = [];
  if ((c.contestations || []).length) r.push('prélèvement contesté à la banque');
  if (c.dernierMois && c.dernierMois.statut === 'echec') r.push('dernier mois impayé');
  if (c.restitution && c.restitution.statut === 'echec') r.push('matériel non rendu et non payé');
  else if (c.restitution && c.restitution.statut === 'facturee') r.push('matériel jamais rendu');
  if (['impaye', 'suspendu'].includes(statutFamille)) r.push('abonnement impayé');
  return r;
}

// Code de commande à 8 caractères (sans 0, O, 1, I, L), affiché XXXX-XXXX : il relie une commande
// à la famille quand le client ne se connecte pas avec l'adresse e-mail du paiement.
const ALPHABET_CODE = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// Hasard cryptographique : le code sert de preuve d'achat (rattacherCommande).
const hasardSur = () => require('node:crypto').randomInt(0, 2 ** 32) / 2 ** 32;

function nouveauCode(aleatoire = hasardSur) {
  let code = '';
  for (let i = 0; i < 8; i++) code += ALPHABET_CODE[Math.floor(aleatoire() * ALPHABET_CODE.length)];
  return code;
}

// « abcd efgh », « ABCD-EFGH » → « ABCDEFGH » ; null si ce n'est pas un code.
function normaliserCode(saisie) {
  if (typeof saisie !== 'string') return null;
  const code = saisie.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 8 || [...code].some((c) => !ALPHABET_CODE.includes(c))) return null;
  return code;
}

function afficherCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// Facture Stripe telle que l'appli famille la montre (page « Abonnement et paiement ») : brouillons et factures
// annulées écartés, lien du PDF à télécharger. statut : 'payee' | 'a-payer'.
function factureClient(f) {
  if (!f || !['paid', 'open', 'uncollectible'].includes(f.status)) return null;
  return {
    id: f.id,
    numero: f.number || null,
    le: f.created * 1000,
    montant: f.status === 'paid' ? f.amount_paid : f.amount_due,
    statut: f.status === 'paid' ? 'payee' : 'a-payer',
    pdf: f.invoice_pdf || null,
    page: f.hosted_invoice_url || null,
  };
}

// Faut-il appliquer un événement Stripe à cette famille ? Une famille offerte ne change jamais.
function peutModifier(actuel) {
  return !(actuel && actuel.statut === 'offert');
}

module.exports = {
  DELAI_GRACE_JOURS,
  ATTENTE_ENVOI,
  premierPrelevementMs,
  ancrePaiement,
  premierPrelevementDe,
  RESTITUTION_JOURS,
  PENALITE_NON_RESTITUTION,
  penaliteRestitution,
  PRIX_MATERIEL,
  NOMS_MATERIEL,
  materielPrete,
  montantManquants,
  limiteRestitution,
  restitutionEchue,
  RETRACTATION_JOURS,
  receptionDe,
  materielParti,
  raisonsMauvaisPayeur,
  limiteRetractation,
  retractationPossible,
  rappelRestitutionDu,
  dateResiliation,
  STATUTS_OK,
  SUSPENSION_RETOUR_JOURS,
  suspendueDepuisTrop,
  TOLERANCE_INSTALLATION_MS,
  toleranceDepassee,
  avisPaiement,
  TARIFS,
  TARIF_TABLETTE,
  TARIF_MISE_EN_SERVICE,
  formuleValide,
  formuleVendue,
  FORMULE,
  estActif,
  statutDepuisStripe,
  graceDepassee,
  peutModifier,
  factureClient,
  nouveauCode,
  normaliserCode,
  afficherCode,
};
