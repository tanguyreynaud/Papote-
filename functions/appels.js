// Appels de la tablette vers la famille : faire sonner le téléphone du proche, même app fermée.
//
//   appelsSonnerie  appel créé par la tablette : notification push « Mamie vous appelle »
//   appelsManques   l'appel de la tablette s'arrête sans réponse : « Appel manqué de Mamie »
//
// Jetons des téléphones : families/{fid}/members/{uid}/private/push = { tokens: [...] }
// (écrits par web/js/push.js). Messages « data » seulement : web/sw.js les affiche.

const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const admin = require('firebase-admin');

const { BASE_FIRESTORE, REGION_FIRESTORE, db: base } = require('./base');

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

async function envoyer(db, fid, uids, data, ttlSecondes) {
  const refs = uids.map((uid) => db.doc(`families/${fid}/members/${uid}/private/push`));
  const docs = refs.length ? await db.getAll(...refs) : [];
  const jetons = [];
  docs.forEach((d, i) => (d.get('tokens') || []).forEach((t) => jetons.push({ t, ref: refs[i] })));
  if (!jetons.length) return 0;
  const res = await admin.messaging().sendEachForMulticast({
    tokens: jetons.map((j) => j.t),
    data,
    webpush: { headers: { Urgency: 'high', TTL: String(ttlSecondes) } },
  });
  // Jetons périmés (app désinstallée, autorisation retirée) : on les oublie.
  const perimes = [];
  res.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
      perimes.push(jetons[i]);
    }
  });
  await Promise.all(perimes.map((j) => j.ref.update({ tokens: admin.firestore.FieldValue.arrayRemove(j.t) }).catch(() => {})));
  return res.successCount;
}

exports.appelsSonnerie = onDocumentCreated({ document: DOC, region: REGION_FIRESTORE, database: BASE_FIRESTORE }, async (event) => {
  const appel = event.data.data();
  if (!appel || appel.state !== 'ringing') return;
  const db = base();
  const { fid, cid } = event.params;
  const uids = await destinataires(db, fid, appel);
  if (!uids.length) return;
  const n = await envoyer(db, fid, uids, { type: 'appel', cid, nom: String(appel.callerName || 'Mamie') }, 45);
  logger.info(`Appel ${cid} : ${n} téléphone(s) prévenu(s)`);
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
