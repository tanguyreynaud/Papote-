// Gestion de Papote pour l'administrateur (page web/gestion.html) : stock de tablettes,
// commandes, factures, comptabilité et bilans.
//
//   gestionDonnees  commandes (avec l'état de la famille), stock de tablettes, dépenses
//   gestionStock    ajoute des tablettes achetées (et la dépense), change l'état d'une tablette
//   gestionDepense  ajoute ou retire une dépense du registre des achats
//   gestionStripe   factures, encaissements, remboursements, frais et abonnements Stripe d'une période
//   gestionCommande factures et paiements Stripe d'une commande
//   gestionPiece    pièces jointes (facture d'achat, bon de livraison…) d'une tablette ou d'une dépense
//   gestionLireFacture  lit une facture d'achat (PDF ou photo) avec Claude pour préremplir la saisie
//   gestionReglages réglages de la gestion (seuil de TVA, taux URSSAF, coût d'un forfait SIM…)
//   gestionRecap    le lundi : récapitulatif de la semaine par e-mail (gestionRecapMaintenant : tout de suite)
//   gestionCourrier toutes les heures : factures envoyées à factures@mapapote.fr, lues et rangées
//                   (« à vérifier ») ; gestionCourrierMaintenant : tout de suite
//   gestionCloture  le 1er du mois à 5 h : livre des recettes et registre des achats du mois écoulé, figés
//                   (gestion/archives), rangés dans Storage et envoyés par e-mail ; gestionCloturer : tout de suite
//   gestionAutomatique  chaque nuit : factures des 120 € de tablette non rendue, avoirs des
//                       remboursements, dépenses mensuelles récurrentes (gestionAutomatiser : tout de suite)
//
// Stripe est la source de vérité pour l'argent qui rentre ; Firestore garde le stock (stock/{id})
// et les dépenses (depenses/{id}), écrits seulement ici (aucune règle client : lecture et écriture
// refusées depuis les applis), pièces jointes dans Storage sous gestion/ (idem). Réservé au badge admin.

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions/v2');
const { defineSecret, defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const Stripe = require('stripe');
const Anthropic = require('@anthropic-ai/sdk');
const mail = require('./mail');

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
};

function lireReglages(donnees) {
  const r = { ...REGLAGES };
  for (const k of Object.keys(REGLAGES)) {
    const v = donnees && donnees[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) r[k] = v;
  }
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
    remarque: texte(o.remarque, 300),
  };
}

const nul = (type) => ({ anyOf: [{ type }, { type: 'null' }] });
const SCHEMA_FACTURE = {
  type: 'object',
  additionalProperties: false,
  required: ['estUneFacture', 'fournisseur', 'numero', 'date', 'totalTTC', 'tva', 'devise', 'categorie', 'libelle', 'tablettes', 'remarque'],
  properties: {
    estUneFacture: { type: 'boolean', description: 'Faux si le document n\'est ni une facture ni un ticket de caisse.' },
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
  const [commandes, stock, depenses, familles, automatique, reglages, courrier, archives] = await Promise.all([
    db().collection('commandes').get(),
    db().collection('stock').get(),
    db().collection('depenses').get(),
    db().collection('families').select('name', 'abonnement').get(),
    db().doc('gestion/automatique').get(),
    db().doc('gestion/reglages').get(),
    db().doc('gestion/courrier').get(),
    db().doc('gestion/archives').get(),
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

exports.gestionStock = onCall(async (request) => {
  verifierAdmin(request);
  const d = request.data || {};
  const qui = request.auth.token.email || request.auth.uid;

  if (d.action === 'ajouter') return ajouterAchat(d, qui);

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
    if ('etat' in champs) {
      if (!ETATS[champs.etat]) throw new HttpsError('invalid-argument', 'État inconnu.');
      if (champs.etat !== snap.get('etat')) {
        maj.etat = champs.etat;
        // Remise en stock : la tablette n'appartient plus à la commande (l'historique la garde).
        if (champs.etat === 'en-stock' && !('commande' in champs)) maj.commande = null;
        maj.historique = FieldValue.arrayUnion({
          le: Date.now(), etat: champs.etat, par: qui, commande: maj.commande !== undefined ? maj.commande : snap.get('commande') || null,
        });
      }
    }
    await ref.update(maj);
    return { ok: true };
  }

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
  if (d.action === 'ajouter') return ajouterDepense(d, request.auth.token.email || request.auth.uid);
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
    return { ok: true, piece: await enregistrerPiece(d.collection, d.id, d.nom, d.type, contenu) };
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
const CONSIGNE_LECTURE = `Tu lis une facture d'achat (ou un ticket) reçue par Papote, une petite entreprise française
qui prête des tablettes à des personnes âgées et leur famille. Remplis chaque champ d'après le document seulement :
null quand l'information n'y figure pas, jamais d'invention. Montants en euros, tels qu'imprimés.
Catégories : tablettes (achat de tablettes), sim (cartes SIM, forfaits mobiles), expedition (transport, colis,
étiquettes, emballages), hebergement (serveurs, Firebase, Google Cloud, nom de domaine), logiciels (abonnements
logiciels, IA), publicite (annonces, réseaux sociaux), materiel (petit matériel : câbles, chargeurs, supports),
autre. Pour un achat de tablettes, remplis aussi « tablettes » avec les numéros de série (IMEI ou S/N) lisibles.`;

// contenu : fichier en base64. Erreur HttpsError lisible si la lecture échoue.
async function lireDocument(contenu, type) {
  const document = type === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: contenu } }
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

async function automatiser(qui) {
  const maintenant = Date.now();
  const bilan = { factures: [], avoirs: [], depenses: 0, erreurs: [] };
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
  await db().doc('gestion/reglages').set(maj, { merge: true });
  return { ok: true };
});

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
function aFaire({ commandes, stock, depenses, automatique, maintenant }) {
  const liste = [];
  // texte : « tablette(s) reçue(s) » → singulier ou pluriel selon n.
  const ajouter = (n, texte) => { if (n > 0) liste.push(`${n} ${texte.replace(/\(s\)/g, n > 1 ? 's' : '')}`); };
  const actives = commandes.filter((c) => c.expedition !== 'annulee');
  const retour = (c) => c.restitution && ['attendue', 'echec'].includes(c.restitution.statut);
  const aEnvoyer = actives.filter((c) => c.expedition === 'a-preparer' && !retour(c)).length;
  const dispo = stock.filter((t) => ['en-stock', 'preparee'].includes(t.etat) && !t.commande).length;
  ajouter(aEnvoyer, 'tablette(s) à envoyer');
  ajouter(Math.max(0, aEnvoyer - dispo), 'tablette(s) manquante(s) en stock pour les envoyer');
  ajouter(actives.filter((c) => c.expedition === 'envoyee' && !c.fid && ms(c.envoyeeLe)
    && maintenant - ms(c.envoyeeLe) > JOURS(20)).length, 'tablette(s) reçue(s) mais pas jumelée(s) après 20 jours');
  ajouter(actives.filter(retour).length, 'tablette(s) à récupérer');
  ajouter(stock.filter((t) => t.etat === 'revenue').length, 'tablette(s) revenue(s) à vérifier');
  ajouter(actives.filter((c) => c.remboursement && c.remboursement.statut === 'echec').length, 'remboursement(s) échoué(s), à faire depuis Stripe');
  const parId = new Map(commandes.map((c) => [c.id, c]));
  ajouter(stock.filter((t) => simAResilier(t, parId.get(t.commande))).length, 'forfait(s) SIM à résilier ou suspendre');
  ajouter(depenses.filter((d) => ms(d.date) > maintenant - JOURS(90) && !(d.pieces || []).length && !d.justificatif).length,
    'dépense(s) des 3 derniers mois sans justificatif');
  ajouter(depenses.filter((d) => d.aVerifier).length, 'facture(s) reçue(s) par e-mail à vérifier');
  ajouter(automatique && automatique.erreurs ? automatique.erreurs.length : 0, 'problème(s) lors du dernier passage automatique');
  return liste;
}

const eurosTexte = (c) => `${(c / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

async function recapitulatif() {
  const maintenant = Date.now();
  const debutAnnee = new Date(new Date(maintenant).getFullYear(), 0, 1).getTime();
  const [commandesSnap, stockSnap, depensesSnap, familles, automatique, reglagesSnap, semaine, annee, abonnes] = await Promise.all([
    db().collection('commandes').get(),
    db().collection('stock').get(),
    db().collection('depenses').get(),
    db().collection('families').select('abonnement').get(),
    db().doc('gestion/automatique').get(),
    db().doc('gestion/reglages').get(),
    argentDepuis(maintenant - JOURS(7)),
    argentDepuis(debutAnnee),
    tout(stripe().subscriptions.list({ status: 'active', limit: 100 })),
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

// Facture lue (lectureVersFormulaire) → achat de tablettes ou dépense « à vérifier », avec la pièce jointe.
async function rangerFacture(r, piece, source) {
  if (r.numero) {
    const memes = await db().collection('depenses').where('numero', '==', r.numero).get();
    if (memes.docs.some((d) => (d.get('fournisseur') || '') === (r.fournisseur || ''))) {
      return `déjà enregistrée (${r.fournisseur || ''} n° ${r.numero})`;
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
  await enregistrerPiece('depenses', id, piece.filename || 'facture', piece.contentType, piece.content);
  return null;
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
        if (!pieces.length) bilan.ignorees.push(`« ${sujet} » (${de}) : aucune facture en pièce jointe`);
        let reessayer = false;
        for (const piece of pieces) {
          try {
            const r = await lireDocument(piece.content.toString('base64'), piece.contentType);
            if (!r.facture) {
              bilan.ignorees.push(`${piece.filename || 'pièce'} (« ${sujet} ») : pas une facture`);
              continue;
            }
            const deja = await rangerFacture(r, piece, `e-mail de ${de}`.slice(0, 200));
            if (deja) bilan.ignorees.push(`${piece.filename || 'pièce'} : ${deja}`);
            else bilan.rangees.push(`${r.fournisseur || de} : ${r.libelle || sujet}`);
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
  lireReglages, simAResilier, aFaire, piecesFacture, debutMoisParis, moisPrecedent, csvTexte, livreDesRecettes,
  registreDesAchats,
};
