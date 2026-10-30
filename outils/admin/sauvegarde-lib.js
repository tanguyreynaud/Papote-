// Sauvegarde et restauration de la base Firestore (et de la liste des comptes) : le cœur, sans ligne de commande,
// pour être testé sur l'émulateur (sauvegarde.test.js) et utilisé par sauvegarder.js / restaurer.js.
//
// Format : un fichier JSON { version, le, projet, base, documents: [{ chemin, donnees }], comptes: [...] }.
// Les valeurs Firestore qui n'existent pas en JSON sont encodées : { "@type": "timestamp", "ms", "ns" },
// { "@type": "geo", "lat", "lon" }, { "@type": "ref", "chemin" }, { "@type": "bytes", "base64" }. Les cartes qui
// auraient elles-mêmes une clé « @type » sont protégées ({ "@type": "map", "valeurs" }).
const { Timestamp, GeoPoint, DocumentReference } = require('firebase-admin/firestore');

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

// Réécrit chaque document tel qu'il était (set complet, 400 par lot). Les documents présents dans la base et absents
// de la sauvegarde sont laissés tels quels, sauf avec effacer: true (remise exacte à l'état sauvegardé).
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
  let ecrits = 0;
  for (let i = 0; i < sauvegarde.documents.length; i += 400) {
    const lot = db.batch();
    for (const d of sauvegarde.documents.slice(i, i + 400)) lot.set(db.doc(d.chemin), decoder(d.donnees, db));
    await lot.commit();
    ecrits += Math.min(400, sauvegarde.documents.length - i);
    progression(ecrits);
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

module.exports = { encoder, decoder, toutLire, lireComptes, sauvegarder, restaurer, VERSION };
