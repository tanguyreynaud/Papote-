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
  // Domaine déclaré auprès de Google pour la connexion (adresse de retour autorisée).
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
export {
  doc, getDoc, collection, setDoc, addDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp, writeBatch,
  increment,
};

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

export function saveFamilyId(fid) {
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
    if (!memberSnap.exists() || memberSnap.data().status === 'pending') return null;
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
    uid: user.uid, email: (user.email || '').toLowerCase(), status: 'active',
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
  const { fid, kind } = invite.data();
  // Le code d'installation d'une tablette ne sert pas à rejoindre depuis un téléphone.
  if (kind === 'tablette' && role !== 'tablette') throw new CodeInconnuError();
  const memberRef = doc(db, 'families', fid, 'members', user.uid);
  let alreadyMember = false;
  try {
    alreadyMember = (await getDoc(memberRef)).exists();
  } catch (e) { /* pas encore membre : lecture refusée */ }
  if (alreadyMember) await updateDoc(memberRef, { name });
  else {
    // Arrivé avec le code famille : un responsable doit accepter le nouveau membre.
    await setDoc(memberRef, {
      name, role, code, joinedAt: serverTimestamp(),
      uid: user.uid, email: (user.email || '').toLowerCase(), status: 'pending',
    });
  }
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

// Signale aux tablettes qu'il y a du nouveau : elles ne relisent que lorsque ce compteur bouge.
export function bumpRev(batch, fid) {
  batch.update(doc(db, 'families', fid), { rev: increment(1) });
}

/**
 * Un envoi : le document ne contient qu'un petit aperçu (thumb) ; la photo ou le son en taille
 * réelle sont dans posts/{id}/media/{image|audio} et ne sont téléchargés qu'à la demande.
 */
export const VIDEO_CHUNK = 700_000; // morceaux de base64 (un document Firestore fait 1 Mo au plus)
export const MAX_VIDEO_CHUNKS = 10;

export async function addPost(fid, {
  type, text, image, thumb, audio, duration, video, mime, authorUid, authorName,
}) {
  const postRef = doc(collection(db, 'families', fid, 'posts'));
  const batch = writeBatch(db);
  const data = {
    type, text, image: null, authorUid, authorName,
    createdAt: serverTimestamp(), seenAt: null, hearts: 0,
  };
  if (image) { data.thumb = thumb; data.hasMedia = true; }
  if (audio) { data.hasMedia = true; data.duration = duration; }
  // Vidéo : base64 découpé en morceaux posts/{id}/media/video0, video1…
  const videoParts = [];
  if (video) {
    for (let i = 0; i < video.length; i += VIDEO_CHUNK) videoParts.push(video.slice(i, i + VIDEO_CHUNK));
    Object.assign(data, { thumb, hasMedia: true, duration, chunks: videoParts.length, mime });
  }
  batch.set(postRef, data);
  videoParts.forEach((part, i) => batch.set(doc(postRef, 'media', `video${i}`), { data: part }));
  if (image) batch.set(doc(postRef, 'media', 'image'), { data: image });
  if (audio) batch.set(doc(postRef, 'media', 'audio'), { data: audio });
  bumpRev(batch, fid);
  await batch.commit();
  return postRef;
}

export async function deletePost(fid, post) {
  const postRef = doc(db, 'families', fid, 'posts', post.id);
  const batch = writeBatch(db);
  if (post.hasMedia) {
    batch.delete(doc(postRef, 'media', 'image'));
    batch.delete(doc(postRef, 'media', 'audio'));
    for (let i = 0; i < (post.chunks || 0); i++) batch.delete(doc(postRef, 'media', `video${i}`));
  }
  batch.delete(postRef);
  bumpRev(batch, fid);
  await batch.commit();
}

// ---------- Photos et sons en taille réelle, gardés en cache sur le téléphone ----------

const MEDIA_CACHE = 'papote-media-v1';

async function cacheGet(key) {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    const hit = await cache.match(key);
    return hit ? URL.createObjectURL(await hit.blob()) : null;
  } catch (e) { return null; }
}

async function cachePut(key, blob) {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    await cache.put(key, new Response(blob, { headers: { 'Content-Type': blob.type } }));
  } catch (e) { /* cache indisponible */ }
}

/** Renvoie une adresse affichable (blob:) pour la photo ou le son d'un envoi. */
export async function loadMedia(fid, post, kind) {
  // Anciens envois : le média est directement dans le document.
  const inline = kind === 'image' ? post.image : post.audio;
  if (inline) return inline;
  const key = `/media/${fid}/${post.id}/${kind}`;
  const cached = await cacheGet(key);
  if (cached) return cached;
  let blob;
  if (kind === 'video') {
    const parts = [];
    for (let i = 0; i < (post.chunks || 0); i++) {
      const part = await getDoc(doc(db, 'families', fid, 'posts', post.id, 'media', `video${i}`));
      if (!part.exists()) return null;
      parts.push(part.data().data);
    }
    blob = await (await fetch(`data:${post.mime || 'video/mp4'};base64,${parts.join('')}`)).blob();
  } else {
    const snap = await getDoc(doc(db, 'families', fid, 'posts', post.id, 'media', kind));
    if (!snap.exists()) return null;
    blob = await (await fetch(snap.data().data)).blob();
  }
  await cachePut(key, blob);
  return URL.createObjectURL(blob);
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
