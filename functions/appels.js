// Appels de la tablette vers la famille : faire sonner le téléphone du proche, même app fermée.
//
//   appelsSonnerie  appel créé par la tablette : notification push « Mamie vous appelle »
//   appelsManques   l'appel de la tablette s'arrête sans réponse : « Appel manqué de Mamie » ;
//                   s'il a été décroché, les autres téléphones arrêtent de sonner (« fin »)
//                   SOS (bouton « SOS famille ») : « SOS : Mamie vous appelle » ; sans réponse au
//                   2e essai, « Mamie a appuyé sur SOS » à toute la famille
//   refuserAppel    « Refuser » sur l'app Android (pas connectée à Firebase) : l'appel s'arrête pour
//                   la tablette, prouvé par le jeton d'appel reçu avec la sonnerie
//
// Jetons des téléphones : families/{fid}/members/{uid}/private/push (voir push.js).
// Messages « data » seulement : web/sw.js ou l'app Android (telephone/) les affichent.

const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { FieldValue } = require('firebase-admin/firestore');

const { defineSecret, defineString } = require('firebase-functions/params');
const { BASE_FIRESTORE, REGION_FIRESTORE, db: base } = require('./base');
const { envoyer } = require('./push');
const mail = require('./mail');

// Appel ou SOS qui ne fait sonner aucun téléphone (D1, Tanguy 2026-10-27) : tous les proches le savent par
// e-mail (mêmes réglages que index.js ; en simulation, mail.envoyer est remplacé).
const MAIL_SMTP = defineString('MAIL_SMTP', { default: 'smtp.gmail.com:465:' });
const MAIL_EXPEDITEUR = defineString('MAIL_EXPEDITEUR', { default: '' });
const MAIL_MOT_DE_PASSE = defineSecret('MAIL_MOT_DE_PASSE');
const APPLI = 'https://app.mapapote.fr/';

async function prevenirSansTelephone(db, fid, uids, { nom, sos }) {
  const fiches = uids.length ? await db.getAll(...uids.map((uid) => db.doc(`families/${fid}/members/${uid}`))) : [];
  const emails = [...new Set(fiches.map((m) => m.exists && m.get('email')).filter(Boolean).map((e) => String(e).toLowerCase()))];
  logger.warn(`Famille ${fid} : ${sos ? 'SOS' : 'appel'} de la tablette sans aucun téléphone joignable, ${emails.length} e-mail(s)`);
  const contenu = mail.appelSansTelephone({ nom, sos, lien: APPLI });
  const envois = emails.map((a) => mail.envoyer({
    smtp: MAIL_SMTP.value(), expediteur: MAIL_EXPEDITEUR.value(), motDePasse: MAIL_MOT_DE_PASSE.value(), a, contenu,
  }));
  (await Promise.allSettled(envois)).filter((r) => r.status === 'rejected')
    .forEach((r) => logger.error(`Famille ${fid} : e-mail « aucun téléphone n'a sonné » non parti`, r.reason));
}

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

// Bouton SOS de la tablette : toute la famille, calleeName 'SOS' (1er essai) ou 'SOS 2' (2e essai).
// Pas de champ à part : les règles Firestore des appels restent les mêmes.
function essaiSos(appel) {
  if (appel.calleeUid) return 0;
  if (appel.calleeName === 'SOS') return 1;
  return appel.calleeName === 'SOS 2' ? 2 : 0;
}

// Une notification web ne sonne qu'une fois : on la renvoie toutes les 12 s tant que la tablette
// sonne (même étiquette, « renotify » refait sonner et vibrer), comme une sonnerie qui insiste.
const REPRISES = 4;
const INTERVALLE_MS = 12_000;
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

exports.appelsSonnerie = onDocumentCreated({ document: DOC, region: REGION_FIRESTORE, database: BASE_FIRESTORE, timeoutSeconds: 90, secrets: [MAIL_MOT_DE_PASSE] }, async (event) => {
  const appel = event.data.data();
  if (!appel || appel.state !== 'ringing') return;
  const db = base();
  const { fid, cid } = event.params;
  const uids = await destinataires(db, fid, appel);
  if (!uids.length) return;
  // Jeton d'appel : seul un téléphone qui a reçu la sonnerie peut refuser sans se connecter.
  const jeton = require('node:crypto').randomBytes(16).toString('hex');
  await event.data.ref.collection('prive').doc('refus').set({ jeton });
  const nom = String(appel.callerName || 'Mamie');
  const data = { type: 'appel', cid, fid, jeton, nom: essaiSos(appel) ? `SOS : ${nom}` : nom };
  const n = await envoyer(db, fid, uids, data, 45);
  logger.info(`Appel ${cid} : ${n} téléphone(s) prévenu(s)`);
  // Personne ne sonne : les proches le savent par e-mail, au 1er essai seulement (le 2e essai du SOS suit de près).
  if (n === 0 && essaiSos(appel) !== 2) await prevenirSansTelephone(db, fid, uids, { nom, sos: essaiSos(appel) > 0 });
  for (let i = 0; i < REPRISES; i++) {
    await attendre(INTERVALLE_MS);
    const cur = await event.data.ref.get();
    if (!cur.exists || cur.get('state') !== 'ringing') return;
    await envoyer(db, fid, uids, data, 20, { websSeulement: true });
  }
});

exports.appelsManques = onDocumentUpdated({ document: DOC, region: REGION_FIRESTORE, database: BASE_FIRESTORE, secrets: [MAIL_MOT_DE_PASSE] }, async (event) => {
  const avant = event.data.before.data();
  const apres = event.data.after.data();
  if (!avant || !apres || avant.state !== 'ringing' || apres.state === 'ringing') return;
  const db = base();
  const { fid, cid } = event.params;
  const uids = await destinataires(db, fid, apres);
  if (!uids.length) return;
  const sos = essaiSos(apres);
  const nom = String(apres.callerName || 'Mamie');
  if (sos && ['missed', 'declined'].includes(apres.state) && !apres.answer) {
    // 1er essai sans réponse : la tablette rappelle tout de suite, rien à dire. Au 2e, l'alerte.
    if (sos === 2) {
      const n = await envoyer(db, fid, uids, { type: 'alerte', titre: `${nom} a appuyé sur SOS`, texte: "Personne n'a pu répondre. Rappelez dès que possible." }, 24 * 3600);
      logger.warn(`SOS ${cid} : personne n'a répondu, famille alertée`);
      if (n === 0) await prevenirSansTelephone(db, fid, uids, { nom, sos: true });
    }
  } else if (['missed', 'ended', 'declined'].includes(apres.state) && !apres.answer) {
    await envoyer(db, fid, uids, { type: 'manque', cid, nom }, 24 * 3600);
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

// Plafond par compte et par jour : les comptes anonymes se créent librement, ce relevé ne doit pas
// pouvoir remplir la base. Au-delà, l'incident n'est plus que dans les journaux.
const INCIDENTS_PAR_JOUR = 50;

exports.incidentAppel = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Connexion requise.');
  const d = request.data || {};
  const jour = new Date(Date.now()).toISOString().slice(0, 10);
  const limite = base().doc(`limites/incidents-${request.auth.uid}`);
  const n = await base().runTransaction(async (t) => {
    const s = await t.get(limite);
    const deja = s.exists && s.get('jour') === jour ? s.get('n') : 0;
    if (deja < INCIDENTS_PAR_JOUR) t.set(limite, { jour, n: deja + 1 });
    return deja;
  });
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
  if (n >= INCIDENTS_PAR_JOUR) return { ok: true };
  await base().collection('incidentsAppels').add(incident);
  return { ok: true };
});
