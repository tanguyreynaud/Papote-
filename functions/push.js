// Notifications push vers les téléphones de la famille (appels de la tablette, alertes).
// Jetons : families/{fid}/members/{uid}/private/push = { tokens: [...], natifs: [...] }
//   tokens  navigateurs (app famille web), écrits par web/js/push.js ; web/sw.js affiche les messages
//   natifs  app Android Papote (telephone/), qui sonne comme un vrai appel ; jeton transmis à
//           l'app famille au lancement (?natif=…) puis rangé par web/js/push.js
// Messages « data » seulement, en priorité haute : un téléphone Android en veille les reçoit tout de suite.

const admin = require('firebase-admin');

// Envoie `data` à tous les téléphones des membres `uids`. Renvoie le nombre de téléphones atteints.
// `natifsSeulement` : messages que seule l'app Android comprend (« fin » d'un appel).
// `websSeulement` : renvois de la sonnerie, inutiles à l'app Android qui sonne déjà en boucle.
async function envoyer(db, fid, uids, data, ttlSecondes, { natifsSeulement = false, websSeulement = false } = {}) {
  const refs = uids.map((uid) => db.doc(`families/${fid}/members/${uid}/private/push`));
  const docs = refs.length ? await db.getAll(...refs) : [];
  const jetons = [];
  docs.forEach((d, i) => {
    const champs = natifsSeulement ? ['natifs'] : websSeulement ? ['tokens'] : ['tokens', 'natifs'];
    champs.forEach((champ) => (d.get(champ) || []).forEach((t) => jetons.push({ t, ref: refs[i], champ })));
  });
  if (!jetons.length) return 0;
  const res = await admin.messaging().sendEachForMulticast({
    tokens: jetons.map((j) => j.t),
    data,
    android: { priority: 'high', ttl: ttlSecondes * 1000 },
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
  await Promise.all(perimes.map((j) => j.ref.update({ [j.champ]: admin.firestore.FieldValue.arrayRemove(j.t) }).catch(() => {})));
  return res.successCount;
}

module.exports = { envoyer };
