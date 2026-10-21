// Espace d'administration (admin.html) : familles et tablettes, envois et retours de commandes,
// transfert des anciennes photos et vidéos vers Storage. Le stock, les factures et la comptabilité
// sont dans gestion.js, sur la même page.
// Une app Firebase à part (« admin ») : la connexion Google ne touche pas à la famille de ce navigateur.
import { demander, saisir, prevenir } from './dialogue.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getFirestore, collection, collectionGroup, query, where, orderBy, limit,
  getDocs, getDoc, doc, writeBatch, getCountFromServer, setDoc, deleteDoc, updateDoc,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import {
  getStorage, ref, uploadBytes, getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-storage.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';
import { refreshSim } from './sim.js';
import { appeler, donnees, signalerChangement } from './gestion-api.js';
import { ouvrirParcours } from './parcours.js';

const app = initializeApp({
  apiKey: 'AIzaSyAvoivJR8p-u2VxUWzlyHzTgP20-5ZG_-E',
  authDomain: 'papote-famille.firebaseapp.com',
  projectId: 'papote-famille',
  storageBucket: 'papote-famille.firebasestorage.app',
  messagingSenderId: '807031084851',
  appId: '1:807031084851:web:b8048e2952cb1e893b1046',
}, 'admin');
const auth = getAuth(app);
// Base et bucket : ceux d'origine, ou ceux que config/base (dans la base d'origine) désigne après la
// bascule en Europe ({ database: 'eu', bucket: 'papote-famille-eu' }). Lu une fois, avant tout chargement.
let db = getFirestore(app);
let storage = getStorage(app);
let baseChoisie = null;
function choisirBase() {
  baseChoisie = baseChoisie || getDoc(doc(db, 'config', 'base')).then((snap) => {
    const c = (snap.exists() && snap.data()) || {};
    if (typeof c.database === 'string' && c.database && c.database !== '(default)') db = getFirestore(app, c.database);
    if (typeof c.bucket === 'string' && c.bucket) storage = getStorage(app, `gs://${c.bucket}`);
  }).catch((err) => console.warn('config/base illisible, base d\'origine gardée', err));
  return baseChoisie;
}
const functions = getFunctions(app, 'europe-west1');

const $ = (id) => document.getElementById(id);
const OFFLINE_MS = 45 * 60_000;
const IDLE_MS = 24 * 3600_000;

let families = [];

const toDate = (ts) => (ts && ts.toDate ? ts.toDate() : null);

function ago(date) {
  if (!date) return 'jamais';
  const min = Math.round((Date.now() - date.getTime()) / 60000);
  if (min < 2) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} jours`;
}

// ---------- Connexion ----------

$('btn-signin').addEventListener('click', async () => {
  $('signin-error').hidden = true;
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    console.error(err);
    $('signin-error').textContent = 'La connexion a échoué. Réessayez.';
    $('signin-error').hidden = false;
  }
});

$('btn-signout').addEventListener('click', () => signOut(auth));
$('btn-refresh').addEventListener('click', () => {
  load();
  signalerChangement();
});

onAuthStateChanged(auth, (user) => {
  $('signin').hidden = !!user;
  $('dashboard').hidden = !user;
  $('btn-refresh').hidden = !user;
  $('who').textContent = user ? user.email : '';
  if (user) load();
});

// ---------- Familles et tablettes ----------

// Commandes payées sur le site, tablette à préparer (écrites par le serveur Stripe).
// Adresse de livraison : point relais Mondial Relay, ou adresse postale des anciennes commandes.
function livraisonTexte(c) {
  const l = c.livraison || {};
  if (l.transporteur === 'mondial-relay') {
    return `Point relais ${l.nom || ''} (n° ${l.id || '?'}) · ${[l.adresse, `${l.cp || ''} ${l.ville || ''}`.trim(), l.pays].filter(Boolean).join(', ')}${l.destinataire ? ` · retrait par ${l.destinataire}` : ''}`;
  }
  const a = l.adresse || {};
  const postale = [a.line1, a.line2, `${a.postal_code || ''} ${a.city || ''}`.trim(), a.country].filter(Boolean).join(', ');
  return postale ? `Adresse : ${postale}` : 'Adresse non fournie';
}

const lienSuivi = (c) => `https://www.mondialrelay.fr/suivi-de-colis/?numeroExpedition=${encodeURIComponent(c.suivi || '')}&codePostal=${encodeURIComponent(c.livraison?.cp || '')}`;

function orderHead(c) {
  return `${c.nom || c.email} · ${c.formule === 'sim' ? 'carte SIM' : 'Wi-Fi'}, tablette ${c.tablette === 'incluse' ? 'incluse' : 'achetée'}`;
}

// Tablettes à envoyer : chaque commande se prépare pas à pas (parcours), sans rien oublier.
async function loadOrders() {
  try {
    const snap = await getDocs(query(collection(db, 'commandes'), where('expedition', '==', 'a-preparer')));
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (toDate(a.creeLe)?.getTime() || 0) - (toDate(b.creeLe)?.getTime() || 0));
    $('orders-empty').hidden = list.length > 0;
    $('orders').replaceChildren(...list.map((c) => {
      // Mêmes prix que le serveur (abonnement.js, PRIX_MATERIEL) et les conditions de vente.
      const prix = { tablette: 130, chargeur: 10, enceinte: 10 };
      const li = document.createElement('li');
      li.innerHTML = '<strong></strong><span class="muted small"></span><span class="small adresse"></span>'
        + '<div class="envoi-suite"><span class="small avancement"></span><button type="button" class="primary small-btn"></button></div>';
      li.querySelector('strong').textContent = orderHead(c);
      li.querySelector('.muted').textContent = `${c.email}${c.telephone ? ` · ${c.telephone}` : ''} · commandé ${ago(toDate(c.creeLe))}${c.fid ? ' · famille créée' : ''}`;
      li.querySelector('.adresse').textContent = livraisonTexte(c);
      const etapes = etapesEnvoi(c, {}).filter((e) => !e.saute || !e.saute({}));
      const p = c.preparation;
      const commencee = !!(p && Object.keys(p.faits || {}).length);
      const n = commencee ? Math.min(Number(p.etape) || 0, etapes.length - 1) : 0;
      li.querySelector('.avancement').textContent = commencee
        ? `Étape ${n + 1} sur ${etapes.length} : ${etapes[n].titre}` : `Pas commencée · ${etapes.length} étapes`;
      const bouton = li.querySelector('button');
      bouton.textContent = commencee ? 'Reprendre la préparation' : 'Préparer l\'envoi';
      bouton.addEventListener('click', () => preparerEnvoi(c, bouton));
      return li;
    }));
  } catch (err) {
    console.warn('Commandes illisibles', err);
    $('orders-empty').hidden = false;
  }
}

const avecTiret = (code) => String(code || '').replace(/^(.{4})(.{4})$/, '$1-$2');
const simTexte = (l) => (l ? [l.numero || `ICCID …${String(l.iccid || '').slice(-4)}`, l.operateur].filter(Boolean).join(' · ') : '');
const creer = (tag, attrs = {}, texte = '') => Object.assign(document.createElement(tag), attrs, texte ? { textContent: texte } : {});

// Étapes de l'envoi d'une commande. ctx : { stock, sims, accessoires } (vide pour seulement compter les étapes).
function etapesEnvoi(c, { stock = [], sims = [], accessoires = [] }) {
  // Internet inclus : la carte SIM est dans la tablette. L'enceinte part seulement si on le choisit (e.enceinte = 'oui').
  const internet = c.formule === 'sim';
  const avecEnceinte = (e) => e.enceinte === 'oui';
  const tablette = (e) => stock.find((t) => t.id === e.tablette);
  const nom = (e) => { const t = tablette(e); return t ? t.ref || t.numero || t.modele || 'choisie' : ''; };
  const simDe = (e) => { const t = tablette(e); return sims.find((l) => l.id === (e.sim || (t && t.simId))) || null; };
  const pour = (formule) => accessoires.filter((a) => a.parEnvoi === formule).map((a) => a.nom);
  const enceinte = () => accessoires.find((a) => a.parEnvoi === 'option' && /enceinte|haut-parleur/i.test(a.nom))?.nom || 'L\'enceinte';
  const option = (valeur, texte, choisi) => creer('option', { value: valeur, selected: choisi }, texte);
  return [
    {
      cle: 'tablette',
      titre: 'Choisir la tablette',
      texte: 'Prenez une tablette déjà installée : elle a un numéro T-… écrit dessus.',
      contenu(zone, e, maj) {
        const dispo = stock.filter((t) => t.commande === c.id || (['en-stock', 'preparee'].includes(t.etat) && !t.commande))
          .sort((a, b) => !!b.ref - !!a.ref);
        const choix = creer('select', { ariaLabel: 'Tablette' });
        choix.append(option('', dispo.length ? 'Choisir la tablette…' : 'Aucune tablette en stock', !e.tablette),
          ...dispo.map((t) => option(t.id, [t.ref || 'pas encore installée', t.numero, t.modele, t.sim ? `SIM ${t.sim}` : null].filter(Boolean).join(' · '), t.id === e.tablette)));
        const libres = sims.filter((l) => (!l.tablette || l.id === e.sim) && ['stock', 'active'].includes(l.statut));
        const choixSim = creer('select', { ariaLabel: 'Carte SIM' });
        choixSim.append(option('', libres.length ? 'Carte SIM…' : 'Aucune carte SIM libre', !e.sim),
          ...libres.map((l) => option(l.id, simTexte(l), l.id === e.sim)));
        const alerte = creer('p', { className: 'small error' });
        const majChoix = () => {
          e.tablette = choix.value || null;
          const t = tablette(e);
          alerte.textContent = t && !t.ref ? 'Cette tablette n\'est pas encore installée : faites d\'abord sa réception (Stock > Recevoir une tablette).' : '';
          choixSim.hidden = !internet || !t || !!t.simId;
          e.sim = choixSim.hidden ? null : choixSim.value || null;
          maj();
        };
        choix.addEventListener('change', majChoix);
        choixSim.addEventListener('change', majChoix);
        zone.append(choix, choixSim, alerte);
        majChoix();
      },
      pret: (e) => !!tablette(e) && !!tablette(e).ref && (!internet || !!tablette(e).simId || !!e.sim),
      async valider(e) {
        // La tablette est réservée pour cette commande (et libère celle choisie avant, s'il y en avait une).
        const avant = stock.find((t) => t.commande === c.id && t.id !== e.tablette);
        if (avant) await appeler('gestionStock', { action: 'modifier', id: avant.id, champs: { commande: null } });
        await appeler('gestionStock', { action: 'modifier', id: e.tablette, champs: { commande: c.id } });
        for (const t of stock) {
          if (t.id === e.tablette) t.commande = c.id;
          else if (t.commande === c.id) t.commande = null;
        }
      },
    },
    {
      cle: 'sim',
      titre: 'Activer la carte SIM',
      texte: 'Activez la ligne chez l\'opérateur si ce n\'est pas fait, puis notez-la :',
      saute: () => !internet,
      contenu(zone, e, maj) {
        const l = simDe(e) || {};
        e.simNumero = e.simNumero ?? (l.numero || '');
        e.simActivation = e.simActivation || (l.activation ? new Date(l.activation) : new Date()).toISOString().slice(0, 10);
        e.simPrix = e.simPrix ?? (l.prix != null ? String(l.prix / 100).replace('.', ',') : '');
        const champ = (libelle, cle, attrs = {}) => {
          const input = creer('input', { value: e[cle], ...attrs });
          input.addEventListener('input', () => { e[cle] = input.value.trim(); maj(); });
          const lab = creer('label', { className: 'pc-champ' }, `${libelle} `);
          lab.append(input);
          return lab;
        };
        zone.append(creer('p', { className: 'small muted' }, simTexte(l) || 'Carte SIM'),
          champ('Numéro de la ligne', 'simNumero', { inputMode: 'tel', placeholder: '06…' }),
          champ('Activée le', 'simActivation', { type: 'date' }),
          champ('Prix par mois (€)', 'simPrix', { inputMode: 'decimal', placeholder: 'ex. 2,99' }));
      },
      cases: ['Code PIN de la carte retiré (sinon la tablette reste sans internet au démarrage)'],
      pret: (e) => /^[\d +.]{6,}$/.test(e.simNumero || '') && /^\d{4}-\d{2}-\d{2}$/.test(e.simActivation || '')
        && /^\d+([.,]\d{1,2})?$/.test(e.simPrix || ''),
      async valider(e) {
        const l = simDe(e);
        if (!l) return;
        await appeler('gestionSim', { action: 'modifier', id: l.id, champs: {
          statut: 'active', numero: e.simNumero, activation: Date.parse(`${e.simActivation}T12:00:00`),
          prix: Math.round(Number(e.simPrix.replace(',', '.')) * 100), tablette: e.tablette,
        } });
      },
    },
    {
      cle: 'carton',
      titre: 'La tablette dans le carton',
      cases: (e) => [
        `La tablette ${nom(e)} est dans le carton`,
        'Le chargeur et son câble sont dans le carton',
        ...pour('tous').map((a) => `${a} : dans le carton`),
      ],
    },
    {
      cle: 'enceinte-choix',
      titre: 'Enceinte ?',
      texte: 'L\'enceinte part-elle dans ce colis ? Elle ne sera facturée au client (10 €) que si elle était dans le colis et ne revient pas.',
      contenu(zone, e, maj) {
        const choix = (valeur, texte) => {
          const r = creer('input', { type: 'radio', name: 'enceinte', value: valeur, checked: e.enceinte === valeur });
          r.addEventListener('change', () => { e.enceinte = valeur; maj(); });
          const l = creer('label', { className: 'pc-case' });
          l.append(r, ` ${texte}`);
          return l;
        };
        zone.append(choix('non', 'Non, pas d\'enceinte'), choix('oui', 'Oui : l\'enceinte est dans le carton'));
      },
      pret: (e) => e.enceinte === 'oui' || e.enceinte === 'non',
    },
    {
      cle: 'fermer',
      titre: 'Fermer le colis',
      texte: 'Dernière vérification. Le carton contient :',
      contenu(zone, e) {
        const ul = creer('ul', { className: 'pc-liste' });
        const contenu = [`La tablette ${nom(e)}`, 'Le chargeur et son câble', ...pour('tous'),
          ...(avecEnceinte(e) ? [enceinte()] : []),
          ...(internet ? [`La carte SIM ${simTexte(simDe(e))}, dans la tablette`] : [])];
        ul.append(...contenu.map((x) => creer('li', {}, x)));
        zone.append(ul);
      },
      cases: ['Rien ne manque', 'Le carton est fermé avec du scotch'],
    },
    {
      cle: 'feutre',
      titre: 'Le numéro au feutre',
      texte: 'Écrivez ce numéro au feutre sur le carton : il permet de retrouver la commande si l\'étiquette se décolle.',
      contenu(zone, e) {
        zone.append(creer('p', { className: 'pc-gros' }, [avecTiret(c.code), nom(e)].filter(Boolean).join(' · ')));
      },
      cases: ['Numéro écrit sur le carton'],
    },
    {
      cle: 'etiquette',
      titre: 'L\'étiquette',
      texte: 'Mondial Relay donne un QR code : au relais, montrez-le sur votre téléphone (ou imprimé), ils impriment l\'étiquette et la collent.',
      contenu(zone, e, maj) {
        const bouton = creer('button', { type: 'button', className: 'primary' }, 'Créer l\'étiquette');
        const lien = creer('a', { target: '_blank', rel: 'noopener', className: 'pc-lien' }, 'Ouvrir le QR code');
        const etat = creer('p', { className: 'small' });
        const annuler = creer('button', { type: 'button', className: 'link small' }, 'Annuler cette étiquette');
        const ailleurs = creer('details');
        ailleurs.append(creer('summary', { className: 'small' }, 'Étiquette faite ailleurs ?'));
        const suivi = creer('input', { placeholder: 'N° de suivi Mondial Relay', autocomplete: 'off' });
        ailleurs.append(suivi);
        const afficher = () => {
          const a = c.etiquettes && c.etiquettes.aller;
          bouton.hidden = !!a;
          lien.hidden = !(a && a.url);
          if (a && a.url) lien.href = a.url;
          annuler.hidden = !a;
          etat.textContent = a ? `Étiquette prête, suivi ${a.suivi || '?'}.` : '';
          ailleurs.hidden = !!a;
          e.suivi = (a && a.suivi) || suivi.value.trim() || null;
          maj();
        };
        bouton.addEventListener('click', async () => {
          const fenetre = window.open('', '_blank');
          bouton.disabled = true;
          bouton.textContent = 'Création…';
          try {
            const r = await appeler('gestionEtiquette', { commande: c.id, sens: 'aller' });
            c.etiquettes = { ...(c.etiquettes || {}), aller: r };
            if (fenetre) fenetre.location = r.url;
          } catch (err) {
            if (fenetre) fenetre.close();
            prevenir(`Étiquette impossible : ${err.message}`);
          }
          bouton.disabled = false;
          bouton.textContent = 'Créer l\'étiquette';
          afficher();
        });
        annuler.addEventListener('click', async () => {
          if (!await demander('Annuler cette étiquette chez Sendcloud ? Vous pourrez en créer une nouvelle.', { oui: 'Annuler l\'étiquette', non: 'Garder', danger: true })) return;
          annuler.disabled = true;
          try {
            await appeler('gestionAnnulerEtiquette', { commande: c.id, sens: 'aller' });
            delete c.etiquettes.aller;
          } catch (err) {
            prevenir(`Annulation impossible : ${err.message}`);
          }
          annuler.disabled = false;
          afficher();
        });
        suivi.addEventListener('input', afficher);
        zone.append(bouton, lien, etat, annuler, ailleurs);
        afficher();
      },
      pret: (e) => !!e.suivi,
    },
    {
      cle: 'depot',
      titre: 'Déposer au relais',
      texte: 'Déposez le colis dans un point relais Mondial Relay et montrez le QR code. Ensuite seulement, touchez « Colis déposé » : le client reçoit le lien de suivi par e-mail.',
      cases: ['Le colis est déposé au relais'],
      bouton: 'Colis déposé',
      async valider(e) {
        try {
          await httpsCallable(functions, 'tabletteEnvoyee')({ commande: c.id, suivi: e.suivi });
        } catch (err) {
          throw new Error(err.code?.endsWith('invalid-argument') ? 'Ce numéro de suivi ne semble pas valide.' : 'L\'enregistrement a échoué. Réessayez.');
        }
        try {
          if (e.sim) await appeler('gestionSim', { action: 'modifier', id: e.sim, champs: { tablette: e.tablette } });
          await appeler('gestionStock', { action: 'modifier', id: e.tablette, champs: { etat: 'envoyee', commande: c.id } });
        } catch (err) {
          prevenir(`Colis enregistré, mais le kit n'a pas pu être sorti du stock : ${err.message}`);
        }
      },
    },
  ];
}

// Bouton « Préparer l'envoi » de la page d'une commande (gestion.js).
document.addEventListener('papote:preparer-envoi', (e) => preparerEnvoi(e.detail.commande, e.detail.bouton));

async function preparerEnvoi(c, bouton) {
  bouton.disabled = true;
  let ctx;
  try {
    ctx = await donnees(true);
  } catch (err) {
    prevenir(`Lecture du stock impossible : ${err.message}`);
    bouton.disabled = false;
    return;
  }
  bouton.disabled = false;
  const etat = { etape: 0, faits: {}, ...(c.preparation || {}) };
  etat.suivi = etat.suivi || c.etiquettes?.aller?.suivi || null;
  if (!etat.tablette) etat.tablette = ctx.stock.find((t) => t.commande === c.id)?.id || null;
  const fini = await ouvrirParcours({
    titre: `Envoi à ${c.livraison?.destinataire || c.nom || c.email}`,
    etapes: etapesEnvoi(c, ctx),
    etat,
    sauver: (e) => appeler('gestionParcours', { type: 'envoi', commande: c.id, preparation: e }),
  });
  c.preparation = etat;
  signalerChangement();
  loadOrders();
  if (fini) loadShipped();
}

// Envoyées mais pas encore reliées à une famille : suivi du colis, alerte au bout de 20 jours.
async function loadShipped() {
  try {
    const snap = await getDocs(query(collection(db, 'commandes'), where('expedition', '==', 'envoyee'), where('fid', '==', null)));
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.alerteJumelage === true) - (a.alerteJumelage === true)
        || (toDate(a.envoyeeLe)?.getTime() || 0) - (toDate(b.envoyeeLe)?.getTime() || 0));
    $('shipped-empty').hidden = list.length > 0;
    $('shipped').replaceChildren(...list.map((c) => {
      const li = document.createElement('li');
      if (c.alerteJumelage) li.classList.add('alert');
      li.innerHTML = '<strong></strong><span class="muted small"></span><span class="small"></span><a target="_blank" rel="noopener" class="small"></a>';
      li.querySelector('strong').textContent = orderHead(c);
      const infos = [c.email, `envoyée ${ago(toDate(c.envoyeeLe))}`, `${c.rappels || 0} rappel(s) envoyé(s)`];
      if (c.alerteJumelage) infos.push('pas jumelée après 20 jours : appeler le client');
      li.querySelector('.muted').textContent = infos.join(' · ');
      li.querySelector('span.small:not(.muted)').textContent = c.mailErreur ? `E-mail non parti : ${c.mailErreur}` : livraisonTexte(c);
      const a = li.querySelector('a');
      a.href = lienSuivi(c);
      a.textContent = `Suivre le colis ${c.suivi || ''}`;
      // Suite de l'envoi : déposé, reçu par le client (à cocher d'après le suivi), mis en route (jumelage, automatique).
      const recu = c.preparation?.recuLe;
      const suite = document.createElement('ol');
      suite.className = 'suite-envoi small';
      suite.innerHTML = `<li class="fait">Déposé au relais</li><li class="${recu ? 'fait' : 'actuelle'}">Reçu par le client</li><li>Mis en route par le client</li>`;
      li.append(suite);
      if (!recu) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'secondary small-btn';
        b.textContent = 'Le client a reçu le colis';
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            await appeler('gestionParcours', { type: 'recu', commande: c.id });
            suite.children[1].className = 'fait';
            suite.children[2].className = 'actuelle';
            b.remove();
          } catch (err) {
            prevenir(`Enregistrement impossible : ${err.message}`);
            b.disabled = false;
          }
        });
        li.append(b);
      } else suite.children[2].className = 'actuelle';
      return li;
    }));
  } catch (err) {
    console.warn('Envois illisibles', err);
    $('shipped-empty').hidden = false;
  }
}

// Tablettes incluses à rendre après la fin d'un abonnement (restitution écrite par le serveur).
async function loadReturns() {
  try {
    const snap = await getDocs(query(collection(db, 'commandes'), where('restitution.statut', 'in', ['attendue', 'echec'])));
    $('returns-empty').hidden = !snap.empty;
    $('returns').replaceChildren(...snap.docs.map((d) => {
      const c = d.data();
      const r = c.restitution || {};
      const avant = toDate(r.avant);
      const li = document.createElement('li');
      li.innerHTML = '<strong></strong><span class="muted small"></span><span class="small"></span><span class="small remb"></span>'
        + '<form class="etiquette"><button type="button" class="secondary small-btn sendcloud">Créer avec Sendcloud</button><input type="url" placeholder="ou lien de l\'étiquette de retour" aria-label="Étiquette de retour"><button type="submit" class="secondary small-btn">Envoyer l\'étiquette</button></form>'
        + '<div class="manquants small"><span>Manquant :</span>'
        + `<label><input type="checkbox" value="tablette"> tablette (${prix.tablette} €)</label>`
        + '<label><input type="checkbox" value="chargeur"> chargeur et câble (10 €)</label>'
        + (c.enceinteFournie === true ? '<label><input type="checkbox" value="enceinte"> enceinte (10 €)</label>' : '')
        + '<button type="button" class="secondary small-btn rendue">Matériel reçu</button></div>';
      li.querySelector('strong').textContent = c.livraison?.nom || c.nom || c.email;
      li.querySelector('.muted').textContent = `${c.email}${c.telephone ? ` · ${c.telephone}` : ''}`;
      li.querySelector('span.small:not(.muted):not(.remb)').textContent = (r.statut === 'echec'
        ? `Prélèvement échoué${r.erreur ? ` (${r.erreur})` : ''} : à relancer depuis Stripe.`
        : `À rendre avant le ${avant ? avant.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) : '?'}.`)
        + (r.motif === 'retractation' ? ' Rétractation.' : '');
      const remb = c.remboursement;
      const rembEl = li.querySelector('.remb');
      if (remb) {
        const montant = remb.montant ? `${(remb.montant / 100).toLocaleString('fr-FR')} €` : '';
        rembEl.textContent = remb.statut === 'echec'
          ? `Remboursement ${montant} échoué${remb.erreur ? ` (${remb.erreur})` : ''} : à rembourser depuis Stripe.`
          : `Remboursement ${montant} : ${remb.statut === 'au-retour' ? 'au retour de la tablette' : remb.statut}.`;
        rembEl.classList.toggle('error', remb.statut === 'echec');
      }
      const form = li.querySelector('.etiquette');
      const input = form.querySelector('input');
      if (r.etiquette) input.value = r.etiquette;
      // Sendcloud crée l'étiquette et le serveur l'envoie au client.
      const btnSendcloud = form.querySelector('button.sendcloud');
      btnSendcloud.addEventListener('click', async () => {
        if (r.etiquette && !await demander('Une étiquette a déjà été envoyée. En créer une nouvelle ?', { oui: 'En créer une nouvelle' })) return;
        btnSendcloud.disabled = true;
        btnSendcloud.textContent = 'Création…';
        try {
          const res = await appeler('gestionEtiquette', { commande: d.id, sens: 'retour' });
          input.value = res.url;
          btnSendcloud.textContent = 'Étiquette envoyée au client';
        } catch (err) {
          prevenir(`Étiquette impossible : ${err.message}`);
          btnSendcloud.textContent = 'Créer avec Sendcloud';
          btnSendcloud.disabled = false;
        }
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const lien = input.value.trim();
        if (!/^https:\/\//.test(lien)) { prevenir('Collez le lien https de l\'étiquette prépayée.'); return; }
        const sb = form.querySelector('button');
        sb.disabled = true;
        try {
          await httpsCallable(functions, 'etiquetteRetour')({ commande: d.id, lien });
          sb.textContent = 'Étiquette envoyée au client';
        } catch (err) {
          console.error(err);
          prevenir("L'étiquette n'a pas pu être envoyée.");
          sb.disabled = false;
        }
      });
      const btn = li.querySelector('button.rendue');
      btn.addEventListener('click', async () => {
        // Ce qui manque dans le colis est prélevé sur la carte du client (tabletteRendue, index.js).
        const manquants = [...li.querySelectorAll('.manquants input:checked')].map((i) => i.value);
        const total = manquants.reduce((s, m) => s + prix[m], 0);
        if (!await demander(total
          ? `Prélever ${total} € à ${c.email} pour le matériel manquant (${manquants.join(', ')}) ?`
          : `Tout le matériel de ${c.email} est bien revenu ?`)) return;
        btn.disabled = true;
        try {
          const res = await httpsCallable(functions, 'tabletteRendue')({ commande: d.id, manquants }).then((x) => x.data || {});
          // Tablette revenue : dans le stock, à vérifier avant de repartir. Tablette manquante : perdue (retirée de la famille).
          const { stock } = await donnees().catch(() => ({ stock: [] }));
          const t = stock.find((x) => x.commande === d.id);
          const etat = manquants.includes('tablette') ? 'perdue' : 'revenue';
          if (t) await appeler('gestionStock', { action: 'modifier', id: t.id, champs: { etat } }).catch(() => null);
          if (res.erreur) prevenir(`Prélèvement refusé : ${res.erreur}. La commande reste dans la liste, à relancer depuis Stripe.`);
          signalerChangement();
          if (!res.erreur) li.remove();
          else btn.disabled = false;
        } catch (err) {
          console.error(err);
          prevenir("L'enregistrement a échoué.");
          btn.disabled = false;
        }
      });
      return li;
    }));
  } catch (err) {
    console.warn('Restitutions illisibles', err);
    $('returns-empty').hidden = false;
  }
}

async function load() {
  await choisirBase();
  loadOrders();
  loadShipped();
  loadReturns();
  $('loading-families').hidden = false;
  try {
    const [famSnap, tabletSnap] = await Promise.all([
      getDocs(collection(db, 'families')),
      getDocs(query(collectionGroup(db, 'members'), where('role', '==', 'tablette'))),
    ]);
    const tablets = {};
    for (const d of tabletSnap.docs) {
      const fid = d.ref.parent.parent.id;
      (tablets[fid] = tablets[fid] || []).push(d.data());
    }
    families = await Promise.all(famSnap.docs.map(async (d) => {
      const posts = collection(db, 'families', d.id, 'posts');
      const [count, last, people, legacy] = await Promise.all([
        getCountFromServer(posts).then((c) => c.data().count).catch(() => null),
        getDocs(query(posts, orderBy('createdAt', 'desc'), limit(1))).then((s) => toDate(s.docs[0]?.data().createdAt)).catch(() => null),
        getCountFromServer(query(collection(db, 'families', d.id, 'members'), where('role', '==', 'famille'))).then((c) => c.data().count).catch(() => null),
        getCountFromServer(query(posts, where('hasMedia', '==', true))).then((c) => c.data().count).catch(() => 0),
      ]);
      const list = tablets[d.id] || [];
      const latest = (field) => list.reduce((max, t) => {
        const v = toDate(t[field]);
        return v && (!max || v > max) ? v : max;
      }, null);
      return {
        id: d.id, ...d.data(), posts: count, lastPost: last, people, legacy,
        hasTablet: list.length > 0,
        online: latest('lastOnline'),
        active: latest('lastActive'),
        version: list.map((t) => t.appVersion).filter(Boolean).sort().pop() || null,
      };
    }));
    render();
    refreshSim(families, tablets);
  } catch (err) {
    console.error(err);
    $('t-familles').innerHTML = '<tbody><tr><td class="error">Lecture impossible. Ce compte a-t-il les droits d\'administrateur ?</td></tr></tbody>';
  } finally {
    $('loading-families').hidden = true;
  }
}

// Demandes en attente dans une famille : l'administrateur peut les accepter, et désigner le
// propriétaire (par exemple après un changement de compte, quand plus personne ne peut accepter).
async function showPending(f, li) {
  let snap;
  try {
    snap = await getDocs(query(collection(db, 'families', f.id, 'members'), where('status', '==', 'pending')));
  } catch (err) { return; }
  if (snap.empty) return;
  const box = document.createElement('div');
  box.className = 'replace';
  for (const d of snap.docs) {
    const m = d.data();
    const row = document.createElement('p');
    row.className = 'small pending-row';
    row.textContent = `En attente : ${m.name}${m.email ? ` (${m.email})` : ''} `;
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'link small';
    ok.textContent = 'Accepter';
    const owner = document.createElement('button');
    owner.type = 'button';
    owner.className = 'link small';
    owner.textContent = 'Accepter comme propriétaire';
    const accept = async (asOwner) => {
      try {
        await updateDoc(d.ref, { status: 'active' });
        if (asOwner) await updateDoc(doc(db, 'families', f.id), { createdBy: d.id });
        row.textContent = asOwner ? `${m.name} est maintenant propriétaire.` : `${m.name} a été accepté.`;
      } catch (err) {
        console.error(err);
        prevenir("L'opération a échoué.");
      }
    };
    ok.addEventListener('click', () => accept(false));
    owner.addEventListener('click', async () => { if (await demander(`Faire de ${m.name} le propriétaire de la famille de ${f.name} ?`)) accept(true); });
    row.append(ok, ' · ', owner);
    box.append(row);
  }
  li.append(box);
}

// Membres d'une famille : l'administrateur peut, en secours, nommer ou retirer un responsable,
// changer le propriétaire et retirer un proche (jamais le propriétaire).
async function toggleMembers(f, li) {
  const out = li.querySelector('.members-out');
  if (!out.hidden) { out.hidden = true; return; }
  out.hidden = false;
  out.textContent = 'Chargement…';
  let snap;
  let fam;
  try {
    [snap, fam] = await Promise.all([
      getDocs(query(collection(db, 'families', f.id, 'members'), where('role', '==', 'famille'))),
      getDoc(doc(db, 'families', f.id)),
    ]);
  } catch (err) {
    console.error(err);
    out.textContent = 'Lecture impossible.';
    return;
  }
  const data = fam.data() || {};
  const admins = new Set(data.admins || []);
  const rerender = () => { out.hidden = true; toggleMembers(f, li); };
  const act = async (fn) => {
    try { await fn(); rerender(); } catch (err) { console.error(err); prevenir("L'opération a échoué."); }
  };
  const button = (label, onClick, danger) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `link small${danger ? ' danger' : ''}`;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };
  const famRef = doc(db, 'families', f.id);
  const rows = snap.docs.filter((d) => d.data().status !== 'pending').map((d) => {
    const m = d.data();
    const isOwner = data.createdBy === d.id;
    const isResp = isOwner || admins.has(d.id);
    const row = document.createElement('p');
    row.className = 'small pending-row';
    row.textContent = `${m.name}${m.email ? ` (${m.email})` : ''}${isOwner ? ' · propriétaire' : isResp ? ' · responsable' : ''} `;
    if (isOwner) return row;
    const parts = [
      button(isResp ? 'Retirer responsable' : 'Rendre responsable', () => act(() => {
        const next = new Set(admins);
        if (isResp) next.delete(d.id); else next.add(d.id);
        return updateDoc(famRef, { admins: [...next] });
      })),
      button('Faire propriétaire', async () => {
        if (await demander(`Faire de ${m.name} le propriétaire de la famille de ${f.name} ?`)) act(() => updateDoc(famRef, { createdBy: d.id }));
      }),
      button('Retirer', async () => {
        if (!await demander(`Retirer ${m.name} de la famille de ${f.name} ?`, { oui: 'Retirer', danger: true })) return;
        act(async () => {
          if (admins.has(d.id)) { const next = new Set(admins); next.delete(d.id); await updateDoc(famRef, { admins: [...next] }); }
          await deleteDoc(d.ref);
        });
      }, true),
    ];
    parts.forEach((p, i) => row.append(...(i ? [' · ', p] : [p])));
    return row;
  });
  out.replaceChildren(...(rows.length ? rows : [Object.assign(document.createElement('p'), { className: 'small muted', textContent: 'Aucun proche.' })]));
}

// Tablette de remplacement : un code d'installation pour cette famille. Installée avec
// installer-tablette.ps1 -Code, elle arrive déjà dans la famille, sans écran de bienvenue.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
async function prepareReplacement(f, li) {
  const out = li.querySelector('.replace-out');
  if (!await demander(`Préparer une tablette de remplacement pour la famille de ${f.name} ?`, { oui: 'Préparer' })) return;
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  try {
    await setDoc(doc(db, 'invites', code), { fid: f.id, createdBy: auth.currentUser.uid, kind: 'tablette' });
  } catch (err) {
    console.error(err);
    prevenir("Le code n'a pas pu être créé.");
    return;
  }
  const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
  out.hidden = false;
  out.innerHTML = '';
  const p1 = document.createElement('p');
  p1.textContent = `Installez la nouvelle tablette avec : installer-tablette.ps1 -Code ${shown}`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'link danger small';
  btn.textContent = "Retirer l'ancienne tablette de la famille";
  btn.addEventListener('click', () => removeOldTablets(f, btn));
  out.append(p1, btn);
}

// À faire une fois la nouvelle tablette installée : l'ancienne ne reçoit plus rien.
async function removeOldTablets(f, btn) {
  const snap = await getDocs(query(collection(db, 'families', f.id, 'members'), where('role', '==', 'tablette')));
  const list = snap.docs.map((d) => ({ ref: d.ref, ...d.data() }))
    .sort((a, b) => (toDate(b.joinedAt)?.getTime() || 0) - (toDate(a.joinedAt)?.getTime() || 0));
  // On garde les fiches de la tablette la plus récente (ses deux comptes, inscrits à la même installation).
  const newest = toDate(list[0]?.joinedAt)?.getTime() || 0;
  const old = list.filter((t) => newest - (toDate(t.joinedAt)?.getTime() || 0) > 10 * 60_000);
  if (!old.length) { prevenir("Aucune ancienne tablette à retirer : installez d'abord la nouvelle."); return; }
  if (!await demander(`Retirer ${old.length} fiche(s) d'ancienne tablette de la famille de ${f.name} ?`)) return;
  btn.disabled = true;
  try {
    for (const t of old) await deleteDoc(t.ref);
    btn.textContent = 'Ancienne tablette retirée';
  } catch (err) {
    console.error(err);
    prevenir('Le retrait a échoué.');
    btn.disabled = false;
  }
}

// Suppression définitive demandée par le client (à contact@) : le nom retapé confirme. Le serveur refuse
// la famille offerte (Mamie) et une famille dont l'abonnement est en cours (gestionSupprimerFamille).
async function supprimerFamille(f, li, btn) {
  const nom = await saisir(`Supprimer DÉFINITIVEMENT la famille « ${f.name} » : messages, photos, vidéos, rappels, anniversaires, membres et journal. Rien ne pourra être récupéré.\n\nPour confirmer, retapez le nom de la famille :`);
  if (nom == null) return;
  const simple = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!simple(nom) || simple(nom) !== simple(f.name)) { prevenir('Le nom ne correspond pas : rien n\'a été supprimé.'); return; }
  btn.disabled = true;
  btn.textContent = 'Suppression…';
  try {
    await appeler('gestionSupprimerFamille', { fid: f.id, nom });
    families = families.filter((x) => x.id !== f.id);
    li.remove();
    location.hash = '#clients/familles';
    render();
    prevenir(`La famille « ${f.name} » et toutes ses données sont supprimées.`);
  } catch (err) {
    prevenir(`Suppression impossible : ${err.message}`);
    btn.disabled = false;
    btn.textContent = 'Supprimer la famille et toutes ses données';
  }
}

function state(f) {
  if (!f.hasTablet) return { cls: 'none', label: 'Pas de tablette' };
  if (!f.online || Date.now() - f.online.getTime() > OFFLINE_MS) return { cls: 'off', label: `Hors ligne, vue ${ago(f.online)}` };
  return { cls: 'on', label: 'En ligne' };
}

let vueFamilles = null; // onglet de la liste des familles (off, on, idle, none, toutes)
const pasTouchee = (f) => f.hasTablet && (!f.active || Date.now() - f.active.getTime() > IDLE_MS);
const dansVue = (f) => vueFamilles === 'toutes' || (vueFamilles === 'idle' ? pasTouchee(f) : state(f).cls === vueFamilles);

// Chiffres de l'accueil : chacun ouvre la liste des familles correspondante.
document.querySelectorAll('[data-panneau="accueil"] .stat[data-vue]').forEach((el) => {
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  const choisir = () => { vueFamilles = el.dataset.vue; location.hash = '#clients/familles'; render(); };
  el.addEventListener('click', choisir);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choisir(); } });
});
let ficheFamille = null; // famille ouverte sur sa page

// La famille ouverte est dans l'adresse (#clients/familles/fid) : lien direct depuis la page d'un client.
function familleDeLAdresse() {
  const [page, onglet, fid] = location.hash.slice(1).split('/');
  return page === 'clients' && onglet === 'familles' && fid ? decodeURIComponent(fid) : null;
}
function ouvrirFamille(fid) {
  location.hash = `#clients/familles/${encodeURIComponent(fid)}`;
}
$('famille-retour').addEventListener('click', () => { location.hash = '#clients/familles'; });
window.addEventListener('hashchange', () => {
  if (familleDeLAdresse() === ficheFamille) return;
  ficheFamille = familleDeLAdresse();
  render();
  window.scrollTo(0, 0);
});

// Page d'une famille : ses informations, ses membres, puis ce qu'on peut faire, chaque action expliquée.
const ABONNEMENT_FAMILLE = { offert: 'Offert', actif: 'Actif', impaye: 'Impayé', suspendu: 'Suspendu', resilie: 'Résilié', aucun: 'Aucun' };
function el(tag, classe, texte) {
  const e = document.createElement(tag);
  if (classe) e.className = classe;
  if (texte != null) e.textContent = texte;
  return e;
}
function carteFamille(f) {
  const s = state(f);
  const tete = el('li', `family card ${s.cls}`);
  const titre = el('div', 'family-head');
  titre.append(el('span', 'dot'), el('h2', null, f.name), el('code', null, f.code ? `${f.code.slice(0, 4)}-${f.code.slice(4)}` : ''));
  const dl = el('dl');
  for (const [k, v] of [
    ['État', s.label],
    ['Tablette utilisée', ago(f.active)],
    ['Version', f.version || '–'],
    ['Abonnement', ABONNEMENT_FAMILLE[f.abonnement?.statut] || 'Aucun'],
    ['Proches', f.people ?? '–'],
    ['Photos et messages', f.posts ?? '–'],
    ['Dernier envoi', ago(f.lastPost)],
  ]) dl.append(el('dt', null, k), el('dd', null, v));
  tete.append(titre, dl);

  // Membres affichés d'office, avec les demandes « veut rejoindre » en tête.
  const membres = el('li', 'card');
  const sortie = el('div', 'members-out');
  sortie.hidden = true;
  membres.append(el('h2', null, 'Membres'), sortie);
  showPending(f, membres);
  toggleMembers(f, membres);
  return [tete, membres];
}

function actionsFamille(f) {
  const carte = el('div', 'card');
  carte.append(el('h2', null, 'Actions possibles'));
  const action = (texte, libelle, faire, danger) => {
    const bloc = el('div', 'action');
    const b = el('button', `secondary small-btn${danger ? ' danger' : ''}`, libelle);
    b.type = 'button';
    b.addEventListener('click', () => faire(b));
    bloc.append(el('p', 'small', texte), b);
    carte.append(bloc);
    return bloc;
  };
  const remplacement = action('La tablette est cassée ou perdue : un code permet d\'installer une nouvelle tablette directement dans cette famille, sans rien refaire.',
    'Préparer une tablette de remplacement', () => prepareReplacement(f, carte));
  remplacement.append(Object.assign(el('div', 'replace-out small'), { hidden: true }));
  // Famille offerte (les mamies) : jamais en pause, jamais supprimable.
  const offerte = f.abonnement?.statut === 'offert';
  action(offerte ? 'Famille offerte : elle n\'est jamais mise en pause ni supprimable. Sans abonnement, sa tablette se mettrait en pause.'
    : 'Pour un proche à qui vous offrez le service : la tablette ne sera jamais mise en pause, et la famille ne pourra pas être supprimée.',
  offerte ? 'Ne plus offrir' : 'Rendre offerte', async (b) => {
    if (!await demander(offerte
      ? `« ${f.name} » ne sera plus offerte : sans abonnement, sa tablette se mettra en pause. Continuer ?`
      : `Rendre « ${f.name} » offerte ? Elle ne sera jamais mise en pause ni supprimable.`)) return;
    b.disabled = true;
    try {
      await appeler('gestionFamilleOfferte', { fid: f.id, offerte: !offerte });
      f.abonnement = { ...(f.abonnement || {}), statut: offerte ? 'aucun' : 'offert' };
      render();
    } catch (err) {
      prevenir(`Impossible : ${err.message}`);
      b.disabled = false;
    }
  });
  if (!offerte) {
    action('Seulement si le client le demande : messages, photos, vidéos, rappels et membres sont effacés pour toujours.',
      'Supprimer la famille et toutes ses données', (b) => supprimerFamille(f, carte, b), true);
  }
  return carte;
}

function render() {
  const now = Date.now();
  const withTablet = families.filter((f) => f.hasTablet);
  const offline = withTablet.filter((f) => state(f).cls === 'off');
  $('s-families').textContent = families.length;
  $('s-online').textContent = withTablet.length - offline.length;
  $('s-offline').textContent = offline.length;
  $('s-idle').textContent = withTablet.filter(pasTouchee).length;

  // Liste par statut (les chiffres servent d'onglets) ; une famille ouverte a sa propre page.
  const rank = { off: 0, on: 1, none: 2 };
  const sorted = families.slice().sort((a, b) => rank[state(a).cls] - rank[state(b).cls] || a.name.localeCompare(b.name));
  const compte = (cls) => families.filter((f) => state(f).cls === cls).length;
  if (!vueFamilles) vueFamilles = compte('off') ? 'off' : 'toutes';
  const onglet = (vue, n, texte, classe) => {
    const el = document.createElement('div');
    el.className = `stat onglet ${classe || ''}${vue === vueFamilles ? ' actif' : ''}`;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-pressed', String(vue === vueFamilles));
    el.innerHTML = '<span></span><p></p>';
    el.querySelector('span').textContent = n;
    el.querySelector('p').textContent = texte;
    const choisir = () => { vueFamilles = vue; render(); };
    el.addEventListener('click', choisir);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choisir(); } });
    return el;
  };
  $('kpi-familles').replaceChildren(
    onglet('off', compte('off'), 'hors ligne', 'warn'),
    onglet('on', compte('on'), 'en ligne', 'ok'),
    ...(vueFamilles === 'idle' || families.some(pasTouchee) ? [onglet('idle', families.filter(pasTouchee).length, 'pas touchées 24 h')] : []),
    onglet('none', compte('none'), 'sans tablette'),
    onglet('toutes', families.length, 'toutes les familles'),
  );
  const ABOS = { offert: 'Offert', actif: 'Actif', impaye: 'Impayé', suspendu: 'Suspendu', resilie: 'Résilié', aucun: 'Aucun' };
  const table = $('t-familles');
  const tete = ['Famille', 'Code', 'Tablette', 'Abonnement', 'Membres', 'Envois', 'Dernier envoi', 'Version'];
  const lignes = sorted.filter(dansVue).map((f) => {
    const tr = document.createElement('tr');
    tr.tabIndex = 0;
    const cellules = [f.name, f.code ? `${f.code.slice(0, 4)}-${f.code.slice(4)}` : '', state(f).label,
      ABOS[f.abonnement?.statut] || 'Aucun', f.people ?? '–', f.posts ?? '–', ago(f.lastPost), f.version || '–'];
    cellules.forEach((v, n) => {
      const td = document.createElement('td');
      if (n === 0) {
        const dot = document.createElement('span');
        dot.className = `dot ${state(f).cls}`;
        td.append(dot, ' ');
        const b = document.createElement('strong');
        b.textContent = v;
        td.append(b);
      } else td.textContent = v;
      tr.append(td);
    });
    tr.addEventListener('click', () => ouvrirFamille(f.id));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') ouvrirFamille(f.id); });
    return tr;
  });
  const thead = document.createElement('thead');
  thead.innerHTML = `<tr>${tete.map((t) => `<th>${t}</th>`).join('')}</tr>`;
  const tbody = document.createElement('tbody');
  if (lignes.length) tbody.append(...lignes);
  else tbody.innerHTML = `<tr><td class="vide" colspan="${tete.length}">Aucune famille ici.</td></tr>`;
  table.replaceChildren(thead, tbody);
  ficheFamille = familleDeLAdresse();
  const ouverte = families.find((f) => f.id === ficheFamille);
  $('familles-liste').hidden = !!ouverte;
  $('famille-fiche').hidden = !ouverte;
  // Famille ouverte : une page à elle, sans les onglets de la liste.
  document.querySelector('[data-panneau="clients"] .onglets').hidden = !!ouverte;
  if (ouverte && $('famille-fiche').dataset.fid !== ouverte.id + JSON.stringify(ouverte.abonnement || null)) {
    $('famille-fiche').dataset.fid = ouverte.id + JSON.stringify(ouverte.abonnement || null);
    $('families').replaceChildren(...carteFamille(ouverte));
    $('famille-actions').replaceChildren(actionsFamille(ouverte));
  }
  if (!ouverte) delete $('famille-fiche').dataset.fid;
  const legacy = families.reduce((n, f) => n + (f.legacy || 0), 0);
  $('migrate-count').textContent = legacy
    ? `${legacy} envoi${legacy > 1 ? 's' : ''} encore dans la base (photos, vidéos et anciens vocaux).`
    : 'Tout est déjà dans Storage.';
  $('btn-migrate').disabled = !legacy;
}

// ---------- Transfert vers Storage ----------

function log(line) {
  $('migrate-log').hidden = false;
  $('migrate-log').textContent += `${line}\n`;
  $('migrate-log').scrollTop = $('migrate-log').scrollHeight;
}

async function dataUrlBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}

async function migratePost(fid, snap) {
  const post = snap.data();
  const postRef = snap.ref;
  const mediaRef = (kind) => doc(postRef, 'media', kind);
  let blob;
  let ext;
  let field;
  const toDelete = [];
  if (post.type === 'photo') {
    const m = await getDoc(mediaRef('image'));
    if (!m.exists()) return 'sans fichier';
    blob = await dataUrlBlob(m.data().data);
    ext = 'jpg';
    field = 'imageUrl';
    toDelete.push(mediaRef('image'));
  } else if (post.type === 'video') {
    const parts = [];
    for (let i = 0; i < (post.chunks || 0); i++) {
      const part = await getDoc(mediaRef(`video${i}`));
      if (!part.exists()) return 'vidéo incomplète';
      parts.push(part.data().data);
      toDelete.push(mediaRef(`video${i}`));
    }
    blob = await dataUrlBlob(`data:${post.mime || 'video/webm'};base64,${parts.join('')}`);
    ext = (post.mime || '').includes('mp4') ? 'mp4' : 'webm';
    field = 'videoUrl';
  } else {
    return 'ignoré (vocal)';
  }
  const path = `families/${fid}/media/${snap.id}.${ext}`;
  const fileRef = ref(storage, path);
  await uploadBytes(fileRef, blob, { contentType: blob.type || (ext === 'jpg' ? 'image/jpeg' : `video/${ext}`) });
  const url = await getDownloadURL(fileRef);
  // L'adresse d'abord, puis l'effacement des morceaux : la tablette ne perd jamais l'image.
  const batch = writeBatch(db);
  batch.update(postRef, { [field]: url, storagePath: path, hasMedia: false, chunks: 0 });
  toDelete.forEach((r) => batch.delete(r));
  await batch.commit();
  return `${Math.round(blob.size / 1024)} Ko`;
}

$('btn-migrate').addEventListener('click', async () => {
  if (!await demander('Transférer toutes les anciennes photos et vidéos vers Storage ?', { oui: 'Transférer' })) return;
  $('btn-migrate').disabled = true;
  $('migrate-log').textContent = '';
  let done = 0;
  let failed = 0;
  for (const f of families.filter((x) => x.legacy)) {
    log(`— ${f.name}`);
    const snap = await getDocs(query(collection(db, 'families', f.id, 'posts'), where('hasMedia', '==', true)));
    for (const d of snap.docs) {
      try {
        const result = await migratePost(f.id, d);
        log(`  ${d.data().type} ${d.id} : ${result}`);
        done++;
      } catch (err) {
        console.error(err);
        log(`  ${d.data().type} ${d.id} : ÉCHEC (${err.code || err.message})`);
        failed++;
      }
    }
  }
  log(`Terminé : ${done} traités, ${failed} échecs.`);
  load();
});
