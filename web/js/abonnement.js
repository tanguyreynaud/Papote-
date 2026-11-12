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
  // Offre unique depuis le 29/10/2026 (Tanguy) : tout compris, carte SIM incluse.
  { formule: 'sim', tablette: 'incluse', titre: 'Papote tout compris', prix: '25 € par mois, carte SIM 4G incluse' },
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

// « Passer au prélèvement » (Tanguy, 10/11) : même règle que le serveur (functions/abonnement.js sepaPropose).
// 15 jours après le premier prélèvement mensuel réussi par carte, tant que l'abonnement est actif sans arrêt prévu.
export const SEPA_APRES_JOURS = 15;
const enMs = (t) => (t == null ? null : typeof t === 'number' ? t : typeof t.toMillis === 'function' ? t.toMillis() : (t.seconds != null ? t.seconds * 1000 : null));
export function inciterSepa(family, maintenant = Date.now()) {
  const p = family?.paiement;
  const abo = family?.abonnement;
  if (!p || p.moyen !== 'carte' || !abo || abo.statut !== 'actif' || abo.resiliationLe) return false;
  const premier = enMs(p.premierLe);
  return premier != null && maintenant >= premier + SEPA_APRES_JOURS * 24 * 3600 * 1000;
}

/** Page Stripe du mandat SEPA (aucun paiement) : au retour, l'appli s'ouvre avec ?sepa=ok. */
export async function passerAuSepa(fid) {
  const { url } = await call('passerAuSepa', { fid });
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
export function resilier(fid, { motif } = {}) {
  return call('resilierAbonnement', motif ? { fid, motif } : { fid });
}

/** Factures de la famille, les plus récentes d'abord : [{ id, numero, le, montant, statut: 'payee'|'a-payer', pdf, page }]. */
export async function facturesFamille(fid) {
  return (await call('facturesFamille', { fid }))?.factures || [];
}

/** Fin de contrat : délai de rétractation, tablette à rendre, remboursement (voir functions/). */
export function finDeContrat(fid) {
  return call('finDeContrat', { fid });
}

/** « Je renvoie la tablette » : le QR code de retour (sans impression), créé à la demande : { etiquette, qr }. */
// adresse { rue, cp, ville } : quand la commande n'en a pas d'utilisable.
export function renvoyerTablette(fid, adresse = null) {
  return call('renvoyerTablette', { fid, ...(adresse ? { adresse } : {}) });
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

// Famille préparée dès la commande (functions/famille-preparee.js) : le responsable donne le nom.
export function nommerFamillePreparee(fid, nom) {
  return call('nommerFamillePreparee', { fid, nom });
}

// Celui qui a payé, connecté avec une autre adresse que celle de la commande : il entre dans la famille de sa
// commande avec son numéro de commande (functions/entrer-par-commande.js, A40) → { fid, nom }.
export function entrerParCommande(code, prenom) {
  return call('entrerParCommande', { code, prenom });
}
