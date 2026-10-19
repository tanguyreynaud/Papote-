// Notifications push : la tablette peut faire sonner le téléphone d'un proche, même app fermée.
// Le jeton du téléphone est rangé dans families/{fid}/members/{uid}/private/push (lisible
// seulement par soi-même) ; la fonction serveur appelsPush l'utilise pour prévenir des appels
// de la tablette et des appels manqués. Les messages sont affichés par sw.js.
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getMessaging, getToken, isSupported } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging.js';
import { arrayRemove, arrayUnion } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { db, doc, setDoc, serverTimestamp } from './firebase.js';

// App Android Papote (dossier telephone/ du dépôt) : elle ouvre l'app famille avec ?natif=<jeton>.
// Ce téléphone sonne alors comme un vrai appel par elle, plus par les notifications du navigateur.
const CLE_NATIF = 'papote.jetonNatif';

export function rememberNativeToken(jeton) {
  try { localStorage.setItem(CLE_NATIF, jeton); } catch (e) { /* rien */ }
}

// Ouvert dans l'app Android : c'est elle qui fait sonner le téléphone.
export function inNativeApp() {
  return !!nativeToken();
}

function nativeToken() {
  try { return localStorage.getItem(CLE_NATIF); } catch (e) { return null; }
}

export async function pushSupported() {
  if (nativeToken()) return true;
  try {
    return 'Notification' in window && 'serviceWorker' in navigator && await isSupported();
  } catch (e) {
    return false;
  }
}

export function pushAllowed() {
  return !!nativeToken() || 'Notification' in window && Notification.permission === 'granted';
}

export function pushRefused() {
  return !nativeToken() && 'Notification' in window && Notification.permission === 'denied';
}

// À appeler après un appui (le navigateur exige un geste pour demander l'autorisation),
// ou au lancement quand l'autorisation est déjà donnée. Renvoie vrai si le téléphone sonnera.
export async function enablePush(fid, uid) {
  if (!fid || !uid) return false;
  if (nativeToken()) return enableNativePush(fid, uid);
  if (!await pushSupported()) return false;
  if (Notification.permission === 'default') {
    if (await Notification.requestPermission() !== 'granted') return false;
  }
  if (Notification.permission !== 'granted') return false;
  try {
    const registration = await navigator.serviceWorker.register('sw.js');
    const token = await getToken(getMessaging(getApp()), { serviceWorkerRegistration: registration });
    if (!token) return false;
    await setDoc(doc(db, 'families', fid, 'members', uid, 'private', 'push'), {
      tokens: arrayUnion(token),
      majLe: serverTimestamp(),
    }, { merge: true });
    return true;
  } catch (e) {
    console.warn('Notifications : jeton impossible', e);
    return false;
  }
}

// Jeton de l'app Android rangé avec le compte ; le jeton du navigateur de ce même téléphone est
// retiré, sinon il sonnerait deux fois.
async function enableNativePush(fid, uid) {
  const ref = doc(db, 'families', fid, 'members', uid, 'private', 'push');
  try {
    // Un seul jeton par compte : celui de l'app installée aujourd'hui (une réinstallation en change).
    await setDoc(ref, { natifs: [nativeToken()], majLe: serverTimestamp() }, { merge: true });
  } catch (e) {
    console.warn('Notifications : jeton de l\'app impossible à ranger', e);
    return false;
  }
  try {
    if ('Notification' in window && Notification.permission === 'granted' && await isSupported()) {
      const registration = await navigator.serviceWorker.getRegistration();
      const web = registration && await getToken(getMessaging(getApp()), { serviceWorkerRegistration: registration });
      if (web) await setDoc(ref, { tokens: arrayRemove(web) }, { merge: true });
    }
  } catch (e) { /* pas de jeton navigateur sur ce téléphone */ }
  return true;
}

// La sonnerie d'un appel a été prise en compte dans l'app : la notification n'a plus lieu d'être.
export async function closeCallNotification(cid) {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const list = registration ? await registration.getNotifications({ tag: `appel-${cid}` }) : [];
    list.forEach((n) => n.close());
  } catch (e) { /* rien à fermer */ }
}
