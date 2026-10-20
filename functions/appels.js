// Appels de la tablette vers la famille : faire sonner le téléphone du proche, même app fermée.
//
//   appelsSonnerie  appel créé par la tablette : notification push « Mamie vous appelle »
//   appelsManques   l'appel de la tablette s'arrête sans réponse : « Appel manqué de Mamie » ;
//                   s'il a été décroché, les autres téléphones arrêtent de sonner (« fin »)
//   jetonAppelNatif connexion de l'écran d'appel de l'app Android (voir envoyerConnexions)
//   refuserAppel    « Refuser » sur l'app Android (pas connectée à Firebase) : l'appel s'arrête pour
//                   la tablette, prouvé par le jeton d'appel reçu avec la sonnerie
//
// Jetons des téléphones : families/{fid}/members/{uid}/private/push (voir push.js).
// Messages « data » seulement : web/sw.js ou l'app Android (telephone/) les affichent.

const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

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
  // Jeton d'appel : seul un téléphone qui a reçu la sonnerie peut refuser sans se connecter.
  const jeton = require('node:crypto').randomBytes(16).toString('hex');
  await event.data.ref.collection('prive').doc('refus').set({ jeton });
  const data = { type: 'appel', cid, fid, jeton, nom: String(appel.callerName || 'Mamie') };
  const n = await envoyer(db, fid, uids, data, 45);
  logger.info(`Appel ${cid} : ${n} téléphone(s) prévenu(s)`);
  await envoyerConnexions(db, fid, cid, uids);
  for (let i = 0; i < REPRISES; i++) {
    await attendre(INTERVALLE_MS);
    const cur = await event.data.ref.get();
    if (!cur.exists || cur.get('state') !== 'ringing') return;
    await envoyer(db, fid, uids, data, 20, { websSeulement: true });
  }
});

// L'app Android passe l'appel dans son propre écran (micro gardé en arrière-plan, comme un vrai
// appel) : elle s'y connecte au compte du proche avec ce jeton de connexion Firebase, envoyé juste
// après la sonnerie pour ne pas la retarder. Valable une heure, seulement vers ses téléphones.
async function envoyerConnexions(db, fid, cid, uids) {
  await Promise.all(uids.map(async (uid) => {
    try {
      const connexion = await getAuth().createCustomToken(uid);
      await envoyer(db, fid, [uid], { type: 'connexion', cid, connexion }, 45, { natifsSeulement: true });
    } catch (e) {
      logger.warn(`Appel ${cid} : jeton de connexion impossible pour ${uid}`, e.message);
    }
  }));
}

// Même jeton, pour un appel lancé depuis l'app Android (bouton Appel vidéo de l'app famille).
exports.jetonAppelNatif = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Connexion requise.');
  return { connexion: await getAuth().createCustomToken(request.auth.uid) };
});

exports.appelsManques = onDocumentUpdated({ document: DOC, region: REGION_FIRESTORE, database: BASE_FIRESTORE }, async (event) => {
  const avant = event.data.before.data();
  const apres = event.data.after.data();
  if (!avant || !apres || avant.state !== 'ringing' || apres.state === 'ringing') return;
  const db = base();
  const { fid, cid } = event.params;
  const uids = await destinataires(db, fid, apres);
  if (!uids.length) return;
  if (['missed', 'ended', 'declined'].includes(apres.state) && !apres.answer) {
    await envoyer(db, fid, uids, { type: 'manque', cid, nom: String(apres.callerName || 'Mamie') }, 24 * 3600);
  } else {
    // Quelqu'un a décroché : les autres téléphones (app Android) arrêtent de sonner.
    await envoyer(db, fid, uids, { type: 'fin', cid }, 60, { natifsSeulement: true });
  }
});

// POST { fid, cid, jeton } depuis l'app Android : même effet que « Refuser » dans l'app famille
// (declineIncoming) : la tablette affiche aussitôt que personne n'a pu répondre.
const ID = /^[A-Za-z0-9_-]{1,64}$/;

exports.refuserAppel = onRequest({ maxInstances: 2 }, async (req, res) => {
  const { fid, cid, jeton } = req.body || {};
  if (req.method !== 'POST' || !ID.test(String(fid)) || !ID.test(String(cid)) || typeof jeton !== 'string') {
    res.status(400).send('');
    return;
  }
  const db = base();
  const ref = db.doc(`families/${fid}/calls/${cid}`);
  const refus = await ref.collection('prive').doc('refus').get();
  if (!refus.exists || refus.get('jeton') !== jeton) {
    res.status(403).send('');
    return;
  }
  await db.runTransaction(async (t) => {
    const appel = await t.get(ref);
    if (appel.exists && appel.get('state') === 'ringing') {
      t.update(ref, { state: 'declined', endedAt: FieldValue.serverTimestamp() });
    }
  });
  res.status(204).send('');
});

// ---------- Relevé des appels qui échouent ----------
// incidentAppel : la tablette ou l'app famille signale un appel raté (raison, détail, appel).
// Gardé dans incidentsAppels pour le tableau de bord, et dans les journaux des fonctions.

const texte = (v, max) => String(v == null ? '' : v).slice(0, max);

exports.incidentAppel = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Connexion requise.');
  const d = request.data || {};
  const incident = {
    uid: request.auth.uid,
    cote: d.cote === 'tablette' ? 'tablette' : 'famille',
    raison: texte(d.raison, 60) || 'inconnue',
    detail: texte(d.detail, 300),
    cid: d.cid ? texte(d.cid, 64) : null,
    relais: d.relais === true,
    navigateur: texte(d.navigateur, 200),
    le: FieldValue.serverTimestamp(),
  };
  logger.warn(`Appel raté (${incident.cote}) : ${incident.raison} ${incident.detail}`, { uid: incident.uid, cid: incident.cid, relais: incident.relais });
  await base().collection('incidentsAppels').add(incident);
  return { ok: true };
});
