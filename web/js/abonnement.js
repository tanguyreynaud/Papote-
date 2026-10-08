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

export const FORMULES = [
  { formule: 'wifi', tablette: 'achetee', titre: 'Wi-Fi, j\'achète la tablette', prix: '100 € une fois, puis 20 € par mois' },
  { formule: 'wifi', tablette: 'incluse', titre: 'Wi-Fi, tablette incluse', prix: '25 € par mois' },
  { formule: 'sim', tablette: 'achetee', titre: 'Carte SIM, j\'achète la tablette', prix: '100 € une fois, puis 30 € par mois' },
  { formule: 'sim', tablette: 'incluse', titre: 'Carte SIM, tablette incluse', prix: '35 € par mois' },
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

export function rattacherCommande(fid) {
  return call('rattacherCommande', { fid });
}
