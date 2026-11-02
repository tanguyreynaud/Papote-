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
    const reseau = reseauMobile(sim);
    if (reseau && reseau.alerte) alertes.push(reseau.alerte);
    return [f.id, { sim, vue, alertes, vuLe: toDate(sim?.vuLe) }];
  }));
  document.dispatchEvent(new CustomEvent('papote:sim'));
}

/** Ce que la tablette de la famille dit de sa carte (null si rien de remonté). */
export const simVue = (fid) => {
  const v = fid && parFamille.get(fid);
  return v && v.sim ? v : null;
};

// Réseau mobile chez le client (tablette 2.99.105 et plus : sim.service, sim.simReseau, sim.antennes) : ce que la
// tablette entend, et une alerte si la carte n'a pas de réseau ou un réseau faible (Poissy, 01/11 : SIM Lyca, seulement
// des antennes Orange). Le réseau se lit sur l'antenne utilisée, pas sur le nom de la carte (Lyca, Sosh… sont sur le
// réseau d'un autre).
const RESEAUX = {
  Orange: ['20801', '20802'], SFR: ['20809', '20810', '20811', '20813'], Free: ['20815', '20816'], Bouygues: ['20820', '20821', '20888'],
};
const operateurDe = (code) => Object.keys(RESEAUX).find((n) => RESEAUX[n].includes(String(code || ''))) || null;
const FAIBLE_DBM = -110;
const SERVICES = { ok: 'en service', urgences: 'urgences seulement', 'hors service': 'hors service', eteint: 'réseau mobile coupé' };

/** { service, antennes: [{ operateur, texte, utilisee }], alerte } ou null si la tablette n'envoie pas encore ces relevés. */
export function reseauMobile(sim) {
  if (!sim || (sim.service == null && !Array.isArray(sim.antennes))) return null;
  const antennes = (Array.isArray(sim.antennes) ? sim.antennes : []).map((a) => {
    const operateur = operateurDe(a.reseau) || a.nom || a.reseau || 'opérateur inconnu';
    const bande = a.bande > 0 ? ` bande ${a.bande}` : '';
    const dbm = a.dbm < 0 ? a.dbm : null;
    return { operateur, type: a.type || '', dbm, utilisee: a.utilisee === true,
      texte: `${operateur} ${a.type || ''}${bande}${dbm != null ? `, ${dbm} dBm` : ''}`.replace(/\s+/g, ' ').trim() };
  });
  const utilisee = antennes.find((a) => a.utilisee);
  // Meilleure antenne d'un autre opérateur, pour dire lequel capte mieux ici.
  const autre = antennes.filter((a) => a.dbm != null && (!utilisee || a.operateur !== utilisee.operateur))
    .sort((a, b) => b.dbm - a.dbm)[0];
  const mieux = autre ? ` (${autre.operateur} capte ici à ${autre.dbm} dBm)` : '';
  let alerte = null;
  if (sim.service === 'urgences') alerte = `Aucune antenne de l'opérateur de la carte chez le client${mieux} : changer de carte SIM`;
  else if (sim.service === 'hors service') alerte = `Tablette sans réseau mobile${mieux}`;
  else if (sim.service === 'eteint') alerte = 'Réseau mobile coupé sur la tablette (mode avion ?)';
  else if (utilisee && ['2G', '3G'].includes(utilisee.type)) alerte = `Seulement en ${utilisee.type} chez le client : appels vidéo difficiles${mieux}`;
  else if (utilisee && utilisee.dbm != null && utilisee.dbm < FAIBLE_DBM) {
    alerte = `Réseau faible chez le client (${utilisee.operateur}, ${utilisee.dbm} dBm)${autre && autre.dbm >= utilisee.dbm + 10 ? mieux : ''}`;
  }
  return { service: SERVICES[sim.service] || null, antennes, alerte };
}
