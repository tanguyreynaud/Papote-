// Notifications push vers les téléphones de la famille (appels de la tablette, alertes).
// Jetons : families/{fid}/members/{uid}/private/push = { tokens: [...], natifs: [...] }
//   tokens  navigateurs (app famille web), écrits par web/js/push.js ; web/sw.js affiche les messages
//   natifs  app Android Papote (telephone/), qui sonne comme un vrai appel ; jeton transmis à
//           l'app famille au lancement (?natif=…) puis rangé par web/js/push.js
// Messages « data » seulement, en priorité haute : un téléphone Android en veille les reçoit tout de suite.

const admin = require('firebase-admin');

// Jeton de l'app Android : cru seulement s'il a été rangé par une app famille qui vérifie qu'il
// vient bien de l'app (natifsV >= 2, web/js/push.js). Avant, un simple lien ?natif=<jeton d'un
// autre> pouvait en ranger un : sonneries et jeton de connexion (appels.js) partaient chez lui.
// Un jeton plus ancien est ignoré (le proche est prévenu par ses navigateurs, sinon par e-mail)
// jusqu'à la prochaine ouverture de l'app Android, qui le range à nouveau.
const natifsFiables = (d) => ((Number(d.get('natifsV')) || 0) >= 2 ? d.get('natifs') || [] : []);

// Envoie `data` à tous les téléphones des membres `uids`. Renvoie le nombre de téléphones atteints.
// `natifsSeulement` : messages que seule l'app Android comprend (« fin » d'un appel).
// `websSeulement` : renvois de la sonnerie, inutiles à l'app Android qui sonne déjà en boucle.
// Chaque proche est prévenu soit par l'app Android (s'il l'a), soit par ses navigateurs.
async function envoyer(db, fid, uids, data, ttlSecondes, { natifsSeulement = false, websSeulement = false } = {}) {
  const refs = uids.map((uid) => db.doc(`families/${fid}/members/${uid}/private/push`));
  const docs = refs.length ? await db.getAll(...refs) : [];
  const jetonsDe = (i, champ) => (champ === 'natifs' ? natifsFiables(docs[i]) : docs[i].get(champ) || [])
    .map((t) => ({ t, ref: refs[i], champ, i }));
  const jetons = [];
  docs.forEach((d, i) => {
    // Un proche qui a l'app Android est prévenu par elle seule : ses jetons de navigateur (souvent
    // le même téléphone) feraient sonner une deuxième fois.
    const natif = natifsFiables(d).length > 0;
    const champs = natif ? (websSeulement ? [] : ['natifs']) : (natifsSeulement ? [] : ['tokens']);
    champs.forEach((champ) => jetons.push(...jetonsDe(i, champ)));
  });
  const reussis = await pousser(jetons, data, ttlSecondes);
  let n = reussis.filter(Boolean).length;
  // App Android désinstallée ou réinstallée (jeton périmé) : on se rabat sur les navigateurs.
  if (!natifsSeulement) {
    // Seulement les proches prévenus par l'app : un proche sans app a déjà eu ses jetons de navigateur.
    const echoues = new Set(jetons.filter((j) => j.champ === 'natifs').map((j) => j.i));
    jetons.forEach((j, k) => { if (reussis[k]) echoues.delete(j.i); });
    const secours = [...echoues].flatMap((i) => jetonsDe(i, 'tokens'));
    n += (await pousser(secours, data, ttlSecondes)).filter(Boolean).length;
  }
  return n;
}

// Envoie à ces jetons ; oublie les jetons périmés. Renvoie, pour chaque jeton, s'il a été accepté.
async function pousser(jetons, data, ttlSecondes) {
  if (!jetons.length) return [];
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
  return res.responses.map((r) => r.success);
}

module.exports = { envoyer, natifsFiables };
