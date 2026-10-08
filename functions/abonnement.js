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
// Tablette incluse : à rendre dans les 30 jours après la fin de l'abonnement, sinon 100 €.
const RESTITUTION_JOURS = 30;
const PENALITE_NON_RESTITUTION = 10000; // centimes

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

// Date limite de retour d'une tablette incluse, à partir de la fin de l'abonnement.
function limiteRestitution(finMs) {
  return finMs + RESTITUTION_JOURS * JOUR;
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
  ENGAGEMENT_MOIS,
  finEngagement,
  RESTITUTION_JOURS,
  PENALITE_NON_RESTITUTION,
  limiteRestitution,
  restitutionEchue,
  dateResiliation,
  STATUTS_OK,
  TARIFS,
  TARIF_TABLETTE,
  formuleValide,
  estActif,
  statutDepuisStripe,
  graceDepassee,
  peutModifier,
  nouveauCode,
  normaliserCode,
  afficherCode,
};
