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
//
// Crédit Anthropic épuisé (19/11) : même alerte, même rythme (au plus une par 24 h), document interne/creditIa,
// texte « crédit Anthropic épuisé ». Anthropic répond 400 invalid_request_error « Your credit balance is too low… »
// (ou 402 billing_error) : sans cette alerte, la lecture des factures disait seulement « ne répond pas ».
//
// causeErreurIA(erreur) : cause courte et lisible d'un échec d'appel (« erreur 400 invalid_request_error : … »,
// « délai dépassé »), pour la montrer à l'admin. Jamais la clé ni le contenu envoyé : le code HTTP, le type
// d'erreur et le début (150 caractères) du message d'Anthropic, toute chaîne ressemblant à une clé masquée.

const { defineSecret, defineString } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { Timestamp } = require('firebase-admin/firestore');

const MAIL_SMTP = defineString('MAIL_SMTP', { default: 'smtp.gmail.com:465:' });
const MAIL_EXPEDITEUR = defineString('MAIL_EXPEDITEUR', { default: '' });
const MAIL_MOT_DE_PASSE = defineSecret('MAIL_MOT_DE_PASSE');

const EMAIL_PAPOTE = 'contact@mapapote.fr';
const DOCUMENT = 'interne/cleIa';
const DOCUMENT_CREDIT = 'interne/creditIa';
const DELAI = 24 * 3600_000;
const TYPES_REFUS = ['authentication_error', 'permission_error'];

const TITRE = 'La clé IA (Anthropic) est refusée';
const TEXTE = 'La clé IA (Anthropic) est refusée : chat du site, IA de l\'admin et lecture des factures sont en panne. '
  + 'Créer une nouvelle clé et lancer outils\\support\\installer-support.bat, puis republier les fonctions.';

const TITRE_CREDIT = 'Crédit Anthropic épuisé';
const TEXTE_CREDIT = 'Crédit Anthropic épuisé : Anthropic refuse les appels faute de crédit ; le chat du site, l\'IA de l\'admin '
  + 'et la lecture des factures sont en panne. Recharger le crédit (ou vérifier le crédit promotionnel) dans la console '
  + 'Anthropic, rubrique Billing ; rien à republier.';

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

// Message d'Anthropic (corps { error: { message } }), sinon null.
function messageErreur(e) {
  const corps = e && e.error;
  const m = corps && ((corps.error && corps.error.message) || (corps.type !== 'error' && corps.message));
  return typeof m === 'string' ? m : null;
}

// Vrai quand Anthropic refuse faute de crédit : 402 billing_error, ou 400 « credit balance is too low ».
function creditEpuise(e) {
  if (!e || typeof e !== 'object') return false;
  if (Number(e.status) === 402 || typeErreur(e) === 'billing_error') return true;
  return Number(e.status) === 400 && /credit balance/i.test(messageErreur(e) || '');
}

// Erreur qui se reproduira à l'identique avec le même document : 400 (paramètre ou document refusé) ou 413
// (trop gros), mais pas le crédit épuisé (il suffit de recharger).
function erreurDefinitive(e) {
  if (!e || typeof e !== 'object' || creditEpuise(e)) return false;
  const statut = Number(e.status);
  return statut === 400 || statut === 413;
}

// Début d'un message d'erreur : une ligne, 150 caractères, toute chaîne ressemblant à une clé masquée.
function court(texte) {
  const t = String(texte).replace(/sk-ant-[A-Za-z0-9_-]*/g, '[clé masquée]').replace(/\s+/g, ' ').trim();
  return t.length > 150 ? `${t.slice(0, 150)}…` : t;
}

const nomErreur = (e) => (e && e.constructor && e.constructor.name) || '';

// Cause courte d'un échec d'appel à Anthropic, sans parenthèses (l'appelant les ajoute).
function causeErreurIA(e) {
  if (!e) return 'erreur inconnue';
  const statut = Number(e.status) || null;
  if (!statut) {
    const texte = String(e.message || e.code || '');
    if (nomErreur(e) === 'APIConnectionTimeoutError' || /timed? ?out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(texte)) return 'délai dépassé';
    if (nomErreur(e) === 'APIConnectionError' || /ECONN|ENOTFOUND|EAI_AGAIN|socket|connection/i.test(texte)) return 'connexion impossible';
    // Erreur levée par le SDK lui-même avant l'envoi (paramètre refusé…) : son message ne contient pas le document.
    if (nomErreur(e) === 'AnthropicError' && e.message) return `erreur du SDK Anthropic : ${court(e.message)}`;
    return 'erreur inattendue';
  }
  const type = typeErreur(e);
  const message = court(messageErreur(e) || '');
  return `erreur ${statut}${type ? ` ${type}` : ''}${message ? ` : ${message}` : ''}`;
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
// ou null (ni refus de clé ni crédit épuisé, ou alerte impossible).
async function signalerCleIA(erreur, { source = null, db = null, prevenir = prevenirParDefaut, maintenant = Date.now() } = {}) {
  const motif = refusDeCle(erreur) ? { document: DOCUMENT, titre: TITRE, texte: TEXTE, nom: 'Clé IA (Anthropic) refusée', constat: 'Refus constaté' }
    : creditEpuise(erreur) ? { document: DOCUMENT_CREDIT, titre: TITRE_CREDIT, texte: TEXTE_CREDIT, nom: 'Crédit Anthropic épuisé', constat: 'Constaté' }
      : null;
  if (!motif) return null;
  const statut = Number(erreur.status) || null;
  const type = typeErreur(erreur);
  try {
    const base = typeof db === 'function' ? db() : db || require('./base').db();
    const ref = base.doc(motif.document);
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
    logger.error(`${motif.nom} (${statut || type}${source ? `, ${source}` : ''}) : alerte envoyée à Papote`);
    try {
      await prevenir(motif.titre, `${motif.texte} (${motif.constat}${source ? ` sur ${source}` : ''} : erreur ${statut || type}.)`);
    } catch (e) {
      // E-mail non parti : l'alerte pourra repartir au prochain refus, sans attendre 24 h.
      await base.doc(motif.document).set({ alerteLe: avant.alerteLe }, { merge: true }).catch(() => null);
      throw e;
    }
    return 'alerte';
  } catch (e) {
    logger.error(`Alerte « ${motif.nom} » non envoyée`, e && e.message);
    return null;
  }
}

module.exports = {
  signalerCleIA, refusDeCle, creditEpuise, erreurDefinitive, causeErreurIA,
  DOCUMENT, DOCUMENT_CREDIT, DELAI, TEXTE, TITRE, TEXTE_CREDIT, TITRE_CREDIT,
};
