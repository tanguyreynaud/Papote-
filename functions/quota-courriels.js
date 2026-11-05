// Quota d'e-mails Brevo (offre gratuite : 300 e-mails par jour, pour TOUS les envois : clients, proches, admin).
// Chaque e-mail parti est compté dans interne/courriels-AAAA-MM-JJ (jour de Paris). Les envois en nombre
// (campagne d'information, ouverture de la liste d'attente) ne prennent jamais les 100 derniers : il en reste
// toujours pour les e-mails qui ne peuvent pas attendre (« aucun téléphone n'a sonné », invitations, colis parti,
// paiement échoué). Au-delà de 300, Brevo refuse et l'e-mail est perdu (rien ne le renvoie) : on prévient avant.
const { FieldValue } = require('firebase-admin/firestore');

const PLAFOND_JOUR = Number(process.env.BREVO_PLAFOND_JOUR || 300);
const RESERVE_URGENTS = 100;
const ALERTE_A = Math.round(PLAFOND_JOUR * 0.8);

function jourParis(ms = Date.now()) {
  return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
const ref = (db, ms) => db.doc(`interne/courriels-${jourParis(ms)}`);

// Nombre d'envois en nombre encore permis aujourd'hui, sur `voulus`.
function permisEnNombre(dejaPartis, voulus) {
  return Math.max(0, Math.min(voulus, PLAFOND_JOUR - RESERVE_URGENTS - dejaPartis));
}

async function partisAujourdhui(db) {
  const snap = await ref(db).get();
  return (snap.exists && snap.get('n')) || 0;
}

// Compte n e-mails partis (best effort : un compteur en panne n'empêche jamais un envoi). Un seul document par
// jour, écrit au plus 300 fois : loin de la limite d'une écriture par seconde et par document.
async function compter(db, n = 1, logger = console) {
  try {
    await ref(db).set({ n: FieldValue.increment(n), majLe: FieldValue.serverTimestamp() }, { merge: true });
    const total = await partisAujourdhui(db);
    if (total >= ALERTE_A && total - n < ALERTE_A) {
      logger.warn(`Brevo : ${total} e-mails partis aujourd'hui sur ${PLAFOND_JOUR} (offre gratuite). Au-delà, les e-mails sont refusés et perdus.`);
    }
    return total;
  } catch (e) {
    logger.warn('Compteur d\'e-mails illisible', e.message);
    return null;
  }
}

module.exports = { PLAFOND_JOUR, RESERVE_URGENTS, jourParis, permisEnNombre, partisAujourdhui, compter };
