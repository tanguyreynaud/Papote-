// Appels de la tablette vers la famille : faire sonner le téléphone du proche, même app fermée.
//
//   appelsSonnerie  appel créé par la tablette : notification push « Mamie vous appelle »
//   appelsManques   l'appel de la tablette s'arrête sans réponse : « Appel manqué de Mamie »
//
// Jetons des téléphones : families/{fid}/members/{uid}/private/push = { tokens: [...] }
// (écrits par web/js/push.js). Messages « data » seulement : web/sw.js les affiche.

const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');

const { BASE_FIRESTORE, REGION_FIRESTORE, db: base } = require('./base');
const { envoyer } = require('./push');

const DOC = 'families/{fid}/calls/{cid}';

// L'appel vient-il d'une tablette de la famille ? Renvoie les proches à prévenir.
async function destinataires(db, fid, appel) {
  const membres = await db.collection(`families/${fid}/members`).get();
  const appelant = membres.docs.find((m) => m.id === appel.callerUid);
  if (!appelant || appelant.get('role') !== 'tablette') return [];
  return membres.docs
    .filter((m) => m.get('role') === 'famille' && m.get('status') !== 'pending')
    .filter((m) => !appel.calleeUid || m.id === appel.calleeUid)
    .map((m) => m.id);
}

// Une notification web ne sonne qu'une fois : on la renvoie toutes les 12 s tant que la tablette
// sonne (même étiquette, « renotify » refait sonner et vibrer), comme une sonnerie qui insiste.
const REPRISES = 4;
const INTERVALLE_MS = 12_000;
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

exports.appelsSonnerie = onDocumentCreated({ document: DOC, region: REGION_FIRESTORE, database: BASE_FIRESTORE, timeoutSeconds: 90 }, async (event) => {
  const appel = event.data.data();
  if (!appel || appel.state !== 'ringing') return;
  const db = base();
  const { fid, cid } = event.params;
  const uids = await destinataires(db, fid, appel);
  if (!uids.length) return;
  const data = { type: 'appel', cid, nom: String(appel.callerName || 'Mamie') };
  const n = await envoyer(db, fid, uids, data, 45);
  logger.info(`Appel ${cid} : ${n} téléphone(s) prévenu(s)`);
  for (let i = 0; i < REPRISES; i++) {
    await attendre(INTERVALLE_MS);
    const cur = await event.data.ref.get();
    if (!cur.exists || cur.get('state') !== 'ringing') return;
    await envoyer(db, fid, uids, data, 20);
  }
});

exports.appelsManques = onDocumentUpdated({ document: DOC, region: REGION_FIRESTORE, database: BASE_FIRESTORE }, async (event) => {
  const avant = event.data.before.data();
  const apres = event.data.after.data();
  if (!avant || !apres || avant.state !== 'ringing') return;
  if (!['missed', 'ended', 'declined'].includes(apres.state) || apres.answer) return;
  const db = base();
  const { fid, cid } = event.params;
  const uids = await destinataires(db, fid, apres);
  if (!uids.length) return;
  await envoyer(db, fid, uids, { type: 'manque', cid, nom: String(apres.callerName || 'Mamie') }, 24 * 3600);
});
