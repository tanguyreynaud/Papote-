// Faux Firebase pour la galerie : remplace tous les modules https://www.gstatic.com/firebasejs/…
// (app, auth, firestore, storage, functions, messaging, app-check) par une petite base en mémoire.
// Les données de départ viennent de window.__donnees (posées par la scène avant le chargement) :
//   { user: { uid, email, displayName } | null, docs: { 'families/F1': {...}, ... },
//     fonctions: { nomDeLaFonction: résultat }, fichiers: { 'chemin/storage': url } }
// Une date s'écrit { __ms: 1790000000000 } dans les données de départ.
// Rien ne part sur internet.

const D = window.__donnees || (window.__donnees = {});
const store = new Map();
const ecouteurs = new Set();

// ---------- Dates ----------

export class Timestamp {
  constructor(seconds, nanoseconds = 0) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
  static fromMillis(ms) { return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6); }
  static fromDate(d) { return Timestamp.fromMillis(d.getTime()); }
  static now() { return Timestamp.fromMillis(Date.now()); }
  toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
  toDate() { return new Date(this.toMillis()); }
  valueOf() { return String(this.toMillis()).padStart(15, '0'); }
}

function revivre(v) {
  if (Array.isArray(v)) return v.map(revivre);
  if (v && typeof v === 'object') {
    if (typeof v.__ms === 'number') return Timestamp.fromMillis(v.__ms);
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = revivre(x);
    return o;
  }
  return v;
}
for (const [chemin, data] of Object.entries(D.docs || {})) store.set(chemin, revivre(data));

// ---------- Références ----------

const db0 = { type: 'firestore' };
const segments = (args) => args.flatMap((a) => String(a).split('/')).filter(Boolean);

class DocRef {
  constructor(path) { this.path = path; this.type = 'document'; const s = path.split('/'); this.id = s[s.length - 1]; this.firestore = db0; }
  get parent() { return new CollRef(this.path.split('/').slice(0, -1).join('/')); }
}
class CollRef {
  constructor(path) { this.path = path; this.type = 'collection'; const s = path.split('/'); this.id = s[s.length - 1]; this.firestore = db0; }
  get parent() { const s = this.path.split('/'); return s.length > 1 ? new DocRef(s.slice(0, -1).join('/')) : null; }
}
let nId = 0;
const autoId = () => `auto${Date.now().toString(36)}${(nId++).toString(36)}`;

export function doc(base, ...rest) {
  if (base instanceof CollRef) return new DocRef(`${base.path}/${rest.length ? segments(rest).join('/') : autoId()}`);
  if (base instanceof DocRef) return new DocRef(`${base.path}/${segments(rest).join('/')}`);
  return new DocRef(segments(rest).join('/'));
}
export function collection(base, ...rest) {
  if (base instanceof DocRef || base instanceof CollRef) return new CollRef(`${base.path}/${segments(rest).join('/')}`);
  return new CollRef(segments(rest).join('/'));
}
export function collectionGroup(_db, id) { return { type: 'group', groupe: id, contraintes: [] }; }

// ---------- Requêtes ----------

export const where = (champ, op, valeur) => ({ k: 'where', champ, op, valeur });
export const orderBy = (champ, sens = 'asc') => ({ k: 'orderBy', champ, sens });
export const limit = (n) => ({ k: 'limit', n });
export const limitToLast = (n) => ({ k: 'limitToLast', n });
export const startAfter = (...v) => ({ k: 'startAfter', v });
export const documentId = () => '__name__';
export function query(base, ...contraintes) {
  return { ...base, cible: base.cible || base, contraintes: [...(base.contraintes || []), ...contraintes], type: 'query' };
}

const lire = (o, champ) => champ === '__name__' ? o.__id : champ.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
const cmp = (a, b) => {
  const va = a instanceof Timestamp ? a.toMillis() : a, vb = b instanceof Timestamp ? b.toMillis() : b;
  if (va == null && vb == null) return 0; if (va == null) return -1; if (vb == null) return 1;
  return va < vb ? -1 : va > vb ? 1 : 0;
};
function teste(v, op, x) {
  switch (op) {
    case '==': return cmp(v, x) === 0;
    case '!=': return cmp(v, x) !== 0;
    case '<': return cmp(v, x) < 0;
    case '<=': return cmp(v, x) <= 0;
    case '>': return cmp(v, x) > 0;
    case '>=': return cmp(v, x) >= 0;
    case 'in': return x.some((y) => cmp(v, y) === 0);
    case 'not-in': return !x.some((y) => cmp(v, y) === 0);
    case 'array-contains': return Array.isArray(v) && v.some((y) => cmp(y, x) === 0);
    case 'array-contains-any': return Array.isArray(v) && v.some((y) => x.some((z) => cmp(y, z) === 0));
    default: return true;
  }
}

function executer(q) {
  const cible = q.cible || q;
  let chemins;
  if (cible.type === 'group') {
    chemins = [...store.keys()].filter((p) => { const s = p.split('/'); return s.length % 2 === 0 && s[s.length - 2] === cible.groupe; });
  } else {
    const n = cible.path.split('/').length + 1;
    chemins = [...store.keys()].filter((p) => p.startsWith(cible.path + '/') && p.split('/').length === n);
  }
  let docs = chemins.map((p) => ({ path: p, data: store.get(p) }));
  for (const c of q.contraintes || []) {
    if (c.k === 'where') docs = docs.filter((d) => teste(lire({ ...d.data, __id: d.path.split('/').pop() }, c.champ), c.op, c.valeur));
  }
  const tris = (q.contraintes || []).filter((c) => c.k === 'orderBy');
  if (tris.length) docs.sort((a, b) => {
    for (const t of tris) { const r = cmp(lire(a.data, t.champ), lire(b.data, t.champ)); if (r) return t.sens === 'desc' ? -r : r; }
    return 0;
  });
  else docs.sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const c of q.contraintes || []) {
    if (c.k === 'limit') docs = docs.slice(0, c.n);
    if (c.k === 'limitToLast') docs = docs.slice(-c.n);
  }
  return docs;
}

// ---------- Instantanés ----------

const copie = (v) => (v instanceof Timestamp ? v : Array.isArray(v) ? v.map(copie) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copie(x)])) : v);
const META = { fromCache: false, hasPendingWrites: false };

class DocSnap {
  constructor(path, data) { this.ref = new DocRef(path); this.id = this.ref.id; this._d = data; this.metadata = META; }
  exists() { return this._d !== undefined; }
  data() { return this._d === undefined ? undefined : copie(this._d); }
  get(champ) { return this._d === undefined ? undefined : lire(this._d, champ); }
}
class QuerySnap {
  constructor(docs) { this.docs = docs.map((d) => new DocSnap(d.path, d.data)); this.size = this.docs.length; this.empty = !this.size; this.metadata = META; }
  forEach(fn) { this.docs.forEach(fn); }
  docChanges() { return this.docs.map((d, i) => ({ type: 'added', doc: d, oldIndex: -1, newIndex: i })); }
}
const instantane = (ref) => (ref instanceof DocRef ? new DocSnap(ref.path, store.get(ref.path)) : new QuerySnap(executer(ref)));

export async function getDoc(ref) { return instantane(ref); }
export const getDocFromServer = getDoc;
export const getDocFromCache = getDoc;
export async function getDocs(q) { return instantane(q); }
export const getDocsFromServer = getDocs;
export async function getCountFromServer(q) { const n = executer(q).length; return { data: () => ({ count: n }) }; }

export function onSnapshot(ref, ...args) {
  if (args[0] && typeof args[0] === 'object' && !args[0].next && typeof args[0] !== 'function') args.shift();
  let suite = args[0], erreur = args[1];
  if (suite && typeof suite === 'object') { erreur = suite.error; suite = suite.next; }
  const e = { ref, suite, erreur };
  ecouteurs.add(e);
  setTimeout(() => { if (ecouteurs.has(e)) suite?.(instantane(ref)); }, 0);
  return () => ecouteurs.delete(e);
}
function prevenir() {
  for (const e of [...ecouteurs]) setTimeout(() => { if (ecouteurs.has(e)) e.suite?.(instantane(e.ref)); }, 0);
}

// ---------- Écritures ----------

const SENTINELLE = Symbol('valeur spéciale');
export const serverTimestamp = () => ({ [SENTINELLE]: 'temps' });
export const deleteField = () => ({ [SENTINELLE]: 'effacer' });
export const increment = (n) => ({ [SENTINELLE]: 'plus', n });
export const arrayUnion = (...v) => ({ [SENTINELLE]: 'union', v });
export const arrayRemove = (...v) => ({ [SENTINELLE]: 'retirer', v });

function appliquer(ancien, valeur) {
  const s = valeur && valeur[SENTINELLE];
  if (s === 'temps') return Timestamp.now();
  if (s === 'plus') return (typeof ancien === 'number' ? ancien : 0) + valeur.n;
  if (s === 'union') return [...(Array.isArray(ancien) ? ancien : []), ...valeur.v.filter((x) => !(ancien || []).includes(x))];
  if (s === 'retirer') return (Array.isArray(ancien) ? ancien : []).filter((x) => !valeur.v.includes(x));
  if (valeur && typeof valeur === 'object' && !(valeur instanceof Timestamp) && !Array.isArray(valeur) && !(valeur instanceof Blob)) {
    const o = {};
    for (const [k, x] of Object.entries(valeur)) { if (!(x && x[SENTINELLE] === 'effacer')) o[k] = appliquer(undefined, x); }
    return o;
  }
  return valeur;
}
function fusionner(cible, data) {
  const o = { ...(cible || {}) };
  for (const [k, x] of Object.entries(data)) {
    if (x && x[SENTINELLE] === 'effacer') delete o[k];
    else if (x && typeof x === 'object' && !x[SENTINELLE] && !(x instanceof Timestamp) && !Array.isArray(x) && o[k] && typeof o[k] === 'object' && !(o[k] instanceof Timestamp)) o[k] = fusionner(o[k], x);
    else o[k] = appliquer(o[k], x);
  }
  return o;
}
function poserChamp(o, chemin, x) {
  const ks = chemin.split('.');
  let c = o;
  for (const k of ks.slice(0, -1)) { c[k] = c[k] && typeof c[k] === 'object' ? { ...c[k] } : {}; c = c[k]; }
  const der = ks[ks.length - 1];
  if (x && x[SENTINELLE] === 'effacer') delete c[der]; else c[der] = appliquer(c[der], x);
}

// Balayage « double clic » (double.js) : chaque écriture est notée dans window.__ecritures { op, chemin }.
function noter(op, chemin) { (window.__ecritures || (window.__ecritures = [])).push({ op, chemin }); }
function ecrireSet(ref, data, opts) {
  noter(opts && (opts.merge || opts.mergeFields) ? 'fusion' : 'set', ref.path);
  store.set(ref.path, opts && (opts.merge || opts.mergeFields) ? fusionner(store.get(ref.path), data) : appliquer(undefined, data));
}
function ecrireUpdate(ref, a, ...rest) {
  noter('update', ref.path);
  if (!store.has(ref.path)) { const e = new Error(`No document to update: ${ref.path}`); e.code = 'not-found'; throw e; }
  const o = copie(store.get(ref.path));
  const paires = typeof a === 'string' ? [[a, rest[0]], ...rest.slice(1).reduce((acc, x, i, arr) => (i % 2 ? acc : [...acc, [x, arr[i + 1]]]), [])] : Object.entries(a);
  for (const [k, x] of paires) poserChamp(o, k, x);
  store.set(ref.path, o);
}

// Balayage « double clic » : la base ne répond jamais non plus (une vraie écriture prend 100 à 300 ms, le 2e clic
// d'un double clic arrive avant) ; l'écriture est notée, puis l'attente dure.
const bloquee = () => !!window.__ecrituresBloquees;
export async function setDoc(ref, data, opts) { ecrireSet(ref, data, opts); if (bloquee()) return jamais(); prevenir(); }
export async function updateDoc(ref, ...a) { ecrireUpdate(ref, ...a); if (bloquee()) return jamais(); prevenir(); }
export async function deleteDoc(ref) { noter('delete', ref.path); store.delete(ref.path); if (bloquee()) return jamais(); prevenir(); }
export async function addDoc(coll, data) { const ref = doc(coll); noter('add', coll.path); ecrireSet(ref, data); if (bloquee()) return jamais(); prevenir(); return ref; }
export function writeBatch() {
  const ops = [];
  const b = {
    set: (r, d, o) => { ops.push(() => ecrireSet(r, d, o)); return b; },
    update: (r, ...a) => { ops.push(() => ecrireUpdate(r, ...a)); return b; },
    delete: (r) => { ops.push(() => { noter('delete', r.path); store.delete(r.path); }); return b; },
    commit: async () => { noter('commit', ''); ops.forEach((f) => f()); if (bloquee()) return jamais(); prevenir(); },
  };
  return b;
}
export async function runTransaction(_db, fn) {
  noter('transaction', '');
  const b = writeBatch();
  const r = await fn({ get: getDoc, set: (...a) => { b.set(...a); }, update: (...a) => { b.update(...a); }, delete: (r) => { b.delete(r); } });
  await b.commit();
  return r;
}

export const initializeFirestore = () => db0;
export const getFirestore = () => db0;
export const persistentLocalCache = () => ({});
export const persistentSingleTabManager = () => ({});
export const persistentMultipleTabManager = () => ({});
export const enableIndexedDbPersistence = async () => {};
export const connectFirestoreEmulator = () => {};

// ---------- App, App Check ----------

const app0 = { name: '[DEFAULT]', options: { projectId: 'faux' } };
export const initializeApp = () => app0;
export const getApp = () => app0;
export const getApps = () => [app0];
export const initializeAppCheck = () => ({});
export class ReCaptchaEnterpriseProvider { constructor(k) { this.k = k; } }
export class ReCaptchaV3Provider { constructor(k) { this.k = k; } }
export const getToken = async () => 'faux-jeton';

// ---------- Connexion ----------

function utilisateur(u) {
  if (!u) return null;
  return {
    isAnonymous: false, emailVerified: true, providerData: [{ providerId: 'google.com' }], photoURL: null,
    displayName: null, ...u,
    getIdToken: async () => 'faux-jeton', getIdTokenResult: async () => ({ claims: u.claims || {} }), reload: async () => {},
  };
}
const auth0 = { currentUser: utilisateur(D.user), app: app0, languageCode: 'fr' };
const suiveurs = new Set();
export const getAuth = () => auth0;
export function onAuthStateChanged(_a, fn) { suiveurs.add(fn); setTimeout(() => fn(auth0.currentUser), 0); return () => suiveurs.delete(fn); }
export const onIdTokenChanged = onAuthStateChanged;
export async function signOut() { auth0.currentUser = null; suiveurs.forEach((f) => f(null)); }
export const getRedirectResult = async () => null;
export const isSignInWithEmailLink = () => false;
const pasIci = async () => { const e = new Error('Connexion impossible dans la galerie'); e.code = 'auth/operation-not-allowed'; throw e; };
export const signInWithPopup = pasIci, signInWithRedirect = pasIci, linkWithPopup = pasIci, linkWithRedirect = pasIci,
  signInWithCredential = pasIci, linkWithCredential = pasIci, signInWithEmailLink = pasIci, signInAnonymously = pasIci,
  signInWithCustomToken = pasIci;
export const sendSignInLinkToEmail = async () => {};
export const connectAuthEmulator = () => {};
export class GoogleAuthProvider { setCustomParameters() { return this; } addScope() { return this; } static credentialFromError() { return null; } static credential() { return {}; } }
export class EmailAuthProvider { static credentialWithLink() { return {}; } }

// ---------- Stockage ----------

const storage0 = { app: app0 };
export const getStorage = () => storage0;
export const ref = (_s, chemin = '') => ({ fullPath: chemin, name: chemin.split('/').pop() });
export const getDownloadURL = async (r) => (D.fichiers || {})[r.fullPath] || D.imageParDefaut || '';
// D.envoiBloque : l'envoi reste en cours (à 40 %), pour voir l'écran « Envoi… ».
const jamais = () => new Promise(() => {});
export const uploadBytes = async (r) => (noter('upload', r.fullPath), D.envoiBloque ? jamais() : { ref: r, metadata: {} });
export const uploadBytesResumable = (r) => (noter('upload', r.fullPath), {
  on: (_e, progres, _err, fin) => { if (D.envoiBloque) { setTimeout(() => progres?.({ bytesTransferred: 40, totalBytes: 100 }), 0); return; } setTimeout(() => fin?.(), 0); },
  then: (f, g) => (D.envoiBloque ? jamais() : Promise.resolve({ ref: r })).then(f, g),
});
export const uploadString = async (r) => (noter('upload', r.fullPath), D.envoiBloque ? jamais() : { ref: r });
export const deleteObject = async () => {};
export const connectStorageEmulator = () => {};

// ---------- Fonctions serveur ----------

export const getFunctions = () => ({});
export const connectFunctionsEmulator = () => {};
export function httpsCallable(_f, nom) {
  return async (data) => {
    (window.__appels || (window.__appels = [])).push({ nom, data });
    // Balayage des boutons (boutons.js) : le serveur ne répond jamais, pour voir ce que montre l'écran en attendant.
    if (window.__fonctionsBloquees) return new Promise(() => {});
    let r = (D.fonctions || {})[nom];
    // { __ecrire: { chemin: données }, __si: 'champ', resultat } : le « serveur » écrit dans la base
    // (seulement si l'appel porte ce champ), puis répond resultat.
    if (r && r.__ecrire) {
      if (!r.__si || (data && data[r.__si])) { for (const [p, d] of Object.entries(r.__ecrire)) store.set(p, revivre(d)); prevenir(); }
      r = r.resultat;
    }
    if (r && r.erreur) { const e = new Error(r.erreur); e.code = r.code || 'functions/internal'; throw e; }
    return { data: r === undefined ? {} : r };
  };
}

// ---------- Notifications ----------

export const isSupported = async () => false;
export const getMessaging = () => ({});
export const onMessage = () => () => {};
export const deleteToken = async () => true;

// La scène peut modifier la base après le chargement (window.__base.set('chemin', {...})).
window.__base = {
  set: (p, d) => { store.set(p, revivre(d)); prevenir(); },
  get: (p) => store.get(p),
  delete: (p) => { store.delete(p); prevenir(); },
  chemins: () => [...store.keys()],
};
