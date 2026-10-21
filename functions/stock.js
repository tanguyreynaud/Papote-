// Tablettes disponibles à la vente : les commandes suivent le stock réel, plus PRECOMMANDES commandes d'avance
// (Tanguy, 2026-10-21 : « jusqu'à nombre de commandes = stock + 10 », donc 10 commandes même avec 0 en stock).
// Au-delà du stock, la commande est une précommande : le site annonce un délai de préparation plus long.
//
// Disponibles = fiches du stock libres (en stock ou préparées, sans commande)
//             - commandes payées pas encore reliées à une fiche
//             - paiements en cours (reservations/{id}, une tablette mise de côté pendant le paiement Stripe).
// Une réservation naît à l'ouverture du paiement, disparaît au paiement réussi (la commande prend le relais)
// ou à l'expiration de la page Stripe ; elle s'éteint d'elle-même à expireLe si Stripe ne prévient pas.

const { HttpsError } = require('firebase-functions/v2/https');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');

const ETATS_LIBRES = ['en-stock', 'preparee'];
const PRECOMMANDES = 10;
// Commandes qui attendent une tablette : à préparer, ou payées par SEPA en attente de la banque.
const A_SERVIR = ['a-preparer', 'paiement-en-attente'];
// Page de paiement Stripe : 30 minutes (le minimum accepté par Stripe), la réservation 2 minutes de plus.
const DUREE_PAIEMENT_MS = 30 * 60 * 1000;
const MARGE_MS = 2 * 60 * 1000;

const ms = (v) => (v == null ? null : typeof v === 'number' ? v : v.toMillis ? v.toMillis() : null);

// { stock: [{ etat, commande }], commandes: [{ id, expedition }], reservations: [{ expireLe }] } → tablettes du stock
// encore libres, négatif quand des commandes attendent une tablette pas encore achetée.
function solde({ stock, commandes, reservations, maintenant }) {
  const libres = stock.filter((t) => ETATS_LIBRES.includes(t.etat) && !t.commande).length;
  const reliees = new Set(stock.map((t) => t.commande).filter(Boolean));
  const enAttente = commandes.filter((c) => A_SERVIR.includes(c.expedition) && !reliees.has(c.id)).length;
  const enPaiement = reservations.filter((r) => (ms(r.expireLe) || 0) > maintenant).length;
  return libres - enAttente - enPaiement;
}
// Tablettes en stock pour une nouvelle commande (≥ 0).
const tablettesDisponibles = (d) => Math.max(0, solde(d));
// Commandes encore possibles, précommandes comprises (≥ 0).
const placesDisponibles = (n) => Math.max(0, n + PRECOMMANDES);

// Lectures communes au calcul simple et à la transaction (lire = db ou tx).
async function lireEtCompter(db, lire, maintenant) {
  const [stock, commandes, reservations] = await Promise.all([
    lire(db.collection('stock').where('etat', 'in', ETATS_LIBRES)),
    lire(db.collection('commandes').where('expedition', 'in', A_SERVIR)),
    lire(db.collection('reservations').where('expireLe', '>', Timestamp.fromMillis(maintenant))),
  ]);
  // Les fiches reliées à une commande à préparer sont dans les états libres : elles suffisent pour « reliees ».
  return solde({
    stock: stock.docs.map((d) => d.data()),
    commandes: commandes.docs.map((d) => ({ id: d.id, ...d.data() })),
    reservations: reservations.docs.map((d) => d.data()),
    maintenant,
  });
}

// Commandes encore possibles (précommandes comprises).
async function nombreDisponibles(db) {
  return placesDisponibles(await lireEtCompter(db, (q) => q.get(), Date.now()));
}

// Met une tablette de côté pour un paiement. Renvoie { id, expireA (secondes Stripe) } ou null si plus rien.
// Le document gestion/stock est lu et écrit à chaque réservation : deux paiements simultanés passent
// l'un après l'autre et ne peuvent pas prendre la même dernière tablette.
async function reserver(db) {
  const maintenant = Date.now();
  const verrou = db.doc('gestion/stock');
  const ref = db.collection('reservations').doc();
  const ok = await db.runTransaction(async (tx) => {
    await tx.get(verrou);
    const dispo = placesDisponibles(await lireEtCompter(db, (q) => tx.get(q), maintenant));
    if (dispo < 1) return false;
    tx.set(ref, { creeLe: FieldValue.serverTimestamp(), expireLe: Timestamp.fromMillis(maintenant + DUREE_PAIEMENT_MS + MARGE_MS) });
    tx.set(verrou, { derniereReservation: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
  return ok ? { id: ref.id, expireA: Math.floor((maintenant + DUREE_PAIEMENT_MS) / 1000) } : null;
}

// Paiement réussi, page expirée ou ouverture du paiement ratée : la tablette n'est plus mise de côté.
async function liberer(db, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9]{10,40}$/.test(id)) return;
  await db.doc(`reservations/${id}`).delete();
}

// Lecture publique pour le site : { disponible, precommande } (vrai/faux), rien d'autre (pas de nombre).
// precommande : plus de tablette en stock, la commande attendra l'achat d'une tablette (délai plus long).
function routeDisponible(db, logger) {
  return async (req, res) => {
    try {
      const n = await lireEtCompter(db, (q) => q.get(), Date.now());
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ disponible: placesDisponibles(n) > 0, precommande: n < 1 });
    } catch (e) {
      logger.error('stockDisponible', e);
      res.status(500).json({ erreur: 'indisponible' });
    }
  };
}

const ERREUR_COMPLET = () => new HttpsError('resource-exhausted',
  "Toutes nos tablettes sont réservées pour le moment. Inscrivez-vous sur mapapote.fr pour être prévenu dès qu'il y en a.");

module.exports = { tablettesDisponibles, placesDisponibles, PRECOMMANDES, nombreDisponibles, reserver, liberer, routeDisponible, ERREUR_COMPLET, DUREE_PAIEMENT_MS };
