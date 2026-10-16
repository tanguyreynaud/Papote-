// Base Firestore et stockage des fonctions, réglés dans .env pour basculer en un seul déploiement :
//   BASE_FIRESTORE   « (default) » (US, nam5) aujourd'hui, « eu » après la migration Europe ;
//   REGION_FIRESTORE région de la base pour les déclencheurs (nam5 → us-central1, eu → europe-west1) ;
//   BUCKET_STORAGE  bucket des photos et pièces (vide = bucket par défaut du projet).
// gestion.js lit les mêmes variables ; support.js et appels.js peuvent reprendre db().
const { getFirestore } = require('firebase-admin/firestore');

const BASE_FIRESTORE = process.env.BASE_FIRESTORE || '(default)';
const REGION_FIRESTORE = process.env.REGION_FIRESTORE || 'europe-west1';
const BUCKET_STORAGE = process.env.BUCKET_STORAGE || '';

const db = () => getFirestore(BASE_FIRESTORE);

module.exports = { BASE_FIRESTORE, REGION_FIRESTORE, BUCKET_STORAGE, db };
