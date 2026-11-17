// Statistiques de visite du site, sans cookie ni donnée personnelle (Tanguy, 17/11 : « combien de personnes
// cliquent sur mon site vs le nombre de commandes, et où elles s'arrêtent »).
//
// Un document par jour, statistiques/{AAAA-MM-JJ} (heure de Paris), avec un compteur par étape et, pour les
// visites, un compteur par provenance (sources.google…). Chaque étape est comptée une fois par visite par la page
// (sessionStorage, rien ne reste après la fermeture de l'onglet). Rien d'autre n'est gardé : ni adresse internet,
// ni page précise d'origine, ni identifiant. Lecture : page « Statistiques » de l'admin (gestionStatistiques) et
// outils/admin/statistiques.bat.

// Étapes envoyées par le site, dans l'ordre du tunnel. « paye » et « prevenir » sont comptées par le serveur.
const ETAPES_SITE = ['visite', 'accueil', 'commande', 'adresse', 'couverture-ok', 'couverture-non', 'relais', 'coordonnees', 'paiement', 'complet'];
const ETAPES_SERVEUR = ['paye', 'prevenir'];

// Provenance : seulement une famille de sites, jamais l'adresse exacte (une liste fermée : personne ne peut écrire
// n'importe quoi dans la base).
const SOURCES = [
  ['google', /(^|\.)google\.[a-z.]+$|(^|\.)googleadservices\.com$/],
  ['bing', /(^|\.)bing\.com$/],
  ['qwant', /(^|\.)qwant\.com$/],
  ['duckduckgo', /(^|\.)duckduckgo\.com$/],
  ['ecosia', /(^|\.)ecosia\.org$/],
  ['yahoo', /(^|\.)yahoo\.[a-z.]+$/],
  ['facebook', /(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$/],
  ['instagram', /(^|\.)instagram\.com$/],
  ['whatsapp', /(^|\.)whatsapp\.(com|net)$/],
  ['linkedin', /(^|\.)(linkedin\.com|lnkd\.in)$/],
  ['youtube', /(^|\.)(youtube\.com|youtu\.be)$/],
  ['tiktok', /(^|\.)tiktok\.com$/],
  ['pinterest', /(^|\.)pinterest\.[a-z.]+$/],
  ['x', /(^|\.)(twitter\.com|x\.com|t\.co)$/],
  ['leboncoin', /(^|\.)leboncoin\.fr$/],
  ['email', /(^|\.)(mail\.google\.com|outlook\.(live|office)\.com|mail\.yahoo\.com|webmail\.[a-z.]+|mail\.orange\.fr|zimbra\.free\.fr|mail\.sfr\.fr|laposte\.net|brevo\.com|sendibt\d*\.com)$/],
];
const NOMS_SOURCES = [...SOURCES.map(([n]) => n), 'direct', 'autre'];
const NOTRE_SITE = /(^|\.)(mapapote\.fr|papote\.web\.app|papote\.firebaseapp\.com)$/;

// Famille de provenance d'une visite, d'après le nom du site d'origine (r) ou le paramètre utm_source (u).
function source(r, u) {
  const utm = String(u || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
  if (utm) {
    if (NOMS_SOURCES.includes(utm)) return utm;
    if (['gmail', 'newsletter', 'mail', 'brevo', 'courriel'].includes(utm)) return 'email';
    if (['fb', 'meta'].includes(utm)) return 'facebook';
    if (['ig'].includes(utm)) return 'instagram';
    if (['twitter'].includes(utm)) return 'x';
  }
  const hote = String(r || '').toLowerCase().trim().replace(/^www\./, '').slice(0, 120);
  if (!hote || NOTRE_SITE.test(hote)) return 'direct';
  if (!/^[a-z0-9.-]+$/.test(hote)) return 'autre';
  if (/^mail\.google\.com$/.test(hote)) return 'email';
  for (const [nom, motif] of SOURCES) if (motif.test(hote)) return nom;
  return 'autre';
}

const jourDeParis = (ms = Date.now()) => new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });

// Ce qu'il faut ajouter au document du jour pour une requête du site, ou null si elle n'est pas valable.
function increments(q, FieldValue) {
  const etape = String((q && q.e) || '');
  if (!ETAPES_SITE.includes(etape)) return null;
  const plus = { [etape]: FieldValue.increment(1) };
  if (etape === 'visite') plus.sources = { [source(q.r, q.u)]: FieldValue.increment(1) };
  return plus;
}

// Tunnel lisible pour l'admin, sur une liste de documents du jour (les plus anciens d'abord).
// → { jours: [{ jour, visite, …, paye }], total: {…}, sources: { google: n, … } }
function resume(docs) {
  const champs = [...ETAPES_SITE, ...ETAPES_SERVEUR];
  const total = Object.fromEntries(champs.map((c) => [c, 0]));
  const sources = {};
  const jours = docs.map(({ id, data }) => {
    const ligne = { jour: id };
    for (const c of champs) {
      ligne[c] = Number(data[c]) || 0;
      total[c] += ligne[c];
    }
    // Avant le 17/11, seule l'arrivée sur l'accueil ou la commande était comptée : elle sert de visite.
    if (!data.visite) ligne.visite = Math.max(ligne.accueil, ligne.commande), total.visite += ligne.visite;
    for (const [s, n] of Object.entries(data.sources || {})) sources[s] = (sources[s] || 0) + (Number(n) || 0);
    return ligne;
  });
  return { jours, total, sources };
}

module.exports = { ETAPES_SITE, ETAPES_SERVEUR, NOMS_SOURCES, source, jourDeParis, increments, resume };
