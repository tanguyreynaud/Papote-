// Purge mensuelle des données qui ont dépassé la durée promise dans les mentions légales (Tanguy, 2026-11-03) :
//
//   purgeMensuelle  le 1er de chaque mois à 4 h (Paris, lancée par taches.js) :
//     - aide par écrit (chat) : supportDemandes/ et supportSansReponse/ de plus de 12 mois, et les fiches de
//       contacts/ créées seulement par le chat (sans accord pour les nouvelles, ni liste d'attente, ni commande)
//       sans question depuis 12 mois ;
//     - paniers/ (commandes non terminées) de plus de 12 mois ;
//     - familles résiliées depuis plus de 3 mois (Tanguy, 3/11, fil Inspecter) : photos, vidéos, messages, membres…
//       (gestion.effacerFamille), jamais une famille dont une commande vit encore chez Stripe. Une famille jamais
//       abonnée n'est pas touchée.
//
// Les décisions sont des fonctions pures (testées dans purge.test.js) ; la tâche ne fait que lire, décider, effacer
// par lots de 400. Une erreur sur un lot est journalisée et n'empêche pas le reste : le mois suivant finit le travail.

const { logger } = require('firebase-functions/v2');
const { db: base } = require('./base');
const { STRIPE_VIVANTS } = require('./abonnement');

const JOUR = 86400e3;
const DUREE_MS = 365 * JOUR;
const DUREE_FAMILLE_MS = 90 * JOUR;
const LOT = 400;

function enMillis(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === 'function') return v.toMillis();
  return null;
}

// Plus vieux que 12 mois ; une date absente ou illisible ne purge jamais.
function perime(date, maintenant) {
  const ms = enMillis(date);
  return ms != null && ms <= maintenant - DUREE_MS;
}

// Fiche contacts/ créée seulement par le chat : prénom, nom, téléphone, e-mail et dates du chat, rien d'autre
// (ni accord pour les nouvelles, ni liste d'attente, ni jeton de désinscription, ni commande, ni désinscription).
function contactChatAPurger(c, maintenant) {
  if (!c || c.chatLe == null) return false;
  if (c.consentement != null || c.listeAttente || c.source || c.jeton || c.desinscritLe || c.commande) return false;
  return perime(c.chatLe, maintenant);
}

// Famille résiliée depuis plus de 3 mois (dernier changement d'abonnement et date de fin), dont aucune
// commande ne vit encore chez Stripe.
function familleAPurger(fam, commandes, maintenant) {
  const abo = fam && fam.abonnement;
  if (!abo || abo.statut !== 'resilie') return false;
  const dates = [enMillis(abo.majLe), enMillis(abo.resiliationLe), enMillis(abo.finPeriode)].filter((d) => d != null);
  if (!dates.length) return false;
  if ((commandes || []).some((c) => STRIPE_VIVANTS.includes(c.statutStripe))) return false;
  return Math.max(...dates) <= maintenant - DUREE_FAMILLE_MS;
}

async function effacerParLots(db, refs) {
  for (let i = 0; i < refs.length; i += LOT) {
    const lot = db.batch();
    refs.slice(i, i + LOT).forEach((r) => lot.delete(r));
    await lot.commit();
  }
  return refs.length;
}

// Documents d'une collection dont creeLe a plus de 12 mois.
async function purgerCollection(db, nom, maintenant) {
  const limite = new Date(maintenant - DUREE_MS);
  const snap = await db.collection(nom).where('creeLe', '<=', limite).select().get();
  return effacerParLots(db, snap.docs.map((d) => d.ref));
}

async function purgerContactsChat(db, maintenant) {
  // chatLe est un nombre (Date.now() dans support.js) : la requête tombe sur les fiches passées par le chat.
  const snap = await db.collection('contacts').where('chatLe', '<=', maintenant - DUREE_MS).get();
  return effacerParLots(db, snap.docs.filter((d) => contactChatAPurger(d.data(), maintenant)).map((d) => d.ref));
}

async function purgerFamilles(db, maintenant) {
  const { effacerFamille } = require('./gestion');
  const resiliees = await db.collection('families').where('abonnement.statut', '==', 'resilie').get();
  let n = 0;
  for (const snap of resiliees.docs) {
    const commandes = await db.collection('commandes').where('fid', '==', snap.id).get();
    if (!familleAPurger(snap.data(), commandes.docs.map((c) => c.data()), maintenant)) continue;
    try {
      await effacerFamille({ fid: snap.id, snap, commandes: commandes.docs, par: 'purge automatique (3 mois après la résiliation)' });
      n++;
    } catch (e) {
      logger.error(`Purge : famille ${snap.id} non effacée`, e);
    }
  }
  return n;
}

async function purger(db, maintenant = Date.now()) {
  const bilan = {};
  const etapes = {
    supportDemandes: () => purgerCollection(db, 'supportDemandes', maintenant),
    supportSansReponse: () => purgerCollection(db, 'supportSansReponse', maintenant),
    paniers: () => purgerCollection(db, 'paniers', maintenant),
    contacts: () => purgerContactsChat(db, maintenant),
    familles: () => purgerFamilles(db, maintenant),
  };
  for (const [nom, etape] of Object.entries(etapes)) {
    try {
      bilan[nom] = await etape();
    } catch (e) {
      bilan[nom] = 'erreur';
      logger.error(`Purge : ${nom}`, e);
    }
  }
  logger.info('Purge mensuelle', bilan);
  return bilan;
}

// Lancée par taches.js (tachesHoraires) le 1er du mois à 4 h.
exports.purgeMensuelle = () => purger(base());

exports._test = { perime, contactChatAPurger, familleAPurger, purger, DUREE_MS, DUREE_FAMILLE_MS };
