// Notifications push vers les téléphones de la famille (appels de la tablette, alertes).
// Jetons : families/{fid}/members/{uid}/private/push = { tokens: [...] }, écrits par web/js/push.js.
// Messages « data » seulement : web/sw.js les affiche.

const admin = require('firebase-admin');

// Envoie `data` à tous les téléphones des membres `uids`. Renvoie le nombre de téléphones atteints.
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

module.exports = { envoyer };
