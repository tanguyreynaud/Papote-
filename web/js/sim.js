// Cartes SIM vues par les tablettes (members/{uid}.sim = { iccid, operateur, reseau, signal, dataMoisMo, vuLe }),
// gardées par famille pour la page d'une carte SIM (gestion.js). Les contrats (opérateur, prix, promo…) sont
// dans le registre « Cartes SIM » de l'onglet Stock.
import { operateurParFrequence } from './frequences.js';

// Blocages à demander à l'opérateur sur chaque carte SIM avant son départ (Tanguy, 11/11) : même liste que
// functions/statuts.js (BLOCAGES_SIM). Notés sur la carte (sims/{id}.blocages), cochés une fois pour toutes.
export const BLOCAGES_SIM = [
  ['surtaxes', 'appels vers les numéros surtaxés'],
  ['smsPlus', 'SMS+'],
  ['internetPlus', 'achats sur facture (Internet+)'],
  ['etranger', 'appels et SMS vers l\'étranger'],
];
export const blocagesFaits = (l) => !!l && BLOCAGES_SIM.every(([k]) => l.blocages && l.blocages[k] === true);

const DATA_MAX_MO = 15 * 1024;
const toDate = (v) => (v && v.toDate ? v.toDate() : v ? new Date(v) : null);
export const go = (mo) => (mo == null || mo < 0 ? null : mo >= 1024 ? `${(mo / 1024).toFixed(1)} Go` : `${Math.round(mo)} Mo`);

let parFamille = new Map();

/** Appelé par le tableau de bord avec les familles et les fiches tablette déjà lues. */
export function refreshSim(families, tablets) {
  parFamille = new Map(families.map((f) => {
    const liste = tablets[f.id] || [];
    const membre = liste.filter((t) => t.sim).sort((a, b) => (toDate(b.sim.vuLe) || 0) - (toDate(a.sim.vuLe) || 0))[0] || null;
    const sim = membre?.sim || null;
    const vue = liste.map((t) => toDate(t.lastOnline)).filter(Boolean).sort((a, b) => b - a)[0] || null;
    const alertes = [];
    if (sim?.dataMoisMo > DATA_MAX_MO) alertes.push(`Data du mois élevée : ${go(sim.dataMoisMo)}`);
    if (['suspendu', 'resilie'].includes(f.abonnement?.statut) && sim?.dataMoisMo > 0) {
      alertes.push('Abonnement arrêté mais la ligne consomme encore : la suspendre chez l\'opérateur');
    }
    const reseau = reseauMobile(sim);
    const reseauVu = membre?.reseauVu || null;
    if (reseauAVoir(reseau, reseauVu)) alertes.push(reseau.alerte);
    return [f.id, { sim, vue, alertes, vuLe: toDate(sim?.vuLe), reseau, reseauVu, membreId: membre?.membreId || null }];
  }));
  document.dispatchEvent(new CustomEvent('papote:sim'));
}

/** Après « Vu » sur l'alerte réseau d'une famille (gestion.js a écrit reseauVu sur la fiche de la tablette). */
export function noterReseauVu(fid, reseauVu) {
  const v = parFamille.get(fid);
  if (!v) return;
  v.reseauVu = reseauVu;
  v.alertes = v.alertes.filter((a) => a !== v.reseau?.alerte || reseauAVoir(v.reseau, reseauVu));
  document.dispatchEvent(new CustomEvent('papote:sim'));
}

/** Texte de l'alerte réseau d'une famille s'il faut la montrer (pas vue, ou pire que ce qui a été vu), sinon null. */
export const alerteReseau = (v) => (v && reseauAVoir(v.reseau, v.reseauVu) ? v.reseau.alerte : null);

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
const INCONNU = 'opérateur inconnu';
const FAIBLE_DBM = -110;
const SERVICES = { ok: 'en service', urgences: 'urgences seulement', 'hors service': 'hors service', eteint: 'réseau mobile coupé' };
// Carte bloquée par un code (tablette 2bfc17b : sim = { bloquee: 'pin' | 'puk' | 'verrouillee', service: 'code …', vuLe }).
// Le serveur prévient Tanguy (functions/sim-hors-service.js) ; ici, les mêmes mots sur la page de la tablette.
export const BLOQUEE = { pin: 'code PIN demandé', puk: 'code PUK demandé', verrouillee: 'verrouillée' };
export const texteBloquee = (sim) => (sim && sim.bloquee ? `Carte SIM bloquée : ${BLOQUEE[sim.bloquee] || 'à vérifier'}` : null);

/**
 * { service, antennes: [{ operateur, texte, utilisee }], alerte, niveau, dbm } ou null si la tablette n'envoie pas encore
 * ces relevés. niveau : gravité de l'alerte (0 rien, 1 réseau faible, 2 seulement 2G/3G, 3 sans réseau utilisable) ;
 * dbm : signal de l'antenne utilisée. L'opérateur d'une antenne : son code MCC/MNC (antenne utilisée), sinon sa
 * fréquence (frequences.js, antennes voisines, tablettes qui envoient earfcn…), sinon le nom donné par Android.
 */
export function reseauMobile(sim) {
  if (!sim || (sim.service == null && !Array.isArray(sim.antennes))) return null;
  const antennes = (Array.isArray(sim.antennes) ? sim.antennes : []).filter((a) => a && typeof a === 'object').map((a) => {
    const operateur = operateurDe(a.reseau) || operateurParFrequence(a) || a.nom || a.reseau || INCONNU;
    const bande = a.bande > 0 ? ` bande ${a.bande}` : '';
    const dbm = a.dbm < 0 ? a.dbm : null;
    return { operateur, type: a.type || '', dbm, utilisee: a.utilisee === true,
      texte: `${operateur} ${a.type || ''}${bande}${dbm != null ? `, ${dbm} dBm` : ''}`.replace(/\s+/g, ' ').trim() };
  });
  const utilisee = antennes.find((a) => a.utilisee);
  // Meilleure antenne d'un autre opérateur, pour dire lequel capte mieux ici.
  // Une antenne d'opérateur inconnu peut être celle du même opérateur : elle ne sert pas de comparaison.
  const autre = antennes.filter((a) => a.dbm != null && a.operateur !== INCONNU && (!utilisee || a.operateur !== utilisee.operateur))
    .sort((a, b) => b.dbm - a.dbm)[0];
  const mieux = autre ? ` (${autre.operateur} capte ici à ${autre.dbm} dBm)` : '';
  let alerte = null;
  let niveau = 0;
  if (sim.bloquee) { alerte = texteBloquee(sim); niveau = 3; }
  else if (sim.service === 'urgences') { alerte = `Aucune antenne de l'opérateur de la carte chez le client${mieux} : changer de carte SIM`; niveau = 3; }
  else if (sim.service === 'hors service') { alerte = `Tablette sans réseau mobile${mieux}`; niveau = 3; }
  else if (sim.service === 'eteint') { alerte = 'Réseau mobile coupé sur la tablette (mode avion ?)'; niveau = 3; }
  else if (utilisee && ['2G', '3G'].includes(utilisee.type)) { alerte = `Seulement en ${utilisee.type} chez le client : appels vidéo difficiles${mieux}`; niveau = 2; }
  else if (utilisee && utilisee.dbm != null && utilisee.dbm < FAIBLE_DBM) {
    alerte = `Réseau faible chez le client (${utilisee.operateur}, ${utilisee.dbm} dBm)${autre && autre.dbm >= utilisee.dbm + 10 ? mieux : ''}`;
    niveau = 1;
  }
  const service = sim.bloquee ? `bloquée (${BLOQUEE[sim.bloquee] || 'à vérifier'})` : SERVICES[sim.service] || null;
  return { service, bloquee: sim.bloquee || null, antennes, alerte, niveau, dbm: utilisee ? utilisee.dbm : null };
}

// « Vu » sur l'alerte réseau (Tanguy, 08/11 : « Réseau faible » restait affiché alors qu'il n'y peut parfois rien).
// Vue, l'alerte quitte la liste et le compteur ; elle ne revient que si c'est pire que ce qui a été vu : plus grave
// (faible → 2G/3G → sans réseau) ou signal de l'antenne utilisée 10 dB plus bas. Jamais au bout d'un délai.
const ECART_DBM = 10;

/** Ce qu'on garde de l'alerte au moment du « Vu » (champ reseauVu de la fiche de la tablette). */
export const reseauVuDe = (r, le = Date.now()) => ({ niveau: r ? r.niveau : 0, dbm: r && r.dbm != null ? r.dbm : null, le });

/** true s'il faut montrer l'alerte r : pas encore vue, ou pire que ce qui a été vu (vu = { niveau, dbm }). */
export function reseauAVoir(r, vu) {
  if (!r || !r.alerte) return false;
  if (!vu || !(vu.niveau > 0)) return true;
  if (r.niveau > vu.niveau) return true;
  return r.dbm != null && typeof vu.dbm === 'number' && r.dbm <= vu.dbm - ECART_DBM;
}
