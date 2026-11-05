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
// Le jeton n'est cru que si la page a été ouverte par l'app elle-même (Chrome met alors
// document.referrer = android-app://fr.mapapote.famille/) : un simple lien
// https://app.mapapote.fr/?natif=<jeton d'un autre> enverrait sinon les appels (et le jeton de
// connexion de l'écran d'appel, functions/appels.js) à ce jeton-là. Ancienne clé (papote.jetonNatif)
// abandonnée : elle a pu être remplie par un tel lien avant ce contrôle.
const CLE_NATIF = 'papote.natif';
const CLE_MUET = 'papote.natifMuet';
const PAR_APP_ANDROID = /^android-app:\/\/fr\.mapapote\.famille(\/|$)/;
const JETON_FCM = /^[A-Za-z0-9_:-]{20,4096}$/;
try { localStorage.removeItem('papote.jetonNatif'); } catch (e) { /* rien */ }

/**
 * Paramètres que seule l'app Android peut donner (natif, notifs, pause, quitter), ou null si la
 * page n'a pas été ouverte par elle. Le dernier ?natif= est le sien (Ouverture l'ajoute à la fin,
 * même quand elle a été ouverte par un lien qui en portait déjà un).
 */
export function launchFromAndroidApp(params, referrer = document.referrer) {
  if (!PAR_APP_ANDROID.test(referrer || '')) return null;
  const natif = params.getAll('natif').pop() || null;
  return { natif: natif && JETON_FCM.test(natif) ? natif : null, notifsOff: params.get('notifs') === '0' };
}

// notifsOff : Android bloque les notifications de l'app (ou son canal « Appels ») : elle ne peut
// pas sonner, le jeton ne doit pas compter comme un téléphone prévenu.
export function rememberNativeToken(jeton, notifsOff = false) {
  try {
    localStorage.setItem(CLE_NATIF, jeton);
    if (notifsOff) localStorage.setItem(CLE_MUET, '1'); else localStorage.removeItem(CLE_MUET);
  } catch (e) { /* rien */ }
}

// Ouvert dans l'app Android : c'est elle qui fait sonner le téléphone.
export function inNativeApp() {
  return !!nativeToken();
}

/** L'app Android est là, mais Android l'empêche de sonner (notifications coupées). */
export function nativeNotificationsOff() {
  try { return !!nativeToken() && localStorage.getItem(CLE_MUET) === '1'; } catch (e) { return false; }
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
  if (nativeToken()) return !nativeNotificationsOff();
  return 'Notification' in window && Notification.permission === 'granted';
}

export function pushRefused() {
  if (nativeToken()) return nativeNotificationsOff();
  return 'Notification' in window && Notification.permission === 'denied';
}

// À appeler après un appui (le navigateur exige un geste pour demander l'autorisation),
// ou au lancement quand l'autorisation est déjà donnée. Renvoie vrai si le téléphone sonnera.
// onGranted : appelé dès que l'autorisation est donnée, avant l'enregistrement du jeton (plus lent).
export async function enablePush(fid, uid, onGranted) {
  if (!fid || !uid) return false;
  if (nativeToken()) { onGranted?.(); return enableNativePush(fid, uid); }
  if (!await pushSupported()) return false;
  if (Notification.permission === 'default') {
    if (await Notification.requestPermission() !== 'granted') return false;
  }
  if (Notification.permission !== 'granted') return false;
  onGranted?.();
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
  if (nativeNotificationsOff()) {
    // L'app ne peut pas sonner : sans jeton natif, le serveur se rabat sur les navigateurs du
    // proche, et sinon sur l'e-mail « aucun téléphone n'a sonné ».
    try { await setDoc(ref, { natifs: arrayRemove(nativeToken()), majLe: serverTimestamp() }, { merge: true }); } catch (e) { /* rien */ }
    return false;
  }
  try {
    // Un seul jeton par compte : celui de l'app installée aujourd'hui (une réinstallation en change).
    // natifsV : rangé par une page qui contrôle d'où vient le jeton (voir functions/push.js).
    await setDoc(ref, { natifs: [nativeToken()], natifsV: 2, majLe: serverTimestamp() }, { merge: true });
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
