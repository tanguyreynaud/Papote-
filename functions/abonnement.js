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
// Un mois d'essai, sans engagement (Tanguy, 2026-10-20).
const ESSAI_JOURS = 30;
// Tablette incluse : à rendre dans les 30 jours après la fin de l'abonnement, sinon facturée
// (Tanguy, 2026-10-14) : tablette 160 €, chargeur et câble 10 €, routeur 4G 30 € seulement s'il était dans le colis
// (Tanguy, 2026-10-20 : la tablette 4G a sa propre SIM, le routeur n'est pas toujours fourni).
const RESTITUTION_JOURS = 30;
// Prix de chaque élément prêté, en centimes : un élément manquant au retour est facturé seul.
const PRIX_MATERIEL = { tablette: 16000, chargeur: 1000, routeur: 3000 };
const NOMS_MATERIEL = { tablette: 'tablette', chargeur: 'chargeur et câble', routeur: 'routeur 4G' };
// commande : { routeurFourni } (noté à la préparation du colis, voir gestionParcours).
const materielPrete = (commande) => (commande && commande.routeurFourni === true
  ? ['tablette', 'chargeur', 'routeur'] : ['tablette', 'chargeur']);
// Montant des éléments manquants (seulement ceux prêtés avec cette commande).
function montantManquants(commande, manquants) {
  const pretes = materielPrete(commande);
  return [...new Set(manquants || [])].filter((m) => pretes.includes(m))
    .reduce((total, m) => total + PRIX_MATERIEL[m], 0);
}
// Rien de rendu : tout le matériel prêté (170 €, 200 € avec un routeur 4G dans le colis).
const penaliteRestitution = (commande) => montantManquants(commande, materielPrete(commande));
const PENALITE_NON_RESTITUTION = penaliteRestitution({});
const PENALITE_NON_RESTITUTION_SIM = penaliteRestitution({ routeurFourni: true });

const STATUTS_OK = ['offert', 'actif', 'impaye'];

// Tarifs Stripe, retrouvés par leur « lookup key » (créés par outils/stripe/installer-stripe.js).
const TARIFS = {
  wifi: { achetee: 'papote_wifi_achetee', incluse: 'papote_wifi_incluse' },
  sim: { achetee: 'papote_sim_achetee', incluse: 'papote_sim_incluse' },
};
const TARIF_TABLETTE = 'papote_tablette';
// Tablette prêtée (incluse) : 60 € une fois à la commande, puis l'abonnement.
const TARIF_MISE_EN_SERVICE = 'papote_mise_en_service';

function formuleValide(formule, tablette) {
  return Boolean(TARIFS[formule] && TARIFS[formule][tablette]);
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

// Rétractation (Code de la consommation) : 14 jours après la réception de la tablette.
// Réception estimée à l'envoi + 3 jours (Mondial Relay) ; avant l'envoi, toujours possible.
// Au plus tôt, 14 jours après la commande.
const RETRACTATION_JOURS = 14;
const ACHEMINEMENT_JOURS = 3;
// Rappel avant de prélever le montant d'une tablette non rendue.
const RAPPEL_RESTITUTION_JOURS = 7;

function limiteRetractation(creeMs, envoyeeMs) {
  const depart = Math.max(creeMs || 0, envoyeeMs != null ? envoyeeMs + ACHEMINEMENT_JOURS * JOUR : 0);
  return depart + RETRACTATION_JOURS * JOUR;
}

// La commande peut-elle encore être annulée et remboursée ?
// commande : commandes/{id} (expedition, creeLe, envoyeeLe, retractation).
function retractationPossible(commande, maintenant) {
  if (!commande || commande.retractation) return false;
  if (commande.expedition === 'a-preparer') return true;
  return maintenant <= limiteRetractation(enMillis(commande.creeLe), enMillis(commande.envoyeeLe));
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

// Code de commande à 8 caractères (sans 0, O, 1, I, L), affiché XXXX-XXXX : il relie une commande
// à la famille quand le client ne se connecte pas avec l'adresse e-mail du paiement.
const ALPHABET_CODE = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function nouveauCode(aleatoire = Math.random) {
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

// Faut-il appliquer un événement Stripe à cette famille ? Une famille offerte ne change jamais.
function peutModifier(actuel) {
  return !(actuel && actuel.statut === 'offert');
}

module.exports = {
  DELAI_GRACE_JOURS,
  ESSAI_JOURS,
  RESTITUTION_JOURS,
  PENALITE_NON_RESTITUTION,
  PENALITE_NON_RESTITUTION_SIM,
  penaliteRestitution,
  PRIX_MATERIEL,
  NOMS_MATERIEL,
  materielPrete,
  montantManquants,
  limiteRestitution,
  restitutionEchue,
  RETRACTATION_JOURS,
  limiteRetractation,
  retractationPossible,
  rappelRestitutionDu,
  dateResiliation,
  STATUTS_OK,
  TARIFS,
  TARIF_TABLETTE,
  TARIF_MISE_EN_SERVICE,
  formuleValide,
  estActif,
  statutDepuisStripe,
  graceDepassee,
  peutModifier,
  nouveauCode,
  normaliserCode,
  afficherCode,
};
