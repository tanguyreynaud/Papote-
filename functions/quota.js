// Plafonds de stockage appliqués par le serveur : l'app famille garde déjà les 200 dernières photos
// et 40 vidéos (famille.js, pruneOld), mais une appli modifiée ou un bug pourrait remplir le stockage
// et faire grimper la facture. Ces plafonds sont bien au-dessus d'un usage normal : ils ne servent
// qu'en cas d'abus.
//
//   quotaFichier         fichier ajouté dans families/{fid}/media/ : compté dans stockage/{fid} ;
//                        au-delà de 2 Go ou de 1 500 fichiers par famille, le nouveau fichier est effacé
//   quotaFichierEfface   fichier effacé : décompté
//   quotaEnvois          envoi photo ou vidéo créé : au-delà de 300 photos ou 60 vidéos, il est effacé
//
// stockage/{fid} = { octets, fichiers } n'est lisible par personne côté client (pas de règle).

const { onObjectFinalized, onObjectDeleted } = require('firebase-functions/v2/storage');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const { db: base, BASE_FIRESTORE, REGION_FIRESTORE, BUCKET_STORAGE } = require('./base');

const MAX_OCTETS = 2 * 1024 ** 3;
const MAX_FICHIERS = 1500;
const MAX_ENVOIS = { photo: 300, video: 60 };

// families/{fid}/media/{fichier} -> fid, sinon null.
function familleDuFichier(nom) {
  const m = /^families\/([^/]+)\/media\/[^/]+$/.exec(nom || '');
  return m ? m[1] : null;
}

function depasse({ octets, fichiers }) {
  return octets > MAX_OCTETS || fichiers > MAX_FICHIERS;
}

function envoiEnTrop(type, nombre) {
  return MAX_ENVOIS[type] != null && nombre > MAX_ENVOIS[type];
}

// Total actuel du dossier de la famille (première fois seulement).
async function mesurer(bucket, fid) {
  const [fichiers] = await bucket.getFiles({ prefix: `families/${fid}/media/` });
  return {
    octets: fichiers.reduce((t, f) => t + Number(f.metadata.size || 0), 0),
    fichiers: fichiers.length,
  };
}

const quotaFichier = onObjectFinalized({ bucket: BUCKET_STORAGE, maxInstances: 3 }, async (event) => {
  const fid = familleDuFichier(event.data.name);
  if (!fid) return;
  const taille = Number(event.data.size || 0);
  const bucket = admin.storage().bucket(event.data.bucket);
  const fiche = base().doc(`stockage/${fid}`);

  const total = await base().runTransaction(async (t) => {
    const snap = await t.get(fiche);
    // Première fois : on mesure le dossier, qui contient déjà ce fichier.
    const apres = snap.exists
      ? { octets: (snap.get('octets') || 0) + taille, fichiers: (snap.get('fichiers') || 0) + 1 }
      : await mesurer(bucket, fid);
    t.set(fiche, { ...apres, le: FieldValue.serverTimestamp() });
    return apres;
  });
  if (!depasse(total)) return;

  logger.warn('Plafond de stockage dépassé : fichier effacé', { fid, fichier: event.data.name, ...total });
  // L'effacement déclenche quotaFichierEfface, qui le décompte.
  await bucket.file(event.data.name).delete({ ignoreNotFound: true });
});

const quotaFichierEfface = onObjectDeleted({ bucket: BUCKET_STORAGE, maxInstances: 3 }, async (event) => {
  const fid = familleDuFichier(event.data.name);
  if (!fid) return;
  const fiche = base().doc(`stockage/${fid}`);
  await base().runTransaction(async (t) => {
    const snap = await t.get(fiche);
    if (!snap.exists) return; // pas encore mesuré : rien à décompter
    t.update(fiche, {
      octets: Math.max(0, (snap.get('octets') || 0) - Number(event.data.size || 0)),
      fichiers: Math.max(0, (snap.get('fichiers') || 0) - 1),
    });
  });
});

const quotaEnvois = onDocumentCreated(
  { document: 'families/{fid}/posts/{pid}', database: BASE_FIRESTORE, region: REGION_FIRESTORE, maxInstances: 3 },
  async (event) => {
    const post = event.data && event.data.data();
    if (!post || MAX_ENVOIS[post.type] == null) return;
    const posts = base().collection(`families/${event.params.fid}/posts`);
    const nombre = (await posts.where('type', '==', post.type).count().get()).data().count;
    if (!envoiEnTrop(post.type, nombre)) return;

    logger.warn('Trop d\'envois : envoi effacé', { fid: event.params.fid, type: post.type, nombre });
    // Seulement les fichiers de cette famille : storagePath est écrit par l'appli.
    const chemins = new Set([post.storagePath, ...(post.photos || []).map((p) => p && p.storagePath)]
      .filter((c) => familleDuFichier(c) === event.params.fid));
    const bucket = admin.storage().bucket(BUCKET_STORAGE);
    await Promise.all([...chemins].map((c) => bucket.file(c).delete({ ignoreNotFound: true })));
    await base().recursiveDelete(event.data.ref);
  });

module.exports = { quotaFichier, quotaFichierEfface, quotaEnvois, familleDuFichier, depasse, envoiEnTrop };
