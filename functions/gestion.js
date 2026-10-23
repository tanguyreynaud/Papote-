// Gestion de Papote pour l'administrateur (page web/gestion.html) : stock de tablettes,
// commandes, factures, comptabilité et bilans.
//
//   gestionDonnees  commandes (avec l'état de la famille), stock de tablettes, dépenses
//   gestionStock    ajoute des tablettes achetées (et la dépense), change l'état d'une tablette
//   gestionDepense  ajoute ou retire une dépense du registre des achats
//   gestionStripe   factures, encaissements, remboursements, frais et abonnements Stripe d'une période
//   gestionCommande factures et paiements Stripe d'une commande
//   gestionSim      registre des cartes SIM (en stock, actives…), chacune reliée à sa tablette
//   gestionAccessoire  accessoires (clé 4G, prise…), sortis du stock à chaque envoi de leur formule
//   gestionPiece    pièces jointes (facture d'achat, bon de livraison…) d'une tablette ou d'une dépense
//   gestionLireFacture  lit une facture d'achat (PDF ou photo) avec Claude pour préremplir la saisie
//   gestionReglages réglages de la gestion (seuil de TVA, taux URSSAF, coût d'un forfait SIM…)
//   gestionRecap    le lundi : récapitulatif de la semaine par e-mail (gestionRecapMaintenant : tout de suite)
//   gestionCourrier toutes les heures : factures envoyées à factures@mapapote.fr, lues et rangées
//                   (« à vérifier ») ; gestionCourrierMaintenant : tout de suite
//   gestionCloture  le 1er du mois à 5 h : livre des recettes et registre des achats du mois écoulé, figés
//                   (gestion/archives), rangés dans Storage et envoyés par e-mail ; gestionCloturer : tout de suite
//   gestionAutomatique  chaque nuit : factures du matériel non rendu (montant prélevé), avoirs des
//                       remboursements, dépenses mensuelles récurrentes, états du stock suivant les
//                       commandes (gestionAutomatiser : tout de suite)
//
// Stripe est la source de vérité pour l'argent qui rentre ; Firestore garde le stock (stock/{id})
// et les dépenses (depenses/{id}), écrits seulement ici (aucune règle client : lecture et écriture
// refusées depuis les applis), pièces jointes dans Storage sous gestion/ (idem). Réservé au badge admin.

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions/v2');
const { defineSecret, defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const Stripe = require('stripe');
const Anthropic = require('@anthropic-ai/sdk');
const mail = require('./mail');
const sendcloud = require('./sendcloud');

const STRIPE_SECRET = defineSecret('STRIPE_SECRET');
// Même clé que le chat de support (outils/support/installer-support.bat), jamais dans le dépôt.
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
// Sonnet : recopier montant, date et vendeur d'une facture est simple, et chaque fiche reste « à vérifier ».
const MODELE_LECTURE = 'claude-sonnet-5-5';
// E-mails : mêmes réglages que le reste des fonctions (index.js).
const MAIL_SMTP = defineString('MAIL_SMTP', { default: 'smtp.gmail.com:465:' });
const MAIL_EXPEDITEUR = defineString('MAIL_EXPEDITEUR', { default: '' });
const MAIL_MOT_DE_PASSE = defineSecret('MAIL_MOT_DE_PASSE');
const EMAIL_PAPOTE = 'contact@mapapote.fr';
// Boîte relevée pour les factures (OVH) : « hote:port:utilisateur », mot de passe en secret
// (outils/gestion/installer-factures.bat). Seuls les e-mails adressés à FACTURES_ADRESSE sont lus.
const FACTURES_IMAP = defineString('FACTURES_IMAP', { default: 'ssl0.ovh.net:993:contact@mapapote.fr' });
const FACTURES_ADRESSE = defineString('FACTURES_ADRESSE', { default: 'factures@mapapote.fr' });
const FACTURES_MOT_DE_PASSE = defineSecret('FACTURES_MOT_DE_PASSE');
// « clé publique:clé secrète » de l'intégration Sendcloud « Papote étiquettes » (installer-sendcloud.bat).
const SENDCLOUD_API = defineSecret('SENDCLOUD_API');
const ESPACE_ADMIN = 'https://app.mapapote.fr/admin.html';
const { FieldValue, Timestamp } = admin.firestore;
// Base Firestore et bucket Storage : ceux d'origine (US) jusqu'à la bascule en Europe, où functions/.env
// reçoit BASE_FIRESTORE=eu et BUCKET_STORAGE=papote-famille-eu (notes/securite-acces.md, section 9).
const BASE_FIRESTORE = process.env.BASE_FIRESTORE || 'europe';
const db = () => getFirestore(admin.app(), BASE_FIRESTORE);
const stockage = () => admin.storage().bucket(process.env.BUCKET_STORAGE || 'papote-famille-eu');

let stripeClient;
function stripe() {
  if (!stripeClient) stripeClient = new Stripe(STRIPE_SECRET.value());
  return stripeClient;
}

// ---------- Règles, sans dépendance (testées par gestion.test.js) ----------

// Changements d'état permis à la main (page tablette) : la vie logique d'une tablette, sans retour en arrière.
// Les étapes automatiques (préparation, jumelage, retour, remplacement) écrivent directement.
const SUITES = {
  commandee: ['en-stock'],
  'en-stock': ['preparee', 'envoyee', 'a-reparer', 'hors-service', 'perdue'],
  preparee: ['en-stock', 'envoyee', 'a-reparer', 'hors-service', 'perdue'],
  envoyee: ['chez-client', 'en-retour', 'revenue', 'perdue'],
  'chez-client': ['en-retour', 'revenue', 'perdue', 'hors-service'],
  'en-retour': ['revenue', 'perdue'],
  revenue: ['en-stock', 'a-reparer', 'hors-service', 'perdue'],
  'a-reparer': ['en-stock', 'hors-service', 'perdue'],
  perdue: ['revenue'],
  'hors-service': [],
};
const transitionPermise = (de, vers) => de === vers || !de || (SUITES[de] || []).includes(vers);

// Vie d'une tablette du parc.
const ETATS = {
  commandee: 'Commandée, pas encore reçue',
  'en-stock': 'En stock',
  preparee: 'Préparée',
  envoyee: 'Envoyée',
  'chez-client': 'Chez le client',
  'en-retour': 'En retour',
  revenue: 'Revenue, à vérifier',
  'a-reparer': 'À réparer',
  perdue: 'Perdue',
  'hors-service': 'Hors service',
};
const CATEGORIES = {
  tablettes: 'Achat de tablettes',
  sim: 'Cartes SIM et forfaits',
  expedition: 'Expédition',
  hebergement: 'Hébergement et serveurs',
  logiciels: 'Logiciels et abonnements',
  publicite: 'Publicité',
  materiel: 'Petit matériel',
  autre: 'Autre',
};

const MAX_QUANTITE = 200;
const MAX_MONTANT = 10_000_000; // 100 000 €, en centimes

function texte(valeur, max = 200) {
  if (valeur == null) return null;
  const t = String(valeur).trim().slice(0, max);
  return t || null;
}

// Montant saisi en centimes (entier positif), sinon null.
function centimes(valeur) {
  if (valeur == null || valeur === '') return null;
  const n = Number(valeur);
  if (!Number.isInteger(n) || n < 0 || n > MAX_MONTANT) return null;
  return n;
}

function lien(valeur) {
  const t = texte(valeur, 500);
  return t && /^https:\/\//.test(t) ? t : null;
}

// Nature d'un mouvement Stripe (balance transaction) pour le livre des recettes.
function natureMouvement(bt) {
  const source = bt.source && typeof bt.source === 'object' ? bt.source : {};
  switch (bt.type) {
    case 'charge':
    case 'payment': {
      const desc = `${source.description || bt.description || ''}`.toLowerCase();
      if (/non rendu/.test(desc)) return 'tablette-non-rendue';
      return 'abonnement';
    }
    case 'refund':
    case 'payment_refund':
      return 'remboursement';
    case 'payout':
      return 'virement';
    case 'stripe_fee':
    case 'stripe_fx_fee':
    case 'tax_fee':
      return 'frais';
    case 'dispute':
    case 'payment_failure_refund':
      return 'litige';
    default:
      return 'autre';
  }
}

// Montant mensuel d'un abonnement Stripe (centimes), tous ses tarifs récurrents ramenés au mois.
function mensuel(abo) {
  let total = 0;
  for (const item of (abo.items && abo.items.data) || []) {
    const prix = item.price || {};
    const rec = prix.recurring;
    if (!rec || prix.unit_amount == null) continue;
    const montant = prix.unit_amount * (item.quantity || 1);
    const n = rec.interval_count || 1;
    if (rec.interval === 'month') total += montant / n;
    else if (rec.interval === 'year') total += montant / (12 * n);
    else if (rec.interval === 'week') total += (montant * 52) / (12 * n);
    else if (rec.interval === 'day') total += (montant * 365) / (12 * n);
  }
  return Math.round(total);
}

// Échéance suivante d'une dépense mensuelle : même jour le mois d'après (ou le dernier jour du mois).
function moisSuivant(le, jour) {
  const d = new Date(le);
  const annee = d.getUTCFullYear();
  const mois = d.getUTCMonth() + 1;
  const dernier = new Date(Date.UTC(annee, mois + 1, 0)).getUTCDate();
  return Date.UTC(annee, mois, Math.min(jour || d.getUTCDate(), dernier), 12);
}

// Réglages modifiables depuis la page (gestion/reglages). Montants en centimes.
const REGLAGES = {
  seuilTva: 3750000, // franchise en base de TVA des prestations de services (à vérifier chaque année)
  tauxUrssaf: 21.2, // % du chiffre d'affaires, micro-entreprise
  forfaitSim: 700, // coût mensuel d'un forfait SIM quand la ligne n'a pas son propre coût
  vieTablette: 24, // durée de vie d'une tablette, en mois
  poidsColis: 1500, // poids d'un colis tablette, en grammes (étiquettes Sendcloud)
  miseEnService: 6000, // payée une fois par chaque nouveau client
  fraisEnvoi: 799, // colis aller (Mondial Relay)
  fraisRetour: 800, // colis retour en fin d'abonnement
};
// Adresse de Papote pour les étiquettes : départ des colis et arrivée des retours.
const CHAMPS_EXPEDITEUR = ['nom', 'adresse', 'cp', 'ville', 'telephone', 'email'];

function lireReglages(donnees) {
  const r = { ...REGLAGES };
  for (const k of Object.keys(REGLAGES)) {
    const v = donnees && donnees[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) r[k] = v;
  }
  const e = (donnees && donnees.expediteur) || {};
  r.expediteur = Object.fromEntries(CHAMPS_EXPEDITEUR.map((k) => [k, typeof e[k] === 'string' ? e[k] : '']));
  r.masquees = masqueesActives(donnees && donnees.masquees);
  return r;
}

// Lignes « À faire » masquées par l'admin (Tanguy, 2026-10-22) : [{ cle, jusqua (ms) }], encore en cours.
// Une ligne masquée revient seule après la date si le problème n'est pas réglé.
const MASQUER_JOURS = 7;
function masqueesActives(liste, maintenant = Date.now()) {
  return (Array.isArray(liste) ? liste : [])
    .filter((m) => m && typeof m.cle === 'string' && typeof m.jusqua === 'number' && m.jusqua > maintenant);
}

// Une ligne SIM payée alors que la tablette n'est plus chez un client depuis 30 jours : forfait à résilier ou
// suspendre. Une carte pas encore activée (ligne « stock ») ne coûte rien : pas d'alerte (Tanguy, 2026-10-20).
const ETATS_SANS_CLIENT = ['commandee', 'en-stock', 'revenue', 'a-reparer', 'perdue', 'hors-service'];
const DELAI_SIM_SANS_CLIENT = 30 * 86400000;
function simAResilier(tablette, commande, ligne, maintenant = Date.now()) {
  if (!tablette.sim && !tablette.simId) return false;
  if (ligne && ligne.statut !== 'active') return false;
  const sansClient = ETATS_SANS_CLIENT.includes(tablette.etat)
    || !!(commande && ((commande.restitution && ['rendue', 'facturee'].includes(commande.restitution.statut))
      || ['resilie', 'canceled'].includes(commande.abonnement)));
  if (!sansClient) return false;
  // Depuis le dernier changement d'état de la tablette (son historique).
  const depuis = Math.max(0, ...(tablette.historique || []).map((x) => ms(x.le) || 0));
  return !depuis || maintenant - depuis > DELAI_SIM_SANS_CLIENT;
}

// Cartes SIM (registre sims/{id}) et accessoires (accessoires/{id}).
const STATUTS_SIM = {
  stock: 'En stock, pas activée',
  active: 'Active',
  suspendue: 'Suspendue',
  resiliee: 'Résiliée',
};
// Avec quels envois part un accessoire (clé 4G, prise…) : sorti du stock à chaque tablette envoyée.
// « option » : envoyé à la demande (enceinte), jamais sorti du stock automatiquement ni compté dans la rentabilité.
const ENVOIS_ACCESSOIRE = { '': 'Aucun envoi', tous: 'Chaque envoi', sim: 'Envois Internet inclus', wifi: 'Envois Wi-Fi', option: 'En option (à la demande)' };

// Prix payé ce mois-ci pour une ligne (centimes) : le prix après la promo quand elle est finie.
function coutLigne(l, maintenant) {
  if (l.finPromo && l.finPromo < maintenant && l.prixApres != null) return l.prixApres;
  return l.prix != null ? l.prix : null;
}

// Fin du mois d'expiration d'une carte bancaire « AAAA-MM », en ms (null si illisible).
function finCarte(cbExp) {
  const m = /^(\d{4})-(\d{2})$/.exec(cbExp || '');
  return m ? Date.UTC(Number(m[1]), Number(m[2]), 0, 23) : null;
}

// Ce qui demande une action sur une ligne SIM (mêmes seuils que l'ancien registre).
function alertesSim(l, maintenant) {
  if (l.statut === 'resiliee') return [];
  const liste = [];
  const jours = (t) => Math.ceil((t - maintenant) / (24 * 3600 * 1000));
  if (l.finPromo) {
    const j = jours(l.finPromo);
    if (j < 0 && l.prixApres != null && l.prixApres !== l.prix) liste.push('promo terminée');
    else if (j >= 0 && j <= 30) liste.push(`promo finie dans ${j} j`);
  }
  if (l.statut === 'stock' && l.activerAvant) {
    const j = jours(l.activerAvant);
    if (j < 0) liste.push('date limite d\'activation dépassée');
    else if (j <= 45) liste.push(`à activer dans les ${j} j`);
  }
  const fin = finCarte(l.cbExp);
  const carte = `carte bancaire${l.cb ? ` ${l.cb}` : ''}`;
  if (fin) {
    const j = jours(fin);
    if (j < 0) liste.push(`${carte} expirée`);
    else if (j <= 60) liste.push(`${carte} expire dans ${j} j`);
  }
  if (l.statut === 'suspendue') liste.push('suspendue : à résilier ou réactiver');
  return liste;
}

// Accessoires qui manquent pour les commandes à envoyer, ou sous leur seuil d'alerte.
function accessoiresAPrevoir(accessoires, aEnvoyer) {
  return accessoires.map((a) => {
    const besoin = a.parEnvoi ? aEnvoyer.filter((c) => a.parEnvoi === 'tous' || a.parEnvoi === c.formule).length : 0;
    const manque = Math.max(0, besoin - (a.quantite || 0));
    const bas = !manque && a.seuil != null && (a.quantite || 0) - besoin <= a.seuil;
    return { ...a, besoin, manque, bas };
  }).filter((a) => a.manque || a.bas);
}

// Ce qui ne colle pas entre clients, tablettes et cartes SIM (même règle sur la page).
function incoherences({ commandes, stock, sims }) {
  const parCommande = new Map(stock.filter((t) => t.commande).map((t) => [t.commande, t]));
  const sansSim = commandes.filter((c) => {
    const t = parCommande.get(c.id);
    return c.formule === 'sim' && t && ETATS_PARTIS.includes(t.etat) && !t.sim;
  }).length;
  const sansTablette = sims.filter((l) => l.statut === 'active' && !l.tablette).length;
  const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;
  return [
    sansSim ? `${pluriel(sansSim, 'client Internet inclus', 'clients Internet inclus')} sans carte SIM notée sur sa tablette` : null,
    sansTablette ? `${pluriel(sansTablette, 'ligne SIM active reliée', 'lignes SIM actives reliées')} à aucune tablette` : null,
  ].filter(Boolean);
}

// Batterie d'une tablette, écrite par la tablette dans families/{fid}/members/{tabletUid}.battery
// (level, charging, at, health, temperature, cycles à partir d'Android 14), recopiée sur sa fiche du stock.
function releveBatterie(membre) {
  const b = (membre && membre.battery) || {};
  const val = (v) => (v === undefined ? null : v);
  return {
    niveau: val(b.level), enCharge: val(b.charging), sante: b.health || null, temperature: val(b.temperature),
    cycles: val(b.cycles), le: b.at || null, vueLe: (membre && membre.lastSeen) || null, enLigneLe: (membre && membre.lastOnline) || null,
  };
}

// Batterie usée : la tablette est à retirer du parc à son retour. Renvoie la raison, ou null.
const SANTES_HS = { morte: 'batterie morte', panne: 'batterie en panne', surtension: 'batterie en surtension' };
const CYCLES_USEE = 500;
function usureBatterie(b) {
  if (!b) return null;
  if (SANTES_HS[b.sante]) return SANTES_HS[b.sante];
  if (typeof b.cycles === 'number' && b.cycles >= CYCLES_USEE) return `batterie usée (${b.cycles} cycles)`;
  return null;
}

// Le stock suit les commandes : ce que la nuit corrige quand une étape n'a pas été notée sur la tablette.
// Renvoie les champs à changer ({ etat, commande }) ou null.
const ETATS_PARTIS = ['envoyee', 'chez-client', 'en-retour'];
function stockAJour(tablette, commande) {
  if (!commande) return null;
  const retour = commande.restitution && commande.restitution.statut;
  if (ETATS_PARTIS.includes(tablette.etat)) {
    if (retour === 'facturee') return { etat: 'perdue' };
    if (retour === 'rendue') return { etat: 'revenue' };
    if (tablette.etat === 'envoyee' && commande.fid) return { etat: 'chez-client' };
  }
  // Commande annulée avant le départ : la tablette mise de côté redevient libre.
  if (commande.expedition === 'annulee' && ['en-stock', 'preparee'].includes(tablette.etat)) {
    return { etat: 'en-stock', commande: null };
  }
  return null;
}

// Pièces jointes d'un e-mail à lire comme factures : PDF et photos, sans les petits logos de signature.
const MAX_PIECES_MAIL = 10;
function piecesFacture(pieces) {
  return (pieces || []).filter((p) => {
    const type = String(p.contentType || '').toLowerCase();
    const taille = p.size || (p.content && p.content.length) || 0;
    if (taille > 6 * 1024 * 1024 || !taille) return false;
    if (type === 'application/pdf') return true;
    return /^image\/(png|jpeg|webp|gif)$/.test(type) && taille > 40 * 1024 && p.contentDisposition !== 'inline';
  }).slice(0, MAX_PIECES_MAIL);
}

// ---------- Livres comptables : livre des recettes et registre des achats ----------

const NATURES = {
  abonnement: 'Abonnement Papote',
  'tablette-non-rendue': 'Matériel non rendu',
  remboursement: 'Remboursement',
  litige: 'Contestation bancaire',
};
const ENCAISSEMENTS = ['abonnement', 'tablette-non-rendue'];

// Décalage de Paris par rapport à UTC (ms) à un instant donné.
function decalageParis(t) {
  const nom = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(t)).find((x) => x.type === 'timeZoneName').value; // « GMT+1 »
  const m = /GMT([+-]\d+)/.exec(nom);
  return m ? Number(m[1]) * 3600000 : 0;
}

// Minuit à Paris le 1er du mois (mois de 1 à 12 ; 13 = janvier de l'année suivante), en ms.
// Le 1er du mois n'est jamais un jour de changement d'heure : le décalage de 0 h UTC est le bon.
function debutMoisParis(annee, mois) {
  const utc = Date.UTC(annee, mois - 1, 1);
  return utc - decalageParis(utc);
}

// Le mois (à Paris) qui précède l'instant donné : { annee, mois }.
function moisPrecedent(maintenant) {
  const d = new Date(maintenant + decalageParis(maintenant));
  const annee = d.getUTCFullYear();
  const mois = d.getUTCMonth() + 1;
  return mois === 1 ? { annee: annee - 1, mois: 12 } : { annee, mois: mois - 1 };
}

const cleMois = (annee, mois) => `${annee}-${String(mois).padStart(2, '0')}`;

// CSV pour Excel : séparateur « ; », virgule décimale, BOM UTF-8 (comme les exports de la page).
function csvTexte(entetes, lignes) {
  const champ = (v) => {
    const t = v == null ? '' : String(v);
    return /[";\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return `﻿${[entetes, ...lignes].map((l) => l.map(champ).join(';')).join('\r\n')}\r\n`;
}
const montantCsv = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));
const jourParis = (t) => (t == null ? '' : new Date(t).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }));

// Livre des recettes : chaque paiement reçu et chaque remboursement, dans l'ordre des dates.
// numeros : Map id de facture Stripe → numéro.
function livreDesRecettes(mouvements, numeros = new Map()) {
  const lignes = mouvements
    .filter((m) => ENCAISSEMENTS.includes(m.nature) || m.nature === 'remboursement' || m.nature === 'litige')
    .sort((a, b) => a.le - b.le);
  const total = lignes.reduce((s, m) => s + m.montant, 0);
  return {
    total,
    nombre: lignes.length,
    csv: csvTexte(
      ['Date', 'Facture', 'Client', 'E-mail', 'Nature', 'Mode de règlement', 'Montant', 'Frais Stripe', 'Net', 'Référence Stripe'],
      [...lignes.map((m) => [jourParis(m.le), numeros.get(m.facture) || '', m.client, m.email, NATURES[m.nature],
        'Carte bancaire (Stripe)', montantCsv(m.montant), montantCsv(m.frais), montantCsv(m.net), m.source || m.id]),
      ['', '', '', '', 'Total encaissé moins remboursements', '', montantCsv(total), '', '', '']]),
  };
}

// Registre des achats : chaque dépense, dans l'ordre des dates.
function registreDesAchats(depenses) {
  const lignes = depenses.slice().sort((a, b) => ms(a.date) - ms(b.date));
  const total = lignes.reduce((s, d) => s + (d.montant || 0), 0);
  return {
    total,
    nombre: lignes.length,
    csv: csvTexte(
      ['Date', 'Fournisseur', 'N° de facture', 'Libellé', 'Catégorie', 'Montant TTC', 'dont TVA', 'Justificatifs'],
      [...lignes.map((d) => [jourParis(ms(d.date)), d.fournisseur, d.numero, d.libelle, CATEGORIES[d.categorie] || d.categorie,
        montantCsv(d.montant), montantCsv(d.tva), [...(d.pieces || []).map((p) => p.nom), d.justificatif].filter(Boolean).join(', ')]),
      ['', '', '', 'Total', '', montantCsv(total), '', '']]),
  };
}

// Euros (nombre lu sur la facture) → centimes, sinon null.
function euros(valeur) {
  if (typeof valeur !== 'number' || !Number.isFinite(valeur)) return null;
  return centimes(Math.round(valeur * 100));
}

// Ce que Claude renvoie (SCHEMA_FACTURE) → valeurs des formulaires d'achat et de dépense.
function lectureVersFormulaire(o) {
  o = o || {};
  const date = typeof o.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? Date.parse(`${o.date}T12:00:00Z`) : null;
  const t = o.tablettes && typeof o.tablettes === 'object' ? o.tablettes : null;
  const quantite = t && Number.isInteger(t.quantite) && t.quantite >= 1 && t.quantite <= MAX_QUANTITE ? t.quantite : null;
  return {
    facture: o.estUneFacture !== false,
    confirmation: o.confirmationCommande === true,
    fournisseur: texte(o.fournisseur),
    numero: texte(o.numero, 80),
    date: Number.isFinite(date) ? date : null,
    montant: euros(o.totalTTC),
    tva: euros(o.tva),
    devise: texte(o.devise, 3),
    categorie: CATEGORIES[o.categorie] ? o.categorie : 'autre',
    libelle: texte(o.libelle),
    tablettes: quantite ? {
      quantite,
      modele: texte(t.modele),
      prixAchat: euros(t.prixUnitaireTTC),
      numeros: (Array.isArray(t.numerosSerie) ? t.numerosSerie : []).map((n) => texte(n, 80)).filter(Boolean).slice(0, quantite),
    } : null,
    ...materielLu(o),
    remarque: texte(o.remarque, 300),
  };
}

// Cartes SIM et accessoires d'une facture, depuis la lecture (euros) ou depuis la page (centimes).
function materielLu(o, enCentimes = false) {
  o = o || {};
  const prix = (v) => (enCentimes ? centimes(v) : euros(v));
  const liste = (v, max) => (Array.isArray(v) ? v : []).map((x) => texte(String(x || '').replace(/\s/g, ''), 30)).filter(Boolean).slice(0, max);
  const c = o.cartesSim && typeof o.cartesSim === 'object' ? o.cartesSim : null;
  const quantite = c && Number.isInteger(c.quantite) && c.quantite >= 1 && c.quantite <= MAX_QUANTITE ? c.quantite : null;
  return {
    cartesSim: quantite ? {
      quantite,
      operateur: texte(c.operateur, 80),
      iccids: liste(c.iccids, quantite),
      numeros: liste(c.numeros, quantite),
      prixCarte: prix(enCentimes ? c.prixCarte : c.prixCarteTTC),
      forfait: prix(enCentimes ? c.forfait : c.forfaitMensuelTTC),
    } : null,
    accessoires: (Array.isArray(o.accessoires) ? o.accessoires : []).map((a) => ({
      nom: texte(a && a.nom, 80),
      quantite: a && Number.isInteger(a.quantite) && a.quantite >= 1 && a.quantite <= 10000 ? a.quantite : null,
      prixUnitaire: prix(a && (enCentimes ? a.prixUnitaire : a.prixUnitaireTTC)),
    })).filter((a) => a.nom && a.quantite).slice(0, 20),
  };
}

// Même accessoire sous un nom un peu différent (« Clé 4G » / « Clé USB 4G LTE ») : mots du plus court tous présents.
const motsNom = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .split(/[^a-z0-9]+/).filter((m) => m.length >= 2);
function memeAccessoire(a, b) {
  const [x, y] = [motsNom(a), motsNom(b)].sort((u, v) => u.length - v.length);
  return x.length > 0 && x.every((m) => y.includes(m));
}

const nul = (type) => ({ anyOf: [{ type }, { type: 'null' }] });
const SCHEMA_FACTURE = {
  type: 'object',
  additionalProperties: false,
  required: ['estUneFacture', 'confirmationCommande', 'fournisseur', 'numero', 'date', 'totalTTC', 'tva', 'devise', 'categorie',
    'libelle', 'tablettes', 'cartesSim', 'accessoires', 'remarque'],
  properties: {
    estUneFacture: { type: 'boolean', description: 'Faux si le document n\'est ni une facture, ni un ticket de caisse, ni une confirmation de commande avec le montant payé.' },
    confirmationCommande: { type: 'boolean', description: 'Vrai si c\'est une confirmation de commande d\'un site marchand et non la facture elle-même.' },
    fournisseur: nul('string'),
    numero: { ...nul('string'), description: 'Numéro de la facture.' },
    date: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }], description: 'Date de la facture (AAAA-MM-JJ).' },
    totalTTC: { ...nul('number'), description: 'Total payé, toutes taxes comprises, en euros.' },
    tva: { ...nul('number'), description: 'Montant total de la TVA en euros, null si aucune.' },
    devise: { ...nul('string'), description: 'Code ISO de la devise, EUR le plus souvent.' },
    categorie: { type: 'string', enum: Object.keys(CATEGORIES) },
    libelle: { type: 'string', description: 'Ce qui a été acheté, en quelques mots, en français.' },
    tablettes: {
      anyOf: [{ type: 'null' }, {
        type: 'object',
        additionalProperties: false,
        required: ['quantite', 'modele', 'prixUnitaireTTC', 'numerosSerie'],
        properties: {
          quantite: { type: 'integer' },
          modele: nul('string'),
          prixUnitaireTTC: nul('number'),
          numerosSerie: { type: 'array', items: { type: 'string' } },
        },
      }],
      description: 'Seulement pour un achat de tablettes : sinon null.',
    },
    cartesSim: {
      anyOf: [{ type: 'null' }, {
        type: 'object',
        additionalProperties: false,
        required: ['quantite', 'operateur', 'iccids', 'numeros', 'prixCarteTTC', 'forfaitMensuelTTC'],
        properties: {
          quantite: { type: 'integer' },
          operateur: nul('string'),
          iccids: { type: 'array', items: { type: 'string' }, description: 'ICCID lisibles (numéro de 19 ou 20 chiffres de la carte).' },
          numeros: { type: 'array', items: { type: 'string' }, description: 'Numéros de ligne attribués, dans le même ordre.' },
          prixCarteTTC: { ...nul('number'), description: 'Prix d\'une carte (kit SIM), en euros.' },
          forfaitMensuelTTC: { ...nul('number'), description: 'Prix mensuel du forfait de chaque ligne, en euros.' },
        },
      }],
      description: 'Seulement pour des cartes SIM physiques achetées (kits SIM, nouvelles lignes) : sinon null. '
        + 'Une simple facture mensuelle de forfaits n\'en est pas une.',
    },
    accessoires: {
      type: 'array',
      description: 'Petit matériel envoyé avec les tablettes, à suivre en stock (clé ou routeur 4G, prise USB, chargeur, '
        + 'câble, support…), une entrée par article. Vide sinon (pas les tablettes ni les cartes SIM).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['nom', 'quantite', 'prixUnitaireTTC'],
        properties: { nom: { type: 'string', description: 'Nom court en français, ex. « Clé 4G USB ».' }, quantite: { type: 'integer' }, prixUnitaireTTC: nul('number') },
      },
    },
    remarque: { ...nul('string'), description: 'Un doute à signaler à la personne qui saisit (montant illisible…), sinon null.' },
  },
};

// ---------- Accès ----------

function verifierAdmin(request) {
  const token = request.auth && request.auth.token;
  if (!token || token.admin !== true) throw new HttpsError('permission-denied', 'Réservé à l\'administrateur.');
}

function ms(valeur) {
  if (valeur == null) return null;
  if (typeof valeur.toMillis === 'function') return valeur.toMillis();
  if (typeof valeur === 'number') return valeur;
  return null;
}

// Timestamps Firestore → millisecondes, pour les renvoyer à la page.
function aplatir(valeur) {
  if (valeur == null || typeof valeur !== 'object') return valeur;
  if (typeof valeur.toMillis === 'function') return valeur.toMillis();
  if (Array.isArray(valeur)) return valeur.map(aplatir);
  return Object.fromEntries(Object.entries(valeur).map(([k, v]) => [k, aplatir(v)]));
}

function effacerPieces(pieces) {
  return Promise.all((pieces || []).map((p) => stockage().file(p.chemin).delete().catch(() => null)));
}

// ---------- Lecture ----------

exports.gestionDonnees = onCall(async (request) => {
  verifierAdmin(request);
  const [commandes, stock, depenses, familles, automatique, reglages, courrier, archives, sims, accessoires] = await Promise.all([
    db().collection('commandes').get(),
    db().collection('stock').get(),
    db().collection('depenses').get(),
    db().collection('families').select('name', 'abonnement').get(),
    db().doc('gestion/automatique').get(),
    db().doc('gestion/reglages').get(),
    db().doc('gestion/courrier').get(),
    db().doc('gestion/archives').get(),
    db().collection('sims').get(),
    db().collection('accessoires').get(),
  ]);
  const parFid = new Map(familles.docs.map((f) => [f.id, f.data()]));
  // Même calcul que la vente sur le site (stock.js) : paiements en cours compris.
  const aVendre = await require('./stock').nombreDisponibles(db()).catch((e) => { logger.warn('À vendre', e.message); return null; });
  // Batterie en direct pour les tablettes jumelées, sinon le dernier relevé gardé sur la fiche.
  const batteries = await lireBatteries(stock.docs).catch((e) => { logger.warn('Batteries', e.message); return new Map(); });
  return {
    aVendre,
    commandes: commandes.docs.map((d) => {
      const c = d.data();
      const famille = c.fid ? parFid.get(c.fid) : null;
      return aplatir({
        id: d.id,
        code: c.code || null,
        email: c.email || null,
        nom: c.nom || null,
        telephone: c.telephone || null,
        formule: c.formule || null,
        tablette: c.tablette || null,
        livraison: c.livraison || null,
        expedition: c.expedition || null,
        suivi: c.suivi || null,
        envoyeeLe: c.envoyeeLe || null,
        creeLe: c.creeLe || null,
        fid: c.fid || null,
        famille: famille ? famille.name || null : null,
        abonnement: famille && famille.abonnement ? famille.abonnement.statut || null : (c.statutStripe || null),
        resiliationLe: famille && famille.abonnement ? famille.abonnement.resiliationLe || null : null,
        restitution: c.restitution ? { statut: c.restitution.statut || null, avant: c.restitution.avant || null } : null,
        remboursement: c.remboursement || null,
        restitutionErreur: c.restitution && c.restitution.erreur ? c.restitution.erreur : null,
        retractation: c.retractation || null,
        dernierMois: c.dernierMois || null,
        contestations: c.contestations || null,
        pause: c.pause || null,
        alerteDoublon: c.alerteDoublon || null,
        etiquettes: c.etiquettes || null,
        preparation: c.preparation || null,
        stripeCustomerId: c.stripeCustomerId || null,
        offerte: c.offerte === true,
      });
    }),
    stock: stock.docs.map((d) => {
      const batterie = batteries.get(d.id) || d.get('batterie') || null;
      return aplatir({ id: d.id, ...d.data(), batterie, usure: usureBatterie(batterie) });
    }),
    depenses: depenses.docs.map((d) => aplatir({ id: d.id, ...d.data() })),
    familles: familles.docs.map((f) => ({
      id: f.id,
      nom: f.get('name') || null,
      statut: f.get('abonnement.statut') || null,
      formule: f.get('abonnement.formule') || null,
    })),
    etats: ETATS,
    categories: CATEGORIES,
    automatique: automatique.exists ? automatique.data() : null,
    reglages: lireReglages(reglages.data()),
    courrier: courrier.exists ? courrier.data() : null,
    archives: archives.exists ? archives.data() : null,
    sims: sims.docs.map((d) => aplatir({ id: d.id, ...d.data() })),
    accessoires: accessoires.docs.map((d) => aplatir({ id: d.id, ...d.data() })),
    statutsSim: STATUTS_SIM,
    envoisAccessoire: ENVOIS_ACCESSOIRE,
  };
});

// ---------- Stock ----------

// Fiches créées à l'installation avant que la facture soit enregistrée (sans prix ni date d'achat) : un achat
// enregistré ensuite les complète au lieu d'ajouter des fiches en double, ce qui gonflerait le stock à vendre.
// Même n° de série d'abord, puis la plus ancienne encore au stock : une tablette déjà partie chez un client (ou liée
// à une commande) n'est complétée que par son n° de série. Renvoie, pour chaque tablette, l'id à compléter ou null.
const ETATS_A_RATTACHER = ['commandee', 'en-stock', 'preparee'];
function fichesARattacher(sansAchat, numeros, quantite) {
  const restantes = sansAchat.slice().sort((a, b) => (a.creeLe || 0) - (b.creeLe || 0));
  const libre = (t) => !t.commande && (!t.etat || ETATS_A_RATTACHER.includes(t.etat));
  const prendre = (i) => (i < 0 ? null : restantes.splice(i, 1)[0].id);
  const serie = (n) => String(n || '').replace(/\s/g, '').toUpperCase();
  const choix = Array.from({ length: quantite }, (_, i) => {
    const n = serie(numeros[i]);
    return n ? prendre(restantes.findIndex((t) => serie(t.numero) === n || serie(t.serieAndroid) === n)) : undefined;
  });
  return choix.map((id) => (id === undefined || id === null ? prendre(restantes.findIndex(libre)) : id));
}

// Achat de tablettes : N fiches de stock et la dépense correspondante (sauf depense: false).
async function ajouterAchat(d, qui) {
  const quantite = Number(d.quantite);
  const prix = centimes(d.prixAchat);
  const achat = ms(d.acheteeLe) || Date.now();
  if (!Number.isInteger(quantite) || quantite < 1 || quantite > MAX_QUANTITE) {
    throw new HttpsError('invalid-argument', `Quantité entre 1 et ${MAX_QUANTITE}.`);
  }
  if (prix == null) throw new HttpsError('invalid-argument', 'Prix d\'achat unitaire manquant (en centimes).');
  const numeros = Array.isArray(d.numeros) ? d.numeros.map((n) => texte(n, 80)) : [];
  const batch = db().batch();
  let depenseId = null;
  if (d.depense !== false) {
    const ref = db().collection('depenses').doc();
    depenseId = ref.id;
    batch.set(ref, {
      date: Timestamp.fromMillis(achat),
      categorie: 'tablettes',
      fournisseur: texte(d.fournisseur),
      numero: texte(d.numeroFacture, 80),
      libelle: `${quantite} tablette${quantite > 1 ? 's' : ''} ${texte(d.modele) || ''}`.trim(),
      montant: prix * quantite,
      tva: centimes(d.tva) != null ? centimes(d.tva) * quantite : null,
      justificatif: lien(d.justificatif),
      aVerifier: d.aVerifier === true,
      source: texte(d.source),
      creeLe: FieldValue.serverTimestamp(),
      creePar: qui,
    });
  }
  const sansAchat = (await db().collection('stock').where('acheteeLe', '==', null).get()).docs
    .filter((x) => x.get('prixAchat') == null && !x.get('depense'))
    .map((x) => ({ id: x.id, numero: x.get('numero'), serieAndroid: x.get('serieAndroid'), modele: x.get('modele'),
      etat: x.get('etat'), commande: x.get('commande') || null, creeLe: ms(x.get('creeLe')) || 0 }));
  const rattachees = fichesARattacher(sansAchat, numeros, quantite);
  for (let i = 0; i < quantite; i++) {
    if (rattachees[i]) {
      const t = sansAchat.find((x) => x.id === rattachees[i]);
      batch.update(db().doc(`stock/${t.id}`), {
        ...(t.numero ? {} : { numero: numeros[i] || null }),
        ...(t.modele ? {} : { modele: texte(d.modele) }),
        fournisseur: texte(d.fournisseur),
        prixAchat: prix,
        acheteeLe: Timestamp.fromMillis(achat),
        depense: depenseId,
        notes: null,
        majLe: FieldValue.serverTimestamp(),
      });
      continue;
    }
    batch.set(db().collection('stock').doc(), {
      numero: numeros[i] || null,
      modele: texte(d.modele),
      fournisseur: texte(d.fournisseur),
      prixAchat: prix,
      acheteeLe: Timestamp.fromMillis(achat),
      etat: 'en-stock',
      commande: null,
      sim: null,
      notes: null,
      depense: depenseId,
      historique: [{ le: Date.now(), etat: 'en-stock', par: qui }],
      majLe: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
  const completees = rattachees.filter(Boolean).length;
  return { ok: true, ajoutees: quantite - completees, completees, depense: depenseId };
}

// Remplacement d'un élément du kit chez un client : la tablette, la carte SIM ou un accessoire.
// La tablette remplacée passe « en retour » (à récupérer) et laisse sa carte SIM à la nouvelle ;
// la carte SIM remplacée passe « suspendue » (à résilier) ; l'accessoire sort du stock.
async function remplacer(d, qui) {
  const commande = texte(d.commande, 100);
  const motif = texte(d.motif, 200);
  if (!commande) throw new HttpsError('invalid-argument', 'Commande manquante.');
  const kit = (await db().collection('stock').where('commande', '==', commande).limit(1).get()).docs[0];
  if (!kit) throw new HttpsError('failed-precondition', 'Aucune tablette n\'est notée chez ce client.');
  const trace = (etat, extra = {}) => ({ le: Date.now(), etat, par: qui, commande, motif, ...extra });

  if (d.element === 'tablette') {
    const neuve = await db().doc(`stock/${d.nouveau || '-'}`).get();
    if (!neuve.exists || neuve.get('commande') || !['en-stock', 'preparee'].includes(neuve.get('etat'))) {
      throw new HttpsError('failed-precondition', 'Choisissez une tablette disponible du stock.');
    }
    await kit.ref.update({
      etat: 'en-retour', commande: null, remplaceePour: commande, majLe: FieldValue.serverTimestamp(),
      historique: FieldValue.arrayUnion(trace('en-retour', { remplacement: true })),
    });
    await neuve.ref.update({
      etat: 'envoyee', commande, accessoires: kit.get('accessoires') || [], majLe: FieldValue.serverTimestamp(),
      historique: FieldValue.arrayUnion(trace('envoyee', { remplacement: true })),
    });
    if (kit.get('simId')) await enregistrerSim(kit.get('simId'), { tablette: neuve.id }, qui);
    return { ok: true };
  }

  if (d.element === 'sim') {
    const sim = await db().doc(`sims/${d.nouveau || '-'}`).get();
    if (!sim.exists || sim.get('tablette') || sim.get('statut') === 'resiliee') {
      throw new HttpsError('failed-precondition', 'Choisissez une carte SIM libre.');
    }
    if (!sim.get('numero') && !sim.get('iccid')) {
      throw new HttpsError('failed-precondition', "Notez d'abord le numéro ou l'ICCID de cette carte SIM.");
    }
    const ancienne = kit.get('simId');
    if (ancienne) await enregistrerSim(ancienne, { statut: 'suspendue', tablette: null }, qui);
    await enregistrerSim(sim.id, { tablette: kit.id, statut: 'active', activation: sim.get('activation') || Date.now() }, qui);
    await kit.ref.update({ historique: FieldValue.arrayUnion({ ...trace(kit.get('etat')), sim: sim.get('numero') || sim.get('iccid') || sim.id }) });
    return { ok: true };
  }

  if (d.element === 'accessoire') {
    const a = await db().doc(`accessoires/${d.nouveau || '-'}`).get();
    if (!a.exists) throw new HttpsError('not-found', 'Accessoire introuvable.');
    await a.ref.update({ quantite: FieldValue.increment(-1), majLe: FieldValue.serverTimestamp() });
    await kit.ref.update({
      historique: FieldValue.arrayUnion({ ...trace(kit.get('etat')), accessoires: [a.get('nom')], remplacement: true }),
    });
    return { ok: true };
  }
  throw new HttpsError('invalid-argument', 'Élément à remplacer inconnu.');
}

exports.gestionStock = onCall(async (request) => {
  verifierAdmin(request);
  const d = request.data || {};
  const qui = request.auth.token.email || request.auth.uid;

  // Tablette reçue avant sa facture (« Pas dans la liste » à la réception) : fiche sans achat, que l'installation
  // reprend et que la facture complétera (fichesARattacher).
  if (d.action === 'recue') {
    const ref = await db().collection('stock').add({
      numero: texte(d.numero, 80) || null, modele: texte(d.modele) || null, fournisseur: texte(d.fournisseur) || null,
      prixAchat: null, acheteeLe: null, etat: 'en-stock', commande: null, sim: null,
      notes: 'Reçue avant sa facture : transférez la facture du vendeur à factures@mapapote.fr.',
      historique: [{ le: Date.now(), etat: 'en-stock', par: qui }],
      creeLe: FieldValue.serverTimestamp(), majLe: FieldValue.serverTimestamp(),
    });
    return { ok: true, id: ref.id };
  }

  if (d.action === 'ajouter') {
    const r = await ajouterAchat(d, qui);
    r.materiel = await entrerMateriel(materielLu(d.materiel, true), { depense: r.depense, numeroFacture: d.numeroFacture }, qui);
    return r;
  }

  // Achat rattaché à la mauvaise fiche : la fiche redevient « sans facture » et l'achat part sur une fiche neuve en stock.
  if (d.action === 'detacherAchat') {
    if (typeof d.id !== 'string' || !d.id) throw new HttpsError('invalid-argument', 'Tablette manquante.');
    const ref = db().doc(`stock/${d.id}`);
    const snap = await ref.get();
    if (!snap.exists || !snap.get('depense')) throw new HttpsError('failed-precondition', 'Cette tablette n\'a pas d\'achat rattaché.');
    const dep = await db().doc(`depenses/${snap.get('depense')}`).get();
    const modele = dep.exists ? String(dep.get('libelle') || '').replace(/^\d+ tablettes? ?/, '') || null : null;
    const neuve = db().collection('stock').doc();
    const batch = db().batch();
    batch.set(neuve, {
      numero: null, modele, fournisseur: snap.get('fournisseur') || null, prixAchat: snap.get('prixAchat'),
      acheteeLe: snap.get('acheteeLe'), etat: 'en-stock', commande: null, sim: null, notes: null, depense: snap.get('depense'),
      historique: [{ le: Date.now(), etat: 'en-stock', par: qui }],
      creeLe: FieldValue.serverTimestamp(), majLe: FieldValue.serverTimestamp(),
    });
    batch.update(ref, { prixAchat: null, acheteeLe: null, depense: null, majLe: FieldValue.serverTimestamp() });
    await batch.commit();
    return { ok: true, id: neuve.id };
  }

  if (d.action === 'modifier') {
    if (typeof d.id !== 'string' || !d.id) throw new HttpsError('invalid-argument', 'Tablette manquante.');
    const ref = db().doc(`stock/${d.id}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Tablette introuvable.');
    const champs = d.champs || {};
    const maj = { majLe: FieldValue.serverTimestamp() };
    for (const cle of ['numero', 'modele', 'fournisseur', 'sim', 'simOperateur', 'notes']) {
      if (cle in champs) maj[cle] = texte(champs[cle], cle === 'notes' ? 1000 : 80);
    }
    // Vendeur corrigé : la dépense de l'achat suit (même faute de frappe des deux côtés).
    if (maj.fournisseur && maj.fournisseur !== snap.get('fournisseur') && snap.get('depense')) {
      const dep = db().doc(`depenses/${snap.get('depense')}`);
      if ((await dep.get()).exists) await dep.update({ fournisseur: maj.fournisseur, majLe: FieldValue.serverTimestamp() });
    }
    if ('simCout' in champs) maj.simCout = centimes(champs.simCout);
    // Achat chez le vendeur (Tanguy, 2026-10-22 : chaque tablette, carte SIM ou accessoire a son achat).
    if ('depense' in champs) maj.depense = await depenseExistante(champs.depense);
    if ('commande' in champs) {
      const commande = texte(champs.commande, 100);
      if (commande && !(await db().doc(`commandes/${commande}`).get()).exists) {
        throw new HttpsError('not-found', 'Commande introuvable.');
      }
      maj.commande = commande;
      // Tablette jumelée avant d'être rattachée à sa commande : l'alerte n'a plus lieu d'être.
      if (commande && snap.get('alerteJumelage') === ALERTE_SANS_COMMANDE) maj.alerteJumelage = null;
    }
    let sortis = [];
    if ('etat' in champs) {
      if (!ETATS[champs.etat]) throw new HttpsError('invalid-argument', 'État inconnu.');
      if (!transitionPermise(snap.get('etat'), champs.etat)) {
        throw new HttpsError('failed-precondition', `Une tablette « ${ETATS[snap.get('etat')] || snap.get('etat')} » ne peut pas passer « ${ETATS[champs.etat]} ».`);
      }
      if (champs.etat !== snap.get('etat')) {
        maj.etat = champs.etat;
        // Perdue (volée) ou hors service : plus d'accès aux photos de la famille.
        if (ETATS_BLOQUES.includes(champs.etat) && await retirerDeLaFamille(snap.data(), snap.ref)) maj.fid = null;
        // Remise en stock : la tablette n'appartient plus à la commande (l'historique la garde).
        // (Sauf à la réception d'une tablette commandée : elle reste réservée à sa commande.)
        if (champs.etat === 'en-stock' && !('commande' in champs) && snap.get('etat') !== 'commandee') maj.commande = null;
        const commande = maj.commande !== undefined ? maj.commande : snap.get('commande') || null;
        // Départ du colis : les accessoires qui partent avec cette formule sortent du stock.
        if (champs.etat === 'envoyee' && commande) {
          sortis = await sortirAccessoires(commande);
          // Le kit du client : ce qui est parti avec la tablette.
          maj.accessoires = sortis;
          // Carte SIM encore « en stock » dans la tablette qui part : elle est activée à la préparation.
          const simId = snap.get('simId');
          const sim = simId && await db().doc(`sims/${simId}`).get();
          if (sim && sim.exists && sim.get('statut') === 'stock') {
            await sim.ref.update({ statut: 'active', activation: sim.get('activation') || Date.now(), majLe: FieldValue.serverTimestamp() });
          }
        }
        maj.historique = FieldValue.arrayUnion({
          le: Date.now(), etat: champs.etat, par: qui, commande, ...(sortis.length ? { accessoires: sortis } : {}),
        });
      }
    }
    await ref.update(maj);
    return { ok: true, accessoires: sortis };
  }

  if (d.action === 'remplacer') return remplacer(d, qui);

  // Erreur de saisie seulement : une tablette qui a déjà servi garde sa fiche (état perdue ou hors service).
  if (d.action === 'supprimer') {
    const ref = db().doc(`stock/${d.id || '-'}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Tablette introuvable.');
    if (snap.get('etat') !== 'en-stock' || snap.get('commande') || (snap.get('historique') || []).length > 1) {
      throw new HttpsError('failed-precondition', 'Cette tablette a déjà servi : passez-la en « Perdue » ou « Hors service ».');
    }
    await ref.delete();
    await effacerPieces(snap.get('pieces'));
    return { ok: true };
  }

  throw new HttpsError('invalid-argument', 'Action inconnue.');
});

async function sortirAccessoires(commandeId) {
  const commande = await db().doc(`commandes/${commandeId}`).get();
  const formule = commande.get('formule');
  const accessoires = await db().collection('accessoires').get();
  const sortis = [];
  for (const a of accessoires.docs) {
    const envoi = a.get('parEnvoi');
    // Enceinte (accessoire « en option ») : sortie seulement quand la préparation dit qu'elle part dans le colis.
    if (envoi === 'option' && commande.get('enceinteFournie') === true && /enceinte|haut-parleur/i.test(a.get('nom') || '')) {
      await a.ref.update({ quantite: FieldValue.increment(-1), majLe: FieldValue.serverTimestamp() });
      sortis.push(a.get('nom'));
      continue;
    }
    if (!envoi || (envoi !== 'tous' && envoi !== formule)) continue;
    await a.ref.update({ quantite: FieldValue.increment(-1), majLe: FieldValue.serverTimestamp() });
    sortis.push(a.get('nom'));
  }
  return sortis;
}

// Cartes SIM et accessoires lus sur une facture : cartes « en stock », accessoires ajoutés au stock
// (à un accessoire du même nom, sinon nouveau). Renvoie ce qui a été fait, en clair.
async function entrerMateriel(m, { depense, numeroFacture, source }, qui) {
  const fait = [];
  const c = m && m.cartesSim;
  if (c) {
    const batch = db().batch();
    for (let i = 0; i < c.quantite; i++) {
      batch.set(db().collection('sims').doc(), {
        statut: 'stock', operateur: c.operateur, iccid: c.iccids[i] || null, numero: c.numeros[i] || null,
        prix: c.forfait, tablette: null, depense: depense || null,
        note: [numeroFacture ? `Facture ${numeroFacture}` : null, source].filter(Boolean).join(' · ') || null,
        creeLe: FieldValue.serverTimestamp(), par: qui,
      });
    }
    await batch.commit();
    fait.push(`${c.quantite} carte${c.quantite > 1 ? 's' : ''} SIM en stock`);
  }
  const accessoires = m && m.accessoires && m.accessoires.length ? await db().collection('accessoires').get() : null;
  for (const a of (m && m.accessoires) || []) {
    const existant = accessoires.docs.find((d) => memeAccessoire(d.get('nom'), a.nom));
    if (existant) {
      await existant.ref.update({
        quantite: FieldValue.increment(a.quantite),
        ...(a.prixUnitaire != null ? { prixAchat: a.prixUnitaire } : {}),
        majLe: FieldValue.serverTimestamp(),
      });
      fait.push(`${a.quantite} × ${existant.get('nom')}`);
    } else {
      await db().collection('accessoires').add({
        nom: a.nom, quantite: a.quantite, prixAchat: a.prixUnitaire, parEnvoi: '', seuil: null,
        creeLe: FieldValue.serverTimestamp(), par: qui,
      });
      fait.push(`${a.quantite} × ${a.nom} (nouvel accessoire)`);
    }
  }
  if (fait.length && depense) await db().doc(`depenses/${depense}`).update({ materiel: fait });
  return fait;
}

// ---------- Cartes SIM ----------

const dateOuNull = (v) => (Number.isFinite(v) ? v : null);

// Saisie d'une ligne SIM → champs enregistrés (montants en centimes, dates en ms).
function champsSim(c) {
  const champs = {};
  if ('statut' in c) {
    if (!STATUTS_SIM[c.statut]) throw new HttpsError('invalid-argument', 'Statut inconnu.');
    champs.statut = c.statut;
  }
  for (const cle of ['operateur', 'numero', 'client', 'note']) if (cle in c) champs[cle] = texte(c[cle], cle === 'note' ? 1000 : 80);
  if ('iccid' in c) champs.iccid = texte(String(c.iccid || '').replace(/\s/g, ''), 30);
  if ('cb' in c) champs.cb = texte(String(c.cb || '').replace(/\D/g, '').slice(-4), 4);
  if ('cbExp' in c) champs.cbExp = /^\d{4}-\d{2}$/.test(c.cbExp || '') ? c.cbExp : null;
  if ('go' in c) champs.go = Number.isFinite(c.go) && c.go >= 0 ? c.go : null;
  for (const cle of ['prix', 'prixApres']) if (cle in c) champs[cle] = centimes(c[cle]);
  for (const cle of ['finPromo', 'activation', 'activerAvant']) if (cle in c) champs[cle] = dateOuNull(c[cle]);
  // Achat de la carte (dépense), vérifié par enregistrerSim.
  if ('depense' in c) champs.depense = texte(c.depense, 100) || null;
  return champs;
}

// Identifiant d'une dépense existante, ou null (lien retiré).
async function depenseExistante(id) {
  const v = texte(id, 100) || null;
  if (v && !(await db().doc(`depenses/${v}`).get()).exists) throw new HttpsError('not-found', 'Achat introuvable.');
  return v;
}

// Ce que la fiche de la tablette garde de sa ligne (utilisé par l'envoi, la rentabilité et les alertes).
function simSurTablette(id, l) {
  return {
    simId: id,
    sim: l.numero || (l.iccid ? `ICCID …${l.iccid.slice(-4)}` : 'SIM'),
    simOperateur: l.operateur || null,
    simCout: coutLigne(l, Date.now()),
  };
}
const SANS_SIM = { simId: null, sim: null, simOperateur: null, simCout: null };

// Crée (id null) ou modifie une ligne SIM, et tient à jour la fiche de sa tablette. Renvoie l'id.
async function enregistrerSim(id, c, qui) {
  const ref = id ? db().doc(`sims/${id}`) : db().collection('sims').doc();
  const avant = id ? (await ref.get()).data() : {};
  if (!avant) throw new HttpsError('not-found', 'Ligne introuvable.');
  const champs = champsSim(c);
  if ('depense' in champs) champs.depense = await depenseExistante(champs.depense);
  if (!id && !champs.statut) champs.statut = 'stock';
  const ligne = { ...avant, ...champs };
  // Tablette : une seule ligne par tablette ; une ligne résiliée n'est plus sur aucune tablette.
  let tablette = 'tablette' in c ? texte(c.tablette, 100) : avant.tablette || null;
  if (ligne.statut === 'resiliee') tablette = null;
  if (tablette) {
    // Une carte sans numéro ni ICCID ne se retrouverait plus : pas de tablette tant qu'elle n'est pas identifiée
    // (une carte déjà dans une tablette peut toujours passer dans sa remplaçante).
    if (!ligne.numero && !ligne.iccid && !avant.tablette) {
      throw new HttpsError('failed-precondition', "Notez d'abord le numéro ou l'ICCID de cette carte SIM : une carte sans identifiant ne peut pas aller dans une tablette.");
    }
    const t = await db().doc(`stock/${tablette}`).get();
    if (!t.exists) throw new HttpsError('not-found', 'Tablette introuvable.');
    const autre = t.get('simId');
    if (autre && autre !== ref.id) await db().doc(`sims/${autre}`).update({ tablette: null }).catch(() => null);
  }
  if (avant.tablette && avant.tablette !== tablette) {
    await db().doc(`stock/${avant.tablette}`).update(SANS_SIM).catch(() => null);
  }
  ligne.tablette = tablette;
  await ref.set({
    ...champs,
    tablette,
    majLe: FieldValue.serverTimestamp(),
    ...(!id ? { creeLe: FieldValue.serverTimestamp(), par: qui } : {}),
  }, { merge: true });
  if (tablette) await db().doc(`stock/${tablette}`).update(simSurTablette(ref.id, ligne));
  return ref.id;
}

exports.gestionSim = onCall(async (request) => {
  verifierAdmin(request);
  const d = request.data || {};
  const qui = request.auth.token.email || request.auth.uid;

  if (d.action === 'supprimer') {
    const ref = db().doc(`sims/${d.id || '-'}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Ligne introuvable.');
    if (snap.get('tablette')) await db().doc(`stock/${snap.get('tablette')}`).update(SANS_SIM).catch(() => null);
    await ref.delete();
    return { ok: true };
  }

  if (d.action !== 'ajouter' && d.action !== 'modifier') throw new HttpsError('invalid-argument', 'Action inconnue.');
  return { ok: true, id: await enregistrerSim(d.action === 'ajouter' ? null : d.id || '-', d.champs || {}, qui) };
});

// ---------- Accessoires (clé 4G, prise USB…) ----------

function champsAccessoire(c) {
  const champs = {};
  if ('nom' in c) champs.nom = texte(c.nom, 80);
  if ('parEnvoi' in c) champs.parEnvoi = c.parEnvoi in ENVOIS_ACCESSOIRE ? c.parEnvoi : '';
  if ('quantite' in c) champs.quantite = Number.isInteger(c.quantite) && Math.abs(c.quantite) <= 10000 ? c.quantite : 0;
  if ('seuil' in c) champs.seuil = Number.isInteger(c.seuil) && c.seuil >= 0 ? c.seuil : null;
  if ('prixAchat' in c) champs.prixAchat = centimes(c.prixAchat);
  // Revient avec la tablette et repart chez le client suivant (chargeur, housse), sinon consommé à chaque envoi.
  if ('retour' in c) champs.retour = c.retour === true;
  if ('note' in c) champs.note = texte(c.note, 1000);
  // Achats de cet accessoire (une dépense par livraison), vérifiés par gestionAccessoire.
  if ('depenses' in c) {
    champs.depenses = [...new Set((Array.isArray(c.depenses) ? c.depenses : []).map((x) => texte(x, 100)).filter(Boolean))].slice(-50);
  }
  return champs;
}

exports.gestionAccessoire = onCall(async (request) => {
  verifierAdmin(request);
  const d = request.data || {};
  const qui = request.auth.token.email || request.auth.uid;

  if (d.action === 'ajouter') {
    const champs = champsAccessoire({ quantite: 0, parEnvoi: '', ...(d.champs || {}) });
    if (!champs.nom) throw new HttpsError('invalid-argument', 'Nom manquant.');
    const ref = await db().collection('accessoires').add({ ...champs, creeLe: FieldValue.serverTimestamp(), par: qui });
    return { ok: true, id: ref.id };
  }
  const ref = db().doc(`accessoires/${d.id || '-'}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Accessoire introuvable.');

  if (d.action === 'modifier') {
    const champs = champsAccessoire(d.champs || {});
    if ('nom' in champs && !champs.nom) throw new HttpsError('invalid-argument', 'Nom manquant.');
    for (const x of champs.depenses || []) await depenseExistante(x);
    await ref.update({ ...champs, majLe: FieldValue.serverTimestamp() });
    return { ok: true };
  }
  // Livraison reçue : quantité ajoutée au stock, et la dépense si un montant est donné.
  if (d.action === 'entree') {
    const n = Number(d.quantite);
    if (!Number.isInteger(n) || n < 1 || n > 10000) throw new HttpsError('invalid-argument', 'Quantité invalide.');
    const montant = centimes(d.montant);
    await ref.update({
      quantite: FieldValue.increment(n),
      ...(montant ? { prixAchat: Math.round(montant / n) } : {}),
      majLe: FieldValue.serverTimestamp(),
    });
    if (montant) {
      const dep = await ajouterDepense({
        date: Date.now(), categorie: 'materiel', fournisseur: d.fournisseur, libelle: `${n} × ${snap.get('nom')}`, montant,
      }, qui);
      await ref.update({ depenses: FieldValue.arrayUnion(dep.id) });
    }
    return { ok: true };
  }
  if (d.action === 'supprimer') {
    await ref.delete();
    return { ok: true };
  }
  throw new HttpsError('invalid-argument', 'Action inconnue.');
});

// ---------- Dépenses (registre des achats) ----------

// Dépense du registre des achats.
async function ajouterDepense(d, qui) {
  const montant = centimes(d.montant);
  if (montant == null || montant === 0) throw new HttpsError('invalid-argument', 'Montant manquant (en centimes).');
  if (!CATEGORIES[d.categorie]) throw new HttpsError('invalid-argument', 'Catégorie inconnue.');
  const libelle = texte(d.libelle);
  if (!libelle) throw new HttpsError('invalid-argument', 'Libellé manquant.');
  const date = ms(d.date) || Date.now();
  const jour = new Date(date).getUTCDate();
  const ref = await db().collection('depenses').add({
    date: Timestamp.fromMillis(date),
    categorie: d.categorie,
    fournisseur: texte(d.fournisseur),
    numero: texte(d.numero, 80),
    libelle,
    montant,
    tva: centimes(d.tva),
    justificatif: lien(d.justificatif),
    aVerifier: d.aVerifier === true,
    source: texte(d.source),
    // Dépense mensuelle (hébergement, forfaits…) : recopiée chaque mois par gestionAutomatique.
    recurrence: d.recurrente === true ? 'mensuelle' : null,
    jourRecurrence: d.recurrente === true ? jour : null,
    prochaine: d.recurrente === true ? Timestamp.fromMillis(moisSuivant(date, jour)) : null,
    creeLe: FieldValue.serverTimestamp(),
    creePar: qui,
  });
  return { ok: true, id: ref.id };
}

// Champs modifiables d'une dépense, vérifiés comme à la création.
function champsDepense(c) {
  const maj = {};
  if ('libelle' in c) {
    maj.libelle = texte(c.libelle);
    if (!maj.libelle) throw new HttpsError('invalid-argument', 'Libellé manquant.');
  }
  if ('fournisseur' in c) maj.fournisseur = texte(c.fournisseur);
  if ('numero' in c) maj.numero = texte(c.numero, 80);
  if ('montant' in c) {
    maj.montant = centimes(c.montant);
    if (!maj.montant) throw new HttpsError('invalid-argument', 'Montant invalide (en centimes).');
  }
  if ('tva' in c) {
    maj.tva = c.tva == null || c.tva === '' ? null : centimes(c.tva);
    if (c.tva != null && c.tva !== '' && maj.tva == null) throw new HttpsError('invalid-argument', 'TVA invalide (en centimes).');
  }
  if ('categorie' in c) {
    if (!CATEGORIES[c.categorie]) throw new HttpsError('invalid-argument', 'Catégorie inconnue.');
    maj.categorie = c.categorie;
  }
  if ('date' in c) {
    const t = Number(c.date);
    if (!Number.isFinite(t) || t < Date.UTC(2020, 0, 1) || t > Date.now() + 366 * 86400000) throw new HttpsError('invalid-argument', 'Date invalide.');
    maj.date = Timestamp.fromMillis(t);
  }
  return maj;
}

// « AAAA-MM » du mois (à Paris) d'un instant.
function moisDeParis(t) {
  const d = new Date(t + decalageParis(t));
  return cleMois(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

exports.gestionDepense = onCall(async (request) => {
  verifierAdmin(request);
  const d = request.data || {};
  if (d.action === 'ajouter') {
    const qui = request.auth.token.email || request.auth.uid;
    const r = await ajouterDepense(d, qui);
    r.materiel = await entrerMateriel(materielLu(d.materiel, true), { depense: r.id, numeroFacture: d.numero }, qui);
    return r;
  }
  // Dépense créée depuis une facture reçue par e-mail, relue par l'administrateur.
  if (d.action === 'verifier') {
    const ref = db().doc(`depenses/${d.id || '-'}`);
    if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Dépense introuvable.');
    await ref.update({ aVerifier: false });
    return { ok: true };
  }
  // Correction d'une dépense (facture mal lue, faute de frappe) : seuls les champs envoyés changent.
  if (d.action === 'modifier') {
    const ref = db().doc(`depenses/${d.id || '-'}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Dépense introuvable.');
    const maj = champsDepense(d.champs || {});
    if (!Object.keys(maj).length) throw new HttpsError('invalid-argument', 'Rien à modifier.');
    await ref.update({ ...maj, majLe: FieldValue.serverTimestamp(), majPar: request.auth.token.email || request.auth.uid });
    // Mois déjà clôturé (livres envoyés) : la page propose de le refaire.
    const clos = (await db().doc('gestion/archives').get()).get('mois') || {};
    const moisTouches = [ms(snap.get('date')), maj.date ? maj.date.toMillis() : null].filter(Boolean).map(moisDeParis);
    return { ok: true, moisClos: [...new Set(moisTouches)].filter((m) => clos[m]) };
  }
  if (d.action === 'arreter') {
    const ref = db().doc(`depenses/${d.id || '-'}`);
    if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Dépense introuvable.');
    await ref.update({ recurrence: null, prochaine: null });
    return { ok: true };
  }
  if (d.action === 'supprimer') {
    const ref = db().doc(`depenses/${d.id || '-'}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Dépense introuvable.');
    await ref.delete();
    await effacerPieces(snap.get('pieces'));
    return { ok: true };
  }
  throw new HttpsError('invalid-argument', 'Action inconnue.');
});

// ---------- Stripe : factures, encaissements, abonnements ----------

const MAX_LIGNES = 5000;

function versFacture(f) {
  return {
    id: f.id,
    numero: f.number || null,
    le: f.created * 1000,
    client: f.customer_name || null,
    email: f.customer_email || null,
    abonnement: typeof f.subscription === 'string' ? f.subscription
      : (f.subscription && f.subscription.id) || null,
    statut: f.status,
    total: f.total,
    ht: f.total_excluding_tax != null ? f.total_excluding_tax : f.total,
    tva: f.tax != null ? f.tax
      : (f.total_taxes || []).reduce((s, t) => s + (t.amount || 0), 0),
    paye: f.amount_paid,
    du: f.amount_remaining,
    lignes: ((f.lines && f.lines.data) || []).map((l) => l.description).filter(Boolean).join(' + '),
    lienPdf: f.invoice_pdf || null,
    lienPage: f.hosted_invoice_url || null,
  };
}

async function tout(liste) {
  const lignes = [];
  for await (const x of liste) {
    lignes.push(x);
    if (lignes.length >= MAX_LIGNES) break;
  }
  return lignes;
}

// Mouvements Stripe (balance transactions) d'une période, avec le client du paiement d'origine.
// periode : { gte, lt } en secondes.
async function lireMouvements(periode) {
  const mouvements = await tout(stripe().balanceTransactions.list({
    created: periode, limit: 100, expand: ['data.source'],
  }));
  // Remboursements : le client est sur le paiement d'origine.
  const charges = new Map();
  const aLire = [...new Set(mouvements
    .map((bt) => bt.source && typeof bt.source === 'object' && typeof bt.source.charge === 'string' && bt.source.charge)
    .filter(Boolean))];
  for (const id of aLire.slice(0, 200)) {
    charges.set(id, await stripe().charges.retrieve(id).catch(() => null));
  }
  return mouvements.map((bt) => {
    const source = bt.source && typeof bt.source === 'object' ? bt.source : {};
    const charge = source.object === 'charge' ? source
      : (charges.get(source.charge) || {});
    const facturation = charge.billing_details || {};
    return {
      id: bt.id,
      le: bt.created * 1000,
      disponibleLe: bt.available_on ? bt.available_on * 1000 : null,
      type: bt.type,
      nature: natureMouvement(bt),
      montant: bt.amount,
      frais: bt.fee,
      net: bt.net,
      description: bt.description || source.description || null,
      client: facturation.name || null,
      email: facturation.email || charge.receipt_email || null,
      facture: typeof charge.invoice === 'string' ? charge.invoice
        : (charge.invoice && charge.invoice.id) || null,
      source: source.id || null,
    };
  });
}

exports.gestionStripe = onCall({ secrets: [STRIPE_SECRET], timeoutSeconds: 120 }, async (request) => {
  verifierAdmin(request);
  const { debut, fin } = request.data || {};
  if (!Number.isFinite(debut) || !Number.isFinite(fin) || fin <= debut) {
    throw new HttpsError('invalid-argument', 'Période invalide.');
  }
  const periode = { gte: Math.floor(debut / 1000), lt: Math.floor(fin / 1000) };

  const [factures, mouvements, abonnements] = await Promise.all([
    tout(stripe().invoices.list({ created: periode, limit: 100 })),
    lireMouvements(periode),
    tout(stripe().subscriptions.list({ status: 'all', limit: 100 })),
  ]);

  return {
    factures: factures.map(versFacture),
    mouvements,
    abonnements: abonnements.map((a) => ({
      id: a.id,
      statut: a.status,
      debut: a.start_date * 1000,
      finEssai: a.trial_end ? a.trial_end * 1000 : null,
      finLe: a.ended_at ? a.ended_at * 1000 : null,
      arretPrevu: a.cancel_at ? a.cancel_at * 1000 : null,
      formule: (a.metadata && a.metadata.formule) || null,
      tablette: (a.metadata && a.metadata.tablette) || null,
      mensuel: mensuel(a),
    })),
  };
});

// Factures (créées par Stripe à chaque paiement de l'abonnement) et autres paiements d'une commande.
exports.gestionCommande = onCall({ secrets: [STRIPE_SECRET] }, async (request) => {
  verifierAdmin(request);
  const { commande } = request.data || {};
  if (typeof commande !== 'string' || !commande) throw new HttpsError('invalid-argument', 'Commande manquante.');
  const snap = await db().doc(`commandes/${commande}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Commande introuvable.');
  // Commande offerte : ni facture ni paiement.
  if (snap.get('offerte')) return { factures: [], paiements: [] };
  const client = snap.get('stripeCustomerId');
  // Commande sans abonnement Stripe lisible (commande d'essai, clé de test changée) : on le dit au lieu d'échouer.
  let factures;
  let paiements;
  try {
    [factures, paiements] = await Promise.all([
      commande.startsWith('sub_') ? tout(stripe().invoices.list({ subscription: commande, limit: 100 })) : [],
      client ? tout(stripe().charges.list({ customer: client, limit: 100 })) : [],
    ]);
  } catch (e) {
    logger.warn(`Commande ${commande} : Stripe illisible`, e.message);
    return { factures: [], paiements: [], erreur: `Stripe ne connaît pas cette commande (${e.message}).` };
  }
  return {
    factures: factures.map(versFacture),
    paiements: paiements.map((c) => ({
      id: c.id,
      le: c.created * 1000,
      montant: c.amount,
      rembourse: c.amount_refunded,
      statut: c.status,
      description: c.description || null,
      facture: typeof c.invoice === 'string' ? c.invoice : (c.invoice && c.invoice.id) || null,
      recu: c.receipt_url || null,
    })),
  };
});

// ---------- Pièces jointes ----------

// Contenu envoyé en base64 par la page : 6 Mo au plus pour rester sous la limite des fonctions appelables.
const MAX_PIECE = 6 * 1024 * 1024;
const TYPES_PIECE = /^(application\/pdf|image\/(png|jpeg|webp|heic|heif|gif))$/;
const COLLECTIONS_PIECE = ['stock', 'depenses'];

function nomFichier(nom) {
  const t = String(nom || 'piece').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-80);
  return t || 'piece';
}

// Genre d'un document choisi à l'ajout (page tablette) : photo, bon de garantie, facture, autre.
const GENRES_PIECE = ['photo', 'garantie', 'facture', 'autre'];

async function enregistrerPiece(collection, id, nomBrut, type, contenu, genre) {
  const nom = texte(nomBrut, 120) || 'piece';
  const chemin = `gestion/${collection}/${id}/${Date.now()}-${nomFichier(nom)}`;
  await stockage().file(chemin).save(contenu, { contentType: type, resumable: false });
  const piece = { nom, chemin, type, taille: contenu.length, le: Date.now(), ...(GENRES_PIECE.includes(genre) ? { genre } : {}) };
  await db().doc(`${collection}/${id}`).update({ pieces: FieldValue.arrayUnion(piece) });
  return piece;
}

exports.gestionPiece = onCall({ memory: '512MiB' }, async (request) => {
  verifierAdmin(request);
  const d = request.data || {};
  const bucket = stockage();

  if (d.action === 'lire') {
    if (typeof d.chemin !== 'string' || !d.chemin.startsWith('gestion/')) {
      throw new HttpsError('invalid-argument', 'Pièce inconnue.');
    }
    const fichier = bucket.file(d.chemin);
    const [existe] = await fichier.exists();
    if (!existe) throw new HttpsError('not-found', 'Pièce introuvable.');
    const [[contenu], [meta]] = await Promise.all([fichier.download(), fichier.getMetadata()]);
    return { contenu: contenu.toString('base64'), type: meta.contentType || 'application/octet-stream' };
  }

  if (!COLLECTIONS_PIECE.includes(d.collection) || typeof d.id !== 'string' || !d.id) {
    throw new HttpsError('invalid-argument', 'Fiche inconnue.');
  }
  const ref = db().doc(`${d.collection}/${d.id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Fiche introuvable.');

  if (d.action === 'ajouter') {
    if (!TYPES_PIECE.test(d.type || '')) throw new HttpsError('invalid-argument', 'PDF ou photo seulement.');
    const contenu = Buffer.from(String(d.contenu || ''), 'base64');
    if (!contenu.length) throw new HttpsError('invalid-argument', 'Fichier vide.');
    if (contenu.length > MAX_PIECE) throw new HttpsError('invalid-argument', 'Fichier trop lourd (6 Mo au plus).');
    const piece = await enregistrerPiece(d.collection, d.id, d.nom, d.type, contenu, d.genre);
    // Facture jointe à la main sur un achat venu d'une confirmation de commande : plus de rappel.
    if (snap.get('confirmation')) await ref.update({ confirmation: false });
    return { ok: true, piece };
  }

  if (d.action === 'retirer') {
    const pieces = snap.get('pieces') || [];
    const piece = pieces.find((p) => p.chemin === d.chemin);
    if (!piece) throw new HttpsError('not-found', 'Pièce introuvable.');
    await ref.update({ pieces: FieldValue.arrayRemove(piece) });
    await bucket.file(piece.chemin).delete().catch(() => null);
    return { ok: true };
  }

  throw new HttpsError('invalid-argument', 'Action inconnue.');
});

// ---------- Lecture automatique d'une facture d'achat ----------

const TYPES_LECTURE = /^(application\/pdf|image\/(png|jpeg|webp|gif))$/;

// Texte d'un e-mail sans facture jointe (confirmation de commande Cdiscount, Temu…), lu comme un justificatif.
function corpsDuMail(m) {
  let t = m && m.text ? m.text : '';
  if (!t.trim() && m && typeof m.html === 'string') {
    t = m.html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&euro;/g, '€');
  }
  t = t.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  if (t.length < 150) return null;
  const entete = [`De : ${(m.from && m.from.text) || ''}`, `Objet : ${m.subject || ''}`,
    m.date ? `Date : ${new Date(m.date).toISOString().slice(0, 10)}` : ''].filter(Boolean).join('\n');
  const contenu = Buffer.from(`${entete}\n\n${t.slice(0, 60000)}`, 'utf8');
  return { filename: 'confirmation-commande.txt', contentType: 'text/plain', content: contenu, size: contenu.length };
}

// Une facture qui arrive après la confirmation de commande du même achat (même vendeur, même montant, à 30 jours).
function memeAchat(depense, r) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return !!depense.confirmation && !!r.fournisseur && norm(depense.fournisseur) === norm(r.fournisseur)
    && depense.montant === r.montant && Math.abs((depense.date || 0) - (r.date || depense.date || 0)) <= 30 * 24 * 3600 * 1000;
}
const CONSIGNE_LECTURE = `Tu lis une facture d'achat (ou un ticket) reçue par Papote, une petite entreprise française
qui prête des tablettes à des personnes âgées et leur famille. Remplis chaque champ d'après le document seulement :
null quand l'information n'y figure pas, jamais d'invention. Montants en euros, tels qu'imprimés.
Catégories : tablettes (achat de tablettes), sim (cartes SIM, forfaits mobiles), expedition (transport, colis,
étiquettes, emballages), hebergement (serveurs, Firebase, Google Cloud, nom de domaine), logiciels (abonnements
logiciels, IA), publicite (annonces, réseaux sociaux), materiel (petit matériel : câbles, chargeurs, supports),
autre. Pour un achat de tablettes, remplis aussi « tablettes » avec les numéros de série (IMEI ou S/N) lisibles.
Pour des cartes SIM achetées (kits, nouvelles lignes), remplis « cartesSim » avec les ICCID et numéros lisibles ;
une facture mensuelle de forfaits reste une simple dépense (cartesSim null). Le petit matériel qui part avec les
tablettes (clé ou routeur 4G, prise, chargeur, câble, support) va dans « accessoires ».
Une confirmation de commande d'un site marchand (Cdiscount, Temu, Amazon…) qui donne le montant payé compte comme
justificatif : estUneFacture vrai et confirmationCommande vrai, numero = numéro de commande. Une publicité, une lettre
d'information ou un avis d'expédition sans montant payé n'est pas une facture.`;

// contenu : fichier en base64. Erreur HttpsError lisible si la lecture échoue.
async function lireDocument(contenu, type) {
  const document = type === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: contenu } }
    : type === 'text/plain'
      ? { type: 'document', source: { type: 'text', media_type: 'text/plain', data: Buffer.from(contenu, 'base64').toString('utf8') } }
      : { type: 'image', source: { type: 'base64', media_type: type, data: contenu } };
  let reponse;
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
    reponse = await client.beta.messages.create({
      model: MODELE_LECTURE,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: CONSIGNE_LECTURE,
      messages: [{ role: 'user', content: [document, { type: 'text', text: 'Lis ce document.' }] }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA_FACTURE } },
    });
  } catch (e) {
    logger.warn('Lecture de facture impossible', e.message);
    throw new HttpsError('unavailable', 'La lecture automatique ne répond pas. Remplissez la fiche à la main.');
  }
  const bloc = (reponse.content || []).find((b) => b.type === 'text');
  if (reponse.stop_reason !== 'end_turn' || !bloc) {
    throw new HttpsError('failed-precondition', 'Ce document n\'a pas pu être lu. Remplissez la fiche à la main.');
  }
  try {
    return lectureVersFormulaire(JSON.parse(bloc.text));
  } catch {
    throw new HttpsError('failed-precondition', 'Ce document n\'a pas pu être lu. Remplissez la fiche à la main.');
  }
}

exports.gestionLireFacture = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 180, memory: '512MiB' },
  async (request) => {
    verifierAdmin(request);
    const d = request.data || {};
    if (!TYPES_LECTURE.test(d.type || '')) throw new HttpsError('invalid-argument', 'PDF, JPEG ou PNG seulement.');
    const contenu = String(d.contenu || '');
    if (!contenu || contenu.length > MAX_PIECE * 1.4) throw new HttpsError('invalid-argument', 'Fichier vide ou trop lourd.');
    return lireDocument(contenu, d.type);
  });

// ---------- Automatismes (chaque nuit, ou tout de suite depuis l'accueil) ----------

const JOUR = 24 * 60 * 60 * 1000;
const FENETRE = 40 * JOUR; // ce qui s'est passé depuis 40 jours est revu chaque nuit

// Matériel non rendu : le prélèvement (restitutions ou tabletteRendue, index.js) n'a pas de facture.
// On en fait une, marquée payée hors Stripe, pour que chaque encaissement ait sa facture.
// Ligne de facture : le détail (« tablette, routeur ») vient de la description du prélèvement quand il y est.
function descriptionNonRendu(c) {
  const d = String(c.description || '').trim();
  return d && /non rendu/i.test(d) ? `${d} (indemnité prévue au contrat)` : 'Matériel Papote non rendu (indemnité prévue au contrat)';
}

async function facturerPenalites(depuis, bilan) {
  const charges = await tout(stripe().charges.list({ created: { gte: Math.floor(depuis / 1000) }, limit: 100 }));
  for (const c of charges) {
    if (c.status !== 'succeeded' || c.invoice || (c.metadata && c.metadata.facture)) continue;
    if (natureMouvement({ type: 'charge', source: c }) !== 'tablette-non-rendue' || !c.customer) continue;
    try {
      let facture = (await stripe().invoices.search({ query: `metadata['charge']:'${c.id}'` })).data[0];
      if (!facture) {
        facture = await stripe().invoices.create({
          customer: typeof c.customer === 'string' ? c.customer : c.customer.id,
          collection_method: 'charge_automatically',
          auto_advance: false,
          pending_invoice_items_behavior: 'exclude',
          metadata: { charge: c.id, commande: (c.metadata && c.metadata.commande) || '' },
        });
        await stripe().invoiceItems.create({
          customer: facture.customer,
          invoice: facture.id,
          amount: c.amount,
          currency: c.currency,
          description: descriptionNonRendu(c),
        });
      }
      if (facture.status === 'draft') facture = await stripe().invoices.finalizeInvoice(facture.id, { auto_advance: false });
      if (facture.status === 'open') facture = await stripe().invoices.pay(facture.id, { paid_out_of_band: true });
      await stripe().charges.update(c.id, { metadata: { facture: facture.id } });
      bilan.factures.push(facture.number || facture.id);
    } catch (e) {
      bilan.erreurs.push(`Facture du paiement ${c.id} : ${e.message}`);
    }
  }
}

// Remboursement d'un paiement facturé : avoir rattaché à la facture (la facture seule ne suffit plus).
async function avoirsRemboursements(depuis, bilan) {
  const remboursements = await tout(stripe().refunds.list({
    created: { gte: Math.floor(depuis / 1000) }, limit: 100, expand: ['data.charge'],
  }));
  for (const r of remboursements) {
    if (r.status !== 'succeeded' || (r.metadata && r.metadata.avoir)) continue;
    const c = r.charge && typeof r.charge === 'object' ? r.charge : {};
    const facture = (typeof c.invoice === 'string' ? c.invoice : c.invoice && c.invoice.id)
      || (c.metadata && c.metadata.facture);
    if (!facture) continue; // paiement sans facture : rien à annuler
    try {
      const existants = await tout(stripe().creditNotes.list({ invoice: facture, limit: 100 }));
      let avoir = existants.find((a) => (typeof a.refund === 'string' ? a.refund : a.refund && a.refund.id) === r.id);
      if (!avoir) {
        avoir = await stripe().creditNotes.create({
          invoice: facture,
          refund: r.id,
          lines: [{
            type: 'custom_line_item', description: 'Remboursement', quantity: 1, unit_amount: r.amount,
          }],
        });
        bilan.avoirs.push(avoir.number || avoir.id);
      }
      await stripe().refunds.update(r.id, { metadata: { avoir: avoir.id } });
    } catch (e) {
      bilan.erreurs.push(`Avoir du remboursement ${r.id} : ${e.message}`);
    }
  }
}

// Dépenses mensuelles : la copie du mois est ajoutée au registre à son échéance.
async function depensesRecurrentes(maintenant, bilan) {
  const modeles = await db().collection('depenses').where('recurrence', '==', 'mensuelle').get();
  for (const modele of modeles.docs) {
    try {
      await db().runTransaction(async (tx) => {
        const snap = await tx.get(modele.ref);
        const m = snap.data();
        if (!m || m.recurrence !== 'mensuelle' || !m.prochaine) return;
        let prochaine = m.prochaine.toMillis();
        for (let i = 0; i < 12 && prochaine <= maintenant; i++) {
          tx.set(db().collection('depenses').doc(), {
            date: Timestamp.fromMillis(prochaine),
            categorie: m.categorie,
            fournisseur: m.fournisseur || null,
            numero: null,
            libelle: m.libelle,
            montant: m.montant,
            tva: m.tva == null ? null : m.tva,
            justificatif: null,
            recurrence: null,
            depuis: snap.id,
            creeLe: FieldValue.serverTimestamp(),
            creePar: 'automatique',
          });
          bilan.depenses += 1;
          prochaine = moisSuivant(prochaine, m.jourRecurrence);
        }
        tx.update(modele.ref, { prochaine: Timestamp.fromMillis(prochaine) });
      });
    } catch (e) {
      bilan.erreurs.push(`Dépense mensuelle « ${modele.get('libelle')} » : ${e.message}`);
    }
  }
}

async function synchroniserStock(bilan) {
  const [stock, commandes] = await Promise.all([
    db().collection('stock').where('commande', '!=', null).get(),
    db().collection('commandes').get(),
  ]);
  const parId = new Map(commandes.docs.map((d) => [d.id, d.data()]));
  for (const t of stock.docs) {
    const maj = stockAJour(t.data(), parId.get(t.get('commande')));
    if (!maj) continue;
    try {
      await t.ref.update({
        ...maj,
        majLe: FieldValue.serverTimestamp(),
        historique: FieldValue.arrayUnion({
          le: Date.now(), etat: maj.etat, par: 'automatique', commande: 'commande' in maj ? maj.commande : t.get('commande'),
        }),
      });
      bilan.stock.push(`${t.get('numero') || t.id} : ${ETATS[maj.etat]}`);
    } catch (e) {
      bilan.erreurs.push(`Tablette ${t.get('numero') || t.id} : ${e.message}`);
    }
  }
  // Fin de promo d'une ligne SIM : la tablette prend le nouveau prix (rentabilité).
  const maintenant = Date.now();
  for (const l of (await db().collection('sims').where('tablette', '!=', null).get()).docs) {
    const cout = coutLigne(l.data(), maintenant);
    const t = await db().doc(`stock/${l.get('tablette')}`).get();
    if (t.exists && t.get('simId') === l.id && t.get('simCout') !== cout) {
      await t.ref.update({ simCout: cout });
      bilan.stock.push(`${t.get('numero') || t.id} : forfait SIM à ${eurosTexte(cout || 0)}`);
    }
  }
}

// Fin de contrat : l'étiquette de retour part toute seule (aucun justificatif demandé au client). Seulement
// avec la vraie clé Stripe : en mode test, les commandes d'essai ne doivent pas coûter d'étiquettes.
async function etiquettesRetour(bilan) {
  if (!STRIPE_SECRET.value().startsWith('sk_live_')) return;
  const attendues = await db().collection('commandes').where('restitution.statut', '==', 'attendue').get();
  for (const snap of attendues.docs) {
    const c = snap.data();
    if (c.restitution.etiquette || (c.etiquettes && c.etiquettes.retour) || c.expedition !== 'envoyee') continue;
    try {
      await creerEtiquette(snap.id, 'retour', 'automatique');
      bilan.etiquettes = (bilan.etiquettes || []).concat(c.nom || c.email || snap.id);
    } catch (e) {
      bilan.erreurs.push(`Étiquette de retour de ${c.nom || c.email || snap.id} : ${e.message} (à créer depuis Commandes)`);
    }
  }
}

// « Le client a reçu le colis » d'après le suivi Sendcloud. Une commande déjà jumelée a quitté la liste
// des colis en route : rien à cocher.
// Colis de retour en cours : n° de suivi, lien et étape (« déposé au point relais »…) mis à jour chaque nuit.
async function retoursEnCours(bilan) {
  const attendues = await db().collection('commandes').where('restitution.statut', '==', 'attendue').get();
  const aSuivre = attendues.docs.filter((d) => d.get('etiquettes.retour.colis'));
  if (!aSuivre.length) return;
  const api = sendcloud.client(SENDCLOUD_API.value());
  for (const snap of aSuivre) {
    try {
      const s = await api.suivi(snap.get('etiquettes.retour.colis'));
      await snap.ref.update({
        'etiquettes.retour.suivi': s.suivi || snap.get('etiquettes.retour.suivi') || null,
        'etiquettes.retour.lienSuivi': s.lien || snap.get('etiquettes.retour.lienSuivi') || null,
        'etiquettes.retour.etape': s.etape || null,
        'etiquettes.retour.livre': s.livre,
      });
    } catch (e) {
      bilan.erreurs.push(`Suivi du retour de ${snap.get('nom') || snap.id} : ${e.message}`);
    }
  }
}

// La date notée (preparation.recuLe) est aussi la date de réception qui fait partir les 30 jours pour changer
// d'avis et le premier prélèvement (abonnement.js, receptionDe) : on suit aussi les commandes déjà reliées.
async function colisLivres(bilan) {
  const enRoute = await db().collection('commandes').where('expedition', '==', 'envoyee').get();
  const recent = (d) => { const e = d.get('envoyeeLe'); return !e || !e.toMillis || Date.now() - e.toMillis() < 60 * 864e5; };
  const aSuivre = enRoute.docs.filter((d) => !d.get('preparation.recuLe') && d.get('etiquettes.aller.colis') && recent(d));
  if (!aSuivre.length) return;
  const api = sendcloud.client(SENDCLOUD_API.value());
  for (const snap of aSuivre) {
    try {
      if (!(await api.livre(snap.get('etiquettes.aller.colis')))) continue;
      await snap.ref.update({ 'preparation.recuLe': Date.now(), 'preparation.recuPar': 'suivi Mondial Relay' });
      bilan.livres = (bilan.livres || []).concat(snap.get('nom') || snap.get('email') || snap.id);
    } catch (e) {
      bilan.erreurs.push(`Suivi du colis de ${snap.get('nom') || snap.id} : ${e.message}`);
    }
  }
}

async function automatiser(qui) {
  const maintenant = Date.now();
  const bilan = { factures: [], avoirs: [], depenses: 0, stock: [], erreurs: [] };
  await synchroniserStock(bilan);
  await rattraperJumelages(bilan);
  await copierBatteries(bilan).catch((e) => bilan.erreurs.push(`Batteries : ${e.message}`));
  await depensesRecurrentes(maintenant, bilan);
  await facturerPenalites(maintenant - FENETRE, bilan);
  await avoirsRemboursements(maintenant - FENETRE, bilan);
  await etiquettesRetour(bilan).catch((e) => bilan.erreurs.push(`Étiquettes de retour : ${e.message}`));
  await colisLivres(bilan).catch((e) => bilan.erreurs.push(`Suivi des colis : ${e.message}`));
  await retoursEnCours(bilan).catch((e) => bilan.erreurs.push(`Suivi des retours : ${e.message}`));
  await db().doc('gestion/automatique').set({ ...bilan, le: maintenant, par: qui });
  if (bilan.erreurs.length) logger.warn('Automatismes de gestion', bilan.erreurs);
  return bilan;
}

exports.gestionAutomatique = onSchedule(
  { schedule: 'every day 04:00', timeZone: 'Europe/Paris', secrets: [STRIPE_SECRET, SENDCLOUD_API, MAIL_MOT_DE_PASSE], timeoutSeconds: 300 },
  () => automatiser('automatique'));

exports.gestionAutomatiser = onCall({ secrets: [STRIPE_SECRET, SENDCLOUD_API, MAIL_MOT_DE_PASSE], timeoutSeconds: 300 }, async (request) => {
  verifierAdmin(request);
  return automatiser(request.auth.token.email || request.auth.uid);
});

// ---------- Réglages ----------

exports.gestionReglages = onCall(async (request) => {
  verifierAdmin(request);
  const d = request.data || {};
  const maj = {};
  for (const k of Object.keys(REGLAGES)) {
    if (!(k in d)) continue;
    const v = Number(d[k]);
    if (!Number.isFinite(v) || v < 0 || v > 1e9) throw new HttpsError('invalid-argument', `Valeur invalide : ${k}.`);
    maj[k] = v;
  }
  // { masquer: { cle, jours } } : masque une ligne « À faire » (jours 0 : la réaffiche) ; { masquer: { tout: true, jours: 0 } } : tout réafficher.
  if (d.masquer && typeof d.masquer === 'object') {
    const { cle, jours, tout } = d.masquer;
    if (!tout && (typeof cle !== 'string' || !cle || cle.length > 300)) throw new HttpsError('invalid-argument', 'Ligne à masquer invalide.');
    const n = jours == null ? MASQUER_JOURS : Number(jours);
    if (!Number.isFinite(n) || n < 0 || n > 30) throw new HttpsError('invalid-argument', 'Durée invalide.');
    const actuelles = tout ? [] : masqueesActives((await db().doc('gestion/reglages').get()).get('masquees')).filter((m) => m.cle !== cle);
    if (!tout && n > 0) actuelles.push({ cle, jusqua: Date.now() + n * 864e5 });
    await db().doc('gestion/reglages').set({ masquees: actuelles.slice(-200) }, { merge: true });
    return { ok: true, masquees: actuelles };
  }
  if (d.expediteur && typeof d.expediteur === 'object') {
    for (const k of CHAMPS_EXPEDITEUR) {
      const v = d.expediteur[k];
      if (v != null && (typeof v !== 'string' || v.length > 120)) throw new HttpsError('invalid-argument', `Valeur invalide : ${k}.`);
      maj[`expediteur.${k}`] = (v || '').trim();
    }
  }
  await db().doc('gestion/reglages').update(maj).catch(async (e) => {
    if (e.code !== 5) throw e;
    // Premier enregistrement : le document n'existe pas encore.
    const premier = {};
    for (const [k, v] of Object.entries(maj)) {
      if (k.startsWith('expediteur.')) (premier.expediteur = premier.expediteur || {})[k.slice(11)] = v;
      else premier[k] = v;
    }
    await db().doc('gestion/reglages').set(premier, { merge: true });
  });
  return { ok: true };
});

// ---------- Étiquettes Sendcloud ----------

// Range le PDF dans Storage avec un jeton de téléchargement : lien imprimable par l'admin et par le client.
async function rangerEtiquette(commande, sens, colis, pdf) {
  const chemin = `gestion/etiquettes/${commande}-${sens}-${colis}.pdf`;
  const jeton = require('node:crypto').randomUUID();
  const bucket = stockage();
  await bucket.file(chemin).save(pdf, {
    contentType: 'application/pdf', resumable: false, metadata: { metadata: { firebaseStorageDownloadTokens: jeton } },
  });
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(chemin)}?alt=media&token=${jeton}`;
}

// Crée l'étiquette Mondial Relay chez Sendcloud. Erreur à montrer telle quelle : HttpsError ; panne Sendcloud : Error.
async function creerEtiquette(commande, sens, qui) {
  const ref = db().doc(`commandes/${commande}`);
  const [snap, reglagesSnap] = await Promise.all([ref.get(), db().doc('gestion/reglages').get()]);
  if (!snap.exists) throw new HttpsError('not-found', 'Commande introuvable.');
  const c = snap.data();
  const reglages = lireReglages(reglagesSnap.data());
  const papote = sendcloud.adressePapote(reglages.expediteur);
  if (!papote) throw new HttpsError('failed-precondition', "Renseignez l'adresse d'expédition de Papote (Réglages, Étiquettes Sendcloud).");
  const cl = sendcloud.adresseClient(c);
  if (!cl) throw new HttpsError('failed-precondition', "Cette commande n'a pas d'adresse ni de point relais utilisable.");
  const poids = Math.max(0.1, (reglages.poidsColis || 1500) / 1000);
  const reference = c.code ? String(c.code) : commande.slice(-12);
  let api;
  try {
    api = sendcloud.client(SENDCLOUD_API.value());
  } catch (e) {
    throw new HttpsError('failed-precondition', e.message);
  }
  if (sens === 'aller') {
    const r = await api.envoi({ de: papote, vers: cl.adresse, pointRelais: cl.pointRelais, poids, reference });
    const url = await rangerEtiquette(commande, 'aller', r.colis, r.pdf);
    await ref.update({ 'etiquettes.aller': { colis: r.colis, suivi: r.suivi, url, le: Date.now(), par: qui } });
    return { ok: true, suivi: r.suivi, url };
  }
  const r = await api.retour({ de: cl.adresse, vers: papote, poids, reference });
  const url = await rangerEtiquette(commande, 'retour', r.colis, r.pdf);
  // N° et lien de suivi du retour, pour le suivre depuis l'admin et l'avis de résiliation.
  const suivi = await api.suivi(r.colis).catch(() => ({}));
  const maj = { 'etiquettes.retour': { colis: r.colis, url, le: Date.now(), par: qui,
    suivi: suivi.suivi || null, lienSuivi: suivi.lien || null, etape: suivi.etape || null } };
  const attendue = c.restitution && ['attendue', 'echec'].includes(c.restitution.statut);
  if (attendue) {
    // Fin de contrat : l'e-mail au client part avec commandeModifiee, comme une étiquette collée à la main.
    maj['restitution.etiquette'] = url;
    maj['restitution.etiquetteLe'] = FieldValue.serverTimestamp();
  }
  await ref.update(maj);
  if (!attendue && c.email) {
    // Remplacement d'un élément du kit : l'étiquette part tout de suite.
    await mail.envoyer({
      smtp: MAIL_SMTP.value(), expediteur: MAIL_EXPEDITEUR.value(), motDePasse: MAIL_MOT_DE_PASSE.value(),
      a: c.email, contenu: mail.etiquetteRetour({ nom: c.nom, lien: url, avant: null }),
    });
  }
  return { ok: true, url, envoyee: !!c.email };
}

// { commande, sens: 'aller' | 'retour' } : crée l'étiquette Mondial Relay chez Sendcloud.
// Aller : renvoie le n° de suivi pour le formulaire d'envoi. Retour : le client la reçoit par e-mail.
exports.gestionEtiquette = onCall({ secrets: [SENDCLOUD_API, MAIL_MOT_DE_PASSE], timeoutSeconds: 120 }, async (request) => {
  verifierAdmin(request);
  const qui = request.auth.token.email || request.auth.uid;
  const d = request.data || {};
  if (typeof d.commande !== 'string' || !d.commande || !['aller', 'retour'].includes(d.sens)) {
    throw new HttpsError('invalid-argument', 'Commande ou sens manquant.');
  }
  try {
    return await creerEtiquette(d.commande, d.sens, qui);
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error('Étiquette Sendcloud', e);
    throw new HttpsError('internal', e.message);
  }
});

// { commande, sens } : annule l'étiquette chez Sendcloud (ou constate qu'elle l'est déjà) pour pouvoir en refaire une.
exports.gestionAnnulerEtiquette = onCall({ secrets: [SENDCLOUD_API] }, async (request) => {
  verifierAdmin(request);
  const d = request.data || {};
  if (typeof d.commande !== 'string' || !d.commande || !['aller', 'retour'].includes(d.sens)) {
    throw new HttpsError('invalid-argument', 'Commande ou sens manquant.');
  }
  const ref = db().doc(`commandes/${d.commande}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Commande introuvable.');
  const e = snap.data().etiquettes && snap.data().etiquettes[d.sens];
  if (!e) return { ok: true };
  try {
    await sendcloud.client(SENDCLOUD_API.value()).annuler(e.colis);
  } catch (err) {
    throw new HttpsError('failed-precondition', err.message);
  }
  await ref.update({
    [`etiquettes.${d.sens}`]: FieldValue.delete(),
    'etiquettes.annulees': FieldValue.arrayUnion({ ...e, sens: d.sens, annuleeLe: Date.now(), par: request.auth.token.email || request.auth.uid }),
  });
  return { ok: true };
});

// { commande, email? } : renvoie au client le code de commande (rappel de jumelage), à l'e-mail de la commande
// ou à une autre adresse donnée par téléphone.
exports.gestionRenvoyerCode = onCall({ secrets: [MAIL_MOT_DE_PASSE] }, async (request) => {
  verifierAdmin(request);
  const d = request.data || {};
  if (typeof d.commande !== 'string' || !d.commande) throw new HttpsError('invalid-argument', 'Commande manquante.');
  const snap = await db().doc(`commandes/${d.commande}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Commande introuvable.');
  const c = snap.data();
  if (!c.code) throw new HttpsError('failed-precondition', 'Cette commande n\'a pas de code.');
  const a = typeof d.email === 'string' && d.email.trim() ? d.email.trim().toLowerCase() : c.email;
  if (!a || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) throw new HttpsError('invalid-argument', 'Adresse e-mail invalide.');
  const code = `${c.code.slice(0, 4)}-${c.code.slice(4)}`;
  await mail.envoyer({
    smtp: MAIL_SMTP.value(), expediteur: MAIL_EXPEDITEUR.value(), motDePasse: MAIL_MOT_DE_PASSE.value(),
    a, contenu: mail.rappelJumelage({ nom: c.nom, numero: c.expedition === 'envoyee' ? 1 : 2, code }),
  });
  await snap.ref.update({ codeRenvoye: FieldValue.arrayUnion({ a, le: Date.now() }) });
  return { ok: true, a };
});

// Abonnement Stripe arrêté (s'il tourne encore) et chaque facture payée remboursée de ce qui reste à rendre.
// Rejouable : une facture déjà remboursée (ici ou à la main dans Stripe) est sautée.
async function arreterEtRembourser(id) {
  const abo = await stripe().subscriptions.retrieve(id).catch(() => null);
  // Un abonnement fini (annulé, ou jamais payé : incomplete_expired) ne s'annule plus.
  if (abo && !['canceled', 'incomplete_expired'].includes(abo.status)) {
    await stripe().subscriptions.cancel(id, { prorate: false, invoice_now: false });
  }
  let rembourse = 0;
  const payees = await tout(stripe().invoices.list({ subscription: id, status: 'paid', limit: 100 }));
  for (const f of payees.filter((x) => x.amount_paid > 0 && x.payment_intent)) {
    const pi = await stripe().paymentIntents.retrieve(typeof f.payment_intent === 'string' ? f.payment_intent : f.payment_intent.id,
      { expand: ['latest_charge'] });
    const charge = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
    // Paiement SEPA pas encore abouti, ou déjà remboursé : rien à rembourser.
    if (pi.status !== 'succeeded' || !charge) continue;
    const reste = charge.amount - (charge.amount_refunded || 0);
    if (reste <= 0) continue;
    const r = await stripe().refunds.create({ payment_intent: pi.id, amount: reste, reason: 'requested_by_customer', metadata: { commande: id } },
      { idempotencyKey: `annulation-${f.id}-${reste}` });
    rembourse += r.amount;
  }
  return rembourse;
}

// Annulation d'une commande pas encore partie : abonnement Stripe arrêté, tout ce qui a été payé remboursé,
// tablette mise de côté rendue au stock, e-mail au client. Rejouable sans double remboursement.
exports.gestionAnnulerCommande = onCall({ secrets: [STRIPE_SECRET, MAIL_MOT_DE_PASSE] }, async (request) => {
  verifierAdmin(request);
  const id = texte((request.data || {}).commande, 100);
  if (!id) throw new HttpsError('invalid-argument', 'Commande manquante.');
  const ref = db().doc(`commandes/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Commande introuvable.');
  const c = snap.data();
  if (!['a-preparer', 'paiement-en-attente'].includes(c.expedition)) {
    throw new HttpsError('failed-precondition', c.expedition === 'annulee' ? 'Cette commande est déjà annulée.'
      : 'La tablette est déjà partie : arrêtez plutôt l\'abonnement, le client renverra la tablette.');
  }
  let rembourse = 0;
  // Abonnement inconnu de Stripe (commande de test, abonnement effacé) : rien à arrêter ni à rembourser,
  // la commande s'annule quand même, sans e-mail au client.
  let stripeIntrouvable = false;
  if (!c.offerte && id.startsWith('sub_')) {
    try {
      rembourse = await arreterEtRembourser(id);
    } catch (e) {
      if (e.code === 'resource_missing' || /No such subscription/i.test(e.message || '')) {
        stripeIntrouvable = true;
        logger.warn(`Commande ${id} : abonnement introuvable chez Stripe, annulée sans remboursement`);
      } else {
      // Erreur Stripe : un message lisible plutôt que « le serveur ne répond pas » ; rien n'est encore noté annulé.
      logger.error(`Commande ${id} : annulation Stripe impossible`, e.message);
      throw new HttpsError('aborted', `Stripe a refusé l'annulation : ${e.message}`);
      }
    }
  }
  const qui = request.auth.token.email || request.auth.uid;
  await ref.update({
    expedition: 'annulee', annulation: 'admin', annuleeLe: FieldValue.serverTimestamp(), annuleePar: qui,
    ...(rembourse ? { remboursement: { statut: 'fait', montant: rembourse, le: FieldValue.serverTimestamp() } } : {}),
  });
  // Tablette mise de côté pour cette commande : de nouveau libre.
  const tablettes = await db().collection('stock').where('commande', '==', id).get();
  for (const t of tablettes.docs.filter((x) => ['en-stock', 'preparee'].includes(x.get('etat')))) {
    await t.ref.update({
      commande: null, majLe: FieldValue.serverTimestamp(),
      historique: FieldValue.arrayUnion({ le: Date.now(), etat: t.get('etat'), par: qui, commande: null, motif: 'commande annulée' }),
    });
  }
  let mailEnvoye = false;
  if (c.email && !c.offerte && !stripeIntrouvable) {
    try {
      await mail.envoyer({
        smtp: MAIL_SMTP.value(), expediteur: MAIL_EXPEDITEUR.value(), motDePasse: MAIL_MOT_DE_PASSE.value(),
        a: c.email, contenu: mail.commandeAnnulee({ nom: c.nom, rembourse }),
      });
      mailEnvoye = true;
    } catch (e) {
      logger.error(`Commande ${id} : e-mail d'annulation non parti`, e.message);
    }
  }
  return { ok: true, rembourse, mailEnvoye, stripeIntrouvable };
});

// ---------- Identité des tablettes : préparation et jumelage ----------

// Fonctions de index.js (abonnements) dont le jumelage a besoin, branchées au chargement.
const vitrine = {};
exports.brancher = (f) => Object.assign(vitrine, f);

// Tablette perdue ou hors service : retirée de sa famille, jamais plus jumelée.
const ETATS_BLOQUES = ['perdue', 'hors-service'];

// Que faire quand une tablette du stock est jumelée à une famille (pure, testée).
// t : fiche stock ; commande : sa commande (ou null) ; fid : famille qui vient de la jumeler.
const ALERTE_SANS_COMMANDE = 'jumelée sans commande';
function suiteJumelage(t, commande, fid) {
  if (ETATS_BLOQUES.includes(t.etat)) return { refuser: true };
  if (!t.commande || !commande) return { alerte: ALERTE_SANS_COMMANDE };
  if (!commande.fid) return { relier: true };
  if (commande.fid !== fid) return { alerte: 'jumelée à une autre famille que celle de sa commande' };
  return {};
}

async function ficheDeLaTablette(p) {
  const par = async (champ, valeur) => (valeur
    ? (await db().collection('stock').where(champ, '==', valeur).limit(1).get()).docs[0] || null : null);
  return (await par('tabletUid', p.tabletUid)) || par('serieAndroid', p.serie);
}

// Jumelage (pairings/{code}, écrit par la tablette et l'appli famille) : la tablette est reconnue par
// son n° de série Android, noté à la préparation (outils/gestion/preparer-tablette).
// Première fois : la commande est reliée à la famille, quelle que soit l'adresse e-mail du client.
exports.gestionJumelage = onDocumentUpdated(
  { document: 'pairings/{code}', database: BASE_FIRESTORE, region: process.env.REGION_FIRESTORE || 'europe-west1', secrets: [STRIPE_SECRET] },
  async (event) => {
    const avant = event.data.before.data() || {};
    const p = event.data.after.data() || {};
    if (avant.status === p.status || !['claimed', 'confirmed'].includes(p.status)) return;
    await appliquerJumelage(p, event.data.after.ref);
  });

// Fiche stock et commande mises à jour d'après un jumelage (déclencheur, ou rattrapage de la nuit).
// Renvoie la fiche mise à jour, ou null s'il n'y avait rien à faire.
async function appliquerJumelage(p, pairingRef) {
  const fiche = await ficheDeLaTablette(p);
  if (!fiche) {
    logger.info(`Jumelage ${pairingRef.id} : aucune tablette du stock pour le n° de série ${p.serie || '?'}.`);
    return null;
  }
  const t = fiche.data();
  const commande = t.commande ? (await db().doc(`commandes/${t.commande}`).get()).data() || null : null;
  const suite = suiteJumelage(t, commande, p.fid);
  if (suite.refuser) {
    await pairingRef.update({ status: 'refused' });
    logger.warn(`Jumelage refusé : tablette ${t.ref || fiche.id} ${t.etat}.`);
    return null;
  }
  if (p.status !== 'confirmed' || !p.fid) return null;
  const maj = {
    tabletUid: p.tabletUid || null, callsUid: p.callsUid || null, fid: p.fid,
    jumeleeLe: Date.now(), alerteJumelage: suite.alerte || null,
  };
  if (t.etat === 'envoyee') maj.etat = 'chez-client';
  await fiche.ref.update(maj);
  // Tablette reliée : elle est forcément reçue (si le suivi du colis ne l'a pas déjà noté).
  if (t.commande && commande && commande.envoyeeLe && !(commande.preparation && commande.preparation.recuLe)) {
    await db().doc(`commandes/${t.commande}`).update({ 'preparation.recuLe': Date.now(), 'preparation.recuPar': 'tablette reliée' });
  }
  if (suite.relier && vitrine.appliquer) {
    await vitrine.appliquer(p.fid, t.commande);
    logger.info(`Commande ${t.commande} reliée à la famille ${p.fid} par la tablette ${t.ref || fiche.id}.`);
  }
  return fiche;
}

// Rattrapage (chaque nuit et « Lancer maintenant ») : tablette préparée ou envoyée, jumelée (pairing
// confirmé avec son n° de série) mais dont la fiche n'a pas suivi, par exemple si le déclencheur a manqué.
async function rattraperJumelages(bilan) {
  const fiches = (await db().collection('stock').where('etat', 'in', ['preparee', 'envoyee', 'en-stock']).get()).docs
    .filter((d) => d.get('serieAndroid') && !d.get('fid'));
  for (const d of fiches) {
    try {
      const pairings = (await db().collection('pairings').where('serie', '==', d.get('serieAndroid')).get()).docs
        .filter((x) => x.get('status') === 'confirmed' && x.get('fid'))
        .sort((a, b) => (b.get('createdAt')?.toMillis?.() || 0) - (a.get('createdAt')?.toMillis?.() || 0));
      if (!pairings.length) continue;
      if (await appliquerJumelage(pairings[0].data(), pairings[0].ref)) {
        bilan.stock.push(`${d.get('ref') || d.get('numero') || d.id} : jumelage rattrapé`);
      }
    } catch (e) {
      bilan.erreurs.push(`Jumelage de ${d.get('ref') || d.id} : ${e.message}`);
    }
  }
}

// Relevés de batterie des tablettes jumelées : Map(id de la fiche → relevé).
async function lireBatteries(fiches) {
  const jumelees = fiches.filter((d) => d.get('fid') && d.get('tabletUid'));
  if (!jumelees.length) return new Map();
  const membres = await db().getAll(...jumelees.map((d) => db().doc(`families/${d.get('fid')}/members/${d.get('tabletUid')}`)));
  return new Map(jumelees.map((d, i) => [d.id, membres[i].exists ? releveBatterie(membres[i].data()) : null])
    .filter(([, b]) => b && (b.le || b.niveau != null)));
}

// Chaque nuit : dernier relevé recopié sur la fiche, pour le garder quand la tablette quitte sa famille.
async function copierBatteries(bilan) {
  const fiches = (await db().collection('stock').where('fid', '!=', null).get()).docs;
  const releves = await lireBatteries(fiches);
  for (const d of fiches) {
    const b = releves.get(d.id);
    if (!b || ms(b.le) === ms((d.get('batterie') || {}).le)) continue;
    await d.ref.update({ batterie: b });
    const usure = usureBatterie(b);
    if (usure && !usureBatterie(d.get('batterie'))) bilan.stock.push(`${d.get('ref') || d.get('numero') || d.id} : ${usure}`);
  }
}

// Retire une tablette de sa famille (comptes Sync et appels) : elle revient sur l'écran Bienvenue.
// Le dernier relevé de batterie reste sur la fiche, pour décider de la garder ou non.
async function retirerDeLaFamille(t, fiche) {
  if (!t.fid) return false;
  if (fiche && t.tabletUid) {
    const m = await db().doc(`families/${t.fid}/members/${t.tabletUid}`).get();
    const b = m.exists ? releveBatterie(m.data()) : null;
    if (b && (b.le || b.niveau != null)) await fiche.update({ batterie: b }).catch(() => null);
  }
  await Promise.all([t.tabletUid, t.callsUid].filter(Boolean)
    .map((uid) => db().doc(`families/${t.fid}/members/${uid}`).delete()));
  return true;
}

// ---------- Récapitulatif du lundi ----------

const JOURS = (n) => n * JOUR;

// Paiements reçus et remboursés depuis une date (centimes).
async function argentDepuis(depuis) {
  const t = { encaisse: 0, rembourse: 0, paiements: 0 };
  const mouvements = await tout(stripe().balanceTransactions.list({
    created: { gte: Math.floor(depuis / 1000) }, limit: 100,
  }));
  for (const bt of mouvements) {
    const nature = natureMouvement(bt);
    if (nature === 'abonnement' || nature === 'tablette-non-rendue') {
      t.encaisse += bt.amount;
      t.paiements += 1;
    } else if (nature === 'remboursement' || nature === 'litige') {
      t.rembourse += -bt.amount;
    }
  }
  return t;
}

// Ce qui attend l'administrateur, à partir des données Firestore (même logique que l'accueil de la page).
// Tablette reçue avant sa facture (fiche sans prix ni achat, créée à la réception ou à l'installation) depuis
// plus de 5 jours : la facture est à envoyer à factures@, l'achat complétera cette fiche (fichesARattacher).
const sansFacture = (t, maintenant) => t.prixAchat == null && !t.acheteeLe && !t.depense
  && !['perdue', 'hors-service'].includes(t.etat) && (ms(t.creeLe) || ms(t.preparee) || maintenant) < maintenant - JOURS(5);

function aFaire({ commandes, stock, depenses, automatique, maintenant, sims = [], accessoires = [] }) {
  const liste = [];
  // texte : « tablette(s) reçue(s) » → singulier ou pluriel selon n.
  const ajouter = (n, texte) => { if (n > 0) liste.push(`${n} ${texte.replace(/\(s\)/g, n > 1 ? 's' : '')}`); };
  const actives = commandes.filter((c) => c.expedition !== 'annulee');
  const retour = (c) => c.restitution && ['attendue', 'echec'].includes(c.restitution.statut);
  const idsAEnvoyer = new Set(actives.filter((c) => c.expedition === 'a-preparer' && !retour(c)).map((c) => c.id));
  const aEnvoyer = idsAEnvoyer.size;
  // Une tablette réservée à une commande pas encore envoyée compte pour cette commande.
  const dispo = stock.filter((t) => ['en-stock', 'preparee'].includes(t.etat) && (!t.commande || idsAEnvoyer.has(t.commande))).length;
  ajouter(aEnvoyer, 'tablette(s) à envoyer');
  ajouter(Math.max(0, aEnvoyer - dispo), 'tablette(s) manquante(s) en stock pour les envoyer');
  ajouter(actives.filter((c) => c.expedition === 'envoyee' && !c.fid && ms(c.envoyeeLe)
    && maintenant - ms(c.envoyeeLe) > JOURS(20)).length, 'tablette(s) reçue(s) mais pas jumelée(s) après 20 jours');
  ajouter(actives.filter(retour).length, 'tablette(s) à récupérer');
  ajouter(stock.filter((t) => t.etat === 'revenue').length, 'tablette(s) revenue(s) à vérifier');
  for (const t of stock.filter((x) => x.etat === 'revenue' && usureBatterie(x.batterie))) {
    liste.push(`Tablette ${t.ref || t.numero || ''} revenue : ${usureBatterie(t.batterie)}, à retirer du parc`);
  }
  ajouter(stock.filter((t) => t.etat === 'en-retour' && t.remplaceePour).length, 'tablette(s) remplacée(s) à récupérer chez le client');
  for (const t of stock.filter((x) => x.alerteJumelage && !(x.alerteJumelage === ALERTE_SANS_COMMANDE && x.commande))) liste.push(`Tablette ${t.ref || t.numero || ''} ${t.alerteJumelage}`);
  ajouter(actives.filter((c) => c.remboursement && c.remboursement.statut === 'echec').length, 'remboursement(s) échoué(s), à faire depuis Stripe');
  const parId = new Map(commandes.map((c) => [c.id, c]));
  const lignes = new Map(sims.map((l) => [l.id, l]));
  ajouter(stock.filter((t) => simAResilier(t, parId.get(t.commande), lignes.get(t.simId), maintenant)).length,
    'forfait(s) SIM payé(s) depuis 30 jours pour une tablette sans client : à résilier ou suspendre');
  ajouter(depenses.filter((d) => ms(d.date) > maintenant - JOURS(90) && !(d.pieces || []).length && !d.justificatif).length,
    'dépense(s) des 3 derniers mois sans justificatif');
  // Achat enregistré depuis la confirmation de commande : la facture est à télécharger chez le vendeur.
  const attendues = depenses.filter((d) => d.confirmation && ms(d.date) < maintenant - JOURS(5));
  if (attendues.length) {
    liste.push(`Facture à télécharger chez le vendeur puis à envoyer à factures@ : ${attendues
      .map((d) => `${d.fournisseur || d.libelle}${d.numero ? ` (commande ${d.numero})` : ''}`).join(', ')}`);
  }
  ajouter(depenses.filter((d) => d.aVerifier).length, 'facture(s) reçue(s) par e-mail à vérifier');
  ajouter(stock.filter((t) => sansFacture(t, maintenant)).length,
    'tablette(s) reçue(s) sans facture depuis 5 jours : transférez la facture du vendeur à factures@mapapote.fr');
  ajouter(sims.filter((l) => alertesSim(l, maintenant).length).length, 'carte(s) SIM à regarder (promo, activation, carte bancaire)');
  liste.push(...incoherences({ commandes: actives, stock, sims }));
  for (const a of accessoiresAPrevoir(accessoires, actives.filter((c) => c.expedition === 'a-preparer' && !retour(c)))) {
    liste.push(a.manque ? `${a.nom} : il en manque ${a.manque} pour les envois` : `${a.nom} : plus que ${a.quantite || 0} en stock`);
  }
  ajouter(automatique && automatique.erreurs ? automatique.erreurs.length : 0, 'problème(s) lors du dernier passage automatique');
  return liste;
}

const eurosTexte = (c) => `${(c / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

async function recapitulatif() {
  const maintenant = Date.now();
  const debutAnnee = new Date(new Date(maintenant).getFullYear(), 0, 1).getTime();
  const [commandesSnap, stockSnap, depensesSnap, familles, automatique, reglagesSnap, semaine, annee, abonnes, simsSnap,
    accessoiresSnap] = await Promise.all([
    db().collection('commandes').get(),
    db().collection('stock').get(),
    db().collection('depenses').get(),
    db().collection('families').select('abonnement').get(),
    db().doc('gestion/automatique').get(),
    db().doc('gestion/reglages').get(),
    argentDepuis(maintenant - JOURS(7)),
    argentDepuis(debutAnnee),
    tout(stripe().subscriptions.list({ status: 'active', limit: 100 })),
    db().collection('sims').get(),
    db().collection('accessoires').get(),
  ]);
  const statut = new Map(familles.docs.map((f) => [f.id, f.get('abonnement.statut') || null]));
  const commandes = commandesSnap.docs.map((d) => {
    const c = d.data();
    return { id: d.id, ...c, abonnement: c.fid ? statut.get(c.fid) : c.statutStripe || null };
  });
  const reglages = lireReglages(reglagesSnap.data());
  const liste = aFaire({
    commandes,
    stock: stockSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    depenses: depensesSnap.docs.map((d) => d.data()),
    sims: simsSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
    accessoires: accessoiresSnap.docs.map((d) => d.data()),
    automatique: automatique.data(),
    maintenant,
  });
  const nouvelles = commandes.filter((c) => ms(c.creeLe) > maintenant - JOURS(7)).length;
  const ca = annee.encaisse - annee.rembourse;
  const part = reglages.seuilTva ? Math.round((ca / reglages.seuilTva) * 100) : 0;
  const lignes = [
    ['Cette semaine', [
      `${eurosTexte(semaine.encaisse)} encaissés (${semaine.paiements} paiement${semaine.paiements > 1 ? 's' : ''})`,
      semaine.rembourse ? `${eurosTexte(semaine.rembourse)} remboursés` : null,
      `${nouvelles} nouvelle${nouvelles > 1 ? 's' : ''} commande${nouvelles > 1 ? 's' : ''}`,
      `${abonnes.length} abonnement${abonnes.length > 1 ? 's' : ''} payant${abonnes.length > 1 ? 's' : ''} en cours`,
    ].filter(Boolean)],
    ['À faire', liste.length ? liste : ['Rien, tout est à jour.']],
    ['Franchise de TVA', [`${eurosTexte(ca)} encaissés depuis le 1er janvier, soit ${part} % du seuil de ${eurosTexte(reglages.seuilTva)}.`]],
  ];
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#fdfaf5;color:#24212f;font:16px/1.6 Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:28px 20px">
<p style="margin:0 0 20px;font-weight:bold;font-size:20px;color:#4f46e5">Papote · récap de la semaine</p>
${lignes.map(([titre, items]) => `<h2 style="font-size:18px;margin:20px 0 6px">${mail.echapper(titre)}</h2>
<ul style="margin:0;padding-left:20px">${items.map((i) => `<li>${mail.echapper(i)}</li>`).join('')}</ul>`).join('')}
<p style="margin:28px 0"><a href="${ESPACE_ADMIN}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px">Ouvrir l'espace admin</a></p>
</div></body></html>`;
  const text = [...lignes.flatMap(([titre, items]) => [titre, ...items.map((i) => `- ${i}`), '']), ESPACE_ADMIN].join('\n');
  await mail.envoyer({
    smtp: MAIL_SMTP.value(),
    expediteur: MAIL_EXPEDITEUR.value(),
    motDePasse: MAIL_MOT_DE_PASSE.value(),
    a: EMAIL_PAPOTE,
    contenu: {
      subject: liste.length ? `Papote : ${liste.length} chose${liste.length > 1 ? 's' : ''} à faire cette semaine` : 'Papote : tout est à jour',
      html,
      text,
    },
  });
  return { ok: true, aFaire: liste.length };
}

exports.gestionRecap = onSchedule(
  { schedule: 'every monday 08:00', timeZone: 'Europe/Paris', secrets: [STRIPE_SECRET, MAIL_MOT_DE_PASSE], timeoutSeconds: 300 },
  () => recapitulatif());

exports.gestionRecapMaintenant = onCall({ secrets: [STRIPE_SECRET, MAIL_MOT_DE_PASSE], timeoutSeconds: 300 }, async (request) => {
  verifierAdmin(request);
  try {
    return await recapitulatif();
  } catch (e) {
    logger.warn('Récap de la semaine', e.message);
    throw new HttpsError('failed-precondition', `E-mail non envoyé : ${e.message}`);
  }
});

// ---------- Clôture du mois : livres comptables figés, archivés et envoyés ----------

const MOIS_NOMS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre',
  'novembre', 'décembre'];
const MAX_RATTRAPAGE = 12; // mois en arrière rattrapés quand une clôture manque

// Numéros des factures Stripe payées par ces mouvements.
async function numerosFactures(mouvements, depuis) {
  const numeros = new Map();
  for (const f of await tout(stripe().invoices.list({ created: { gte: Math.floor(depuis / 1000) }, limit: 100 }))) {
    if (f.number) numeros.set(f.id, f.number);
  }
  const manquantes = [...new Set(mouvements.map((m) => m.facture).filter((id) => id && !numeros.has(id)))];
  for (const id of manquantes.slice(0, 50)) {
    const f = await stripe().invoices.retrieve(id).catch(() => null);
    if (f && f.number) numeros.set(id, f.number);
  }
  return numeros;
}

async function enregistrerCsv(chemin, contenu) {
  await stockage().file(chemin).save(Buffer.from(contenu, 'utf8'),
    { contentType: 'text/csv; charset=utf-8', resumable: false });
}

// Livres d'une période [debut, fin) : fichiers dans Storage (gestion/archives/{cle}/) et pièces jointes.
async function livresDe(debut, fin, cle) {
  const [mouvements, depensesSnap] = await Promise.all([
    lireMouvements({ gte: Math.floor(debut / 1000), lt: Math.floor(fin / 1000) }),
    db().collection('depenses')
      .where('date', '>=', Timestamp.fromMillis(debut)).where('date', '<', Timestamp.fromMillis(fin)).get(),
  ]);
  const recettes = livreDesRecettes(mouvements, await numerosFactures(mouvements, debut - JOURS(35)));
  const achats = registreDesAchats(depensesSnap.docs.map((d) => d.data()));
  const encaisse = mouvements.filter((m) => ENCAISSEMENTS.includes(m.nature)).reduce((s, m) => s + m.montant, 0);
  const fichiers = [
    { nom: `livre-des-recettes-${cle}.csv`, contenu: recettes.csv },
    { nom: `registre-des-achats-${cle}.csv`, contenu: achats.csv },
  ];
  for (const f of fichiers) {
    f.chemin = `gestion/archives/${cle}/${f.nom}`;
    f.type = 'text/csv';
    await enregistrerCsv(f.chemin, f.contenu);
  }
  return {
    fiche: {
      le: Date.now(),
      debut,
      fin,
      recettes: { nombre: recettes.nombre, total: recettes.total, encaisse, rembourse: encaisse - recettes.total },
      achats: { nombre: achats.nombre, total: achats.total },
      fichiers: fichiers.map(({ nom, chemin, type }) => ({ nom, chemin, type })),
    },
    pieces: fichiers.map((f) => ({ filename: f.nom, content: f.contenu, contentType: 'text/csv; charset=utf-8' })),
  };
}

// Clôture le mois écoulé, rattrape les mois précédents jamais clôturés (tant qu'ils ont de l'activité),
// ou refait un mois précis (refaire : « AAAA-MM »). En décembre, ajoute l'année entière et le chiffre
// d'affaires à reporter sur la déclaration de revenus. Envoie le tout à contact@mapapote.fr.
async function cloturer(maintenant, refaire) {
  const ref = db().doc('gestion/archives');
  const deja = (await ref.get()).data() || {};
  const faits = { ...(deja.mois || {}) };
  const aFaire = [];
  if (refaire) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(refaire));
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new HttpsError('invalid-argument', 'Mois invalide.');
    const cible = { annee: Number(m[1]), mois: Number(m[2]) };
    if (debutMoisParis(cible.annee, cible.mois + 1) > maintenant) throw new HttpsError('invalid-argument', 'Ce mois n\'est pas fini.');
    aFaire.push({ ...cible, toujours: true });
  } else {
    let { annee, mois } = moisPrecedent(maintenant);
    for (let i = 0; i < MAX_RATTRAPAGE; i += 1) {
      if (!faits[cleMois(annee, mois)]) aFaire.push({ annee, mois, toujours: i === 0 });
      mois -= 1;
      if (mois === 0) { annee -= 1; mois = 12; }
    }
  }

  const mois = {};
  const annees = {};
  const pieces = [];
  const resume = [];
  for (const m of aFaire) {
    const cle = cleMois(m.annee, m.mois);
    const { fiche, pieces: p } = await livresDe(debutMoisParis(m.annee, m.mois), debutMoisParis(m.annee, m.mois + 1), cle);
    const vide = !fiche.recettes.nombre && !fiche.achats.nombre;
    // Rattrapage : on s'arrête au premier mois sans aucune activité (avant le lancement).
    if (vide && !m.toujours) {
      await Promise.all(fiche.fichiers.map((f) => stockage().file(f.chemin).delete().catch(() => null)));
      break;
    }
    mois[cle] = fiche;
    pieces.push(...p);
    resume.push([`${MOIS_NOMS[m.mois - 1]} ${m.annee}`, [
      `Recettes : ${fiche.recettes.nombre} ligne${fiche.recettes.nombre > 1 ? 's' : ''}, ${eurosTexte(fiche.recettes.total)}`,
      `Achats : ${fiche.achats.nombre} ligne${fiche.achats.nombre > 1 ? 's' : ''}, ${eurosTexte(fiche.achats.total)}`,
    ]]);
    if (m.mois === 12) {
      const a = String(m.annee);
      const { fiche: ficheAnnee, pieces: pa } = await livresDe(debutMoisParis(m.annee, 1), debutMoisParis(m.annee + 1, 1), a);
      annees[a] = ficheAnnee;
      pieces.push(...pa);
      resume.push([`Année ${a}`, [
        `Chiffre d'affaires encaissé (paiements reçus moins remboursements) : ${eurosTexte(ficheAnnee.recettes.total)}`,
        'À reporter sur la déclaration de revenus, formulaire 2042-C-PRO (micro-entreprise, case des prestations de services BIC : 5KP, ou 5TB avec le versement libératoire). À vérifier sur impots.gouv.fr.',
        `Achats de l'année : ${eurosTexte(ficheAnnee.achats.total)}`,
      ]]);
    }
  }
  if (!Object.keys(mois).length) return { ok: true, mois: [] };
  await ref.set({ mois, ...(Object.keys(annees).length ? { annees } : {}) }, { merge: true });

  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#fdfaf5;color:#24212f;font:16px/1.6 Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:28px 20px">
<p style="margin:0 0 20px;font-weight:bold;font-size:20px;color:#4f46e5">Papote · livres comptables</p>
<p>Le livre des recettes et le registre des achats sont joints (fichiers à ouvrir avec Excel) et rangés dans l'espace admin, rubrique Comptabilité. Gardez cet e-mail : ce sont les registres obligatoires de la micro-entreprise.</p>
${resume.map(([titre, items]) => `<h2 style="font-size:18px;margin:20px 0 6px">${mail.echapper(titre)}</h2>
<ul style="margin:0;padding-left:20px">${items.map((i) => `<li>${mail.echapper(i)}</li>`).join('')}</ul>`).join('')}
<p style="margin:28px 0"><a href="${ESPACE_ADMIN}#compta" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px">Ouvrir l'espace admin</a></p>
</div></body></html>`;
  const text = ['Le livre des recettes et le registre des achats sont joints et rangés dans l\'espace admin.', '',
    ...resume.flatMap(([titre, items]) => [titre, ...items.map((i) => `- ${i}`), '']), ESPACE_ADMIN].join('\n');
  const titres = resume.filter(([t]) => !t.startsWith('Année')).map(([t]) => t);
  let envoye = true;
  try {
    await mail.envoyer({
      smtp: MAIL_SMTP.value(),
      expediteur: MAIL_EXPEDITEUR.value(),
      motDePasse: MAIL_MOT_DE_PASSE.value(),
      a: EMAIL_PAPOTE,
      contenu: { subject: `Papote : livres comptables de ${titres.join(', ')}`, html, text, attachments: pieces },
    });
  } catch (e) {
    envoye = false;
    logger.warn('Livres comptables : e-mail non envoyé', e.message);
  }
  return { ok: true, mois: Object.keys(mois), envoye };
}

const OPTIONS_CLOTURE = { secrets: [STRIPE_SECRET, MAIL_MOT_DE_PASSE], memory: '512MiB', timeoutSeconds: 540 };

exports.gestionCloture = onSchedule(
  { ...OPTIONS_CLOTURE, schedule: '0 5 1 * *', timeZone: 'Europe/Paris' },
  () => cloturer(Date.now()));

exports.gestionCloturer = onCall(OPTIONS_CLOTURE, async (request) => {
  verifierAdmin(request);
  return cloturer(Date.now(), (request.data || {}).mois || null);
});

// ---------- Factures reçues par e-mail ----------

// Facture lue (lectureVersFormulaire) → achat de tablettes ou dépense « à vérifier », avec la pièce jointe,
// et ses cartes SIM et accessoires dans le stock. Renvoie un texte si elle était déjà enregistrée.
async function rangerFacture(r, piece, source) {
  if (r.numero) {
    const memes = await db().collection('depenses').where('numero', '==', r.numero).get();
    if (memes.docs.some((d) => (d.get('fournisseur') || '') === (r.fournisseur || ''))) {
      return `déjà enregistrée (${r.fournisseur || ''} n° ${r.numero})`;
    }
  }
  if (r.montant != null) {
    const memeMontant = await db().collection('depenses').where('montant', '==', r.montant).get();
    const precedente = memeMontant.docs.find((d) => memeAchat({ ...d.data(), date: ms(d.get('date')) }, r)
      || (r.confirmation && memeAchat({ ...d.data(), confirmation: true, date: ms(d.get('date')) }, r)));
    if (precedente && r.confirmation) return `déjà enregistrée (${r.fournisseur || ''}, même montant)`;
    if (precedente) {
      // La vraie facture remplace la confirmation de commande : pièce jointe ajoutée, rien n'entre deux fois au stock.
      await precedente.ref.update({ confirmation: false, numero: r.numero || precedente.get('numero') || null });
      await enregistrerPiece('depenses', precedente.id, piece.filename || 'facture', piece.contentType, piece.content);
      return { materiel: [], rattachee: true };
    }
  }
  let id;
  if (r.tablettes) {
    const t = r.tablettes;
    const prix = t.prixAchat != null ? t.prixAchat : r.montant != null ? Math.round(r.montant / t.quantite) : null;
    if (prix == null) throw new Error('prix des tablettes illisible');
    ({ depense: id } = await ajouterAchat({
      quantite: t.quantite, modele: t.modele, fournisseur: r.fournisseur, prixAchat: prix,
      tva: r.tva != null ? Math.round(r.tva / t.quantite) : null, acheteeLe: r.date, numeros: t.numeros,
      numeroFacture: r.numero, aVerifier: true, source,
    }, 'e-mail'));
  } else {
    if (r.montant == null) throw new Error('montant illisible');
    ({ id } = await ajouterDepense({
      date: r.date, categorie: r.categorie, fournisseur: r.fournisseur, numero: r.numero,
      libelle: r.libelle || 'Facture reçue par e-mail', montant: r.montant, tva: r.tva, aVerifier: true, source,
    }, 'e-mail'));
  }
  if (r.confirmation) await db().doc(`depenses/${id}`).update({ confirmation: true });
  await enregistrerPiece('depenses', id, piece.filename || 'facture', piece.contentType, piece.content);
  const materiel = await entrerMateriel(r, { depense: id, numeroFacture: r.numero, source }, 'e-mail');
  return materiel.length ? { materiel } : null;
}

async function releverFactures() {
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const [hote, port, utilisateur] = FACTURES_IMAP.value().split(':');
  const bilan = { le: Date.now(), boite: utilisateur || null, rangees: [], ignorees: [], erreurs: [] };
  const client = new ImapFlow({
    host: hote, port: Number(port) || 993, secure: true, logger: false,
    auth: { user: utilisateur, pass: FACTURES_MOT_DE_PASSE.value() },
  });
  try {
    await client.connect();
    const adresse = FACTURES_ADRESSE.value();
    // E-mails des 4 derniers jours pas encore traités, lus ou non : un e-mail ouvert entre-temps dans la
    // messagerie (marqué « lu ») doit quand même être rangé. Les déjà traités sont notés par leur Message-ID.
    const vusRef = db().doc('gestion/courrierVus');
    const vus = new Set((await vusRef.get()).get('ids') || []);
    const traites = [];
    let lus = 0;
    // Boîte de réception, puis courrier indésirable : un e-mail transféré peut y être classé par OVH.
    const dossiers = ['INBOX', ...(await client.list()).filter((b) => b.specialUse === '\\Junk').map((b) => b.path)];
    const depuis = new Date(Date.now() - 4 * 86400000);
    for (const dossier of dossiers) {
      const verrou = await client.getMailboxLock(dossier);
      try {
        const tous = await client.search({ since: depuis }, { uid: true }) || [];
        const uids = await client.search({ since: depuis, or: [{ to: adresse }, { cc: adresse }] }, { uid: true }) || [];
        bilan.recus = (bilan.recus || 0) + tous.length;
        bilan.pourFactures = (bilan.pourFactures || 0) + uids.length;
        for (const uid of uids) {
          if (lus >= 20) break;
          const entete = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
          const cle = String((entete && entete.envelope && entete.envelope.messageId) || `uid-${uid}`).slice(0, 200);
          if (vus.has(cle)) continue;
          lus += 1;
          const { content } = await client.download(String(uid), undefined, { uid: true });
          const mailLu = await simpleParser(content);
          const de = (mailLu.from && mailLu.from.text) || 'expéditeur inconnu';
          const sujet = mailLu.subject || '(sans objet)';
          const pieces = piecesFacture(mailLu.attachments);
          // Le texte de l'e-mail (confirmation de commande) passe après les pièces jointes : lu seulement si
          // aucune pièce n'est une facture (images de produits d'un e-mail transféré, par exemple).
          const corps = corpsDuMail(mailLu);
          if (!pieces.length && !corps) bilan.ignorees.push(`« ${sujet} » (${de}) : aucune facture en pièce jointe`);
          let reessayer = false;
          let trouvee = false;
          for (const piece of [...pieces, ...(corps ? [corps] : [])]) {
            if (piece === corps && trouvee) break;
            try {
              const r = await lireDocument(piece.content.toString('base64'), piece.contentType);
              if (!r.facture) {
                bilan.ignorees.push(`${piece.filename || 'pièce'} (« ${sujet} ») : pas une facture`);
                continue;
              }
              trouvee = true;
              const rangee = await rangerFacture(r, piece, `e-mail de ${de}`.slice(0, 200));
              if (typeof rangee === 'string') bilan.ignorees.push(`${piece.filename || 'pièce'} : ${rangee}`);
              else {
                const plus = rangee && rangee.rattachee ? ' (facture ajoutée à la confirmation de commande)'
                  : rangee && rangee.materiel && rangee.materiel.length ? ` (+ ${rangee.materiel.join(', ')})` : '';
                bilan.rangees.push(`${r.fournisseur || de} : ${r.libelle || sujet}${plus}`);
              }
            } catch (e) {
              bilan.erreurs.push(`${piece.filename || 'pièce'} (« ${sujet} ») : ${e.message}`);
              // Lecture indisponible : l'e-mail reste non lu et sera repris à l'heure suivante.
              if (e.code === 'unavailable') reessayer = true;
            }
          }
          if (reessayer) continue;
          traites.push(cle);
          vus.add(cle);
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        }
      } finally {
        verrou.release();
      }
    }
    if (traites.length) await vusRef.set({ ids: [...vus].slice(-500) });
    await client.logout();
  } catch (e) {
    bilan.erreurs.push(`Boîte ${utilisateur} : ${e.authenticationFailed ? 'mot de passe refusé' : e.message}`);
    client.close();
  }
  // Relevé sans rien de nouveau : le résultat du dernier e-mail traité reste affiché (sinon il disparaît
  // au relevé suivant, une heure après).
  const vide = !bilan.rangees.length && !bilan.ignorees.length && !bilan.erreurs.length;
  const avant = vide ? (await db().doc('gestion/courrier').get()).data() : null;
  const precedent = avant && (avant.rangees.length || avant.ignorees.length || avant.erreurs.length)
    ? { le: avant.le, rangees: avant.rangees, ignorees: avant.ignorees, erreurs: avant.erreurs } : avant && avant.precedent;
  await db().doc('gestion/courrier').set({ ...bilan, ...(precedent ? { precedent } : {}) });
  if (bilan.erreurs.length) logger.warn('Factures reçues par e-mail', bilan.erreurs);
  return bilan;
}

const OPTIONS_COURRIER = {
  secrets: [ANTHROPIC_API_KEY, FACTURES_MOT_DE_PASSE], memory: '512MiB', timeoutSeconds: 540,
};

exports.gestionCourrier = onSchedule(
  { ...OPTIONS_COURRIER, schedule: 'every 60 minutes', timeZone: 'Europe/Paris' },
  () => releverFactures());

exports.gestionCourrierMaintenant = onCall(OPTIONS_COURRIER, async (request) => {
  verifierAdmin(request);
  return releverFactures();
});


// ---------- Clients et e-mails d'information ----------
// Liste des clients (commandes) et des paniers abandonnés (paniers/, écrits par la vitrine), fusionnés par e-mail.
// RGPD : un e-mail d'information ne part qu'aux personnes qui l'ont accepté (case cochée à la commande,
// champ marketing, ou accord noté par l'admin) et pas désinscrites. Chaque e-mail porte un lien de désinscription.
// contacts/{cle} : { email, consentement, source, desinscritLe, jeton } ; campagnes/{id} : historique des envois.

const URL_DESINSCRIPTION = 'https://europe-west1-papote-famille.cloudfunctions.net/desinscription';
const ENVOIS_MAX = 300; // limite quotidienne de Brevo en offre gratuite
const STATUTS_ACTIFS = ['actif', 'offert', 'impaye', 'suspendu'];

const emailPropre = (e) => (typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()) ? e.trim().toLowerCase() : null);
const cleContact = (email) => require('node:crypto').createHash('sha256').update(emailPropre(email) || '').digest('hex').slice(0, 32);
const enMs = (v) => (v == null ? null : typeof v === 'number' ? v : v.toMillis ? v.toMillis() : v._seconds ? v._seconds * 1000 : Date.parse(v) || null);

// { commandes, paniers, contacts, statutFamille(fid) } → [{ email, nom, telephone, type, statut, formule, depuis, consentement, desinscrit }]
// type : client (abonnement en cours), ancien (résilié, annulé), panier (panier abandonné sans commande).
function fusionnerContacts({ commandes = [], paniers = [], contacts = [], statutFamille = () => null }) {
  const parEmail = new Map();
  const fiche = (email) => {
    if (!parEmail.has(email)) parEmail.set(email, { email, nom: null, telephone: null, type: null, statut: null, formule: null, depuis: null, consentement: false, desinscrit: false });
    return parEmail.get(email);
  };
  const rang = { client: 3, ancien: 2, panier: 1 };
  for (const c of commandes) {
    const email = emailPropre(c.email);
    if (!email) continue;
    const f = fiche(email);
    const statut = (c.fid && statutFamille(c.fid)) || c.statutStripe || null;
    const type = c.expedition !== 'annulee' && (STATUTS_ACTIFS.includes(statut) || !statut) ? 'client' : 'ancien';
    const le = enMs(c.creeLe);
    if (!f.type || rang[type] > rang[f.type] || (type === f.type && le && le > (f.depuis || 0))) {
      Object.assign(f, { type, statut: c.expedition === 'annulee' ? 'annulee' : statut, formule: c.formule || null });
    }
    f.nom = f.nom || c.nom || null;
    f.telephone = f.telephone || c.telephone || null;
    if (le && (!f.depuis || le < f.depuis)) f.depuis = le;
    if (c.marketing === true) f.consentement = true;
  }
  for (const p of paniers) {
    const email = emailPropre(p.email);
    if (!email) continue;
    const f = fiche(email);
    if (!f.type) Object.assign(f, { type: 'panier', statut: 'panier', formule: p.formule || null });
    f.nom = f.nom || p.nom || null;
    f.telephone = f.telephone || p.telephone || null;
    const le = enMs(p.creeLe || p.le || p.majLe);
    if (f.type === 'panier' && le && (!f.depuis || le < f.depuis)) f.depuis = le;
    if (p.marketing === true) f.consentement = true;
  }
  for (const k of contacts) {
    const email = emailPropre(k.email);
    // chatLe : coordonnées laissées à l'ouverture du chat du site (functions/support.js).
    if (!email || (!parEmail.has(email) && k.consentement !== true && !k.chatLe)) continue;
    const f = fiche(email);
    if (!f.type) f.type = k.chatLe ? 'chat' : 'contact';
    f.nom = f.nom || k.nom || null;
    f.telephone = f.telephone || k.telephone || null;
    if (f.type === 'chat' && !f.depuis) f.depuis = enMs(k.chatDepuis || k.chatLe);
    if (k.consentement === true) f.consentement = true;
    if (k.desinscritLe || k.consentement === false) { f.consentement = false; f.desinscrit = !!k.desinscritLe; }
  }
  return [...parEmail.values()].sort((a, b) => (b.depuis || 0) - (a.depuis || 0));
}

async function lireContacts() {
  const [commandes, paniers, contacts, familles] = await Promise.all([
    db().collection('commandes').get(),
    db().collection('paniers').get().catch(() => ({ docs: [] })),
    db().collection('contacts').get(),
    db().collection('families').select('abonnement').get(),
  ]);
  const statuts = new Map(familles.docs.map((f) => [f.id, f.get('abonnement.statut') || null]));
  return fusionnerContacts({
    commandes: commandes.docs.map((d) => d.data()),
    paniers: paniers.docs.map((d) => d.data()),
    contacts: contacts.docs.map((d) => d.data()),
    statutFamille: (fid) => statuts.get(fid) || null,
  });
}

// E-mail d'information : texte saisi par l'admin (paragraphes séparés par une ligne vide), {prenom} remplacé.
function emailInformation({ objet, message, nom, lienDesinscription }) {
  const prenom = nom ? String(nom).trim().split(/\s+/)[0] : '';
  const texte = String(message).replace(/\{prenom\}/g, prenom).replace(/ ,/g, ',');
  const paragraphes = texte.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#fdfaf5;color:#24212f;font:17px/1.6 Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
<p style="margin:0 0 24px;font-weight:bold;font-size:20px;color:#4f46e5">Papote</p>
${paragraphes.map((p) => `<p style="margin:0 0 16px">${mail.echapper(p).replace(/\n/g, '<br>')}</p>`).join('')}
<p style="margin:32px 0 0;font-size:13px;color:#5f5a6b">Vous recevez cet e-mail car vous avez accepté les nouvelles de Papote.
<a href="${mail.echapper(lienDesinscription)}" style="color:#5f5a6b">Se désinscrire</a></p>
</div></body></html>`;
  return {
    subject: String(objet).trim(),
    html,
    text: `${paragraphes.join('\n\n')}\n\n--\nSe désinscrire : ${lienDesinscription}`,
    headers: { 'List-Unsubscribe': `<${lienDesinscription}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

// Liste des contacts et historique des envois.
exports.gestionClients = onCall(async (request) => {
  verifierAdmin(request);
  const [contacts, campagnes] = await Promise.all([
    lireContacts(),
    db().collection('campagnes').orderBy('le', 'desc').limit(20).get(),
  ]);
  return { contacts, campagnes: campagnes.docs.map((d) => ({ id: d.id, ...d.data() })), envoisMax: ENVOIS_MAX };
});

// { email, consentement } : l'admin note un accord donné de vive voix ou par écrit (ou le retire).
exports.gestionConsentement = onCall(async (request) => {
  verifierAdmin(request);
  const d = request.data || {};
  const email = emailPropre(d.email);
  if (!email || typeof d.consentement !== 'boolean') throw new HttpsError('invalid-argument', 'E-mail ou choix manquant.');
  await db().doc(`contacts/${cleContact(email)}`).set({
    email, consentement: d.consentement, source: 'admin', majLe: Date.now(), par: request.auth.token.email || request.auth.uid,
    ...(d.consentement ? { desinscritLe: FieldValue.delete() } : {}),
  }, { merge: true });
  return { ok: true };
});

// { objet, message, emails, test } : test → à l'admin seulement ; sinon aux e-mails choisis qui ont accepté.
exports.gestionCampagne = onCall({ secrets: [MAIL_MOT_DE_PASSE], timeoutSeconds: 540 }, async (request) => {
  verifierAdmin(request);
  const d = request.data || {};
  const objet = typeof d.objet === 'string' ? d.objet.trim().slice(0, 150) : '';
  const message = typeof d.message === 'string' ? d.message.trim().slice(0, 10000) : '';
  if (!objet || !message) throw new HttpsError('invalid-argument', 'Objet et message obligatoires.');
  const smtp = { smtp: MAIL_SMTP.value(), expediteur: MAIL_EXPEDITEUR.value(), motDePasse: MAIL_MOT_DE_PASSE.value() };
  if (d.test) {
    const moi = emailPropre(request.auth.token.email);
    if (!moi) throw new HttpsError('failed-precondition', 'Votre compte admin n\'a pas d\'e-mail.');
    await mail.envoyer({ ...smtp, a: moi, contenu: emailInformation({ objet: `[Test] ${objet}`, message, nom: 'Tanguy', lienDesinscription: `${URL_DESINSCRIPTION}?test=1` }) });
    return { envoyes: 1, a: moi };
  }
  const voulus = new Set((Array.isArray(d.emails) ? d.emails : []).map(emailPropre).filter(Boolean));
  const destinataires = (await lireContacts()).filter((c) => voulus.has(c.email) && c.consentement && !c.desinscrit);
  if (!destinataires.length) throw new HttpsError('failed-precondition', "Personne dans cette liste n'a accepté les e-mails d'information.");
  if (destinataires.length > ENVOIS_MAX) throw new HttpsError('failed-precondition', `${destinataires.length} destinataires : ${ENVOIS_MAX} au plus par jour avec Brevo. Réduisez la liste.`);
  const ref = db().collection('campagnes').doc();
  await ref.set({ objet, message, le: Date.now(), par: request.auth.token.email || request.auth.uid, prevus: destinataires.length, envoyes: 0, ignores: voulus.size - destinataires.length });
  let envoyes = 0;
  const erreurs = [];
  for (const c of destinataires) {
    try {
      const cref = db().doc(`contacts/${cleContact(c.email)}`);
      const snap = await cref.get();
      let jeton = snap.exists && snap.get('jeton');
      if (!jeton) {
        jeton = require('node:crypto').randomBytes(16).toString('hex');
        await cref.set({ email: c.email, jeton }, { merge: true });
      }
      const lien = `${URL_DESINSCRIPTION}?c=${cleContact(c.email)}&j=${jeton}`;
      await mail.envoyer({ ...smtp, a: c.email, contenu: emailInformation({ objet, message, nom: c.nom, lienDesinscription: lien }) });
      envoyes++;
    } catch (e) {
      erreurs.push(`${c.email} : ${e.message}`);
    }
  }
  await ref.update({ envoyes, erreurs: erreurs.slice(0, 20), finiLe: Date.now() });
  return { envoyes, ignores: voulus.size - destinataires.length, erreurs: erreurs.slice(0, 5) };
});

// Lien « Se désinscrire » : la page demande une confirmation (les antivirus ouvrent les liens) ;
// le bouton, ou le désabonnement en un clic des messageries (POST), retire l'accord.
exports.desinscription = onRequest(async (req, res) => {
  const p = { ...(req.query || {}), ...(typeof req.body === 'object' && req.body ? req.body : {}) };
  const pageHtml = (titre, texte, formulaire) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${titre}</title></head>
<body style="margin:0;background:#fdfaf5;color:#24212f;font:18px/1.6 Arial,sans-serif"><div style="max-width:520px;margin:0 auto;padding:40px 20px">
<p style="font-weight:bold;font-size:22px;color:#4f46e5">Papote</p><h1 style="font-size:26px">${titre}</h1><p>${texte}</p>${formulaire || ''}</div></body></html>`;
  res.set('Cache-Control', 'no-store');
  if (p.test) { res.send(pageHtml('Lien de test', "C'est ici que vos clients se désinscriront.")); return; }
  const c = typeof p.c === 'string' && /^[0-9a-f]{32}$/.test(p.c) ? p.c : null;
  const j = typeof p.j === 'string' && /^[0-9a-f]{32}$/.test(p.j) ? p.j : null;
  const ref = c && db().doc(`contacts/${c}`);
  const snap = ref && j ? await ref.get() : null;
  if (!snap || !snap.exists || snap.get('jeton') !== j) {
    res.status(404).send(pageHtml('Lien inconnu', 'Ce lien de désinscription n\'est pas valable. Répondez simplement à notre e-mail et nous vous retirerons de la liste.'));
    return;
  }
  if (req.method === 'POST') {
    await ref.set({ consentement: false, desinscritLe: Date.now() }, { merge: true });
    res.send(pageHtml('C\'est fait', 'Vous ne recevrez plus nos e-mails d\'information. Les messages liés à votre abonnement (livraison, facture) continuent d\'arriver.'));
    return;
  }
  res.send(pageHtml('Se désinscrire', 'Vous ne recevrez plus les e-mails d\'information de Papote.',
    `<form method="post" action="?c=${c}&j=${j}"><button type="submit" style="font:inherit;font-weight:bold;background:#4f46e5;color:#fff;border:0;border-radius:999px;padding:14px 26px;cursor:pointer">Me désinscrire</button></form>`));
});



// { fid, offerte } : famille offerte (celle de Tanguy) : jamais en pause, jamais supprimable ; ou retour à « aucun ».
exports.gestionFamilleOfferte = onCall(async (request) => {
  verifierAdmin(request);
  const { fid, offerte } = request.data || {};
  if (typeof fid !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(fid) || typeof offerte !== 'boolean') {
    throw new HttpsError('invalid-argument', 'Famille ou choix manquant.');
  }
  const ref = db().doc(`families/${fid}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Famille introuvable.');
  const statut = snap.get('abonnement.statut');
  if (offerte && ['actif', 'impaye', 'suspendu'].includes(statut)) {
    throw new HttpsError('failed-precondition', "Cette famille a un abonnement payant en cours : résiliez-le d'abord dans Stripe.");
  }
  if (!offerte && statut !== 'offert') return { ok: true };
  const qui = request.auth.token.email || request.auth.uid;
  // Fin du service offert : la commande offerte se clôt, le matériel est noté récupéré ou à récupérer.
  const { offertes, parties } = offertesOuvertes(offerte ? [] : (await db().collection('commandes').where('fid', '==', fid).get()).docs);
  const { recupere } = request.data || {};
  if (parties.length && typeof recupere !== 'boolean') {
    throw new HttpsError('failed-precondition', "Dites d'abord si la tablette et les accessoires de la commande offerte sont récupérés.");
  }
  await ref.update({
    'abonnement.statut': offerte ? 'offert' : 'aucun',
    'abonnement.majLe': FieldValue.serverTimestamp(),
    'abonnement.par': qui,
  });
  await closOffertes(offertes, recupere === true, qui);
  return { ok: true };
});

// Commande offerte (les mamies de Tanguy) : une vraie commande, sans Stripe, avec son code de commande.
// La famille choisie passe « offerte » (jamais en pause) ; la tablette choisie est rattachée à la commande.
// { nom, email?, telephone?, formule: 'wifi'|'sim', fid?, tablette?, dejaInstallee? }
exports.gestionCommandeOfferte = onCall(async (request) => {
  verifierAdmin(request);
  const d = request.data || {};
  const nom = texte(d.nom, 100);
  if (!nom) throw new HttpsError('invalid-argument', 'Nom manquant.');
  const formule = d.formule === 'sim' ? 'sim' : 'wifi';
  const fid = typeof d.fid === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(d.fid) ? d.fid : null;
  const famille = fid ? await db().doc(`families/${fid}`).get() : null;
  if (fid && !famille.exists) throw new HttpsError('not-found', 'Famille introuvable.');
  if (famille && ['actif', 'impaye', 'suspendu'].includes(famille.get('abonnement.statut'))) {
    throw new HttpsError('failed-precondition', "Cette famille a un abonnement payant en cours : résiliez-le d'abord dans Stripe.");
  }
  const tablette = typeof d.tablette === 'string' && d.tablette ? await db().doc(`stock/${d.tablette}`).get() : null;
  if (tablette && (!tablette.exists || tablette.get('commande'))) {
    throw new HttpsError('failed-precondition', 'Cette tablette est déjà rattachée à une commande.');
  }
  const installee = d.dejaInstallee === true;
  const qui = request.auth.token.email || request.auth.uid;
  const ref = db().collection('commandes').doc(`offerte-${db().collection('commandes').doc().id}`);
  await db().runTransaction(async (tx) => {
    let code;
    do {
      code = require('./abonnement').nouveauCode();
    } while (!(await tx.get(db().collection('commandes').where('code', '==', code).limit(1))).empty);
    tx.set(ref, {
      offerte: true, code, nom, email: emailPropre(d.email) || null, telephone: texte(d.telephone, 30), formule,
      tablette: 'incluse', livraison: null, expedition: installee ? 'envoyee' : 'a-preparer', fid,
      ...(installee ? { envoyeeLe: FieldValue.serverTimestamp() } : {}),
      creeLe: FieldValue.serverTimestamp(), creePar: qui,
    });
    if (fid) {
      tx.update(famille.ref, {
        'abonnement.statut': 'offert', 'abonnement.formule': formule,
        'abonnement.majLe': FieldValue.serverTimestamp(), 'abonnement.par': qui,
      });
    }
    if (tablette) {
      const etat = installee ? 'chez-client' : tablette.get('etat');
      tx.update(tablette.ref, {
        commande: ref.id, etat, majLe: FieldValue.serverTimestamp(),
        historique: FieldValue.arrayUnion({ le: Date.now(), etat, par: qui, commande: ref.id }),
      });
    }
  });
  return { ok: true, id: ref.id };
});

// ---------- Suppression d'une famille (demande du client à contact@) ----------
// Les responsables ne peuvent plus supprimer leur famille dans l'appli : l'admin le fait ici, en retapant le nom.
// Tout part : la fiche et ses sous-collections (posts, reminders, birthdays, invitations, calls, invites,
// members, logs, commands…) et les photos et vidéos de Storage (families/{fid}/). Famille offerte : sa commande offerte
// est close (annulée si la tablette n'est pas partie, sinon matériel noté récupéré ou encore à récupérer).

const STATUTS_A_RESILIER = ['actif', 'impaye', 'suspendu'];
const nomCompare = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();

// Raison de refuser la suppression, ou null.
function refusSuppression(famille, nomTape) {
  const statut = famille.abonnement && famille.abonnement.statut;
  if (STATUTS_A_RESILIER.includes(statut)) return "L'abonnement de cette famille est en cours : résiliez-le d'abord, sinon le client continuerait à payer.";
  if (!nomCompare(nomTape) || nomCompare(nomTape) !== nomCompare(famille.name)) return 'Le nom retapé ne correspond pas au nom de la famille.';
  return null;
}

exports.gestionSupprimerFamille = onCall({ timeoutSeconds: 540, memory: '512MiB' }, async (request) => {
  verifierAdmin(request);
  const { fid, nom } = request.data || {};
  if (typeof fid !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(fid)) throw new HttpsError('invalid-argument', 'Famille manquante.');
  const ref = db().doc(`families/${fid}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Famille introuvable (déjà supprimée ?).');
  const refus = refusSuppression(snap.data(), nom);
  if (refus) throw new HttpsError('failed-precondition', refus);
  const commandes = await db().collection('commandes').where('fid', '==', fid).get();
  // Commande offerte partie chez le proche : l'admin dit si la tablette et ses accessoires sont récupérés.
  const { offertes, parties } = offertesOuvertes(commandes.docs);
  const { recupere } = request.data || {};
  if (parties.length && typeof recupere !== 'boolean') {
    throw new HttpsError('failed-precondition', 'Dites d\'abord si la tablette et les accessoires de la commande offerte sont récupérés.');
  }
  const membres = await ref.collection('members').get();
  // Fichiers d'abord : si la base échoue ensuite, un nouvel essai finit le travail.
  await stockage().deleteFiles({ prefix: `families/${fid}/`, force: true });
  await db().recursiveDelete(ref);
  // Jumelages de cette famille : sans eux, le rattrapage de nuit ne relie plus la tablette à une famille disparue.
  const jumelages = await db().collection('pairings').where('fid', '==', fid).get();
  await Promise.all(jumelages.docs.map((d) => d.ref.delete()));
  await Promise.all(commandes.docs.map((d) => d.ref.update({ familleSupprimeeLe: Date.now() })));
  await closOffertes(offertes, recupere === true, request.auth.token.email || request.auth.uid);
  await db().collection('suppressions').add({
    fid, nom: snap.get('name') || null, membres: membres.size, le: Date.now(), par: request.auth.token.email || request.auth.uid,
  });
  logger.info(`Famille ${fid} supprimée par ${request.auth.token.email}`);
  return { ok: true, membres: membres.size };
});

// Commandes offertes encore ouvertes (ni annulées ni closes), et celles dont la tablette est partie chez le proche.
function offertesOuvertes(docs) {
  const offertes = docs.filter((d) => d.get('offerte') && d.get('expedition') !== 'annulee' && !d.get('restitution'));
  return { offertes, parties: offertes.filter((d) => !['a-preparer', 'paiement-en-attente'].includes(d.get('expedition'))) };
}

// Commandes offertes d'une famille qui n'est plus offerte, ou supprimée. Pas encore partie : annulée, sa tablette revient au stock.
// Partie : matériel rendu (la tablette passe « revenue », à vérifier) ou encore à récupérer chez le proche.
async function closOffertes(offertes, recupere, qui) {
  for (const d of offertes) {
    const pasPartie = ['a-preparer', 'paiement-en-attente'].includes(d.get('expedition'));
    const tablettes = await db().collection('stock').where('commande', '==', d.id).get();
    if (pasPartie) {
      await d.ref.update({ expedition: 'annulee', annuleeLe: Date.now(), abonnement: 'resilie' });
      await Promise.all(tablettes.docs.map((t) => t.ref.update({
        commande: null, majLe: FieldValue.serverTimestamp(),
        historique: FieldValue.arrayUnion({ le: Date.now(), etat: t.get('etat'), par: qui, motif: 'commande offerte annulée' }),
      })));
      continue;
    }
    await d.ref.update({ abonnement: 'resilie', restitution: { statut: recupere ? 'rendue' : 'a-recuperer', le: Date.now() } });
    if (recupere) {
      await Promise.all(tablettes.docs.filter((t) => ETATS_PARTIS.includes(t.get('etat'))).map((t) => t.ref.update({
        etat: 'revenue', majLe: FieldValue.serverTimestamp(),
        historique: FieldValue.arrayUnion({ le: Date.now(), etat: 'revenue', par: qui, commande: d.id }),
      })));
    }
  }
}

// ---------- Parcours pas à pas (envoi d'une commande, réception d'une tablette) ----------
// L'avancement est gardé sur la commande (preparation) ou la fiche tablette (reception) : on reprend où on s'était arrêté.

// Avancement propre : { etape, faits: {cle: ms}, fini, + champs texte permis }.
function avancementPropre(a, champs = []) {
  const o = a && typeof a === 'object' ? a : {};
  const faits = {};
  for (const [k, v] of Object.entries(o.faits || {}).slice(0, 30)) {
    if (/^[a-z0-9-]{1,30}$/i.test(k) && Number.isFinite(Number(v))) faits[k] = Number(v);
  }
  const propre = {
    etape: Math.max(0, Math.min(30, Math.floor(Number(o.etape) || 0))),
    faits,
    fini: Number.isFinite(Number(o.fini)) && o.fini ? Number(o.fini) : null,
  };
  for (const c of champs) propre[c] = texte(o[c], 100);
  return propre;
}

// Tablette installée (n° T-xxx donné par l'installation) rattachée à la fiche du parcours de réception :
// l'installation prend la plus ancienne tablette « en stock », qui n'est pas forcément celle qu'on a en main.
async function lierInstallation(id, numero, qui) {
  const ref = texte(numero, 10).toUpperCase().replace(/^T-?/, 'T-');
  if (!/^T-\d{1,5}$/.test(ref)) throw new HttpsError('invalid-argument', 'Tapez le numéro affiché à la fin de l\'installation, par exemple T-012.');
  const trouvee = (await db().collection('stock').where('ref', '==', ref).limit(1).get()).docs[0];
  if (!trouvee) throw new HttpsError('not-found', `${ref} n'est pas dans le stock : l'installation est-elle allée jusqu'au bout ?`);
  if (!id || trouvee.id === id) return { id: trouvee.id, ref };
  const fiche = db().doc(`stock/${id}`);
  const snap = await fiche.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Tablette introuvable.');
  if (snap.get('ref') && snap.get('ref') !== ref) throw new HttpsError('failed-precondition', `Cette tablette est déjà ${snap.get('ref')}.`);
  const t = trouvee.data();
  if (t.commande) throw new HttpsError('failed-precondition', `${ref} est déjà réservée pour une commande.`);
  const maintenant = Date.now();
  // Tablette achetée pas encore notée « reçue » : l'installation prouve qu'elle est arrivée.
  const recue = snap.get('etat') === 'commandee' ? [{ le: maintenant - 1, etat: 'en-stock', par: qui, motif: 'reçue' }] : [];
  await fiche.update({
    ref, serieAndroid: t.serieAndroid || null, preparee: t.preparee || maintenant, etat: 'preparee',
    ...(t.modele && !snap.get('modele') ? { modele: t.modele } : {}),
    ...(!snap.get('numero') && (t.numero || t.serieAndroid) ? { numero: t.numero || t.serieAndroid } : {}),
    historique: FieldValue.arrayUnion(...recue, { le: maintenant, etat: 'preparee', par: qui }),
    majLe: FieldValue.serverTimestamp(),
  });
  // Fiche créée par l'installation faute d'achat en stock : elle n'a plus de raison d'être.
  if (t.prixAchat == null && !t.acheteeLe && !t.depense) await trouvee.ref.delete();
  else {
    await trouvee.ref.update({
      ref: FieldValue.delete(), serieAndroid: FieldValue.delete(), preparee: FieldValue.delete(), etat: 'en-stock',
      majLe: FieldValue.serverTimestamp(),
    });
  }
  return { id, ref };
}

// { type: 'envoi', commande, preparation } | { type: 'recu', commande } | { type: 'reception', id, reception }
// | { type: 'lier', id, ref }
exports.gestionParcours = onCall(async (request) => {
  verifierAdmin(request);
  const d = request.data || {};
  const qui = request.auth.token.email || request.auth.uid;
  if (d.type === 'envoi' || d.type === 'recu') {
    const ref = db().doc(`commandes/${texte(d.commande, 100) || '-'}`);
    if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Commande introuvable.');
    if (d.type === 'recu') await ref.update({ 'preparation.recuLe': Date.now(), 'preparation.recuPar': qui });
    else {
      const preparation = avancementPropre(d.preparation, ['tablette', 'sim', 'suivi', 'enceinte']);
      // Enceinte dans le colis ou non : facturée seulement si elle était fournie et ne revient pas.
      const enceinte = preparation.enceinte === 'oui' ? { enceinteFournie: true } : preparation.enceinte === 'non' ? { enceinteFournie: false } : {};
      await ref.update({ preparation: { ...preparation, majLe: Date.now(), par: qui }, ...enceinte });
    }
    return { ok: true };
  }
  if (d.type === 'reception') {
    const ref = db().doc(`stock/${texte(d.id, 100) || '-'}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Tablette introuvable.');
    // Une tablette commandée qu'on ouvre est arrivée : elle passe « En stock ».
    const arrivee = snap.get('etat') === 'commandee'
      ? { etat: 'en-stock', historique: FieldValue.arrayUnion({ le: Date.now(), etat: 'en-stock', par: qui, motif: 'reçue' }) } : {};
    await ref.update({ reception: { ...avancementPropre(d.reception), majLe: Date.now(), par: qui }, ...arrivee });
    return { ok: true };
  }
  if (d.type === 'lier') return lierInstallation(texte(d.id, 100), d.ref, qui);
  throw new HttpsError('invalid-argument', 'Parcours inconnu.');
});

exports.regles = {
  ETATS, CATEGORIES, natureMouvement, mensuel, centimes, lien, nomFichier, moisSuivant, lectureVersFormulaire, SCHEMA_FACTURE,
  lireReglages, transitionPermise, SUITES, simAResilier, fichesARattacher, sansFacture, stockAJour, releveBatterie, usureBatterie, incoherences, materielLu, memeAccessoire, coutLigne, alertesSim, accessoiresAPrevoir, champsSim, aFaire, piecesFacture, debutMoisParis, moisPrecedent, csvTexte, livreDesRecettes,
  registreDesAchats, corpsDuMail, memeAchat, suiteJumelage, descriptionNonRendu, refusSuppression, fusionnerContacts, emailInformation, cleContact,
  avancementPropre,
};
