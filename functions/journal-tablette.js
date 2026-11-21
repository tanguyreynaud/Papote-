// Journal de la tablette (families/{fid}/logs/{uid}) : la tablette n'envoie plus ses 200 dernières lignes à chaque fois
// (≈ 25 Ko sur la carte SIM toutes les 6 h), seulement les lignes nouvelles, ajoutées à la liste « ajouts » (Sync.java,
// uploadJournal ; Tanguy, 21/11). Ici, elles sont rangées à la suite de « lines », que lisent l'appli et l'admin, et
// seules les 300 dernières lignes sont gardées : la fiche ne grossit jamais. Une ancienne tablette écrit encore « lines »
// en entier, sans « ajouts » : rien à faire.

const { onDocumentWritten } = require('./base').declencheurs;
const { logger } = require('firebase-functions/v2');
const { FieldValue } = require('firebase-admin/firestore');
const { BASE_FIRESTORE, REGION_FIRESTORE, db: base } = require('./base');

const LIGNES_MAX = 300;
const TAILLE_MAX = 60000; // comme firestore.rules (lines.size() <= 60000)

// Lignes existantes + morceaux ajoutés -> texte gardé (les plus récentes en bas). Un morceau qui reprend les dernières
// lignes déjà là (tablette redémarrée, envoi refait) n'est pas recopié deux fois.
function fusionner(lines, ajouts) {
  let l = typeof lines === 'string' && lines ? lines.split('\n') : [];
  for (const a of ajouts || []) {
    if (typeof a !== 'string' || !a) continue;
    const n = a.split('\n');
    let commun = 0;
    for (let k = Math.min(l.length, n.length); k > 0; k--) {
      let pareil = true;
      for (let i = 0; i < k && pareil; i++) pareil = l[l.length - k + i] === n[i];
      if (pareil) { commun = k; break; }
    }
    l = l.concat(n.slice(commun));
  }
  if (l.length > LIGNES_MAX) l = l.slice(l.length - LIGNES_MAX);
  let texte = l.join('\n');
  while (texte.length > TAILLE_MAX && l.length > 1) { l = l.slice(1); texte = l.join('\n'); }
  return texte.length > TAILLE_MAX ? texte.slice(texte.length - TAILLE_MAX) : texte;
}

exports.journalTablette = onDocumentWritten(
  { document: 'families/{fid}/logs/{uid}', region: REGION_FIRESTORE, database: BASE_FIRESTORE, maxInstances: 5 },
  async (event) => {
    const apres = event.data && event.data.after;
    if (!apres || !apres.exists) return;
    const ajouts = apres.get('ajouts');
    if (!Array.isArray(ajouts) || !ajouts.length) return;
    const db = base();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(apres.ref);
      const lus = snap.exists ? snap.get('ajouts') : null;
      if (!Array.isArray(lus) || !lus.length) return;
      // arrayRemove des morceaux lus seulement : un morceau arrivé entre-temps reste pour le tour suivant.
      tx.update(apres.ref, { lines: fusionner(snap.get('lines'), lus), ajouts: FieldValue.arrayRemove(...lus) });
    });
    logger.info('Journal de la tablette rangé', { fid: event.params.fid, morceaux: ajouts.length });
  },
);

exports._test = { fusionner, LIGNES_MAX, TAILLE_MAX };
