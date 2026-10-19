// Notifications push : la tablette peut faire sonner le téléphone d'un proche, même app fermée.
// Le jeton du téléphone est rangé dans families/{fid}/members/{uid}/private/push (lisible
// seulement par soi-même) ; la fonction serveur appelsPush l'utilise pour prévenir des appels
// de la tablette et des appels manqués. Les messages sont affichés par sw.js.
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getMessaging, getToken, isSupported } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging.js';
import { arrayUnion } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { db, doc, setDoc, serverTimestamp } from './firebase.js';

export async function pushSupported() {
  try {
    return 'Notification' in window && 'serviceWorker' in navigator && await isSupported();
  } catch (e) {
    return false;
  }
}

export function pushAllowed() {
  return 'Notification' in window && Notification.permission === 'granted';
}

export function pushRefused() {
  return 'Notification' in window && Notification.permission === 'denied';
}

// À appeler après un appui (le navigateur exige un geste pour demander l'autorisation),
// ou au lancement quand l'autorisation est déjà donnée. Renvoie vrai si le téléphone sonnera.
export async function enablePush(fid, uid) {
  if (!fid || !uid || !await pushSupported()) return false;
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

// La sonnerie d'un appel a été prise en compte dans l'app : la notification n'a plus lieu d'être.
export async function closeCallNotification(cid) {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const list = registration ? await registration.getNotifications({ tag: `appel-${cid}` }) : [];
    list.forEach((n) => n.close());
  } catch (e) { /* rien à fermer */ }
}
