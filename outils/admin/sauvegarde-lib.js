// Sauvegarde et restauration de la base Firestore (et de la liste des comptes) : le cœur, sans ligne de commande,
// pour être testé sur l'émulateur (sauvegarde.test.js) et utilisé par sauvegarder.js / restaurer.js.
//
// Format : un fichier JSON { version, le, projet, base, documents: [{ chemin, donnees }], comptes: [...] }.
// Les valeurs Firestore qui n'existent pas en JSON sont encodées : { "@type": "timestamp", "ms", "ns" },
// { "@type": "geo", "lat", "lon" }, { "@type": "ref", "chemin" }, { "@type": "bytes", "base64" }. Les cartes qui
// auraient elles-mêmes une clé « @type » sont protégées ({ "@type": "map", "valeurs" }).
// firebase-admin : celui d'outils/admin (npm install sur le PC), sinon celui de functions/ (tests et exercices du dépôt).
function charger(nom) {
  try { return require(nom); } catch (e) {
    return require(require.resolve(nom, { paths: [require('path').join(__dirname, '..', '..', 'functions')] }));
  }
}
const { Timestamp, GeoPoint, DocumentReference } = charger('firebase-admin/firestore');

const VERSION = 1;

function encoder(v) {
  if (v === null || v === undefined) return v === undefined ? null : v;
  if (v instanceof Timestamp) return { '@type': 'timestamp', ms: v.toMillis(), ns: v.nanoseconds % 1_000_000 };
  if (v instanceof Date) return { '@type': 'timestamp', ms: v.getTime(), ns: 0 };
  if (v instanceof GeoPoint) return { '@type': 'geo', lat: v.latitude, lon: v.longitude };
  if (v instanceof DocumentReference) return { '@type': 'ref', chemin: v.path };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { '@type': 'bytes', base64: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return v.map(encoder);
  if (typeof v === 'object') {
    const sortie = {};
    for (const [k, x] of Object.entries(v)) sortie[k] = encoder(x);
    return Object.prototype.hasOwnProperty.call(v, '@type') ? { '@type': 'map', valeurs: sortie } : sortie;
  }
  return v;
}

function decoder(v, db) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => decoder(x, db));
  switch (v['@type']) {
    case 'timestamp': return new Timestamp(Math.floor(v.ms / 1000), (v.ms % 1000) * 1_000_000 + (v.ns || 0));
    case 'geo': return new GeoPoint(v.lat, v.lon);
    case 'ref': return db.doc(v.chemin);
    case 'bytes': return Buffer.from(v.base64, 'base64');
    case 'map': return decoder(v.valeurs, db);
    default: {
      const sortie = {};
      for (const [k, x] of Object.entries(v)) sortie[k] = decoder(x, db);
      return sortie;
    }
  }
}

// Parcourt toute la base : chaque collection, chaque document, et les sous-collections de chaque document
// (listCollections, en parallèle par paquets). Rend les documents dans l'ordre des chemins, lus par pages de 500.
async function toutLire(db, { progression = () => {}, parallele = 25 } = {}) {
  const documents = [];
  const aVisiter = await db.listCollections();
  while (aVisiter.length) {
    const collection = aVisiter.shift();
    let page = await collection.orderBy('__name__').limit(500).get();
    while (!page.empty) {
      const refs = [];
      for (const d of page.docs) {
        documents.push({ chemin: d.ref.path, donnees: encoder(d.data()) });
        refs.push(d.ref);
      }
      for (let i = 0; i < refs.length; i += parallele) {
        const sous = await Promise.all(refs.slice(i, i + parallele).map((r) => r.listCollections()));
        sous.forEach((liste) => aVisiter.push(...liste));
      }
      progression(documents.length);
      if (page.size < 500) break;
      page = await collection.orderBy('__name__').startAfter(page.docs[page.docs.length - 1]).limit(500).get();
    }
  }
  documents.sort((a, b) => (a.chemin < b.chemin ? -1 : a.chemin > b.chemin ? 1 : 0));
  return documents;
}

// Les comptes (Firebase Auth) : identité et fournisseurs, pas les mots de passe (ceux des comptes « appels » des
// tablettes sont recréés par la tablette elle-même au besoin).
async function lireComptes(auth) {
  const comptes = [];
  let jeton;
  do {
    const r = await auth.listUsers(1000, jeton);
    for (const u of r.users) {
      comptes.push({
        uid: u.uid, email: u.email || null, emailVerified: !!u.emailVerified, displayName: u.displayName || null,
        photoURL: u.photoURL || null, disabled: !!u.disabled, customClaims: u.customClaims || null,
        providers: u.providerData.map((p) => ({ providerId: p.providerId, uid: p.uid, email: p.email || null, displayName: p.displayName || null })),
        creeLe: u.metadata.creationTime || null,
      });
    }
    jeton = r.pageToken;
  } while (jeton);
  return comptes.sort((a, b) => (a.uid < b.uid ? -1 : 1));
}

async function sauvegarder({ db, auth = null, projet = '', base = '', progression }) {
  const documents = await toutLire(db, { progression });
  const comptes = auth ? await lireComptes(auth) : [];
  return { version: VERSION, le: new Date().toISOString(), projet, base, documents, comptes };
}

// Lots d'écriture : 400 documents au plus, et 3,5 Mio au plus en tout. Firestore refuse une requête de plus de
// 10 Mio (et l'émulateur reste bloqué au-delà de 4 Mio environ), or un document peut peser près de 1 Mio (photo
// en taille réelle posts/{id}/media/image, morceaux de vidéo de 700 000 caractères) : 400 documents de ce genre ne
// passent pas en un seul commit. La taille est estimée d'après le JSON du document (plus grande que la taille
// réelle : le base64 des octets compte 4/3). Un document seul plus gros que la limite part seul dans son lot.
const MAX_DOCS_LOT = 400;
const MAX_OCTETS_LOT = 3.5 * 1024 * 1024;
const tailleEstimee = (d) => Buffer.byteLength(d.chemin) + Buffer.byteLength(JSON.stringify(d.donnees || {})) + 64;
function lotsDEcriture(documents, { maxDocs = MAX_DOCS_LOT, maxOctets = MAX_OCTETS_LOT } = {}) {
  const lots = [];
  let lot = [];
  let octets = 0;
  for (const d of documents) {
    const taille = tailleEstimee(d);
    if (lot.length && (lot.length >= maxDocs || octets + taille > maxOctets)) {
      lots.push(lot);
      lot = [];
      octets = 0;
    }
    lot.push(d);
    octets += taille;
  }
  if (lot.length) lots.push(lot);
  return lots;
}

// Réécrit chaque document tel qu'il était (set complet, par lots : lotsDEcriture). Les documents présents dans la
// base et absents de la sauvegarde sont laissés tels quels, sauf avec effacer: true (remise exacte à l'état sauvegardé).
async function restaurer({ db, auth = null, sauvegarde, effacer = false, progression = () => {} }) {
  if (sauvegarde.version !== VERSION) throw new Error(`Version de sauvegarde inconnue : ${sauvegarde.version}`);
  if (effacer) {
    const presents = await toutLire(db);
    const garder = new Set(sauvegarde.documents.map((d) => d.chemin));
    const aEffacer = presents.filter((d) => !garder.has(d.chemin));
    for (let i = 0; i < aEffacer.length; i += 400) {
      const lot = db.batch();
      aEffacer.slice(i, i + 400).forEach((d) => lot.delete(db.doc(d.chemin)));
      await lot.commit();
    }
  }
  // Pendant l'écriture, les déclencheurs du serveur qui préviennent des humains ou réveillent des tablettes se
  // taisent (functions/base.js restaurationEnCours) : drapeau interne/restauration, 2 h au plus, retiré à la fin.
  const drapeau = db.doc('interne/restauration');
  await drapeau.set({ enCours: true, jusque: Timestamp.fromMillis(Date.now() + 2 * 3600 * 1000), le: Timestamp.now() });
  let ecrits = 0;
  try {
    const documents = sauvegarde.documents.filter((d) => d.chemin !== 'interne/restauration');
    for (const paquet of lotsDEcriture(documents)) {
      const lot = db.batch();
      for (const d of paquet) lot.set(db.doc(d.chemin), decoder(d.donnees, db));
      await lot.commit();
      ecrits += paquet.length;
      progression(ecrits);
    }
    // Les déclencheurs tournent encore quelques secondes après la dernière écriture.
    await new Promise((r) => setTimeout(r, 5000));
  } finally {
    await drapeau.delete();
  }
  let comptes = 0;
  if (auth && sauvegarde.comptes && sauvegarde.comptes.length) {
    for (let i = 0; i < sauvegarde.comptes.length; i += 1000) {
      const r = await auth.importUsers(sauvegarde.comptes.slice(i, i + 1000).map((c) => ({
        uid: c.uid, email: c.email || undefined, emailVerified: c.emailVerified, displayName: c.displayName || undefined,
        photoURL: c.photoURL || undefined, disabled: c.disabled, customClaims: c.customClaims || undefined,
        providerData: c.providers.filter((p) => p.providerId !== 'password').map((p) => ({ providerId: p.providerId, uid: p.uid, email: p.email || undefined, displayName: p.displayName || undefined })),
      })));
      comptes += r.successCount;
      if (r.failureCount) throw new Error(`${r.failureCount} compte(s) non restauré(s) : ${r.errors.map((e) => `${e.index} ${e.error.message}`).join(' ; ')}`);
    }
  }
  return { documents: ecrits, comptes };
}

// ---------- Photos et vidéos (Storage) ----------
// Les fichiers du bucket sont copiés tels quels dans un dossier (fichiers/<chemin dans le bucket>), avec un index
// (fichiers/index.json : chemin → { md5, taille, type }). Copie incrémentale : seul ce qui est nouveau ou a changé
// est téléchargé ; rien n'est jamais effacé du dossier (une photo supprimée depuis reste dans la copie).
const fsp = require('fs').promises;
const pathLib = require('path');
const crypto = require('crypto');

const INDEX = 'index.json';
const cheminLocal = (dossier, chemin) => pathLib.join(dossier, ...chemin.split('/'));

async function lireIndex(dossier) {
  try { return JSON.parse(await fsp.readFile(pathLib.join(dossier, INDEX), 'utf8')); } catch { return {}; }
}

async function sauvegarderFichiers({ bucket, dossier, progression = () => {}, parallele = 8 }) {
  await fsp.mkdir(dossier, { recursive: true });
  const index = await lireIndex(dossier);
  const [fichiers] = await bucket.getFiles({ autoPaginate: true });
  const aCopier = fichiers.filter((f) => !f.name.endsWith('/') && (!index[f.name] || index[f.name].md5 !== f.metadata.md5Hash));
  let copies = 0;
  let octets = 0;
  for (let i = 0; i < aCopier.length; i += parallele) {
    await Promise.all(aCopier.slice(i, i + parallele).map(async (f) => {
      const destination = cheminLocal(dossier, f.name);
      await fsp.mkdir(pathLib.dirname(destination), { recursive: true });
      await f.download({ destination });
      index[f.name] = { md5: f.metadata.md5Hash, taille: Number(f.metadata.size), type: f.metadata.contentType || null };
      copies++;
      octets += Number(f.metadata.size) || 0;
      progression(copies, aCopier.length);
    }));
    await fsp.writeFile(pathLib.join(dossier, INDEX), JSON.stringify(index));
  }
  await fsp.writeFile(pathLib.join(dossier, INDEX), JSON.stringify(index));
  return { total: fichiers.length, copies, octets, index };
}

// Vérifie la copie locale : chaque fichier de l'index existe et a bien le même contenu (md5). Rend les manquants
// et les abîmés.
async function verifierFichiers(dossier) {
  const index = await lireIndex(dossier);
  const manquants = [];
  const abimes = [];
  for (const [chemin, info] of Object.entries(index)) {
    let contenu;
    try { contenu = await fsp.readFile(cheminLocal(dossier, chemin)); } catch { manquants.push(chemin); continue; }
    if (crypto.createHash('md5').update(contenu).digest('base64') !== info.md5) abimes.push(chemin);
  }
  return { total: Object.keys(index).length, manquants, abimes };
}

// Remet dans le bucket les fichiers de la copie qui n'y sont plus (ou qui ont changé). Ce qui est dans le bucket et
// pas dans la copie est laissé.
async function restaurerFichiers({ bucket, dossier, progression = () => {}, parallele = 8 }) {
  const index = await lireIndex(dossier);
  const [presents] = await bucket.getFiles({ autoPaginate: true });
  const dejaLa = new Map(presents.map((f) => [f.name, f.metadata.md5Hash]));
  const aRemettre = Object.entries(index).filter(([chemin, info]) => dejaLa.get(chemin) !== info.md5);
  let remis = 0;
  for (let i = 0; i < aRemettre.length; i += parallele) {
    await Promise.all(aRemettre.slice(i, i + parallele).map(async ([chemin, info]) => {
      await bucket.upload(cheminLocal(dossier, chemin), { destination: chemin, contentType: info.type || undefined, resumable: false });
      remis++;
      progression(remis, aRemettre.length);
    }));
  }
  return { remis, total: aRemettre.length };
}

// Ne garde que les n sauvegardes de la base les plus récentes du dossier (papote-<date>.json, le nom porte la date).
// Rend les noms effacés. n = 0 : rien n'est effacé.
function garderDernieres(dossier, n = 4) {
  if (!n || n < 1) return [];
  const fs = require('fs');
  const fichiers = fs.readdirSync(dossier).filter((f) => /^papote-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const aEffacer = fichiers.slice(0, Math.max(0, fichiers.length - n));
  for (const f of aEffacer) fs.unlinkSync(pathLib.join(dossier, f));
  return aEffacer;
}

module.exports = { encoder, decoder, lotsDEcriture, MAX_OCTETS_LOT, toutLire, lireComptes, sauvegarder, restaurer, sauvegarderFichiers, verifierFichiers, restaurerFichiers, garderDernieres, VERSION };
