// Relance des paniers abandonnés (décision Tanguy, 2026-10-15) : trois e-mails au plus, envoyés
// seulement si la personne a coché l'accord sur la page de commande et n'a pas payé depuis :
//   1. une heure après l'ouverture du paiement ;
//   2. le lendemain soir, à 19 h (heure de Paris) ;
//   3. une semaine après, à 19 h.
// Stripe ne recueille l'accord e-mails qu'aux États-Unis : l'accord et l'e-mail sont donc pris sur
// commande.html, et les paniers sont notés dans paniers/{session} à l'ouverture du paiement.

const HEURE = 60 * 60 * 1000;
const JOUR = 24 * HEURE;
const HEURE_DU_SOIR = 19;
const RELANCES_MAX = 3;

// Instant (ms) de hh:00 à Paris, « jours » jours après la date (à Paris) de ms.
function soirParis(ms, jours, heure = HEURE_DU_SOIR) {
  const [a, m, j] = new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }).split('-').map(Number);
  const essai = Date.UTC(a, m - 1, j + jours, heure);
  // Décalage de Paris à cet instant (1 h en hiver, 2 h en été).
  const vu = new Date(essai).toLocaleString('sv-SE', { timeZone: 'Europe/Paris' }).replace(' ', 'T') + 'Z';
  return essai - (Date.parse(vu) - essai);
}

function echeances(creeMs) {
  return [creeMs + HEURE, soirParis(creeMs, 1), soirParis(creeMs, 7)];
}

// Numéro de la relance à envoyer maintenant (1 à 3), ou null. Une relance en retard au point
// que la suivante est déjà due est sautée : on n'envoie jamais deux e-mails d'affilée.
function relanceDue(creeMs, dejaEnvoyees, maintenant) {
  if (creeMs == null) return null;
  const t = echeances(creeMs);
  for (let k = (dejaEnvoyees || 0) + 1; k <= RELANCES_MAX; k++) {
    if (maintenant < t[k - 1]) return null;
    if (k === RELANCES_MAX || maintenant < t[k]) return k;
  }
  return null;
}

module.exports = { soirParis, echeances, relanceDue, RELANCES_MAX, JOUR };
