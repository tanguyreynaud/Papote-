// Limites contre les abus (A12, décidé avec Tanguy le 12/11/2026) : la voix Google des messages et des rappels
// est payée au caractère ; une appli modifiée ou un proche qui écrit sans fin ne doit pas faire grimper la facture.
//
//   - à partir du 10e message écrit du jour par le MÊME proche : plus de voix Google (la tablette lit le message
//     avec la voix d'Android). Seuls les messages écrits comptent : pas les photos et vidéos (quota mensuel,
//     quota.js), dont la légende garde sa voix ; pas les rappels ;
//   - 50 messages écrits par jour et par famille : les suivants sont refusés jusqu'à minuit (heure de Paris) ;
//   - rappels : 10 créés par jour et par famille au plus, et 30 en cours (non passés) par famille.
//
// Les règles Firestore ne savent pas compter : le serveur tient un compteur par famille, families/{fid}/compteurs/jour
//   { jour: 'AAAA-MM-JJ' (Paris), messages, parAuteur: { uid: n }, rappels, rappelsModifies,
//     bloqueJusqua?: Timestamp, rappelsBloquesJusqua?: Timestamp, majLe }
// et y écrit bloqueJusqua (messages) ou rappelsBloquesJusqua (rappels) = minuit suivant à Paris dès que la limite est
// atteinte. Les règles refusent alors la création (firestore.rules, branche de l'app) ; les membres lisent le
// compteur pour afficher un message calme dans l'appli. Écrit par le serveur seulement.
// Quelques messages lancés en même temps peuvent passer avant le drapeau : ils n'ont pas de voix ; un rappel en trop
// (11e du jour, 31e en cours) est effacé.
//
// Coût : une transaction (2 lectures : compteur et drapeau de restauration, 1 écriture) par message écrit ou rappel CRÉÉ ; rien de plus quand un envoi ou un
// rappel existant est modifié (« vu », bisou, « c'est fait »), ce qui relance pourtant la fonction de la voix.

const { FieldValue, Timestamp } = require('firebase-admin/firestore');

const LIMITES = {
  voixParProche: 9, // le 10e message du jour du même proche n'a plus de voix
  messagesParJour: 50, // le 51e est refusé
  rappelsParJour: 10, // le 11e est refusé
  rappelsEnCours: 30, // le 31e est refusé
  // Un rappel dont on change le texte refait sa voix : 20 changements par jour et par famille au plus avec la voix
  // Google, au-delà la tablette lit le rappel avec la voix d'Android (même porte que les messages, plus large).
  voixRappelsModifies: 20,
};
// Un envoi dont la date est plus vieille qu'une heure n'est pas compté : copie ou restauration faite par Papote.
// (Les règles imposent createdAt == heure du serveur aux messages écrits depuis l'appli.)
const FRAIS_MS = 60 * 60 * 1000;

function jourParis(ms = Date.now()) {
  return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

// Décalage de Paris par rapport à UTC (ms) à un instant donné.
function decalageParis(t) {
  const nom = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(t)).find((x) => x.type === 'timeZoneName').value; // « GMT+1 »
  const m = /GMT([+-]\d+)/.exec(nom);
  return m ? Number(m[1]) * 3600000 : 0;
}

// Minuit (heure de Paris) qui suit l'instant donné, en ms. Le changement d'heure se fait à 2 ou 3 h du matin : à
// 0 h UTC du jour suivant, le décalage est encore celui de minuit à Paris.
function minuitSuivantParis(ms = Date.now()) {
  const [a, m, j] = jourParis(ms).split('-').map(Number);
  const utc = Date.UTC(a, m - 1, j + 1);
  return utc - decalageParis(utc);
}

const millis = (t) => (t == null ? null : typeof t.toMillis === 'function' ? t.toMillis() : t instanceof Date ? t.getTime() : Number(t));

// Envoi récent (écrit depuis l'appli à l'instant), à compter. Sans date : compté (prudence).
function estFrais(createdAt, maintenant = Date.now()) {
  const t = millis(createdAt);
  return t == null || Number.isNaN(t) || t >= maintenant - FRAIS_MS;
}

// Compteur du jour : celui d'hier repart de zéro.
function duJour(compteur, jour) {
  const c = compteur && compteur.jour === jour ? compteur : null;
  return {
    jour,
    messages: (c && c.messages) || 0,
    parAuteur: { ...((c && c.parAuteur) || {}) },
    rappels: (c && c.rappels) || 0,
    rappelsModifies: (c && c.rappelsModifies) || 0,
    ...(c && c.bloqueJusqua ? { bloqueJusqua: c.bloqueJusqua } : {}),
    ...(c && c.rappelsBloquesJusqua ? { rappelsBloquesJusqua: c.rappelsBloquesJusqua } : {}),
  };
}

// Un message écrit de plus (pur, testé seul) : nouveau compteur et décision.
//   voix : la voix Google est permise ; bloque : la famille vient d'atteindre 50.
function compterMessage(compteur, auteur, maintenant = Date.now()) {
  const c = duJour(compteur, jourParis(maintenant));
  const cle = auteur || '?';
  c.parAuteur[cle] = (c.parAuteur[cle] || 0) + 1;
  c.messages += 1;
  const bloque = c.messages >= LIMITES.messagesParJour;
  if (bloque) c.bloqueJusqua = minuitSuivantParis(maintenant);
  return {
    compteur: c,
    voix: c.parAuteur[cle] <= LIMITES.voixParProche && c.messages <= LIMITES.messagesParJour,
    bloque,
    enTrop: c.messages > LIMITES.messagesParJour,
  };
}

// Un rappel créé de plus (pur). enTrop : au-delà des 10 du jour (passé avant le drapeau), à effacer.
function compterRappel(compteur, maintenant = Date.now()) {
  const c = duJour(compteur, jourParis(maintenant));
  c.rappels += 1;
  const bloque = c.rappels >= LIMITES.rappelsParJour;
  if (bloque) c.rappelsBloquesJusqua = minuitSuivantParis(maintenant);
  return { compteur: c, bloque, enTrop: c.rappels > LIMITES.rappelsParJour };
}

// Le texte d'un rappel a changé (pur) : voix permise jusqu'au 20e changement du jour.
function compterRappelModifie(compteur, maintenant = Date.now()) {
  const c = duJour(compteur, jourParis(maintenant));
  c.rappelsModifies += 1;
  return { compteur: c, voix: c.rappelsModifies <= LIMITES.voixRappelsModifies };
}

// Rappel en cours : un rappel « une fois » dont le jour n'est pas passé, ou un rappel qui se répète et n'est pas
// terminé (finLe passée). En pause : toujours en cours. Même définition que l'appli (agenda.js, rappelsEnCours).
function rappelEnCours(r, jour) {
  if (!r) return false;
  if (r.repeat === 'once') return !r.date || r.date >= jour;
  return !r.finLe || r.finLe >= jour;
}

// Pour la base : le compteur en Timestamp.
function versBase(c) {
  const d = { ...c, majLe: FieldValue.serverTimestamp() };
  if (c.bloqueJusqua != null) d.bloqueJusqua = Timestamp.fromMillis(millis(c.bloqueJusqua));
  if (c.rappelsBloquesJusqua != null) d.rappelsBloquesJusqua = Timestamp.fromMillis(millis(c.rappelsBloquesJusqua));
  return d;
}

const refCompteur = (db, fid) => db.doc(`families/${fid}/compteurs/jour`);

// Restauration d'une sauvegarde en cours (drapeau interne/restauration, voir base.js) : les envois et rappels remis
// ne sont pas comptés (ni effacés), le compteur du jour est lui-même restauré.
function restaurationEnCours(snap, maintenant = Date.now()) {
  const jusque = snap && snap.exists ? snap.get('jusque') : null;
  return !!(snap && snap.exists && snap.get('enCours') === true && jusque && jusque.toMillis && jusque.toMillis() > maintenant);
}

// Compte dans une transaction (un seul document par famille, écrit au plus ~70 fois par jour). Lu en même temps que
// le drapeau de restauration : 2 lectures, un seul aller-retour. { restauration: true } : rien compté.
async function compter(db, fid, calcul) {
  const ref = refCompteur(db, fid);
  return db.runTransaction(async (t) => {
    const [snap, drapeau] = await t.getAll(ref, db.doc('interne/restauration'));
    if (restaurationEnCours(drapeau)) return { restauration: true };
    const r = calcul(snap.exists ? snap.data() : null);
    // Set complet : un nouveau jour efface les compteurs et drapeaux d'hier.
    t.set(ref, versBase(r.compteur));
    return r;
  });
}

const messageCree = (db, fid, auteur) => compter(db, fid, (c) => compterMessage(c, auteur));
const rappelCree = (db, fid) => compter(db, fid, (c) => compterRappel(c));
const rappelModifie = (db, fid) => compter(db, fid, (c) => compterRappelModifie(c));

// Rappels en cours de la famille (secours : l'appli refuse déjà le 31e). Compte d'abord, cher seulement au-delà.
async function rappelsEnCours(db, fid, maintenant = Date.now()) {
  const coll = db.collection(`families/${fid}/reminders`);
  const total = (await coll.count().get()).data().count;
  if (total <= LIMITES.rappelsEnCours) return total;
  const jour = jourParis(maintenant);
  return (await coll.get()).docs.filter((d) => rappelEnCours(d.data(), jour)).length;
}

module.exports = {
  LIMITES, jourParis, minuitSuivantParis, estFrais, compterMessage, compterRappel, compterRappelModifie,
  rappelEnCours, messageCree, rappelCree, rappelModifie, rappelsEnCours, refCompteur,
};
