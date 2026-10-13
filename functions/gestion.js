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
//   gestionAutomatique  chaque nuit : factures des 120 € de tablette non rendue, avoirs des
//                       remboursements, dépenses mensuelles récurrentes, états du stock suivant les
//                       commandes (gestionAutomatiser : tout de suite)
//
// Stripe est la source de vérité pour l'argent qui rentre ; Firestore garde le stock (stock/{id})
// et les dépenses (depenses/{id}), écrits seulement ici (aucune règle client : lecture et écriture
// refusées depuis les applis), pièces jointes dans Storage sous gestion/ (idem). Réservé au badge admin.

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions/v2');
const { defineSecret, defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const Stripe = require('stripe');
const Anthropic = require('@anthropic-ai/sdk');
const mail = require('./mail');
const sendcloud = require('./sendcloud');

const STRIPE_SECRET = defineSecret('STRIPE_SECRET');
// Même clé que le chat de support (outils/support/installer-support.bat), jamais dans le dépôt.
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const MODELE_LECTURE = 'claude-opus-5-5';
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
const ESPACE_ADMIN = 'https://papote-famille.web.app/admin.html';
const { FieldValue, Timestamp } = admin.firestore;
const db = () => admin.firestore();

let stripeClient;
function stripe() {
  if (!stripeClient) stripeClient = new Stripe(STRIPE_SECRET.value());
  return stripeClient;
}

// ---------- Règles, sans dépendance (testées par gestion.test.js) ----------

// Vie d'une tablette du parc.
const ETATS = {
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
      if (desc.includes('non rendue')) return 'tablette-non-rendue';
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
  return r;
}

// Une ligne SIM payée alors que la tablette n'est plus chez un client : forfait à résilier ou suspendre.
const ETATS_SANS_CLIENT = ['en-stock', 'revenue', 'a-reparer', 'perdue', 'hors-service'];
function simAResilier(tablette, commande) {
  if (!tablette.sim) return false;
  if (ETATS_SANS_CLIENT.includes(tablette.etat)) return true;
  return !!(commande && ((commande.restitution && ['rendue', 'facturee'].includes(commande.restitution.statut))
    || ['resilie', 'canceled'].includes(commande.abonnement)));
}

// Cartes SIM (registre sims/{id}) et accessoires (accessoires/{id}).
const STATUTS_SIM = {
  stock: 'En stock, pas activée',
  active: 'Active',
  suspendue: 'Suspendue',
  resiliee: 'Résiliée',
};
// Avec quels envois part un accessoire (clé 4G, prise…) : sorti du stock à chaque tablette envoyée.
const ENVOIS_ACCESSOIRE = { '': 'Aucun envoi', tous: 'Chaque envoi', sim: 'Envois Internet inclus', wifi: 'Envois Wi-Fi' };

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
  'tablette-non-rendue': 'Tablette non rendue',
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
  return Promise.all((pieces || []).map((p) => admin.storage().bucket().file(p.chemin).delete().catch(() => null)));
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
  return {
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
        restitution: c.restitution ? { statut: c.restitution.statut || null, avant: c.restitution.avant || null } : null,
        remboursement: c.remboursement || null,
        etiquettes: c.etiquettes || null,
        stripeCustomerId: c.stripeCustomerId || null,
      });
    }),
    stock: stock.docs.map((d) => aplatir({ id: d.id, ...d.data() })),
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
  for (let i = 0; i < quantite; i++) {
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
  return { ok: true, ajoutees: quantite, depense: depenseId };
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

  if (d.action === 'ajouter') {
    const r = await ajouterAchat(d, qui);
    r.materiel = await entrerMateriel(materielLu(d.materiel, true), { depense: r.depense, numeroFacture: d.numeroFacture }, qui);
    return r;
  }

  if (d.action === 'modifier') {
    if (typeof d.id !== 'string' || !d.id) throw new HttpsError('invalid-argument', 'Tablette manquante.');
    const ref = db().doc(`stock/${d.id}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Tablette introuvable.');
    const champs = d.champs || {};
    const maj = { majLe: FieldValue.serverTimestamp() };
    for (const cle of ['numero', 'modele', 'sim', 'simOperateur', 'notes']) {
      if (cle in champs) maj[cle] = texte(champs[cle], cle === 'notes' ? 1000 : 80);
    }
    if ('simCout' in champs) maj.simCout = centimes(champs.simCout);
    if ('commande' in champs) {
      const commande = texte(champs.commande, 100);
      if (commande && !(await db().doc(`commandes/${commande}`).get()).exists) {
        throw new HttpsError('not-found', 'Commande introuvable.');
      }
      maj.commande = commande;
    }
    let sortis = [];
    if ('etat' in champs) {
      if (!ETATS[champs.etat]) throw new HttpsError('invalid-argument', 'État inconnu.');
      if (champs.etat !== snap.get('etat')) {
        maj.etat = champs.etat;
        // Perdue (volée) ou hors service : plus d'accès aux photos de la famille.
        if (ETATS_BLOQUES.includes(champs.etat) && await retirerDeLaFamille(snap.data())) maj.fid = null;
        // Remise en stock : la tablette n'appartient plus à la commande (l'historique la garde).
        if (champs.etat === 'en-stock' && !('commande' in champs)) maj.commande = null;
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
  return champs;
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
  if (!id && !champs.statut) champs.statut = 'stock';
  const ligne = { ...avant, ...champs };
  // Tablette : une seule ligne par tablette ; une ligne résiliée n'est plus sur aucune tablette.
  let tablette = 'tablette' in c ? texte(c.tablette, 100) : avant.tablette || null;
  if (ligne.statut === 'resiliee') tablette = null;
  if (tablette) {
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
  if ('note' in c) champs.note = texte(c.note, 1000);
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
      await ajouterDepense({
        date: Date.now(), categorie: 'materiel', fournisseur: d.fournisseur, libelle: `${n} × ${snap.get('nom')}`, montant,
      }, qui);
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
  const client = snap.get('stripeCustomerId');
  const [factures, paiements] = await Promise.all([
    tout(stripe().invoices.list({ subscription: commande, limit: 100 })),
    client ? tout(stripe().charges.list({ customer: client, limit: 100 })) : [],
  ]);
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

async function enregistrerPiece(collection, id, nomBrut, type, contenu) {
  const nom = texte(nomBrut, 120) || 'piece';
  const chemin = `gestion/${collection}/${id}/${Date.now()}-${nomFichier(nom)}`;
  await admin.storage().bucket().file(chemin).save(contenu, { contentType: type, resumable: false });
  const piece = { nom, chemin, type, taille: contenu.length, le: Date.now() };
  await db().doc(`${collection}/${id}`).update({ pieces: FieldValue.arrayUnion(piece) });
  return piece;
}

exports.gestionPiece = onCall({ memory: '512MiB' }, async (request) => {
  verifierAdmin(request);
  const d = request.data || {};
  const bucket = admin.storage().bucket();

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
    const piece = await enregistrerPiece(d.collection, d.id, d.nom, d.type, contenu);
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

// Tablette non rendue : le prélèvement de 120 € (restitutions, index.js) n'a pas de facture.
// On en fait une, marquée payée hors Stripe, pour que chaque encaissement ait sa facture.
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
          description: 'Tablette Papote non rendue (indemnité prévue au contrat)',
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

async function automatiser(qui) {
  const maintenant = Date.now();
  const bilan = { factures: [], avoirs: [], depenses: 0, stock: [], erreurs: [] };
  await synchroniserStock(bilan);
  await depensesRecurrentes(maintenant, bilan);
  await facturerPenalites(maintenant - FENETRE, bilan);
  await avoirsRemboursements(maintenant - FENETRE, bilan);
  await db().doc('gestion/automatique').set({ ...bilan, le: maintenant, par: qui });
  if (bilan.erreurs.length) logger.warn('Automatismes de gestion', bilan.erreurs);
  return bilan;
}

exports.gestionAutomatique = onSchedule(
  { schedule: 'every day 04:00', timeZone: 'Europe/Paris', secrets: [STRIPE_SECRET], timeoutSeconds: 300 },
  () => automatiser('automatique'));

exports.gestionAutomatiser = onCall({ secrets: [STRIPE_SECRET], timeoutSeconds: 300 }, async (request) => {
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
  const bucket = admin.storage().bucket();
  await bucket.file(chemin).save(pdf, {
    contentType: 'application/pdf', resumable: false, metadata: { metadata: { firebaseStorageDownloadTokens: jeton } },
  });
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(chemin)}?alt=media&token=${jeton}`;
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
  const ref = db().doc(`commandes/${d.commande}`);
  const [snap, reglagesSnap] = await Promise.all([ref.get(), db().doc('gestion/reglages').get()]);
  if (!snap.exists) throw new HttpsError('not-found', 'Commande introuvable.');
  const c = snap.data();
  const reglages = lireReglages(reglagesSnap.data());
  const papote = sendcloud.adressePapote(reglages.expediteur);
  if (!papote) throw new HttpsError('failed-precondition', "Renseignez l'adresse d'expédition de Papote (onglet Commandes, Étiquettes).");
  const cl = sendcloud.adresseClient(c);
  if (!cl) throw new HttpsError('failed-precondition', "Cette commande n'a pas d'adresse ni de point relais utilisable.");
  const poids = Math.max(0.1, (reglages.poidsColis || 1500) / 1000);
  const reference = c.code ? String(c.code) : d.commande.slice(-12);
  let api;
  try {
    api = sendcloud.client(SENDCLOUD_API.value());
  } catch (e) {
    throw new HttpsError('failed-precondition', e.message);
  }
  try {
    if (d.sens === 'aller') {
      const r = await api.envoi({ de: papote, vers: cl.adresse, pointRelais: cl.pointRelais, poids, reference });
      const url = await rangerEtiquette(d.commande, 'aller', r.colis, r.pdf);
      await ref.update({ 'etiquettes.aller': { colis: r.colis, suivi: r.suivi, url, le: Date.now(), par: qui } });
      return { ok: true, suivi: r.suivi, url };
    }
    const r = await api.retour({ de: cl.adresse, vers: papote, poids, reference });
    const url = await rangerEtiquette(d.commande, 'retour', r.colis, r.pdf);
    const maj = { 'etiquettes.retour': { colis: r.colis, url, le: Date.now(), par: qui } };
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

// ---------- Identité des tablettes : préparation et jumelage ----------

// Fonctions de index.js (abonnements) dont le jumelage a besoin, branchées au chargement.
const vitrine = {};
exports.brancher = (f) => Object.assign(vitrine, f);

// Tablette perdue ou hors service : retirée de sa famille, jamais plus jumelée.
const ETATS_BLOQUES = ['perdue', 'hors-service'];

// Que faire quand une tablette du stock est jumelée à une famille (pure, testée).
// t : fiche stock ; commande : sa commande (ou null) ; fid : famille qui vient de la jumeler.
function suiteJumelage(t, commande, fid) {
  if (ETATS_BLOQUES.includes(t.etat)) return { refuser: true };
  if (!t.commande || !commande) return { alerte: 'jumelée sans commande' };
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
  { document: 'pairings/{code}', region: process.env.REGION_FIRESTORE || 'europe-west1', secrets: [STRIPE_SECRET] },
  async (event) => {
    const avant = event.data.before.data() || {};
    const p = event.data.after.data() || {};
    if (avant.status === p.status || !['claimed', 'confirmed'].includes(p.status)) return;
    const fiche = await ficheDeLaTablette(p);
    if (!fiche) return;
    const t = fiche.data();
    const commande = t.commande ? (await db().doc(`commandes/${t.commande}`).get()).data() || null : null;
    const suite = suiteJumelage(t, commande, p.fid);
    if (suite.refuser) {
      await event.data.after.ref.update({ status: 'refused' });
      logger.warn(`Jumelage refusé : tablette ${t.ref || fiche.id} ${t.etat}.`);
      return;
    }
    if (p.status !== 'confirmed' || !p.fid) return;
    const maj = {
      tabletUid: p.tabletUid || null, callsUid: p.callsUid || null, fid: p.fid,
      jumeleeLe: Date.now(), alerteJumelage: suite.alerte || null,
    };
    if (t.etat === 'envoyee') maj.etat = 'chez-client';
    await fiche.ref.update(maj);
    if (suite.relier && vitrine.appliquer) {
      await vitrine.appliquer(p.fid, t.commande);
      logger.info(`Commande ${t.commande} reliée à la famille ${p.fid} par la tablette ${t.ref || fiche.id}.`);
    }
  });

// Retire une tablette de sa famille (comptes Sync et appels) : elle revient sur l'écran Bienvenue.
async function retirerDeLaFamille(t) {
  if (!t.fid) return false;
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
  ajouter(stock.filter((t) => t.etat === 'en-retour' && t.remplaceePour).length, 'tablette(s) remplacée(s) à récupérer chez le client');
  for (const t of stock.filter((x) => x.alerteJumelage)) liste.push(`Tablette ${t.ref || t.numero || ''} ${t.alerteJumelage}`);
  ajouter(actives.filter((c) => c.remboursement && c.remboursement.statut === 'echec').length, 'remboursement(s) échoué(s), à faire depuis Stripe');
  const parId = new Map(commandes.map((c) => [c.id, c]));
  ajouter(stock.filter((t) => simAResilier(t, parId.get(t.commande))).length, 'forfait(s) SIM à résilier ou suspendre');
  ajouter(depenses.filter((d) => ms(d.date) > maintenant - JOURS(90) && !(d.pieces || []).length && !d.justificatif).length,
    'dépense(s) des 3 derniers mois sans justificatif');
  // Achat enregistré depuis la confirmation de commande : la facture est à télécharger chez le vendeur.
  const attendues = depenses.filter((d) => d.confirmation && ms(d.date) < maintenant - JOURS(5));
  if (attendues.length) {
    liste.push(`Facture à télécharger chez le vendeur puis à envoyer à factures@ : ${attendues
      .map((d) => `${d.fournisseur || d.libelle}${d.numero ? ` (commande ${d.numero})` : ''}`).join(', ')}`);
  }
  ajouter(depenses.filter((d) => d.aVerifier).length, 'facture(s) reçue(s) par e-mail à vérifier');
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
    sims: simsSnap.docs.map((d) => d.data()),
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
  await admin.storage().bucket().file(chemin).save(Buffer.from(contenu, 'utf8'),
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
      await Promise.all(fiche.fichiers.map((f) => admin.storage().bucket().file(f.chemin).delete().catch(() => null)));
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
  const bilan = { le: Date.now(), rangees: [], ignorees: [], erreurs: [] };
  const client = new ImapFlow({
    host: hote, port: Number(port) || 993, secure: true, logger: false,
    auth: { user: utilisateur, pass: FACTURES_MOT_DE_PASSE.value() },
  });
  try {
    await client.connect();
    const verrou = await client.getMailboxLock('INBOX');
    try {
      const adresse = FACTURES_ADRESSE.value();
      const uids = await client.search({ seen: false, or: [{ to: adresse }, { cc: adresse }] }, { uid: true }) || [];
      for (const uid of uids.slice(0, 20)) {
        const { content } = await client.download(String(uid), undefined, { uid: true });
        const mailLu = await simpleParser(content);
        const de = (mailLu.from && mailLu.from.text) || 'expéditeur inconnu';
        const sujet = mailLu.subject || '(sans objet)';
        const pieces = piecesFacture(mailLu.attachments);
        if (!pieces.length) {
          const corps = corpsDuMail(mailLu);
          if (corps) pieces.push(corps);
          else bilan.ignorees.push(`« ${sujet} » (${de}) : aucune facture en pièce jointe`);
        }
        let reessayer = false;
        for (const piece of pieces) {
          try {
            const r = await lireDocument(piece.content.toString('base64'), piece.contentType);
            if (!r.facture) {
              bilan.ignorees.push(`${piece.filename || 'pièce'} (« ${sujet} ») : pas une facture`);
              continue;
            }
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
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      }
    } finally {
      verrou.release();
    }
    await client.logout();
  } catch (e) {
    bilan.erreurs.push(`Boîte ${utilisateur} : ${e.authenticationFailed ? 'mot de passe refusé' : e.message}`);
    client.close();
  }
  await db().doc('gestion/courrier').set(bilan);
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

exports.regles = {
  ETATS, CATEGORIES, natureMouvement, mensuel, centimes, lien, nomFichier, moisSuivant, lectureVersFormulaire, SCHEMA_FACTURE,
  lireReglages, simAResilier, stockAJour, incoherences, materielLu, memeAccessoire, coutLigne, alertesSim, accessoiresAPrevoir, champsSim, aFaire, piecesFacture, debutMoisParis, moisPrecedent, csvTexte, livreDesRecettes,
  registreDesAchats, corpsDuMail, memeAchat, suiteJumelage,
};
