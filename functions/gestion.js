// Gestion de Papote pour l'administrateur (page web/gestion.html) : stock de tablettes,
// commandes, factures, comptabilité et bilans.
//
//   gestionDonnees  commandes (avec l'état de la famille), stock de tablettes, dépenses
//   gestionStock    ajoute des tablettes achetées (et la dépense), change l'état d'une tablette
//   gestionDepense  ajoute ou retire une dépense du registre des achats
//   gestionStripe   factures, encaissements, remboursements, frais et abonnements Stripe d'une période
//   gestionCommande factures et paiements Stripe d'une commande
//   gestionPiece    pièces jointes (facture d'achat, bon de livraison…) d'une tablette ou d'une dépense
//
// Stripe est la source de vérité pour l'argent qui rentre ; Firestore garde le stock (stock/{id})
// et les dépenses (depenses/{id}), écrits seulement ici (aucune règle client : lecture et écriture
// refusées depuis les applis), pièces jointes dans Storage sous gestion/ (idem). Réservé au badge admin.

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const Stripe = require('stripe');

const STRIPE_SECRET = defineSecret('STRIPE_SECRET');
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
  const [commandes, stock, depenses, familles] = await Promise.all([
    db().collection('commandes').get(),
    db().collection('stock').get(),
    db().collection('depenses').get(),
    db().collection('families').select('name', 'abonnement').get(),
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
  };
});

// ---------- Stock ----------

exports.gestionStock = onCall(async (request) => {
  verifierAdmin(request);
  const d = request.data || {};
  const qui = request.auth.token.email || request.auth.uid;

  if (d.action === 'ajouter') {
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
        libelle: `${quantite} tablette${quantite > 1 ? 's' : ''} ${texte(d.modele) || ''}`.trim(),
        montant: prix * quantite,
        tva: centimes(d.tva) != null ? centimes(d.tva) * quantite : null,
        justificatif: lien(d.justificatif),
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

  if (d.action === 'modifier') {
    if (typeof d.id !== 'string' || !d.id) throw new HttpsError('invalid-argument', 'Tablette manquante.');
    const ref = db().doc(`stock/${d.id}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Tablette introuvable.');
    const champs = d.champs || {};
    const maj = { majLe: FieldValue.serverTimestamp() };
    for (const cle of ['numero', 'modele', 'sim', 'notes']) {
      if (cle in champs) maj[cle] = texte(champs[cle], cle === 'notes' ? 1000 : 80);
    }
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

exports.gestionDepense = onCall(async (request) => {
  verifierAdmin(request);
  const d = request.data || {};
  if (d.action === 'ajouter') {
    const montant = centimes(d.montant);
    if (montant == null || montant === 0) throw new HttpsError('invalid-argument', 'Montant manquant (en centimes).');
    if (!CATEGORIES[d.categorie]) throw new HttpsError('invalid-argument', 'Catégorie inconnue.');
    const libelle = texte(d.libelle);
    if (!libelle) throw new HttpsError('invalid-argument', 'Libellé manquant.');
    const ref = await db().collection('depenses').add({
      date: Timestamp.fromMillis(ms(d.date) || Date.now()),
      categorie: d.categorie,
      fournisseur: texte(d.fournisseur),
      libelle,
      montant,
      tva: centimes(d.tva),
      justificatif: lien(d.justificatif),
      creeLe: FieldValue.serverTimestamp(),
      creePar: request.auth.token.email || request.auth.uid,
    });
    return { ok: true, id: ref.id };
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

exports.gestionStripe = onCall({ secrets: [STRIPE_SECRET], timeoutSeconds: 120 }, async (request) => {
  verifierAdmin(request);
  const { debut, fin } = request.data || {};
  if (!Number.isFinite(debut) || !Number.isFinite(fin) || fin <= debut) {
    throw new HttpsError('invalid-argument', 'Période invalide.');
  }
  const periode = { gte: Math.floor(debut / 1000), lt: Math.floor(fin / 1000) };

  const [factures, mouvements, abonnements] = await Promise.all([
    tout(stripe().invoices.list({ created: periode, limit: 100 })),
    tout(stripe().balanceTransactions.list({
      created: periode, limit: 100, expand: ['data.source'],
    })),
    tout(stripe().subscriptions.list({ status: 'all', limit: 100 })),
  ]);
  // Remboursements : le client est sur le paiement d'origine.
  const charges = new Map();
  const aLire = [...new Set(mouvements
    .map((bt) => bt.source && typeof bt.source === 'object' && typeof bt.source.charge === 'string' && bt.source.charge)
    .filter(Boolean))];
  for (const id of aLire.slice(0, 200)) {
    charges.set(id, await stripe().charges.retrieve(id).catch(() => null));
  }

  return {
    factures: factures.map(versFacture),
    mouvements: mouvements.map((bt) => {
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
    }),
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
    const nom = texte(d.nom, 120) || 'piece';
    const chemin = `gestion/${d.collection}/${d.id}/${Date.now()}-${nomFichier(nom)}`;
    await bucket.file(chemin).save(contenu, { contentType: d.type, resumable: false });
    const piece = { nom, chemin, type: d.type, taille: contenu.length, le: Date.now() };
    await ref.update({ pieces: FieldValue.arrayUnion(piece) });
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

exports.regles = { ETATS, CATEGORIES, natureMouvement, mensuel, centimes, lien, nomFichier };
