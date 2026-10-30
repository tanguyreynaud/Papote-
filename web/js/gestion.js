// Espace d'administration, partie gestion : navigation entre les sections, accueil « À faire »,
// commandes, stock de tablettes, factures et comptabilité. Tout passe par les fonctions serveur
// gestion* (functions/gestion.js) : l'argent vient de Stripe, le stock et les dépenses de Firestore.
// Les factures déposées sont lues automatiquement (gestionLireFacture) pour préremplir les fiches.
// La connexion et les sections familles, envois et maintenance sont dans admin.js.
import './retour.js';
import { demander, saisir, prevenir, menuPoints, annoncer, boutonCharge, patienter, ligneModifiable } from './dialogue.js';
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  appeler, donnees as lireDonnees, signalerChangement, messageErreur, reveiller,
} from './gestion-api.js';
import { ouvrirParcours, fermerParcours } from './parcours.js';
import {
  getFirestore, doc, collection, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, serverTimestamp, increment,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { simVue, go as enGo } from './sim.js';

const $ = (id) => document.getElementById(id);

// ---------- Mise en forme ----------

const euros = (c) => (c == null ? '' : (c / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }));
const jour = (ms) => (ms ? new Date(ms).toLocaleDateString('fr-FR') : '');
const moisCle = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const moisNom = (cle) => {
  const [a, m] = cle.split('-').map(Number);
  const t = new Date(a, m - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? 's' : ''}`;
const codeCommande = (c) => (c && c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c || '');

// « 89,90 », « 89.9 », « 1 200 » → centimes ; null si vide, NaN si illisible.
function enCentimes(saisie) {
  const t = String(saisie || '').replace(/\s|€/g, '').replace(',', '.');
  if (!t) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
  return Math.round(Number(t) * 100);
}

// Élément HTML ; les textes passent par textContent (jamais d'HTML venu des données).
function h(tag, attrs = {}, ...enfants) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const e of enfants.flat()) {
    if (e == null || e === false) continue;
    el.append(e instanceof Node ? e : document.createTextNode(String(e)));
  }
  return el;
}

// Tableau : colonnes [{ titre, n (nombre aligné à droite) }], lignes de cellules (texte ou Node).
// lignes peut contenir { cellules, onclick } pour une ligne cliquable.
function remplirTable(table, colonnes, lignes, { total, vide = 'Rien sur cette période.' } = {}) {
  const ligne = (l) => {
    const cellules = Array.isArray(l) ? l : l.cellules;
    const tr = h('tr', l.onclick ? { tabIndex: 0, onclick: l.onclick, onkeydown: (e) => e.key === 'Enter' && l.onclick() } : {},
      cellules.map((v, i) => h('td', { class: colonnes[i].n ? 'n' : null, 'data-titre': colonnes[i].titre }, v ?? '')));
    if (l.classe) tr.className = l.classe;
    return tr;
  };
  table.replaceChildren(
    h('thead', {}, h('tr', {}, colonnes.map((c) => h('th', { class: c.n ? 'n' : null }, c.titre)))),
    h('tbody', {},
      lignes.length ? lignes.map(ligne) : h('tr', {}, h('td', { class: 'vide', colSpan: colonnes.length }, vide)),
      total ? h('tr', { class: 'total' }, total.map((v, i) => h('td', { class: colonnes[i].n ? 'n' : null }, v ?? ''))) : null),
  );
}

function stat(valeur, texte, detail, classe) {
  return h('div', { class: 'stat' }, h('span', { class: classe }, valeur), h('p', {}, texte), detail ? h('small', {}, detail) : null);
}

// Un chiffre qui ouvre la liste correspondante.
function cliquable(el, faire) {
  el.classList.add('onglet');
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.addEventListener('click', faire);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); faire(); } });
  return el;
}

const badge = (texte, classe) => h('span', { class: `badge ${classe || ''}` }, texte);

// ---------- CSV pour Excel (séparateur « ; », virgule décimale, BOM UTF-8) ----------

const csvMontant = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));

function csv(nom, entetes, lignes, avecPeriode = true) {
  const cellule = (v) => {
    const t = v == null ? '' : String(v);
    return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const texte = [entetes, ...lignes].map((l) => l.map(cellule).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿', texte], { type: 'text/csv;charset=utf-8' }));
  const suffixe = avecPeriode ? etiquettePeriode() : new Date().toLocaleDateString('sv-SE');
  const a = h('a', { href: url, download: `papote-${nom}-${suffixe}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- Pièces jointes ----------

const MAX_PIECE = 6 * 1024 * 1024;

function lireFichier(fichier) {
  return new Promise((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = () => ko(r.error);
    r.readAsDataURL(fichier);
  });
}

// Photo de téléphone trop lourde : réduite à 2000 px en JPEG.
async function alleger(fichier) {
  if (!/^image\/(jpeg|png|webp)$/.test(fichier.type) || fichier.size < 2 * 1024 * 1024) return fichier;
  try {
    const image = await createImageBitmap(fichier);
    const k = Math.min(1, 2000 / Math.max(image.width, image.height));
    const canvas = h('canvas', { width: Math.round(image.width * k), height: Math.round(image.height * k) });
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.85));
    return blob ? new File([blob], fichier.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }) : fichier;
  } catch (e) {
    return fichier;
  }
}

async function envoyerPieces(collection, id, fichiers, genre) {
  for (const brut of fichiers) {
    const fichier = await alleger(brut);
    if (fichier.size > MAX_PIECE) throw new Error(`${fichier.name} dépasse 6 Mo.`);
    await appeler('gestionPiece', {
      action: 'ajouter', collection, id, nom: fichier.name, type: fichier.type, contenu: await lireFichier(fichier), ...(genre ? { genre } : {}),
    });
  }
}

async function ouvrirPiece(piece) {
  // Fenêtre ouverte tout de suite, sinon le navigateur la bloque après l'attente.
  const fenetre = window.open('', '_blank');
  try {
    const { contenu, type } = await appeler('gestionPiece', { action: 'lire', chemin: piece.chemin });
    const octets = Uint8Array.from(atob(contenu), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([octets], { type }));
    if (fenetre) fenetre.location = url;
    else h('a', { href: url, download: piece.nom }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    if (fenetre) fenetre.close();
    prevenir(messageErreur(e));
  }
}

const GENRES_PIECE = { photo: 'Photo', garantie: 'Bon de garantie', facture: 'Facture d\'achat', autre: 'Autre document' };

// Choix du type de fichier avant de le prendre : null si annulé.
function choisirGenre() {
  return new Promise((resoudre) => {
    const d = h('dialog', { class: 'dialogue-papote' });
    const fin = (v) => { d.close(); d.remove(); resoudre(v); };
    d.append(h('p', {}, 'Quel fichier ajoutez-vous ?'),
      h('div', { class: 'actions choix-genre' }, ...Object.entries(GENRES_PIECE).map(([k, v]) =>
        h('button', { type: 'button', class: 'secondary', onclick: () => fin(k) }, v))),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'secondary', onclick: () => fin(null) }, 'Annuler')));
    d.addEventListener('cancel', (e) => { e.preventDefault(); fin(null); });
    document.body.append(d);
    d.showModal();
  });
}

// Fenêtre de choix de fichiers (PDF ou photo) : liste vide si rien n'est choisi.
function prendreFichiers(genre) {
  return new Promise((resoudre) => {
    const champ = h('input', { type: 'file', accept: genre === 'photo' ? 'image/*' : 'application/pdf,image/*', multiple: true, hidden: true });
    champ.addEventListener('change', () => { resoudre([...champ.files]); champ.remove(); });
    champ.addEventListener('cancel', () => { resoudre([]); champ.remove(); });
    document.body.append(champ);
    champ.click();
  });
}

function lienPiece(piece) {
  return h('button', { type: 'button', class: 'piece', title: piece.nom, onclick: (e) => { e.stopPropagation(); ouvrirPiece(piece); } },
    '📎 ', piece.nom.length > 28 ? `${piece.nom.slice(0, 25)}…` : piece.nom);
}

// ---------- État ----------

let donnees = null; // gestionDonnees
let stripe = null; // gestionStripe pour la période choisie
let stripeMois = null; // le mois en cours (accueil), tiré de stripeAnnee
let stripeAnnee = null; // gestionStripe pour l'année civile en cours (franchise de TVA)
let stripeTotal = null; // gestionStripe depuis le début de Papote (résultat total de l'accueil)
const DEBUT_PAPOTE = new Date(2026, 0, 1).getTime();
let periode = null; // { debut, fin } en millisecondes, fin exclue

function erreur(e) {
  console.error(e);
  $('erreur').textContent = messageErreur(e);
  $('erreur').hidden = false;
}

// ---------- Navigation ----------

const memoire = {
  lire: (k, defaut) => { try { return localStorage.getItem(k) || defaut; } catch (e) { return defaut; } },
  ecrire: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* navigation privée */ } },
};

const TITRES = {
  accueil: 'Accueil',
  commandes: 'Commandes',
  clients: 'Clients',
  stock: 'Stock',
  compta: 'Comptabilité',
  outils: 'Réglages',
  tablette: 'Tablette',
  commande: 'Commande',
  client: 'Client',
  depense: 'Dépense',
  sim: 'Carte SIM',
  accessoire: 'Accessoire',
  nouveau: 'Ajouter',
};
// Pages d'une fiche (#tablette/id, #commande/id) : le menu garde sa section allumée.
const PARENTS = { tablette: 'stock', commande: 'commandes', client: 'clients', depense: 'compta', sim: 'stock', accessoire: 'stock', nouveau: 'compta' };
// Anciennes pages devenues des onglets (liens déjà notés, favoris) : #familles → #clients/familles.
const ANCIENNES = { familles: 'clients/familles', factures: 'compta/factures' };
const AVEC_PERIODE = ['compta'];

let connecte = false; // connexion admin faite (onAuthStateChanged plus bas)

function pageCourante() {
  const p = location.hash.slice(1).split('/')[0];
  return TITRES[p] ? p : 'accueil';
}

// Onglets d'une page (#compta/urssaf) : un seul bloc affiché à la fois, le dernier choisi est retenu.
function choisirOnglet(page, nom) {
  const panneau = document.querySelector(`[data-panneau="${page}"]`);
  const boutons = [...panneau.querySelectorAll('.onglets [data-onglet]')];
  if (!boutons.length) return;
  const noms = boutons.map((b) => b.dataset.onglet);
  if (!noms.includes(nom)) nom = memoire.lire(`papote-onglet-${page}`, noms[0]);
  if (!noms.includes(nom)) nom = noms[0];
  memoire.ecrire(`papote-onglet-${page}`, nom);
  for (const b of boutons) {
    b.classList.toggle('actif', b.dataset.onglet === nom);
    b.setAttribute('aria-selected', String(b.dataset.onglet === nom));
  }
  panneau.querySelectorAll('[data-onglet]:not(button)').forEach((el) => { el.hidden = el.dataset.onglet !== nom; });
}
document.querySelectorAll('[data-panneau] .onglets [data-onglet]').forEach((b) => {
  b.setAttribute('role', 'tab');
  b.addEventListener('click', () => {
    const page = b.closest('[data-panneau]').dataset.panneau;
    history.replaceState(null, '', `#${page}/${b.dataset.onglet}`);
    choisirOnglet(page, b.dataset.onglet);
  });
});

function afficherPage() {
  const ancienne = ANCIENNES[location.hash.slice(1).split('/')[0]];
  if (ancienne) history.replaceState(null, '', `#${ancienne}`);
  const page = pageCourante();
  const menu = PARENTS[page] || page;
  document.querySelectorAll('.nav a[data-page]').forEach((a) => {
    a.classList.toggle('actif', a.dataset.page === menu);
  });
  document.querySelectorAll('[data-panneau]').forEach((p) => { p.hidden = p.dataset.panneau !== page; });
  // Page d'une famille (#clients/familles/fid) : titre « Famille », pas « Clients ».
  const [, onglet, fiche] = location.hash.slice(1).split('/');
  const titre = page === 'clients' && onglet === 'familles' && fiche ? 'Famille' : TITRES[page];
  $('titre-page').textContent = titre;
  choisirOnglet(page, location.hash.slice(1).split('/')[1]);
  document.title = `Papote · ${titre}`;
  $('periode').hidden = !AVEC_PERIODE.includes(page);
  $('p-etat').hidden = !AVEC_PERIODE.includes(page);
  window.scrollTo(0, 0);
  // Clients déjà lus : affichés tout de suite, relus en fond s'ils datent de plus d'une minute.
  if ((page === 'clients' || page === 'client') && connecte && (!clients || Date.now() - clientsLus > 60_000)) chargerClients();
  afficherFiche();
}

// Page tablette : relevés en direct (déclarés ici, afficherFiche les coupe dès le premier affichage).
let stopReleves = null;
let stopOrdre = null;
let membreTablette = null; // dernière fiche de membre lue (version, batterie, SIM, en ligne)
let familleTablette = null; // volumes de la famille

// Fiche ouverte dans l'adresse (#tablette/id ou #commande/id), redessinée à chaque nouvelle lecture des données.
function afficherFiche() {
  const [page, id, sous] = location.hash.slice(1).split('/');
  if (page !== 'tablette' && stopReleves) { stopReleves(); stopReleves = null; $('dt-agir').dataset.id = ''; }
  if (!donnees || !id) return;
  if (page === 'clients' && id === 'familles' && sous) remplirLiensFamille(decodeURIComponent(sous));
  if (page === 'tablette') remplirTablette(decodeURIComponent(id));
  if (page === 'commande') remplirCommande(decodeURIComponent(id));
  if (page === 'client') remplirClient(decodeURIComponent(id));
  if (page === 'depense') remplirPageDepense(decodeURIComponent(id));
  if (page === 'sim') remplirPageSim(decodeURIComponent(id));
  if (page === 'accessoire') remplirPageAccessoire(decodeURIComponent(id));
  if (page === 'nouveau') remplirNouveau(id);
}
window.addEventListener('hashchange', afficherPage);

// Téléphone : menu ☰ qui se déplie sous la barre du haut, refermé dès qu'on choisit une page.
function ouvrirMenu(ouvert) {
  document.querySelector('.nav').classList.toggle('ouvert', ouvert);
  $('nav-menu').setAttribute('aria-expanded', String(ouvert));
}
$('nav-menu').addEventListener('click', () => ouvrirMenu(!document.querySelector('.nav').classList.contains('ouvert')));
window.addEventListener('hashchange', () => ouvrirMenu(false));
document.addEventListener('click', (e) => { if (!e.target.closest('.nav')) ouvrirMenu(false); });
afficherPage();

// ---------- Chargement ----------

// L'écran d'ouverture s'efface en fondu dès les premières données (ou sans connexion).
function fermerChargement() {
  const e = $('chargement');
  if (e.hidden || e.classList.contains('parti')) return;
  e.classList.add('parti');
  setTimeout(() => { e.hidden = true; }, 300);
}

onAuthStateChanged(getAuth(getApp('admin')), (user) => {
  connecte = !!user;
  if (!user) { fermerChargement(); return; }
  reveiller();
  // Lus dès la connexion, pour que la page Clients s'ouvre sans attendre.
  chargerClients();
  chargerDonnees();
  chargerMois();
  changerPeriode();
});

document.addEventListener('papote:maj', () => {
  chargerDonnees();
  chargerMois();
  changerPeriode();
});

async function chargerDonnees() {
  try {
    donnees = await lireDonnees();
    $('erreur').hidden = true;
    preparerFormulaires();
    afficherTout();
  } catch (e) {
    erreur(e);
  }
  // Premier chargement terminé (ou en erreur) : l'indicateur d'ouverture disparaît.
  fermerChargement();
}

async function chargerMois() {
  const n = new Date();
  try {
    stripeAnnee = await lireStripeAnnee(true);
    const debutMois = new Date(n.getFullYear(), n.getMonth(), 1).getTime();
    stripeMois = { ...stripeAnnee, mouvements: stripeAnnee.mouvements.filter((m) => m.le >= debutMois) };
    afficherAccueil();
    // Les années précédentes ne sont lues qu'à partir de 2027 : avant, l'année en cours est le total.
    stripeTotal = n.getFullYear() > new Date(DEBUT_PAPOTE).getFullYear()
      ? await appeler('gestionStripe', { debut: DEBUT_PAPOTE, fin: new Date(n.getFullYear() + 1, 0, 1).getTime() }) : stripeAnnee;
    afficherAccueil();
  } catch (e) {
    console.warn('Stripe (mois en cours)', e);
  }
}

function afficherTout() {
  if (donnees) {
    afficherAccueil();
    afficherStock();
    afficherSim();
    afficherAccessoires();
    afficherCommandes();
    afficherExpediteur();
    afficherReglagesCalculs();
    afficherAchats();
    afficherFiche();
  }
  if (donnees && stripe) {
    afficherBilan();
    afficherFactures();
    afficherCompta();
    afficherGraphiques();
    afficherUrssaf();
    afficherRentabilite();
  }
}

// ---------- Période ----------

function calculerPeriode() {
  const n = new Date();
  const a = n.getFullYear();
  const m = n.getMonth();
  switch ($('p-choix').value) {
    case 'mois': return { debut: new Date(a, m, 1), fin: new Date(a, m + 1, 1) };
    case 'mois-1': return { debut: new Date(a, m - 1, 1), fin: new Date(a, m, 1) };
    case 'trimestre': {
      const t = Math.floor(m / 3) * 3;
      return { debut: new Date(a, t, 1), fin: new Date(a, t + 3, 1) };
    }
    case 'annee-1': return { debut: new Date(a - 1, 0, 1), fin: new Date(a, 0, 1) };
    case 'perso': {
      const du = $('p-du').value;
      const au = $('p-au').value;
      if (!du || !au) return null;
      const [y1, m1, d1] = du.split('-').map(Number);
      const [y2, m2, d2] = au.split('-').map(Number);
      return { debut: new Date(y1, m1 - 1, d1), fin: new Date(y2, m2 - 1, d2 + 1) };
    }
    default: return { debut: new Date(a, 0, 1), fin: new Date(a + 1, 0, 1) };
  }
}

function etiquettePeriode() {
  if (!periode) return '';
  const iso = (ms) => new Date(ms).toLocaleDateString('sv-SE');
  return `${iso(periode.debut)}_${iso(periode.fin - 1)}`;
}

const dans = (p, ms) => ms != null && ms >= p.debut && ms < p.fin;
const dansPeriode = (ms) => dans(periode, ms);

// Stripe est lu une seule fois pour l'année en cours, partagé par l'accueil et le bilan : une période qui tient dans
// l'année (ce mois-ci, ce trimestre, cette année…) en est tirée sans nouvel appel, avec le même filtre par date
// que le serveur. Avant, l'ouverture et chaque modification relisaient deux fois la même année dans Stripe.
let anneeStripe = null;
function bornesAnnee() {
  const a = new Date().getFullYear();
  return { debut: new Date(a, 0, 1).getTime(), fin: new Date(a + 1, 0, 1).getTime() };
}
function lireStripeAnnee(relire = false) {
  const b = bornesAnnee();
  if (relire || !anneeStripe || anneeStripe.debut !== b.debut) {
    const promesse = appeler('gestionStripe', b);
    anneeStripe = { debut: b.debut, promesse };
    promesse.catch(() => { if (anneeStripe && anneeStripe.promesse === promesse) anneeStripe = null; });
  }
  return anneeStripe.promesse;
}
function lireStripe(p) {
  const b = bornesAnnee();
  if (p.debut < b.debut || p.fin > b.fin) return appeler('gestionStripe', p);
  return lireStripeAnnee().then((a) => ({
    ...a,
    factures: a.factures.filter((f) => dans(p, f.le)),
    mouvements: a.mouvements.filter((m) => dans(p, m.le)),
  }));
}

let demande = 0;
async function changerPeriode() {
  const perso = $('p-choix').value === 'perso';
  $('p-du-l').hidden = !perso;
  $('p-au-l').hidden = !perso;
  const p = calculerPeriode();
  if (!p || p.fin <= p.debut) {
    $('p-etat').textContent = 'Choisissez les deux dates.';
    return;
  }
  periode = { debut: p.debut.getTime(), fin: p.fin.getTime() };
  $('bilan-titre').textContent = `Bilan Papote du ${jour(periode.debut)} au ${jour(periode.fin - 1)}`;
  $('p-etat').textContent = 'Lecture de Stripe…';
  const n = ++demande;
  try {
    const r = await lireStripe(periode);
    if (n !== demande) return;
    stripe = r;
    $('p-etat').textContent = `Du ${jour(periode.debut)} au ${jour(periode.fin - 1)}`;
    afficherTout();
  } catch (e) {
    if (n === demande) {
      $('p-etat').textContent = '';
      erreur(e);
    }
  }
}
$('p-choix').addEventListener('change', changerPeriode);
$('p-du').addEventListener('change', changerPeriode);
$('p-au').addEventListener('change', changerPeriode);

// ---------- Calculs ----------

const ENCAISSEMENTS = ['abonnement', 'tablette-non-rendue'];

function totaux(mouvements, depenses) {
  const t = { encaisse: 0, rembourse: 0, frais: 0, depenses: 0 };
  for (const m of mouvements) {
    if (ENCAISSEMENTS.includes(m.nature)) t.encaisse += m.montant;
    else if (m.nature === 'remboursement' || m.nature === 'litige') t.rembourse += -m.montant;
    if (m.nature !== 'virement') t.frais += m.frais;
    if (m.nature === 'frais') t.frais += -m.montant;
  }
  for (const d of depenses) t.depenses += d.montant;
  t.net = t.encaisse - t.rembourse - t.frais;
  t.resultat = t.net - t.depenses;
  return t;
}

const depensesDe = (p) => donnees.depenses.filter((d) => dans(p, d.date)).sort((a, b) => a.date - b.date);
const depensesPeriode = () => depensesDe(periode);
const recettes = () => stripe.mouvements.filter((m) => ENCAISSEMENTS.includes(m.nature) || m.nature === 'remboursement' || m.nature === 'litige');

function moisDeLaPeriode() {
  const cles = [];
  const d = new Date(periode.debut);
  d.setDate(1);
  // Pas de mois à venir dans le bilan.
  const fin = Math.min(periode.fin, Date.now());
  while (d.getTime() < fin) {
    cles.push(moisCle(d.getTime()));
    d.setMonth(d.getMonth() + 1);
  }
  return cles;
}

function bilanMensuel() {
  const deps = depensesPeriode();
  return moisDeLaPeriode().map((cle) => ({
    cle,
    ...totaux(stripe.mouvements.filter((m) => moisCle(m.le) === cle), deps.filter((d) => moisCle(d.date) === cle)),
  }));
}

// État d'une commande pour le suivi.
function etatCommande(c) {
  if (c.expedition === 'annulee') return 'annulee';
  const r = c.restitution && c.restitution.statut;
  if (r === 'attendue' || r === 'echec') return 'retour';
  // Commande offerte d'une famille supprimée : finie dès que sa tablette n'est plus chez le proche.
  if (r === 'a-recuperer') {
    const t = donnees && donnees.stock.find((x) => x.commande === c.id);
    return t && !['envoyee', 'chez-client', 'en-retour'].includes(t.etat) ? 'terminee' : 'retour';
  }
  if (r === 'rendue' || r === 'facturee' || ['resilie', 'canceled'].includes(c.abonnement)) return 'terminee';
  if (c.expedition === 'a-preparer') return 'a-envoyer';
  // Prélèvement SEPA pas encore confirmé par la banque : ne pas envoyer.
  if (c.expedition === 'paiement-en-attente') return 'paiement';
  if (c.expedition === 'envoyee' && !c.fid) return 'en-route';
  // Résiliation demandée (par le client ou depuis l'admin) : encore en service jusqu'à la date d'arrêt.
  if (c.resiliationLe) return 'arret';
  return 'active';
}
const ETATS_COMMANDE = {
  'a-envoyer': ['À envoyer', 'info'],
  paiement: ['Paiement en attente (SEPA), ne pas envoyer', ''],
  'en-route': ['En route', 'info'],
  active: ['En service', 'ok'],
  arret: ['Arrêt prévu', 'info'],
  retour: ['Tablette à récupérer', 'ko'],
  terminee: ['Terminée', ''],
  annulee: ['Annulée', ''],
};
const ABONNEMENTS = {
  offert: 'offert', actif: 'actif', impaye: 'impayé', suspendu: 'suspendu', resilie: 'résilié', aucun: 'sans abonnement', installation: 'installation en cours',
  canceled: 'résilié', active: 'actif', trialing: 'premier mois', past_due: 'impayé',
};
const RETOURS = {
  attendue: 'Retour attendu', 'a-recuperer': 'Matériel offert encore à récupérer', echec: 'Non rendue, prélèvement refusé', rendue: 'Tablette rendue', facturee: 'Matériel non rendu, prélevé',
};
const REMBOURSEMENTS = {
  'en-cours': 'en cours de remboursement', 'au-retour': 'remboursés au retour', fait: 'remboursés', echec: 'à rembourser depuis Stripe',
};
// Offre unique depuis le 29/10/2026 : « wifi » ne reste que pour les anciennes commandes de test.
const FORMULES = { sim: 'Tout compris', wifi: 'Wi-Fi (ancienne formule)' };
const formuleTexte = (c) => [FORMULES[c.formule] || c.formule, c.tablette === 'achetee' ? 'tablette achetée' : null,
  c.offerte ? 'offerte' : null]
  .filter(Boolean).join(', ');
const nomCommande = (c) => [codeCommande(c.code), c.nom || c.email].filter(Boolean).join(' · ') || c.id;

// État affiché d'une tablette : « Envoyée » devient « Chez le client » dès que la famille est jumelée.
function etatTablette(t) {
  const c = t.commande && donnees.commandes.find((x) => x.id === t.commande);
  if (t.etat === 'envoyee' && c && c.fid) return 'chez-client';
  return t.etat;
}
const ETATS_OK = ['chez-client'];
const ETATS_KO = ['perdue', 'hors-service', 'a-reparer', 'revenue'];
const classeEtat = (e) => (ETATS_OK.includes(e) ? 'ok' : ETATS_KO.includes(e) ? 'ko' : e === 'en-stock' ? 'info' : '');

// Pièces d'une tablette : les siennes et celles de son achat.
function piecesTablette(t) {
  const achat = t.depense && donnees.depenses.find((d) => d.id === t.depense);
  return [...(t.pieces || []), ...((achat && achat.pieces) || [])];
}

const DISPONIBLES = ['en-stock', 'preparee'];
// Alerte notée au jumelage, sauf « sans commande » quand la tablette a été rattachée depuis.
const alerteJumelage = (t) => (t.alerteJumelage === 'jumelée sans commande' && t.commande ? null : t.alerteJumelage || null);
// Tablettes du stock qui peuvent partir : libres, ou déjà réservées à une commande pas encore envoyée.
function tablettesPretes() {
  const aEnvoyer = new Set(donnees.commandes.filter((c) => etatCommande(c) === 'a-envoyer').map((c) => c.id));
  return donnees.stock.filter((t) => DISPONIBLES.includes(t.etat) && (!t.commande || aEnvoyer.has(t.commande)));
}

// ---------- Accueil ----------

function afficherAccueil() {
  if (!donnees) return;
  const cmd = donnees.commandes;
  const aEnvoyer = cmd.filter((c) => etatCommande(c) === 'a-envoyer').length;
  const aRecuperer = cmd.filter((c) => etatCommande(c) === 'retour').length;
  const sansJumelage = cmd.filter((c) => etatCommande(c) === 'en-route' && c.envoyeeLe && Date.now() - c.envoyeeLe > 20 * 864e5).length;
  const aRembourser = cmd.filter((c) => c.remboursement && c.remboursement.statut === 'echec').length;
  const dispo = tablettesPretes().length;
  const manque = Math.max(0, aEnvoyer - dispo);
  const aVerifier = donnees.stock.filter((t) => t.etat === 'revenue').length;
  const impayees = stripeMois ? stripeMois.abonnements.filter((a) => a.statut === 'past_due').length : 0;
  const familleImpayees = donnees.familles.filter((f) => f.statut === 'impaye');
  const problemes = donnees.automatique ? (donnees.automatique.erreurs || []).length : 0;
  const simsAResilier = lignesSim().filter((l) => l.aResilier).length;
  const simsARegarder = donnees.sims.filter((l) => alertesSim(l).length).length;
  const remplacees = donnees.stock.filter((t) => t.etat === 'en-retour' && t.remplaceePour).length;
  const parCommande = new Map(donnees.stock.filter((t) => t.commande).map((t) => [t.commande, t]));
  const clientsSansSim = cmd.filter((c) => c.expedition !== 'annulee' && c.formule === 'sim' && parCommande.get(c.id)
    && ['envoyee', 'chez-client', 'en-retour'].includes(parCommande.get(c.id).etat) && !parCommande.get(c.id).sim).length;
  const simsSansTablette = donnees.sims.filter((l) => l.statut === 'active' && !l.tablette).length;
  const accessoires = accessoiresAPrevoir().filter((a) => a.manque || a.bas);
  // Achats enregistrés depuis la confirmation de commande : facture à télécharger chez le vendeur (après 5 jours).
  const jumelagesAVoir = donnees.stock.filter(alerteJumelage);
  // Même règle que aFaire (functions/gestion.js) : batterie usée, la tablette revenue ne repart pas.
  const usees = donnees.stock.filter((t) => t.etat === 'revenue' && t.usure);
  const facturesAttendues = donnees.depenses.filter((d) => d.confirmation && Date.now() - (d.date || 0) > 5 * 864e5);
  const aVerifierMail = donnees.depenses.filter((d) => d.aVerifier);
  // Même règle que sansFacture (functions/gestion.js).
  const sansFactureListe = donnees.stock.filter((t) => t.prixAchat == null && !t.acheteeLe && !t.depense
    && !['perdue', 'hors-service'].includes(t.etat) && (t.creeLe || t.preparee || Date.now()) < Date.now() - 5 * 864e5);
  // Tablette installée alors que son achat attend sur une autre fiche : une seule ligne, sur la tablette, au lieu de
  // « reçue sans facture » + « facture à télécharger » pour la même tablette (Tanguy, 2026-10-27).
  const aRelier = sansFactureListe.filter((t) => fichesAchetees(t).length);
  const achatsARelier = new Set(aRelier.flatMap((t) => fichesAchetees(t).map((x) => x.depense)).filter(Boolean));
  const sansFacture = sansFactureListe.length - aRelier.length;
  const simsSansAchat = donnees.sims.filter((l) => !l.depense && l.statut !== 'resiliee').length;
  const accessoiresSansAchat = donnees.accessoires.filter((x) => !(x.depenses || []).length && (x.quantite || 0) > 0).length;
  const erreursMail = donnees.courrier ? (donnees.courrier.erreurs || []).length : 0;
  const tva = franchiseTva();

  // Liens précis : une ligne par tablette ou commande concernée, qui ouvre sa page.
  const tabletteDe = (c) => donnees.stock.find((t) => t.commande === c.id);
  const nomT = (t) => `Tablette ${t.ref || t.numero || t.modele || ''}`.trim();
  const versTablette = (t) => `#tablette/${encodeURIComponent(t.id)}`;
  const versFamille = (f) => {
    const c = cmd.find((x) => x.fid === f.id && x.expedition !== 'annulee');
    return c ? versCommande(c) : `#clients/familles/${encodeURIComponent(f.id)}`;
  };
  const versCommande = (c) => `#commande/${encodeURIComponent(c.id)}`;
  let taches = [
    // Client qui recommande (même IBAN, e-mail, téléphone ou adresse), avant l'envoi : gros signal s'il a déjà mal payé.
    ...cmd.filter((c) => c.alerteDoublon && ['a-preparer', 'paiement-en-attente'].includes(c.expedition))
      .map((c) => (c.alerteDoublon.mauvaisPayeur
        ? [1, `⚠ Ne pas envoyer avant vérification : ${c.nom || c.email || 'client'} a déjà été mauvais payeur (${c.alerteDoublon.raisons.join(', ')})`, versCommande(c), 'ko']
        : [1, `2e commande du même client : ${c.nom || c.email || 'client'}, vérifier avant d'envoyer`, versCommande(c), ''])),
    // Une seule : la ligne ouvre directement la commande.
    [aEnvoyer, pluriel(aEnvoyer, 'tablette') + ' à envoyer', aEnvoyer === 1 ? versCommande(cmd.find((c) => etatCommande(c) === 'a-envoyer')) : '#commandes', manque ? 'ko' : ''],
    [manque, `Il manque ${pluriel(manque, 'tablette')} en stock pour les envoyer`, '#stock', 'ko'],
    ...cmd.filter((c) => etatCommande(c) === 'en-route' && c.envoyeeLe && Date.now() - c.envoyeeLe > 20 * 864e5)
      .map((c) => [1, `Tablette pas jumelée après 20 jours : ${c.nom || c.email || 'client'}, l'appeler`, versCommande(c), 'ko']),
    ...cmd.filter((c) => etatCommande(c) === 'retour' && c.restitution.statut !== 'echec').map((c) => {
      const t = tabletteDe(c);
      return [1, `${t ? nomT(t) : 'Tablette'} à récupérer chez ${c.nom || c.email || 'le client'}`, t ? versTablette(t) : versCommande(c), ''];
    }),
    ...donnees.stock.filter((t) => t.etat === 'revenue' && !t.usure)
      .map((t) => [1, `${nomT(t)} revenue, à vérifier avant de remettre en stock`, versTablette(t), '']),
    ...cmd.filter((c) => c.remboursement && c.remboursement.statut === 'echec')
      .map((c) => [1, `Remboursement échoué : ${c.nom || c.email || 'un client'}, à faire depuis Stripe`, versCommande(c), 'ko']),
    // Une ligne par famille impayée ou en pause, qui ouvre sa page (Stripe en secours si la famille manque).
    // Mêmes textes que aFaire (functions/gestion.js) ; chaque ligne ouvre la commande de la famille, sinon la famille.
    ...(familleImpayees.length ? familleImpayees.map((f) => [1, `Famille ${f.nom || 'sans nom'} en retard de paiement${f.graceJusqua ? ` (pause le ${jour(f.graceJusqua)})` : ''}`, versFamille(f), 'ko'])
      : [[impayees, `${pluriel(impayees, 'abonnement')} impayé${impayees > 1 ? 's' : ''}`, '#compta/factures', 'ko']]),
    ...donnees.familles.filter((f) => f.statut === 'suspendu').map((f) => {
      const depuis = f.suspenduLe || f.majLe;
      const jours = depuis ? Math.floor((Date.now() - depuis) / 864e5) : null;
      return [1, `Famille ${f.nom || 'sans nom'} suspendue pour impayé${jours != null ? ` depuis ${pluriel(jours, 'jour')}` : ''}${jours >= 30
        ? ' : demander le retour de la tablette (« Arrêter l\'abonnement » sur la commande)' : ''}`, versFamille(f), 'ko'];
    }),
    // Colis jamais retiré au relais, revenu à l'expéditeur d'après Sendcloud (A3).
    ...cmd.filter((c) => etatCommande(c) === 'en-route' && c.etiquettes && c.etiquettes.aller && c.etiquettes.aller.retourExpediteur)
      .map((c) => [1, `Colis de ${c.nom || c.email || 'un client'} en retour chez vous (jamais retiré) : « Colis revenu » dans le ⋮ de la commande l'annule et rembourse`, versCommande(c), 'ko']),
    ...cmd.filter((c) => c.expedition === 'paiement-en-attente' && c.creeLe && Date.now() - c.creeLe > 10 * 864e5)
      .map((c) => [1, `Paiement SEPA en attente depuis plus de 10 jours : ${c.nom || c.email || 'client'}, regarder dans Stripe`, versCommande(c), 'ko']),
    ...cmd.filter((c) => c.dernierMois && c.dernierMois.statut === 'echec')
      .map((c) => [1, `Dernier mois refusé par la banque : ${c.nom || c.email || 'client'}, le contacter`, versCommande(c), 'ko']),
    ...cmd.filter((c) => c.restitution && c.restitution.statut === 'echec')
      .map((c) => [1, `Prélèvement du matériel refusé : ${c.nom || c.email || 'client'}, le contacter`, versCommande(c), 'ko']),
    ...cmd.filter((c) => (c.contestations || []).some((x) => Date.now() - x.le < 60 * 864e5))
      .map((c) => [1, `Prélèvement contesté à la banque : ${c.nom || c.email || 'client'}, voir le litige dans Stripe`, versCommande(c), 'ko']),
    [simsAResilier, `${pluriel(simsAResilier, 'forfait SIM')} payé${simsAResilier > 1 ? 's' : ''} depuis 30 jours pour une tablette sans client : à résilier ou suspendre`, '#stock/sim', 'ko'],
    ...donnees.stock.filter((t) => t.etat === 'en-retour' && t.remplaceePour)
      .map((t) => [1, `${nomT(t)} remplacée, à récupérer chez le client`, versTablette(t), '']),
    [clientsSansSim, `${clientsSansSim} client${clientsSansSim > 1 ? 's' : ''} sans carte SIM notée sur sa tablette`, '#stock/sim', 'ko'],
    [simsSansTablette, `${simsSansTablette} ligne${simsSansTablette > 1 ? 's SIM actives reliées' : ' SIM active reliée'} à aucune tablette`, '#stock/sim', 'ko'],
    [simsARegarder, `${simsARegarder} carte${simsARegarder > 1 ? 's' : ''} SIM à regarder (promo, activation, carte bancaire)`, '#stock/sim', 'ko'],
    ...accessoires.map((a) => [1, a.manque ? `${a.nom} : il en manque ${a.manque} pour les envois` : `${a.nom} : stock bas (${a.quantite || 0})`, '#stock/accessoires', a.manque ? 'ko' : '']),
    ...jumelagesAVoir.map((t) => [1, `${nomT(t)} ${alerteJumelage(t)}`, versTablette(t), 'ko']),
    ...usees.map((t) => [1, `${nomT(t)} revenue : ${t.usure}, à retirer du parc`, versTablette(t), 'ko']),
    // Une ligne par achat, qui ouvre la page de cet achat.
    ...aRelier.map((t) => {
      const achats = fichesAchetees(t);
      const de = [...new Set(achats.map((x) => x.fournisseur).filter(Boolean))].join(' ou ');
      return [1, `${nomT(t)} n'est reliée à aucun achat : sur sa fiche, ligne « Achat », choisir la tablette achetée${de ? ` chez ${de}` : ''}`, versTablette(t), 'ko'];
    }),
    ...facturesAttendues.filter((d) => !achatsARelier.has(d.id)).map((d) => [1, `Facture ${d.fournisseur || 'du vendeur'} à télécharger : ${d.libelle || 'achat'}${d.numero ? `, commande ${d.numero}` : ''}. La télécharger chez le vendeur puis l'envoyer à factures@`,
      `#depense/${encodeURIComponent(d.id)}`, 'ko']),
    // Chaque carte SIM et chaque accessoire doit avoir son achat (Tanguy, 2026-10-22).
    [simsSansAchat, `${pluriel(simsSansAchat, 'carte SIM')} sans achat lié : ouvrir la carte et choisir son achat`, '#stock/sim', ''],
    [accessoiresSansAchat, `${pluriel(accessoiresSansAchat, 'accessoire')} sans achat lié : ouvrir l'accessoire et ajouter son achat`, '#stock/accessoires', ''],
    [sansFacture, `${pluriel(sansFacture, 'tablette')} reçue${sansFacture > 1 ? 's' : ''} sans facture depuis 5 jours : transférez la facture du vendeur à factures@mapapote.fr`, '#stock', 'ko'],
    ...aVerifierMail.map((d) => [1, `Facture ${d.fournisseur || ''} à vérifier : ${[d.libelle, euros(d.montant)].filter(Boolean).join(', ')}, reçue par e-mail`.replace('  ', ' '),
      `#depense/${encodeURIComponent(d.id)}`, '']),
    [erreursMail, `${pluriel(erreursMail, 'problème')} au dernier relevé de factures@mapapote.fr (détail en bas de page)`, '#accueil', 'ko'],
    [tva && tva.alerte ? 1 : 0, tva ? tva.alerte : '', '#compta/urssaf', 'ko'],
    [problemes, `${pluriel(problemes, 'problème')} lors du dernier passage automatique`, '#outils/automatique', 'ko'],
  ].filter(([n]) => n > 0);
  // Lignes masquées 7 jours par l'admin (gestionReglages, masquer) : elles reviennent seules si rien n'est réglé.
  const cleTache = ([, texte, lien]) => `${lien}|${texte}`;
  const masquees = new Set(((donnees.reglages && donnees.reglages.masquees) || []).filter((m) => m.jusqua > Date.now()).map((m) => m.cle));
  const nMasquees = taches.filter((t) => masquees.has(cleTache(t))).length;
  const masquer = async (cle, jours) => {
    try {
      const r = await patienter(jours ? 'Ligne masquée pour 7 jours…' : 'Lignes réaffichées…',
        () => appeler('gestionReglages', { masquer: jours ? { cle, jours } : { tout: true, jours: 0 } }));
      donnees.reglages.masquees = r.masquees || [];
      afficherAccueil();
      annoncer(jours ? 'Masquée 7 jours' : 'Tout est réaffiché');
    } catch (e) {
      prevenir(messageErreur(e));
    }
  };
  taches = taches.filter((t) => !masquees.has(cleTache(t)));
  // Rangé par sujet ; chaque ligne : un titre court, le détail en dessous, une pastille si c'est urgent.
  const groupe = (lien) => (/^#(commande|client)/.test(lien) ? 'Commandes et clients'
    : /^#(tablette|stock|sim)/.test(lien) ? 'Stock' : /^#(depense|compta)/.test(lien) ? 'Comptabilité' : 'Fonctionnement');
  const groupes = new Map(['Commandes et clients', 'Stock', 'Comptabilité', 'Fonctionnement'].map((g) => [g, []]));
  for (const tache of taches) {
    const [, texte, lien, classe] = tache;
    const i = texte.indexOf(' : ');
    const [titre, detail] = i > 0 ? [texte.slice(0, i), texte.slice(i + 3)] : [texte, null];
    groupes.get(groupe(lien)).push(h('li', { class: 'ligne-tache' }, h('a', { href: lien, class: classe === 'ko' ? 'urgent' : '' },
      h('span', { class: 'pastille-tache', 'aria-hidden': 'true' }),
      h('span', { class: 'tache' }, h('span', { class: 'tache-titre' }, titre.charAt(0).toUpperCase() + titre.slice(1)),
        detail ? h('span', { class: 'tache-detail' }, detail.charAt(0).toUpperCase() + detail.slice(1)) : null),
      h('span', { class: 'fleche', 'aria-hidden': 'true' }, '›')),
    menuPoints([{ libelle: 'Masquer 7 jours', faire: () => masquer(cleTache(tache), 7) }], 'Actions pour cette ligne')));
  }
  $('a-faire').replaceChildren(...(taches.length
    ? [...groupes].filter(([, l]) => l.length).map(([g, l]) => h('li', { class: 'groupe-taches' }, h('h3', {}, g), h('ul', {}, l)))
    : [h('li', { class: 'muted' }, 'Rien à faire pour le moment.')]),
  ...(nMasquees ? [h('li', { class: 'muted small masquees' }, `${pluriel(nMasquees, 'ligne')} masquée${nMasquees > 1 ? 's' : ''} pour 7 jours · `,
    h('button', { type: 'button', class: 'link', onclick: () => masquer(null, 0) }, 'Tout réafficher'))] : []));

  const pastille = (id, n) => {
    $(id).hidden = !n;
    $(id).textContent = n || '';
  };
  pastille('n-accueil', taches.length);
  pastille('n-menu', taches.length);
  pastille('n-commandes', aEnvoyer + aRecuperer);
  pastille('n-stock', manque + aVerifier + simsAResilier + simsARegarder + accessoires.length + remplacees + clientsSansSim + simsSansTablette);
  blocAlertes($('alertes-accueil'), donnees.alertes || [], { titre: 'Alertes envoyées aux familles', avecTablette: true });
  afficherAutomatique();
  afficherCourrier();
  afficherArchives();
  afficherTva(tva);

  if (stripeMois) {
    const n = new Date();
    const mois = { debut: new Date(n.getFullYear(), n.getMonth(), 1).getTime(), fin: new Date(n.getFullYear(), n.getMonth() + 1, 1).getTime() };
    const t = totaux(stripeMois.mouvements, depensesDe(mois));
    const tTotal = stripeTotal ? totaux(stripeTotal.mouvements, donnees.depenses) : null;
    // Abonnés : d'après l'état des familles écrit par le serveur (les offertes à part).
    const payants = donnees.familles.filter((f) => ['actif', 'impaye', 'suspendu'].includes(f.statut)).length;
    const offerts = donnees.familles.filter((f) => f.statut === 'offert').length;
    // Chaque chiffre du mois ouvre sa page, réglée sur « Ce mois-ci ».
    const argent = (onglet) => () => {
      if ($('p-choix').value !== 'mois') { $('p-choix').value = 'mois'; changerPeriode(); }
      location.hash = `#compta/${onglet}`;
    };
    // Bilan sur toute la vie de Papote (période « Autre » depuis le début).
    const depuisLeDebut = () => {
      $('p-choix').value = 'perso';
      $('p-du').value = new Date(DEBUT_PAPOTE).toLocaleDateString('sv-SE');
      $('p-au').value = n.toLocaleDateString('sv-SE');
      changerPeriode();
      location.hash = '#compta/bilan';
    };
    $('kpi-mois').replaceChildren(
      cliquable(stat(String(payants), payants > 1 ? 'abonnés' : 'abonné', offerts ? `+ ${offerts} offert${offerts > 1 ? 's' : ''}` : null), () => { location.hash = '#clients/familles'; }),
      cliquable(stat(String(cmd.filter((c) => dans(mois, c.creeLe)).length), 'nouvelles commandes ce mois'), () => {
        vueCommandes = 'toutes';
        $('filtre-commandes').value = '';
        location.hash = '#commandes';
        afficherCommandes();
      }),
      cliquable(stat(euros(t.resultat), 'résultat ce mois', `${euros(t.encaisse)} encaissés, ${euros(t.depenses)} dépensés`, t.resultat < 0 ? 'neg' : null), argent('bilan')),
      tTotal ? cliquable(stat(euros(tTotal.resultat), 'résultat total', 'depuis le début de Papote', tTotal.resultat < 0 ? 'neg' : null), depuisLeDebut) : null,
    );
  }
}

// ---------- Commandes ----------

let vueCommandes = null; // liste affichée dans Commandes (a-envoyer, en-route, retour, toutes)

function afficherCommandes() {
  const toutes = donnees.commandes.slice().sort((a, b) => (b.creeLe || 0) - (a.creeLe || 0));
  const parEtat = {};
  for (const c of toutes) parEtat[etatCommande(c)] = (parEtat[etatCommande(c)] || 0) + 1;
  // Les chiffres servent d'onglets : chaque statut montre sa liste, « au total » et « en service » le tableau.
  if (!vueCommandes) vueCommandes = parEtat['a-envoyer'] ? 'a-envoyer' : parEtat.retour ? 'retour' : parEtat['en-route'] ? 'en-route' : 'toutes';
  const onglet = (vue, valeur, texte, classe, filtre = '') => {
    const el = stat(String(valeur), texte, null, classe);
    const actif = vue === vueCommandes && (vue !== 'toutes' || $('filtre-commandes').value === filtre);
    el.classList.add('onglet');
    el.classList.toggle('actif', actif);
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-pressed', String(actif));
    const choisir = () => {
      vueCommandes = vue;
      if (vue === 'toutes') $('filtre-commandes').value = filtre;
      afficherCommandes();
    };
    el.addEventListener('click', choisir);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choisir(); } });
    return el;
  };
  $('kpi-commandes').replaceChildren(...[
    onglet('a-envoyer', parEtat['a-envoyer'] || 0, 'à envoyer'),
    parEtat.paiement ? onglet('toutes', parEtat.paiement, 'paiement en attente', null, 'paiement') : null,
    onglet('en-route', parEtat['en-route'] || 0, 'en route'),
    onglet('retour', parEtat.retour || 0, 'à récupérer', parEtat.retour ? 'neg' : null),
    onglet('toutes', parEtat.active || 0, 'en service', null, 'active'),
    onglet('toutes', toutes.length, 'commandes au total'),
  ].filter(Boolean));
  document.querySelectorAll('[data-panneau="commandes"] [data-vue]').forEach((c) => { c.hidden = c.dataset.vue !== vueCommandes; });
  const filtre = $('filtre-commandes').value;
  const tablettes = new Map(donnees.stock.filter((t) => t.commande).map((t) => [t.commande, t]));
  remplirTable($('t-commandes'), [
    { titre: 'Date' }, { titre: 'Code' }, { titre: 'Client' }, { titre: 'Formule' }, { titre: 'État' },
    { titre: 'Famille' }, { titre: 'Tablette' },
  ], toutes.filter((c) => !filtre || etatCommande(c) === filtre).map((c) => {
    const [texte, classe] = ETATS_COMMANDE[etatCommande(c)];
    const t = tablettes.get(c.id);
    return {
      onclick: () => ouvrirCommande(c),
      cellules: [
        jour(c.creeLe),
        codeCommande(c.code),
        h('div', {}, c.nom || c.email || '', c.nom ? h('div', { class: 'muted' }, c.email || '') : null),
        formuleTexte(c),
        badge(texte, classe),
        c.famille ? `${c.famille}${c.abonnement ? ` (${ABONNEMENTS[c.abonnement] || c.abonnement})` : ''}` : '',
        t ? t.numero || t.modele || 'affectée' : '',
      ],
    };
  }), { vide: 'Aucune commande.' });
}
$('filtre-commandes').addEventListener('change', afficherCommandes);

// Commande offerte (les mamies) : sans paiement, avec sa famille et sa tablette.
function preparerOfferte() {
  const f = $('f-offerte');
  f.reset();
  f.fid.replaceChildren(h('option', { value: '' }, 'Pas encore de famille'),
    ...donnees.familles.filter((x) => !['actif', 'impaye', 'suspendu'].includes(x.statut))
      .filter((x) => !donnees.commandes.some((c) => c.fid === x.id && c.expedition !== 'annulee'))
      .map((x) => h('option', { value: x.id }, x.nom || x.id)));
  f.tablette.replaceChildren(h('option', { value: '' }, 'Plus tard'),
    ...donnees.stock.filter((t) => !t.commande && !['perdue', 'hors-service'].includes(t.etat))
      .map((t) => h('option', { value: t.id }, [t.ref, t.numero, t.modele].filter(Boolean).join(' · '))));
  f.querySelector('.f-msg').hidden = true;
}
$('b-offerte').addEventListener('click', () => {
  preparerOfferte();
  allerNouveau('offerte');
});

$('f-offerte').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  await enregistrer(f, async () => {
    await appeler('gestionCommandeOfferte', {
      nom: f.nom.value, email: f.email.value, telephone: f.telephone.value, formule: f.formule.value,
      fid: f.fid.value || null, tablette: f.tablette.value || null, dejaInstallee: f.installee.checked,
    });
    fermerNouveau();
  });
});

$('x-commandes').addEventListener('click', () => {
  const tablettes = new Map(donnees.stock.filter((t) => t.commande).map((t) => [t.commande, t]));
  csv('commandes', ['Date', 'Code', 'Nom', 'E-mail', 'Téléphone', 'Formule', 'État', 'N° de suivi', 'Envoyée le',
    'Famille', 'Abonnement', 'Tablette', 'Retour', 'Remboursement'],
  donnees.commandes.slice().sort((a, b) => (a.creeLe || 0) - (b.creeLe || 0)).map((c) => {
    const t = tablettes.get(c.id);
    return [jour(c.creeLe), codeCommande(c.code), c.nom, c.email, c.telephone, formuleTexte(c),
      ETATS_COMMANDE[etatCommande(c)][0], c.suivi, jour(c.envoyeeLe), c.famille, ABONNEMENTS[c.abonnement] || c.abonnement,
      t ? t.numero || t.modele : '', c.restitution ? RETOURS[c.restitution.statut] || c.restitution.statut : '',
      c.remboursement ? `${csvMontant(c.remboursement.montant)} ${REMBOURSEMENTS[c.remboursement.statut] || c.remboursement.statut}` : ''];
  }), false);
});

function livraisonTexte(c) {
  const l = c.livraison || {};
  if (l.transporteur === 'mondial-relay') {
    return `Point relais ${l.nom || ''} (n° ${l.id || '?'}), ${[l.adresse, `${l.cp || ''} ${l.ville || ''}`.trim()].filter(Boolean).join(', ')}${l.destinataire ? `, retrait par ${l.destinataire}` : ''}`;
  }
  const a = l.adresse || {};
  return [l.nom, a.line1, a.line2, `${a.postal_code || ''} ${a.city || ''}`.trim()].filter(Boolean).join(', ') || '—';
}

const STATUTS_FACTURE = {
  paid: ['Payée', 'ok'], open: ['À payer', 'info'], uncollectible: ['Irrécouvrable', 'ko'],
  void: ['Annulée', ''], draft: ['Brouillon', ''],
};

// Fiche d'une commande : client, livraison, tablette, factures et paiements Stripe.
function ouvrirCommande(c) {
  location.hash = `#commande/${encodeURIComponent(c.id)}`;
}

// Page d'une commande : ce qu'il faut savoir, puis les actions possibles, chacune expliquée.
let commandeAffichee = null;
async function remplirCommande(id) {
  const c = donnees.commandes.find((x) => x.id === id);
  if (!c) {
    $('dc-corps').replaceChildren(h('div', { class: 'card' }, h('p', {}, 'Commande introuvable.')));
    return;
  }
  // Même commande déjà affichée : garder les factures déjà lues et ce qui est en cours de saisie.
  const cle = JSON.stringify([c.id, etatCommande(c), c.preparation, c.fid, c.etiquettes]);
  if (commandeAffichee === cle && $('dc-corps').children.length) return;
  commandeAffichee = cle;
  const t = donnees.stock.find((x) => x.commande === c.id);
  const [texte, classe] = ETATS_COMMANDE[etatCommande(c)];
  document.title = `Papote · Commande ${codeCommande(c.code)}`;
  const ligne = (k, v) => (v ? [h('dt', {}, k), h('dd', {}, v)] : []);
  const factures = h('div', {}, h('p', { class: 'muted small' }, 'Lecture des factures…'));
  const partie = !['a-preparer', 'paiement-en-attente', 'annulee'].includes(c.expedition);
  // Remplacement d'un élément du kit : ouvert depuis le ⋮, sous l'en-tête.
  const zoneRemplacement = h('div', { class: 'zone-remplacement', hidden: true },
    t && partie ? formulaireRemplacement(c, t) : null);
  const etape = prochaineEtape(c, t);
  // Retour du matériel : coché ici seulement (la liste « à récupérer » ne fait qu'ouvrir la commande).
  const aRecuperer = etatCommande(c) === 'retour';
  const zoneReception = aRecuperer ? zoneMaterielRecu(c, t) : null;
  const sansEtiquette = !(c.etiquettes && c.etiquettes.retour) && !(c.restitution && c.restitution.etiquette);
  const annonce = annonceCommande;
  annonceCommande = null;
  const doublon = c.alerteDoublon;
  $('dc-corps').replaceChildren(...[
    annonce ? h('p', { class: 'annonce', role: 'status' }, annonce) : null,
    doublon ? h('div', { class: `alerte-doublon${doublon.mauvaisPayeur ? ' grave' : ''}`, role: 'alert' },
      h('strong', {}, doublon.mauvaisPayeur ? '⚠ Client déjà mauvais payeur : ne pas envoyer avant vérification' : 'Ce client a déjà commandé'),
      doublon.mauvaisPayeur ? h('p', {}, `Sur une commande précédente : ${doublon.raisons.join(', ')}.`) : null,
      h('p', {}, 'Même IBAN, e-mail, téléphone ou adresse que : ',
        ...doublon.commandes.flatMap((x, i) => [i ? ', ' : null, h('a', { href: `#commande/${encodeURIComponent(x.id)}` }, [x.code, x.nom].filter(Boolean).join(' · ') || 'commande')]))) : null,
    h('div', { class: 'card' },
      h('div', { class: 'tete-fiche' }, h('h2', {}, `Commande ${codeCommande(c.code)}`, c.offerte ? ' (offerte)' : ''),
        h('div', { class: 'tete-actions' },
          aRecuperer ? h('button', { type: 'button', class: 'primary small-btn no-print', onclick: () => { zoneReception.hidden = false; } }, 'Matériel reçu') : null,
          // L'étiquette de retour est créée toute seule ; ce bouton ne sert que si elle manque.
          aRecuperer && sansEtiquette && !c.offerte ? boutonEtiquetteRetour(c) : null,
          menuCommande(c, t && partie && ['active', 'en-route'].includes(etatCommande(c)) ? zoneRemplacement : null,
            partie && !aRecuperer && sansEtiquette && t && t.etat === 'en-retour'))),
      zoneRemplacement,
      zoneReception,
      h('dl', { class: 'fiche' },
      ligne('État', badge(texte, classe)),
      ligne('Commandée le', jour(c.creeLe)),
      ligne('Client', [c.nom, c.email, c.telephone].filter(Boolean).join(' · ')),
      // Souvent un proche (compte joint, gendre…) : à regarder avant l'envoi, sans rien bloquer.
      ligne('Titulaire de l\'IBAN', c.titulaire),
      ligne('Formule', formuleTexte(c)),
      ligne('Livraison', livraisonTexte(c)),
      ligne('Suivi', c.suivi ? `${c.suivi}${c.envoyeeLe ? `, envoyée le ${jour(c.envoyeeLe)}` : ''}` : null),
      ligne('Famille', c.famille ? `${c.famille}${c.abonnement ? ` (${ABONNEMENTS[c.abonnement] || c.abonnement})` : ''}` : null),
      ligne('Tablette', t ? h('button', { type: 'button', class: 'link', onclick: () => ouvrirTablette(t.id) },
        [t.ref, t.numero || (t.ref ? null : 'sans n° de série'), t.modele, donnees.etats[etatTablette(t)]].filter(Boolean).join(' · ')) : null),
      ligne('Carte SIM', simDuKit(t)),
      ligne('Accessoires', t && (t.accessoires || []).length ? t.accessoires.join(', ') : null),
      ligne('Retour', c.restitution ? `${RETOURS[c.restitution.statut] || c.restitution.statut}${c.restitution.avant && c.restitution.statut === 'attendue' ? ` avant le ${jour(c.restitution.avant)}` : ''}` : null),
      ligne('Suivi du retour', suiviRetourDe(c)),
      ligne('Étiquettes', etiquettesDe(c)),
      ligne('Remboursement', c.remboursement ? `${euros(c.remboursement.montant)} ${REMBOURSEMENTS[c.remboursement.statut] || c.remboursement.statut}` : null),
      ligne('Reçue le', c.preparation && c.preparation.recuLe ? `${jour(c.preparation.recuLe)}${c.preparation.recuPar ? ` (${c.preparation.recuPar})` : ''}` : null),
      ligne('Annulation possible', c.fid && annulableApresEnvoi(c) ? `jusqu'au ${jour(limiteAnnulation(c))}` : null),
      ligne('Pause', c.pause && c.pause.jusqua > Date.now() ? `prélèvements en pause jusqu'au ${jour(c.pause.jusqua)} (hospitalisation)` : null),
      ligne('Dernier mois', c.dernierMois ? `${euros(c.dernierMois.montant)} ${DERNIER_MOIS[c.dernierMois.statut] || c.dernierMois.statut}${c.dernierMois.erreur ? ` : ${c.dernierMois.erreur}` : ''}` : null),
      ligne('Prélèvement refusé', c.restitution && c.restitution.statut === 'echec' ? `matériel non rendu${c.restitutionErreur ? ` : ${c.restitutionErreur}` : ''}` : null),
      ligne('Contesté', (c.contestations || []).length ? c.contestations.map((x) => `${euros(x.montant)} le ${jour(x.le)}`).join(', ') : null))),
    h('div', { class: 'card' }, h('h2', {}, 'Parcours'),
      // Frise : la date à gauche (vide pour une étape sans date), l'étape à droite ; la prochaine étape en dernier.
      h('ol', { class: 'frise' }, ...parcoursCommande(c).map(([le, texte, date]) => {
        const quand = Number.isFinite(le) ? le : date;
        return h('li', {}, h('span', { class: 'frise-date' }, quand ? jour(quand) : ''), h('span', { class: 'frise-texte' }, texte));
      }), etape ? h('li', { class: 'frise-suite' }, h('span', { class: 'frise-date' }, 'À venir'),
        h('span', { class: 'frise-texte' }, h('strong', {}, 'Prochaine étape : '), etape[0], etape[1] ? h('span', { class: 'frise-action' }, etape[1]) : null)) : null)),
    h('div', { class: 'card' }, h('h2', {}, 'Factures et paiements du client'), factures),
  ].filter(Boolean));
  if (c.offerte) {
    factures.replaceChildren(h('p', { class: 'muted small' }, 'Commande offerte : aucun paiement.'));
    return;
  }
  try {
    const r = await appeler('gestionCommande', { commande: c.id });
    const table = h('table');
    remplirTable(table, [{ titre: 'Date' }, { titre: 'N°' }, { titre: 'Détail' }, { titre: 'Montant', n: 1 }, { titre: 'Statut' }, { titre: '' }],
      r.factures.sort((a, b) => b.le - a.le).map((f) => {
        const [s, cl] = STATUTS_FACTURE[f.statut] || [f.statut, ''];
        return [jour(f.le), f.numero || '—', f.lignes, euros(f.total), badge(s, cl),
          f.lienPdf ? h('a', { href: f.lienPdf, target: '_blank', rel: 'noopener' }, 'PDF') : ''];
      }), { vide: 'Aucune facture pour cette commande.' });
    // Paiements sans facture (tablette non rendue) et remboursements.
    const autres = r.paiements.filter((p) => !p.facture || p.rembourse);
    const table2 = h('table');
    if (autres.length) {
      remplirTable(table2, [{ titre: 'Date' }, { titre: 'Paiement' }, { titre: 'Montant', n: 1 }, { titre: 'Remboursé', n: 1 }, { titre: '' }],
        autres.map((p) => [jour(p.le), p.description || (p.facture ? 'Abonnement' : 'Paiement'), euros(p.montant),
          p.rembourse ? euros(p.rembourse) : '', p.recu ? h('a', { href: p.recu, target: '_blank', rel: 'noopener' }, 'Reçu') : '']));
    }
    const paye = r.paiements.filter((p) => p.statut === 'succeeded').reduce((s, p) => s + p.montant - (p.rembourse || 0), 0);
    // Abonnement introuvable chez Stripe : en général une commande de test, ou un abonnement effacé de Stripe.
    const inconnue = r.erreur && /No such/i.test(r.erreur);
    if (inconnue || (!r.factures.length && !r.paiements.length)) {
      factures.replaceChildren(h('p', { class: 'muted small' }, inconnue
        ? 'Stripe ne retrouve pas l\'abonnement de cette commande (commande de test, ou abonnement effacé dans Stripe) : aucun paiement à afficher.'
        : r.erreur || 'Aucun paiement pour l\'instant.'));
      return;
    }
    factures.replaceChildren(...[r.erreur ? h('p', { class: 'muted small' }, r.erreur) : null,
      h('p', { class: 'small' }, `Payé au total : ${euros(paye)}`),
      r.factures.length ? h('div', { class: 'table cartes' }, table) : null, autres.length ? h('div', { class: 'table cartes' }, table2) : null].filter(Boolean));
  } catch (e) {
    factures.replaceChildren(h('p', { class: 'error small' }, messageErreur(e)));
  }
}

// Actions rares ou définitives de la commande, rangées dans le ⋮ ; chacune s'explique dans sa confirmation.
function menuCommande(c, zoneRemplacement, etiquette) {
  const lancer = async (faire) => {
    try {
      annonceCommande = await faire();
      commandeAffichee = null;
      donnees = await patienter('Mise à jour de la page…', () => lireDonnees(true));
      afficherTout();
      signalerChangement();
    } catch (e) {
      if (e !== 'non') prevenir(messageErreur(e));
    }
  };
  const enCours = c.fid && !c.offerte && !c.resiliationLe && ['actif', 'impaye', 'suspendu', 'active', 'trialing', 'past_due'].includes(c.abonnement);
  // Pendant les 30 jours après la réception : « Annuler la commande » (rien à payer, tout remboursé au
  // retour) ; ensuite seulement « Arrêter l'abonnement » (fin du mois, dernier mois prélevé).
  const annulable = enCours && annulableApresEnvoi(c);
  const enPause = c.pause && c.pause.jusqua > Date.now();
  const items = [
    ['a-preparer', 'paiement-en-attente'].includes(c.expedition)
      ? { libelle: 'Annuler la commande', danger: true, faire: () => lancer(() => annulerCommande(c)) } : null,
    annulable ? { libelle: 'Annuler la commande (30 jours)', danger: true, faire: () => lancer(() => annulerApresEnvoi(c)) } : null,
    c.expedition === 'envoyee' && !c.fid && c.remise !== 'main-propre'
      ? { libelle: 'Colis revenu (jamais retiré)', danger: true, faire: () => lancer(() => colisRevenu(c)) } : null,
    enCours && !annulable
      ? { libelle: 'Arrêter l\'abonnement', danger: true, faire: () => lancer(() => arreterAbonnement(c)) } : null,
    enCours && !annulable && !enPause ? { libelle: 'Pause hospitalisation…', faire: () => lancer(() => pauseHospitalisation(c)) } : null,
    enPause ? { libelle: 'Reprendre les prélèvements', faire: () => lancer(() => reprendrePrelevements(c)) } : null,
    zoneRemplacement ? { libelle: 'Remplacer un élément du kit (cassé ou perdu)…', faire: () => {
      zoneRemplacement.hidden = false;
      zoneRemplacement.querySelector('select').focus();
    } } : null,
    etiquette ? { libelle: 'Créer l\'étiquette de retour', faire: () => lancer(async () => {
      if (!await demander(`Créer une étiquette de retour Mondial Relay et l'envoyer à ${c.email || 'ce client'} ?`, { oui: 'Créer et envoyer' })) throw 'non';
      const r = await patienter('Création de l\'étiquette de retour…', () => appeler('gestionEtiquette', { commande: c.id, sens: 'retour' }));
      return r.envoyee ? 'Étiquette de retour créée et envoyée au client.' : 'Étiquette de retour créée (pas d\'e-mail client connu).';
    }) } : null,
  ].filter(Boolean);
  return items.length ? menuPoints(items, `Actions pour la commande ${codeCommande(c.code)}`) : null;
}

let annonceCommande = null; // Résultat de la dernière action, affiché en haut de la page commande rechargée.

async function annulerCommande(c) {
  if (!await demander(`Annuler la commande ${codeCommande(c.code)} de ${c.nom || c.email || 'ce client'} ?\n\n${c.offerte
    ? 'La tablette n\'est pas encore partie : la commande est annulée et la tablette mise de côté revient au stock.'
    : 'La tablette n\'est pas encore partie : l\'abonnement s\'arrête, tout ce qui a été payé est remboursé, la tablette mise de côté revient au stock et le client reçoit un e-mail.'}`, { oui: 'Annuler la commande', non: 'Garder la commande', danger: true })) throw 'non';
  const r = await patienter('Annulation de la commande…', () => appeler('gestionAnnulerCommande', { commande: c.id }));
  return [`Commande annulée.`, r.stripeIntrouvable ? 'Stripe ne connaissait pas son abonnement (commande de test ?) : rien à rembourser, pas d\'e-mail au client.' : null,
    r.rembourse ? `${euros(r.rembourse)} remboursés.` : null,
    r.mailEnvoye ? 'Le client a reçu un e-mail.' : null].filter(Boolean).join(' ');
}

// Colis jamais retiré au relais et revenu chez Papote (A3) : la commande est annulée et remboursée, la tablette revient.
async function colisRevenu(c) {
  if (!await demander(`Le colis de ${c.nom || c.email || 'ce client'} est revenu sans avoir été retiré ?\n\nLa commande ${codeCommande(c.code)} est annulée, tout ce qui a été payé est remboursé, et la tablette passe « Revenue, à vérifier ».`,
    { oui: 'Colis revenu : annuler', non: 'Garder la commande', danger: true })) throw 'non';
  const r = await patienter('Annulation de la commande…', () => appeler('gestionAnnulerCommande', { commande: c.id, colisRevenu: true }));
  return ['Commande annulée, colis revenu.', r.rembourse ? `${euros(r.rembourse)} remboursés.` : null,
    r.mailEnvoye ? 'Le client a reçu un e-mail.' : null].filter(Boolean).join(' ');
}

// Date limite pour « Annuler la commande » une fois la tablette partie : 30 jours après la réception
// (la vraie si on la connaît, sinon envoi + 3 jours). Même règle que limiteRetractation (functions/abonnement.js).
function limiteAnnulation(c) {
  const recue = c.preparation && c.preparation.recuLe;
  const reception = recue || (c.envoyeeLe ? c.envoyeeLe + 3 * 864e5 : 0);
  return Math.max(c.creeLe || 0, reception) + 30 * 864e5;
}
const annulableApresEnvoi = (c) => c.expedition === 'envoyee' && !c.retractation && !c.restitution && Date.now() <= limiteAnnulation(c);

async function annulerApresEnvoi(c) {
  if (!await demander(`Annuler la commande ${codeCommande(c.code)} de ${c.nom || c.email || 'ce client'} ?\n\nLa tablette est chez le client depuis moins de 30 jours (jusqu'au ${jour(limiteAnnulation(c))}) : l'abonnement s'arrête tout de suite, rien n'est prélevé, et tout ce qui a été payé (60 € compris) est remboursé dès que la tablette revient. Le client reçoit l'étiquette de retour par e-mail.`,
    { oui: 'Annuler la commande', non: 'Garder la commande', danger: true })) throw 'non';
  const r = await patienter('Annulation de la commande…', () => appeler('retracter', { fid: c.fid }));
  return `Commande annulée. ${euros(r.montant)} seront remboursés au retour de la tablette.`;
}

// « 15/12/2026 » ou « 15/12 » → millisecondes (midi), ou null.
function dateReprise(t) {
  const m = String(t || '').trim().match(/^(\d{1,2})[/. -](\d{1,2})(?:[/. -](\d{2,4}))?$/);
  if (!m) return null;
  const n = new Date();
  let annee = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : n.getFullYear();
  let d = new Date(annee, Number(m[2]) - 1, Number(m[1]), 12);
  if (!m[3] && d < n) d = new Date(++annee, Number(m[2]) - 1, Number(m[1]), 12);
  return d.getDate() === Number(m[1]) ? d.getTime() : null;
}

async function pauseHospitalisation(c) {
  const saisie = await saisir(`Pause pour hospitalisation de ${c.famille || c.nom || 'ce client'} (justificatif reçu).\n\nRien ne sera prélevé jusqu'à la date de reprise ; la tablette continue de marcher. Date de reprise des prélèvements (JJ/MM/AAAA) :`, '', { oui: 'Mettre en pause' });
  if (saisie == null || saisie === false) throw 'non';
  const jusqua = dateReprise(saisie);
  if (!jusqua) throw new Error('Date illisible : écrivez par exemple 15/12/2026.');
  await patienter('Mise en pause des prélèvements…', () => appeler('pauseHospitalisation', { commande: c.id, jusqua }));
  return `Prélèvements en pause jusqu'au ${jour(jusqua)}.`;
}

async function reprendrePrelevements(c) {
  if (!await demander(`Reprendre les prélèvements de ${c.famille || c.nom || 'ce client'} dès maintenant ?`, { oui: 'Reprendre' })) throw 'non';
  await patienter('Reprise des prélèvements…', () => appeler('pauseHospitalisation', { commande: c.id, jusqua: null }));
  return 'Prélèvements repris.';
}

async function arreterAbonnement(c) {
  if (!await demander(`Arrêter l'abonnement de ${c.nom || c.email || 'ce client'} ?\n\nComme si le client résiliait lui-même dans l'appli : l'abonnement prend fin à la fin du mois en cours, prélevé à l'arrêt.`, { oui: 'Arrêter l\'abonnement', non: 'Garder', danger: true })) throw 'non';
  const r = await patienter('Arrêt de l\'abonnement…', () => appeler('resilierAbonnement', { fid: c.fid, par: 'papote' }));
  return `Abonnement arrêté : il prend fin le ${jour(r.le)}.`;
}

// Colis de retour : n° de suivi (lien Mondial Relay) et où il en est, mis à jour chaque nuit.
const ETAPES_COLIS = { 'Delivered': 'arrivé chez Papote', 'Awaiting customer pickup': 'au point relais', 'En route to sorting center': 'en route',
  'Being sorted': 'au centre de tri', 'Driver en route': 'en livraison', 'Ready to send': 'étiquette créée, pas encore déposé',
  'Announced': 'étiquette créée, pas encore déposé' };
function suiviRetourDe(c) {
  const r = c.etiquettes && c.etiquettes.retour;
  if (!r || !r.colis) return null;
  const etape = r.livre ? 'arrivé chez Papote' : r.etape ? (ETAPES_COLIS[r.etape] || r.etape) : 'étiquette créée, pas encore déposé';
  const numero = r.lienSuivi ? h('a', { href: r.lienSuivi, target: '_blank', rel: 'noopener' }, r.suivi || 'Suivre le colis') : (r.suivi || null);
  return [badge(etape, r.livre ? 'ok' : 'info'), numero ? ' ' : null, numero];
}

// Étiquettes Sendcloud de la commande, en liens PDF.
function etiquettesDe(c) {
  const e = c.etiquettes || {};
  const liens = [['aller', 'Envoi'], ['retour', 'Retour']].filter(([k]) => e[k] && e[k].url)
    .map(([k, nom]) => h('a', { href: e[k].url, target: '_blank', rel: 'noopener' }, `${nom} du ${jour(e[k].le)}`));
  return liens.length ? liens.flatMap((a, i) => (i ? [' · ', a] : [a])) : null;
}

// Matériel revenu : ce qui manque est prélevé au client (tabletteRendue, index.js), la tablette passe
// « Revenue » (à vérifier) ou « Perdue » si elle manque.
const PRIX_MATERIEL = { tablette: 130, chargeur: 10, enceinte: 10 };
function zoneMaterielRecu(c, t) {
  const cases = [['tablette', 'la tablette'], ['chargeur', 'le chargeur et son câble'], c.enceinteFournie === true ? ['enceinte', 'l\'enceinte'] : null]
    .filter(Boolean).map(([k, v]) => h('label', { class: 'case' }, h('input', { type: 'checkbox', value: k }), ` ${v} (${PRIX_MATERIEL[k]} €)`));
  const msg = h('p', { class: 'small error', hidden: true });
  const zone = h('div', { class: 'zone-remplacement no-print', hidden: true },
    h('p', {}, h('strong', {}, 'Colis de retour reçu. '), c.offerte ? 'Cochez ce qui manque (commande offerte : rien n\'est prélevé).' : 'Cochez ce qui manque, ce sera prélevé au client :'),
    ...cases, msg);
  const valider = h('button', { type: 'button', class: 'primary small-btn' }, 'Enregistrer le retour');
  valider.addEventListener('click', async () => {
    const manquants = [...zone.querySelectorAll('input:checked')].map((i) => i.value);
    const total = c.offerte ? 0 : manquants.reduce((s, m) => s + PRIX_MATERIEL[m], 0);
    if (!await demander(total
      ? `Prélever ${total} € à ${c.email || 'ce client'} pour le matériel manquant (${manquants.join(', ')}) ?`
      : manquants.length ? `Noter comme manquant : ${manquants.join(', ')} ?` : 'Tout le matériel est bien revenu ?', { oui: 'Enregistrer' })) return;
    valider.disabled = true;
    msg.hidden = true;
    try {
      const r = await patienter('Enregistrement du retour…', async () => {
        const res = await appeler('tabletteRendue', { commande: c.id, manquants });
        if (t) await appeler('gestionStock', { action: 'modifier', id: t.id, champs: { etat: manquants.includes('tablette') ? 'perdue' : 'revenue' } }).catch(() => null);
        donnees = await lireDonnees(true);
        return res;
      });
      annonceCommande = r && r.erreur ? `Prélèvement refusé : ${r.erreur}. À relancer depuis Stripe.`
        : `Retour enregistré.${t && !manquants.includes('tablette') ? ' La tablette est à vérifier avant de repartir.' : ''}`;
      commandeAffichee = null;
      afficherTout();
      signalerChangement();
    } catch (e) {
      msg.hidden = false;
      msg.textContent = messageErreur(e);
      valider.disabled = false;
    }
  });
  zone.append(h('div', { class: 'boutons' }, valider,
    h('button', { type: 'button', class: 'secondary small-btn', onclick: () => { zone.hidden = true; } }, 'Annuler')));
  return zone;
}

// Étiquette de retour Sendcloud (élément remplacé, fin de contrat) : envoyée au client par e-mail.
function boutonEtiquetteRetour(c) {
  const msg = h('p', { class: 'small muted', hidden: true });
  const bouton = h('button', { type: 'button', class: 'secondary small-btn' }, 'Étiquette de retour au client');
  bouton.addEventListener('click', async () => {
    if (!await demander(`Créer une étiquette de retour Mondial Relay et l'envoyer à ${c.email || 'ce client'} ?`, { oui: 'Créer et envoyer' })) return;
    const fenetre = window.open('', '_blank');
    bouton.disabled = true;
    msg.hidden = false;
    msg.className = 'small muted';
    msg.textContent = '';
    try {
      const r = await patienter('Création de l\'étiquette de retour…', async () => {
        const res = await appeler('gestionEtiquette', { commande: c.id, sens: 'retour' });
        donnees = await lireDonnees(true);
        return res;
      });
      if (fenetre) fenetre.location = r.url;
      msg.textContent = r.envoyee ? 'Étiquette créée et envoyée au client.' : 'Étiquette créée (pas d\'e-mail client connu).';
    } catch (err) {
      if (fenetre) fenetre.close();
      msg.className = 'small error';
      msg.textContent = messageErreur(err);
      bouton.disabled = false;
    }
  });
  return h('div', { class: 'bouton-message no-print' }, bouton, msg);
}

// Client qui a perdu son code de commande (pour relier la tablette avec une autre adresse e-mail).
function boutonRenvoyerCode(c) {
  const msg = h('p', { class: 'small muted', hidden: true });
  const bouton = h('button', { type: 'button', class: 'secondary small-btn' }, 'Renvoyer le code au client');
  bouton.addEventListener('click', async () => {
    const email = await saisir('Adresse e-mail où envoyer le code de commande :', c.email || '');
    if (email == null) return;
    bouton.disabled = true;
    msg.hidden = false;
    msg.className = 'small muted';
    try {
      const r = await patienter('Envoi du code…', () => appeler('gestionRenvoyerCode', { commande: c.id, email }));
      msg.textContent = `Code envoyé à ${r.a}.`;
    } catch (err) {
      msg.className = 'small error';
      msg.textContent = messageErreur(err);
    }
    bouton.disabled = false;
  });
  return h('div', { class: 'remplacement no-print' }, bouton, msg);
}

// Carte SIM de la tablette d'un client, cliquable vers sa fiche.
function simDuKit(t) {
  if (!t || !t.sim) return null;
  const l = t.simId && donnees.sims.find((x) => x.id === t.simId);
  const texte = [t.sim, l && l.iccid ? `ICCID ${fin4(l.iccid)}` : null, t.simOperateur].filter(Boolean).join(' · ');
  return l ? h('button', { type: 'button', class: 'link', onclick: () => ouvrirSim(l.id) }, texte) : texte;
}

// Remplacer un élément du kit chez le client : tablette, carte SIM ou accessoire.
function formulaireRemplacement(c, t) {
  const choix = h('select', { 'aria-label': 'Élément à remplacer' },
    h('option', { value: '' }, 'Remplacer…'),
    h('option', { value: 'tablette' }, 'la tablette'),
    h('option', { value: 'sim' }, 'la carte SIM'),
    h('option', { value: 'accessoire' }, 'un accessoire'));
  const nouveau = h('select', { 'aria-label': 'Remplacé par', hidden: true });
  const motif = h('input', { placeholder: 'Motif (ex. écran cassé)', hidden: true });
  const bouton = h('button', { type: 'submit', class: 'secondary small-btn', hidden: true }, 'Remplacer');
  const msg = h('p', { class: 'small muted', hidden: true });
  const libres = {
    tablette: () => donnees.stock.filter((x) => DISPONIBLES.includes(x.etat) && !x.commande)
      .map((x) => [x.id, [x.ref, x.numero || (x.ref ? null : 'sans n° de série'), x.modele].filter(Boolean).join(' · ')]),
    sim: () => donnees.sims.filter((l) => !l.tablette && ['stock', 'active'].includes(l.statut) && (l.numero || l.iccid))
      .map((l) => [l.id, [l.numero || `ICCID ${fin4(l.iccid)}`, l.operateur].filter(Boolean).join(' · ')]),
    accessoire: () => donnees.accessoires.map((a) => [a.id, `${a.nom} (${a.quantite || 0} en stock)`]),
  };
  const AIDE = {
    tablette: 'La tablette actuelle passe « en retour » et garde sa place dans « À faire » jusqu\'à son retour. Sa carte SIM passe dans la nouvelle, à jumeler avec l\'appli famille.',
    sim: 'L\'ancienne carte passe « suspendue » : pense à la résilier chez l\'opérateur.',
    accessoire: 'L\'accessoire sort du stock.',
  };
  choix.addEventListener('change', () => {
    const k = choix.value;
    const options = k ? libres[k]() : [];
    nouveau.replaceChildren(...(options.length ? options.map(([v, x]) => h('option', { value: v }, x))
      : [h('option', { value: '' }, 'Rien de disponible en stock')]));
    for (const el of [nouveau, motif, bouton, msg]) el.hidden = !k;
    msg.className = 'small muted';
    msg.textContent = k ? AIDE[k] : '';
  });
  const form = h('form', { class: 'remplacement no-print' }, choix, nouveau, motif, bouton, msg);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!nouveau.value) return;
    bouton.disabled = true;
    // Ouverte avant toute attente, sinon le navigateur la bloque : elle recevra l'étiquette d'envoi.
    const fenetre = window.open('', '_blank');
    try {
      await patienter('Remplacement en cours…', () => appeler('gestionStock', { action: 'remplacer', commande: c.id, element: choix.value, nouveau: nouveau.value, motif: motif.value }));
      // Étiquettes faites tout de suite : l'aller pour le colis de remplacement, le retour (envoyé au client par
      // e-mail) pour la tablette remplacée.
      msg.className = 'small muted';
      msg.textContent = 'Remplacement noté. Création des étiquettes chez Sendcloud…';
      const sens = choix.value === 'tablette' ? ['aller', 'retour'] : ['aller'];
      const faites = [];
      for (const s of sens) {
        try {
          const r = await patienter('Création des étiquettes…', () => appeler('gestionEtiquette', { commande: c.id, sens: s }));
          faites.push([s, r.url]);
        } catch (err) {
          prevenir(`Étiquette ${s === 'aller' ? 'd\'envoi' : 'de retour'} impossible : ${messageErreur(err)}. Faites-la depuis la commande.`);
        }
      }
      const aller = faites.find(([s]) => s === 'aller');
      if (fenetre) { if (aller) fenetre.location = aller[1]; else fenetre.close(); }
      donnees = await patienter('Mise à jour de la page…', () => lireDonnees(true));
      afficherTout();
      commandeAffichee = null;
      afficherFiche();
    } catch (err) {
      if (fenetre) fenetre.close();
      msg.className = 'small error';
      msg.textContent = messageErreur(err);
      bouton.disabled = false;
    }
  });
  return form;
}

const DERNIER_MOIS = { 'en-cours': 'en cours de prélèvement', 'en-attente': 'prélevé, en attente de la banque', fait: 'prélevé', echec: 'refusé par la banque' };

// Ce qu'il reste à faire sur la commande, d'après son état : [texte, bouton éventuel], ou null si rien.
function prochaineEtape(c, t) {
  const nom = t ? [t.ref, t.modele || t.numero].filter(Boolean).join(' ') : '';
  const r = c.etiquettes && c.etiquettes.retour;
  switch (etatCommande(c)) {
    case 'annulee': return null;
    case 'paiement': return ['attendre que la banque confirme le prélèvement SEPA. Ne rien envoyer avant.'];
    case 'a-envoyer': {
      if (t && t.etat === 'commandee') return [`attendre la tablette ${nom}, commandée chez le fournisseur et pas encore reçue. Ensuite : préparer l'envoi.`];
      const preparer = h('button', { type: 'button', class: 'primary small-btn', onclick: (e) => document.dispatchEvent(
        new CustomEvent('papote:preparer-envoi', { detail: { commande: c, bouton: e.currentTarget } })) },
      c.preparation && Object.keys(c.preparation.faits || {}).length ? 'Reprendre la préparation' : 'Préparer l\'envoi');
      return [t ? 'préparer le colis : tablette, carte SIM, accessoires, étiquette Mondial Relay.'
        : 'choisir une tablette du stock pendant la préparation du colis.', preparer];
    }
    case 'en-route': return ['attendre que la famille relie la tablette avec son code de commande.', c.code ? boutonRenvoyerCode(c) : null];
    case 'active':
      if (c.resiliationLe) return [`l'abonnement s'arrête le ${jour(c.resiliationLe)}. Le client recevra alors l'étiquette pour rendre la tablette.`];
      if (t && !t.jumeleeLe && c.envoyeeLe) return ['attendre que la tablette soit reliée à la famille.', c.code ? boutonRenvoyerCode(c) : null];
      return ['rien à faire, la tablette est chez le client.'];
    case 'retour':
      if (c.restitution.statut === 'a-recuperer') return ['reprendre la tablette et ses accessoires chez le proche, puis, sur la page de la tablette, « Modifier » et choisir « Revenue, à vérifier ».'];
      if (c.restitution.statut === 'echec') return ['la tablette n\'a pas été rendue et le prélèvement a échoué : contacter le client.'];
      return [r && r.colis ? 'attendre le colis de retour (suivi ci-dessus).' : 'envoyer au client l\'étiquette de retour (bouton en haut).'];
    default: return null;
  }
}

// Grandes étapes d'une commande, de la commande au retour de la tablette (seulement ce qui s'est passé).
function parcoursCommande(c) {
  // La commande ouvre toujours le parcours, même créée dans la même seconde que la réservation.
  const etapes = [[-Infinity, c.offerte ? `Commande offerte créée${c.famille ? ` pour la famille ${c.famille}` : ''}` : 'Commande passée', c.creeLe]];
  if (c.envoyeeLe) etapes.push([c.envoyeeLe, c.remise === 'main-propre' ? 'Tablette remise en main propre' : `Tablette envoyée${c.suivi ? ` (suivi ${c.suivi})` : ''}`]);
  for (const t of donnees.stock) {
    for (const x of t.historique || []) {
      if (!x.le || x.commande !== c.id) continue;
      if (x.remplacement || x.sim) {
        const quoi = x.sim ? `carte SIM ${x.sim}` : x.accessoires ? x.accessoires.join(', ') : `tablette ${t.numero || t.modele || ''}`;
        etapes.push([x.le, `Remplacement : ${quoi}${x.etat === 'en-retour' ? ' à récupérer' : ' envoyée'}${x.motif ? ` (${x.motif})` : ''}`]);
      } else if (x.etat !== 'envoyee') {
        const nom = [t.ref, t.modele || t.numero].filter(Boolean).join(' ');
        const texte = {
          commandee: `Tablette ${nom} réservée pour cette commande (commandée chez le fournisseur, pas encore reçue)`,
          'en-stock': `Tablette ${nom} mise de côté pour cette commande`,
          preparee: `Tablette ${nom} préparée`,
          'chez-client': `Tablette ${nom} chez le client`,
        }[x.etat] || `Tablette ${nom} : ${(donnees.etats[x.etat] || x.etat).toLowerCase()}`;
        etapes.push([x.le, texte]);
      }
    }
    // Jumelage réel : la tablette s'est reliée à la famille (pas seulement la famille choisie à la commande).
    if (t.commande === c.id && t.jumeleeLe) etapes.push([t.jumeleeLe, `Tablette reliée à la famille ${c.famille || ''}`.trim()]);
  }
  if (c.resiliationLe) etapes.push([null, `Abonnement arrêté, fin le ${jour(c.resiliationLe)}`]);
  if (c.expedition === 'annulee') etapes.push([null, 'Commande annulée']);
  // La date du retour est une date limite, pas celle d'un événement : à la suite, dans le texte.
  if (c.restitution) etapes.push([null, `${RETOURS[c.restitution.statut] || c.restitution.statut}${c.restitution.avant && c.restitution.statut === 'attendue' ? `, à rendre avant le ${jour(c.restitution.avant)}` : ''}`]);
  if (c.remboursement) etapes.push([null, `${euros(c.remboursement.montant)} ${REMBOURSEMENTS[c.remboursement.statut] || c.remboursement.statut}`]);
  // Étapes sans date (jumelage, remboursement) à la suite des autres.
  return etapes.filter(([, texte]) => texte).sort((a, b) => (a[0] || Infinity) - (b[0] || Infinity));
}

// ---------- Stock ----------

// Regroupements du filtre de la liste des tablettes (les chiffres du haut) : [libellé, états, condition].
const GROUPES_STOCK = {
  'g:disponibles': ['En stock, libres', DISPONIBLES, (t) => !t.commande],
  'g:reservees': ['Réservées pour un envoi', DISPONIBLES, (t) => !!t.commande],
  'g:chez': ['Chez les clients', ['envoyee', 'chez-client', 'en-retour']],
  'g:verifier': ['À vérifier ou réparer', ['revenue', 'a-reparer']],
  'g:sorties': ['Perdues ou hors service', ['perdue', 'hors-service']],
};
const dansGroupe = (g, t) => g[1].includes(t.affiche) && (!g[2] || g[2](t));

function afficherStock() {
  const stock = donnees.stock.map((t) => ({ ...t, affiche: etatTablette(t) }));
  const compte = (etats) => stock.filter((t) => etats.includes(t.affiche)).length;
  const valeur = (etats) => stock.filter((t) => etats.includes(t.affiche)).reduce((s, t) => s + (t.prixAchat || 0), 0);
  const aEnvoyer = donnees.commandes.filter((c) => etatCommande(c) === 'a-envoyer').length;
  const pretes = tablettesPretes();
  const dispo = pretes.length;
  const reservees = pretes.filter((t) => t.commande).length;
  const chez = GROUPES_STOCK['g:chez'][1];
  // Chaque chiffre filtre la liste des tablettes juste en dessous.
  const filtrer = (valeur) => () => {
    $('filtre-stock').value = valeur;
    afficherStock();
    $('t-stock').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const libresListe = stock.filter((t) => dansGroupe(GROUPES_STOCK['g:disponibles'], t));
  const libres = libresListe.length;
  const valeurLibres = libresListe.reduce((s, t) => s + (t.prixAchat || 0), 0);
  const reserveesTout = stock.filter((t) => dansGroupe(GROUPES_STOCK['g:reservees'], t)).length;
  const manqueTablettes = Math.max(0, aEnvoyer - dispo);
  // Trois chiffres, chacun ouvre ses tablettes ; le reste en petite ligne, seulement s'il y en a.
  $('kpi-stock').replaceChildren(
    cliquable(stat(String(libres), 'en stock, libres',
      manqueTablettes ? `il manque ${pluriel(manqueTablettes, 'tablette')} pour les commandes` : valeurLibres ? `valeur ${euros(valeurLibres)}` : null,
      manqueTablettes ? 'neg' : null), filtrer('g:disponibles')),
    cliquable(stat(String(reserveesTout), 'réservées pour un envoi'), filtrer('g:reservees')),
    cliquable(stat(String(compte(chez)), 'chez les clients', valeur(chez) ? `valeur ${euros(valeur(chez))}` : null), filtrer('g:chez')));
  const lien = (n, texte, filtre) => (n ? h('button', { type: 'button', class: 'link', onclick: filtrer(filtre) }, `${n} ${texte}`) : null);
  const suite = [
    lien(compte(['commandee']), compte(['commandee']) > 1 ? 'commandées chez le vendeur' : 'commandée chez le vendeur', 'commandee'),
    lien(compte(['revenue', 'a-reparer']), 'à vérifier ou réparer', 'g:verifier'),
    lien(compte(['perdue', 'hors-service']), 'perdue(s) ou hors service', 'g:sorties'),
    donnees.aVendre == null ? null : h('span', { class: 'muted' }, donnees.aVendre
      ? `Le site propose ${donnees.aVendre} à la vente (stock + 10 précommandes)`
      : 'Le site propose « Être prévenu » (plus rien à vendre)'),
  ].filter(Boolean);
  $('kpi-stock-suite').replaceChildren(...suite.flatMap((x, i) => (i ? [' · ', x] : [x])));
  const manque = aEnvoyer - dispo;
  $('alerte-stock').hidden = manque <= 0;
  $('alerte-stock').textContent = manque > 0
    ? `Il manque ${pluriel(manque, 'tablette')} pour envoyer toutes les commandes.` : '';

  const filtre = $('filtre-stock').value;
  const parId = new Map(donnees.commandes.map((c) => [c.id, c]));
  $('stock-vide').hidden = stock.length > 0;
  remplirTable($('t-stock'), [
    { titre: 'N° de série' }, { titre: 'Modèle' }, { titre: 'État' }, { titre: 'Achat' }, { titre: 'Client' }, { titre: 'SIM' },
    { titre: 'Pièces' }, { titre: 'Prix', n: 1 }, { titre: 'Achetée le' },
  ], stock.filter((t) => !filtre || (GROUPES_STOCK[filtre] ? dansGroupe(GROUPES_STOCK[filtre], t) : t.affiche === filtre))
    .sort((a, b) => (b.acheteeLe || 0) - (a.acheteeLe || 0))
    .map((t) => {
      const c = parId.get(t.commande);
      return {
        onclick: () => ouvrirTablette(t.id),
        cellules: [
          h('div', {}, t.ref ? h('strong', {}, `${t.ref} `) : null, t.numero || t.serieAndroid || h('span', { class: 'muted' }, 'à saisir'),
            alerteJumelage(t) ? h('div', {}, badge(alerteJumelage(t), 'ko')) : null,
            t.usure ? h('div', {}, badge(t.usure, 'ko')) : null),
          t.modele || '',
          badge(donnees.etats[t.affiche] || t.affiche, classeEtat(t.affiche)),
          celluleAchat(t),
          c ? nomCommande(c) : '',
          t.sim || '',
          h('div', { class: 'pieces-liste' }, piecesTablette(t).map(lienPiece)),
          euros(t.prixAchat),
          jour(t.acheteeLe),
        ],
      };
    }), { vide: 'Aucune tablette.' });
}
$('filtre-stock').addEventListener('change', afficherStock);

// ---------- Lignes SIM ----------

const ETATS_SANS_CLIENT = ['commandee', 'en-stock', 'revenue', 'a-reparer', 'perdue', 'hors-service'];
const coutSim = (t) => (t.simCout != null ? t.simCout : donnees.reglages.forfaitSim);

// Même règle que simAResilier (functions/gestion.js) : ligne active (payée), tablette sans client depuis 30 jours.
// Une carte pas encore activée ne coûte rien : pas d'alerte.
function lignesSim() {
  if (!donnees) return [];
  const parId = new Map(donnees.commandes.map((c) => [c.id, c]));
  const lignes = new Map(donnees.sims.map((l) => [l.id, l]));
  return donnees.stock.filter((t) => t.sim).map((t) => {
    const c = parId.get(t.commande);
    const ligne = lignes.get(t.simId);
    const finie = c && ((c.restitution && ['rendue', 'facturee'].includes(c.restitution.statut))
      || ['resilie', 'canceled'].includes(c.abonnement));
    const depuis = Math.max(0, ...(t.historique || []).map((x) => x.le || 0));
    const aResilier = (!ligne || ligne.statut === 'active') && (ETATS_SANS_CLIENT.includes(t.etat) || !!finie)
      && (!depuis || Date.now() - depuis > 30 * 864e5);
    return { t, c, aResilier };
  });
}

// Registre des cartes SIM : mêmes règles qu'alertesSim et coutLigne (functions/gestion.js).
const JOUR_MS = 864e5;
function coutLigne(l) {
  if (l.finPromo && l.finPromo < Date.now() && l.prixApres != null) return l.prixApres;
  return l.prix != null ? l.prix : null;
}
function alertesSim(l) {
  if (l.statut === 'resiliee') return [];
  const liste = [];
  const jours = (t) => Math.ceil((t - Date.now()) / JOUR_MS);
  if (l.finPromo) {
    const j = jours(l.finPromo);
    if (j < 0 && l.prixApres != null && l.prixApres !== l.prix) liste.push('promo terminée');
    else if (j >= 0 && j <= 30) liste.push(`promo finie dans ${j} j`);
  }
  if (l.statut === 'stock' && l.activerAvant) {
    const j = jours(l.activerAvant);
    if (j < 0) liste.push('date limite d\'activation dépassée');
    else if (j <= 45) liste.push(`à activer dans les ${j} j`);
  }
  const m = /^(\d{4})-(\d{2})$/.exec(l.cbExp || '');
  if (m) {
    const j = jours(Date.UTC(Number(m[1]), Number(m[2]), 0, 23));
    const carte = `carte bancaire${l.cb ? ` ${l.cb}` : ''}`;
    if (j < 0) liste.push(`${carte} expirée`);
    else if (j <= 60) liste.push(`${carte} expire dans ${j} j`);
  }
  if (l.statut === 'suspendue') liste.push('suspendue : à résilier ou réactiver');
  const recharge = alerteRecharge(l);
  if (recharge) liste.unshift(recharge);
  return liste;
}
// Forfait prépayé (Lyca, 30 jours) : même règle qu'alerteRecharge (functions/gestion.js).
function alerteRecharge(l) {
  if (l.statut !== 'active' || !l.prochaineRecharge) return null;
  const j = Math.ceil((l.prochaineRecharge - Date.now()) / JOUR_MS);
  if (l.renouvellementAuto) return j < -2 ? 'renouvellement pas vu : vérifier chez l\'opérateur' : null;
  if (j < 0) return 'forfait fini : à recharger';
  if (j === 0) return 'à recharger aujourd\'hui';
  return j <= 3 ? `à recharger dans ${j} j` : null;
}
const STATUT_CLASSE = { active: 'ok', stock: 'info', suspendue: 'ko', resiliee: '' };
const fin4 = (iccid) => (iccid ? `…${String(iccid).slice(-4)}` : '');

function afficherSim() {
  const aResilier = new Set(lignesSim().filter((x) => x.aResilier).map((x) => x.t.id));
  const parTablette = new Map(donnees.stock.map((t) => [t.id, t]));
  const parCommande = new Map(donnees.commandes.map((c) => [c.id, c]));
  const filtre = $('filtre-sim').value;
  const ordre = { active: 0, suspendue: 1, stock: 2, resiliee: 3 };
  const lignes = donnees.sims.filter((l) => (filtre ? l.statut === filtre : l.statut !== 'resiliee'))
    .map((l) => {
      const t = l.tablette && parTablette.get(l.tablette);
      const alertes = alertesSim(l);
      if (t && aResilier.has(t.id) && l.statut === 'active') alertes.unshift('tablette plus chez un client : à résilier ou suspendre');
      return { l, t, c: t && parCommande.get(t.commande), alertes };
    })
    .sort((a, b) => b.alertes.length - a.alertes.length || (ordre[a.l.statut] ?? 9) - (ordre[b.l.statut] ?? 9));
  // Anciennes lignes saisies directement sur la fiche d'une tablette, avant le registre.
  const anciennes = donnees.stock.filter((t) => t.sim && !t.simId);
  const actives = donnees.sims.filter((l) => l.statut === 'active');
  const total = actives.reduce((s, l) => s + (coutLigne(l) || 0), 0) + anciennes.reduce((s, t) => s + coutSim(t), 0);
  const n = actives.length + anciennes.length;
  $('sim-resume').textContent = `${n} ligne${n > 1 ? 's actives' : ' active'}, ${euros(total)} par mois · `
    + `${pluriel(donnees.sims.filter((l) => l.statut === 'stock').length, 'carte')} en stock`;
  remplirTable($('t-sim'), [
    { titre: 'Statut' }, { titre: 'Opérateur' }, { titre: 'Numéro' }, { titre: 'ICCID' }, { titre: 'Achat' }, { titre: 'Tablette' },
    { titre: 'Client' }, { titre: 'Par mois', n: 1 }, { titre: 'À regarder' },
  ], [
    ...lignes.map(({ l, t, c, alertes }) => ({
      onclick: () => ouvrirSim(l.id),
      cellules: [badge(donnees.statutsSim[l.statut] || l.statut, STATUT_CLASSE[l.statut]), l.operateur || '', l.numero || '',
        fin4(l.iccid), lienAchat(l.depense), t ? t.numero || t.modele || '' : '', c ? nomCommande(c) : '', euros(coutLigne(l)),
        h('span', { class: 'alertes' }, alertes.map((x) => badge(x, 'ko')))],
    })),
    ...anciennes.map((t) => ({
      onclick: () => ouvrirTablette(t.id),
      cellules: [badge('Active', 'ok'), t.simOperateur || '', t.sim, h('span', { class: 'muted' }, 'à compléter'), '',
        t.numero || t.modele || '', '', euros(coutSim(t)), aResilier.has(t.id) ? badge('à résilier ou suspendre', 'ko') : ''],
    })),
  ], { vide: 'Aucune carte SIM enregistrée.' });
}
$('filtre-sim').addEventListener('change', afficherSim);

let simOuverte = null;
const dateChamp = (ms) => (ms ? new Date(ms).toLocaleDateString('sv-SE') : '');
// Carte existante : sa page ; nouvelle carte : la page « nouvelle », directement en saisie.
let simEdition = null; // id de la carte dont le formulaire est ouvert dans la page, ou 'nouvelle'
function ouvrirSim(id) {
  if (id) location.hash = `#sim/${encodeURIComponent(id)}`;
  else modifierSim(null);
}

// Page d'une carte SIM : ce qu'on sait d'elle en lecture, la tablette et le client où elle est.
function remplirPageSim(id) {
  const zone = $('dsi-corps');
  // Saisie en cours dans la page : ne pas l'effacer à la relecture des données.
  if ((simEdition === id && zone.contains($('f-sim'))) || (zone.dataset.id === id && saisieEnCours(zone))) return;
  zone.dataset.id = id;
  if (id === 'nouvelle') {
    if (simEdition !== 'nouvelle') { modifierSim(null); return; }
    document.title = 'Papote · Nouvelle carte SIM';
    zone.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Nouvelle carte SIM'), $('f-sim')));
    $('f-sim').operateur.focus();
    return;
  }
  const l = donnees.sims.find((x) => x.id === id);
  if (!l) {
    zone.replaceChildren(h('div', { class: 'card' }, h('p', {}, 'Carte SIM introuvable (supprimée ?).')));
    return;
  }
  const titre = `Carte SIM ${l.numero || fin4(l.iccid) || ''}`.trim();
  document.title = `Papote · ${titre}`;
  const t = l.tablette && donnees.stock.find((x) => x.id === l.tablette);
  const c = t && t.commande && donnees.commandes.find((x) => x.id === t.commande);
  const ligne = (k, v) => (v ? [h('dt', {}, k), h('dd', {}, v)] : []);
  const cout = coutLigne(l);
  // Ce que la tablette remonte de sa carte (réseau, data), seulement s'il y a quelque chose.
  const vue = c && c.fid ? simVue(c.fid) : null;
  const alertes = [...alertesSim(l), ...(vue ? vue.alertes : [])];
  // Actions selon l'état de la ligne ; chaque information se modifie seule avec son crayon.
  const changer = (champs, question, fait) => async () => {
    if (question && !await demander(question, { oui: 'Confirmer' })) return;
    await modifierChampsSim(l.id, champs, fait, 'Enregistrement…');
  };
  const actions = [
    l.statut === 'stock' ? { libelle: 'Activer la ligne', faire: changer({ statut: 'active', ...(l.activation ? {} : { activation: Date.now() }) }, 'La ligne est activée chez l\'opérateur ? Elle passe « Active » (date d\'activation : aujourd\'hui).') } : null,
    l.statut === 'suspendue' ? { libelle: 'Réactiver la ligne', faire: changer({ statut: 'active' }, 'La ligne est réactivée chez l\'opérateur ?') } : null,
    l.statut === 'active' ? { libelle: 'Suspendre la ligne', faire: changer({ statut: 'suspendue' }, 'La ligne est suspendue chez l\'opérateur ?') } : null,
    l.tablette ? { libelle: 'Retirer de la tablette', faire: changer({ tablette: null }, 'Retirer cette carte de sa tablette ? La tablette n\'aura plus de carte SIM notée.') } : null,
    ['active', 'suspendue', 'stock'].includes(l.statut) ? { libelle: 'Résilier la ligne', danger: true, faire: changer({ statut: 'resiliee' }, 'La ligne est résiliée chez l\'opérateur ? Elle sort de sa tablette.') } : null,
    { libelle: 'Supprimer la carte (erreur de saisie)', danger: true, faire: () => supprimerSim(l.id) },
  ];
  const tete = h('div', { class: 'tete-fiche' }, h('h2', {}, titre),
    h('div', { class: 'tete-actions no-print' }, menuPoints(actions, `Actions pour ${titre}`)));
  const modif = (libelle, affiche, champ, opts = {}) => ligneModifiable(libelle, affiche, { ...opts,
    enregistrer: (v) => modifierChampsSim(l.id, { [champ]: v }) });
  const tablettesPossibles = donnees.stock.filter((x) => x.id === l.tablette || (!x.simId && !x.sim && !['perdue', 'hors-service'].includes(x.etat)));
  zone.replaceChildren(...[h('div', { class: 'card' },
    tete,
    alertes.length ? h('p', { class: 'small' }, ...alertes.map((a) => badge(a, 'ko'))) : null,
    h('dl', { class: 'fiche' },
      ...ligne('Statut', badge(donnees.statutsSim[l.statut] || l.statut, STATUT_CLASSE[l.statut])),
      ...modif('Opérateur', l.operateur, 'operateur', { valeur: l.operateur }),
      ...modif('Numéro de ligne', l.numero, 'numero', { valeur: l.numero, mode: 'tel' }),
      ...modif('ICCID', l.iccid, 'iccid', { valeur: l.iccid, mode: 'numeric' }),
      ...modif('Tablette', t ? h('a', { href: `#tablette/${encodeURIComponent(t.id)}` }, [t.ref, t.numero || t.modele].filter(Boolean).join(' · ') || 'tablette') : null,
        'tablette', { valeur: l.tablette || '', vide: 'dans aucune tablette',
          options: [['', 'Aucune'], ...tablettesPossibles.map((x) => [x.id, [x.ref, x.numero || x.modele, donnees.etats[etatTablette(x)]].filter(Boolean).join(' · ')])],
          convertir: (v) => v || null }),
      ...ligne('Commande', c ? h('a', { href: `#commande/${encodeURIComponent(c.id)}` }, `Commande ${codeCommande(c.code)}`) : null),
      ...ligne('Client', c && c.email ? h('a', { href: `#client/${encodeURIComponent(c.email.toLowerCase())}` }, c.nom || c.email) : null),
      ...modif('Achat', lienAchat(l.depense), 'depense', { valeur: l.depense || '', options: optionsAchats(), convertir: (v) => v || null }),
      ...modif('Forfait', l.go != null ? `${l.go} Go par mois` : null, 'go', { valeur: l.go != null ? String(l.go) : '', mode: 'decimal', suffixe: 'Go',
        convertir: (v) => { if (!v.trim()) return null; const n = Number(v.replace(',', '.')); if (!Number.isFinite(n)) throw new Error('Un nombre de Go.'); return n; } }),
      ...modif('Prix par mois', l.prix != null ? euros(l.prix) : null, 'prix', { valeur: enEuros(l.prix), mode: 'decimal', suffixe: '€', convertir: convertirEuros }),
      ...modif('Fin de la promo', l.finPromo ? jour(l.finPromo) : null, 'finPromo', { valeur: dateChamp(l.finPromo), type: 'date', convertir: (v) => (v ? dateSaisie(v) : null) }),
      ...(l.finPromo || l.prixApres != null ? modif('Prix après la promo', l.prixApres != null ? euros(l.prixApres) : null, 'prixApres', { valeur: enEuros(l.prixApres), mode: 'decimal', suffixe: '€', convertir: convertirEuros }) : []),
      ...ligne('Coût actuel', cout != null && cout !== l.prix ? euros(cout) : null),
      ...modif('Activée le', l.activation ? jour(l.activation) : null, 'activation', { valeur: dateChamp(l.activation), type: 'date', convertir: (v) => (v ? dateSaisie(v) : null) }),
      ...(l.statut === 'stock' ? modif('À activer avant', l.activerAvant ? jour(l.activerAvant) : null, 'activerAvant', { valeur: dateChamp(l.activerAvant), type: 'date', convertir: (v) => (v ? dateSaisie(v) : null) }) : []),
      ...modif('Identifiant client', l.client, 'client', { valeur: l.client }),
      ...modif('Carte bancaire', l.cb ? `…${l.cb}` : null, 'cb', { valeur: l.cb, mode: 'numeric', aide: '4 derniers chiffres' }),
      ...modif('Expiration de la carte', l.cbExp, 'cbExp', { valeur: l.cbExp, type: 'month' }),
      ...modif('Note', l.note, 'note', { valeur: l.note, long: true }))),
    carteRecharges(l, modif, vue),
    vue ? h('div', { class: 'card' }, h('h2', {}, 'Ce que dit la tablette'),
      h('dl', { class: 'fiche' },
        ...ligne('Réseau', vue.sim.reseau ? `${vue.sim.reseau}${vue.sim.signal >= 0 ? `, signal ${vue.sim.signal}/4` : ''}` : null),
        ...ligne('Data du mois', enGo(vue.sim.dataMoisMo)),
        ...ligne('Carte vue le', vue.vuLe ? vue.vuLe.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : null),
        ...ligne('Tablette en ligne le', vue.vue ? vue.vue.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : null),
        ...ligne('ICCID lu', vue.sim.iccid && l.iccid && !String(vue.sim.iccid).endsWith(String(l.iccid).replace(/\D/g, '').slice(-6))
          ? h('span', { class: 'error' }, `…${String(vue.sim.iccid).slice(-6)} : ce n'est pas cette carte`) : null))) : null].filter(Boolean));
}

function convertirEuros(v) {
  const c = enCentimes(v);
  if (Number.isNaN(c)) throw new Error('Montant illisible (ex. 2,99).');
  return c;
}

// Recharges du forfait d'une ligne : fin du forfait, renouvellement, « J'ai rechargé » et les dépenses payées.
function carteRecharges(l, modif, vue) {
  const recharges = donnees.depenses.filter((d) => d.sim === l.id).sort((a, b) => (b.date || 0) - (a.date || 0));
  if (l.statut === 'resiliee' && !recharges.length) return null;
  const duree = l.dureeForfait || 30;
  const j = l.prochaineRecharge ? Math.ceil((l.prochaineRecharge - Date.now()) / JOUR_MS) : null;
  const fin = l.prochaineRecharge
    ? `${jour(l.prochaineRecharge)} (${j > 1 ? `dans ${j} jours` : j === 1 ? 'demain' : j === 0 ? 'aujourd\'hui' : `il y a ${-j} j`})` : null;
  const annee = new Date().getFullYear();
  const cetteAnnee = recharges.filter((d) => new Date(d.date).getFullYear() === annee).reduce((t, d) => t + (d.montant || 0), 0);
  const bouton = l.statut === 'active'
    ? h('button', { type: 'button', class: 'primary small-btn no-print', onclick: () => noterRecharge(l) }, 'J\'ai rechargé') : null;
  return h('div', { class: 'card' },
    h('div', { class: 'tete-fiche' }, h('h2', {}, 'Recharges du forfait'), h('div', { class: 'tete-actions' }, bouton)),
    h('dl', { class: 'fiche' },
      ...modif('Fin du forfait', fin, 'prochaineRecharge', { valeur: dateChamp(l.prochaineRecharge), type: 'date', vide: 'pas notée',
        convertir: (v) => (v ? dateSaisie(v) : null) }),
      ...modif('Durée du forfait', `${duree} jours`, 'dureeForfait', { valeur: String(duree), mode: 'numeric', suffixe: 'jours',
        convertir: (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 366) throw new Error('Un nombre de jours, ex. 30.'); return n; } }),
      ...modif('Renouvellement', l.renouvellementAuto ? 'automatique, par l\'opérateur' : 'à la main', 'renouvellementAuto', {
        valeur: l.renouvellementAuto ? 'oui' : '', options: [['', 'À la main'], ['oui', 'Automatique, par l\'opérateur']], convertir: (v) => v === 'oui' }),
      ...(cetteAnnee ? [h('dt', {}, `Payé en ${annee}`), h('dd', {}, euros(cetteAnnee))] : []),
      ...ligneGardeFou(vue && vue.sim)),
    h('p', { class: 'muted small' }, l.renouvellementAuto
      ? 'Les factures de l\'opérateur envoyées à factures@mapapote.fr se rangent ici toutes seules. Sans facture 2 jours après la fin du forfait, une alerte s\'affiche.'
      : 'Rappel 3 jours avant la fin du forfait. Une facture envoyée à factures@mapapote.fr se range aussi ici toute seule.',
      ' La tablette reçoit le forfait (Go notés plus haut, 1 Go sinon) et la date de recharge : à 70 % elle réduit l\'image des appels, à 88 % encore plus, à 95 % elle les passe sans image et les vidéos attendent le Wi-Fi.'),
    recharges.length ? h('div', { class: 'table cartes' }, tableRecharges(recharges)) : h('p', { class: 'muted small' }, 'Aucune recharge notée.'));
}
// Garde-fou du forfait vu par la tablette (Forfait.java) : Mo passés par la carte depuis le début du pass,
// sur le forfait recopié dans sa famille (Go de la carte, 1 Go sinon), et ce qu'elle retient.
const PALIERS = ['normal', 'visio Éco', 'visio très réduite', 'appels sans image, ni vidéo, ni météo, ni mise à jour'];
const moTexte = (mo) => (mo >= 1000 ? `${(mo / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} Go` : `${Math.round(mo)} Mo`);
function ligneGardeFou(sim) {
  if (!sim || !(sim.plafondMo > 0) || !(sim.dataCycleMo >= 0)) return [];
  const pc = Math.round((sim.dataCycleMo * 100) / sim.plafondMo);
  return [h('dt', {}, 'Utilisé sur la tablette'), h('dd', {},
    `${moTexte(sim.dataCycleMo)} sur ${moTexte(sim.plafondMo)} (${pc} %)`,
    sim.niveau ? h('span', {}, ' ', badge(PALIERS[sim.niveau] || `palier ${sim.niveau}`, sim.niveau >= 3 ? 'ko' : 'info')) : null,
    sim.cycleDebut ? h('span', { class: 'muted small' }, ` depuis le ${jour(Date.parse(`${sim.cycleDebut}T12:00:00`))}`) : null)];
}

function tableRecharges(recharges) {
  const table = h('table');
  remplirTable(table, [{ titre: 'Date' }, { titre: 'Libellé' }, { titre: 'Montant', n: 1 }], recharges.slice(0, 24).map((d) => ({
    onclick: () => { location.hash = `#depense/${encodeURIComponent(d.id)}`; },
    cellules: [jour(d.date), h('span', {}, d.libelle, d.aVerifier ? h('span', {}, ' ', badge('à vérifier', 'ko')) : null), euros(d.montant)],
  })));
  return table;
}

// « J'ai rechargé » : le montant payé (prix du forfait proposé), puis la dépense et la nouvelle fin du forfait.
async function noterRecharge(l) {
  const v = await saisir(`Recharge payée aujourd'hui pour ${l.numero || 'cette carte'} : montant en euros`, enEuros(coutLigne(l)) || '', { oui: 'Noter la recharge' });
  if (v == null) return;
  let montant;
  try {
    montant = convertirEuros(v);
    if (!montant) throw new Error('Montant manquant (ex. 4,99).');
  } catch (e) {
    prevenir(e.message);
    return;
  }
  try {
    const r = await patienter('Recharge notée…', async () => {
      const res = await appeler('gestionSim', { action: 'recharger', id: l.id, montant });
      donnees = await lireDonnees(true);
      return res;
    });
    afficherTout();
    annoncer(r.prochaineRecharge ? `Recharge notée, prochaine le ${jour(r.prochaineRecharge)}` : 'Recharge notée');
  } catch (e) {
    prevenir(messageErreur(e));
  }
}

// attente : texte de la carte « en cours » pour une action du ⋮ (un crayon a déjà sa roue dans son bouton).
async function modifierChampsSim(id, champs, fait, attente) {
  const travail = async () => {
    await appeler('gestionSim', { action: 'modifier', id, champs });
    donnees = await lireDonnees(true);
  };
  try {
    await (attente ? patienter(attente, travail) : travail());
    afficherTout();
    annoncer(fait || 'Enregistré');
    return true;
  } catch (e) {
    prevenir(messageErreur(e));
    return false;
  }
}

// Un champ en cours de saisie dans cette zone : ne pas la redessiner à la relecture des données.
const saisieEnCours = (zone) => !!zone.querySelector('.saisie-champ:not([data-envoi])');

async function supprimerSim(id) {
  if (!await demander('Supprimer cette carte du registre (erreur de saisie) ? Pour une ligne arrêtée, mettez plutôt le statut « Résiliée ».', { oui: 'Supprimer', danger: true })) return;
  try {
    await patienter('Suppression de la carte…', async () => {
      await appeler('gestionSim', { action: 'supprimer', id });
      donnees = await lireDonnees(true);
    });
    annoncer('Carte supprimée');
    location.hash = '#stock/sim';
    afficherTout();
  } catch (e) {
    prevenir(messageErreur(e));
  }
}

function modifierSim(id) {
  const l = id ? donnees.sims.find((x) => x.id === id) : { statut: 'stock' };
  if (!l) return;
  simOuverte = id || null;
  const f = $('f-sim');
  f.reset();
  $('ds-titre').textContent = id ? `Carte SIM ${l.numero || fin4(l.iccid)}`.trim() : 'Nouvelle carte SIM';
  f.statut.replaceChildren(...Object.entries(donnees.statutsSim).map(([k, v]) => h('option', { value: k, selected: k === l.statut }, v)));
  // Tablettes sans autre carte, plus celle de cette ligne.
  f.tablette.replaceChildren(h('option', { value: '' }, 'Aucune'),
    ...donnees.stock.filter((t) => t.id === l.tablette || (!t.simId && !t.sim && !['perdue', 'hors-service'].includes(t.etat)))
      .map((t) => h('option', { value: t.id, selected: t.id === l.tablette },
        [t.ref, t.numero || (t.ref ? null : 'sans n° de série'), t.modele, donnees.etats[etatTablette(t)]].filter(Boolean).join(' · '))));
  for (const k of ['operateur', 'numero', 'iccid', 'client', 'cb', 'cbExp', 'note']) f.elements[k].value = l[k] || '';
  f.go.value = l.go != null ? l.go : '';
  f.prix.value = enEuros(l.prix);
  f.prixApres.value = enEuros(l.prixApres);
  for (const k of ['finPromo', 'activation', 'activerAvant']) f.elements[k].value = dateChamp(l[k]);
  f.querySelector('.f-msg').hidden = true;
  // Le formulaire s'ouvre dans la page de la carte (plus de fenêtre par-dessus).
  simEdition = id || 'nouvelle';
  const cible = `#sim/${encodeURIComponent(simEdition)}`;
  if (location.hash !== cible) location.hash = cible;
  else remplirPageSim(simEdition);
}
$('ds-annuler').addEventListener('click', () => {
  const id = simEdition;
  simEdition = null;
  $('d-sim').append($('f-sim'));
  if (id === 'nouvelle') location.hash = '#stock/sim';
  else remplirPageSim(id);
});
$('btn-sim').addEventListener('click', () => ouvrirSim(null));

$('f-sim').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const prix = enCentimes(f.prix.value);
  const prixApres = enCentimes(f.prixApres.value);
  if (Number.isNaN(prix) || Number.isNaN(prixApres)) return message(f, 'Prix illisible (ex. 2,99).');
  const go = f.go.value.trim() ? Number(f.go.value.replace(',', '.')) : null;
  if (go != null && !Number.isFinite(go)) return message(f, 'Forfait illisible : un nombre de Go.');
  const date = (v) => (v ? dateSaisie(v) : null);
  const champs = {
    statut: f.statut.value, tablette: f.tablette.value || null, operateur: f.operateur.value, numero: f.numero.value,
    iccid: f.iccid.value, client: f.client.value, go, prix, prixApres, finPromo: date(f.finPromo.value),
    activation: date(f.activation.value), activerAvant: date(f.activerAvant.value), cb: f.cb.value, cbExp: f.cbExp.value,
    note: f.note.value,
  };
  await enregistrer(f, async () => {
    const r = await appeler('gestionSim', simOuverte ? { action: 'modifier', id: simOuverte, champs } : { action: 'ajouter', champs });
    // Saisie terminée : le formulaire retourne à sa place, la page montre la carte enregistrée.
    simEdition = null;
    $('d-sim').append(f);
    if (!simOuverte) location.hash = r && r.id ? `#sim/${encodeURIComponent(r.id)}` : '#stock/sim';
  });
});

// ---------- Accessoires ----------

function accessoiresAPrevoir() {
  const aEnvoyer = donnees.commandes.filter((c) => etatCommande(c) === 'a-envoyer');
  return donnees.accessoires.map((a) => {
    const besoin = a.parEnvoi ? aEnvoyer.filter((c) => a.parEnvoi === 'tous' || a.parEnvoi === c.formule).length : 0;
    const manque = Math.max(0, besoin - (a.quantite || 0));
    const bas = !manque && a.seuil != null && (a.quantite || 0) - besoin <= a.seuil;
    return { ...a, besoin, manque, bas };
  });
}

function afficherAccessoires() {
  remplirTable($('t-accessoires'), [
    { titre: 'Accessoire' }, { titre: 'En stock', n: 1 }, { titre: 'Part avec' }, { titre: 'Au retour' }, { titre: 'Prix unitaire', n: 1 }, { titre: 'Achat' }, { titre: '' },
  ], accessoiresAPrevoir().sort((a, b) => a.nom.localeCompare(b.nom, 'fr')).map((a) => ({
    onclick: () => ouvrirAccessoire(a.id),
    cellules: [a.nom, String(a.quantite || 0), donnees.envoisAccessoire[a.parEnvoi || ''], a.retour ? 'Revient' : 'Consommé', euros(a.prixAchat),
      lienAchat((a.depenses || []).slice(-1)[0]),
      a.manque ? badge(`il en manque ${a.manque} pour les envois`, 'ko') : a.bas ? badge('stock bas', 'ko') : ''],
  })), { vide: 'Aucun accessoire.' });
}

// Page d'un accessoire : chaque information se modifie avec son crayon ; la livraison reçue et la suppression
// sont dans le ⋮. #accessoire/nouveau : le formulaire de saisie dans la page.
function ouvrirAccessoire(id) {
  location.hash = `#accessoire/${encodeURIComponent(id || 'nouveau')}`;
}
$('btn-accessoire').addEventListener('click', () => ouvrirAccessoire(null));

const entier = (v) => (String(v).trim() === '' ? null : /^-?\d+$/.test(String(v).trim()) ? Number(v) : NaN);

function remplirPageAccessoire(id) {
  const zone = $('dx-corps');
  if (id === 'nouveau') {
    $('titre-page').textContent = 'Nouvel accessoire';
    const f = $('f-accessoire');
    if (zone.contains(f)) return;
    f.reset();
    f.parEnvoi.replaceChildren(...Object.entries(donnees.envoisAccessoire).map(([k, v]) => h('option', { value: k }, v)));
    f.quantite.value = 0;
    f.querySelector('.f-msg').hidden = true;
    zone.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Nouvel accessoire'), f));
    f.nom.focus();
    return;
  }
  $('d-accessoire').append($('f-accessoire'));
  const a = accessoiresAPrevoir().find((x) => x.id === id);
  if (!a) {
    zone.replaceChildren(h('div', { class: 'card' }, h('p', {}, 'Accessoire introuvable (supprimé ?).')));
    return;
  }
  if (saisieEnCours(zone)) return;
  document.title = `Papote · ${a.nom}`;
  const changer = (champs, fait) => sauverAccessoire({ action: 'modifier', id: a.id, champs }, fait);
  const modif = (libelle, affiche, champ, opts = {}) => ligneModifiable(libelle, affiche, { ...opts, enregistrer: (v) => changer({ [champ]: v }) });
  const nombre = (v, vide) => {
    const n = entier(v);
    if (Number.isNaN(n) || (n == null && !vide) || n < 0) throw new Error('Un nombre entier, s\'il vous plaît.');
    return n;
  };
  // Livraison reçue : seulement la quantité. La facture arrive par factures@ (ou « Déposer une facture ») et
  // fait la dépense ; le prix unitaire se corrige avec son crayon.
  const livraison = h('form', { class: 'zone-remplacement no-print', hidden: true },
    h('p', {}, h('strong', {}, 'Livraison reçue. '), 'Combien en avez-vous reçu ? La quantité s\'ajoute au stock.'),
    h('div', { class: 'grille' },
      h('label', {}, 'Quantité reçue ', h('input', { name: 'quantite', inputmode: 'numeric', required: true }))),
    h('div', { class: 'boutons' }, h('button', { type: 'submit', class: 'primary small-btn' }, 'Ajouter au stock'),
      h('button', { type: 'button', class: 'secondary small-btn', onclick: () => { livraison.hidden = true; } }, 'Annuler')),
    h('p', { class: 'f-msg small', hidden: true }));
  livraison.addEventListener('submit', async (e) => {
    e.preventDefault();
    const quantite = entier(livraison.quantite.value);
    if (!quantite || quantite < 1 || Number.isNaN(quantite)) return message(livraison, 'Quantité illisible : un nombre entier.');
    await enregistrer(livraison, () => appeler('gestionAccessoire', { action: 'entree', id: a.id, quantite }), `+${quantite} au stock`);
  });
  const menu = menuPoints([
    { libelle: 'Livraison reçue…', faire: () => { livraison.hidden = false; livraison.quantite.focus(); } },
    { libelle: 'Supprimer l\'accessoire', danger: true, faire: async () => {
      if (!await demander(`Supprimer « ${a.nom} » de la liste des accessoires ?`, { oui: 'Supprimer', danger: true })) return;
      if (await sauverAccessoire({ action: 'supprimer', id: a.id }, 'Accessoire supprimé', 'Suppression de l\'accessoire…')) location.hash = '#stock/accessoires';
    } },
  ], `Actions pour ${a.nom}`);
  zone.replaceChildren(h('div', { class: 'card' },
    h('div', { class: 'tete-fiche' }, h('h2', {}, a.nom), h('div', { class: 'tete-actions no-print' }, menu)),
    a.manque ? h('p', { class: 'small' }, badge(`il en manque ${a.manque} pour les envois`, 'ko')) : a.bas ? h('p', { class: 'small' }, badge('stock bas', 'ko')) : null,
    h('dl', { class: 'fiche' },
      ...modif('Nom', a.nom, 'nom', { valeur: a.nom }),
      ...modif('En stock', String(a.quantite || 0), 'quantite', { valeur: a.quantite || 0, mode: 'numeric', convertir: (v) => nombre(v) }),
      ...(a.besoin ? [h('dt', {}, 'Pour les envois'), h('dd', {}, `${a.besoin} à prévoir pour les commandes à envoyer`)] : []),
      ...modif('Alerte sous', a.seuil != null ? String(a.seuil) : null, 'seuil', { valeur: a.seuil ?? '', mode: 'numeric', vide: 'pas d\'alerte', convertir: (v) => nombre(v, true) }),
      ...modif('Prix unitaire', a.prixAchat != null ? euros(a.prixAchat) : null, 'prixAchat', { valeur: enEuros(a.prixAchat), mode: 'decimal', suffixe: '€', convertir: convertirEuros }),
      // Une dépense par livraison : la liste s'allonge (« Ajouter un achat »), une livraison saisie avec son montant s'y ajoute seule.
      ...modif('Achats', (a.depenses || []).length ? h('span', {}, ...a.depenses.flatMap((x, i) => [i ? ', ' : null, lienAchat(x)])) : badge('aucun achat lié', 'neutre'),
        'depenses', { valeur: '', options: optionsAchats('Choisir l\'achat à ajouter'), convertir: (v) => (v ? [...(a.depenses || []), v] : (a.depenses || [])) }),
      ...modif('Part avec', donnees.envoisAccessoire[a.parEnvoi || ''], 'parEnvoi', { valeur: a.parEnvoi || '', options: Object.entries(donnees.envoisAccessoire) }),
      ...modif('Au retour', a.retour ? 'Revient et repart chez le client suivant' : 'Consommé à chaque envoi', 'retour', {
        valeur: a.retour ? 'oui' : '', options: [['oui', 'Revient et repart chez le client suivant'], ['', 'Consommé à chaque envoi']], convertir: (v) => v === 'oui' }),
      ...modif('Note', a.note || null, 'note', { valeur: a.note || '', long: true, vide: 'aucune' })),
    livraison));
}

async function sauverAccessoire(donneesAppel, fait = 'Enregistré', attente) {
  const travail = async () => {
    await appeler('gestionAccessoire', donneesAppel);
    donnees = await lireDonnees(true);
  };
  try {
    await (attente ? patienter(attente, travail) : travail());
    afficherTout();
    annoncer(fait);
    return true;
  } catch (e) {
    prevenir(messageErreur(e));
    return false;
  }
}

$('dx-annuler').addEventListener('click', () => { location.hash = '#stock/accessoires'; });

$('f-accessoire').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const quantite = entier(f.quantite.value);
  const seuil = entier(f.seuil.value);
  const prixAchat = enCentimes(f.prixAchat.value);
  if (quantite == null || Number.isNaN(quantite) || Number.isNaN(seuil)) return message(f, 'Quantité illisible : un nombre entier.');
  if (Number.isNaN(prixAchat)) return message(f, 'Prix illisible (ex. 9,90).');
  const champs = { nom: f.nom.value, parEnvoi: f.parEnvoi.value, quantite, seuil, prixAchat, retour: f.retour.checked, note: f.note.value };
  let nouveau = null;
  const ok = await enregistrer(f, async () => {
    nouveau = await appeler('gestionAccessoire', { action: 'ajouter', champs });
  }, 'Accessoire ajouté');
  if (ok) {
    $('d-accessoire').append(f);
    location.hash = nouveau && nouveau.id ? `#accessoire/${encodeURIComponent(nouveau.id)}` : '#stock/accessoires';
  }
});

$('x-stock').addEventListener('click', () => {
  const parId = new Map(donnees.commandes.map((c) => [c.id, c]));
  csv('stock', ['N° de série', 'Modèle', 'Fournisseur', 'État', 'Commande', 'Client', 'SIM', 'Prix d\'achat', 'Achetée le', 'Notes'],
    donnees.stock.map((t) => {
      const c = parId.get(t.commande);
      return [t.numero, t.modele, t.fournisseur, donnees.etats[etatTablette(t)] || t.etat, c ? codeCommande(c.code) : '',
        c ? c.nom || c.email : '', t.sim, csvMontant(t.prixAchat), jour(t.acheteeLe), t.notes];
    }), false);
});

// Batterie relevée par la tablette (en direct si elle est jumelée, sinon le dernier relevé gardé).
const SANTES = { bonne: 'bonne', surchauffe: 'surchauffe', morte: 'morte', surtension: 'surtension', froide: 'trop froide', panne: 'en panne', inconnue: 'inconnue' };
const ilYA = (le) => {
  const min = Math.round((Date.now() - le) / 60000);
  return min < 2 ? "à l'instant" : min < 60 ? `il y a ${min} min` : min < 48 * 60 ? `il y a ${Math.round(min / 60)} h` : `le ${jour(le)}`;
};
function afficherBatterie(t) {
  const b = t.batterie;
  const zone = $('dt-batterie');
  zone.hidden = !b;
  if (!b) return;
  const infos = [
    b.niveau != null ? `${b.niveau} %${b.enCharge ? ', en charge' : ''}` : null,
    b.sante ? `santé ${SANTES[b.sante] || b.sante}` : null,
    b.temperature != null ? `${String(Math.round(b.temperature * 10) / 10).replace('.', ',')} °C` : null,
    b.cycles != null ? `${b.cycles} cycles` : null,
  ].filter(Boolean).join(' · ');
  const vues = [b.le ? `relevé ${ilYA(b.le)}` : null, b.enLigneLe ? `en ligne ${ilYA(b.enLigneLe)}` : null,
    b.vueLe ? `Mamie vue ${ilYA(b.vueLe)}` : null].filter(Boolean).join(' · ');
  zone.replaceChildren(
    h('p', { class: 'small' }, h('strong', {}, 'Batterie '), infos || 'pas encore de relevé', t.usure ? ' ' : null, t.usure ? badge(t.usure, 'ko') : null),
    vues ? h('p', { class: 'small muted' }, vues) : null,
  );
}

// Alertes envoyées aux proches (journal du serveur, 90 derniers jours) : un chiffre par sorte d'alerte, qui ouvre
// la liste datée (Tanguy, 27/10 : « compter chaque alerte pour analyser »). Sur l'accueil (toutes) et sur la page
// de chaque tablette (les siennes).
function blocAlertes(zone, liste, { titre, avecTablette }) {
  zone.hidden = !donnees.genresAlerte;
  if (zone.hidden) return;
  const jours = donnees.alertesJours || 90;
  const genres = donnees.genresAlerte;
  const parGenre = new Map();
  for (const a of liste) parGenre.set(a.genre, [...(parGenre.get(a.genre) || []), a]);
  const detail = h('ul', { class: 'alertes-liste small', hidden: true });
  let ouvert = null;
  const montrer = (genre) => {
    ouvert = ouvert === genre ? null : genre;
    detail.hidden = !ouvert;
    zone.querySelectorAll('.stat').forEach((s) => s.classList.toggle('actif', s.dataset.genre === ouvert));
    if (!ouvert) return;
    detail.replaceChildren(...(ouvert === '*' ? liste : parGenre.get(ouvert)).map((a) => {
      const morceaux = [
        ouvert === '*' ? genres[a.genre] || a.genre : null,
        avecTablette && a.fiche ? h('a', { href: `#tablette/${encodeURIComponent(a.fiche)}` }, a.fiche) : null,
        avecTablette ? a.famille : null,
        a.telephones != null ? h('span', { class: 'muted' }, `${a.telephones} téléphone${a.telephones > 1 ? 's' : ''} prévenu${a.telephones > 1 ? 's' : ''}`) : null,
      ].filter(Boolean);
      return h('li', {},
        h('span', { class: 'quand' }, a.le ? new Date(a.le).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '?'),
        ...morceaux.flatMap((m, i) => [i ? ' · ' : ' ', m]));
    }));
  };
  const chiffre = (genre, n, texte) => {
    const el = cliquable(stat(String(n), texte), () => montrer(genre));
    el.dataset.genre = genre;
    return el;
  };
  zone.replaceChildren(
    h('h2', {}, `${titre} (${jours} derniers jours)`),
    liste.length
      ? h('div', { class: 'stats compact' }, chiffre('*', liste.length, 'en tout'),
        ...[...parGenre.entries()].sort((x, y) => y[1].length - x[1].length).map(([g, l]) => chiffre(g, l.length, genres[g] || g)))
      : h('p', { class: 'muted small' }, 'Aucune alerte.'),
    detail,
  );
}

// Garde-fous de la tablette (functions/gestion.js, gardeFous) : chaque fois qu'elle s'est remise d'aplomb toute
// seule (écran bloqué, page rechargée, appli relancée, tablette redémarrée), lu dans son journal. Un chiffre par
// sorte, qui ouvre la liste datée (Tanguy, 29/10).
function blocGardeFous(zone, t) {
  const genres = donnees.genresGardeFou;
  zone.hidden = !genres || !t.tabletUid;
  if (zone.hidden) return;
  const liste = t.gardeFous || [];
  const parGenre = new Map();
  for (const g of liste) parGenre.set(g.genre, [...(parGenre.get(g.genre) || []), g]);
  const detail = h('ul', { class: 'alertes-liste small', hidden: true });
  let ouvert = null;
  const montrer = (genre) => {
    ouvert = ouvert === genre ? null : genre;
    detail.hidden = !ouvert;
    zone.querySelectorAll('.stat').forEach((s) => s.classList.toggle('actif', s.dataset.genre === ouvert));
    if (!ouvert) return;
    detail.replaceChildren(...(ouvert === '*' ? liste : parGenre.get(ouvert)).map((g) => h('li', {},
      h('span', { class: 'quand' }, new Date(g.le).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })), ' ',
      ouvert === '*' ? `${genres[g.genre] || g.genre} · ` : '', h('span', { class: 'muted' }, g.texte))));
  };
  const chiffre = (genre, n, texte) => {
    const el = cliquable(stat(String(n), texte), () => montrer(genre));
    el.dataset.genre = genre;
    return el;
  };
  zone.replaceChildren(
    h('h2', {}, 'Garde-fous de la tablette'),
    liste.length
      ? h('div', { class: 'stats compact' }, chiffre('*', liste.length, 'en tout'),
        ...Object.keys(genres).filter((g) => parGenre.has(g)).map((g) => chiffre(g, parGenre.get(g).length, genres[g])))
      : h('p', { class: 'muted small' }, 'Aucun dans son journal.'),
    h('p', { class: 'muted small' }, 'Comptés dans le journal de la tablette (ses 200 dernières lignes).'),
    detail,
  );
}

// ---------- Agir sur une tablette à distance (page de la tablette) ----------
// Les ordres passent par families/{fid}/commands, comme ceux de l'app famille : le serveur réveille la
// tablette par notification (reveilOrdre), elle exécute et écrit le résultat dans le même document. Un
// ordre coûte quelques Ko à la tablette ; rien n'est ajouté à ses tours réguliers. Les « derniers relevés »
// viennent de sa fiche de membre, qu'elle met à jour avec son signal « en ligne » (rien de plus).

let bddAdmin = null;
// Base Firestore : celle d'origine, ou celle que config/base désigne (bascule en Europe), comme admin.js.
async function bdd() {
  if (bddAdmin) return bddAdmin;
  const app = getApp('admin');
  let d = getFirestore(app);
  try {
    const c = (await getDoc(doc(d, 'config', 'base'))).data() || {};
    if (typeof c.database === 'string' && c.database && c.database !== '(default)') d = getFirestore(app, c.database);
  } catch (e) { console.warn('config/base illisible, base d\'origine gardée', e); }
  bddAdmin = d;
  return d;
}

const heure = (d = new Date()) => d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const relieeAUneFamille = (t) => !!(t && t.fid && t.tabletUid);

// Ordres disponibles : { type, titre, sous(t), attente (ms avant « pas de réponse »), confirmer(t) → extra ou null }.
const ORDRES = [
  { type: 'restart', titre: 'Redémarrer', sous: () => 'Elle dit quand Papote est revenue', attente: 240_000,
    confirmer: (t) => demander(`Redémarrer ${nomTablette(t)} ? Elle sera indisponible une minute, puis dira si Papote est bien revenue verrouillée.`, { oui: 'Redémarrer' }).then((ok) => (ok ? {} : null)) },
  { type: 'status', titre: 'État complet maintenant', sous: () => 'Wifi, internet, carte SIM, batterie, version', attente: 120_000 },
  { type: 'journal', titre: 'Lire le journal', sous: () => 'Ses 200 dernières lignes, à l\'instant', attente: 120_000 },
  { type: 'maj', titre: 'Mettre à jour maintenant', sous: (t, m) => (m && m.appVersion ? `Version ${m.appVersion} installée` : 'Vérifie la version publiée'), attente: 120_000 },
  { type: 'recharger', titre: 'Recharger l\'écran', sous: () => 'Si l\'écran semble figé, sans redémarrer', attente: 120_000 },
  { type: 'volumes', titre: 'Volumes', sous: (t, m, f) => (f ? `Général ${f.volume ?? 'auto'} · appel ${f.volumeAppel ?? 100} · sonnerie ${f.volumeSonnerie ?? 100}` : 'Général, appel, sonnerie'), choix: true },
  { type: 'usine', titre: 'Remettre à zéro', sous: () => 'Réglages d\'usine, tout est effacé', attente: 120_000, danger: true },
];
const nomTablette = (t) => (t.ref ? `la tablette ${t.ref}` : 'cette tablette');

// Fiche de membre de la tablette, en direct : en ligne, batterie, carte SIM, version.
function blocReleves(zone, t) {
  if (stopReleves) { stopReleves(); stopReleves = null; }
  membreTablette = null;
  familleTablette = null;
  zone.hidden = !relieeAUneFamille(t);
  if (zone.hidden) return;
  zone.replaceChildren(h('h2', {}, 'Derniers relevés'), h('p', { class: 'muted small' }, 'Lecture de la fiche de la tablette…'));
  const dessiner = () => {
    const m = membreTablette || {};
    const b = m.battery || {};
    const sim = m.sim || null;
    const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v || null);
    const enLigne = ms(m.lastOnline);
    const signal = sim && sim.signal >= 0 ? `${sim.signal} / 4` : null;
    const mo = sim && sim.dataMoisMo >= 0 ? `${sim.dataMoisMo} Mo ce mois` : null;
    zone.replaceChildren(
      h('h2', {}, 'Derniers relevés ', h('span', { class: 'muted small' }, '· envoyés par la tablette avec son signal « en ligne », rien de plus')),
      h('div', { class: 'stats compact' },
        stat(enLigne ? ilYA(enLigne) : '—', 'En ligne', enLigne && Date.now() - enLigne > 70 * 60_000 ? 'ne répond plus ?' : null, enLigne && Date.now() - enLigne > 70 * 60_000 ? 'warn' : null),
        stat(b.level != null ? `${b.level} %` : '—', b.charging ? 'Batterie, sur le chargeur' : 'Batterie, débranchée', null, b.charging === false ? 'warn' : null),
        stat(sim ? (sim.reseau || sim.operateur || 'Carte SIM') : 'Wi-Fi', sim ? [sim.operateur !== sim.reseau ? sim.operateur : null, signal ? `signal ${signal}` : null].filter(Boolean).join(' · ') || 'carte SIM' : 'pas de carte SIM', mo),
        stat(m.appVersion || '—', 'Version de Papote')),
      h('p', { class: 'muted small' }, 'Fiche de la tablette lue en direct : la page se met à jour toute seule quand elle donne de ses nouvelles.'),
    );
    rafraichirSousTitres();
  };
  bdd().then((d) => {
    if ($('dt-releves') !== zone || tabletteOuverte !== t.id) return;
    stopReleves = onSnapshot(doc(d, 'families', t.fid, 'members', t.tabletUid), (snap) => {
      membreTablette = snap.exists() ? snap.data() : {};
      dessiner();
    }, (err) => {
      console.warn('Fiche de la tablette illisible', err);
      zone.replaceChildren(h('h2', {}, 'Derniers relevés'), h('p', { class: 'muted small' }, `Fiche de la tablette illisible (${messageErreur(err)}).`));
    });
    getDoc(doc(d, 'families', t.fid)).then((snap) => { familleTablette = snap.exists() ? snap.data() : {}; rafraichirSousTitres(); }).catch(() => null);
  });
}

// Les sous-titres des boutons (version installée, volumes) suivent les relevés.
function rafraichirSousTitres() {
  const zone = $('dt-agir');
  const t = donnees && donnees.stock.find((x) => x.id === tabletteOuverte);
  if (!t || zone.hidden) return;
  zone.querySelectorAll('button[data-ordre] small').forEach((el) => {
    const o = ORDRES.find((x) => x.type === el.parentElement.dataset.ordre);
    if (o) el.textContent = o.sous(t, membreTablette, familleTablette);
  });
}

// Boutons d'action, chacun avec son retour visible : « Un instant… » puis le résultat daté (ou « pas de réponse »).
function blocAgir(zone, t) {
  if (stopOrdre) { stopOrdre(); stopOrdre = null; }
  zone.hidden = false;
  if (!relieeAUneFamille(t)) {
    zone.replaceChildren(h('h2', {}, 'Agir sur la tablette'),
      h('p', { class: 'muted small' }, 'Cette tablette n\'est pas reliée à une famille : les actions à distance (redémarrer, état, mise à jour…) seront possibles dès qu\'elle sera jumelée.'));
    return;
  }
  const retour = h('div', { class: 'retour-ordre', hidden: true, role: 'status' });
  const detail = h('div', { hidden: true });
  const choix = h('div', { class: 'choix-ordre', hidden: true });
  const grille = h('div', { class: 'agir' });
  const boutons = new Map();
  const occuper = (actif) => boutons.forEach((b) => { b.disabled = actif; });
  const montrer = (texte, classe) => {
    retour.hidden = false;
    retour.className = `retour-ordre ${classe || ''}`;
    retour.textContent = texte;
  };
  for (const o of ORDRES) {
    const b = h('button', { type: 'button', class: `secondary${o.danger ? ' danger' : ''}`, 'data-ordre': o.type },
      o.titre, h('small', {}, o.sous(t, membreTablette, familleTablette)));
    if (o.type === 'usine' && !['revenue', 'perdue', 'a-reparer', 'hors-service'].includes(t.etat)) {
      b.disabled = true;
      b.querySelector('small').textContent = 'Seulement une tablette revenue, perdue, à réparer ou hors service';
    }
    b.addEventListener('click', () => lancerOrdre(o, b));
    boutons.set(o.type, b);
    grille.append(b);
  }
  zone.replaceChildren(
    h('h2', {}, 'Agir sur la tablette'),
    h('p', { class: 'muted small' }, 'La tablette est réveillée tout de suite par notification et répond en général en moins d\'une minute. Chaque action lui coûte quelques Ko.'),
    grille, retour, detail,
  );

  async function lancerOrdre(o, b) {
    detail.hidden = true;
    if (o.type === 'volumes') return choisirVolumes();
    let extra = {};
    if (o.confirmer) {
      extra = await o.confirmer(t);
      if (!extra) return;
    }
    if (o.type === 'usine') {
      const serie = t.numero || t.serieAndroid;
      if (!serie) { prevenir('Le n° de série de cette tablette n\'est pas noté sur sa fiche : impossible de la remettre à zéro à distance (la tablette exige son n° de série).'); return; }
      const saisi = await saisir(`Remettre ${nomTablette(t)} à zéro, à distance ? TOUT est effacé sur la tablette (Papote, photos, réglages) : elle revient comme neuve, à réinstaller.\n\nPour confirmer, retapez son numéro :`, '', { oui: 'Remettre à zéro' });
      if (saisi == null) return;
      if ((saisi || '').trim().toUpperCase() !== String(t.ref || serie).toUpperCase()) { prevenir('Numéro différent : rien n\'a été fait.'); return; }
      extra = { serie };
    }
    await envoyer(o, b, o.type === 'journal' ? 'status' : o.type, extra);
  }

  async function envoyer(o, b, type, extra) {
    occuper(true);
    boutonCharge(b, true);
    const demandeA = heure();
    montrer(`Un instant… « ${o.titre} » demandé à ${demandeA}, la tablette se réveille.`, 'en-attente');
    let ref = null;
    try {
      const d = await bdd();
      const uid = getAuth(getApp('admin')).currentUser.uid;
      ref = doc(collection(d, 'families', t.fid, 'commands'));
      await setDoc(ref, { type, target: t.tabletUid, createdBy: uid, createdAt: serverTimestamp(), state: 'pending', ...extra });
      // Marqueur de changement de la famille : une tablette d'avant la 2.99.99 ne relit ses ordres qu'à ce signal.
      await updateDoc(doc(d, 'families', t.fid), { rev: increment(1) }).catch(() => null);
    } catch (err) {
      occuper(false);
      boutonCharge(b, false);
      montrer(`L'ordre n'a pas pu être envoyé (${messageErreur(err)}).`, 'ko');
      return;
    }
    const fini = (texte, classe) => {
      if (stopOrdre) { stopOrdre(); stopOrdre = null; }
      clearTimeout(minuterie);
      occuper(false);
      boutonCharge(b, false);
      montrer(texte, classe);
    };
    let minuterie = setTimeout(() => {
      fini(`Pas de réponse après ${Math.round((o.attente || 120_000) / 60_000)} min : la tablette est peut-être éteinte ou sans réseau. Elle fera « ${o.titre} » dès qu'elle se reconnectera.`, 'ko');
    }, o.attente || 120_000);
    stopOrdre = onSnapshot(ref, async (snap) => {
      const c = snap.data();
      if (!c || c.state === 'pending') return;
      if (c.state === 'running') { montrer(`${heure()} · ${c.result || 'La tablette redémarre…'} Papote dira quand elle est revenue.`, 'en-attente'); return; }
      const ok = c.state === 'done';
      let texte = c.result || (ok ? 'C\'est fait.' : 'La tablette n\'a pas pu le faire.');
      if (o.type === 'journal' && ok) texte = await montrerJournal(texte);
      fini(`${ok ? '✓' : '✗'} ${heure()} · ${texte}`, ok ? 'ok' : 'ko');
      deleteDoc(ref).catch(() => null); // résultat affiché : l'ordre n'a plus besoin d'être gardé
    }, (err) => fini(`Résultat illisible (${messageErreur(err)}).`, 'ko'));
  }

  // Journal : la tablette vient de l'envoyer avec son état (ordre « status »), on le lit dans families/{fid}/logs.
  async function montrerJournal(etat) {
    try {
      const d = await bdd();
      const snap = await getDoc(doc(d, 'families', t.fid, 'logs', t.tabletUid));
      const lignes = snap.exists() ? snap.get('lines') || '' : '';
      const quand = snap.exists() && snap.get('updatedAt') && snap.get('updatedAt').toDate ? snap.get('updatedAt').toDate() : null;
      detail.hidden = false;
      detail.replaceChildren(
        h('p', { class: 'small muted' }, `Journal de la tablette${quand ? ` (envoyé le ${quand.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })})` : ''} · ${lignes ? lignes.split('\n').length : 0} lignes, la plus récente en bas.`),
        h('pre', { class: 'journal-tablette' }, lignes || 'Journal vide.'));
      return `${etat} Journal reçu, ci-dessous.`;
    } catch (err) {
      return `${etat} Journal illisible (${messageErreur(err)}).`;
    }
  }

  // Volumes (10 à 100) : mêmes réglages que la famille (families/{fid}.volume…), la tablette les relit au réveil.
  function choisirVolumes() {
    const f = familleTablette || {};
    const champ = (nom, valeur, libelle) => {
      const input = h('input', { type: 'number', min: 10, max: 100, step: 5, value: valeur ?? '', name: nom, 'aria-label': libelle, placeholder: 'auto' });
      return [h('label', { class: 'small' }, `${libelle} `, input), input];
    };
    const [lg, ig] = champ('volume', f.volume, 'Général');
    const [la, ia] = champ('volumeAppel', f.volumeAppel ?? 100, 'Appel');
    const [ls, is] = champ('volumeSonnerie', f.volumeSonnerie ?? 100, 'Sonnerie');
    const b = boutons.get('volumes');
    const appliquer = h('button', { type: 'button', class: 'primary small-btn' }, 'Appliquer');
    appliquer.addEventListener('click', async () => {
      const champs = { rev: increment(1) };
      for (const [cle, input] of [['volume', ig], ['volumeAppel', ia], ['volumeSonnerie', is]]) {
        if (input.value === '') continue;
        const v = Number(input.value);
        if (!Number.isInteger(v) || v < 10 || v > 100) { montrer('Chaque volume va de 10 à 100.', 'ko'); return; }
        champs[cle] = v;
      }
      boutonCharge(appliquer, true);
      try {
        const d = await bdd();
        await updateDoc(doc(d, 'families', t.fid), champs);
        familleTablette = { ...f, ...champs, rev: undefined };
        rafraichirSousTitres();
        montrer(`✓ ${heure()} · Volumes enregistrés : la tablette les applique à son réveil (notification envoyée).`, 'ok');
        choix.replaceWith(b);
      } catch (err) {
        montrer(`Volumes non enregistrés (${messageErreur(err)}).`, 'ko');
      } finally {
        boutonCharge(appliquer, false);
      }
    });
    const annuler = h('button', { type: 'button', class: 'secondary small-btn', onclick: () => { choix.replaceWith(b); b.focus(); } }, 'Annuler');
    choix.hidden = false;
    choix.replaceChildren(h('strong', {}, 'Volumes'), lg, la, ls, h('span', { class: 'choix-boutons' }, appliquer, annuler));
    // La saisie remplace le bouton « Volumes » dans la grille, à sa taille ; le bouton revient après.
    b.replaceWith(choix);
  }
}

// Page d'une tablette : informations, achat, documents, historique.
let tabletteOuverte = null;
function ouvrirTablette(id) {
  location.hash = `#tablette/${encodeURIComponent(id)}`;
}
function remplirTablette(id) {
  const t = donnees.stock.find((x) => x.id === id);
  if (!t) {
    $('dt-titre').textContent = 'Tablette introuvable';
    $('dt-infos').replaceChildren(h('dd', {}, 'Elle a peut-être été supprimée.'));
    return;
  }
  // Même tablette déjà affichée : ne pas effacer ce qui est en cours de saisie.
  const f = $('f-tablette');
  tabletteOuverte = t.id;
  f.dataset.charge = t.id;
  const nom = [t.ref, t.numero || t.modele].filter(Boolean).join(' · ') || 'sans nom';
  $('dt-titre').textContent = `Tablette ${nom}`;
  document.title = `Papote · Tablette ${t.ref || ''}`.trim();
  const c = t.commande && donnees.commandes.find((x) => x.id === t.commande);
  // Chaque information se modifie seule (petit crayon) ; l'état change par les boutons d'action.
  const ligne = (k, v) => (v ? [h('dt', {}, k), h('dd', {}, v)] : []);
  const changerTablette = (champs) => enregistrerTablette(() => appeler('gestionStock', { action: 'modifier', id: t.id, champs }));
  const modif = (libelle, affiche, champ, opts = {}) => ligneModifiable(libelle, affiche, { ...opts,
    enregistrer: (v) => changerTablette({ [champ]: v }) });
  // Carte SIM : une ligne du registre libre (avec numéro ou ICCID), ou l'ancienne saisie gardée telle quelle.
  const simsPossibles = donnees.sims.filter((l) => l.id === t.simId || (!l.tablette && l.statut !== 'resiliee' && (l.numero || l.iccid)));
  const actions = actionsTablette(t, c);
  const infos = $('dt-infos');
  if (!(infos.dataset.id === t.id && saisieEnCours(infos))) {
    infos.dataset.id = t.id;
    infos.replaceChildren(
      ...ligne('Où est-elle ?', friseTablette(t, actions.bouton)),
      // Attribuée à une commande par « Préparer l'envoi » (SIM, accessoires, étiquette), pas à la main.
      ...ligne('Commande', c ? h('a', { href: `#commande/${encodeURIComponent(c.id)}` }, `Commande ${codeCommande(c.code)}${c.offerte ? ' (offerte)' : ''}`) : h('span', { class: 'muted' }, 'pas encore attribuée')),
      ...ligne('Client', c && c.email ? h('a', { href: `#client/${encodeURIComponent(c.email.toLowerCase())}` }, c.nom || c.email) : c ? c.nom : null),
      ...(fichesAchetees(t).length
        // Fiche créée à l'installation faute d'achat « En stock » : on choisit la tablette achetée qu'elle est
        // vraiment (la fiche de l'achat prend le T-0… et le n° de série, celle-ci disparaît).
        ? ligneModifiable('Achat', badge('aucun achat lié', 'neutre'), {
          valeur: '', options: [['', 'Choisir la tablette achetée…'], ...fichesAchetees(t).map((x) => [x.id, libelleAchetee(x)])],
          enregistrer: (v) => (v ? enregistrerTablette(async () => {
            await appeler('gestionParcours', { type: 'lier', id: v, ref: t.ref });
            $('f-tablette').dataset.charge = '';
            ouvrirTablette(v);
          }, `${t.ref} rattachée à son achat`, 'Rattachement à l\'achat…') : Promise.resolve(false)),
        })
        : modif('Achat', t.depense ? ligneAchatTablette(t) : badge('aucun achat lié', 'neutre'), 'depense', {
          valeur: t.depense || '', options: optionsAchats(), convertir: (v) => v || null })),
      ...modif('N° de série', t.numero || t.serieAndroid, 'numero', { valeur: t.numero || t.serieAndroid, vide: 'pas encore noté' }),
      ...modif('Modèle', t.modele, 'modele', { valeur: t.modele }),
      ...ligneModifiable('Carte SIM', simDuKit(t), {
        vide: 'aucune', valeur: t.simId || (t.sim ? 'ancienne' : ''),
        options: [['', 'Aucune'], ...(t.sim && !t.simId ? [['ancienne', `${t.sim} (ancienne saisie)`]] : []),
          ...simsPossibles.map((l) => [l.id, [l.numero || `ICCID ${fin4(l.iccid)}`, l.operateur, donnees.statutsSim[l.statut]].filter(Boolean).join(' · ')])],
        enregistrer: (v) => enregistrerTablette(async () => {
          if (v === 'ancienne') return;
          if (v) await appeler('gestionSim', { action: 'modifier', id: v, champs: { tablette: t.id } });
          else if (t.simId) await appeler('gestionSim', { action: 'modifier', id: t.simId, champs: { tablette: null } });
          else if (t.sim) await appeler('gestionStock', { action: 'modifier', id: t.id, champs: { sim: null, simOperateur: null, simCout: null } });
        }),
      }),
      ...ligne('Accessoires', (t.accessoires || []).join(', ')),
      ...modif('Notes', t.notes, 'notes', { valeur: t.notes, long: true, vide: 'aucune' }));
  }
  afficherDocumentsTablette(t);
  // Relevés en direct et actions à distance : redessinés seulement si on change de tablette (un ordre en
  // cours garde son retour affiché quand les données se relisent).
  const cleAgir = [t.id, t.fid || '', t.tabletUid || '', t.etat || ''].join('|');
  if ($('dt-agir').dataset.id !== cleAgir) {
    $('dt-agir').dataset.id = cleAgir;
    blocReleves($('dt-releves'), t);
    blocAgir($('dt-agir'), t);
  }
  afficherBatterie(t);
  blocAlertes($('dt-alertes'), (donnees.alertes || []).filter((a) => a.fiche === t.id), { titre: 'Alertes de cette tablette' });
  blocGardeFous($('dt-gardefous'), t);
  $('dt-historique').replaceChildren(...historiqueLisible(t).reverse().map(([le, texte]) => h('li', {},
    h('span', { class: 'quand' }, new Date(le).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })), ' ', texte)));
  if (!$('dt-historique').children.length) $('dt-historique').append(h('li', {}, 'Rien de noté pour l\'instant.'));
  $('dt-actions').replaceChildren(actions.menu);
  f.querySelector('.f-msg').hidden = true;
}

// Où en est la tablette : les étapes de son parcours habituel, l'étape actuelle en couleur.
// Hors de ce parcours (retour, réparation, perdue…), son état seul.
const PARCOURS_TABLETTE = [['commandee', 'Commandée'], ['en-stock', 'En stock'], ['preparee', 'Préparée'], ['envoyee', 'Envoyée'], ['chez-client', 'Chez le client']];
// bouton : l'action qui fait passer à l'étape suivante, placée juste après l'étape actuelle.
function friseTablette(t, bouton) {
  const etat = etatTablette(t);
  const i = PARCOURS_TABLETTE.findIndex(([k]) => k === etat);
  if (i < 0) {
    return h('div', { class: 'frise-tablette' },
      badge(donnees.etats[etat] || etat, ['perdue', 'hors-service', 'a-reparer'].includes(etat) ? 'ko' : 'info'), bouton);
  }
  // Étapes en ronds reliés (✓ pour les étapes passées), l'action suivante en dessous.
  return h('div', { class: 'etapes-tablette' },
    h('ol', { class: 'stepper' }, ...PARCOURS_TABLETTE.map(([, texte], j) => h('li', {
      class: j < i ? 'fait' : j === i ? 'actuelle' : null, 'aria-current': j === i ? 'step' : null,
    }, h('span', { class: 'rond', 'aria-hidden': 'true' }, j < i ? '✓' : String(j + 1)), h('span', { class: 'libelle' }, texte)))),
    bouton ? h('div', { class: 'etape-action' }, bouton) : null);
}

// Changements d'état permis, en miroir de SUITES dans functions/gestion.js.
const SUITES = {
  commandee: ['en-stock'],
  'en-stock': ['preparee', 'envoyee', 'a-reparer', 'hors-service', 'perdue'],
  preparee: ['en-stock', 'envoyee', 'a-reparer', 'hors-service', 'perdue'],
  envoyee: ['chez-client', 'en-retour', 'revenue', 'perdue'],
  'chez-client': ['en-retour', 'revenue', 'perdue', 'hors-service'],
  'en-retour': ['revenue', 'perdue'],
  revenue: ['en-stock', 'a-reparer', 'hors-service', 'perdue'],
  'a-reparer': ['en-stock', 'hors-service', 'perdue'],
  perdue: ['revenue'],
  'hors-service': [],
};
const transitionPermise = (de, vers) => de === vers || !de || (SUITES[de] || []).includes(vers);

// Historique en phrases : [date, texte], du plus ancien au plus récent, sans les doublons sans information.
function historiqueLisible(t) {
  const lignes = [];
  let avant = null;
  for (const x of (t.historique || []).filter((y) => y.le).sort((a, b) => a.le - b.le)) {
    const c = x.commande && donnees.commandes.find((y) => y.id === x.commande);
    const pour = c ? ` (commande ${codeCommande(c.code)})` : '';
    let texte = null;
    if (avant && x.etat === avant) {
      if (x.sim) texte = `Carte SIM ${x.sim} mise dedans`;
      else if (x.accessoires && x.accessoires.length) texte = `${x.remplacement ? 'Remplacement envoyé' : 'Accessoires'} : ${x.accessoires.join(', ')}`;
      else if (x.motif) texte = x.motif.charAt(0).toUpperCase() + x.motif.slice(1);
    } else {
      texte = {
        commandee: 'Commandée chez le vendeur',
        'en-stock': !avant ? 'Ajoutée au stock' : avant === 'commandee' ? 'Reçue du vendeur, mise en stock'
          : avant === 'revenue' ? 'Vérifiée, remise en stock' : avant === 'a-reparer' ? 'Réparée, remise en stock'
            : x.motif === 'commande annulée' || x.motif === 'commande offerte annulée' ? 'Libérée : commande annulée' : 'Remise en stock',
        preparee: `Préparée pour l'envoi${pour}`,
        envoyee: x.remplacement ? `Envoyée en remplacement${pour}` : `Envoyée au client${pour}`,
        'chez-client': `Reçue par le client${pour}`,
        'en-retour': `Sur le chemin du retour${pour}`,
        revenue: avant === 'perdue' ? 'Retrouvée, à vérifier' : `Revenue, à vérifier${pour}`,
        'a-reparer': 'Mise à réparer',
        'hors-service': 'Déclarée hors service',
        perdue: 'Déclarée perdue',
      }[x.etat] || donnees.etats[x.etat] || x.etat;
      if (x.motif && !/annulée|reçue/.test(x.motif) && !texte.includes(x.motif)) texte += ` : ${x.motif}`;
    }
    if (texte) lignes.push([x.le, texte]);
    avant = x.etat;
  }
  return lignes;
}

async function ajouterFichierTablette(t) {
  const genre = await choisirGenre();
  if (!genre) return;
  const fichiers = await prendreFichiers(genre);
  if (!fichiers.length) return;
  // La facture d'achat va avec l'achat (dépense) quand il existe : elle y sert aussi pour la comptabilité.
  const [collection, id] = genre === 'facture' && t.depense ? ['depenses', t.depense] : ['stock', t.id];
  await enregistrerTablette(() => envoyerPieces(collection, id, fichiers, genre), fichiers.length > 1 ? 'Fichiers ajoutés' : 'Fichier ajouté', fichiers.length > 1 ? 'Envoi des fichiers…' : 'Envoi du fichier…');
}

// Documents propres à la tablette (la facture d'achat est montrée avec l'achat).
function afficherDocumentsTablette(t) {
  // Tous les documents au même endroit : ceux de l'achat (facture, confirmation) puis ceux de la tablette.
  const achat = t.depense && donnees.depenses.find((d) => d.id === t.depense);
  const genre = (p, deLAchat) => (p.genre ? GENRES_PIECE[p.genre]
    : deLAchat ? (/confirmation/i.test(p.nom) ? 'Confirmation de commande' : 'Facture d\'achat') : 'Document');
  const docs = [...((achat && achat.pieces) || []).map((p) => [p, 'depenses', achat.id, true]),
    ...(t.pieces || []).map((p) => [p, 'stock', t.id, false])];
  $('dt-pieces').replaceChildren(...docs.map(([p, collection, id, deLAchat]) => h('li', {},
    h('span', { class: 'muted' }, `${genre(p, deLAchat)} : `), lienPiece(p),
    h('button', { type: 'button', class: 'crayon no-print', title: `Retirer « ${p.nom} »`, 'aria-label': `Retirer « ${p.nom} »`, onclick: () => retirerPiece(collection, id, p) }, '✕'))));
  if (!$('dt-pieces').children.length) $('dt-pieces').append(h('li', { class: 'muted small' }, 'Aucun document pour l\'instant.'));
}

// Colonne « Achat » de la liste du stock : la commande chez le vendeur (Tanguy, 2026-10-22 : chaque tablette
// doit en avoir une), en rouge si elle manque. Le lien ouvre l'achat, pas la tablette.
function celluleAchat(t) {
  if (!t.depense) return badge('aucun achat lié', 'neutre');
  const achat = donnees.depenses.find((d) => d.id === t.depense);
  const texte = [t.fournisseur || (achat && achat.fournisseur), achat && achat.numero ? `n° ${achat.numero}` : null]
    .filter(Boolean).join(' ') || 'voir l\'achat';
  return h('a', { href: `#depense/${encodeURIComponent(t.depense)}`, onclick: (e) => e.stopPropagation() }, texte);
}

// Achats possibles pour un lien (les plus récents d'abord) : [id, libellé] pour une liste déroulante.
// Tablette créée par l'installation sans achat (T-0… sans prix) : les fiches d'achat encore libres
// (« Commandée » ou « En stock », pas installées, sans commande) qu'elle peut être.
function fichesAchetees(t) {
  if (!t.ref || t.depense || t.prixAchat != null || t.acheteeLe || t.commande) return [];
  return donnees.stock.filter((x) => x.id !== t.id && ['commandee', 'en-stock'].includes(x.etat) && !x.ref && !x.serieAndroid
    && !x.commande && (x.depense || x.prixAchat != null || x.acheteeLe));
}
const libelleAchetee = (x) => [x.modele || 'Tablette', x.fournisseur, x.acheteeLe ? `achetée le ${jour(x.acheteeLe)}` : null,
  donnees.etats[x.etat] || x.etat, x.numero ? `n° ${x.numero}` : null].filter(Boolean).join(' · ');

function optionsAchats(premier = 'Aucun achat lié') {
  return [['', premier], ...[...donnees.depenses].sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, 150)
    .map((d) => [d.id, [jour(d.date), [d.fournisseur, d.numero ? `n° ${d.numero}` : null].filter(Boolean).join(' '), d.libelle, euros(d.montant)]
      .filter(Boolean).join(' · ')])];
}
// Lien vers un achat (vendeur et n° de commande), ou le badge rouge s'il n'y en a pas.
function lienAchat(id) {
  if (!id) return badge('aucun achat lié', 'neutre');
  const d = donnees.depenses.find((x) => x.id === id);
  return h('a', { href: `#depense/${encodeURIComponent(id)}`, onclick: (e) => e.stopPropagation() },
    (d && ([d.fournisseur, d.numero ? `n° ${d.numero}` : null].filter(Boolean).join(' ') || d.libelle)) || 'voir l\'achat');
}

// Achat de la tablette, en une ligne de la fiche : vendeur, prix, date, et si la facture manque encore.
// Le détail est sur la page de l'achat.
function ligneAchatTablette(t) {
  if (!t.depense) {
    return h('span', { class: 'muted' }, 'inconnu : transférez la facture du vendeur à factures@mapapote.fr');
  }
  const achat = donnees.depenses.find((d) => d.id === t.depense);
  return h('span', {},
    h('a', { href: `#depense/${encodeURIComponent(t.depense)}` },
      [t.fournisseur || (achat && achat.fournisseur), t.prixAchat != null ? euros(t.prixAchat) : null, t.acheteeLe ? `le ${jour(t.acheteeLe)}` : null]
        .filter(Boolean).join(', ') || 'voir l\'achat'),
    achat && achat.confirmation ? [' ', badge('facture pas encore reçue', 'info')] : null);
}

// Actions de la page tablette hors formulaire : l'erreur s'affiche même si le formulaire est replié.
// texte : carte « … en cours » pour les actions du ⋮ et de la frise (un crayon a déjà sa roue dans son bouton).
async function enregistrerTablette(action, annonce, texte) {
  const f = $('f-tablette');
  const ok = texte ? await patienter(texte, () => enregistrer(f, action, annonce)) : await enregistrer(f, action, annonce);
  if (!ok && f.hidden) prevenir(f.querySelector('.f-msg').textContent);
  return ok;
}

async function detacherAchat() {
  if (!await demander('Cet achat a été rattaché à la mauvaise tablette ? Le prix, la date et la facture quittent cette fiche et passent sur une nouvelle tablette « En stock » (celle qui arrivera). Rien n\'est supprimé : la dépense reste dans la comptabilité.', { oui: 'Détacher l\'achat' })) return;
  await enregistrerTablette(async () => {
    const r = await appeler('gestionStock', { action: 'detacherAchat', id: tabletteOuverte });
    $('f-tablette').dataset.charge = '';
    if (r && r.id) ouvrirTablette(r.id);
  }, 'Achat détaché', 'Détachement de l\'achat…');
}

$('f-tablette').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const t = donnees.stock.find((x) => x.id === tabletteOuverte);
  const simId = f.simId.value;
  const ok = await enregistrer(f, async () => {
    await appeler('gestionStock', {
      action: 'modifier',
      id: tabletteOuverte,
      champs: {
        numero: f.numero.value, modele: f.modele.value, etat: f.etat.value, commande: f.commande.value || null,
        notes: f.notes.value,
        // Ancienne saisie retirée : la fiche n'a plus de ligne.
        ...(simId === '' && t.sim && !t.simId ? { sim: null, simOperateur: null, simCout: null } : {}),
      },
    });
    f.dataset.charge = '';
    if (simId && simId !== 'ancienne' && simId !== t.simId) {
      await appeler('gestionSim', { action: 'modifier', id: simId, champs: { tablette: tabletteOuverte } });
    } else if (!simId && t.simId) {
      await appeler('gestionSim', { action: 'modifier', id: t.simId, champs: { tablette: null } });
    }
  });
  if (ok) f.hidden = true;
});

// Actions de la tablette selon où elle en est : l'étape suivante en bouton, le reste dans le ⋮.
function actionsTablette(t, c) {
  const changer = (etat, question, champs = {}) => async () => {
    if (question && !await demander(question, { oui: 'Confirmer' })) return;
    await enregistrerTablette(() => appeler('gestionStock', { action: 'modifier', id: t.id, champs: { etat, ...champs } }), 'Tablette mise à jour', 'Changement d\'état…');
  };
  const nom = t.ref || t.numero || 'cette tablette';
  const retour = c && c.restitution && ['attendue', 'echec', 'a-recuperer'].includes(c.restitution.statut);
  let principal = null;
  if (t.etat === 'commandee') {
    // La vraie réception : vérification du carton, n° de série, installation ; elle passe « En stock » au passage.
    principal = ['Le colis est arrivé', () => recevoirTablette(t.id)];
  } else if (['en-stock', 'preparee'].includes(t.etat) && c && c.expedition === 'a-preparer') {
    principal = ['Préparer l\'envoi', (e) => document.dispatchEvent(new CustomEvent('papote:preparer-envoi', { detail: { commande: c, bouton: e.currentTarget } }))];
  } else if (['envoyee', 'chez-client', 'en-retour'].includes(t.etat) && retour) {
    // Le colis se coche sur la page de la commande (ce qui manque y est prélevé au client).
    principal = ['Tablette revenue', () => { location.hash = `#commande/${encodeURIComponent(c.id)}`; }];
  } else if (t.etat === 'revenue') {
    principal = ['Vérifiée, remettre en stock', changer('en-stock', `${nom} est vérifiée et prête à repartir ? Elle redevient libre dans le stock.`, { commande: null })];
  } else if (t.etat === 'a-reparer') {
    principal = ['Réparée, remettre en stock', changer('en-stock', `${nom} est réparée ? Elle redevient libre dans le stock.`, { commande: null })];
  }
  const jamaisServi = t.etat === 'en-stock' && !t.commande && (t.historique || []).length <= 1;
  const peut = (etat) => t.etat !== etat && transitionPermise(t.etat, etat);
  const menu = menuPoints([
    { libelle: 'Ajouter un fichier', faire: () => ajouterFichierTablette(t) },
    t.depense ? { libelle: 'Détacher l\'achat (mauvaise tablette)', faire: detacherAchat } : null,
    t.etat === 'perdue' ? { libelle: 'Retrouvée', faire: changer('revenue', `${nom} est retrouvée ? Elle passe « Revenue », à vérifier avant de repartir.`) } : null,
    peut('a-reparer') ? { libelle: 'Mettre à réparer', faire: changer('a-reparer', `Mettre ${nom} à réparer ? Elle ne repart plus tant qu'elle n'est pas réparée.`) } : null,
    peut('hors-service') ? { libelle: 'Déclarer hors service', danger: true, faire: changer('hors-service', `${nom} est hors service ? Elle sort du parc et ne pourra plus être jumelée.`) } : null,
    peut('perdue') ? { libelle: 'Déclarer perdue', danger: true, faire: changer('perdue', `${nom} est perdue ? Elle sort du parc et ne pourra plus être jumelée.`) } : null,
    jamaisServi ? { libelle: 'Supprimer la fiche (créée par erreur)', danger: true, faire: supprimerFicheTablette } : null,
  ], `Actions pour ${nom}`);
  // L'étape suivante se place dans la frise « Où est-elle ? », le reste dans le ⋮ en haut.
  return { bouton: principal ? h('button', { type: 'button', class: 'primary small-btn no-print', onclick: principal[1] }, principal[0], ' ›') : null, menu };
}
$('dt-annuler').addEventListener('click', () => {
  const f = $('f-tablette');
  f.hidden = true;
  f.dataset.charge = '';
  remplirTablette(tabletteOuverte);
});

async function supprimerFicheTablette() {
  if (!await demander('Supprimer cette fiche du stock ? À faire seulement si la tablette n\'existe pas.', { oui: 'Supprimer la fiche', danger: true })) return;
  const ok = await enregistrerTablette(async () => {
    await appeler('gestionStock', { action: 'supprimer', id: tabletteOuverte });
  }, 'Fiche supprimée', 'Suppression de la fiche…');
  if (ok) location.hash = '#stock/tablettes';
}

async function retirerPiece(collection, id, piece) {
  if (!await demander(`Retirer « ${piece.nom} » ?`, { oui: 'Retirer', danger: true })) return;
  try {
    await patienter('Retrait du fichier…', async () => {
      await appeler('gestionPiece', { action: 'retirer', collection, id, chemin: piece.chemin });
      donnees = await lireDonnees(true);
    });
    annoncer('Fichier retiré');
    afficherTout();
    if (collection === 'stock') afficherFiche();
  } catch (e) {
    prevenir(messageErreur(e));
  }
}

// ---------- Factures ----------

function afficherFactures() {
  const toutes = stripe.factures.slice().sort((a, b) => b.le - a.le);
  const filtre = $('filtre-factures').value;
  const liste = toutes.filter((f) => !filtre || f.statut === filtre);
  const somme = (l, k) => l.reduce((s, f) => s + (f[k] || 0), 0);
  const ouvertes = toutes.filter((f) => f.statut === 'open');
  $('kpi-factures').replaceChildren(
    stat(String(toutes.filter((f) => f.statut !== 'draft' && f.statut !== 'void').length), 'factures émises'),
    stat(euros(somme(toutes.filter((f) => f.statut === 'paid'), 'total')), 'facturé et payé'),
    stat(euros(somme(ouvertes, 'du')), 'reste à encaisser', pluriel(ouvertes.length, 'facture'), ouvertes.length ? 'neg' : null),
  );
  const parAbonnement = new Map(donnees ? donnees.commandes.map((c) => [c.id, c]) : []);
  remplirTable($('t-factures'), [
    { titre: 'N°' }, { titre: 'Date' }, { titre: 'Client' }, { titre: 'Détail' }, { titre: 'HT', n: 1 },
    { titre: 'TVA', n: 1 }, { titre: 'TTC', n: 1 }, { titre: 'Statut' }, { titre: '' },
  ], liste.map((f) => {
    const [texte, classe] = STATUTS_FACTURE[f.statut] || [f.statut, ''];
    const c = parAbonnement.get(f.abonnement);
    return {
      onclick: c ? () => ouvrirCommande(c) : null,
      cellules: [f.numero || '—', jour(f.le), h('div', {}, f.client || '', h('div', { class: 'muted' }, f.email || '')),
        f.lignes, euros(f.ht), euros(f.tva), euros(f.total), badge(texte, classe),
        f.lienPdf ? h('a', { href: f.lienPdf, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, 'PDF') : ''],
    };
  }), {
    total: liste.length ? ['Total', '', '', '', euros(somme(liste, 'ht')), euros(somme(liste, 'tva')), euros(somme(liste, 'total')), '', ''] : null,
  });
}
$('filtre-factures').addEventListener('change', afficherFactures);

function exporterFactures() {
  csv('factures', ['N°', 'Date', 'Client', 'E-mail', 'Détail', 'HT', 'TVA', 'TTC', 'Payé', 'Reste dû', 'Statut', 'Lien PDF'],
    stripe.factures.slice().sort((a, b) => a.le - b.le).map((f) => [f.numero, jour(f.le), f.client, f.email, f.lignes,
      csvMontant(f.ht), csvMontant(f.tva), csvMontant(f.total), csvMontant(f.paye), csvMontant(f.du),
      (STATUTS_FACTURE[f.statut] || [f.statut])[0], f.lienPdf]));
}
$('x-factures').addEventListener('click', exporterFactures);

// ---------- Comptabilité ----------

function afficherBilan() {
  const t = totaux(stripe.mouvements, depensesPeriode());
  $('kpi-argent').replaceChildren(
    stat(euros(t.encaisse), 'encaissé', pluriel(stripe.mouvements.filter((m) => ENCAISSEMENTS.includes(m.nature)).length, 'paiement')),
    stat(euros(t.rembourse), 'remboursé'),
    stat(euros(t.frais), 'frais Stripe'),
    stat(euros(t.depenses), 'dépenses'),
    stat(euros(t.resultat), 'résultat', null, t.resultat < 0 ? 'neg' : null),
  );
  const abos = stripe.abonnements;
  const enCours = abos.filter((a) => ['active', 'trialing', 'past_due'].includes(a.statut));
  const mrr = enCours.filter((a) => a.statut !== 'trialing').reduce((s, a) => s + a.mensuel, 0);
  const commandes = donnees.commandes.filter((c) => dansPeriode(c.creeLe));
  $('kpi-activite').replaceChildren(
    stat(String(enCours.length), 'abonnements en cours',
      `${enCours.filter((a) => a.statut === 'trialing').length} au premier mois · ${enCours.filter((a) => a.statut === 'past_due').length} impayé(s)`),
    stat(euros(mrr), 'revenu mensuel', 'abonnements payants'),
    stat(String(commandes.length), 'commandes', `${commandes.filter((c) => c.formule === 'sim').length} tout compris`),
    stat(String(abos.filter((a) => dansPeriode(a.finLe)).length), 'abonnements terminés'),
  );
  const montant = (c) => h('span', { class: c < 0 ? 'neg' : null }, euros(c));
  remplirTable($('t-bilan'), [
    { titre: 'Mois' }, { titre: 'Encaissé', n: 1 }, { titre: 'Remboursé', n: 1 }, { titre: 'Frais Stripe', n: 1 },
    { titre: 'Net', n: 1 }, { titre: 'Dépenses', n: 1 }, { titre: 'Résultat', n: 1 },
  ], bilanMensuel().map((l) => [moisNom(l.cle), euros(l.encaisse), euros(l.rembourse), euros(l.frais), euros(l.net),
    euros(l.depenses), montant(l.resultat)]),
  { total: ['Total', euros(t.encaisse), euros(t.rembourse), euros(t.frais), euros(t.net), euros(t.depenses), montant(t.resultat)] });
}

const NATURES = {
  abonnement: 'Abonnement Papote',
  'tablette-non-rendue': 'Matériel non rendu',
  remboursement: 'Remboursement',
  litige: 'Contestation bancaire',
  virement: 'Virement vers la banque',
  frais: 'Frais Stripe',
  autre: 'Autre',
};

function numeroFacture(id) {
  const f = id && stripe.factures.find((x) => x.id === id);
  return f ? f.numero : '';
}

let fichierDepense = null; // dépense à laquelle ajouter une pièce
const choixFichier = h('input', { type: 'file', accept: 'application/pdf,image/*', multiple: true, hidden: true });
document.body.append(choixFichier);
choixFichier.addEventListener('change', async () => {
  const fichiers = [...choixFichier.files];
  choixFichier.value = '';
  if (!fichiers.length || !fichierDepense) return;
  try {
    await envoyerPieces('depenses', fichierDepense, fichiers);
    donnees = await lireDonnees(true);
    afficherTout();
  } catch (e) {
    prevenir(messageErreur(e));
  }
});

function afficherCompta() {
  const deps = depensesPeriode();
  remplirTable($('t-achats'), [
    { titre: 'Date' }, { titre: 'Fournisseur' }, { titre: 'Libellé' }, { titre: 'Catégorie' }, { titre: 'TTC', n: 1 },
    { titre: 'dont TVA', n: 1 }, { titre: 'Justificatifs' }, { titre: '' },
  ], deps.map((d) => ({ onclick: ouvrirDepense(d), cellules: [jour(d.date), d.fournisseur || '', libelleDepense(d), donnees.categories[d.categorie] || d.categorie,
    euros(d.montant), euros(d.tva),
    h('div', { class: 'pieces-liste' }, (d.pieces || []).map(lienPiece),
      d.justificatif ? h('a', { href: d.justificatif, target: '_blank', rel: 'noopener' }, 'Lien') : null),
    h('div', { class: 'no-print' }, menuPoints([
      { libelle: 'Joindre un justificatif', faire: () => { fichierDepense = d.id; choixFichier.click(); } },
      d.recurrence ? { libelle: 'Ne plus l\'ajouter chaque mois', faire: () => arreterDepense(d) } : null,
      { libelle: 'Supprimer la dépense', danger: true, faire: () => supprimerDepense(d) },
    ], `Actions pour « ${d.libelle} »`))] })),
  {
    total: deps.length ? ['Total', '', '', '', euros(deps.reduce((s, d) => s + d.montant, 0)),
      euros(deps.reduce((s, d) => s + (d.tva || 0), 0)), '', ''] : null,
    vide: 'Aucune dépense sur cette période.',
  });

  const parCat = {};
  for (const d of deps) parCat[d.categorie] = (parCat[d.categorie] || 0) + d.montant;
  const cats = Object.entries(parCat).sort((a, b) => b[1] - a[1]);
  if (cats.length) {
    remplirTable($('t-categories'), [{ titre: 'Par catégorie' }, { titre: 'Montant', n: 1 }],
      cats.map(([k, v]) => [donnees.categories[k] || k, euros(v)]));
  } else {
    $('t-categories').replaceChildren();
  }

  const lignes = recettes().sort((a, b) => a.le - b.le);
  const somme = (k) => lignes.reduce((s, m) => s + m[k], 0);
  const signe = (c) => h('span', { class: c < 0 ? 'neg' : null }, euros(c));
  remplirTable($('t-recettes'), [
    { titre: 'Date' }, { titre: 'Facture' }, { titre: 'Client' }, { titre: 'Nature' },
    { titre: 'Montant', n: 1 }, { titre: 'Frais', n: 1 }, { titre: 'Net', n: 1 },
  ], lignes.map((m) => [jour(m.le), numeroFacture(m.facture), m.client || m.email || '', NATURES[m.nature] || m.nature,
    signe(m.montant), euros(m.frais), signe(m.net)]),
  { total: lignes.length ? ['Total', '', '', '', signe(somme('montant')), euros(somme('frais')), signe(somme('net'))] : null });

  const virements = stripe.mouvements.filter((m) => m.nature === 'virement').sort((a, b) => a.le - b.le);
  remplirTable($('t-virements'), [{ titre: 'Date' }, { titre: 'Arrivée prévue' }, { titre: 'Montant', n: 1 }],
    virements.map((m) => [jour(m.le), jour(m.disponibleLe), euros(-m.montant)]),
    { vide: 'Aucun virement sur cette période.' });
}

// Stock > Achats : les commandes passées chez les vendeurs (tablettes et matériel), séparées des tablettes.
function afficherAchats() {
  const achats = donnees.depenses.filter((d) => ['tablettes', 'materiel'].includes(d.categorie) || (d.materiel || []).length)
    .sort((a, b) => (b.date || 0) - (a.date || 0));
  remplirTable($('t-achats-vendeurs'), [
    { titre: 'Date' }, { titre: 'Vendeur' }, { titre: 'Ce qui a été acheté' }, { titre: 'N° de commande' },
    { titre: 'Montant', n: 1 }, { titre: 'Facture' }, { titre: 'Tablettes' },
  ], achats.map((d) => {
    const tablettes = donnees.stock.filter((t) => t.depense === d.id);
    return { onclick: ouvrirDepense(d), cellules: [
      jour(d.date), d.fournisseur || '', d.libelle || '', d.numero || '', euros(d.montant),
      h('div', {}, d.confirmation ? badge('pas encore reçue', 'info') : badge('reçue', 'ok'),
        ...((d.pieces || []).map((p) => h('div', {}, lienPiece(p))))),
      h('div', {}, ...tablettes.map((t) => h('div', {}, h('a', { href: `#tablette/${encodeURIComponent(t.id)}` },
        t.ref || t.numero || 'tablette')))),
    ] };
  }), { vide: 'Aucun achat enregistré.' });
}

// Ligne de tableau → page de la dépense (sauf un clic sur un lien, un bouton ou le ⋮ de la ligne).
const ouvrirDepense = (d) => (e) => {
  if (e && e.target && e.target.closest && e.target.closest('a, button, input, .menu-points')) return;
  location.hash = `#depense/${encodeURIComponent(d.id)}`;
};

const ACHATS = ['tablettes', 'materiel'];

// Page d'une dépense : pour un achat chez un vendeur, sa commande (n°, facture, tablettes reçues).
function remplirPageDepense(id) {
  const zone = $('dd-corps');
  const d = donnees.depenses.find((x) => x.id === id);
  if (!d) {
    zone.replaceChildren(h('div', { class: 'card' }, h('p', {}, 'Dépense introuvable (supprimée ?).')));
    return;
  }
  const achat = ACHATS.includes(d.categorie) || (d.materiel || []).length;
  const titre = achat ? `Achat chez ${d.fournisseur || 'le vendeur'}` : d.libelle || 'Dépense';
  $('titre-page').textContent = achat ? 'Achat' : 'Dépense';
  document.title = `Papote · ${titre}`;
  const ligne = (k, v) => (v ? [h('dt', {}, k), h('dd', {}, v)] : []);
  if (saisieEnCours(zone)) return;
  const modif = (libelle, affiche, champ, opts = {}) => ligneModifiable(libelle, affiche, { ...opts,
    enregistrer: (v) => modifierDepense(d, { [champ]: v }) });
  const tablettes = donnees.stock.filter((t) => t.depense === d.id);
  const sims = donnees.sims.filter((l) => l.depense === d.id);
  const pieces = [...(d.pieces || []).map(lienPiece),
    d.justificatif ? h('a', { href: d.justificatif, target: '_blank', rel: 'noopener' }, 'Lien') : null].filter(Boolean);
  const valider = d.aVerifier ? h('button', { type: 'button', class: 'primary small-btn no-print', onclick: () => verifierDepense(d) }, 'Valider') : null;
  zone.replaceChildren(...[
    h('div', { class: 'card' },
      h('div', { class: 'tete-fiche' }, h('h2', {}, titre),
        h('div', { class: 'tete-actions' }, valider, h('div', { class: 'no-print' }, menuPoints([
          { libelle: 'Joindre un justificatif', faire: () => { fichierDepense = d.id; choixFichier.click(); } },
          d.recurrence ? { libelle: 'Ne plus l\'ajouter chaque mois', faire: () => arreterDepense(d) } : null,
          { libelle: 'Supprimer la dépense', danger: true, faire: async () => { if (await supprimerDepense(d)) location.hash = '#compta/depenses'; } },
        ], `Actions pour « ${d.libelle} »`)))),
      d.aVerifier ? h('p', { class: 'small a-verifier' }, badge('à vérifier', 'ko'), ' ', sourceDepense(d), ' : vérifiez le montant, la date et le vendeur, puis validez.') : null,
      h('dl', { class: 'fiche' },
        // Chaque information se corrige avec son crayon (facture mal lue, faute de frappe).
        ...modif('Date', jour(d.date), 'date', { valeur: dateChamp(d.date), type: 'date', convertir: (v) => {
          if (!v) throw new Error('Date manquante.');
          return dateSaisie(v);
        } }),
        ...modif('Vendeur', d.fournisseur, 'fournisseur', { valeur: d.fournisseur || '' }),
        ...modif(achat ? 'Ce qui a été acheté' : 'Libellé', d.libelle, 'libelle', { valeur: d.libelle || '' }),
        ...modif('N° de commande', d.numero, 'numero', { valeur: d.numero || '', vide: 'aucun' }),
        ...modif('Catégorie', donnees.categories[d.categorie] || d.categorie, 'categorie', { valeur: d.categorie, options: Object.entries(donnees.categories) }),
        ...modif('Montant TTC', euros(d.montant), 'montant', { valeur: enEuros(d.montant), mode: 'decimal', suffixe: '€', convertir: (v) => {
          const c = convertirEuros(v);
          if (!c) throw new Error('Montant manquant.');
          return c;
        } }),
        ...modif('dont TVA', d.tva != null ? euros(d.tva) : null, 'tva', { valeur: enEuros(d.tva), mode: 'decimal', suffixe: '€', vide: 'aucune',
          convertir: (v) => (String(v).trim() ? convertirEuros(v) : null) }),
        // Facture ajoutée d'ici, d'un bouton visible (Tanguy, 29/10 : « je ne peux pas ajouter une facture »).
        ligne('Facture', h('div', { class: 'facture-achat' }, d.confirmation
          ? h('span', {}, badge('pas encore reçue', 'info'), ' ', h('span', { class: 'muted small' }, 'seule la confirmation de commande est arrivée : ajoutez la facture ici, ou transférez-la à factures@mapapote.fr'))
          : pieces.length ? badge('reçue', 'ok') : h('span', { class: 'muted' }, 'aucun justificatif'),
        h('button', { type: 'button', class: 'secondary small-btn no-print', id: 'dd-ajouter-facture', onclick: () => { fichierDepense = d.id; choixFichier.click(); } },
          d.confirmation || !pieces.length ? 'Ajouter la facture' : 'Ajouter un document'))),
        ligne('Justificatifs', pieces.length ? h('div', { class: 'pieces-liste' }, pieces) : null),
        ...(d.categorie === 'sim' && !sims.length ? modif('Carte SIM rechargée', simDe(d.sim), 'sim', { valeur: d.sim || '', vide: 'aucune',
          options: [['', 'Aucune'], ...donnees.sims.filter((l) => l.statut !== 'resiliee' || l.id === d.sim)
            .map((l) => [l.id, [l.operateur, l.numero || fin4(l.iccid)].filter(Boolean).join(' · ') || 'Carte SIM'])],
          convertir: (v) => v || null }) : []),
        ligne('Chaque mois', d.recurrence ? 'oui, ajoutée automatiquement chaque mois' : null),
        ligne('Entré au stock', (d.materiel || []).length ? d.materiel.join(', ') : null))),
    // Ce que l'achat a fait entrer : les tablettes (achat de tablettes) ou les cartes SIM, chacune vers sa page.
    sims.length ? h('div', { class: 'card' }, h('h2', {}, sims.length > 1 ? `Les ${sims.length} cartes SIM de cet achat` : 'La carte SIM de cet achat'),
      h('ul', { class: 'liste-liens' }, ...sims.map((l) => h('li', {}, h('span', { class: 'll-quoi' }, 'Carte SIM'),
        h('a', { href: `#sim/${encodeURIComponent(l.id)}` }, l.numero || (l.iccid ? `ICCID ${fin4(l.iccid)}` : 'numéro à saisir')),
        h('span', { class: 'muted small' }, donnees.statutsSim[l.statut] || l.statut))))) : null,
    achat && (d.categorie === 'tablettes' || tablettes.length) ? h('div', { class: 'card' }, h('h2', {}, tablettes.length > 1 ? 'Tablettes de cet achat' : 'Tablette de cet achat'),
      tablettes.length ? h('ul', { class: 'liste-liens' }, ...tablettes.map((t) => h('li', {}, h('span', { class: 'll-quoi' }, 'Tablette'),
        h('a', { href: `#tablette/${encodeURIComponent(t.id)}` }, [t.ref, t.numero || t.modele].filter(Boolean).join(' · ') || 'Tablette'),
        h('span', { class: 'muted small' }, donnees.etats[etatTablette(t)] || t.etat))))
        : h('p', { class: 'muted small' }, 'Aucune tablette rattachée à cet achat.')) : null,
  ].filter(Boolean));
}

// Lien vers la page de la carte SIM rechargée par une dépense.
function simDe(id) {
  const l = id && donnees.sims.find((x) => x.id === id);
  return l ? h('a', { href: `#sim/${encodeURIComponent(l.id)}` }, [l.operateur, l.numero || fin4(l.iccid)].filter(Boolean).join(' · ') || 'Carte SIM') : null;
}

function libelleDepense(d) {
  return h('div', {}, d.libelle,
    d.numero ? h('span', { class: 'muted' }, ` · n° ${d.numero}`) : null,
    d.recurrence ? h('div', {}, badge('chaque mois', 'info')) : null,
    d.depuis ? h('div', { class: 'muted small' }, 'ajoutée automatiquement') : null,
    (d.materiel || []).length ? h('div', { class: 'muted small' }, `Entré au stock : ${d.materiel.join(', ')}`) : null,
    d.confirmation ? h('div', { class: 'muted small' }, 'Facture pas encore reçue (seule la confirmation de commande est arrivée)') : null,
    d.aVerifier ? h('div', { class: 'a-verifier' },
      h('p', { class: 'small' }, badge('à vérifier', 'ko'), ' ', sourceDepense(d),
        ' : vérifiez le montant, la date et le vendeur, puis validez.'),
      h('button', { type: 'button', class: 'secondary small-btn no-print', onclick: () => verifierDepense(d) }, 'Valider cette dépense')) : null);
}

// « e-mail de "Tanguy Reynaud" <adresse> » → « Lue dans l'e-mail de Tanguy Reynaud ».
function sourceDepense(d) {
  const s = String(d.source || '');
  const qui = (s.match(/^e-mail de\s+"?([^"<]+?)"?\s*(<|$)/) || [])[1];
  return qui ? `Lue dans l'e-mail de ${qui.trim()}` : (s || 'Reçue par e-mail');
}

async function verifierDepense(d) {
  try {
    await patienter('Enregistrement…', () => appeler('gestionDepense', { action: 'verifier', id: d.id }));
    signalerChangement();
  } catch (e) {
    prevenir(messageErreur(e));
  }
}

async function modifierDepense(d, champs) {
  try {
    const r = await appeler('gestionDepense', { action: 'modifier', id: d.id, champs });
    donnees = await lireDonnees(true);
    afficherTout();
    signalerChangement();
    annoncer('Dépense corrigée');
    // Mois déjà clôturé : ses livres envoyés ne contiennent pas la correction.
    for (const m of (r && r.moisClos) || []) {
      const [a, n] = m.split('-').map(Number);
      const nom = new Date(a, n - 1, 15).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
      if (await demander(`${nom[0].toUpperCase()}${nom.slice(1)} est déjà clôturé : le livre des achats envoyé ne contient pas cette correction. Refaire la clôture de ${nom} (nouveaux fichiers envoyés par e-mail) ?`, { oui: 'Refaire la clôture', non: 'Plus tard' })) {
        await patienter('Clôture en cours…', () => appeler('gestionCloturer', { mois: m }));
        annoncer(`Clôture de ${nom} refaite`);
      }
    }
    return true;
  } catch (e) {
    prevenir(messageErreur(e));
    return false;
  }
}

async function arreterDepense(d) {
  if (!await demander(`Ne plus ajouter « ${d.libelle} » chaque mois ? Les dépenses déjà inscrites restent.`, { oui: 'Arrêter' })) return;
  try {
    await patienter('Enregistrement…', () => appeler('gestionDepense', { action: 'arreter', id: d.id }));
    signalerChangement();
  } catch (e) {
    prevenir(messageErreur(e));
  }
}

async function supprimerDepense(d) {
  if (!await demander(`Supprimer la dépense « ${d.libelle} » (${euros(d.montant)}) et ses justificatifs ?`, { oui: 'Supprimer', danger: true })) return;
  try {
    await patienter('Suppression de la dépense…', () => appeler('gestionDepense', { action: 'supprimer', id: d.id }));
    signalerChangement();
    return true;
  } catch (e) {
    prevenir(messageErreur(e));
    return false;
  }
}

$('imprimer').addEventListener('click', () => window.print());

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
$('x-tout').addEventListener('click', async () => {
  const t = totaux(stripe.mouvements, depensesPeriode());
  const exports = [
    () => csv('bilan', ['Mois', 'Encaissé', 'Remboursé', 'Frais Stripe', 'Net', 'Dépenses', 'Résultat'],
      [...bilanMensuel().map((x) => [moisNom(x.cle), csvMontant(x.encaisse), csvMontant(x.rembourse), csvMontant(x.frais),
        csvMontant(x.net), csvMontant(x.depenses), csvMontant(x.resultat)]),
      ['Total', csvMontant(t.encaisse), csvMontant(t.rembourse), csvMontant(t.frais), csvMontant(t.net),
        csvMontant(t.depenses), csvMontant(t.resultat)]]),
    () => csv('livre-des-recettes', ['Date', 'Facture', 'Client', 'E-mail', 'Nature', 'Mode de règlement', 'Montant', 'Frais Stripe', 'Net', 'Référence Stripe'],
      recettes().sort((a, b) => a.le - b.le).map((m) => [jour(m.le), numeroFacture(m.facture), m.client, m.email,
        NATURES[m.nature] || m.nature, 'Carte bancaire (Stripe)', csvMontant(m.montant), csvMontant(m.frais), csvMontant(m.net), m.source || m.id])),
    () => csv('registre-des-achats', ['Date', 'Fournisseur', 'N° de facture', 'Libellé', 'Catégorie', 'Montant TTC', 'dont TVA', 'Justificatifs'],
      depensesPeriode().map((d) => [jour(d.date), d.fournisseur, d.numero, d.libelle, donnees.categories[d.categorie] || d.categorie,
        csvMontant(d.montant), csvMontant(d.tva), [...(d.pieces || []).map((p) => p.nom), d.justificatif].filter(Boolean).join(', ')])),
    exporterFactures,
    () => csv('releve-stripe', ['Date', 'Disponible le', 'Type', 'Nature', 'Description', 'Client', 'Montant', 'Frais', 'Net', 'Référence'],
      stripe.mouvements.slice().sort((a, b) => a.le - b.le).map((m) => [jour(m.le), jour(m.disponibleLe), m.type,
        NATURES[m.nature] || m.nature, m.description, m.client || m.email, csvMontant(m.montant), csvMontant(m.frais),
        csvMontant(m.net), m.id])),
  ];
  // Petit délai entre les fichiers : certains navigateurs bloquent plusieurs téléchargements d'un coup.
  for (const f of exports) {
    f();
    await attendre(600);
  }
});

// ---------- Fenêtres et formulaires ----------

document.querySelectorAll('dialog .fermer').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
// Clic sur le fond : ferme la fenêtre.
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

let formulairesPrets = false;
function preparerFormulaires() {
  if (formulairesPrets) return;
  formulairesPrets = true;
  $('filtre-stock').append(...Object.entries(GROUPES_STOCK).map(([k, [v]]) => h('option', { value: k }, v)),
    ...Object.entries(donnees.etats).map(([k, v]) => h('option', { value: k }, v)));
  $('filtre-sim').append(...Object.entries(donnees.statutsSim).map(([k, v]) => h('option', { value: k }, v)));
  $('f-depense').elements.categorie.append(...Object.entries(donnees.categories)
    .map(([k, v]) => h('option', { value: k, selected: k === 'autre' }, v)));
}

// Ajouts (achat de tablettes, dépense, commande offerte) : le formulaire s'affiche dans sa page
// (#nouveau/…), plus dans une fenêtre par-dessus ; « Retour » ou l'enregistrement ramènent d'où l'on venait.
const NOUVEAUX = {
  achat: { form: 'f-stock', titre: 'Ajouter un achat de tablettes', menu: 'compta' },
  depense: { form: 'f-depense', titre: 'Ajouter une dépense', menu: 'compta' },
  offerte: { form: 'f-offerte', titre: 'Commande offerte', menu: 'commandes' },
};
const CLE_NOUVEAU = { 'd-achat': 'achat', 'd-depense': 'depense', 'd-offerte': 'offerte' };
let retourNouveau = null;
const nouveauOuvert = () => (location.hash.match(/^#nouveau\/(\w+)/) || [])[1] || null;
function allerNouveau(cle) {
  if (!nouveauOuvert()) retourNouveau = location.hash || '#accueil';
  $(NOUVEAUX[cle].form).dataset.pret = '1';
  if (location.hash !== `#nouveau/${cle}`) location.hash = `#nouveau/${cle}`;
  else remplirNouveau(cle);
}
function remplirNouveau(cle) {
  const n = NOUVEAUX[cle];
  if (!n) { location.hash = '#accueil'; return; }
  const f = $(n.form);
  // Données relues pendant la saisie : rien ne bouge.
  if ($('nv-corps').contains(f) && !f.dataset.pret) return;
  // Page ouverte directement (lien, rechargement) : formulaire remis à zéro.
  if (!f.dataset.pret) {
    if (cle === 'offerte') preparerOfferte(); else viderFormulaire(f);
  }
  delete f.dataset.pret;
  $('titre-page').textContent = n.titre;
  document.title = `Papote · ${n.titre}`;
  $('nv-titre').textContent = n.titre;
  $('nv-retour').href = retourNouveau || `#${n.menu}`;
  document.querySelectorAll('.nav a[data-page]').forEach((a) => a.classList.toggle('actif', a.dataset.page === n.menu));
  // Le formulaire d'un autre ajout retourne à sa place cachée.
  for (const x of [...$('nv-corps').children]) if (x !== f) document.getElementById(Object.keys(CLE_NOUVEAU).find((d) => NOUVEAUX[CLE_NOUVEAU[d]].form === x.id)).append(x);
  if (!$('nv-corps').contains(f)) $('nv-corps').append(f);
  (f.querySelector('input:not([type="file"]):not([type="date"]), select') || f).focus();
}
// Page quittée : le formulaire retourne à sa place cachée (la prochaine ouverture repart de zéro).
window.addEventListener('hashchange', () => {
  if (nouveauOuvert()) return;
  for (const x of [...$('nv-corps').children]) document.getElementById(Object.keys(CLE_NOUVEAU).find((d) => NOUVEAUX[CLE_NOUVEAU[d]].form === x.id)).append(x);
});
function fermerNouveau() {
  const cle = nouveauOuvert();
  location.hash = retourNouveau || (cle ? `#${NOUVEAUX[cle].menu}` : '#accueil');
  retourNouveau = null;
}
function viderFormulaire(f) {
  f.reset();
  materielLu.delete(f);
  const aujourdhui = new Date().toLocaleDateString('sv-SE');
  f.querySelectorAll('input[type="date"]').forEach((i) => { i.value = aujourdhui; });
  f.querySelector('.f-msg').hidden = true;
}
function ouvrirFormulaire(id) {
  viderFormulaire($(id).querySelector('form') || $(NOUVEAUX[CLE_NOUVEAU[id]].form));
  allerNouveau(CLE_NOUVEAU[id]);
}
$('btn-achat-2').addEventListener('click', () => $('btn-achat').click());
$('btn-achat').addEventListener('click', () => ouvrirFormulaire('d-achat'));
$('btn-depense').addEventListener('click', () => ouvrirFormulaire('d-depense'));

const dateSaisie = (v) => {
  const [a, m, j] = v.split('-').map(Number);
  return new Date(a, m - 1, j, 12).getTime();
};

function message(form, texte, ok) {
  const p = form.querySelector('.f-msg');
  p.textContent = texte;
  p.className = `f-msg small ${ok ? 'muted' : 'error'}`;
  p.hidden = false;
}

// Action d'un formulaire : bouton désactivé pendant l'envoi, message d'erreur lisible, relecture des données.
// Pendant l'envoi : une roue dans le bouton qui valide ; à la fin, « Enregistré ✓ » en bas de l'écran.
async function enregistrer(form, action, annonce = 'Enregistré') {
  const boutons = form.querySelectorAll('button');
  const valider = form.querySelector('button[type="submit"]') || form.querySelector('button.primary');
  boutons.forEach((b) => { b.disabled = true; });
  boutonCharge(valider, true);
  form.querySelector('.f-msg').hidden = true;
  try {
    await action();
    donnees = await lireDonnees(true);
    afficherTout();
    annoncer(typeof annonce === 'string' && !annonce.endsWith('…') ? annonce : 'Enregistré');
    document.dispatchEvent(new CustomEvent('papote:listes'));
    return true;
  } catch (e) {
    console.error(e);
    message(form, messageErreur(e));
    return false;
  } finally {
    boutons.forEach((b) => { b.disabled = false; });
    boutonCharge(valider, false);
  }
}

$('f-stock').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const prix = enCentimes(f.prix.value);
  const tva = enCentimes(f.tva.value);
  if (!prix || Number.isNaN(tva)) return message(f, 'Montant illisible (ex. 89,90).');
  const numeros = f.numeros.value.split('\n').map((n) => n.trim()).filter(Boolean);
  const quantite = Number(f.quantite.value);
  if (numeros.length > quantite) return message(f, `${numeros.length} numéros pour ${pluriel(quantite, 'tablette')}.`);
  const fichiers = [...f.piece.files];
  const ok = await enregistrer(f, async () => {
    const r = await appeler('gestionStock', {
      action: 'ajouter', quantite, modele: f.modele.value, fournisseur: f.fournisseur.value,
      prixAchat: prix, tva, acheteeLe: dateSaisie(f.date.value), numeros, numeroFacture: f.numero.value,
      materiel: materielLu.get(f) || null,
    });
    if (fichiers.length && r.depense) await envoyerPieces('depenses', r.depense, fichiers);
  });
  if (ok) {
    fermerNouveau();
    signalerChangement();
  }
});

$('f-depense').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const montant = enCentimes(f.montant.value);
  const tva = enCentimes(f.tva.value);
  if (!montant || Number.isNaN(tva)) return message(f, 'Montant illisible (ex. 12,00).');
  const fichiers = [...f.piece.files];
  const ok = await enregistrer(f, async () => {
    const r = await appeler('gestionDepense', {
      action: 'ajouter', date: dateSaisie(f.date.value), categorie: f.categorie.value,
      fournisseur: f.fournisseur.value, libelle: f.libelle.value, montant, tva,
      numero: f.numero.value, recurrente: f.recurrente.checked, materiel: materielLu.get(f) || null,
    });
    if (fichiers.length) await envoyerPieces('depenses', r.id, fichiers);
  });
  if (ok) {
    fermerNouveau();
    signalerChangement();
  }
});

// ---------- Lecture automatique des factures ----------

const TYPES_LECTURE = /^(application\/pdf|image\/(png|jpeg|webp|gif))$/;
const enEuros = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));

async function lireFacture(brut) {
  const fichier = await alleger(brut);
  if (!TYPES_LECTURE.test(fichier.type)) throw new Error('Lecture automatique : PDF, JPEG ou PNG seulement.');
  if (fichier.size > MAX_PIECE) throw new Error(`${fichier.name} dépasse 6 Mo.`);
  return appeler('gestionLireFacture', { type: fichier.type, contenu: await lireFichier(fichier) });
}

// Seuls les champs lus sur la facture sont remplacés.
function appliquer(f, valeurs) {
  for (const [k, v] of Object.entries(valeurs)) {
    if (v != null && v !== '' && f.elements[k]) f.elements[k].value = v;
  }
}

function remplirAchat(f, r) {
  const t = r.tablettes || {};
  const quantite = t.quantite || 1;
  appliquer(f, {
    quantite: t.quantite,
    date: r.date && new Date(r.date).toLocaleDateString('sv-SE'),
    modele: t.modele,
    fournisseur: r.fournisseur,
    prix: enEuros(t.prixAchat != null ? t.prixAchat : r.montant != null ? Math.round(r.montant / quantite) : null),
    tva: enEuros(r.tva != null ? Math.round(r.tva / quantite) : null),
    numero: r.numero,
    numeros: t.numeros && t.numeros.length ? t.numeros.join('\n') : null,
  });
}

function remplirDepense(f, r) {
  appliquer(f, {
    date: r.date && new Date(r.date).toLocaleDateString('sv-SE'),
    categorie: r.categorie,
    fournisseur: r.fournisseur,
    libelle: r.libelle,
    montant: enEuros(r.montant),
    tva: enEuros(r.tva),
    numero: r.numero,
  });
}

// Cartes SIM et accessoires lus sur la facture : ajoutés au stock en même temps que la fiche.
const materielLu = new Map(); // formulaire → { cartesSim, accessoires }
function materielTexte(m) {
  if (!m) return '';
  const x = [
    m.cartesSim ? `${m.cartesSim.quantite} carte${m.cartesSim.quantite > 1 ? 's' : ''} SIM` : null,
    ...(m.accessoires || []).map((a) => `${a.quantite} × ${a.nom}`),
  ].filter(Boolean);
  return x.length ? `En plus, iront dans le stock : ${x.join(', ')}.` : '';
}
const messageLu = (r) => ['Fiche remplie d\'après le document : vérifiez avant d\'enregistrer.',
  r.devise && r.devise !== 'EUR' ? `Attention, montants en ${r.devise}.` : null, materielTexte(r), r.remarque].filter(Boolean).join(' ');

// Lit la facture choisie dans le formulaire et remplit la fiche ; renvoie la lecture (ou null).
async function preremplir(f, fichier) {
  const bouton = f.querySelector('button[type="submit"]');
  bouton.disabled = true;
  message(f, 'Lecture de la facture…', true);
  try {
    const r = await lireFacture(fichier);
    if (!r.facture) {
      message(f, 'Ce document ne ressemble pas à une facture : remplissez la fiche à la main.');
      return null;
    }
    (f.id === 'f-stock' ? remplirAchat : remplirDepense)(f, r);
    materielLu.set(f, { cartesSim: r.cartesSim, accessoires: r.accessoires });
    message(f, messageLu(r), true);
    return r;
  } catch (e) {
    message(f, messageErreur(e));
    return null;
  } finally {
    bouton.disabled = false;
  }
}

for (const id of ['f-stock', 'f-depense']) {
  const f = $(id);
  f.piece.addEventListener('change', () => {
    if (f.piece.files[0]) preremplir(f, f.piece.files[0]);
  });
}

function mettreFichier(f, fichier) {
  const dt = new DataTransfer();
  dt.items.add(fichier);
  f.piece.files = dt.files;
}

// Facture déposée sans formulaire ouvert : dépense, ou achat de tablettes si c'en est un.
async function deposer(fichier) {
  const fd = $('f-depense');
  ouvrirFormulaire('d-depense');
  mettreFichier(fd, fichier);
  const r = await preremplir(fd, fichier);
  if (r && r.tablettes) {
    ouvrirFormulaire('d-achat');
    const fa = $('f-stock');
    mettreFichier(fa, fichier);
    remplirAchat(fa, r);
    materielLu.set(fa, materielLu.get(fd));
    materielLu.delete(fd);
    message(fa, messageLu(r), true);
  }
}


// Glisser-déposer un fichier n'importe où sur la page.
const avecFichiers = (e) => [...(e.dataTransfer && e.dataTransfer.types) || []].includes('Files');
document.addEventListener('dragover', (e) => {
  if (!avecFichiers(e) || $('dashboard').hidden) return;
  e.preventDefault();
  document.body.classList.add('depot-actif');
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('depot-actif');
});
document.addEventListener('drop', (e) => {
  document.body.classList.remove('depot-actif');
  if (!avecFichiers(e) || $('dashboard').hidden) return;
  e.preventDefault();
  const fichier = e.dataTransfer.files[0];
  if (!fichier) return;
  const ouvert = ['achat', 'depense'].includes(nouveauOuvert()) ? nouveauOuvert() : null;
  if (ouvert) {
    const f = $(NOUVEAUX[ouvert].form);
    mettreFichier(f, fichier);
    preremplir(f, fichier);
  } else {
    deposer(fichier);
  }
});

// ---------- Automatismes ----------

function afficherAutomatique() {
  const a = donnees && donnees.automatique;
  if (!a) {
    $('automatique').replaceChildren('Premier passage cette nuit.');
    return;
  }
  const quand = new Date(a.le).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
  const fait = [
    a.factures.length ? `${pluriel(a.factures.length, 'facture')} créée${a.factures.length > 1 ? 's' : ''} (${a.factures.join(', ')})` : null,
    a.avoirs.length ? `${pluriel(a.avoirs.length, 'avoir')} (${a.avoirs.join(', ')})` : null,
    a.depenses ? `${pluriel(a.depenses, 'dépense mensuelle')} ajoutée${a.depenses > 1 ? 's' : ''}` : null,
    (a.stock || []).length ? `stock mis à jour (${a.stock.join(', ')})` : null,
    (a.etiquettes || []).length ? `étiquette de retour envoyée à ${a.etiquettes.join(', ')}` : null,
    (a.livres || []).length ? `colis reçu par ${a.livres.join(', ')}` : null,
  ].filter(Boolean);
  $('automatique').replaceChildren(
    `Dernier passage le ${quand} : ${fait.length ? fait.join(', ') : 'rien à faire'}.`,
    ...(a.erreurs || []).map((x) => h('span', { class: 'error' }, h('br'), x)),
  );
}

$('btn-automatiser').addEventListener('click', async () => {
  const b = $('btn-automatiser');
  b.disabled = true;
  $('automatique').textContent = 'En cours…';
  try {
    await appeler('gestionAutomatiser');
    signalerChangement();
  } catch (e) {
    $('automatique').replaceChildren(h('span', { class: 'error' }, messageErreur(e)));
  } finally {
    b.disabled = false;
  }
});

// ---------- Recherche ----------

const normaliser = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function rechercher(q) {
  const n = normaliser(q).trim();
  if (n.length < 2 || !donnees) return [];
  const compact = n.replace(/[\s-]/g, '');
  const trouve = (...champs) => champs.some((c) => {
    const x = normaliser(c);
    return x.includes(n) || (compact.length >= 3 && x.replace(/[\s-]/g, '').includes(compact));
  });
  const res = [];
  for (const c of donnees.commandes) {
    if (trouve(c.code, c.nom, c.email, c.telephone, c.famille, c.suivi)) {
      res.push({ texte: nomCommande(c), detail: `Commande · ${ETATS_COMMANDE[etatCommande(c)][0]}`, ouvrir: () => ouvrirCommande(c) });
    }
  }
  for (const t of donnees.stock) {
    if (trouve(t.numero, t.modele, t.sim, t.notes)) {
      res.push({ texte: `Tablette ${t.numero || t.modele || ''}`, detail: donnees.etats[etatTablette(t)] || t.etat, ouvrir: () => ouvrirTablette(t.id) });
    }
  }
  for (const l of donnees.sims) {
    if (trouve(l.numero, l.iccid, l.operateur, l.client, l.note)) {
      const t = l.tablette && donnees.stock.find((x) => x.id === l.tablette);
      res.push({ texte: `Carte SIM ${l.numero || fin4(l.iccid)}`, detail: [donnees.statutsSim[l.statut], t ? `tablette ${t.numero || t.modele || ''}` : null].filter(Boolean).join(' · '), ouvrir: () => ouvrirSim(l.id) });
    }
  }
  for (const a of donnees.accessoires) {
    if (trouve(a.nom)) res.push({ texte: a.nom, detail: `Accessoire · ${a.quantite || 0} en stock`, ouvrir: () => ouvrirAccessoire(a.id) });
  }
  for (const f of donnees.familles) {
    if (trouve(f.nom) && !donnees.commandes.some((c) => c.fid === f.id)) {
      res.push({ texte: f.nom, detail: 'Famille', ouvrir: () => { location.hash = '#clients/familles'; } });
    }
  }
  for (const d of donnees.depenses) {
    if (trouve(d.fournisseur, d.libelle, d.numero)) {
      res.push({ texte: d.libelle, detail: `Dépense · ${jour(d.date)} · ${euros(d.montant)}`, ouvrir: () => voirDepense(d) });
    }
  }
  return res.slice(0, 12);
}

// Dépense : la comptabilité sur son mois.
function voirDepense(d) {
  const debut = new Date(d.date);
  $('p-choix').value = 'perso';
  $('p-du').value = new Date(debut.getFullYear(), debut.getMonth(), 1).toLocaleDateString('sv-SE');
  $('p-au').value = new Date(debut.getFullYear(), debut.getMonth() + 1, 0).toLocaleDateString('sv-SE');
  location.hash = '#compta/depenses';
  changerPeriode();
}

let resultats = [];
function afficherResultats() {
  resultats = rechercher($('recherche').value);
  const q = $('recherche').value.trim();
  $('resultats').hidden = q.length < 2;
  $('resultats').replaceChildren(...(resultats.length
    ? resultats.map((r) => h('li', {}, h('button', { type: 'button', onclick: () => choisir(r) }, r.texte, h('small', {}, r.detail))))
    : [h('li', { class: 'muted small' }, donnees ? 'Aucun résultat.' : 'Chargement…')]));
}
function choisir(r) {
  $('resultats').hidden = true;
  $('recherche').value = '';
  r.ouvrir();
}
$('recherche').addEventListener('input', afficherResultats);
$('recherche').addEventListener('focus', afficherResultats);
$('recherche').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && resultats[0]) {
    // Sinon la touche « Entrée » appuie aussi sur le bouton de fermeture de la fiche ouverte.
    e.preventDefault();
    choisir(resultats[0]);
  }
  if (e.key === 'Escape') $('resultats').hidden = true;
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.recherche')) $('resultats').hidden = true;
});

// ---------- Graphiques ----------

const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...enfants) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const e of enfants.flat(Infinity)) if (e != null) el.append(e instanceof Node ? e : document.createTextNode(String(e)));
  return el;
}

const moisCourt = (cle) => {
  const [a, m] = cle.split('-').map(Number);
  return new Date(a, m - 1, 1).toLocaleDateString('fr-FR', { month: 'short' });
};

// Barres et courbes par mois. series : [{ nom, type: 'barre' | 'ligne', classe, valeurs, format }].
function graphique(conteneur, mois, series) {
  if (!mois.length) {
    conteneur.replaceChildren(h('p', { class: 'muted small' }, 'Rien sur cette période.'));
    return;
  }
  const L = 640; const H = 220; const G = 56; const B = 28; const T = 10;
  const tout = series.flatMap((s) => s.valeurs);
  const max = Math.max(1, ...tout);
  const min = Math.min(0, ...tout);
  const y = (v) => T + ((max - v) / (max - min)) * (H - T - B);
  const pas = (L - G) / mois.length;
  const barres = series.filter((s) => s.type === 'barre');
  const largeur = Math.min(28, (pas * 0.7) / Math.max(1, barres.length));
  const x0 = (i) => G + i * pas + pas / 2;
  const format = series[0].format || String;
  const graduations = [min, (min + max) / 2, max].filter((v, i, a) => a.indexOf(v) === i);
  const dessin = svg('svg', { viewBox: `0 0 ${L} ${H}`, class: 'graphique', role: 'img' },
    graduations.map((v) => [
      svg('line', { x1: G, x2: L, y1: y(v), y2: y(v), class: v === 0 ? 'g-zero' : 'g-grille' }),
      svg('text', { x: G - 6, y: y(v) + 4, class: 'g-axe', 'text-anchor': 'end' }, format(Math.round(v))),
    ]),
    mois.map((cle, i) => svg('text', { x: x0(i), y: H - 8, class: 'g-axe', 'text-anchor': 'middle' },
      moisCourt(cle))),
    barres.map((s, k) => s.valeurs.map((v, i) => (!v ? null : svg('rect', {
      x: x0(i) - (largeur * barres.length) / 2 + k * largeur, y: Math.min(y(v), y(0)),
      width: largeur - 2, height: Math.max(1, Math.abs(y(0) - y(v))), class: s.classe, rx: 3,
    }, svg('title', {}, `${moisNom(mois[i])} · ${s.nom} : ${(s.format || String)(v)}`))))),
    series.filter((s) => s.type === 'ligne').map((s) => [
      svg('polyline', { points: s.valeurs.map((v, i) => `${x0(i)},${y(v)}`).join(' '), class: `${s.classe} g-ligne` }),
      s.valeurs.map((v, i) => svg('circle', { cx: x0(i), cy: y(v), r: 4, class: s.classe },
        svg('title', {}, `${moisNom(mois[i])} · ${s.nom} : ${(s.format || String)(v)}`))),
    ]));
  conteneur.replaceChildren(dessin, h('p', { class: 'legende small' },
    series.map((s) => h('span', {}, h('i', { class: s.classe }), s.nom))));
}

const eurosRonds = (c) => (c / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

function afficherGraphiques() {
  const lignes = bilanMensuel();
  const mois = lignes.map((l) => l.cle);
  graphique($('g-argent'), mois, [
    { nom: 'Encaissé', type: 'barre', classe: 'g-encaisse', valeurs: lignes.map((l) => l.encaisse), format: eurosRonds },
    { nom: 'Dépenses', type: 'barre', classe: 'g-depense', valeurs: lignes.map((l) => l.depenses), format: eurosRonds },
    { nom: 'Résultat', type: 'ligne', classe: 'g-resultat', valeurs: lignes.map((l) => l.resultat), format: eurosRonds },
  ]);
  const abos = stripe.abonnements.filter((a) => !['incomplete', 'incomplete_expired'].includes(a.statut));
  const finDuMois = (cle) => {
    const [a, m] = cle.split('-').map(Number);
    return Math.min(new Date(a, m, 1).getTime(), Date.now());
  };
  graphique($('g-abonnes'), mois, [
    { nom: 'Arrivées', type: 'barre', classe: 'g-arrivee', valeurs: mois.map((cle) => abos.filter((a) => moisCle(a.debut) === cle).length) },
    { nom: 'Départs', type: 'barre', classe: 'g-depart', valeurs: mois.map((cle) => abos.filter((a) => a.finLe && moisCle(a.finLe) === cle).length) },
    { nom: 'En cours', type: 'ligne', classe: 'g-encours', valeurs: mois.map((cle) => abos.filter((a) => a.debut < finDuMois(cle) && (!a.finLe || a.finLe >= finDuMois(cle))).length) },
  ]);
}

// ---------- Déclarations URSSAF ----------

$('u-rythme').value = memoire.lire('papote-urssaf-rythme', 'mois');

function afficherUrssaf() {
  const taux = donnees.reglages.tauxUrssaf;
  const ca = new Map();
  for (const m of stripe.mouvements) {
    if (ENCAISSEMENTS.includes(m.nature) || m.nature === 'remboursement' || m.nature === 'litige') {
      ca.set(moisCle(m.le), (ca.get(moisCle(m.le)) || 0) + m.montant);
    }
  }
  const trimestre = $('u-rythme').value === 'trimestre';
  const groupes = new Map();
  for (const cle of moisDeLaPeriode()) {
    const [a, m] = cle.split('-').map(Number);
    const g = trimestre ? `${a}-T${Math.floor((m - 1) / 3) + 1}` : cle;
    const fin = trimestre ? new Date(a, Math.floor((m - 1) / 3) * 3 + 3, 1) : new Date(a, m, 1);
    if (!groupes.has(g)) groupes.set(g, { g, fin, ca: 0 });
    groupes.get(g).ca += ca.get(cle) || 0;
  }
  const lignes = [...groupes.values()];
  const cotis = (c) => (Number.isFinite(taux) ? Math.round((Math.max(0, c) * taux) / 100) : null);
  const nom = (x) => (trimestre ? `${x.g.slice(6)}e trimestre ${x.g.slice(0, 4)}`.replace('1e', '1er') : moisNom(x.g));
  remplirTable($('t-urssaf'), [
    { titre: trimestre ? 'Trimestre' : 'Mois' }, { titre: 'Chiffre d\'affaires à déclarer', n: 1 },
    { titre: 'Cotisations estimées', n: 1 }, { titre: 'À déclarer avant le' },
  ], lignes.map((x) => [
    h('span', {}, nom(x), x.fin.getTime() > Date.now() ? h('span', { class: 'muted' }, ' (en cours)') : null),
    euros(x.ca), euros(cotis(x.ca)),
    // Fin du mois qui suit la période déclarée.
    jour(new Date(x.fin.getFullYear(), x.fin.getMonth() + 1, 0).getTime()),
  ]), {
    total: lignes.length ? ['Total', euros(lignes.reduce((s, x) => s + x.ca, 0)), euros(cotis(lignes.reduce((s, x) => s + x.ca, 0))), ''] : null,
  });
}
$('u-rythme').addEventListener('change', () => {
  memoire.ecrire('papote-urssaf-rythme', $('u-rythme').value);
  if (stripe) afficherUrssaf();
});

// ---------- Scan des numéros de série ----------

let flux = null;
let boucle = null;
document.querySelectorAll('.scanner').forEach((b) => {
  b.hidden = !('BarcodeDetector' in window);
  b.addEventListener('click', () => scanner(b.closest('form'), b.dataset.cible));
});

async function scanner(form, nom) {
  const champ = form.elements[nom];
  const plusieurs = champ.tagName === 'TEXTAREA';
  const lus = new Set(plusieurs ? champ.value.split('\n').map((x) => x.trim()).filter(Boolean) : []);
  $('scan-lus').replaceChildren();
  $('scan-msg').textContent = nom === 'iccid' ? 'Visez le code-barres de la carte SIM (sur son support en plastique).'
    : 'Visez le code-barres du numéro de série (étiquette de la boîte ou au dos de la tablette).';
  $('scan-fin').hidden = !plusieurs;
  $('d-scan').showModal();
  try {
    flux = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (e) {
    $('scan-msg').textContent = 'Caméra inaccessible : autorisez-la dans le navigateur.';
    return;
  }
  if (!$('d-scan').open) return arreterScan();
  const video = $('scan-video');
  video.srcObject = flux;
  await video.play().catch(() => null);
  const detecteur = new window.BarcodeDetector();
  boucle = setInterval(async () => {
    let codes = [];
    try { codes = await detecteur.detect(video); } catch (e) { return; }
    for (const c of codes) {
      const v = (c.rawValue || '').trim();
      if (!v || lus.has(v)) continue;
      lus.add(v);
      if (navigator.vibrate) navigator.vibrate(80);
      if (!plusieurs) {
        champ.value = v;
        $('d-scan').close();
        return;
      }
      champ.value = [...lus].join('\n');
      if (form.elements.quantite && Number(form.elements.quantite.value) < lus.size) form.elements.quantite.value = lus.size;
      $('scan-lus').append(h('li', {}, v));
    }
  }, 300);
}

function arreterScan() {
  clearInterval(boucle);
  boucle = null;
  if (flux) flux.getTracks().forEach((t) => t.stop());
  flux = null;
}
$('d-scan').addEventListener('close', arreterScan);
$('scan-fin').addEventListener('click', () => $('d-scan').close());

// ---------- Franchise de TVA ----------

// Chiffre d'affaires encaissé depuis le 1er janvier, projeté à fin décembre avec les abonnements en cours.
function franchiseTva() {
  if (!donnees || !stripeAnnee) return null;
  const seuil = donnees.reglages.seuilTva;
  let ca = 0;
  for (const m of stripeAnnee.mouvements) {
    if (ENCAISSEMENTS.includes(m.nature) || m.nature === 'remboursement' || m.nature === 'litige') ca += m.montant;
  }
  const mensuelTotal = stripeAnnee.abonnements.filter((a) => ['active', 'trialing', 'past_due'].includes(a.statut))
    .reduce((s, a) => s + a.mensuel, 0);
  const n = new Date();
  const moisRestants = 11 - n.getMonth() + (1 - n.getDate() / new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate());
  const projection = Math.round(ca + mensuelTotal * moisRestants);
  const part = seuil ? ca / seuil : 0;
  const alerte = !seuil ? null
    : ca >= seuil ? 'Seuil de franchise de TVA dépassé : à facturer avec TVA, voir le comptable'
      : projection >= seuil ? 'Le seuil de franchise de TVA sera dépassé avant la fin de l\'année à ce rythme'
        : part >= 0.8 ? `${Math.round(part * 100)} % du seuil de franchise de TVA atteint` : null;
  return { ca, seuil, part, projection, alerte };
}

function afficherTva(t) {
  if (!t) {
    $('tva').replaceChildren(h('p', { class: 'muted small' }, 'Lecture de Stripe…'));
    return;
  }
  const pct = Math.min(100, Math.round(t.part * 100));
  $('tva').replaceChildren(
    h('div', { class: `jauge${t.alerte ? ' ko' : ''}`, role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
      h('span', { style: `width:${pct}%` })),
    h('p', { class: 'small' }, `${euros(t.ca)} encaissés depuis le 1er janvier, soit ${pct} % du seuil de ${euros(t.seuil)}. `,
      `À ce rythme : environ ${euros(t.projection)} fin décembre.`),
    ...(t.alerte ? [h('p', { class: 'small error' }, t.alerte)] : []),
    h('p', { class: 'muted small' }, 'Tant que vous restez sous le seuil, vos factures sont sans TVA (art. 293 B du CGI). Seuil réglable dans Réglages, Calculs.'),
  );
}

// ---------- Rentabilité par formule ----------

// Un abonné rapporte chaque mois (prix − Stripe − URSSAF − forfait SIM) et coûte au départ : la tablette et ce qui
// revient avec elle (achetés une fois, réutilisés), ce qui est consommé à chaque envoi (carton, papier, fiche), le port
// aller et retour, moins la mise en service. Les accessoires « en option » (enceinte) ne sont pas comptés.
function afficherRentabilite() {
  const r = donnees.reglages;
  // Frais Stripe réels de la période (part du montant encaissé), sinon ~3 % : carte, le cas le moins favorable
  // (1,5 % + 0,25 € et 0,7 % d'abonnement Stripe sur 25 €, Tanguy 2026-10-30).
  const paiements = stripe.mouvements.filter((m) => ENCAISSEMENTS.includes(m.nature));
  const encaisse = paiements.reduce((s, m) => s + m.montant, 0);
  const tauxFrais = encaisse ? paiements.reduce((s, m) => s + m.frais, 0) / encaisse : 0.03;
  const prixTablettes = donnees.stock.map((t) => t.prixAchat).filter((p) => p > 0);
  const tablette = prixTablettes.length ? Math.round(prixTablettes.reduce((s, p) => s + p, 0) / prixTablettes.length) : 12500; // ~125 € (Tab 60 Pro)
  const enService = lignesSim().filter((l) => !l.aResilier);
  const forfait = enService.length ? Math.round(enService.reduce((s, l) => s + coutSim(l.t), 0) / enService.length) : r.forfaitSim;
  const payants = stripe.abonnements.filter((a) => ['active', 'past_due'].includes(a.statut));
  const somme = (liste) => liste.reduce((s, a) => s + (a.prixAchat || 0), 0);
  const charges = (montant) => Math.round(montant * tauxFrais) + Math.round((montant * r.tauxUrssaf) / 100);
  // Offre unique : l'ancienne formule Wi-Fi n'apparaît que s'il reste un abonné.
  const lignes = Object.entries(FORMULES).filter(([cle]) => cle === 'sim' || payants.some((a) => a.formule === cle)).map(([cle, nom]) => {
    const abos = payants.filter((a) => a.formule === cle);
    const prix = abos.length ? Math.round(abos.reduce((s, a) => s + a.mensuel, 0) / abos.length) : (cle === 'sim' ? 2500 : 2000);
    const sim = cle === 'sim' ? forfait : 0;
    const parMois = prix - charges(prix) - sim;
    const colis = (donnees.accessoires || []).filter((a) => a.parEnvoi === 'tous' || a.parEnvoi === cle);
    const materiel = tablette + somme(colis.filter((a) => a.retour));
    const envoi = somme(colis.filter((a) => !a.retour)) + r.fraisEnvoi + r.fraisRetour;
    const depart = materiel + envoi - (r.miseEnService - charges(r.miseEnService));
    const mois = parMois > 0 ? Math.max(0, Math.ceil(depart / parMois)) : null;
    // Une fois amorti : le matériel réparti sur sa durée de vie, un client par tablette sur cette durée.
    const amorti = parMois - Math.round(Math.max(0, depart) / Math.max(1, r.vieTablette));
    return { nom, n: abos.length, prix, charges: charges(prix) + sim, parMois, depart, mois, amorti };
  });
  const signe = (c) => h('span', { class: c < 0 ? 'neg' : null }, euros(c));
  remplirTable($('t-rentabilite'), [
    { titre: 'Formule' }, { titre: 'Abonnés', n: 1 }, { titre: 'Prix', n: 1 }, { titre: 'Stripe, URSSAF, SIM', n: 1 },
    { titre: 'Reste / mois', n: 1 }, { titre: 'Coût de départ', n: 1 },
    { titre: 'Remboursé en', n: 1 }, { titre: 'Reste amorti / mois', n: 1 }, { titre: 'Total / mois', n: 1 },
  ], lignes.map((l) => [l.nom, String(l.n), euros(l.prix), euros(l.charges), signe(l.parMois), signe(l.depart), l.mois == null ? 'jamais' : `${l.mois} mois`, signe(l.amorti), signe(l.amorti * l.n)]), {
    total: ['Total', String(lignes.reduce((s, l) => s + l.n, 0)), '', '', '', '', '', '',
      signe(lignes.reduce((s, l) => s + l.amorti * l.n, 0))],
  });
  const accessoires = (donnees.accessoires || []).filter((a) => a.parEnvoi);
  const ligne = (nom, prix, note) => h('li', null, `${nom} : ${euros(prix)}`, note ? h('span', { class: 'muted' }, ` (${note})`) : null);
  $('rentabilite-colis').replaceChildren(
    h('ul', { class: 'small' },
      ligne('Tablette', tablette, prixTablettes.length ? 'prix moyen du stock, revient au retour' : 'prix par défaut, aucun prix dans le stock'),
      ...accessoires.map((a) => ligne(a.nom, a.prixAchat || 0, [
        a.parEnvoi === 'option' ? 'en option, non compté' : a.parEnvoi === 'tous' ? null : donnees.envoisAccessoire[a.parEnvoi],
        a.parEnvoi === 'option' ? null : a.retour ? 'revient au retour' : 'consommé',
      ].filter(Boolean).join(', '))),
      ligne('Envoi', r.fraisEnvoi), ligne('Retour', r.fraisRetour), ligne('Mise en service (en moins)', r.miseEnService)),
    h('p', { class: 'muted small' }, accessoires.length
      ? 'Modifier le contenu : Stock, Accessoires. Chaque envoi sort ces articles du stock et prévient quand il en manque.'
      : 'Aucun article de colis : ajoutez-les dans Stock, Accessoires (carton, housse, chargeur, câble, papier, fiche…), « Part avec : Chaque envoi ».'),
  );
  afficherReglagesCalculs();
}

// Un réglage modifié seul (crayon) : seuls les champs envoyés changent côté serveur.
async function sauverReglages(valeurs, fait = 'Réglage enregistré') {
  try {
    await appeler('gestionReglages', valeurs);
    donnees = await lireDonnees(true);
    afficherTout();
    annoncer(fait);
    return true;
  } catch (e) {
    prevenir(messageErreur(e));
    return false;
  }
}

function nombreSaisi(v, { centimes = false, entier = false, min = 0, max = 1e9 } = {}) {
  const n = Number(String(v).replace(/\s|€|%|g/g, '').replace(',', '.'));
  if (String(v).trim() === '' || !Number.isFinite(n) || n < min || n > max || (entier && !Number.isInteger(n))) throw new Error('Valeur illisible.');
  return centimes ? Math.round(n * 100) : n;
}

function afficherReglagesCalculs() {
  const zone = $('reglages-calculs');
  if (saisieEnCours(zone)) return;
  const r = donnees.reglages;
  const reglage = (libelle, cle, affiche, valeur, opts = {}) => ligneModifiable(libelle, affiche, {
    valeur, mode: 'decimal', ...opts, convertir: (v) => nombreSaisi(v, opts.nombre), enregistrer: (v) => sauverReglages({ [cle]: v }),
  });
  zone.replaceChildren(
    ...reglage('Seuil de franchise de TVA', 'seuilTva', euros(r.seuilTva), enEuros(r.seuilTva), { suffixe: '€', nombre: { centimes: true } }),
    ...reglage('Taux URSSAF', 'tauxUrssaf', `${String(r.tauxUrssaf).replace('.', ',')} %`, String(r.tauxUrssaf).replace('.', ','), { suffixe: '%', nombre: { max: 100 } }),
    ...reglage('Forfait SIM par défaut', 'forfaitSim', `${euros(r.forfaitSim)} par mois`, enEuros(r.forfaitSim), { suffixe: '€ par mois', nombre: { centimes: true } }),
    ...reglage('Durée de vie d\'une tablette', 'vieTablette', `${r.vieTablette} mois`, r.vieTablette, { mode: 'numeric', suffixe: 'mois', nombre: { entier: true, min: 1 } }),
    ...reglage('Mise en service', 'miseEnService', euros(r.miseEnService), enEuros(r.miseEnService), { suffixe: '€', nombre: { centimes: true } }),
    ...reglage('Envoi d\'un colis', 'fraisEnvoi', euros(r.fraisEnvoi), enEuros(r.fraisEnvoi), { suffixe: '€', nombre: { centimes: true } }),
    ...reglage('Retour d\'un colis', 'fraisRetour', euros(r.fraisRetour), enEuros(r.fraisRetour), { suffixe: '€', nombre: { centimes: true } }),
  );
}

// ---------- Adresse des étiquettes Sendcloud ----------

const CHAMPS_EXPEDITEUR = [['nom', 'Nom'], ['adresse', 'Adresse'], ['cp', 'Code postal', 'numeric'], ['ville', 'Ville'],
  ['telephone', 'Téléphone', 'tel'], ['email', 'E-mail', 'email']];
function afficherExpediteur() {
  const zone = $('reglages-expediteur');
  if (saisieEnCours(zone)) return;
  const e = donnees.reglages.expediteur || {};
  zone.replaceChildren(
    ...CHAMPS_EXPEDITEUR.flatMap(([k, libelle, mode]) => ligneModifiable(libelle, e[k] || null, {
      valeur: e[k] || '', mode: mode || null, type: mode === 'email' ? 'email' : null,
      // Le serveur reçoit toujours l'adresse entière : les autres lignes restent telles quelles.
      enregistrer: (v) => sauverReglages({ expediteur: { ...Object.fromEntries(CHAMPS_EXPEDITEUR.map(([c]) => [c, e[c] || ''])), [k]: v.trim() } }, 'Adresse enregistrée'),
    })),
    ...ligneModifiable('Poids d\'un colis', `${donnees.reglages.poidsColis} g`, {
      valeur: donnees.reglages.poidsColis, mode: 'numeric', suffixe: 'g',
      convertir: (v) => nombreSaisi(v, { entier: true, min: 100, max: 30000 }),
      enregistrer: (v) => sauverReglages({ poidsColis: v }),
    }),
  );
}

// ---------- Récap du lundi ----------

$('btn-recap').addEventListener('click', async () => {
  const b = $('btn-recap');
  b.disabled = true;
  try {
    const r = await appeler('gestionRecapMaintenant');
    prevenir(`Récap envoyé à contact@mapapote.fr (${pluriel(r.aFaire, 'point')} à faire).`);
  } catch (e) {
    prevenir(messageErreur(e));
  } finally {
    b.disabled = false;
  }
});

// ---------- Factures reçues par e-mail ----------

function afficherCourrier() {
  const c = donnees && donnees.courrier;
  if (!c) {
    $('courrier').replaceChildren('Pas encore relevée.');
    return;
  }
  const quand = new Date(c.le).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
  $('courrier').replaceChildren(
    `Dernier relevé le ${quand} : ${c.rangees.length ? `${pluriel(c.rangees.length, 'facture')} rangée${c.rangees.length > 1 ? 's' : ''} (${c.rangees.join(' ; ')})` : 'aucune nouvelle facture'}`,
    c.recus != null ? ` (boîte ${c.boite || ''} : ${pluriel(c.recus, 'e-mail')} reçu${c.recus > 1 ? 's' : ''} ces 4 jours, dont ${c.pourFactures || 0} adressé${c.pourFactures > 1 ? 's' : ''} à factures@).` : '.',
    ...c.ignorees.map((x) => h('span', {}, h('br'), `Ignoré : ${x}`)),
    ...c.erreurs.map((x) => h('span', { class: 'error' }, h('br'), x)),
    ...(c.precedent ? [h('br'), `Dernier e-mail traité le ${new Date(c.precedent.le).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })} : `,
      c.precedent.rangees.length ? `rangé (${c.precedent.rangees.join(' ; ')})` : 'rien de rangé',
      ...c.precedent.ignorees.map((x) => h('span', {}, h('br'), `Ignoré : ${x}`)),
      ...c.precedent.erreurs.map((x) => h('span', { class: 'error' }, h('br'), x))] : []),
  );
}

// ---------- Livres comptables archivés (clôture du mois) ----------

function afficherArchives() {
  const a = (donnees && donnees.archives) || {};
  const mois = Object.entries(a.mois || {}).sort(([x], [y]) => y.localeCompare(x));
  // Libellés courts ; le fichier garde son nom complet (livre-des-recettes-2026-10.csv…).
  const fichiers = (f) => h('span', {}, ...(f.fichiers || []).map((p) => {
    const b = lienPiece(p);
    b.lastChild.textContent = p.nom.startsWith('livre') ? 'Recettes' : 'Achats';
    return b;
  }));
  const refaire = (cle) => h('button', {
    type: 'button', class: 'link', title: 'Refaire avec les données actuelles',
    onclick: (e) => { e.stopPropagation(); cloturer(cle); },
  }, 'Refaire');
  remplirTable($('t-archives'), [
    { titre: 'Mois' }, { titre: 'Recettes', n: 1 }, { titre: 'Achats', n: 1 }, { titre: 'Fichiers' }, { titre: 'Figé le' }, { titre: '' },
  ], mois.map(([cle, f]) => [moisNom(cle), euros(f.recettes.total), euros(f.achats.total), fichiers(f), jour(f.le), refaire(cle)]),
  { vide: 'Premier archivage le 1er du mois prochain.' });
  const annees = Object.entries(a.annees || {}).sort(([x], [y]) => y.localeCompare(x));
  $('t-impots').hidden = !annees.length;
  if (annees.length) {
    remplirTable($('t-impots'), [
      { titre: 'Déclaration de revenus' }, { titre: 'Chiffre d\'affaires encaissé', n: 1 }, { titre: 'Où le reporter' }, { titre: 'Fichiers de l\'année' },
    ], annees.map(([an, f]) => [`Revenus ${an}`, euros(f.recettes.total),
      '2042-C-PRO, case 5KP (ou 5TB avec versement libératoire), à vérifier', fichiers(f)]));
  }
}

async function cloturer(cle) {
  const b = $('btn-cloturer');
  b.disabled = true;
  $('cloture').hidden = false;
  $('cloture').className = 'muted small';
  $('cloture').textContent = 'Archivage en cours…';
  try {
    const r = await appeler('gestionCloturer', cle ? { mois: cle } : {});
    $('cloture').textContent = !r.mois.length ? 'Rien de nouveau à archiver.'
      : `${r.mois.map(moisNom).join(', ')} archivé${r.mois.length > 1 ? 's' : ''}${r.envoye ? ' et envoyé par e-mail' : ', mais l\'e-mail n\'est pas parti'}.`;
    signalerChangement();
  } catch (e) {
    $('cloture').className = 'error small';
    $('cloture').textContent = messageErreur(e);
  } finally {
    b.disabled = false;
  }
}
$('btn-cloturer').addEventListener('click', () => cloturer());

// ---------- Clients et e-mails d'information ----------
// gestionClients fusionne commandes et paniers abandonnés par e-mail ; l'envoi ne part qu'aux personnes
// qui ont accepté (vérifié aussi par le serveur), avec un lien de désinscription.

let clients = null;
// attente : « Être prévenu » du site quand il n'y a plus de tablette en stock (à rappeler à la main, aucun SMS automatique).
const TYPES_CLIENT = { client: 'Abonné', ancien: 'Ancien client', panier: 'Panier abandonné', attente: 'Liste d\'attente', contact: 'Contact', chat: 'Contact du chat' };
const STATUTS_CLIENT = {
  actif: 'actif', offert: 'offert', impaye: 'impayé', suspendu: 'suspendu', resilie: 'résilié', aucun: 'sans abonnement', installation: 'installation en cours', annulee: 'annulée',
};

// Rond de chargement au milieu de la zone, tant que les données ne sont pas arrivées.
function attente(texte = 'Chargement…') {
  return h('div', { class: 'attente', role: 'status' }, h('span', { class: 'roue' }), h('p', {}, texte));
}

let clientsLus = 0;
let clientsEnCours = null;
async function chargerClients() {
  if (clientsEnCours) return clientsEnCours;
  if (!clients) $('kpi-clients').replaceChildren(attente('Chargement des clients…'));
  clientsEnCours = (async () => {
    try {
      clients = await appeler('gestionClients');
      clientsLus = Date.now();
      afficherClients();
    } catch (e) {
      erreur(e);
    } finally {
      clientsEnCours = null;
    }
  })();
  return clientsEnCours;
}

function clientsAffiches() {
  if (!clients) return [];
  const filtre = $('filtre-clients').value;
  const q = $('cherche-clients').value.trim().toLowerCase();
  return clients.contacts.filter((c) => {
    if (filtre === 'accord' ? !(c.consentement && !c.desinscrit) : filtre && c.type !== filtre) return false;
    return !q || [c.nom, c.email, c.telephone].some((v) => v && v.toLowerCase().includes(q));
  });
}

function accordTexte(c) {
  if (c.desinscrit) return badge('Désinscrit', 'ko');
  return c.consentement ? badge('Oui', 'ok') : h('span', { class: 'muted' }, 'Non');
}

function afficherClients() {
  if (!clients) return;
  const tous = clients.contacts;
  const compte = (f) => tous.filter(f).length;
  $('kpi-clients').replaceChildren(
    stat(String(compte((c) => c.type === 'client')), 'abonnés'),
    stat(String(compte((c) => c.type === 'ancien')), 'anciens clients'),
    stat(String(compte((c) => c.type === 'panier')), 'paniers abandonnés'),
    stat(String(compte((c) => c.type === 'attente')), 'en liste d\'attente'),
    stat(String(compte((c) => c.type === 'chat')), 'contacts du chat'),
    stat(String(compte((c) => c.consentement && !c.desinscrit)), 'acceptent les e-mails', `${compte((c) => c.desinscrit)} désinscrits`),
  );
  const liste = clientsAffiches();
  remplirTable($('t-clients'), [
    { titre: 'Nom' }, { titre: 'E-mail' }, { titre: 'Téléphone' }, { titre: 'Situation' }, { titre: 'Depuis' }, { titre: 'E-mails' },
  ], liste.map((c) => ({
    cellules: [
      c.nom || '', c.email,
      // Toucher le numéro appelle (sans ouvrir la fiche).
      c.telephone ? h('a', { href: `tel:${c.telephone.replace(/\s/g, '')}`, onclick: (e) => e.stopPropagation() }, c.telephone) : '',
      [TYPES_CLIENT[c.type] || '', c.statut && c.type !== 'panier' ? ` (${STATUTS_CLIENT[c.statut] || c.statut})` : '', c.formule === 'wifi' ? ' · Wi-Fi (ancienne formule)' : ''].join(''),
      jour(c.depuis), accordTexte(c),
    ],
    onclick: () => { location.hash = `#client/${encodeURIComponent(c.email)}`; },
  })), { vide: 'Personne pour ce filtre.' });
  const cible = liste.filter((c) => c.consentement && !c.desinscrit).length;
  $('campagne-cible').textContent = cible
    ? `Destinataires : ${pluriel(cible, 'personne')} de la liste affichée (${pluriel(liste.length - cible, 'autre')} sans accord, ignorée${liste.length - cible > 1 ? 's' : ''}).`
    : 'Personne dans la liste affichée n\'a accepté les e-mails d\'information.';
  $('campagne-envoyer').disabled = !cible;
  $('campagnes').replaceChildren(...(clients.campagnes.length
    ? clients.campagnes.map((k) => h('li', {}, h('strong', {}, k.objet), ` · ${jour(k.le)} · ${pluriel(k.envoyes || 0, 'envoi')}`,
      k.erreurs && k.erreurs.length ? h('span', { class: 'error' }, ` · ${pluriel(k.erreurs.length, 'échec')}`) : null))
    : [h('li', { class: 'muted' }, 'Aucun envoi pour l\'instant.')]));
  afficherFiche();
}

// Page d'une famille (admin.js) : qui l'a commandée, sa commande et sa tablette.
// Une ligne par commande (avec son client et sa tablette) ; les commandes finies ou annulées repliées en dessous.
function remplirLiensFamille(fid) {
  const commandes = donnees.commandes.filter((c) => c.fid === fid).sort((a, b) => (b.creeLe || 0) - (a.creeLe || 0));
  const tablettes = donnees.stock.filter((t) => t.fid === fid || commandes.some((c) => c.id === t.commande));
  const ligneLien = (quoi, href, texte, detail) => h('li', {}, h('span', { class: 'll-quoi' }, quoi),
    h('a', { href }, texte), detail ? h('span', { class: 'muted small' }, detail) : null);
  const nomTablette = (t) => [t.ref, t.numero || t.modele].filter(Boolean).join(' · ') || 'Tablette';
  const blocCommande = (c) => {
    const t = tablettes.find((x) => x.commande === c.id);
    const [etat] = ETATS_COMMANDE[etatCommande(c)];
    return [
      ligneLien('Commande', `#commande/${encodeURIComponent(c.id)}`, `Commande ${codeCommande(c.code)}`,
        [c.offerte ? 'offerte' : null, etat.toLowerCase(), jour(c.creeLe)].filter(Boolean).join(' · ')),
      c.email ? ligneLien('Client', `#client/${encodeURIComponent(c.email.toLowerCase())}`, c.nom || c.email, c.nom ? c.email : '') : null,
      t ? ligneLien('Tablette', `#tablette/${encodeURIComponent(t.id)}`, nomTablette(t), donnees.etats[etatTablette(t)] || t.etat) : null,
    ].filter(Boolean);
  };
  const finie = (c) => ['terminee', 'annulee'].includes(etatCommande(c));
  const enCours = commandes.filter((c) => !finie(c));
  const finies = commandes.filter(finie);
  // Tablette de la famille sans commande rattachée (jumelée à la main, ancienne fiche).
  const seules = tablettes.filter((t) => !commandes.some((c) => c.id === t.commande));
  $('famille-liens').replaceChildren(...[
    h('h2', {}, 'Commande, client et tablette'),
    ...enCours.map((c) => h('ul', { class: 'liste-liens groupe-commande' }, ...blocCommande(c))),
    seules.length ? h('ul', { class: 'liste-liens groupe-commande' }, ...seules.map((t) => ligneLien('Tablette', `#tablette/${encodeURIComponent(t.id)}`,
      nomTablette(t), donnees.etats[etatTablette(t)] || t.etat))) : null,
    finies.length ? h('details', { class: 'anciennes' }, h('summary', {}, `${pluriel(finies.length, 'commande')} terminée${finies.length > 1 ? 's' : ''} ou annulée${finies.length > 1 ? 's' : ''}`),
      ...finies.map((c) => h('ul', { class: 'liste-liens groupe-commande' }, ...blocCommande(c)))) : null,
    commandes.length || tablettes.length ? null : h('p', { class: 'muted small' }, 'Aucune commande ni tablette rattachée à cette famille.'),
  ].filter(Boolean));
}

// Page d'un client : coordonnées, accord e-mails, commandes, famille, tablette et paiements.
let clientAffiche = null;
async function remplirClient(email) {
  const zone = $('dcl-corps');
  const c = clients && clients.contacts.find((x) => x.email === email);
  if (!clients) {
    zone.replaceChildren(attente('Chargement du client…'));
    return;
  }
  if (!c) {
    zone.replaceChildren(h('div', { class: 'card' }, h('p', {}, 'Client introuvable.')));
    return;
  }
  const commandes = donnees.commandes.filter((x) => (x.email || '').toLowerCase() === email)
    .sort((a, b) => (b.creeLe || 0) - (a.creeLe || 0));
  const cle = JSON.stringify([c, commandes.map((x) => [x.id, etatCommande(x), x.fid, x.abonnement])]);
  // Mêmes informations déjà affichées : garder les paiements déjà lus.
  if (clientAffiche === cle && zone.children.length) return;
  clientAffiche = cle;
  document.title = `Papote · ${c.nom || c.email}`;
  const ligne = (k, v) => (v ? [h('dt', {}, k), h('dd', {}, v)] : []);
  const accepte = c.consentement && !c.desinscrit;
  const familles = commandes.filter((x) => x.fid);
  const tablettes = commandes.map((x) => donnees.stock.find((t) => t.commande === x.id)).filter(Boolean);
  const paiements = h('div', {}, h('p', { class: 'muted small' }, commandes.length ? 'Lecture des paiements…' : 'Aucune commande, donc aucun paiement.'));
  zone.replaceChildren(
    h('div', { class: 'card' },
      h('h2', {}, c.nom || c.email),
      h('dl', { class: 'fiche' },
        ligne('Situation', [TYPES_CLIENT[c.type] || '', c.statut && c.type !== 'panier' ? ` (${STATUTS_CLIENT[c.statut] || c.statut})` : ''].join('')),
        ligne('E-mail', h('a', { href: `mailto:${c.email}` }, c.email)),
        ligne('Téléphone', c.telephone ? h('a', { href: `tel:${c.telephone.replace(/\s/g, '')}` }, c.telephone) : null),
        ligne('Formule', c.formule ? (c.formule === 'sim' ? 'Tout compris (carte SIM)' : 'Wi-Fi (ancienne formule)') : null),
        ligne('Client depuis', jour(c.depuis)),
        // Interrupteur : il ne bascule qu'après la confirmation (changerAccord relit la liste).
        ligne('E-mails d\'information', h('label', { class: 'interrupteur' },
          h('input', { type: 'checkbox', class: 'toggle', checked: accepte, 'aria-label': 'Reçoit les e-mails d\'information',
            onchange: (e) => { e.target.checked = accepte; changerAccord(c); } }),
          h('span', {}, accepte ? 'Oui, il ou elle a donné son accord' : c.desinscrit ? 'Non, désinscrit' : 'Non'))))),
    h('div', { class: 'card' }, h('h2', {}, 'Commandes'),
      commandes.length ? h('ul', { class: 'liste-liens' }, commandes.map((x) => {
        const [texte, classe] = ETATS_COMMANDE[etatCommande(x)];
        return h('li', {}, h('a', { href: `#commande/${encodeURIComponent(x.id)}` }, `Commande ${codeCommande(x.code)}`),
          ` · ${jour(x.creeLe)} · ${formuleTexte(x)} `, badge(texte, classe));
      })) : h('p', { class: 'muted small' }, c.type === 'panier' ? 'Panier abandonné : pas de commande.' : 'Aucune commande.')),
    h('div', { class: 'card' }, h('h2', {}, familles.length > 1 ? 'Familles' : 'Famille'),
      familles.length ? h('ul', { class: 'liste-liens' }, familles.map((x) => h('li', {},
        h('a', { href: `#clients/familles/${encodeURIComponent(x.fid)}` }, x.famille || 'Famille sans nom'),
        x.abonnement ? ` · abonnement ${ABONNEMENTS[x.abonnement] || x.abonnement}` : ''))) :
        h('p', { class: 'muted small' }, commandes.length ? 'Pas encore de famille : la tablette n\'a pas été jumelée.' : 'Aucune famille.')),
    h('div', { class: 'card' }, h('h2', {}, tablettes.length > 1 ? 'Tablettes' : 'Tablette'),
      tablettes.length ? h('ul', { class: 'liste-liens' }, tablettes.map((t) => h('li', {},
        h('a', { href: `#tablette/${encodeURIComponent(t.id)}` }, [t.ref, t.numero || t.modele].filter(Boolean).join(' · ') || 'tablette'),
        ` · ${donnees.etats[etatTablette(t)] || t.etat}`))) :
        h('p', { class: 'muted small' }, 'Aucune tablette rattachée.')),
    h('div', { class: 'card' }, h('h2', {}, 'Paiements'), paiements),
  );
  const payantes = commandes.filter((x) => !x.offerte);
  if (!payantes.length) {
    if (commandes.length) paiements.replaceChildren(h('p', { class: 'muted small' }, 'Commande offerte : aucun paiement.'));
    return;
  }
  try {
    const lus = await Promise.all(payantes.map((x) => appeler('gestionCommande', { commande: x.id })));
    const lignes = lus.flatMap((r) => r.paiements).sort((a, b) => b.le - a.le);
    const table = h('table');
    remplirTable(table, [{ titre: 'Date' }, { titre: 'Paiement' }, { titre: 'Montant', n: 1 }, { titre: 'Remboursé', n: 1 }, { titre: 'Statut' }, { titre: '' }],
      lignes.map((p) => [jour(p.le), p.description || (p.facture ? 'Abonnement' : 'Paiement'), euros(p.montant),
        p.rembourse ? euros(p.rembourse) : '', p.statut === 'succeeded' ? badge('payé', 'ok') : badge(p.statut, 'ko'),
        p.recu ? h('a', { href: p.recu, target: '_blank', rel: 'noopener' }, 'Reçu') : '']),
      { vide: 'Aucun paiement pour l\'instant.' });
    const total = lignes.filter((p) => p.statut === 'succeeded').reduce((s, p) => s + p.montant - (p.rembourse || 0), 0);
    paiements.replaceChildren(h('p', { class: 'small' }, `Payé au total : ${euros(total)}`), h('div', { class: 'table' }, table));
  } catch (e) {
    paiements.replaceChildren(h('p', { class: 'error small' }, messageErreur(e)));
  }
}

async function changerAccord(c) {
  const accepte = c.consentement && !c.desinscrit;
  const question = accepte
    ? `Retirer l'accord de ${c.nom || c.email} ? Il ou elle ne recevra plus les e-mails d'information.`
    : `${c.nom || c.email} a accepté de recevoir les e-mails d'information de Papote (de vive voix ou par écrit) ?${c.desinscrit ? ' Attention : cette personne s\'était désinscrite.' : ''}`;
  if (!await demander(question, { oui: accepte ? 'Retirer l\'accord' : 'Oui, il ou elle a accepté' })) return;
  try {
    await appeler('gestionConsentement', { email: c.email, consentement: !accepte });
    clientAffiche = null;
    await chargerClients();
  } catch (e) {
    erreur(e);
  }
}

$('filtre-clients').addEventListener('change', afficherClients);
$('cherche-clients').addEventListener('input', afficherClients);
$('x-clients').addEventListener('click', () => {
  csv('clients', ['Nom', 'E-mail', 'Téléphone', 'Situation', 'Statut', 'Formule', 'Depuis', 'Accepte les e-mails'],
    clientsAffiches().map((c) => [c.nom, c.email, c.telephone, TYPES_CLIENT[c.type] || '', STATUTS_CLIENT[c.statut] || c.statut || '', c.formule || '',
      jour(c.depuis), c.desinscrit ? 'désinscrit' : c.consentement ? 'oui' : 'non']), false);
});

async function envoyerCampagne(test) {
  const form = $('f-campagne');
  const msg = form.querySelector('.f-msg');
  const objet = form.objet.value.trim();
  const message = form.message.value.trim();
  if (!objet || !message) { form.reportValidity(); return; }
  const emails = clientsAffiches().filter((c) => c.consentement && !c.desinscrit).map((c) => c.email);
  if (!test && !await demander(`Envoyer « ${objet} » à ${pluriel(emails.length, 'personne')} ? Pensez à vous envoyer un essai d'abord.`, { oui: 'Envoyer' })) return;
  const boutons = form.querySelectorAll('button');
  boutons.forEach((b) => { b.disabled = true; });
  msg.hidden = false;
  msg.className = 'f-msg small';
  msg.textContent = test ? 'Envoi de l\'essai…' : `Envoi à ${pluriel(emails.length, 'personne')}…`;
  try {
    const r = await appeler('gestionCampagne', { objet, message, emails, test });
    msg.textContent = test ? `Essai envoyé à ${r.a}.` : `${pluriel(r.envoyes, 'e-mail')} envoyé${r.envoyes > 1 ? 's' : ''}.${r.erreurs && r.erreurs.length ? ` Échecs : ${r.erreurs.join(' ; ')}` : ''}`;
    if (!test) { form.reset(); await chargerClients(); }
  } catch (e) {
    msg.className = 'f-msg small error';
    msg.textContent = messageErreur(e);
  }
  boutons.forEach((b) => { b.disabled = false; });
  if (clients) afficherClients();
}

$('campagne-test').addEventListener('click', () => envoyerCampagne(true));

// E-mail d'ouverture des commandes à la liste d'attente (lancementListeAttente, functions/index.js).
async function envoyerLancement(test) {
  if (!test && !await demander("Envoyer l'e-mail « Papote est disponible : vous pouvez commander » à toute la liste d'attente ?\n\n"
    + "Chaque personne ne le reçoit qu'une fois. Pensez à vous envoyer un test d'abord.")) return;
  const msg = $('lancement-msg');
  const boutons = [$('lancement-test'), $('lancement-envoyer')];
  boutons.forEach((b) => { b.disabled = true; });
  msg.hidden = false;
  msg.className = 'small';
  msg.textContent = test ? 'Envoi du test…' : 'Envoi à la liste d\'attente…';
  try {
    const r = await appeler('lancementListeAttente', test ? { test: true } : {});
    msg.textContent = test ? 'Test envoyé à votre adresse.'
      : `${pluriel(r.envoyes || 0, 'e-mail')} envoyé${r.envoyes > 1 ? 's' : ''}${r.erreurs ? `, ${pluriel(r.erreurs, 'échec')} (voir les journaux)` : ''}.`;
    if (!test && r.erreurs) msg.className = 'small error';
  } catch (e) {
    msg.className = 'small error';
    msg.textContent = messageErreur(e);
  }
  boutons.forEach((b) => { b.disabled = false; });
}
$('lancement-test').addEventListener('click', () => envoyerLancement(true));
$('lancement-envoyer').addEventListener('click', () => envoyerLancement(false));
$('f-campagne').addEventListener('submit', (e) => { e.preventDefault(); envoyerCampagne(false); });


// ---------- Réception d'une tablette, pas à pas ----------
// Vérifier, noter le n° de série, préparer, installer Papote (qui donne le numéro T-…), vérifier, ranger.

const libelleTablette = (t) => [t.ref, t.numero, t.modele, t.fournisseur, t.acheteeLe ? `achetée le ${jour(t.acheteeLe)}` : null]
  .filter(Boolean).join(' · ') || 'Tablette sans nom';

function etapesReceptionTablette() {
  const fiche = (e) => donnees.stock.find((t) => t.id === e.id);
  return [
    {
      cle: 'reception',
      titre: 'Réception',
      texte: 'Ouvrez le carton du vendeur. Quel achat est-ce ?',
      contenu(zone, e, maj) {
        const achats = donnees.stock.filter((t) => t.id === e.id || (['commandee', 'en-stock'].includes(t.etat) && !t.ref && !t.commande))
          .sort((a, b) => (a.acheteeLe || 0) - (b.acheteeLe || 0));
        if (e.id === undefined) e.id = achats.length ? achats[0].id : null;
        const choix = h('select', { 'aria-label': 'Achat' },
          ...achats.map((t) => h('option', { value: t.id, selected: t.id === e.id }, libelleTablette(t))),
          h('option', { value: '', selected: !e.id }, 'Pas dans la liste (facture pas encore enregistrée)'));
        const abimee = h('button', { type: 'button', class: 'link small danger' }, 'La tablette est abîmée');
        choix.addEventListener('change', () => { e.id = choix.value || null; maj(); });
        abimee.addEventListener('click', async () => {
          if (!e.id) { prevenir('Enregistrez d\'abord sa facture (Ajouter un achat), puis notez-la « À réparer ».'); return; }
          if (!await demander('Noter cette tablette « À réparer » ? Contactez ensuite le vendeur pour l\'échanger.', { oui: 'À réparer' })) return;
          await appeler('gestionStock', { action: 'modifier', id: e.id, champs: { etat: 'a-reparer' } });
          signalerChangement();
          fermerParcours();
        });
        e.id = choix.value || null;
        zone.append(choix, abimee);
      },
      cases: ['L\'écran n\'est ni rayé ni fissuré', 'La coque n\'est pas abîmée', 'Le chargeur et le câble sont dans la boîte'],
    },
    {
      cle: 'donnees',
      titre: 'Les informations',
      texte: 'Notez le numéro de série (sur la boîte, ou dans Paramètres > À propos de la tablette).',
      contenu(zone, e, maj) {
        const t = fiche(e) || {};
        e.numero = e.numero || t.numero || '';
        e.modele = e.modele || t.modele || '';
        e.fournisseur = e.fournisseur || t.fournisseur || '';
        const form = h('form', { class: 'grille', onsubmit: (ev) => ev.preventDefault() },
          h('label', {}, 'N° de série ', h('span', { class: 'avec-bouton' }, h('input', { name: 'numero', value: e.numero, autocomplete: 'off' }),
            'BarcodeDetector' in window ? h('button', { type: 'button', class: 'secondary small-btn', onclick: () => scanner(form, 'numero') }, 'Scanner') : null)),
          h('label', {}, 'Modèle ', h('input', { name: 'modele', value: e.modele, placeholder: 'ex. M107' })),
          h('label', {}, 'Vendeur ', h('input', { name: 'fournisseur', value: e.fournisseur, placeholder: 'ex. Cdiscount' })));
        const lire = () => {
          e.numero = form.numero.value.trim(); e.modele = form.modele.value.trim(); e.fournisseur = form.fournisseur.value.trim(); maj();
        };
        form.addEventListener('input', lire);
        $('d-scan').addEventListener('close', lire);
        zone.append(form);
      },
      pret: (e) => !!e.numero,
      async valider(e) {
        if (e.id) await appeler('gestionStock', { action: 'modifier', id: e.id, champs: { numero: e.numero, modele: e.modele, ...(e.fournisseur ? { fournisseur: e.fournisseur } : {}) } });
        // Facture pas encore là : une fiche sans achat, que l'installation reprendra et que la facture complétera.
        else e.id = (await appeler('gestionStock', { action: 'recue', numero: e.numero, modele: e.modele, fournisseur: e.fournisseur })).id;
      },
    },
    {
      cle: 'preparer',
      titre: 'Préparer la tablette',
      texte: 'Allumez la tablette et faites la configuration de départ.',
      cases: [
        'Configuration passée SANS ajouter de compte Google ni Samsung',
        'Paramètres > À propos > « Numéro de build » : touché 7 fois',
        'Paramètres > Options pour les développeurs > « Débogage USB » : activé',
      ],
    },
    {
      cle: 'installation',
      titre: 'Installer Papote',
      texte: 'Branchez la tablette au PC en USB. Dans PowerShell, dans le dossier Papote, lancez :',
      contenu(zone, e, maj) {
        const commande = '.\\installation\\installer-tablette.bat';
        const copier = h('button', { type: 'button', class: 'secondary small-btn' }, 'Copier');
        copier.addEventListener('click', () => navigator.clipboard.writeText(commande).then(() => { copier.textContent = 'Copié'; }).catch(() => null));
        const ref = h('input', { placeholder: 'T-012', value: e.ref || '', autocomplete: 'off', 'aria-label': 'Numéro donné par l\'installation' });
        ref.addEventListener('input', () => { e.ref = ref.value.trim(); maj(); });
        // L'installation note le T-0… sur la fiche de cette réception (preparer-tablette.js) : il s'affiche tout seul.
        const attente = h('p', { class: 'small muted' }, 'En attente de la fin de l\'installation…');
        const chercher = async () => {
          if (!zone.isConnected || /^T-\d+$/.test(e.ref || '')) return;
          const t = e.id && (await lireDonnees(true).catch(() => null))?.stock.find((x) => x.id === e.id);
          if (t && t.ref) {
            e.ref = t.ref;
            ref.value = t.ref;
            attente.textContent = `Installation terminée : ${t.ref}.`;
            maj();
            return;
          }
          setTimeout(chercher, 6000);
        };
        if (e.id) setTimeout(chercher, 6000);
        else attente.hidden = true;
        zone.append(
          h('div', { class: 'pc-commande' }, h('code', {}, commande), copier),
          h('ol', { class: 'pc-liste' },
            h('li', {}, 'Sur la tablette, acceptez « Autoriser le débogage USB » (cochez « Toujours »).'),
            h('li', {}, 'Quand le script demande un code, appuyez sur Entrée sans rien taper.'),
            h('li', {}, 'À la fin, il affiche « Écrivez T-0… sur le carton ». Le numéro arrive ici tout seul (sinon, tapez-le) :')),
          ref, attente);
      },
      pret: (e) => /^T-?\d{1,5}$/i.test(e.ref || ''),
      async valider(e) {
        const r = await appeler('gestionParcours', { type: 'lier', id: e.id || null, ref: e.ref });
        const sansFiche = !e.id;
        e.id = r.id;
        e.ref = r.ref;
        if (sansFiche && e.numero) await appeler('gestionStock', { action: 'modifier', id: e.id, champs: { numero: e.numero, modele: e.modele } });
      },
    },
    {
      cle: 'verification',
      titre: 'Vérifier la tablette',
      texte: 'Bientôt ici : une vérification guidée de toutes les fonctions (appel vidéo, photos, son). Pour l\'instant :',
      cases: ['La tablette affiche l\'écran « Bienvenue » de Papote'],
    },
    {
      cle: 'rangement',
      titre: 'Ranger la tablette',
      texte: 'Écrivez ce numéro au feutre au dos de la tablette (sur un autocollant) et sur sa boîte :',
      contenu(zone, e) { zone.append(h('p', { class: 'pc-gros' }, e.ref || '')); },
      cases: ['Numéro écrit au dos de la tablette', 'Numéro écrit sur la boîte', 'Tablette rangée dans sa boîte avec son chargeur'],
      bouton: 'Terminer',
    },
  ];
}

// id : la tablette commandée dont on fait la réception (depuis sa page) ; sinon on la choisit dans le parcours.
async function recevoirTablette(id) {
  if (!donnees) return;
  const pour = typeof id === 'string' ? id : null;
  const enCours = donnees.stock.find((t) => t.reception && !t.reception.fini && (!pour || t.id === pour));
  const reprendre = enCours && (pour || await demander(`Reprendre la réception de ${libelleTablette(enCours)} ?`));
  const etat = reprendre
    ? { ...enCours.reception, id: enCours.id, ref: enCours.ref || '', numero: enCours.numero || '', modele: enCours.modele || '' }
    : { etape: 0, faits: {}, ...(pour ? { id: pour } : {}) };
  await ouvrirParcours({
    titre: 'Recevoir une tablette',
    etapes: etapesReceptionTablette(),
    etat,
    sauver: (e) => (e.id ? appeler('gestionParcours', { type: 'reception', id: e.id, reception: e }) : null),
  });
  signalerChangement();
}
$('btn-recevoir').addEventListener('click', recevoirTablette);

// ---------- Réception d'accessoires (routeurs 4G…), pas à pas ----------

const estRouteur = (a) => /routeur|4g|modem|cl[ée]/i.test((a && a.nom) || '');

function etapesReceptionAccessoire() {
  const acc = (e) => donnees.accessoires.find((a) => a.id === e.id);
  return [
    {
      cle: 'choix',
      titre: 'Ce qui est arrivé',
      contenu(zone, e, maj) {
        const liste = donnees.accessoires.slice().sort((a, b) => estRouteur(b) - estRouteur(a) || a.nom.localeCompare(b.nom, 'fr'));
        if (!liste.length) {
          zone.append(h('p', { class: 'error small' }, 'Aucun accessoire : créez-le d\'abord (Ajouter un accessoire).'));
          return;
        }
        e.id = e.id || liste[0].id;
        const form = h('form', { class: 'grille', onsubmit: (ev) => ev.preventDefault() },
          h('label', {}, 'Accessoire ', h('select', { name: 'acc' }, ...liste.map((a) => h('option', { value: a.id, selected: a.id === e.id }, a.nom)))),
          h('label', {}, 'Quantité reçue ', h('input', { name: 'quantite', inputmode: 'numeric', value: e.quantite || '' })),
          h('label', {}, 'Montant payé (€) ', h('input', { name: 'montant', inputmode: 'decimal', placeholder: 'facultatif', value: e.montant || '' })),
          h('label', {}, 'Vendeur ', h('input', { name: 'fournisseur', placeholder: 'facultatif', value: e.fournisseur || '' })));
        const lire = () => {
          e.id = form.acc.value;
          e.quantite = form.quantite.value.trim();
          e.montant = form.montant.value.trim();
          e.fournisseur = form.fournisseur.value.trim();
          maj();
        };
        form.addEventListener('input', lire);
        form.addEventListener('change', lire);
        zone.append(form);
      },
      pret: (e) => !!acc(e) && /^\d+$/.test(e.quantite || '') && Number(e.quantite) > 0,
      valider(e) { e.bons = String(e.quantite); },
    },
    {
      cle: 'test',
      titre: 'Tester',
      texte: (e) => (estRouteur(acc(e)) ? 'Testez chaque routeur, un par un :' : 'Vérifiez chaque article :'),
      cases: (e) => (estRouteur(acc(e)) ? [
        'Carte SIM de test glissée dans le routeur',
        'Routeur branché sur une prise USB : le voyant s\'allume',
        'Après une minute, son Wi-Fi apparaît sur le téléphone (nom et mot de passe sous le capot)',
        'Téléphone connecté à ce Wi-Fi : une page internet s\'ouvre',
        'Carte SIM de test retirée',
      ] : ['Complet et en bon état']),
      apres: true,
      contenu(zone, e, maj) {
        const bons = h('input', { inputmode: 'numeric', value: e.bons || e.quantite, 'aria-label': 'Combien fonctionnent' });
        bons.addEventListener('input', () => { e.bons = bons.value.trim(); maj(); });
        zone.append(h('label', { class: 'pc-champ' }, `Combien fonctionnent, sur ${e.quantite} ?`, bons));
      },
      pret: (e) => /^\d+$/.test(e.bons || '') && Number(e.bons) <= Number(e.quantite),
    },
    {
      cle: 'stock',
      titre: 'Ranger',
      texte: (e) => {
        const ko = Number(e.quantite) - Number(e.bons);
        return `${e.bons} ${acc(e) ? acc(e).nom : ''} ajouté${Number(e.bons) > 1 ? 's' : ''} au stock.${ko ? ` Mettez de côté ${ko === 1 ? 'celui qui ne marche pas' : `les ${ko} qui ne marchent pas`} : à renvoyer au vendeur.` : ''}`;
      },
      cases: ['Rangés avec le stock'],
      bouton: 'Ajouter au stock',
      async valider(e) {
        if (Number(e.bons) > 0) {
          await appeler('gestionAccessoire', {
            action: 'entree', id: e.id, quantite: Number(e.bons), montant: enCentimes(e.montant) || null, fournisseur: e.fournisseur || null,
          });
        }
      },
    },
  ];
}

$('btn-recevoir-accessoire').addEventListener('click', async () => {
  if (!donnees) return;
  await ouvrirParcours({ titre: 'Recevoir une livraison', etapes: etapesReceptionAccessoire(), etat: { etape: 0, faits: {} } });
  signalerChangement();
});

// « ← Retour » : revient à la page d'avant, comme le bouton retour du téléphone. Sans page d'avant
// dans l'admin (lien ouvert directement), il mène à la liste parente (son lien ou son bouton).
const pilePages = [location.hash];
window.addEventListener('hashchange', () => {
  if (pilePages.length > 1 && pilePages[pilePages.length - 2] === location.hash) pilePages.pop();
  else pilePages.push(location.hash);
});
document.addEventListener('click', (e) => {
  const r = e.target.closest('.retour');
  if (!r || pilePages.length < 2) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  history.back();
}, true);
