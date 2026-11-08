// Tablette volée ou perdue : couper son identité Firebase en un seul geste (admin seulement).
// Audit reprise après sinistre (5/11) : aujourd'hui il faut 3 gestes séparés (ordre « Verrouiller » dans l'admin,
// Stock > « Perdue », puis cle-tablette.bat --retirer sur le PC de Tanguy) et les deux comptes Firebase de la tablette
// restent actifs : avec l'e-mail et le mot de passe gardés dans la tablette, ils se reconnectent quand on veut.
//
// Ordre des étapes (il compte) :
//   1. ordre « verrouiller » (ou « usine » si effacer) visant le compte de la tablette, AVANT de la sortir de la famille :
//      la tablette lit ses ordres par target == son uid, même hors famille (firestore.rules, match /commands) ;
//      l'ordre porte `revoquer: true` : quand la tablette répond, apresOrdre() désactive son compte.
//   2. fiches membre (tablette + appels) supprimées : plus de lecture des photos, messages, e-mails et téléphones.
//   3. compte des appels désactivé tout de suite (il ne sert qu'à la visio) ; jetons des deux comptes révoqués.
//      Révoquer seul ne suffit pas : la tablette garde son mot de passe (Firebase.java token()) et se reconnecte.
//   4. clés App Check de ce n° de série supprimées (plus de jeton App Check).
//   5. compte de la tablette : désactivé tout de suite si couperTout (l'ordre ne pourra alors plus être lu),
//      sinon dès que l'ordre est exécuté (apresOrdre), ou à la main.
//   6. fiche stock : état « perdue », famille et comptes oubliés (comme gestionStock).
// Réversible : réactiver les comptes (console Firebase > Authentication) ne remet pas la tablette dans la famille ;
// une tablette retrouvée se remet à zéro et se rejumelle (installer-tablette.ps1).
//
// Ce module ne dépend pas de firebase-functions : tout est injecté (testé dans tablette-volee.test.js).

const SERIE_MIN = 4;

function verifierParams(p) {
  const serie = typeof (p && p.serie) === 'string' ? p.serie.trim() : '';
  if (serie.length < SERIE_MIN) return { erreur: 'N° de série manquant (4 caractères au moins).' };
  return { serie, effacer: p.effacer === true, couperTout: p.couperTout === true };
}

// Ce qu'il faut faire pour cette fiche stock (pure).
function planRevocation(fiche, { effacer, couperTout }) {
  const plan = { ordre: null, membres: [], desactiver: [], revoquer: [], fid: fiche.fid || null };
  const uids = [fiche.tabletUid, fiche.callsUid].filter(Boolean);
  plan.revoquer = uids;
  if (fiche.fid && fiche.tabletUid) {
    plan.ordre = { type: effacer ? 'usine' : 'verrouiller', target: fiche.tabletUid };
  }
  if (fiche.fid) plan.membres = uids.map((uid) => `families/${fiche.fid}/members/${uid}`);
  if (fiche.callsUid) plan.desactiver.push(fiche.callsUid);
  // Sans ordre possible (tablette déjà sortie de sa famille), rien n'attend : on coupe tout de suite.
  if (fiche.tabletUid && (couperTout || !plan.ordre)) plan.desactiver.push(fiche.tabletUid);
  return plan;
}

// deps : { db, auth, maintenant: () => ms, qui, supprimerChamp: () => FieldValue.delete(),
//          ajouterHistorique: (x) => FieldValue.arrayUnion(x), horodatage: () => FieldValue.serverTimestamp() }
async function revoquer(deps, params) {
  const p = verifierParams(params);
  if (p.erreur) return { ok: false, erreur: p.erreur };
  const { db, auth } = deps;
  const trouve = await db.collection('stock').where('serieAndroid', '==', p.serie).limit(1).get();
  const doc = trouve.docs[0];
  if (!doc) return { ok: false, erreur: `Aucune tablette du stock avec le n° de série ${p.serie}.` };
  const fiche = doc.data();
  const plan = planRevocation(fiche, p);
  const fait = { ordre: null, membres: 0, desactives: [], revoques: [], cles: 0, erreurs: [] };

  if (plan.ordre) {
    const ref = db.collection(`families/${plan.fid}/commands`).doc();
    await ref.set({
      ...plan.ordre, serie: p.serie, state: 'pending', createdBy: deps.qui || 'admin',
      createdAt: deps.horodatage(), revoquer: true,
    });
    fait.ordre = ref.path;
  }
  for (const chemin of plan.membres) {
    await db.doc(chemin).delete();
    fait.membres += 1;
  }
  // Une erreur d'Auth (compte déjà supprimé) ne doit pas empêcher le reste.
  for (const uid of plan.desactiver) {
    try { await auth.updateUser(uid, { disabled: true }); fait.desactives.push(uid); } catch (e) { fait.erreurs.push(`${uid} : ${e.message}`); }
  }
  for (const uid of plan.revoquer) {
    try { await auth.revokeRefreshTokens(uid); fait.revoques.push(uid); } catch (e) { fait.erreurs.push(`${uid} : ${e.message}`); }
  }
  const cles = await db.collection('clesTablettes').where('serie', '==', p.serie).get();
  for (const c of cles.docs) { await c.ref.delete(); fait.cles += 1; }

  const maj = {
    fid: null, tabletUid: null, callsUid: null, jumeleeLe: deps.supprimerChamp(),
    revocation: { le: deps.maintenant(), par: deps.qui || 'admin', fid: plan.fid, tabletUid: fiche.tabletUid || null,
      callsUid: fiche.callsUid || null, ordre: fait.ordre },
  };
  if (fiche.etat !== 'perdue') {
    maj.etat = 'perdue';
    maj.historique = deps.ajouterHistorique({ le: deps.maintenant(), etat: 'perdue', par: deps.qui || 'admin', motif: 'volée ou perdue (révocation)' });
  }
  await doc.ref.update(maj);
  return { ok: true, ...fait, attente: plan.ordre && !p.couperTout
    ? 'Le compte de la tablette sera désactivé dès qu\'elle aura exécuté l\'ordre (ou à la main dans la console).'
    : null };
}

// Déclencheur sur families/{fid}/commands/{id} : l'ordre de révocation est exécuté (ou refusé) → compte désactivé.
// Renvoie l'uid à désactiver, ou null (pure).
function apresOrdre(avant, apres) {
  if (!apres || apres.revoquer !== true || !apres.target) return null;
  if (avant && ['done', 'failed'].includes(avant.state)) return null;
  return ['done', 'failed'].includes(apres.state) ? apres.target : null;
}

module.exports = { verifierParams, planRevocation, revoquer, apresOrdre };
