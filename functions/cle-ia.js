// Clé IA (Anthropic) refusée : UN e-mail à Papote, au plus une fois par 24 h (incident du 11/11 : la clé
// ANTHROPIC_API_KEY a expiré et personne ne l'a vu pendant 6 jours ; le chat du site, l'IA de l'admin et la lecture
// des factures répondaient seulement « indisponible »).
//
// signalerCleIA(erreur, options) est appelé dans chaque catch autour d'un appel à Anthropic (support.js,
// ia-admin.js, gestion.js lireDocument : lecture d'une facture depuis l'admin et factures reçues par e-mail).
// Il ne fait rien pour une autre erreur (panne 5xx, surcharge, délai…) et ne lève jamais d'erreur : la réponse
// donnée à l'utilisateur ne change pas.
//
// Même chemin que les autres alertes de l'admin (prevenirPapote d'index.js) : mail.alerteAdmin envoyé à
// contact@mapapote.fr. Pas de nouvelle tâche planifiée : l'alerte part au moment du refus.
// Anti-doublon : interne/cleIa { alerteLe, dernierRefusLe, statut, source } ; un nouvel e-mail seulement si le
// précédent date de plus de 24 h. La clé elle-même n'est jamais lue ici, ni journalisée, ni enregistrée (pas même
// le message d'erreur d'Anthropic : seulement le code HTTP et le type d'erreur).

const { defineSecret, defineString } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { Timestamp } = require('firebase-admin/firestore');

const MAIL_SMTP = defineString('MAIL_SMTP', { default: 'smtp.gmail.com:465:' });
const MAIL_EXPEDITEUR = defineString('MAIL_EXPEDITEUR', { default: '' });
const MAIL_MOT_DE_PASSE = defineSecret('MAIL_MOT_DE_PASSE');

const EMAIL_PAPOTE = 'contact@mapapote.fr';
const DOCUMENT = 'interne/cleIa';
const DELAI = 24 * 3600_000;
const TYPES_REFUS = ['authentication_error', 'permission_error'];

const TITRE = 'La clé IA (Anthropic) est refusée';
const TEXTE = 'La clé IA (Anthropic) est refusée : chat du site, IA de l\'admin et lecture des factures sont en panne. '
  + 'Créer une nouvelle clé et lancer outils\\support\\installer-support.bat, puis republier les fonctions.';

const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : typeof v === 'number' ? v : null);

// Type d'erreur d'Anthropic (corps { type: 'error', error: { type } }), quelle que soit la forme de l'erreur du SDK.
function typeErreur(e) {
  if (!e) return null;
  const corps = e.error;
  return (corps && corps.error && corps.error.type) || (corps && corps.type !== 'error' && corps.type) || null;
}

// Vrai quand Anthropic refuse la clé : 401 (clé invalide, expirée, révoquée), 403 (permission refusée), ou le type
// authentication_error / permission_error.
function refusDeCle(e) {
  if (!e || typeof e !== 'object') return false;
  const statut = Number(e.status);
  return statut === 401 || statut === 403 || TYPES_REFUS.includes(typeErreur(e));
}

// E-mail à Papote, comme prevenirPapote d'index.js. La fonction appelante doit déclarer MAIL_MOT_DE_PASSE.
async function prevenirParDefaut(titre, detail) {
  const mail = require('./mail');
  await mail.envoyer({
    smtp: MAIL_SMTP.value(), expediteur: MAIL_EXPEDITEUR.value(), motDePasse: MAIL_MOT_DE_PASSE.value(),
    a: EMAIL_PAPOTE, contenu: mail.alerteAdmin({ titre, detail }),
  });
}

// erreur : l'erreur levée par le SDK Anthropic. options : { source (« chat du site »…), db (base ou fonction qui la
// rend), prevenir(titre, detail), maintenant }. Rend 'alerte' (e-mail parti), 'deja' (alerte de moins de 24 h),
// ou null (pas un refus de clé, ou alerte impossible).
async function signalerCleIA(erreur, { source = null, db = null, prevenir = prevenirParDefaut, maintenant = Date.now() } = {}) {
  if (!refusDeCle(erreur)) return null;
  const statut = Number(erreur.status) || null;
  const type = typeErreur(erreur);
  try {
    const base = typeof db === 'function' ? db() : db || require('./base').db();
    const ref = base.doc(DOCUMENT);
    const refus = { dernierRefusLe: Timestamp.fromMillis(maintenant), statut, type, source };
    const avant = await base.runTransaction(async (t) => {
      const snap = await t.get(ref);
      const d = snap.exists ? snap.data() : {};
      const derniere = ms(d.alerteLe);
      if (derniere && maintenant - derniere < DELAI) {
        t.set(ref, refus, { merge: true });
        return { deja: true };
      }
      t.set(ref, { ...refus, alerteLe: Timestamp.fromMillis(maintenant) }, { merge: true });
      return { deja: false, alerteLe: d.alerteLe || null };
    });
    if (avant.deja) return 'deja';
    logger.error(`Clé IA (Anthropic) refusée (${statut || type}${source ? `, ${source}` : ''}) : alerte envoyée à Papote`);
    try {
      await prevenir(TITRE, `${TEXTE} (Refus constaté${source ? ` sur ${source}` : ''} : erreur ${statut || type}.)`);
    } catch (e) {
      // E-mail non parti : l'alerte pourra repartir au prochain refus, sans attendre 24 h.
      await base.doc(DOCUMENT).set({ alerteLe: avant.alerteLe }, { merge: true }).catch(() => null);
      throw e;
    }
    return 'alerte';
  } catch (e) {
    logger.error('Alerte « clé IA refusée » non envoyée', e && e.message);
    return null;
  }
}

module.exports = { signalerCleIA, refusDeCle, DOCUMENT, DELAI, TEXTE, TITRE };
