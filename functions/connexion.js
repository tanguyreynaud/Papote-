// Lien de connexion de l'appli famille envoyé par Papote (Tanguy 20/11 : l'e-mail anglais de Firebase, « Hello, We
// received a request to sign in to Papote… », était « moche et pas travaillé »). L'appli appelle lienConnexion au lieu
// de sendSignInLinkToEmail : le serveur fabrique le lien (admin.auth().generateSignInWithEmailLink, mêmes réglages que
// l'appli avant) et l'envoie avec nos e-mails (mail.lienConnexion, envoyé comme tout e-mail urgent par mail.envoyer).
//
//   lienConnexion  onCall { email, retour } -> { ok: true }
//                  retour : l'adresse de l'appli où revenir (« https://app.mapapote.fr/?lien=1 »)
//
// N'importe qui peut l'appeler, sans compte et pour n'importe quelle adresse : garde-fous contre les abus (vider le
// quota Brevo, inonder une boîte de réception) :
//   - 3 envois par heure pour une même adresse e-mail ;
//   - 10 envois par heure depuis une même adresse internet ;
//   - 60 envois par heure pour tout Papote (le quota Brevo, 300 par jour, sert aussi aux e-mails de commande et SOS).
//   - 100 envois par jour (jour de Paris) pour tout Papote : sans ce plafond, quelqu'un qui tourne sous les limites
//     par heure viderait les e-mails du jour, ceux des alertes et du SOS compris (audit du 26/11, Tanguy 27/11).
//     Au-delà du plafond du jour, ou dès que la réserve des e-mails urgents est entamée (quota-courriels.js),
//     rien ne part de Papote : la réponse porte « repli: true » et l'appli demande alors le lien à Firebase
//     (e-mail de Google, en français, moins soigné mais qui ne coûte rien à notre quota). Personne n'est bloqué.
// Au-delà des limites par heure : « resource-exhausted », rien ne part. Compteurs dans limites/connexion-… (adresse e-mail et adresse
// internet hachées, comme limites/attente-ip-…), avec les heures des envois de la dernière heure et expireLe.
// La réponse est la même qu'un compte existe ou non : rien n'apprend qui est inscrit.
// L'adresse de retour doit être sur l'appli (app.mapapote.fr, papote-famille.web.app ; localhost avec les
// émulateurs seulement) : personne ne fait partir de Papote un e-mail qui mène ailleurs.

const crypto = require('node:crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { Timestamp } = require('firebase-admin/firestore');

const LIMITES_CONNEXION = { parAdresse: 3, parIp: 10, total: 60, parJour: 100 };
const HEURE_MS = 60 * 60 * 1000;
const DOMAINES = ['app.mapapote.fr', 'papote-famille.web.app'];

const MESSAGE_LIMITE = 'Trop de demandes de lien en peu de temps. Attendez une heure, puis réessayez. Pensez à regarder dans les courriers indésirables : le lien y est peut-être déjà.';

// Même règle que les autres fonctions (index.js, emailValide) : adresse en minuscules, sinon null.
function adresseValide(e) {
  if (typeof e !== 'string') return null;
  const t = e.trim().toLowerCase();
  return t.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/.test(t) ? t : null;
}

// Émulateurs (banc d'essai de l'appli, parcours) : jamais en ligne.
const enEmulateur = () => process.env.FUNCTIONS_EMULATOR === 'true' || Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);

// L'adresse de retour, si elle mène bien à l'appli (https sur nos domaines ; http://localhost avec les émulateurs).
function retourPermis(retour, emulateur = enEmulateur()) {
  if (typeof retour !== 'string' || retour.length > 300) return null;
  let u;
  try { u = new URL(retour); } catch (e) { return null; }
  if (u.username || u.password) return null;
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (local) return emulateur && ['http:', 'https:'].includes(u.protocol) ? u.href : null;
  return u.protocol === 'https:' && !u.port && DOMAINES.includes(u.hostname) ? u.href : null;
}

// Mêmes réglages que l'appli avant (web/js/compte.js) : retour dans l'appli, qui finit la connexion elle-même.
const reglagesLien = (retour) => ({ url: retour, handleCodeInApp: true });

const hacher = (texte) => crypto.createHash('sha256').update(String(texte)).digest('hex').slice(0, 32);

// Les heures d'envoi de la dernière heure (pur) : null si la limite est atteinte, sinon la liste avec l'envoi de plus.
function compterEnvoi(essais, limite, maintenant = Date.now()) {
  const recents = (Array.isArray(essais) ? essais : []).filter((t) => typeof t === 'number' && t > maintenant - HEURE_MS);
  return recents.length >= limite ? null : [...recents, maintenant];
}

// Les trois compteurs d'un coup (une transaction : 3 lectures, 3 écritures). true si l'envoi est permis.
async function envoiPermis(db, { email, ip }, maintenant = Date.now()) {
  const refs = [
    [db.doc(`limites/connexion-mail-${hacher(`connexion:${email}`)}`), LIMITES_CONNEXION.parAdresse],
    [db.doc(`limites/connexion-ip-${hacher(`connexion:${ip || '?'}`)}`), LIMITES_CONNEXION.parIp],
    [db.doc('limites/connexion-total'), LIMITES_CONNEXION.total],
  ];
  return db.runTransaction(async (tx) => {
    const snaps = await tx.getAll(...refs.map(([r]) => r));
    const suites = snaps.map((s, i) => compterEnvoi(s.exists ? s.get('essais') : null, refs[i][1], maintenant));
    if (suites.some((x) => x === null)) return false;
    refs.forEach(([r], i) => tx.set(r, { essais: suites[i], expireLe: Timestamp.fromMillis(maintenant + HEURE_MS) }));
    return true;
  });
}

// Plafond du jour (une transaction, un document par jour de Paris) : true si cet envoi peut encore partir de Papote.
const jourParis = (ms) => new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
async function sousPlafondDuJour(db, maintenant = Date.now()) {
  const ref = db.doc(`limites/connexion-jour-${jourParis(maintenant)}`);
  return db.runTransaction(async (tx) => {
    const snap = (await tx.getAll(ref))[0];
    const n = (snap.exists && snap.get('n')) || 0;
    if (n >= LIMITES_CONNEXION.parJour) return false;
    tx.set(ref, { n: n + 1, expireLe: Timestamp.fromMillis(maintenant + 48 * HEURE_MS) });
    return true;
  });
}

// Adresse internet de l'appelant : le DERNIER élément de X-Forwarded-For, ajouté par Google (stock.js, adresseVisiteur).
function adresseAppelant(rawRequest) {
  const h = (rawRequest && rawRequest.headers) || {};
  const chaine = String(h['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return chaine.length ? chaine[chaine.length - 1] : String((rawRequest && rawRequest.ip) || '');
}

// La fonction, avec ce dont elle a besoin (index.js : la base, admin.auth(), envoyerMail, logger ; les essais : des faux).
// reserveEntamee (facultatif) : () => true quand les e-mails « de confort » ne partent plus (quota-courriels.js).
function creer({ db, auth, envoyerMail, mail, logger, reserveEntamee = async () => false }) {
  return async (request) => {
    const d = request.data || {};
    const email = adresseValide(d.email);
    if (!email) throw new HttpsError('invalid-argument', 'Adresse e-mail invalide.');
    const retour = retourPermis(d.retour);
    if (!retour) throw new HttpsError('invalid-argument', 'Adresse de retour refusée.');
    if (!(await envoiPermis(db, { email, ip: adresseAppelant(request.rawRequest) }))) {
      logger.warn('Lien de connexion : limite atteinte');
      throw new HttpsError('resource-exhausted', MESSAGE_LIMITE);
    }
    // Plafond du jour atteint, ou réserve des urgents entamée : l'appli demandera le lien à Firebase (repli).
    let repli = false;
    try {
      repli = !(await sousPlafondDuJour(db)) || await reserveEntamee();
    } catch (e) {
      logger.warn('Lien de connexion : plafond du jour illisible, envoi par Papote', e.message);
    }
    if (repli) {
      logger.warn('Lien de connexion : plafond du jour atteint, repli sur l\'e-mail de Firebase');
      return { ok: true, repli: true };
    }
    let lien;
    try {
      lien = await auth.generateSignInWithEmailLink(email, reglagesLien(retour));
    } catch (e) {
      logger.error('Lien de connexion : fabrication impossible', e);
      throw new HttpsError('unavailable', 'Le lien n\'a pas pu être préparé. Réessayez dans un instant.');
    }
    try {
      await envoyerMail(email, mail.lienConnexion({ email, lien }));
    } catch (e) {
      logger.error('Lien de connexion : e-mail non parti', e);
      throw new HttpsError('unavailable', 'L\'e-mail n\'a pas pu partir. Réessayez dans un instant.');
    }
    return { ok: true };
  };
}

module.exports = {
  creer, sousPlafondDuJour, adresseValide, retourPermis, reglagesLien, compterEnvoi, envoiPermis, adresseAppelant, LIMITES_CONNEXION, MESSAGE_LIMITE, DOMAINES,
};
