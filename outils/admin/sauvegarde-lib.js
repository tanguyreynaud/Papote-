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

// Format 2 (12/11) : un dossier par sauvegarde, un document par ligne (ecrireSauvegarde). Le format 1 (un seul
// fichier JSON) se relit toujours (lireSauvegarde).
const VERSION = 2;

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
// (listCollections, en parallèle par paquets), lus par pages de 500. Chaque document est passé tout de suite à
// surDocument (qui peut être async : l'écriture sur le disque attend le disque) : rien n'est gardé en mémoire, la
// taille de la base n'a plus de limite (audit 12/11, N2 : un seul texte JSON s'arrêtait vers 20 à 40 familles).
// Rend le nombre de documents.
async function parcourir(db, surDocument, { progression = () => {}, parallele = 25 } = {}) {
  let n = 0;
  const aVisiter = await db.listCollections();
  while (aVisiter.length) {
    const collection = aVisiter.shift();
    let page = await collection.orderBy('__name__').limit(500).get();
    while (!page.empty) {
      const refs = [];
      for (const d of page.docs) {
        await surDocument({ chemin: d.ref.path, donnees: encoder(d.data()) });
        refs.push(d.ref);
        n++;
      }
      for (let i = 0; i < refs.length; i += parallele) {
        const sous = await Promise.all(refs.slice(i, i + parallele).map((r) => r.listCollections()));
        sous.forEach((liste) => aVisiter.push(...liste));
      }
      progression(n);
      if (page.size < 500) break;
      page = await collection.orderBy('__name__').startAfter(page.docs[page.docs.length - 1]).limit(500).get();
    }
  }
  return n;
}

// Toute la base en mémoire, dans l'ordre des chemins (petites bases : tests, vérification, exercices).
async function toutLire(db, options = {}) {
  const documents = [];
  await parcourir(db, (d) => { documents.push(d); }, options);
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

// Sauvegarde en mémoire (format 1 : { version, le, projet, base, documents: [...], comptes: [...] }) : pour les
// tests et les exercices sur de petites bases. La sauvegarde du dimanche écrit sur le disque (ecrireSauvegarde).
async function sauvegarder({ db, auth = null, projet = '', base = '', progression }) {
  const documents = await toutLire(db, { progression });
  const comptes = auth ? await lireComptes(auth) : [];
  return { version: 1, le: new Date().toISOString(), projet, base: base || nomBase(db), documents, comptes };
}

const nomBase = (db) => (db && db.databaseId) || '(default)';

// Lots d'écriture : 400 documents au plus, et 3,5 Mio au plus en tout. Firestore refuse une requête de plus de
// 10 Mio (et l'émulateur reste bloqué au-delà de 4 Mio environ), or un document peut peser près de 1 Mio (photo
// en taille réelle posts/{id}/media/image, morceaux de vidéo de 700 000 caractères) : 400 documents de ce genre ne
// passent pas en un seul commit. La taille est estimée d'après le JSON du document (plus grande que la taille
// réelle : le base64 des octets compte 4/3). Un document seul plus gros que la limite part seul dans son lot.
const MAX_DOCS_LOT = 400;
const MAX_OCTETS_LOT = 3.5 * 1024 * 1024;
const tailleEstimee = (d) => Buffer.byteLength(d.chemin) + Buffer.byteLength(JSON.stringify(d.donnees || {})) + 64;
// Découpe au fil de l'eau : ajouter(d) rend le lot précédent quand d n'y tient plus, reste() le dernier.
function decoupeur({ maxDocs = MAX_DOCS_LOT, maxOctets = MAX_OCTETS_LOT } = {}) {
  let lot = [];
  let octets = 0;
  return {
    ajouter(d) {
      const taille = tailleEstimee(d);
      let plein = null;
      if (lot.length && (lot.length >= maxDocs || octets + taille > maxOctets)) {
        plein = lot;
        lot = [];
        octets = 0;
      }
      lot.push(d);
      octets += taille;
      return plein;
    },
    reste: () => (lot.length ? lot : null),
  };
}
function lotsDEcriture(documents, options) {
  const d = decoupeur(options);
  const lots = [];
  for (const doc of documents) { const plein = d.ajouter(doc); if (plein) lots.push(plein); }
  if (d.reste()) lots.push(d.reste());
  return lots;
}

// Documents qui ne sont jamais réécrits par une restauration : le drapeau de restauration lui-même, et le relevé
// de la dernière sauvegarde réussie (interne/sauvegarde, lu par l'alerte des 8 jours) qui doit rester le vrai.
const JAMAIS_RESTAURES = new Set(['interne/restauration', 'interne/sauvegarde']);

// Réécrit chaque document tel qu'il était (set complet, par lots : lotsDEcriture). Les documents présents dans la
// base et absents de la sauvegarde sont laissés tels quels, sauf avec effacer: true (remise exacte à l'état sauvegardé).
// sauvegarde.documents : un tableau (format 1) ou un itérable asynchrone relisible (format 2, lireSauvegarde).
// Mauvaise base (audit A15-2) : la sauvegarde porte le nom de la base d'où elle vient ; la restaurer dans une autre
// base est refusé, sauf autreBase: true (restaurer.bat --autre-base), par exemple vers une base « europe2 » neuve.
async function restaurer({ db, auth = null, sauvegarde, effacer = false, autreBase = false, progression = () => {} }) {
  if (![1, VERSION].includes(sauvegarde.version)) throw new Error(`Version de sauvegarde inconnue : ${sauvegarde.version}`);
  const cible = nomBase(db);
  if (!autreBase && sauvegarde.base !== cible) {
    throw new Error(`cette sauvegarde vient de la base « ${sauvegarde.base || 'inconnue'} », pas de « ${cible} » : restauration refusée. `
      + 'Pour la mettre exprès dans une autre base, relancer avec --autre-base.');
  }
  if (effacer) {
    const garder = new Set();
    for await (const d of sauvegarde.documents) garder.add(d.chemin);
    const aEffacer = [];
    await parcourir(db, (d) => { if (!garder.has(d.chemin) && !JAMAIS_RESTAURES.has(d.chemin)) aEffacer.push(d.chemin); });
    for (let i = 0; i < aEffacer.length; i += 400) {
      const lot = db.batch();
      aEffacer.slice(i, i + 400).forEach((c) => lot.delete(db.doc(c)));
      await lot.commit();
    }
  }
  // Pendant l'écriture, les déclencheurs du serveur qui préviennent des humains ou réveillent des tablettes se
  // taisent (functions/base.js restaurationEnCours) : drapeau interne/restauration, 2 h au plus, retiré à la fin.
  const drapeau = db.doc('interne/restauration');
  await drapeau.set({ enCours: true, jusque: Timestamp.fromMillis(Date.now() + 2 * 3600 * 1000), le: Timestamp.now() });
  let ecrits = 0;
  const ecrire = async (paquet) => {
    const lot = db.batch();
    for (const d of paquet) lot.set(db.doc(d.chemin), decoder(d.donnees, db));
    await lot.commit();
    ecrits += paquet.length;
    progression(ecrits);
  };
  try {
    const lots = decoupeur();
    for await (const d of sauvegarde.documents) {
      if (JAMAIS_RESTAURES.has(d.chemin)) continue;
      const plein = lots.ajouter(d);
      if (plein) await ecrire(plein);
    }
    if (lots.reste()) await ecrire(lots.reste());
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

// ---------- Fichiers du stockage (Storage) ----------
// Les fichiers du bucket sont copiés tels quels dans un dossier (fichiers/<chemin dans le bucket>), avec un index
// (fichiers/index.json : chemin → { md5, taille, type }). Copie incrémentale : seul ce qui est nouveau ou a changé
// est téléchargé ; rien n'est jamais effacé du dossier (un fichier supprimé depuis reste dans la copie).
// prefixe : seulement ce dossier du bucket. La sauvegarde du dimanche copie toujours « gestion/ » (factures de
// vente à garder 10 ans, livres du mois, pièces d'achat : audit 12/11, N5) ; les photos et vidéos seulement avec --photos.
const fsp = require('fs').promises;
const pathLib = require('path');
const crypto = require('crypto');

const INDEX = 'index.json';
const cheminLocal = (dossier, chemin) => pathLib.join(dossier, ...chemin.split('/'));

async function lireIndex(dossier) {
  try { return JSON.parse(await fsp.readFile(pathLib.join(dossier, INDEX), 'utf8')); } catch { return {}; }
}

async function sauvegarderFichiers({ bucket, dossier, prefixe = '', progression = () => {}, parallele = 8 }) {
  await fsp.mkdir(dossier, { recursive: true });
  const index = await lireIndex(dossier);
  const [tous] = await bucket.getFiles(prefixe ? { prefix: prefixe, autoPaginate: true } : { autoPaginate: true });
  const fichiers = tous.filter((f) => f.name.startsWith(prefixe));
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

// Vérifie la copie locale : chaque fichier de l'index (sous prefixe) existe et a bien le même contenu (md5). Rend
// les manquants et les abîmés.
async function verifierFichiers(dossier, { prefixe = '' } = {}) {
  const index = await lireIndex(dossier);
  const manquants = [];
  const abimes = [];
  const entrees = Object.entries(index).filter(([chemin]) => chemin.startsWith(prefixe));
  for (const [chemin, info] of entrees) {
    let contenu;
    try { contenu = await fsp.readFile(cheminLocal(dossier, chemin)); } catch { manquants.push(chemin); continue; }
    if (crypto.createHash('md5').update(contenu).digest('base64') !== info.md5) abimes.push(chemin);
  }
  return { total: entrees.length, manquants, abimes };
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


// ---------- Sauvegarde sur le disque, format 2 (audit 12/11, N2, A15-3) ----------
// Un dossier par sauvegarde, papote-<date>/ :
//   documents.jsonl  un document par ligne { chemin, donnees } (écrit et relu ligne à ligne : pas de limite de taille)
//   comptes.jsonl    un compte par ligne
//   entete.json      { version: 2, le, projet, base, configBase, documents: { lignes, octets, sha256 }, comptes: {…},
//                      gestion: { fichiers, nouveaux, octets }, photos, complete: true }, écrit EN DERNIER
// Les fichiers du stockage vont à côté, dans le dossier fichiers/ commun à toutes les sauvegardes (incrémental).
// La sauvegarde s'écrit d'abord dans papote-<date>.en-cours/, est relue et contrôlée (nombre de lignes, empreinte
// sha256, chaque ligne lisible), puis seulement renommée en papote-<date>/. La rotation ne compte que les
// sauvegardes complètes et passe après ce contrôle : une sauvegarde coupée au milieu n'efface jamais une ancienne.
const PREFIXE_GESTION = 'gestion/';
const EN_COURS = '.en-cours';
const ENTETE_FICHIER = 'entete.json';
const DONNEES = { documents: 'documents.jsonl', comptes: 'comptes.jsonl' };
const NOM = /^papote-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/;
const ANCIEN_FORMAT = /^papote-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json(\.enc)?$/;
const nomSauvegarde = (date) => `papote-${date.toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
const { once } = require('events');
const readline = require('readline');

// Écrit des lignes JSON dans un fichier en attendant le disque (pas de tout-en-mémoire), avec l'empreinte.
function ecrivain(fichier) {
  const flux = require('fs').createWriteStream(fichier);
  const hash = crypto.createHash('sha256');
  let lignes = 0;
  let octets = 0;
  let erreur = null;
  flux.on('error', (e) => { erreur = e; });
  return {
    async ligne(objet) {
      if (erreur) throw erreur;
      const t = Buffer.from(`${JSON.stringify(objet)}\n`);
      hash.update(t);
      octets += t.length;
      lignes++;
      if (!flux.write(t)) await once(flux, 'drain');
    },
    async fermer() {
      if (!flux.writableEnded) await new Promise((ok, ko) => { flux.once('error', ko); flux.end(ok); });
      if (erreur) throw erreur;
      return { lignes, octets, sha256: hash.digest('hex') };
    },
  };
}

async function* lignes(fichier) {
  const rl = readline.createInterface({ input: require('fs').createReadStream(fichier), crlfDelay: Infinity });
  for await (const l of rl) if (l) yield JSON.parse(l);
}

// Relit un fichier de lignes : nombre de lignes, octets, empreinte, et chaque ligne doit se lire en JSON.
async function mesurer(fichier) {
  const hash = crypto.createHash('sha256');
  let octets = 0;
  let n = 0;
  let reste = '';
  for await (const morceau of require('fs').createReadStream(fichier)) {
    hash.update(morceau);
    octets += morceau.length;
    const texte = reste + morceau.toString('utf8');
    const parties = texte.split('\n');
    reste = parties.pop();
    for (const p of parties) {
      n++;
      try { JSON.parse(p); } catch { throw new Error(`${pathLib.basename(fichier)} : ligne ${n} illisible`); }
    }
  }
  if (reste) throw new Error(`${pathLib.basename(fichier)} : dernière ligne coupée`);
  return { lignes: n, octets, sha256: hash.digest('hex') };
}

// Contrôle d'un dossier de sauvegarde : chaque fichier de données a exactement les lignes et l'empreinte notées
// dans entete.json. Rend l'entête ; lance une erreur sinon.
async function verifierDossier(chemin) {
  let entete;
  try { entete = JSON.parse(await fsp.readFile(pathLib.join(chemin, ENTETE_FICHIER), 'utf8')); } catch {
    throw new Error(`${pathLib.basename(chemin)} : pas d'entete.json lisible, sauvegarde incomplète`);
  }
  if (!entete.complete) throw new Error(`${pathLib.basename(chemin)} : sauvegarde incomplète`);
  for (const [cle, fichier] of Object.entries(DONNEES)) {
    const m = await mesurer(pathLib.join(chemin, fichier));
    const attendu = entete[cle] || {};
    if (m.lignes !== attendu.lignes || m.sha256 !== attendu.sha256) {
      throw new Error(`${fichier} : ${m.lignes} lignes relues pour ${attendu.lignes} écrites, ou contenu différent`);
    }
  }
  return entete;
}

// La sauvegarde du dimanche (sauvegarder.js). bucket : celui du stockage (null = pas de fichiers, pour les tests
// sans stockage) ; photos : copier tout le bucket au lieu du seul dossier gestion/. Rend { nom, dossier, entete,
// effacees }. Une erreur à n'importe quelle étape laisse papote-<date>.en-cours/ (effacé à la sauvegarde réussie
// suivante) et ne touche à aucune sauvegarde d'avant.
async function ecrireSauvegarde({ db, auth = null, bucket = null, dossier, projet = '', base = '', configBase = null, photos = false,
  garder = 4, le = new Date(), progression = () => {}, progressionFichiers = () => {} }) {
  await fsp.mkdir(dossier, { recursive: true });
  const nom = nomSauvegarde(le);
  const enCours = pathLib.join(dossier, nom + EN_COURS);
  await fsp.rm(enCours, { recursive: true, force: true });
  await fsp.mkdir(enCours);

  const ecrire = async (fichier, remplir) => {
    const e = ecrivain(pathLib.join(enCours, fichier));
    try { await remplir((x) => e.ligne(x)); } catch (err) { await e.fermer().catch(() => null); throw err; }
    return e.fermer();
  };
  const documents = await ecrire(DONNEES.documents, (ligne) => parcourir(db, ligne, { progression }));
  const comptes = await ecrire(DONNEES.comptes, async (ligne) => { for (const c of auth ? await lireComptes(auth) : []) await ligne(c); });

  let gestion = null;
  if (bucket) {
    const dossierFichiers = pathLib.join(dossier, 'fichiers');
    const copier = () => sauvegarderFichiers({ bucket, dossier: dossierFichiers, prefixe: photos ? '' : PREFIXE_GESTION, progression: progressionFichiers });
    let f = await copier();
    let v = await verifierFichiers(dossierFichiers, { prefixe: PREFIXE_GESTION });
    if (v.manquants.length || v.abimes.length) {
      // Copie locale abîmée ou fichier effacé à la main : retirés de l'index, retéléchargés une fois.
      const index = await lireIndex(dossierFichiers);
      for (const c of [...v.manquants, ...v.abimes]) delete index[c];
      await fsp.writeFile(pathLib.join(dossierFichiers, INDEX), JSON.stringify(index));
      f = await copier();
      v = await verifierFichiers(dossierFichiers, { prefixe: PREFIXE_GESTION });
    }
    if (v.manquants.length || v.abimes.length) {
      throw new Error(`copie du dossier gestion/ : ${v.manquants.length} fichier(s) manquant(s), ${v.abimes.length} abîmé(s)`);
    }
    gestion = { fichiers: v.total, nouveaux: f.copies, octets: f.octets };
  }

  const entete = { version: VERSION, le: le.toISOString(), projet, base: base || nomBase(db), configBase, documents, comptes, gestion, photos: !!photos, complete: true };
  await fsp.writeFile(pathLib.join(enCours, ENTETE_FICHIER), JSON.stringify(entete, null, 1));
  await verifierDossier(enCours);
  const final = pathLib.join(dossier, nom);
  await fsp.rename(enCours, final);
  const effacees = garderDernieres(dossier, garder);
  return { nom, dossier: final, entete, effacees };
}

// Relit une sauvegarde pour restaurer() : un dossier (format 2) ou un ancien fichier .json (format 1). Les documents
// d'un dossier sont relus ligne à ligne à chaque passage (jamais tous en mémoire).
async function lireSauvegarde(chemin) {
  const dossierFichiers = pathLib.join(pathLib.dirname(pathLib.resolve(chemin)), 'fichiers');
  if (!(await fsp.stat(chemin)).isDirectory()) {
    const s = JSON.parse(await fsp.readFile(chemin, 'utf8'));
    return { ...s, nbDocuments: s.documents.length, dossierFichiers };
  }
  const entete = await verifierDossier(chemin);
  const comptes = [];
  for await (const c of lignes(pathLib.join(chemin, DONNEES.comptes))) comptes.push(c);
  const fichier = pathLib.join(chemin, DONNEES.documents);
  return {
    version: entete.version, le: entete.le, projet: entete.projet, base: entete.base, configBase: entete.configBase || null,
    entete, nbDocuments: entete.documents.lignes, documents: { [Symbol.asyncIterator]: () => lignes(fichier) }, comptes, dossierFichiers,
  };
}

function lireEntete(chemin) {
  try { return JSON.parse(require('fs').readFileSync(pathLib.join(chemin, ENTETE_FICHIER), 'utf8')); } catch { return null; }
}

// Rotation (audit A15-3 : avant, quatre dimanches ratés ou vides effaçaient la dernière bonne sauvegarde).
// - Seules les sauvegardes complètes (entete.json « complete ») comptent ; on garde les n plus récentes.
// - La plus récente sauvegarde « pleine » (au moins la moitié des documents de la plus grosse) n'est jamais effacée,
//   même si n sauvegardes vides ou presque l'ont suivie (base vidée par erreur, outil de test lancé…).
// - Les dossiers .en-cours plus anciens que la dernière sauvegarde complète (sauvegardes coupées) sont effacés.
// - Les anciens fichiers .json (.json.enc) du format 1 ne sont effacés qu'une fois n sauvegardes complètes du
//   nouveau format présentes.
// Rend les noms effacés. n = 0 : rien n'est effacé. Sert aussi pour le dossier de la copie chiffrée.
function garderDernieres(dossier, n = 4) {
  if (!n || n < 1) return [];
  const fs = require('fs');
  const noms = fs.readdirSync(dossier).sort();
  const completes = noms.filter((f) => NOM.test(f)).map((f) => ({ nom: f, entete: lireEntete(pathLib.join(dossier, f)) }))
    .filter((x) => x.entete && x.entete.complete);
  const effacer = [];
  if (completes.length > n) {
    const taille = (x) => (x.entete.documents && x.entete.documents.lignes) || 0;
    const plusGrosse = Math.max(...completes.map(taille));
    const protegee = [...completes].reverse().find((x) => taille(x) >= plusGrosse / 2);
    for (const x of completes.slice(0, completes.length - n)) if (x !== protegee) effacer.push(x.nom);
  }
  const derniere = completes.length ? completes[completes.length - 1].nom : null;
  for (const f of noms) {
    const base = f.endsWith(EN_COURS) ? f.slice(0, -EN_COURS.length) : null;
    if (base && NOM.test(base) && derniere && base < derniere) effacer.push(f);
  }
  if (completes.length >= n) effacer.push(...noms.filter((f) => ANCIEN_FORMAT.test(f)));
  for (const f of effacer) fs.rmSync(pathLib.join(dossier, f), { recursive: true, force: true });
  return effacer;
}

// ---------- Copie chiffrée hors de Google (sauvegarder.js --copie) ----------
// racine/papote-<date>/ : documents.jsonl.enc, comptes.jsonl.enc (chiffrés au fil de l'eau, chiffrement.js format 2)
// et entete.json en clair (nombres, empreintes : rien de personnel ; la rotation le lit sans la phrase).
// racine/fichiers/ : les fichiers de gestion/ chiffrés un par un (<chemin>.enc), incrémental, avec index.json.
// Même règle que la sauvegarde : écrite en .en-cours, relue (déchiffrée et comparée à l'empreinte), renommée,
// puis rotation (12 gardées).
async function copierChiffre({ source, racine, phrase, fichiers = null, garder = 12 }) {
  const { chiffrerFichier, dechiffrerFichier } = require('./chiffrement');
  const entete = await verifierDossier(source);
  const nom = pathLib.basename(source);
  await fsp.mkdir(racine, { recursive: true });
  const enCours = pathLib.join(racine, nom + EN_COURS);
  await fsp.rm(enCours, { recursive: true, force: true });
  await fsp.mkdir(enCours);
  for (const [cle, fichier] of Object.entries(DONNEES)) {
    const cible = pathLib.join(enCours, `${fichier}.enc`);
    await chiffrerFichier(pathLib.join(source, fichier), cible, phrase);
    const relu = await dechiffrerFichier(cible, null, phrase);
    if (relu.sha256 !== entete[cle].sha256) throw new Error(`copie chiffrée de ${fichier} : relecture différente`);
  }
  await fsp.copyFile(pathLib.join(source, ENTETE_FICHIER), pathLib.join(enCours, ENTETE_FICHIER));
  const final = pathLib.join(racine, nom);
  await fsp.rename(enCours, final);

  let copies = 0;
  if (fichiers) {
    const index = await lireIndex(fichiers);
    const dossierCopie = pathLib.join(racine, 'fichiers');
    await fsp.mkdir(dossierCopie, { recursive: true });
    const indexCopie = await lireIndex(dossierCopie);
    for (const [chemin, info] of Object.entries(index)) {
      if (!chemin.startsWith(PREFIXE_GESTION) || (indexCopie[chemin] && indexCopie[chemin].md5 === info.md5)) continue;
      const cible = `${cheminLocal(dossierCopie, chemin)}.enc`;
      await fsp.mkdir(pathLib.dirname(cible), { recursive: true });
      await chiffrerFichier(cheminLocal(fichiers, chemin), cible, phrase);
      indexCopie[chemin] = info;
      copies++;
      if (copies % 50 === 0) await fsp.writeFile(pathLib.join(dossierCopie, INDEX), JSON.stringify(indexCopie));
    }
    await fsp.writeFile(pathLib.join(dossierCopie, INDEX), JSON.stringify(indexCopie));
  }
  return { dossier: final, fichiers: copies, effacees: garderDernieres(racine, garder) };
}

module.exports = {
  encoder, decoder, lotsDEcriture, MAX_OCTETS_LOT, parcourir, toutLire, lireComptes, sauvegarder, restaurer,
  sauvegarderFichiers, verifierFichiers, restaurerFichiers, garderDernieres, VERSION,
  ecrireSauvegarde, lireSauvegarde, verifierDossier, copierChiffre, nomSauvegarde, lignes, PREFIXE_GESTION, DONNEES, EN_COURS,
};
