// Base Firestore et stockage des fonctions, réglés dans .env pour basculer en un seul déploiement :
//   BASE_FIRESTORE   « (default) » (US, nam5) aujourd'hui, « eu » après la migration Europe ;
//   REGION_FIRESTORE région de la base pour les déclencheurs (nam5 → us-central1, eu → europe-west1) ;
//   BUCKET_STORAGE  bucket des photos et pièces (vide = bucket par défaut du projet).
// gestion.js lit les mêmes variables ; support.js et appels.js peuvent reprendre db().
// Valeurs par défaut = Europe : à la publication, Firebase lit les options des déclencheurs
// (database) sans toujours voir .env, et un repli sur (default) les laissait sur l'ancienne base.
const { getFirestore, initializeFirestore } = require('firebase-admin/firestore');
const { getApp } = require('firebase-admin/app');

const BASE_FIRESTORE = process.env.BASE_FIRESTORE || 'europe';
const REGION_FIRESTORE = process.env.REGION_FIRESTORE || 'europe-west1';
const BUCKET_STORAGE = process.env.BUCKET_STORAGE || 'papote-famille-eu';

// REST plutôt que gRPC en ligne : la bibliothèque gRPC n'est plus chargée ni sa connexion ouverte au premier
// appel, ce qui raccourcit le démarrage à froid de chaque fonction (recommandé par Firebase ; les écoutes en
// direct repassent d'elles-mêmes par gRPC). L'émulateur des tests reste en gRPC : en REST il demande un compte Google.
let instance;
function db() {
  if (!instance) {
    instance = process.env.FIRESTORE_EMULATOR_HOST
      ? getFirestore(BASE_FIRESTORE)
      : initializeFirestore(getApp(), { preferRest: true }, BASE_FIRESTORE);
  }
  return instance;
}

// Restauration d'une sauvegarde (outils/admin/restaurer.js, audit A15-5 et A34) : pendant qu'elle réécrit la base,
// AUCUN déclencheur Firestore ne doit agir, sinon chaque proche restauré recevrait « X a rejoint la famille », chaque
// appel restauré ferait sonner les téléphones, chaque commande restaurée repasserait par commandeModifiee (Stripe,
// e-mails), chaque envoi referait sa voix… Le drapeau interne/restauration :
//   pendant : { enCours: true, debut (heure du serveur), jusque (2 h, prolongé tant que l'écriture dure) }
//   après   : { enCours: false, debut, fin (heure du serveur) } : il reste, pour les événements livrés en retard.
// Un déclencheur se tait si l'écriture qui l'a lancé (event.time) tombe entre debut et fin, ou après debut tant que
// la restauration est en cours (jusque pas dépassé : une restauration plantée ne bloque pas plus de 2 h).
// Tous les déclencheurs Firestore passent par declencheurs (ci-dessous) : aucun ne peut l'oublier.
// Coût : le drapeau est gardé en mémoire 60 s par instance (CACHE_MS) : au plus une lecture par minute et par
// instance, pas une par déclencheur (compterProches tourne à chaque signe de vie des tablettes). C'est sûr parce que
// restaurer.js attend plus de 60 s entre la pose du drapeau et sa première écriture (toute mémoire plus vieille que
// le drapeau a expiré), et parce qu'un drapeau « en cours » n'est jamais gardé en mémoire (relu à chaque fois pendant
// la restauration : la fin est vue tout de suite).
// Ce qu'un humain écrit PENDANT la restauration ne déclenche rien non plus (pas de voix, pas de notification) : la
// restauration est une opération de maintenance, à faire au calme.
const CACHE_MS = 60 * 1000;
const millis = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : null);
let memoire = null; // { lu (ms), drapeau (données ou null) }
async function lireDrapeau() {
  const frais = memoire && Date.now() - memoire.lu < CACHE_MS && Date.now() >= memoire.lu
    && !(memoire.drapeau && memoire.drapeau.enCours === true);
  if (!frais) {
    const lu = Date.now();
    const s = await db().doc('interne/restauration').get();
    memoire = { lu, drapeau: s.exists ? s.data() : null };
  }
  return memoire.drapeau;
}
function oublierDrapeau() { memoire = null; }

async function restaurationEnCours(event) {
  try {
    const quand = event && event.time ? Date.parse(event.time) : Date.now();
    const d = await lireDrapeau();
    if (!d) return false;
    const debut = millis(d.debut) || millis(d.le);
    if (d.enCours === true) {
      const jusque = millis(d.jusque);
      return !!(jusque && jusque > Date.now() && (!debut || quand >= debut));
    }
    const fin = millis(d.fin);
    return !!(debut && fin && quand >= debut && quand <= fin);
  } catch (e) {
    return false;
  }
}

// Enveloppe d'un déclencheur : rien n'est fait pendant une restauration.
function sansRestauration(nom, gestionnaire) {
  return async (event) => {
    if (await module.exports.restaurationEnCours(event)) {
      require('firebase-functions/v2').logger.info(`${nom || 'Déclencheur'} : écriture d'une restauration, ignorée.`);
      return null;
    }
    return gestionnaire(event);
  };
}

// À utiliser à la place de firebase-functions/v2/firestore dans tous les fichiers.
const v2firestore = require('firebase-functions/v2/firestore');
const envelopper = (nom) => (options, gestionnaire) => v2firestore[nom](options, sansRestauration(options && options.document, gestionnaire));
const declencheurs = {
  onDocumentCreated: envelopper('onDocumentCreated'),
  onDocumentUpdated: envelopper('onDocumentUpdated'),
  onDocumentWritten: envelopper('onDocumentWritten'),
  onDocumentDeleted: envelopper('onDocumentDeleted'),
};

module.exports = { BASE_FIRESTORE, REGION_FIRESTORE, BUCKET_STORAGE, db, restaurationEnCours, sansRestauration, declencheurs, oublierDrapeau, CACHE_MS };
