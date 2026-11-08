// Tablette perdue ou volée : la remplaçante, et ce que paie la famille (Tanguy, 8/11).
// Après « Tablette volée : tout couper » (tablette-volee.js), l'admin enchaîne sur le même écran :
//   - une tablette libre en stock → « Envoyer une tablette de remplacement » ;
//   - stock vide → « Acheter une tablette de remplacement » : une fiche « Commandée, pas encore reçue » réservée à
//     cette commande (reserveePour), et une ligne dans « À faire » jusqu'à ce qu'elle parte (« Envoyer la tablette de
//     remplacement » sur la commande, dès sa réception).
// Envoyer = PRÉLEVER D'ABORD (ordre validé par Tanguy, 8/11) : la famille paie le matériel perdu comme un matériel
// non rendu (CGV : 140 €, ou 150 € si une enceinte a été fournie), sur le compte de l'abonnement (index.js
// preleverMateriel). Seulement si le prélèvement passe : le remplacement de « Remplacer un élément du kit »
// (gestion.js remplacer), la carte SIM aussi si la case est cochée, puis l'étiquette d'envoi. Refusé : rien n'est
// remplacé ni envoyé, l'admin voit le motif, Papote est prévenu. La famille reçoit un e-mail dans les deux cas.
// Jamais deux prélèvements : la tentative est notée (transaction) avant l'appel à Stripe, un deuxième clic pendant
// ce temps est refusé, et chaque tentative a sa clé d'idempotence perte-<commande>-<tablette>-<n° d'essai> (un
// nouvel essai après un refus en prend une nouvelle : Stripe rejouerait sinon le même refus).
//
// commandes/{id}.perte : { tablette (fiche perdue), statut, remplacante (fiche qui part ou achetée), montant, essai,
//   le, par, paiement, erreur, envoyeeLe, majLe }. statut :
//   achat       remplaçante achetée, pas encore partie (ligne dans « À faire »)
//   prelevement prélèvement en cours (deux clics : le second est refusé ; arrêt en plein milieu : voir Stripe)
//   echec       prélèvement refusé : rien n'est parti (Papote prévenu, ligne dans « À faire ») ; un nouvel essai est permis
//   payee       prélevé, remplacement pas encore écrit (panne juste après) : « Envoyer » le termine sans reprélever
//   remplacement prélevé, remplacement en cours d'écriture (deux clics : le second est refusé)
//   envoyee     prélevé et remplaçante partie
//   offerte     commande offerte : remplaçante partie sans rien prélever
// Une nouvelle perte sur la même commande (autre tablette, la précédente finie) range l'ancienne dans pertesPassees.
//
// Sans dépendance : règles pures, testées dans perte.test.js. Le reste est dans index.js (tabletteRemplacement).
'use strict';

const regles = require('./abonnement');

const LIBELLE = 'Papote : tablette perdue ou volée';
const FINIS = ['envoyee', 'offerte'];

// 140 €, ou 150 € si une enceinte a été fournie (commande.enceinteFournie) : le prix d'un kit non rendu.
const montant = (commande) => regles.penaliteRestitution(commande || {});
const cle = (commande, tablette, essai = 1) => `perte-${commande}-${tablette}-${essai}`;

// Paramètres de l'appel admin. action : 'envoyer' (nouveau = fiche qui part) ou 'acheter'.
const ID = /^[A-Za-z0-9_-]{1,100}$/;
function verifierParams(p) {
  const d = p || {};
  if (!['envoyer', 'acheter'].includes(d.action)) return { erreur: 'Action inconnue.' };
  if (typeof d.commande !== 'string' || !ID.test(d.commande)) return { erreur: 'Commande manquante.' };
  if (typeof d.ancienne !== 'string' || !ID.test(d.ancienne)) return { erreur: 'Tablette perdue manquante.' };
  if (d.action === 'envoyer' && (typeof d.nouveau !== 'string' || !ID.test(d.nouveau))) return { erreur: 'Choisissez la tablette qui part.' };
  if (d.sim != null && (typeof d.sim !== 'string' || !ID.test(d.sim))) return { erreur: 'Carte SIM invalide.' };
  return { action: d.action, commande: d.commande, ancienne: d.ancienne, nouveau: d.nouveau || null, sim: d.sim || null };
}

// La fiche perdue est-elle bien celle de cette commande ? '' si oui, sinon le message (pure).
function refusAncienne(fiche, commande) {
  if (!fiche) return 'Tablette perdue introuvable.';
  if (fiche.etat !== 'perdue') return 'Coupez d\'abord la tablette (« Tablette volée : tout couper ») : elle doit être notée perdue.';
  if (fiche.commande !== commande && fiche.perdueDe !== commande) return 'Cette tablette n\'est pas celle de cette commande.';
  return '';
}

// Que faire de la demande, d'après la perte déjà notée sur la commande (pure) ?
// → { refus, code } | { deja: true } | { nouveau: true, essai, archiver? } | { remplacer: true } (déjà payée)
// Prélèvement resté « en cours » plus de 10 minutes (arrêt en plein milieu) : on peut relancer avec la MÊME clé,
// Stripe rend alors le paiement déjà fait au lieu d'en faire un second.
const BLOCAGE_MS = 10 * 60 * 1000;
function decision(perte, { action, ancienne }, maintenant = Date.now()) {
  const p = perte || null;
  if (p && p.tablette !== ancienne) {
    if (!FINIS.includes(p.statut)) return { refus: 'Un autre remplacement de tablette est en cours pour cette commande.', code: 'failed-precondition' };
    return { nouveau: true, essai: 1, archiver: true };
  }
  if (!p) return { nouveau: true, essai: 1 };
  if (p.statut === 'prelevement' && action === 'envoyer' && maintenant - (p.le || 0) > BLOCAGE_MS) return { nouveau: true, essai: p.essai || 1 };
  if (p.statut === 'prelevement') return { refus: 'Prélèvement déjà en cours (double clic ?) : rechargez la page.', code: 'already-exists' };
  if (FINIS.includes(p.statut)) return { deja: true };
  if (action === 'acheter') {
    if (p.statut === 'achat') return { deja: true };
    if (['payee', 'remplacement'].includes(p.statut)) return { refus: 'La perte est déjà payée : envoyez la tablette de remplacement.', code: 'failed-precondition' };
    return { nouveau: true, essai: p.essai || 0 };
  }
  if (p.statut === 'payee') return { remplacer: true };
  if (p.statut === 'remplacement') {
    return maintenant - (p.remplacementLe || 0) > BLOCAGE_MS ? { remplacer: true }
      : { refus: 'Remplacement déjà en cours (double clic ?) : rechargez la page.', code: 'already-exists' };
  }
  // achat ou echec : nouvel essai de prélèvement (une autre tablette du stock peut partir à la place de celle
  // achetée, perte.achetee : index.js la libère).
  return { nouveau: true, essai: (p.essai || 0) + 1 };
}

// Ce que la page admin montre d'une perte (pure).
function resume(p) {
  if (!p) return null;
  return { statut: p.statut || null, montant: p.montant ?? null, erreur: p.erreur || null, remplacante: p.remplacante || null };
}

// Ligne d'état lisible pour l'admin (pure) : « 140 € prélevés, tablette partie », « prélèvement refusé : … »…
function texteStatut(p, euros) {
  if (!p) return '';
  const m = p.montant != null ? euros(p.montant) : '';
  switch (p.statut) {
    case 'achat': return 'tablette de remplacement achetée, à envoyer dès sa réception (le prélèvement se fait à l\'envoi)';
    case 'prelevement': return `prélèvement de ${m} en cours`;
    case 'echec': return `prélèvement de ${m} refusé${p.erreur ? ` (${p.erreur})` : ''} : rien n'est parti`;
    case 'remplacement': return `${m} prélevés, remplacement en cours`;
    case 'payee': return `${m} prélevés, remplacement à terminer (« Envoyer la tablette de remplacement »)`;
    case 'envoyee': return `${m} prélevés, tablette de remplacement partie`;
    case 'offerte': return 'commande offerte : tablette de remplacement partie, rien prélevé';
    default: return p.statut || '';
  }
}

module.exports = { LIBELLE, FINIS, BLOCAGE_MS, montant, cle, verifierParams, refusAncienne, decision, resume, texteStatut };
