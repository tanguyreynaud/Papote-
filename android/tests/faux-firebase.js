// Faux Firebase (app, App Check, Auth, Firestore, Functions) pour le banc d'essai : servi à la place
// des fichiers de www.gstatic.com/firebasejs/… importés par appels.js. Une base en mémoire, partagée
// par tous les modules de la page (window.__fs), avec les écoutes en direct (onSnapshot).
// Le banc lit et écrit la même base : window.__fs.ecrire(chemin, données), window.__fs.lire(chemin).
const fs = window.__fs || (window.__fs = (() => {
  const docs = new Map();      // chemin -> données
  const ecoutes = new Set();   // { cible, suivant, erreur, avant }
  let auto = 0;
  const horodatage = (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms), seconds: Math.floor(ms / 1000) });
  const resoudre = (v) => {
    if (v && v.__serverTimestamp) return horodatage(Date.now());
    if (Array.isArray(v)) return v.map(resoudre);
    if (v && typeof v === 'object' && !v.toMillis) {
      const o = {};
      Object.keys(v).forEach((k) => { o[k] = resoudre(v[k]); });
      return o;
    }
    return v;
  };
  const instantane = (chemin) => {
    const d = docs.get(chemin);
    const id = chemin.split('/').pop();
    const ref = { type: 'doc', path: chemin, id };
    return { id, ref, exists: () => d !== undefined, data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d), (k, x) => (x && x.__ms !== undefined ? horodatage(x.__ms) : x))) };
  };
  const enJson = (d) => JSON.parse(JSON.stringify(d, (k, x) => (x && typeof x === 'object' && typeof x.toMillis === 'function' ? { __ms: x.toMillis() } : x)));
  const correspond = (cible, chemin) => {
    const base = cible.path;
    if (!chemin.startsWith(base + '/') || chemin.slice(base.length + 1).includes('/')) return false;
    const d = docs.get(chemin);
    return (cible.filtres || []).every((f) => {
      const v = d[f.champ];
      if (f.op === '==') return v === f.valeur;
      throw new Error('opérateur non imité : ' + f.op);
    });
  };
  const resultat = (cible) => {
    if (cible.type === 'doc') return instantane(cible.path);
    const liste = [...docs.keys()].filter((c) => correspond(cible, c)).sort().map(instantane);
    return { docs: liste, size: liste.length, empty: !liste.length, forEach: (fn) => liste.forEach(fn) };
  };
  const signal = () => Promise.resolve().then(() => {
    ecoutes.forEach((e) => {
      if (!ecoutes.has(e)) return;
      const r = resultat(e.cible);
      const empreinte = JSON.stringify(e.cible.type === 'doc' ? (r.data() || null) : r.docs.map((x) => [x.id, x.data()]));
      if (empreinte === e.avant) return;
      const precedents = e.ids || new Map();
      if (e.cible.type !== 'doc') {
        const changes = [];
        const ids = new Map();
        r.docs.forEach((x) => {
          const j = JSON.stringify(x.data());
          ids.set(x.id, j);
          if (!precedents.has(x.id)) changes.push({ type: 'added', doc: x });
          else if (precedents.get(x.id) !== j) changes.push({ type: 'modified', doc: x });
        });
        precedents.forEach((j, id) => { if (!ids.has(id)) changes.push({ type: 'removed', doc: instantane(e.cible.path + '/' + id) }); });
        r.docChanges = () => changes;
        e.ids = ids;
      }
      e.avant = empreinte;
      try { e.suivant(r); } catch (err) { console.error('onSnapshot (faux)', err); }
    });
  });
  return {
    docs, ecoutes, horodatage,
    nouvelId: () => 'auto' + (++auto),
    ecrire(chemin, donnees) { docs.set(chemin, enJson(resoudre(donnees))); signal(); },
    modifier(chemin, donnees) {
      if (!docs.has(chemin)) throw Object.assign(new Error('absent : ' + chemin), { code: 'not-found' });
      docs.set(chemin, { ...docs.get(chemin), ...enJson(resoudre(donnees)) });
      signal();
    },
    effacer(chemin) { docs.delete(chemin); signal(); },
    lire(chemin) { const s = instantane(chemin); return s.exists() ? s.data() : null; },
    liste(prefixe) { return [...docs.keys()].filter((c) => c.startsWith(prefixe)); },
    ecouter(cible, suivant, erreur) {
      const e = { cible, suivant, erreur, avant: undefined };
      ecoutes.add(e);
      signal();
      return () => ecoutes.delete(e);
    },
    // Coupe les écoutes d'un chemin avec une erreur (droits refusés), comme le vrai Firestore.
    casser(chemin) {
      ecoutes.forEach((e) => {
        if (e.cible.path !== chemin) return;
        ecoutes.delete(e);
        if (e.erreur) e.erreur(Object.assign(new Error('permission-denied'), { code: 'permission-denied' }));
      });
    },
    resultat,
    compte: null,
  };
})());
// Données de départ données par le banc (etat.base = { chemin: données }).
if (!fs.semee) {
  fs.semee = true;
  const base = (window.__etat && window.__etat.base) || {};
  Object.keys(base).forEach((c) => fs.ecrire(c, base[c]));
}

const chemin = (parts) => parts.filter((p) => p !== undefined && p !== null).join('/');

// ---------- app, App Check ----------
export function initializeApp(options) { return { options }; }
export function initializeAppCheck() { return {}; }
export class CustomProvider { constructor(o) { this.o = o; } }

// ---------- Auth ----------
const auth = { currentUser: null };
const utilisateur = (email) => ({ uid: 'appels-' + email.split('@')[0], email, isAnonymous: false, getIdToken: async () => 'jeton' });
export function getAuth() { return auth; }
export function onAuthStateChanged(a, cb) { setTimeout(() => cb(auth.currentUser), 0); return () => {}; }
export async function signInWithEmailAndPassword(a, email) {
  if (!fs.compte || fs.compte !== email) throw Object.assign(new Error('inconnu'), { code: 'auth/invalid-credential' });
  auth.currentUser = utilisateur(email);
  return { user: auth.currentUser };
}
export async function createUserWithEmailAndPassword(a, email) {
  fs.compte = email;
  auth.currentUser = utilisateur(email);
  return { user: auth.currentUser };
}

// ---------- Firestore ----------
export function getFirestore() { return { type: 'db' }; }
export function doc(base, ...parts) {
  if (base.type === 'coll') {
    const id = parts.length ? parts.join('/') : fs.nouvelId();
    return { type: 'doc', path: base.path + '/' + id, id: id.split('/').pop() };
  }
  const p = chemin([base.type === 'doc' ? base.path : null, ...parts]);
  return { type: 'doc', path: p, id: p.split('/').pop() };
}
export function collection(base, ...parts) {
  return { type: 'coll', path: chemin([base.type === 'doc' ? base.path : null, ...parts]) };
}
export function where(champ, op, valeur) { return { champ, op, valeur }; }
export function query(coll, ...filtres) { return { type: 'coll', path: coll.path, filtres }; }
export function serverTimestamp() { return { __serverTimestamp: true }; }
export async function getDoc(ref) { return fs.resultat(ref); }
export async function getDocs(q) { return fs.resultat(q); }
export async function setDoc(ref, data) { fs.ecrire(ref.path, data); }
export async function updateDoc(ref, data) { fs.modifier(ref.path, data); }
export async function addDoc(coll, data) { const ref = doc(coll); fs.ecrire(ref.path, data); return ref; }
export async function deleteDoc(ref) { fs.effacer(ref.path); }
export function onSnapshot(cible, suivant, erreur) { return fs.ecouter(cible, suivant, erreur); }

// ---------- Functions ----------
export function getFunctions() { return {}; }
export function httpsCallable(f, nom) {
  return async (donnees) => { (window.__incidents || (window.__incidents = [])).push({ nom, donnees }); return { data: {} }; };
}
