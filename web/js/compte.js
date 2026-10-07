// Compte de l'app famille : connexion Google ou lien par e-mail, en gardant le profil anonyme
// d'avant (même uid), puis la liste de ses familles et de ses invitations.
import {
  GoogleAuthProvider, EmailAuthProvider, signInWithPopup, linkWithPopup, signInWithCredential,
  linkWithCredential, sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink, signOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  collectionGroup, query, where, getDocs,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import {
  auth, db, doc, getDoc, setDoc, updateDoc, deleteDoc, serverTimestamp, writeBatch,
} from './firebase.js';

const EMAIL_KEY = 'papote.emailLien';
const ALREADY_USED = ['auth/credential-already-in-use', 'auth/email-already-in-use', 'auth/provider-already-linked'];

export const isRealAccount = (user) => !!user && !user.isAnonymous && !!user.email;

export function myEmail() {
  return (auth.currentUser?.email || '').toLowerCase();
}

// ---------- Connexion ----------

export async function signInGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const user = auth.currentUser;
  if (user && user.isAnonymous) {
    // On rattache le compte Google au profil actuel : même uid, la famille est gardée.
    try {
      return (await linkWithPopup(user, provider)).user;
    } catch (err) {
      if (!ALREADY_USED.includes(err.code)) throw err;
      // Ce compte Google sert déjà ailleurs : on se connecte avec lui.
      const cred = GoogleAuthProvider.credentialFromError(err);
      if (cred) return (await signInWithCredential(auth, cred)).user;
    }
  }
  return (await signInWithPopup(auth, provider)).user;
}

export async function sendEmailLink(email) {
  await sendSignInLinkToEmail(auth, email, {
    url: `${location.origin}/?lien=1`,
    handleCodeInApp: true,
  });
  try { localStorage.setItem(EMAIL_KEY, email); } catch (e) { /* stockage indisponible */ }
}

export const isEmailLink = () => isSignInWithEmailLink(auth, location.href);

/** Termine la connexion par lien e-mail. Sans adresse mémorisée, il faut la redemander. */
export async function completeEmailLink(emailTyped) {
  let email = emailTyped;
  if (!email) {
    try { email = localStorage.getItem(EMAIL_KEY); } catch (e) { /* rien */ }
  }
  if (!email) return null;
  const href = location.href;
  const user = auth.currentUser;
  let result;
  if (user && user.isAnonymous) {
    try {
      result = (await linkWithCredential(user, EmailAuthProvider.credentialWithLink(email, href))).user;
    } catch (err) {
      if (!ALREADY_USED.includes(err.code)) throw err;
    }
  }
  if (!result) result = (await signInWithEmailLink(auth, email, href)).user;
  try { localStorage.removeItem(EMAIL_KEY); } catch (e) { /* rien */ }
  history.replaceState(null, '', location.pathname);
  return result;
}

export function logOut() {
  return signOut(auth);
}

// ---------- Mes familles et mes invitations ----------

/** Les familles où je suis inscrit : [{ fid, status, member }]. */
export async function myMemberships() {
  const uid = auth.currentUser.uid;
  const snap = await getDocs(query(collectionGroup(db, 'members'), where('uid', '==', uid)));
  return snap.docs.map((d) => {
    const member = d.data();
    return { fid: d.ref.parent.parent.id, status: member.status || 'active', member };
  });
}

export async function familyName(fid) {
  try {
    const snap = await getDoc(doc(db, 'families', fid));
    return snap.exists() ? snap.data().name : null;
  } catch (e) {
    return null;
  }
}

/** Les fiches d'avant n'ont ni uid ni e-mail : on les ajoute pour retrouver la famille partout. */
export async function tagLegacyMember(fid) {
  const user = auth.currentUser;
  const ref = doc(db, 'families', fid, 'members', user.uid);
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const data = snap.data();
    if (data.uid === user.uid && data.email === myEmail()) return;
    await updateDoc(ref, { uid: user.uid, email: myEmail() });
  } catch (err) {
    console.warn('Fiche membre non complétée', err);
  }
}

export async function myInvitations() {
  const email = myEmail();
  if (!email) return [];
  try {
    const snap = await getDocs(query(collectionGroup(db, 'invitations'), where('email', '==', email)));
    return snap.docs.map((d) => d.data());
  } catch (err) {
    console.warn('Invitations illisibles', err);
    return [];
  }
}

/** Accepter une invitation par e-mail : membre actif tout de suite. */
export async function acceptInvitation(invitation, name) {
  const user = auth.currentUser;
  const email = myEmail();
  await setDoc(doc(db, 'families', invitation.fid, 'members', user.uid), {
    name, role: 'famille', code: '', joinedAt: serverTimestamp(),
    uid: user.uid, email, status: 'active',
  });
  await deleteDoc(doc(db, 'families', invitation.fid, 'invitations', email));
}

// ---------- Côté responsable ----------

export function inviteByEmail(fid, family, rawEmail, invitedBy) {
  const email = rawEmail.trim().toLowerCase();
  return setDoc(doc(db, 'families', fid, 'invitations', email), {
    email, fid, familyName: family.name, invitedBy, createdAt: serverTimestamp(),
  });
}

export function cancelInvitation(fid, email) {
  return deleteDoc(doc(db, 'families', fid, 'invitations', email));
}

export function acceptMember(fid, uid) {
  return updateDoc(doc(db, 'families', fid, 'members', uid), { status: 'active' });
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** Code d'installation d'une tablette : seul ce code permet d'inscrire une tablette. */
export async function createTabletCode(fid) {
  const code = randomCode();
  await setDoc(doc(db, 'invites', code), { fid, createdBy: auth.currentUser.uid, kind: 'tablette' });
  return code;
}

/** Nouveau code famille : l'ancien ne permet plus de rejoindre. */
export async function changeFamilyCode(fid, oldCode) {
  const code = randomCode();
  const batch = writeBatch(db);
  batch.set(doc(db, 'invites', code), { fid, createdBy: auth.currentUser.uid });
  batch.update(doc(db, 'families', fid), { code });
  if (oldCode) batch.delete(doc(db, 'invites', oldCode));
  await batch.commit();
  return code;
}
