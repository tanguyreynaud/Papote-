// Un téléphone, un seul compte qui le fait sonner (bug Tanguy 2026-11 : un téléphone sonnait pour deux
// profils). Le jeton push d'un téléphone (navigateur ou app Android) est rangé dans
// families/{fid}/members/{uid}/private/push. Quand un autre compte se connecte sur ce même téléphone,
// son jeton est le même : sans ménage, l'ancien compte le garderait et ferait toujours sonner ce téléphone.
// L'appli retire le jeton à la déconnexion (web/js/famille.js) ; ce déclencheur rattrape les cas où elle
// n'a pas pu (hors ligne, app désinstallée, ancienne version) : chaque jeton AJOUTÉ à une fiche est
// retiré des fiches des AUTRES comptes (toutes familles). Un même compte dans deux familles garde le
// jeton dans les deux : c'est le même proche.
// Pas de boucle : le retrait réécrit l'autre fiche, mais n'y ajoute rien, donc rien à faire.
// Coût : une requête par jeton ajouté (connexion, réinstallation), rare.

const { FieldValue } = require('firebase-admin/firestore');

// Champs de jetons de téléphone (les jetons de tablette, champ « tablette », ne sont pas concernés).
const CHAMPS = ['tokens', 'natifs'];

const liste = (doc, champ) => (doc && Array.isArray(doc[champ]) ? doc[champ].filter((t) => typeof t === 'string' && t) : []);

/** Jetons présents après et absents avant : [{ champ, jeton }]. */
function jetonsAjoutes(avant, apres) {
  const res = [];
  for (const champ of CHAMPS) {
    const deja = new Set(liste(avant, champ));
    for (const jeton of new Set(liste(apres, champ))) if (!deja.has(jeton)) res.push({ champ, jeton });
  }
  return res;
}

const CHEMIN = /^families\/([^/]+)\/members\/([^/]+)\/private\/push$/;

/**
 * Fiches où retirer un jeton : celles d'un AUTRE uid que `uid`. `trouvees` : chemins des fiches qui
 * contiennent ce jeton (requête collectionGroup('private')). Renvoie les chemins à nettoyer.
 */
function fichesARetirer(uid, trouvees) {
  return [...new Set(trouvees)].filter((chemin) => {
    const m = CHEMIN.exec(chemin);
    return Boolean(m) && m[2] !== uid;
  });
}

// Fiches qui contiennent ce jeton, tous comptes, toutes familles. Noms de champs écrits en toutes lettres :
// index-firestore.test.js vérifie l'exemption de champ (array-contains sur un groupe de collections).
const chercher = {
  tokens: (db, jeton) => db.collectionGroup('private').where('tokens', 'array-contains', jeton),
  natifs: (db, jeton) => db.collectionGroup('private').where('natifs', 'array-contains', jeton),
};

/**
 * Retire des autres comptes chaque jeton ajouté à families/{fid}/members/{uid}/private/push.
 * Renvoie le nombre de retraits faits.
 */
async function retirerAilleurs(db, { uid, avant, apres }) {
  const ajoutes = jetonsAjoutes(avant, apres);
  let n = 0;
  for (const { champ, jeton } of ajoutes) {
    const snap = await chercher[champ](db, jeton).get();
    const chemins = fichesARetirer(uid, snap.docs.map((d) => d.ref.path));
    await Promise.all(chemins.map(async (chemin) => {
      try {
        await db.doc(chemin).update({ [champ]: FieldValue.arrayRemove(jeton) });
        n++;
      } catch (e) {
        if (e.code !== 5) throw e; // fiche effacée entre-temps
      }
    }));
  }
  return n;
}

module.exports = { jetonsAjoutes, fichesARetirer, retirerAilleurs, CHAMPS };
