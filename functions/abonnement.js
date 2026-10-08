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
const ESSAI_JOURS = 15;
const ENGAGEMENT_MOIS = 12;

const STATUTS_OK = ['offert', 'actif', 'impaye'];

// Tarifs Stripe, retrouvés par leur « lookup key » (créés par outils/stripe/installer-stripe.js).
const TARIFS = {
  wifi: { achetee: 'papote_wifi_achetee', incluse: 'papote_wifi_incluse' },
  sim: { achetee: 'papote_sim_achetee', incluse: 'papote_sim_incluse' },
};
const TARIF_TABLETTE = 'papote_tablette';

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

// Fin de l'engagement de 12 mois, compté à partir de la fin de l'essai gratuit.
// debut : en millisecondes (fin d'essai, ou début de l'abonnement sans essai).
function finEngagement(debut) {
  const d = new Date(debut);
  const jour = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + ENGAGEMENT_MOIS);
  // 31 janvier + 12 mois reste le 31 janvier ; 29 février devient le 28 février.
  const dernierJour = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(jour, dernierJour));
  return d.getTime();
}

// Date d'arrêt d'une résiliation demandée maintenant : fin du mois déjà payé,
// et jamais avant la fin de l'engagement.
function dateResiliation(finEngagementMs, finPeriodeMs, maintenant) {
  return Math.max(finEngagementMs || 0, finPeriodeMs || 0, maintenant);
}

// Faut-il appliquer un événement Stripe à cette famille ? Une famille offerte ne change jamais.
function peutModifier(actuel) {
  return !(actuel && actuel.statut === 'offert');
}

module.exports = {
  DELAI_GRACE_JOURS,
  ESSAI_JOURS,
  ENGAGEMENT_MOIS,
  finEngagement,
  dateResiliation,
  STATUTS_OK,
  TARIFS,
  TARIF_TABLETTE,
  formuleValide,
  estActif,
  statutDepuisStripe,
  graceDepassee,
  peutModifier,
};
