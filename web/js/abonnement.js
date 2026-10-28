// Abonnement de la famille : état écrit par le serveur dans families/{fid}.abonnement,
// paiement et portail Stripe par les fonctions serveur (europe-west1).
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';

const functions = getFunctions(getApp(), 'europe-west1');
const call = (name, data) => httpsCallable(functions, name)(data).then((r) => r.data);

export const OK_STATUTS = ['offert', 'actif', 'impaye', 'installation'];

/** Envois, agenda et appels possibles ? (champ absent = famille d'avant les abonnements). */
export function abonnementOk(family) {
  const abo = family?.abonnement;
  // Installation en cours : rien n'est bloqué (la commande est reliée juste après).
  if (family?.installation && family.installation.etape !== 'fini') return true;
  return !abo || OK_STATUTS.includes(abo.statut);
}

// La tablette est toujours prêtée : 60 € de mise en service à la commande, puis l'abonnement.
export const FORMULES = [
  { formule: 'wifi', tablette: 'incluse', titre: 'Avec le Wi-Fi de la maison', prix: '20 € par mois' },
  { formule: 'sim', tablette: 'incluse', titre: 'Internet inclus', prix: '30 € par mois, sans box ni Wi-Fi' },
];

export const LIBELLES = {
  offert: 'Offert',
  installation: 'Installation en cours',
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

/** Résilier (sans engagement) : l'abonnement s'arrête à la date renvoyée ({ le }), fin du mois en cours, prélevé à l'arrêt. */
export function resilier(fid) {
  return call('resilierAbonnement', { fid });
}

/** Factures de la famille, les plus récentes d'abord : [{ id, numero, le, montant, statut: 'payee'|'a-payer', pdf, page }]. */
export async function facturesFamille(fid) {
  return (await call('facturesFamille', { fid }))?.factures || [];
}

/** Fin de contrat : délai de rétractation, tablette à rendre, remboursement (voir functions/). */
export function finDeContrat(fid) {
  return call('finDeContrat', { fid });
}

/** Annuler la commande (30 jours après la réception) : l'abonnement s'arrête tout de suite, tout est remboursé. */
export function retracter(fid) {
  return call('retracter', { fid });
}

/** Invitation d'un proche : un vrai e-mail part de Papote (fonction inviterParEmail). */
export function inviterParEmail(fid, email) {
  return call('inviterParEmail', { fid, email });
}

export function annulerResiliation(fid) {
  return call('annulerResiliation', { fid });
}

// Installation d'une nouvelle tablette (functions/installation.js).
// reserverTablette → { etat: 'reserve' | 'occupe' | 'inconnu' | 'expire', par?, fid? }
export function reserverTablette(code, prenom) {
  return call('reserverTablette', { code, prenom });
}

// reveil : appel à vide qui démarre le serveur avant le vrai appel.
export function nommerFamille(code, nom, reveil = false) {
  return call('nommerFamille', reveil ? { reveil: true } : { code, nom });
}

export function finirInstallation(fid) {
  return call('finirInstallation', { fid });
}

// { code } avant le nom (réservation rendue), { fid } après (famille effacée).
export function annulerInstallation(data) {
  return call('annulerInstallation', data);
}
