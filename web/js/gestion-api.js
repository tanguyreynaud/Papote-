// Appels aux fonctions de gestion (functions/gestion.js), partagés par admin.js et gestion.js.
// Utilise l'app Firebase « admin » créée par admin.js (même connexion Google).
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';

let fonctions;
export function appeler(nom, data) {
  if (!fonctions) fonctions = getFunctions(getApp('admin'), 'europe-west1');
  return httpsCallable(fonctions, nom, { timeout: 130_000 })(data).then((r) => r.data);
}

// Commandes, stock et dépenses : un seul appel partagé, relu après chaque changement.
let cache = null;
export function donnees(relire = false) {
  if (relire || !cache) {
    cache = appeler('gestionDonnees');
    cache.catch(() => { cache = null; });
  }
  return cache;
}

// Prévient les autres parties de la page qu'il faut relire (tablette envoyée, achat ajouté…).
export function signalerChangement() {
  cache = null;
  document.dispatchEvent(new CustomEvent('papote:maj'));
}

export function messageErreur(e) {
  const code = (e && e.code) || '';
  if (code.endsWith('permission-denied')) return 'Ce compte n\'a pas le badge administrateur.';
  // Fonction absente ou en panne : le message brut (« internal », « not-found »…) ne dit rien d'utile.
  const brut = !e.message || /^(internal|not[- ]found|unavailable)$/i.test(e.message);
  if (code.endsWith('internal') || ((code.endsWith('not-found') || code.endsWith('unavailable')) && brut)) {
    return 'Le serveur de gestion ne répond pas. Les fonctions « gestion » ne sont peut-être pas encore déployées.';
  }
  return (e && e.message) || String(e);
}
