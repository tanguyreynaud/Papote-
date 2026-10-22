// Cartes SIM vues par les tablettes (members/{uid}.sim = { iccid, operateur, reseau, signal, dataMoisMo, vuLe }),
// gardées par famille pour la page d'une carte SIM (gestion.js). Les contrats (opérateur, prix, promo…) sont
// dans le registre « Cartes SIM » de l'onglet Stock.
const DATA_MAX_MO = 15 * 1024;
const toDate = (v) => (v && v.toDate ? v.toDate() : v ? new Date(v) : null);
export const go = (mo) => (mo == null || mo < 0 ? null : mo >= 1024 ? `${(mo / 1024).toFixed(1)} Go` : `${Math.round(mo)} Mo`);

let parFamille = new Map();

/** Appelé par le tableau de bord avec les familles et les fiches tablette déjà lues. */
export function refreshSim(families, tablets) {
  parFamille = new Map(families.map((f) => {
    const liste = tablets[f.id] || [];
    const sim = liste.filter((t) => t.sim).sort((a, b) => (toDate(b.sim.vuLe) || 0) - (toDate(a.sim.vuLe) || 0))[0]?.sim || null;
    const vue = liste.map((t) => toDate(t.lastOnline)).filter(Boolean).sort((a, b) => b - a)[0] || null;
    const alertes = [];
    if (sim?.dataMoisMo > DATA_MAX_MO) alertes.push(`Data du mois élevée : ${go(sim.dataMoisMo)}`);
    if (['suspendu', 'resilie'].includes(f.abonnement?.statut) && sim?.dataMoisMo > 0) {
      alertes.push('Abonnement arrêté mais la ligne consomme encore : la suspendre chez l\'opérateur');
    }
    return [f.id, { sim, vue, alertes, vuLe: toDate(sim?.vuLe) }];
  }));
}

/** Ce que la tablette de la famille dit de sa carte (null si rien de remonté). */
export const simVue = (fid) => {
  const v = fid && parFamille.get(fid);
  return v && v.sim ? v : null;
};
