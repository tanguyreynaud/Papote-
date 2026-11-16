// Ménage quotidien des données qui grossissent sans fin (Tanguy, 12/11 : A14, A25 et A26 des audits).
//
//   menageQuotidien  chaque jour à 10 h, avec rappelsJumelage (même créneau de tachesHoraires, taches.js : aucune
//                    nouvelle tâche Cloud Scheduler) :
//     - vieux journaux de plus de 90 jours (A14, audit 8/11 N8), par petits lots :
//         families/{fid}/calls (appels finis, avec leurs candidats réseau et leur jeton de refus) ; un appel qui
//         sonne ou qui est en cours (« ringing », « accepted ») n'est jamais effacé ;
//         families/{fid}/commands (ordres exécutés ou refusés : « done », « failed ») ; un ordre qui attend sa
//         tablette (« pending », par exemple la révocation d'une tablette volée) n'est jamais effacé ;
//         alertes/ (journal des alertes, lu sur 90 jours par gestionDonnees) et incidentsAppels/ ;
//     - comptes de connexion (Firebase Auth) qui ne sont membres d'aucune famille et dont la dernière connexion a
//       plus de 3 mois (A25, rapport données personnelles 12/11 P4) : compte anonyme ou réel, jamais un compte de
//       tablette, jamais l'administrateur, jamais un compte responsable d'une famille ou dont l'e-mail a une
//       commande encore en cours.
//
//   effacerTracesAppel  à la fin de chaque appel (déclencheur appelsManques, appels.js) : description technique de
//     l'appel (offer.sdp, answer.sdp) et candidats réseau (callerCandidates, calleeCandidates), qui contiennent les
//     adresses IP du téléphone et de la tablette (A26, même rapport, P3). Le reste de l'appel (qui, quand, décroché
//     par qui, réseau sim ou wifi) est gardé jusqu'aux 90 jours.
//
// Coût : chaque requête est limitée (LOT documents) et ne lit que les documents à effacer (index composites
// state + createdAt pour calls et commands : firestore.indexes.json). Un plafond de lots par jour et une durée
// maximale laissent le reste au lendemain : rien n'est jamais lu en entier. Une erreur sur une étape est
// journalisée et n'empêche pas les autres.

const { logger } = require('firebase-functions/v2');
const { FieldValue } = require('firebase-admin/firestore');
const { db: base } = require('./base');
const { STRIPE_VIVANTS } = require('./abonnement');

const JOUR = 86400e3;
const DUREE_JOURNAUX_MS = 90 * JOUR;
const DUREE_COMPTE_MS = 90 * JOUR;
const LOT = 300;
// Au plus LOTS_MAX lots par collection et par jour (9000 documents), et DUREE_MAX_MS en tout : à 1000 familles
// (≈ 3000 appels par jour), le stock de chaque jour part le jour même.
const LOTS_MAX = 30;
const DUREE_MAX_MS = 8 * 60e3;
// Comptes : au plus COMPTES_MAX vérifiés par jour (2 à 3 lectures chacun).
const COMPTES_MAX = 500;

const APPELS_FINIS = ['ended', 'missed', 'declined'];
const ORDRES_FINIS = ['done', 'failed'];
const DOMAINE_TABLETTES = '@tablettes.papote-famille.web.app';

const ms = (v) => {
  if (!v) return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

// ---------- A26 : adresses IP d'un appel fini ----------

// Appel qui vient de finir (sonnait ou était en cours, ne l'est plus).
function vientDeFinir(avant, apres) {
  return !!(avant && apres && !APPELS_FINIS.includes(avant.state) && APPELS_FINIS.includes(apres.state));
}

// offer.sdp et answer.sdp effacés (le reste de offer et answer, lu par les applis, est gardé), candidats effacés.
async function effacerTracesAppel(refEvenement, appel) {
  const db = base();
  const ref = db.doc(refEvenement.path);
  const [a, b] = await Promise.all(['callerCandidates', 'calleeCandidates'].map((c) => ref.collection(c).select().get()));
  const refs = [...a.docs, ...b.docs].map((d) => d.ref);
  for (let i = 0; i < refs.length; i += 400) {
    const lot = db.batch();
    refs.slice(i, i + 400).forEach((r) => lot.delete(r));
    await lot.commit();
  }
  const maj = {};
  if (appel && appel.offer && appel.offer.sdp != null) maj['offer.sdp'] = FieldValue.delete();
  if (appel && appel.answer && appel.answer.sdp != null) maj['answer.sdp'] = FieldValue.delete();
  if (Object.keys(maj).length) await ref.update(maj);
  return refs.length;
}

// ---------- A14 : journaux de plus de 90 jours ----------

// Efface, lot après lot, les documents rendus par requete() (déjà limitée à LOT). recursif : avec leurs
// sous-collections (un appel : candidats et jeton de refus), en une seule requête par document.
async function effacerParLots(db, requete, { recursif = false, fin }) {
  let n = 0;
  for (let i = 0; i < LOTS_MAX && Date.now() < fin; i++) {
    const snap = await requete().get();
    if (snap.empty) break;
    if (recursif) {
      const writer = db.bulkWriter();
      writer.onWriteError((e) => e.failedAttempts < 5);
      await Promise.all(snap.docs.map((d) => db.recursiveDelete(d.ref, writer)));
      await writer.close();
    } else {
      const lot = db.batch();
      snap.docs.forEach((d) => lot.delete(d.ref));
      await lot.commit();
    }
    n += snap.size;
    if (snap.size < LOT) break;
  }
  return n;
}

function etapesJournaux(db, maintenant, fin) {
  const limite = new Date(maintenant - DUREE_JOURNAUX_MS);
  return {
    appels: () => effacerParLots(db, () => db.collectionGroup('calls')
      .where('state', 'in', APPELS_FINIS).where('createdAt', '<=', limite).limit(LOT).select(), { recursif: true, fin }),
    ordres: () => effacerParLots(db, () => db.collectionGroup('commands')
      .where('state', 'in', ORDRES_FINIS).where('createdAt', '<=', limite).limit(LOT).select(), { fin }),
    alertes: () => effacerParLots(db, () => db.collection('alertes').where('le', '<=', limite).limit(LOT).select(), { fin }),
    incidentsAppels: () => effacerParLots(db, () => db.collection('incidentsAppels').where('le', '<=', limite).limit(LOT).select(), { fin }),
  };
}

// ---------- A25 : comptes sans famille depuis plus de 3 mois ----------

// Compte à vérifier dans la base (décision sans lecture, testée dans menage.test.js) : ni tablette, ni
// administrateur, ni désactivé (tablette révoquée…), aucune connexion depuis plus de 3 mois.
function compteCandidat(u, maintenant) {
  if (!u || !u.uid) return false;
  if (u.customClaims && u.customClaims.admin === true) return false;
  if (u.disabled) return false;
  const email = String(u.email || '').toLowerCase();
  if (email.endsWith(DOMAINE_TABLETTES)) return false;
  const m = u.metadata || {};
  const dates = [m.creationTime, m.lastSignInTime, m.lastRefreshTime].map(ms).filter((t) => t != null);
  if (!dates.length) return false;
  return Math.max(...dates) <= maintenant - DUREE_COMPTE_MS;
}

// Commande encore en cours : abonnement vivant chez Stripe, paiement ou envoi pas fini, tablette à rendre, ou
// famille pas encore reliée. Seule une commande annulée, ou finie chez Stripe sans rien à rendre, est terminée.
function commandeEnCours(c) {
  if (!c) return false;
  if (c.expedition === 'annulee') return false;
  if (STRIPE_VIVANTS.includes(c.statutStripe)) return true;
  if (['paiement-en-attente', 'a-preparer'].includes(c.expedition)) return true;
  if (c.restitution && ['attendue', 'echec', 'au-retour'].includes(c.restitution.statut)) return true;
  // Jamais confirmée chez Stripe (ou offerte) : on ne sait pas, on garde. Finie chez Stripe : terminée.
  return !c.statutStripe;
}

// Le compte doit-il rester ? Membre d'une famille (même en attente), responsable d'une famille, ou e-mail d'une
// commande encore en cours. 2 lectures (3 avec un e-mail), une par requête vide.
async function compteAGarder(db, u) {
  const [membre, responsable] = await Promise.all([
    db.collectionGroup('members').where('uid', '==', u.uid).limit(1).select().get(),
    db.collection('families').where('admins', 'array-contains', u.uid).limit(1).select().get(),
  ]);
  if (!membre.empty || !responsable.empty) return true;
  const email = String(u.email || '').toLowerCase();
  if (!email) return false;
  const commandes = await db.collection('commandes').where('email', '==', email).get();
  return commandes.docs.some((d) => commandeEnCours(d.data()));
}

async function effacerComptesSansFamille(db, auth, maintenant, fin) {
  const aEffacer = [];
  let verifies = 0;
  let page;
  do {
    const r = await auth.listUsers(1000, page);
    page = r.pageToken;
    for (const u of r.users) {
      if (verifies >= COMPTES_MAX || Date.now() >= fin) break;
      if (!compteCandidat(u, maintenant)) continue;
      verifies++;
      if (!(await compteAGarder(db, u))) aEffacer.push(u.uid);
    }
  } while (page && verifies < COMPTES_MAX && Date.now() < fin);
  let n = 0;
  for (let i = 0; i < aEffacer.length; i += 1000) {
    const r = await auth.deleteUsers(aEffacer.slice(i, i + 1000));
    n += r.successCount;
    r.errors.forEach((e) => logger.warn(`Ménage : compte ${aEffacer[i + e.index]} non effacé`, e.error && e.error.message));
  }
  if (n) logger.info(`Ménage : ${n} compte(s) de connexion sans famille depuis plus de 3 mois effacé(s)`);
  return n;
}

// ---------- Tâche ----------

async function menage(db, auth, maintenant = Date.now()) {
  const fin = Date.now() + DUREE_MAX_MS;
  const etapes = {
    ...etapesJournaux(db, maintenant, fin),
    comptes: () => effacerComptesSansFamille(db, auth, maintenant, fin),
  };
  const bilan = {};
  for (const [nom, etape] of Object.entries(etapes)) {
    try {
      bilan[nom] = await etape();
    } catch (e) {
      bilan[nom] = 'erreur';
      logger.error(`Ménage : ${nom}`, e);
    }
  }
  logger.info('Ménage quotidien', bilan);
  return bilan;
}

exports.menageQuotidien = () => menage(base(), require('firebase-admin').auth());
exports.effacerTracesAppel = effacerTracesAppel;
exports.vientDeFinir = vientDeFinir;
exports._test = {
  compteCandidat, commandeEnCours, menage, vientDeFinir,
  DUREE_JOURNAUX_MS, DUREE_COMPTE_MS, LOT, APPELS_FINIS, ORDRES_FINIS, DOMAINE_TABLETTES,
};
