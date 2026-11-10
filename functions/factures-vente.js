// Factures de vente (Tanguy, 10/11) : chaque facture et chaque avoir Stripe gardés en PDF chez Papote, 10 ans
// (Storage gestion/ventes/{année}/), et contrôle à la clôture du mois « une facture = un PDF = un paiement ».
// Règles sans dépendance : testées par factures-vente.test.js ; les appels Stripe et Storage sont dans gestion.js.
//
// gestion/ventes/pieces/{id Stripe} = { type: 'facture'|'avoir', numero, le, total, statut, abonnement, chemin,
//   octets, sha256, copieLe }.

// Une facture Stripe se garde dès qu'elle a un numéro (finalisée) et son PDF : payée, ouverte, annulée ou
// irrécouvrable. Un brouillon n'est pas une facture.
function aGarder(f) {
  return Boolean(f && f.number && f.status !== 'draft' && (f.invoice_pdf || f.pdf));
}

// Avoir (credit note) ou facture.
const typeDe = (f) => (f && f.object === 'credit_note' ? 'avoir' : 'facture');

// Chemin de la copie : un dossier par année d'émission (heure de Paris), le numéro comme nom.
function cheminCopie(f) {
  const annee = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric' }).format(new Date(f.created * 1000));
  const numero = String(f.number).replace(/[^A-Za-z0-9_-]/g, '_');
  return `gestion/ventes/${annee}/${typeDe(f)}-${numero}.pdf`;
}

const idAbonnement = (f) => {
  const a = f.subscription || (f.parent && f.parent.subscription_details && f.parent.subscription_details.subscription);
  return (a && typeof a === 'object' ? a.id : a) || null;
};

// Fiche gardée dans gestion/ventes/pieces.
function fiche(f, { chemin, octets, sha256, maintenant }) {
  return {
    type: typeDe(f),
    numero: f.number,
    le: f.created * 1000,
    total: f.total != null ? f.total : (f.amount != null ? f.amount : null),
    statut: f.status || null,
    abonnement: idAbonnement(f),
    facture: typeDe(f) === 'avoir' ? (typeof f.invoice === 'string' ? f.invoice : (f.invoice && f.invoice.id) || null) : null,
    chemin,
    octets,
    sha256,
    copieLe: maintenant,
  };
}

// Un PDF, c'est un fichier qui commence par « %PDF » : une page d'erreur n'est jamais gardée comme facture.
const estPdf = (buffer) => Boolean(buffer && buffer.length > 4 && buffer.subarray(0, 4).toString('latin1') === '%PDF');

// Numéro Stripe « PREFIXE-0012 » → { prefixe, rang } (préfixe du compte ou du client, selon le réglage Stripe).
function decouper(numero) {
  const m = /^(.*)-(\d+)$/.exec(String(numero || ''));
  return m ? { prefixe: m[1], rang: Number(m[2]) } : null;
}

const euros = (c) => `${(c / 100).toFixed(2).replace('.', ',')} €`;

// Contrôle d'un mois, en phrases pour « À faire » (vide : rien à signaler).
//   factures : factures Stripe émises dans le mois (pas les brouillons)
//   mouvements : paiements Stripe du mois et des 10 jours suivants ({ facture, nature, montant })
//   pieces : toutes les copies gardées ({ id, type, numero })
function controleMois({ factures, mouvements, pieces }) {
  const problemes = [];
  const copies = new Map(pieces.map((p) => [p.id, p]));
  const payees = new Set(mouvements.filter((m) => m.facture && m.montant > 0).map((m) => m.facture));
  for (const f of factures.filter(aGarder)) {
    const nom = `Facture ${f.number}`;
    if (!copies.has(f.id)) problemes.push(`${nom} : pas de copie du PDF chez Papote`);
    // Payée chez Stripe sans aucun paiement reçu (ou payée « hors Stripe » à la main) : à vérifier.
    if (f.status === 'paid' && f.amount_paid > 0 && !payees.has(f.id)) {
      problemes.push(`${nom} (${euros(f.amount_paid)}) : marquée payée mais aucun paiement trouvé`);
    }
  }
  // Même abonnement facturé deux fois pour la même période.
  const parPeriode = new Map();
  for (const f of factures.filter((x) => aGarder(x) && x.status !== 'void' && idAbonnement(x))) {
    const ligne = ((f.lines && f.lines.data) || []).find((l) => l.period && l.period.start);
    if (!ligne) continue;
    const cle = `${idAbonnement(f)}|${ligne.period.start}`;
    if (parPeriode.has(cle)) problemes.push(`Factures ${parPeriode.get(cle)} et ${f.number} : même abonnement, même mois (doublon ?)`);
    else parPeriode.set(cle, f.number);
  }
  // Numérotation sans trou (obligation légale) : pour chaque préfixe, tous les numéros du premier au dernier gardé.
  const rangs = new Map();
  for (const p of pieces.filter((x) => x.type === 'facture')) {
    const d = decouper(p.numero);
    if (!d) continue;
    if (!rangs.has(d.prefixe)) rangs.set(d.prefixe, new Set());
    rangs.get(d.prefixe).add(d.rang);
  }
  for (const [prefixe, ens] of rangs) {
    const tries = [...ens].sort((a, b) => a - b);
    const manquants = [];
    for (let r = tries[0] + 1; r < tries[tries.length - 1] && manquants.length < 5; r += 1) if (!ens.has(r)) manquants.push(r);
    if (manquants.length) {
      const largeur = String(tries[tries.length - 1]).length;
      const noms = manquants.map((r) => `${prefixe}-${String(r).padStart(Math.max(4, largeur), '0')}`);
      problemes.push(`Numérotation : ${noms.join(', ')} ${manquants.length > 1 ? 'manquent' : 'manque'} (aucune copie gardée)`);
    }
  }
  return problemes;
}

module.exports = { aGarder, typeDe, cheminCopie, fiche, estPdf, decouper, controleMois, idAbonnement };
