// Couverture 4G chez la personne équipée (Tanguy, 2026-10-29) : la commande n'est possible que si la carte SIM
// fournie (réseau Bouygues Telecom) capte bien à son adresse. C'est Papote qui vérifie, pas la famille.
//
// Source : carte de couverture théorique 4G Bouygues de l'ARCEP (« Mon réseau mobile », licence ouverte),
// réduite en carreaux de 100 m par outils/couverture/construire.py (couverture/bouygues-4g.*), mise à jour
// chaque trimestre. Niveaux de l'ARCEP :
//   TBC très bonne couverture : internet marche dehors et, dans la plupart des cas, dans la maison ;
//   BC  bonne couverture      : dehors dans la plupart des cas, parfois dans la maison ;
//   CL  couverture limitée    : dehors dans la plupart des cas, probablement pas dans la maison.
// Éligible : très bonne ou bonne couverture. « Limitée » ne l'est pas : la tablette reste dans la maison.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const NIVEAUX = [null, 'CL', 'BC', 'TBC'];
const ELIGIBLES = ['TBC', 'BC'];
const DOSSIER = path.join(__dirname, 'couverture');

// Lambert-93 (RGF93, EPSG:2154) depuis la latitude et la longitude en degrés (WGS84, écart négligeable ici).
// Formules de l'IGN (projection conique conforme, ellipsoïde GRS80).
const L93 = { n: 0.7256077650532670, c: 11754255.4261, xs: 700000, ys: 12655612.0499, e: 0.0818191910428158, lon0: 3 };
function lambert93(lat, lon) {
  const phi = (lat * Math.PI) / 180;
  const s = Math.sin(phi);
  const L = 0.5 * Math.log((1 + s) / (1 - s)) - (L93.e / 2) * Math.log((1 + L93.e * s) / (1 - L93.e * s));
  const R = L93.c * Math.exp(-L93.n * L);
  const g = L93.n * (((lon - L93.lon0) * Math.PI) / 180);
  return { x: L93.xs + R * Math.sin(g), y: L93.ys - R * Math.cos(g) };
}

// Grille chargée une fois par instance (≈ 30 Mo en mémoire, 5 Mo sur le disque).
let grille = null;
function charger() {
  if (!grille) {
    const meta = JSON.parse(fs.readFileSync(path.join(DOSSIER, 'bouygues-4g.json'), 'utf8'));
    grille = { meta, octets: zlib.gunzipSync(fs.readFileSync(path.join(DOSSIER, 'bouygues-4g.bin.gz'))) };
  }
  return grille;
}

// Niveau du carreau qui contient ce point : 'TBC', 'BC', 'CL', ou null (pas de couverture, ou hors de la carte).
function niveauA(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const { meta, octets } = charger();
  const { x, y } = lambert93(lat, lon);
  const col = Math.floor((x - meta.x0) / meta.pas);
  const lig = Math.floor((meta.y1 - y) / meta.pas);
  if (col < 0 || lig < 0 || col >= meta.largeur || lig >= meta.hauteur) return null;
  const i = lig * meta.largeur + col;
  return NIVEAUX[(octets[i >> 2] >> (6 - 2 * (i & 3))) & 3];
}

// Coordonnées reçues du site (texte) : nombres dans la France métropolitaine, sinon null.
function coordonnees(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || la < 41 || la > 51.5 || lo < -5.5 || lo > 10) return null;
  return { lat: la, lon: lo };
}

// { niveau, eligible, trimestre } pour l'adresse choisie sur la page de commande.
function verifier(lat, lon) {
  const c = coordonnees(lat, lon);
  const niveau = c ? niveauA(c.lat, c.lon) : null;
  return { niveau, eligible: ELIGIBLES.includes(niveau), trimestre: c ? charger().meta.trimestre : null };
}

// Commune seule, quand l'acheteur ne connaît pas l'adresse exacte (Tanguy, 2026-10-29) : acceptée si au moins
// 95 % de sa surface a une 4G bonne ou très bonne, sans autre vérification ensuite. En dessous, la page demande la rue.
const SEUIL_COMMUNE = 0.95;
const CONTOURS = 'https://data.geopf.fr/wfs/ows?service=WFS&version=2.0.0&request=GetFeature'
  + '&typeNames=ADMINEXPRESS-COG-CARTO.LATEST:commune&outputFormat=application/json&srsName=EPSG:2154&cql_filter=';

// Le point (Lambert-93) est-il dans ce polygone, trous compris (règle pair-impair sur tous les anneaux) ?
function dansAnneaux(x, y, anneaux) {
  let dedans = false;
  for (const anneau of anneaux) {
    for (let i = 0, j = anneau.length - 1; i < anneau.length; j = i++) {
      const [xi, yi] = anneau[i];
      const [xj, yj] = anneau[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dedans = !dedans;
    }
  }
  return dedans;
}

// Part des carreaux de 100 m de la commune (géométrie GeoJSON en Lambert-93) dont la 4G est bonne ou très bonne.
function partCouverte(geometrie) {
  const { meta, octets } = charger();
  const polygones = geometrie.type === 'Polygon' ? [geometrie.coordinates] : geometrie.coordinates;
  let total = 0;
  let bons = 0;
  for (const anneaux of polygones) {
    const xs = anneaux[0].map((p) => p[0]);
    const ys = anneaux[0].map((p) => p[1]);
    const c0 = Math.max(0, Math.floor((Math.min(...xs) - meta.x0) / meta.pas));
    const c1 = Math.min(meta.largeur - 1, Math.floor((Math.max(...xs) - meta.x0) / meta.pas));
    const l0 = Math.max(0, Math.floor((meta.y1 - Math.max(...ys)) / meta.pas));
    const l1 = Math.min(meta.hauteur - 1, Math.floor((meta.y1 - Math.min(...ys)) / meta.pas));
    for (let lig = l0; lig <= l1; lig++) {
      const y = meta.y1 - (lig + 0.5) * meta.pas;
      for (let col = c0; col <= c1; col++) {
        if (!dansAnneaux(meta.x0 + (col + 0.5) * meta.pas, y, anneaux)) continue;
        total++;
        const i = lig * meta.largeur + col;
        if (ELIGIBLES.includes(NIVEAUX[(octets[i >> 2] >> (6 - 2 * (i & 3))) & 3])) bons++;
      }
    }
  }
  return total ? bons / total : 0;
}

// { part, eligible, trimestre } pour une commune (code INSEE), ou null si la commune est introuvable.
const communes = new Map();
async function verifierCommune(insee, { chercher = fetch } = {}) {
  if (typeof insee !== 'string' || !/^(\d{5}|2[AB]\d{3})$/.test(insee)) return null;
  if (!communes.has(insee)) {
    const r = await chercher(CONTOURS + encodeURIComponent(`code_insee='${insee}'`));
    if (!r.ok) throw new Error(`Contour de la commune ${insee} : ${r.status}`);
    const f = ((await r.json()).features || [])[0];
    communes.set(insee, f ? Math.floor(partCouverte(f.geometry) * 100) / 100 : null);
  }
  const part = communes.get(insee);
  if (part == null) return null;
  return { part, eligible: part >= SEUIL_COMMUNE, trimestre: charger().meta.trimestre };
}

// Adresse de la personne équipée choisie sur la page de commande (paramètres padr, plat, plon de commander, et
// pinsee pour une commune seule), vérifiée ici à nouveau : { adresse, lat, lon, niveau, eligible }, ou null.
async function procheDepuisRequete(q, options) {
  const adresse = typeof q.padr === 'string' ? q.padr.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  const c = coordonnees(q.plat, q.plon);
  if (!adresse || !c) return null;
  if (q.pinsee) {
    const v = await verifierCommune(String(q.pinsee), options).catch(() => null);
    return v && { adresse, lat: c.lat, lon: c.lon, niveau: `commune:${Math.round(v.part * 100)}`, eligible: v.eligible };
  }
  const { niveau, eligible } = verifier(c.lat, c.lon);
  return { adresse, lat: c.lat, lon: c.lon, niveau, eligible };
}

// L'adresse voyage dans les métadonnées Stripe (clés « proche_* »), comme le point relais.
function procheVersMeta(p) {
  return { proche_adresse: p.adresse, proche_lat: String(p.lat), proche_lon: String(p.lon), proche_4g: p.niveau || '' };
}
function procheDepuisMeta(m) {
  if (!m || !m.proche_adresse) return null;
  return { adresse: m.proche_adresse, lat: Number(m.proche_lat), lon: Number(m.proche_lon), couverture4g: m.proche_4g || null };
}

module.exports = { lambert93, niveauA, coordonnees, verifier, partCouverte, verifierCommune, SEUIL_COMMUNE, procheDepuisRequete, procheVersMeta, procheDepuisMeta, ELIGIBLES };
