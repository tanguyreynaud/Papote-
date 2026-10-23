// App Check pour les tablettes : pas de Play Store, donc pas de Play Integrity. Chaque tablette reçoit
// à l'installation une clé secrète (outils\admin\cle-tablette.bat, appelé par installer-tablette.ps1) ;
// seule son empreinte SHA-256 est gardée dans clesTablettes/{empreinte}, illisible côté client.
//
//   jetonAppCheck  POST { cle } -> { token, expireTimeMillis } : jeton App Check valable 1 h ;
//                  avec « Authorization: Bearer <jeton d'identité> », la clé est reliée au compte de la tablette,
//                  envoyé ensuite par la tablette dans l'en-tête X-Firebase-AppCheck (et par appels.js)
//
// Une tablette perdue ou volée : supprimer sa clé (cle-tablette.bat --retirer SERIE), plus de jeton.

const { onRequest } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const crypto = require('node:crypto');
const { db: base } = require('./base');

// Appli web Firebase de Papote (même identifiant que l'app famille et appels.js).
const APP_ID = '1:807031084851:web:b8048e2952cb1e893b1046';
const DUREE_MS = 60 * 60_000;
const JOUR_MS = 86_400_000;

const empreinte = (cle) => crypto.createHash('sha256').update(cle).digest('hex');

// Une clé : 43 caractères base64url (32 octets aléatoires).
const cleValide = (cle) => typeof cle === 'string' && /^[A-Za-z0-9_-]{43}$/.test(cle);

async function uidDuJeton(entete) {
  const m = /^Bearer (.+)$/.exec(entete || '');
  if (!m) return null;
  try {
    return (await admin.auth().verifyIdToken(m[1])).uid;
  } catch (e) {
    return null;
  }
}

const jetonAppCheck = onRequest({ maxInstances: 2, cors: true }, async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('POST seulement');
  const cle = req.body && req.body.cle;
  if (!cleValide(cle)) return res.status(400).json({ erreur: 'clé absente' });

  const fiche = base().doc(`clesTablettes/${empreinte(cle)}`);
  const snap = await fiche.get();
  if (!snap.exists) {
    logger.warn('App Check : clé de tablette inconnue');
    return res.status(403).json({ erreur: 'clé inconnue' });
  }
  const { token, ttlMillis } = await admin.appCheck().createToken(APP_ID, { ttlMillis: DUREE_MS });
  const maj = {};
  // Compte Firebase de la tablette (Authorization: Bearer <jeton d'identité>) : la clé, posée à
  // l'installation avec le n° de série, prouve alors que ce compte est bien cette tablette
  // (gestionJumelage ne croit le n° de série d'un jumelage que sur cette preuve).
  const uid = await uidDuJeton(req.get('Authorization'));
  if (uid && snap.get('tabletUid') !== uid) maj.tabletUid = uid;
  // Dernière utilisation, au plus une écriture par jour.
  const vue = snap.get('vueLe');
  if (!vue || Date.now() - vue.toMillis() > JOUR_MS) maj.vueLe = admin.firestore.Timestamp.now();
  if (Object.keys(maj).length) await fiche.update(maj).catch(() => {});
  res.json({ token, expireTimeMillis: Date.now() + ttlMillis });
});

module.exports = { jetonAppCheck, empreinte, cleValide, APP_ID };
