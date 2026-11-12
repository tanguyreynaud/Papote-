// Fiches des tablettes : le serveur y écrit leur uid (règles 2, R3, Tanguy 12/11).
// Le relais des appels vidéo (turn-worker, côté appli) n'est donné qu'aux membres d'une famille. Il le vérifie avec
// le jeton de l'appli elle-même, par la requête « mes familles » (fiches membres qui portent mon uid). Les proches
// ont ce champ depuis toujours ; les tablettes (APK 2.99.64 et avant) ne l'écrivent pas : on le leur ajoute ici.
// Appelé à chaque écriture d'une fiche membre (compterProches, index.js) : rien à faire dans presque tous les cas.
// Quand une fiche de tablette n'a pas son uid, les autres tablettes de la famille sont rattrapées en même temps (le
// compte des appels de la tablette n'écrit presque jamais sa fiche : il est rattrapé avec la fiche principale,
// qui est écrite toutes les 10 minutes).

// Renvoie true si la fiche écrite est une tablette sans son uid.
function aRattraper(apres, uid) {
  return Boolean(apres && apres.role === 'tablette' && apres.uid !== uid);
}

// db : Firestore admin ; fid, uid : la fiche écrite ; apres : ses données après l'écriture (ou null si effacée).
// Renvoie le nombre de fiches corrigées.
async function uidDesTablettes(db, fid, uid, apres) {
  if (!aRattraper(apres, uid)) return 0;
  const tablettes = await db.collection(`families/${fid}/members`).where('role', '==', 'tablette').get();
  let n = 0;
  for (const d of tablettes.docs) {
    if (d.get('uid') === d.id) continue;
    try {
      await d.ref.update({ uid: d.id });
      n++;
    } catch (e) {
      // Fiche effacée entre-temps (tablette retirée) : rien à corriger.
      if (e.code !== 5) throw e;
    }
  }
  return n;
}

module.exports = { uidDesTablettes, regles: { aRattraper } };
