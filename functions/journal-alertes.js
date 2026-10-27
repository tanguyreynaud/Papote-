// Chaque alerte envoyée aux proches est notée une fois dans alertes/{id} (Tanguy, 2026-10-27 : « compter chaque
// alerte et la remonter à l'admin pour analyser »). Lu par gestionDonnees (90 derniers jours) ; aucune règle
// Firestore ne l'ouvre aux applis, seul le serveur y écrit.
//   { genre, fid, tablette (uid du compte de la tablette, ou null), telephones (nombre prévenus), le }
// Ne bloque jamais l'alerte elle-même : une écriture ratée est seulement journalisée.

const { logger } = require('firebase-functions/v2');
const { FieldValue } = require('firebase-admin/firestore');

const GENRES = {
  debranchee: 'Tablette débranchée',
  silence: 'Tablette qui ne répond plus',
  'pas-vue': 'Pas vue ce matin',
  sos: 'SOS',
  'sos-sans-reponse': 'SOS sans réponse',
  'appel-manque': 'Appel manqué de la tablette',
  'sans-telephone': 'Appel sans aucun téléphone joignable',
  impaye: 'Paiement échoué',
  pause: 'Papote en pause (impayé)',
};

async function noter(db, { genre, fid, tablette = null, telephones = null }) {
  try {
    await db.collection('alertes').add({
      genre, fid: fid || null, tablette: tablette || null,
      telephones: Number.isFinite(telephones) ? telephones : null,
      le: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    logger.warn(`Alerte ${genre} (${fid}) non notée`, e.message);
  }
}

module.exports = { GENRES, noter };
