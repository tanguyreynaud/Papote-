// Lancement (Tanguy, 2026-10-30) : on ne vend que les tablettes en stock (VENDRE_SANS_STOCK = false).
// À stock 0, pas de réservation donc pas de paiement, et le site propose « Être prévenu » (liste d'attente).
// Remettre VENDRE_SANS_STOCK à true pour reprendre les précommandes décrites ci-dessous.
//
// Délai annoncé selon le stock réel (Tanguy, 2026-10-21), quand on vend sans stock :
//   en stock                       : 'stock' ;
//   au-delà, jusqu'à stock + 10    : 'precommande' (PRECOMMANDES) ;
//   au-delà de stock + 10          : 'long'.
// Depuis le 29/10/2026, le client voit toujours « expédiée sous 3 à 5 jours ouvrés » : ce délai ne sert plus qu'à
// prévenir Tanguy (e-mail de nouvelle commande) qu'il faut racheter des tablettes.
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
const VENDRE_SANS_STOCK = false;
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
// Une nouvelle commande peut-elle être payée, d'après le solde du stock ?
const vendable = (n, sansStock = VENDRE_SANS_STOCK) => n >= 1 || (sansStock && placesDisponibles(n) > 0);

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

// Commandes encore possibles (précommandes comprises quand on vend sans stock).
async function nombreDisponibles(db) {
  const n = await lireEtCompter(db, (q) => q.get(), Date.now());
  return VENDRE_SANS_STOCK ? placesDisponibles(n) : Math.max(0, n);
}

// Délai d'une nouvelle commande d'après le solde du stock : 'stock', 'precommande' ou 'long'.
function delai(n) {
  if (n >= 1) return 'stock';
  return placesDisponibles(n) > 0 ? 'precommande' : 'long';
}

// Met une tablette de côté pour un paiement. Renvoie { id, expireA (secondes Stripe), delai },
// ou null quand il n'y a plus rien à vendre (rien n'est écrit).
// Le document gestion/stock est lu et écrit à chaque réservation : deux paiements simultanés passent
// l'un après l'autre et ne peuvent pas prendre la même dernière tablette.
async function reserver(db) {
  const maintenant = Date.now();
  const verrou = db.doc('gestion/stock');
  const ref = db.collection('reservations').doc();
  const d = await db.runTransaction(async (tx) => {
    await tx.get(verrou);
    const n = await lireEtCompter(db, (q) => tx.get(q), maintenant);
    if (!vendable(n)) return null;
    tx.set(ref, { creeLe: FieldValue.serverTimestamp(), expireLe: Timestamp.fromMillis(maintenant + DUREE_PAIEMENT_MS + MARGE_MS) });
    tx.set(verrou, { derniereReservation: FieldValue.serverTimestamp() }, { merge: true });
    return delai(n);
  });
  if (!d) return null;
  return { id: ref.id, expireA: Math.floor((maintenant + DUREE_PAIEMENT_MS) / 1000), delai: d };
}

// Paiement réussi, page expirée ou ouverture du paiement ratée : la tablette n'est plus mise de côté.
async function liberer(db, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9]{10,40}$/.test(id)) return;
  await db.doc(`reservations/${id}`).delete();
}

// Lecture publique pour le site : { disponible, precommande, attenteLongue } (vrai/faux), pas de nombre.
// disponible : une commande peut être payée (sinon le site propose « Être prévenu ») ; precommande : plus de
// tablette en stock ; attenteLongue : au-delà de stock + 10. Le site n'affiche plus ces deux-là (29/10/2026).
function routeDisponible(db, logger) {
  return async (req, res) => {
    try {
      const n = await lireEtCompter(db, (q) => q.get(), Date.now());
      res.set('Cache-Control', 'public, max-age=60');
      const d = delai(n);
      res.json({ disponible: vendable(n), precommande: d === 'precommande', attenteLongue: d === 'long' });
    } catch (e) {
      logger.error('stockDisponible', e);
      res.status(500).json({ erreur: 'indisponible' });
    }
  };
}

const ERREUR_COMPLET = () => new HttpsError('resource-exhausted',
  "Toutes nos tablettes sont réservées pour le moment. Inscrivez-vous sur mapapote.fr pour être prévenu dès qu'il y en a.");

module.exports = { tablettesDisponibles, placesDisponibles, vendable, VENDRE_SANS_STOCK, delai, PRECOMMANDES, nombreDisponibles, reserver, liberer, routeDisponible, ERREUR_COMPLET, DUREE_PAIEMENT_MS };
