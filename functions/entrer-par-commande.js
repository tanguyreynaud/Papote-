// Entrer dans sa famille avec son numéro de commande (A40, audit de mise en route du 12/11, M1 ; Tanguy 12/11).
//
// Celui qui a payé est invité dans sa famille préparée à l'adresse e-mail de la commande (famille-preparee.js). S'il
// ouvre l'appli avec une autre adresse (Google perso, adresse du conjoint…), aucune invitation ne l'attend : il tape
// alors dans « Vous êtes invité dans une famille » le seul code qu'il a, son numéro de commande (page « Merci »,
// e-mail, facture ; format XXXX-XXXX, commandes/{id}.code). L'appli essaie d'abord le code famille, puis cette fonction.
//
//   commande payée, avec sa famille préparée → le compte y entre comme proche actif, et devient responsable :
//     « le premier qui rejoint devient responsable, celui qui a commandé est toujours responsable » (Tanguy) ;
//     propriétaire (createdBy) si la famille n'en a pas encore, sinon ajouté aux responsables (admins, 10 au plus).
//   essais limités par compte et par jour (limites/entrerParCommande-{uid}, un seul document par compte, remis à zéro
//   le jour suivant : rien à purger, pas de tâche planifiée) : on ne devine pas un code de commande au hasard.
//
// Exporté à la fin de index.js (exports.entrerParCommande).

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { FieldValue } = require('firebase-admin/firestore');
const base = require('./base');
const { normaliserCode } = require('./abonnement');

// Essais par compte et par jour (heure de Paris). Les codes ont 8 caractères parmi 31 : à ce rythme, deviner la
// commande de quelqu'un est hors de portée, et un proche qui se trompe deux ou trois fois n'est pas bloqué.
const ESSAIS_PAR_JOUR = 5;
const MAX_RESPONSABLES = 10; // comme les règles Firestore et installation.js
const MAX_PROCHES = 30; // comme firestore.rules (familleAPlace) et l'appli

// Jour de Paris (« 2026-11-12 ») d'un instant : le compteur repart chaque jour à minuit.
function jourDeParis(ms) {
  return new Date(ms).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
}

// Essai suivant pour ce compte (pure, testée) : { ok, compteur } ; ok=false au-delà de ESSAIS_PAR_JOUR aujourd'hui.
function essaiSuivant(compteur, maintenant, max = ESSAIS_PAR_JOUR) {
  const jour = jourDeParis(maintenant);
  const essais = compteur && compteur.jour === jour ? compteur.essais || 0 : 0;
  if (essais >= max) return { ok: false, compteur: { jour, essais } };
  return { ok: true, compteur: { jour, essais: essais + 1 } };
}

// La commande ouvre-t-elle sa famille (pure, testée) ? Payée (la famille n'est créée qu'au paiement), avec sa famille
// préparée, pas annulée. → null si oui, sinon la raison.
function refusCommande(commande) {
  if (!commande) return 'inconnue';
  if (!commande.famillePreparee || !commande.fid) return 'sans-famille';
  if (commande.expedition === 'annulee') return 'annulee';
  if (commande.expedition === 'paiement-en-attente') return 'pas-payee';
  return null;
}

// Place du compte dans la famille (pure, testée) : { responsable: 'proprietaire' | 'admin' | 'deja' | 'complet' }.
function placeDuPayeur(famille, uid) {
  if (!famille.createdBy) return 'proprietaire';
  const admins = famille.admins || [];
  if (famille.createdBy === uid || admins.includes(uid)) return 'deja';
  return admins.length < MAX_RESPONSABLES ? 'admin' : 'complet';
}

function compteVerifie(request) {
  const token = request.auth && request.auth.token;
  if (!token || !token.email || !token.email_verified
    || (token.firebase && token.firebase.sign_in_provider === 'anonymous')) {
    throw new HttpsError('unauthenticated', 'Connectez-vous avec Google ou votre e-mail.');
  }
  return { uid: request.auth.uid, email: token.email.toLowerCase() };
}

const INCONNU = 'Ce code ne correspond à aucune commande.';

async function entrer(request) {
  const { uid, email } = compteVerifie(request);
  const data = request.data || {};
  const prenom = typeof data.prenom === 'string' ? data.prenom.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  if (!prenom) throw new HttpsError('invalid-argument', 'Votre prénom est demandé.');
  const db = base.db();

  // L'essai compte avant toute recherche, qu'il réussisse ou non.
  const limite = db.doc(`limites/entrerParCommande-${uid}`);
  const permis = await db.runTransaction(async (tx) => {
    const r = essaiSuivant((await tx.get(limite)).data(), Date.now());
    if (r.ok) tx.set(limite, { ...r.compteur, majLe: FieldValue.serverTimestamp() });
    return r.ok;
  });
  if (!permis) {
    logger.warn(`entrerParCommande : ${uid} a dépassé ${ESSAIS_PAR_JOUR} essais aujourd'hui.`);
    throw new HttpsError('resource-exhausted', 'Trop d\'essais pour aujourd\'hui. Réessayez demain.');
  }

  const code = normaliserCode(data.code);
  if (!code) throw new HttpsError('not-found', INCONNU);
  const trouvees = await db.collection('commandes').where('code', '==', code).limit(2).get();
  if (trouvees.size !== 1) throw new HttpsError('not-found', INCONNU);
  const commande = trouvees.docs[0].data();
  const refus = refusCommande(commande);
  if (refus === 'pas-payee') {
    throw new HttpsError('failed-precondition', 'Cette commande n\'est pas encore payée : votre famille sera prête dès la confirmation du paiement.');
  }
  if (refus) throw new HttpsError('not-found', INCONNU);

  const fid = commande.fid;
  const famRef = db.doc(`families/${fid}`);
  const membreRef = famRef.collection('members').doc(uid);
  const r = await db.runTransaction(async (tx) => {
    const [famSnap, membreSnap] = await Promise.all([tx.get(famRef), tx.get(membreRef)]);
    const fam = famSnap.data();
    if (!fam || !(fam.installation && fam.installation.preparee)) throw new HttpsError('not-found', INCONNU);
    const membre = membreSnap.data();
    if (membre && membre.role !== 'famille') throw new HttpsError('failed-precondition', 'Ce compte ne peut pas entrer dans cette famille.');
    const proche = membre && membre.status !== 'pending';
    if (!proche && (fam.nbProches || 0) >= MAX_PROCHES) {
      throw new HttpsError('failed-precondition', 'La famille est complète : 30 proches au maximum. Un responsable peut retirer quelqu\'un.');
    }
    const place = placeDuPayeur(fam, uid);
    if (!membre) {
      tx.set(membreRef, {
        name: prenom, role: 'famille', code: fam.code || '', joinedAt: FieldValue.serverTimestamp(),
        uid, email, status: 'active',
      });
    } else if (membre.status === 'pending') {
      tx.update(membreRef, { status: 'active' });
    }
    if (place === 'proprietaire') {
      tx.update(famRef, { createdBy: uid, rev: FieldValue.increment(1) });
      if (fam.code) tx.set(db.doc(`invites/${fam.code}`), { createdBy: uid }, { merge: true });
    } else if (place === 'admin') {
      tx.update(famRef, { admins: FieldValue.arrayUnion(uid), rev: FieldValue.increment(1) });
    }
    return { place, nom: fam.nomAChoisir ? '' : (fam.name || '') };
  });
  logger.info(`entrerParCommande : ${uid} entre dans la famille ${fid} (commande ${trouvees.docs[0].id}, ${r.place}).`);
  return { fid, nom: r.nom, responsable: r.place !== 'complet' };
}

exports.entrerParCommande = onCall({ maxInstances: 2 }, entrer);
exports.regles = { jourDeParis, essaiSuivant, refusCommande, placeDuPayeur, ESSAIS_PAR_JOUR, MAX_RESPONSABLES };
