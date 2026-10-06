// Initialisation Firebase et accès aux données, partagés par l'app famille et la tablette.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, orderBy, limit,
  onSnapshot, addDoc, serverTimestamp, writeBatch, increment,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAvoivJR8p-u2VxUWzlyHzTgP20-5ZG_-E',
  authDomain: 'papote-famille.firebaseapp.com',
  projectId: 'papote-famille',
  storageBucket: 'papote-famille.firebasestorage.app',
  messagingSenderId: '807031084851',
  appId: '1:807031084851:web:b8048e2952cb1e893b1046',
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

let db;
try {
  // Cache local : la tablette garde ses photos si le wifi coupe.
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
  });
} catch (e) {
  db = initializeFirestore(app, {});
}
export { db };
// Pour les appels vidéo (appel.js).
export { doc, collection, setDoc, addDoc, updateDoc, onSnapshot, serverTimestamp };

const FID_KEY = 'papote.fid';

// Sans 0/O/1/I/L pour éviter les confusions en le recopiant.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function normalizeCode(raw) {
  return (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function formatCode(code) {
  const c = normalizeCode(code);
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function currentUser() {
  return new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, (user) => {
      stop();
      resolve(user);
    });
  });
}

export async function ensureSignedIn() {
  const user = await currentUser();
  if (user) return user;
  const cred = await signInAnonymously(auth);
  return cred.user;
}

export function savedFamilyId() {
  try { return localStorage.getItem(FID_KEY); } catch (e) { return null; }
}

function saveFamilyId(fid) {
  try {
    if (fid) localStorage.setItem(FID_KEY, fid);
    else localStorage.removeItem(FID_KEY);
  } catch (e) { /* stockage indisponible */ }
}

// Renvoie { family, member } si l'utilisateur appartient toujours à la famille enregistrée.
export async function loadMembership() {
  const fid = savedFamilyId();
  const user = await currentUser();
  if (!fid || !user) return null;
  try {
    const memberSnap = await getDoc(doc(db, 'families', fid, 'members', user.uid));
    if (!memberSnap.exists()) return null;
    const familySnap = await getDoc(doc(db, 'families', fid));
    return {
      fid,
      family: familySnap.data(),
      member: memberSnap.data(),
      uid: user.uid,
    };
  } catch (e) {
    console.warn('Adhésion illisible', e);
    return null;
  }
}

export async function createFamily(grandParentName, myName) {
  const user = await ensureSignedIn();
  const fid = doc(collection(db, 'families')).id;
  const code = randomCode();
  const batch = writeBatch(db);
  batch.set(doc(db, 'families', fid), {
    name: grandParentName, code, createdBy: user.uid, createdAt: serverTimestamp(),
  });
  batch.set(doc(db, 'invites', code), { fid, createdBy: user.uid });
  batch.set(doc(db, 'families', fid, 'members', user.uid), {
    name: myName, role: 'famille', code, joinedAt: serverTimestamp(),
  });
  await batch.commit();
  saveFamilyId(fid);
  return fid;
}

export class CodeInconnuError extends Error {}

export async function joinFamily(rawCode, name, role = 'famille') {
  const code = normalizeCode(rawCode);
  const user = await ensureSignedIn();
  let invite;
  try {
    invite = await getDoc(doc(db, 'invites', code));
  } catch (e) {
    throw new CodeInconnuError();
  }
  if (!invite.exists()) throw new CodeInconnuError();
  const { fid } = invite.data();
  const memberRef = doc(db, 'families', fid, 'members', user.uid);
  let alreadyMember = false;
  try {
    alreadyMember = (await getDoc(memberRef)).exists();
  } catch (e) { /* pas encore membre : lecture refusée */ }
  if (alreadyMember) await updateDoc(memberRef, { name });
  else await setDoc(memberRef, { name, role, code, joinedAt: serverTimestamp() });
  saveFamilyId(fid);
  return fid;
}

export async function leaveFamily(fid, uid) {
  try { await deleteDoc(doc(db, 'families', fid, 'members', uid)); } catch (e) { /* déjà parti */ }
  saveFamilyId(null);
}

export function watchPosts(fid, max, callback) {
  const q = query(collection(db, 'families', fid, 'posts'), orderBy('createdAt', 'desc'), limit(max));
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) })));
  }, (err) => console.error('Lecture des envois impossible', err));
}

export function watchMembers(fid, callback) {
  return onSnapshot(collection(db, 'families', fid, 'members'), (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export function addPost(fid, { type, text, image, authorUid, authorName }) {
  return addDoc(collection(db, 'families', fid, 'posts'), {
    type, text, image: image || null, authorUid, authorName,
    createdAt: serverTimestamp(), seenAt: null, hearts: 0,
  });
}

export function deletePost(fid, pid) {
  return deleteDoc(doc(db, 'families', fid, 'posts', pid));
}

export function markSeen(fid, pid) {
  return updateDoc(doc(db, 'families', fid, 'posts', pid), { seenAt: serverTimestamp() });
}

export function sendHeart(fid, pid) {
  return updateDoc(doc(db, 'families', fid, 'posts', pid), { hearts: increment(1), seenAt: serverTimestamp() });
}

export function toDate(ts) {
  if (!ts) return null;
  if (ts.toDate) return ts.toDate();
  return new Date(ts);
}
