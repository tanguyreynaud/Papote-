// Réveil des tablettes par notification push, à la place d'une écoute Firestore ouverte en permanence
// dans la page de la tablette (≈ 100 Mo par mois sur la carte SIM, mesuré le 28/10).
//
//   reveilAppel    un proche appelle (families/{fid}/calls créé par un téléphone) : { type: 'appel', id }
//   reveilOrdre    test du son demandé par le téléphone (commands créé) : { type: 'ordre', id }
//   reveilFamille  la fiche de la famille change (envoi, rappel, réglage…) : { type: 'famille' }
//   reveilVersion  nouvelle version publiée (config/version) : { type: 'version' } à toutes les tablettes
//
// Jetons des tablettes : families/{fid}/members/{uid}/private/push = { tablette: [jeton] }, écrits par
// l'app Android de la tablette (Sync.ecrireJetonPush). Messages « data » seulement, priorité haute :
// l'app Android (Push.java) réveille la page ou la synchronisation. Une tablette sans jeton (ancienne
// version, services Google absents) garde son écoute en direct : rien à envoyer, rien de perdu.

const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');

const { BASE_FIRESTORE, REGION_FIRESTORE, db: base } = require('./base');

const TOPIC = 'tablettes';
const OPTIONS = { region: REGION_FIRESTORE, database: BASE_FIRESTORE, maxInstances: 5 };

// Jetons push des tablettes de la famille : [{ t, ref }].
async function jetonsTablettes(db, fid) {
  const membres = await db.collection(`families/${fid}/members`).where('role', '==', 'tablette').get();
  if (membres.empty) return [];
  const refs = membres.docs.map((m) => db.doc(`families/${fid}/members/${m.id}/private/push`));
  const docs = await db.getAll(...refs);
  return docs.flatMap((d, i) => (d.exists ? (d.get('tablette') || []) : []).map((t) => ({ t, ref: refs[i] })));
}

// Envoie `data` aux tablettes de la famille ; oublie les jetons périmés. Renvoie le nombre atteint.
// `messagerie` : admin.messaging() (remplaçable dans les essais).
async function reveiller(db, fid, data, ttlSecondes = 60, messagerie = () => admin.messaging()) {
  const jetons = await jetonsTablettes(db, fid);
  if (!jetons.length) return 0;
  const res = await messagerie().sendEachForMulticast({
    tokens: jetons.map((j) => j.t),
    data,
    android: { priority: 'high', ttl: ttlSecondes * 1000, collapseKey: data.type },
  });
  const perimes = [];
  res.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
      perimes.push(jetons[i]);
    }
  });
  await Promise.all(perimes.map((j) => j.ref.update({ tablette: FieldValue.arrayRemove(j.t) }).catch(() => {})));
  return res.responses.filter((r) => r.success).length;
}

// Un proche appelle la tablette (pas la tablette qui appelle : ces appels-là font sonner les téléphones).
exports.reveilAppel = onDocumentCreated({ ...OPTIONS, document: 'families/{fid}/calls/{cid}' }, async (event) => {
  const appel = event.data && event.data.data();
  if (!appel || appel.state !== 'ringing' || !appel.callerUid) return;
  const db = base();
  const { fid, cid } = event.params;
  const appelant = await db.doc(`families/${fid}/members/${appel.callerUid}`).get();
  if (appelant.get('role') === 'tablette') return;
  const n = await reveiller(db, fid, { type: 'appel', id: cid });
  logger.info('Réveil appel', { fid, cid, tablettes: n });
});

// Ordre d'un téléphone (test du son à l'installation).
exports.reveilOrdre = onDocumentCreated({ ...OPTIONS, document: 'families/{fid}/commands/{id}' }, async (event) => {
  const ordre = event.data && event.data.data();
  if (!ordre || ordre.state !== 'pending') return;
  await reveiller(base(), event.params.fid, { type: 'ordre', id: event.params.id }, 120);
});

// La fiche de la famille a changé (rev à chaque envoi, rappels, réglages, abonnement, nom…) : la
// tablette fait un tour de synchronisation. Le message tient 10 min et les suivants le remplacent.
exports.reveilFamille = onDocumentUpdated({ ...OPTIONS, document: 'families/{fid}' }, async (event) => {
  if (!event.data || !aChange(event.data.before.data(), event.data.after.data())) return;
  await reveiller(base(), event.params.fid, { type: 'famille' }, 600);
});

// Champs de la famille sans intérêt pour la tablette (comptes tenus par le serveur).
const SANS_INTERET = new Set(['nbProches', 'updatedAt']);
function aChange(avant, apres) {
  const cles = new Set([...Object.keys(avant || {}), ...Object.keys(apres || {})]);
  for (const k of cles) {
    if (SANS_INTERET.has(k)) continue;
    if (JSON.stringify((avant || {})[k]) !== JSON.stringify((apres || {})[k])) return true;
  }
  return false;
}

// Nouvelle version publiée : toutes les tablettes (abonnées au sujet « tablettes » au démarrage).
exports.reveilVersion = onDocumentWritten({ ...OPTIONS, document: 'config/version' }, async () => {
  try {
    await admin.messaging().send({ topic: TOPIC, data: { type: 'version' }, android: { priority: 'high', ttl: 3600_000 } });
  } catch (e) {
    logger.warn('Réveil version', e && e.message);
  }
});

module.exports.jetonsTablettes = jetonsTablettes;
module.exports.reveiller = reveiller;
module.exports.aChange = aChange;
