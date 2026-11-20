// « Je m'en occupe » pendant un SOS (Tanguy, 20/11 : un seul message de fin par SOS, « jamais plus d'un de ces
// messages »). Un proche le touche dans l'app famille ; le premier gagne, les autres apprennent qui s'en occupe.
//
//   La tablette signale son SOS sur sa fiche : families/{fid}/members/{uidTablette}.sos = { debut (ms), fin, uid, nom },
//   fin vide tant qu'il court, puis 'repondu', 'arrete' ou 'pris' (android/…/tablette.js, sosSignaler ; Sync.signalerSos).
//   Ici, dans une transaction : families/{fid}.sosPris = { uid, nom, le (heure du serveur), debut } seulement si
//     - l'appelant est un proche actif de la famille (pas en attente, pas la tablette) ;
//     - une tablette de la famille a ce SOS (même debut) et il court encore (fin vide, moins de 32 min) ;
//     - personne ne l'a déjà pris : un sosPris d'un SOS d'avant (autre debut) ne bloque pas le nouveau.
//   Le serveur n'envoie RIEN (ni notification, ni e-mail) : le changement de la fiche famille réveille la tablette
//   (reveil.js, reveilFamille), qui lit sosPris (Sync.java, SosPris.lire : uid, nom, le) et envoie elle-même le SMS
//   aux autres proches. debut, en plus, sert seulement ici et à l'app famille (quel SOS a été pris).
//
// Ce module ne dépend pas de firebase-functions : tout est injecté (testé dans sos-pris.test.js).

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SOS_DUREE_MS = 30 * 60_000;
// Horloges de la tablette et du serveur pas tout à fait d'accord (même marge que tablette.js, SOS_PRIS_AVANCE_MS).
const MARGE_MS = 2 * 60_000;

const dejaPris = (nom) => `${nom || 'Un proche'} s'en occupe déjà.`;

// deps : { db, horodatage: () => FieldValue.serverTimestamp(), maintenant: () => ms }
// Renvoie { ok: true, nom } ; { ok: false, raison, message, … } quand le SOS est déjà pris ou fini ;
// { erreur, code } pour une demande impossible (code d'HttpsError).
async function prendre(deps, uid, data) {
  const fid = data && data.fid;
  const debut = data && data.debut;
  if (!uid) return { code: 'unauthenticated', erreur: 'Connexion requise.' };
  if (typeof fid !== 'string' || !ID.test(fid) || !Number.isSafeInteger(debut) || debut <= 0) {
    return { code: 'invalid-argument', erreur: 'SOS inconnu.' };
  }
  const { db } = deps;
  const famRef = db.doc(`families/${fid}`);
  const moiRef = db.doc(`families/${fid}/members/${uid}`);
  const tablettes = db.collection(`families/${fid}/members`).where('role', '==', 'tablette');
  return db.runTransaction(async (t) => {
    const [fam, moi, tabs] = await Promise.all([t.get(famRef), t.get(moiRef), t.get(tablettes)]);
    if (!fam.exists || !moi.exists || moi.get('status') === 'pending' || moi.get('role') === 'tablette') {
      return { code: 'permission-denied', erreur: 'Réservé aux proches de la famille.' };
    }
    const sos = tabs.docs.map((d) => d.get('sos')).find((s) => s && s.debut === debut);
    if (!sos) return { ok: false, raison: 'inconnu', message: 'Ce SOS est terminé.' };
    const pris = fam.get('sosPris');
    if (pris && pris.debut === debut) {
      if (pris.uid === uid) return { ok: true, nom: pris.nom || '' }; // double appui, ou deuxième téléphone : déjà à moi
      return { ok: false, raison: 'deja', uid: pris.uid || '', nom: pris.nom || '', message: dejaPris(pris.nom) };
    }
    if (sos.fin) return { ok: false, raison: 'fini', fin: sos.fin, uid: sos.uid || '', nom: sos.nom || '', message: 'Ce SOS est terminé.' };
    if (deps.maintenant() - debut > SOS_DUREE_MS + MARGE_MS) return { ok: false, raison: 'fini', fin: '', message: 'Ce SOS est terminé.' };
    const nom = String(moi.get('name') || '').slice(0, 40);
    t.update(famRef, { sosPris: { uid, nom, le: deps.horodatage(), debut } });
    return { ok: true, nom };
  });
}

module.exports = { prendre, SOS_DUREE_MS, MARGE_MS };
