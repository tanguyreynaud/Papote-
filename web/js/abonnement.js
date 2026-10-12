// Abonnement de la famille : état écrit par le serveur dans families/{fid}.abonnement,
// paiement et portail Stripe par les fonctions serveur (europe-west1).
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';

const functions = getFunctions(getApp(), 'europe-west1');
const call = (name, data) => httpsCallable(functions, name)(data).then((r) => r.data);

export const OK_STATUTS = ['offert', 'actif', 'impaye'];

/** Envois, agenda et appels possibles ? (champ absent = famille d'avant les abonnements). */
export function abonnementOk(family) {
  const abo = family?.abonnement;
  return !abo || OK_STATUTS.includes(abo.statut);
}

// La tablette est toujours prêtée : 50 € de mise en service à la commande, puis l'abonnement.
export const FORMULES = [
  { formule: 'wifi', tablette: 'incluse', titre: 'Avec le Wi-Fi de la maison', prix: '20 € par mois' },
  { formule: 'sim', tablette: 'incluse', titre: 'Internet inclus', prix: '30 € par mois, sans box ni Wi-Fi' },
];

export const LIBELLES = {
  offert: 'Offert',
  actif: 'Actif',
  impaye: 'Paiement en retard',
  suspendu: 'En pause : paiement non réglé',
  resilie: 'Résilié',
  aucun: 'Pas encore d\'abonnement',
};

export async function ouvrirPortail(fid) {
  const { url } = await call('portailClient', { fid });
  location.href = url;
}

export async function payer(fid, formule, tablette) {
  const { url } = await call('creerPaiement', { fid, formule, tablette });
  location.href = url;
}

/** Relier une commande payée sur le site : par son code (« ABCD-EFGH »), sinon par l'e-mail du compte. */
export function rattacherCommande(fid, code) {
  const clean = (code || '').trim();
  return call('rattacherCommande', clean ? { fid, code: clean } : { fid });
}

/** Résilier : l'abonnement s'arrête à la date renvoyée ({ le }), après l'engagement. */
export function resilier(fid) {
  return call('resilierAbonnement', { fid });
}

/** Fin de contrat : délai de rétractation, tablette à rendre, remboursement (voir functions/). */
export function finDeContrat(fid) {
  return call('finDeContrat', { fid });
}

/** Annuler la commande (rétractation) : l'abonnement s'arrête tout de suite. */
export function retracter(fid) {
  return call('retracter', { fid });
}

export function annulerResiliation(fid) {
  return call('annulerResiliation', { fid });
}
