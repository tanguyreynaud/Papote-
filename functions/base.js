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

module.exports = { BASE_FIRESTORE, REGION_FIRESTORE, BUCKET_STORAGE, db };
