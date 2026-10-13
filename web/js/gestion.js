// Espace d'administration, partie gestion : navigation entre les sections, accueil « À faire »,
// commandes, stock de tablettes, factures et comptabilité. Tout passe par les fonctions serveur
// gestion* (functions/gestion.js) : l'argent vient de Stripe, le stock et les dépenses de Firestore.
// Les factures déposées sont lues automatiquement (gestionLireFacture) pour préremplir les fiches.
// La connexion et les sections familles, envois et maintenance sont dans admin.js.
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  appeler, donnees as lireDonnees, signalerChangement, messageErreur,
} from './gestion-api.js';

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
      cellules.map((v, i) => h('td', { class: colonnes[i].n ? 'n' : null }, v ?? '')));
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

async function envoyerPieces(collection, id, fichiers) {
  for (const brut of fichiers) {
    const fichier = await alleger(brut);
    if (fichier.size > MAX_PIECE) throw new Error(`${fichier.name} dépasse 6 Mo.`);
    await appeler('gestionPiece', {
      action: 'ajouter', collection, id, nom: fichier.name, type: fichier.type, contenu: await lireFichier(fichier),
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
    alert(messageErreur(e));
  }
}

function lienPiece(piece) {
  return h('button', { type: 'button', class: 'piece', title: piece.nom, onclick: (e) => { e.stopPropagation(); ouvrirPiece(piece); } },
    '📎 ', piece.nom.length > 28 ? `${piece.nom.slice(0, 25)}…` : piece.nom);
}

// ---------- État ----------

let donnees = null; // gestionDonnees
let stripe = null; // gestionStripe pour la période choisie
let stripeMois = null; // gestionStripe pour le mois en cours (accueil)
let periode = null; // { debut, fin } en millisecondes, fin exclue

function erreur(e) {
  console.error(e);
  $('erreur').textContent = messageErreur(e);
  $('erreur').hidden = false;
}

// ---------- Navigation ----------

const TITRES = {
  accueil: 'Accueil',
  commandes: 'Commandes',
  familles: 'Familles et tablettes',
  stock: 'Stock de tablettes',
  factures: 'Factures',
  compta: 'Comptabilité',
  outils: 'Maintenance',
};
const AVEC_PERIODE = ['factures', 'compta'];

function pageCourante() {
  const p = location.hash.slice(1);
  return TITRES[p] ? p : 'accueil';
}

function afficherPage() {
  const page = pageCourante();
  document.querySelectorAll('.nav a[data-page]').forEach((a) => {
    a.classList.toggle('actif', a.dataset.page === page);
    // Sur téléphone, le menu défile : garder la section choisie visible.
    if (a.dataset.page === page) a.scrollIntoView({ block: 'nearest', inline: 'center' });
  });
  document.querySelectorAll('[data-panneau]').forEach((p) => { p.hidden = p.dataset.panneau !== page; });
  $('titre-page').textContent = TITRES[page];
  document.title = `Papote · ${TITRES[page]}`;
  $('periode').hidden = !AVEC_PERIODE.includes(page);
  $('p-etat').hidden = !AVEC_PERIODE.includes(page);
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', afficherPage);
afficherPage();

// ---------- Chargement ----------

onAuthStateChanged(getAuth(getApp('admin')), (user) => {
  if (!user) return;
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
}

async function chargerMois() {
  const n = new Date();
  try {
    stripeMois = await appeler('gestionStripe', {
      debut: new Date(n.getFullYear(), n.getMonth(), 1).getTime(),
      fin: new Date(n.getFullYear(), n.getMonth() + 1, 1).getTime(),
    });
    afficherAccueil();
  } catch (e) {
    console.warn('Stripe (mois en cours)', e);
  }
}

function afficherTout() {
  if (donnees) {
    afficherAccueil();
    afficherStock();
    afficherCommandes();
  }
  if (donnees && stripe) {
    afficherBilan();
    afficherFactures();
    afficherCompta();
    afficherGraphiques();
    afficherUrssaf();
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
    const r = await appeler('gestionStripe', periode);
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
  if (r === 'rendue' || r === 'facturee' || ['resilie', 'canceled'].includes(c.abonnement)) return 'terminee';
  if (c.expedition === 'a-preparer') return 'a-envoyer';
  if (c.expedition === 'envoyee' && !c.fid) return 'en-route';
  return 'active';
}
const ETATS_COMMANDE = {
  'a-envoyer': ['À envoyer', 'info'],
  'en-route': ['En route', 'info'],
  active: ['En service', 'ok'],
  retour: ['Tablette à récupérer', 'ko'],
  terminee: ['Terminée', ''],
  annulee: ['Annulée', ''],
};
const ABONNEMENTS = {
  offert: 'offert', actif: 'actif', impaye: 'impayé', suspendu: 'suspendu', resilie: 'résilié', aucun: 'sans abonnement',
  canceled: 'résilié', active: 'actif', trialing: 'en essai', past_due: 'impayé',
};
const RETOURS = {
  attendue: 'Retour attendu', echec: 'Non rendue, prélèvement refusé', rendue: 'Tablette rendue', facturee: 'Non rendue, 120 € prélevés',
};
const REMBOURSEMENTS = {
  'en-cours': 'en cours de remboursement', 'au-retour': 'remboursés au retour', fait: 'remboursés', echec: 'à rembourser depuis Stripe',
};
const FORMULES = { wifi: 'Wi-Fi', sim: 'Internet inclus' };
const formuleTexte = (c) => [FORMULES[c.formule] || c.formule, c.tablette === 'achetee' ? 'tablette achetée' : null]
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

// ---------- Accueil ----------

function afficherAccueil() {
  if (!donnees) return;
  const cmd = donnees.commandes;
  const aEnvoyer = cmd.filter((c) => etatCommande(c) === 'a-envoyer').length;
  const aRecuperer = cmd.filter((c) => etatCommande(c) === 'retour').length;
  const sansJumelage = cmd.filter((c) => etatCommande(c) === 'en-route' && c.envoyeeLe && Date.now() - c.envoyeeLe > 20 * 864e5).length;
  const aRembourser = cmd.filter((c) => c.remboursement && c.remboursement.statut === 'echec').length;
  const dispo = donnees.stock.filter((t) => DISPONIBLES.includes(t.etat) && !t.commande).length;
  const manque = Math.max(0, aEnvoyer - dispo);
  const aVerifier = donnees.stock.filter((t) => t.etat === 'revenue').length;
  const impayees = stripeMois ? stripeMois.abonnements.filter((a) => a.statut === 'past_due').length : 0;
  const problemes = donnees.automatique ? (donnees.automatique.erreurs || []).length : 0;

  const taches = [
    [aEnvoyer, pluriel(aEnvoyer, 'tablette') + ' à envoyer', '#commandes', manque ? 'ko' : ''],
    [manque, `Il manque ${pluriel(manque, 'tablette')} en stock pour les envoyer`, '#stock', 'ko'],
    [sansJumelage, `${pluriel(sansJumelage, 'tablette')} reçue${sansJumelage > 1 ? 's' : ''} mais pas jumelée${sansJumelage > 1 ? 's' : ''} après 20 jours : appeler le client`, '#commandes', 'ko'],
    [aRecuperer, `${pluriel(aRecuperer, 'tablette')} à récupérer`, '#commandes', ''],
    [aVerifier, `${pluriel(aVerifier, 'tablette')} revenue${aVerifier > 1 ? 's' : ''}, à vérifier avant de remettre en stock`, '#stock', ''],
    [aRembourser, `${pluriel(aRembourser, 'remboursement')} échoué${aRembourser > 1 ? 's' : ''}, à faire depuis Stripe`, '#commandes', 'ko'],
    [impayees, `${pluriel(impayees, 'abonnement')} impayé${impayees > 1 ? 's' : ''}`, '#factures', 'ko'],
    [problemes, `${pluriel(problemes, 'problème')} lors du dernier passage automatique (détail plus bas)`, '#accueil', 'ko'],
  ].filter(([n]) => n > 0);
  $('a-faire').replaceChildren(...(taches.length
    ? taches.map(([, texte, lien, classe]) => h('li', {}, h('a', { href: lien, class: classe }, texte, h('span', { 'aria-hidden': 'true' }, '›'))))
    : [h('li', { class: 'muted' }, 'Rien à faire pour le moment.')]));

  const pastille = (id, n) => {
    $(id).hidden = !n;
    $(id).textContent = n || '';
  };
  pastille('n-accueil', taches.length);
  pastille('n-commandes', aEnvoyer + aRecuperer);
  pastille('n-stock', manque + aVerifier);
  afficherAutomatique();

  if (stripeMois) {
    const n = new Date();
    const mois = { debut: new Date(n.getFullYear(), n.getMonth(), 1).getTime(), fin: new Date(n.getFullYear(), n.getMonth() + 1, 1).getTime() };
    const t = totaux(stripeMois.mouvements, depensesDe(mois));
    const enCours = stripeMois.abonnements.filter((a) => ['active', 'trialing', 'past_due'].includes(a.statut));
    $('kpi-mois').replaceChildren(
      stat(euros(t.encaisse), 'encaissé'),
      stat(euros(t.depenses), 'dépensé'),
      stat(euros(t.resultat), 'résultat', null, t.resultat < 0 ? 'neg' : null),
      stat(String(cmd.filter((c) => dans(mois, c.creeLe)).length), 'nouvelles commandes'),
      stat(String(enCours.length), 'abonnements en cours'),
    );
  }
}

// ---------- Commandes ----------

function afficherCommandes() {
  const toutes = donnees.commandes.slice().sort((a, b) => (b.creeLe || 0) - (a.creeLe || 0));
  const parEtat = {};
  for (const c of toutes) parEtat[etatCommande(c)] = (parEtat[etatCommande(c)] || 0) + 1;
  $('kpi-commandes').replaceChildren(
    stat(String(toutes.length), 'commandes au total'),
    stat(String(parEtat['a-envoyer'] || 0), 'à envoyer'),
    stat(String(parEtat['en-route'] || 0), 'en route'),
    stat(String(parEtat.active || 0), 'en service'),
    stat(String(parEtat.retour || 0), 'à récupérer', null, parEtat.retour ? 'neg' : null),
  );
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
    return `Point relais ${l.nom || ''} (n° ${l.id || '?'}), ${[l.adresse, `${l.cp || ''} ${l.ville || ''}`.trim()].filter(Boolean).join(', ')}`;
  }
  const a = l.adresse || {};
  return [l.nom, a.line1, a.line2, `${a.postal_code || ''} ${a.city || ''}`.trim()].filter(Boolean).join(', ') || '—';
}

const STATUTS_FACTURE = {
  paid: ['Payée', 'ok'], open: ['À payer', 'info'], uncollectible: ['Irrécouvrable', 'ko'],
  void: ['Annulée', ''], draft: ['Brouillon', ''],
};

// Fiche d'une commande : client, livraison, tablette, factures et paiements Stripe.
async function ouvrirCommande(c) {
  const t = donnees.stock.find((x) => x.commande === c.id);
  const [texte, classe] = ETATS_COMMANDE[etatCommande(c)];
  $('dc-titre').textContent = `Commande ${codeCommande(c.code)}`;
  const ligne = (k, v) => (v ? [h('dt', {}, k), h('dd', {}, v)] : []);
  const factures = h('div', {}, h('p', { class: 'muted small' }, 'Lecture des factures…'));
  $('dc-corps').replaceChildren(
    h('dl', { class: 'fiche' },
      ligne('État', badge(texte, classe)),
      ligne('Commandée le', jour(c.creeLe)),
      ligne('Client', [c.nom, c.email, c.telephone].filter(Boolean).join(' · ')),
      ligne('Formule', formuleTexte(c)),
      ligne('Livraison', livraisonTexte(c)),
      ligne('Suivi', c.suivi ? `${c.suivi}${c.envoyeeLe ? `, envoyée le ${jour(c.envoyeeLe)}` : ''}` : null),
      ligne('Famille', c.famille ? `${c.famille}${c.abonnement ? ` (${ABONNEMENTS[c.abonnement] || c.abonnement})` : ''}` : null),
      ligne('Tablette', t ? h('button', { type: 'button', class: 'link', onclick: () => ouvrirTablette(t.id) },
        [t.numero || 'sans n° de série', t.modele].filter(Boolean).join(' · ')) : null),
      ligne('Retour', c.restitution ? `${RETOURS[c.restitution.statut] || c.restitution.statut}${c.restitution.avant && c.restitution.statut === 'attendue' ? ` avant le ${jour(c.restitution.avant)}` : ''}` : null),
      ligne('Remboursement', c.remboursement ? `${euros(c.remboursement.montant)} ${REMBOURSEMENTS[c.remboursement.statut] || c.remboursement.statut}` : null)),
    h('h3', {}, 'Parcours'),
    h('ul', { class: 'historique small' }, parcoursCommande(c).map(([le, texte]) => h('li', {}, le ? `${jour(le)} : ${texte}` : texte))),
    h('h3', {}, 'Factures et paiements'),
    factures,
  );
  $('d-commande').showModal();
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
    factures.replaceChildren(h('p', { class: 'small' }, `Payé au total : ${euros(paye)}`),
      h('div', { class: 'table' }, table), ...(autres.length ? [h('div', { class: 'table' }, table2)] : []));
  } catch (e) {
    factures.replaceChildren(h('p', { class: 'error small' }, messageErreur(e)));
  }
}

// Grandes étapes d'une commande, de la commande au retour de la tablette.
function parcoursCommande(c) {
  const etapes = [[c.creeLe, 'commande passée']];
  if (c.envoyeeLe) etapes.push([c.envoyeeLe, `tablette envoyée${c.suivi ? ` (suivi ${c.suivi})` : ''}`]);
  for (const t of donnees.stock) {
    for (const x of t.historique || []) {
      if (x.le && x.commande === c.id && !['envoyee'].includes(x.etat)) {
        etapes.push([x.le, `tablette ${t.numero || t.modele || ''} : ${(donnees.etats[x.etat] || x.etat).toLowerCase()}`]);
      }
    }
  }
  if (c.fid) etapes.push([null, `jumelée avec la famille ${c.famille || ''}`.trim()]);
  if (c.restitution) etapes.push([c.restitution.avant, RETOURS[c.restitution.statut] || c.restitution.statut]);
  if (c.remboursement) etapes.push([null, `${euros(c.remboursement.montant)} ${REMBOURSEMENTS[c.remboursement.statut] || c.remboursement.statut}`]);
  // Étapes sans date (jumelage, remboursement) à la suite des autres.
  return etapes.filter(([, texte]) => texte).sort((a, b) => (a[0] || Infinity) - (b[0] || Infinity));
}

// ---------- Stock ----------

function afficherStock() {
  const stock = donnees.stock.map((t) => ({ ...t, affiche: etatTablette(t) }));
  const compte = (etats) => stock.filter((t) => etats.includes(t.affiche)).length;
  const valeur = (etats) => stock.filter((t) => etats.includes(t.affiche)).reduce((s, t) => s + (t.prixAchat || 0), 0);
  const aEnvoyer = donnees.commandes.filter((c) => etatCommande(c) === 'a-envoyer').length;
  const dispo = stock.filter((t) => DISPONIBLES.includes(t.etat) && !t.commande).length;
  const chez = ['envoyee', 'chez-client', 'en-retour'];
  $('kpi-stock').replaceChildren(
    stat(String(dispo), 'disponibles', `valeur ${euros(valeur(DISPONIBLES))}`, dispo < aEnvoyer ? 'neg' : null),
    stat(String(aEnvoyer), 'commandes à envoyer'),
    stat(String(compte(chez)), 'chez les clients', `valeur ${euros(valeur(chez))}`),
    stat(String(compte(['revenue', 'a-reparer'])), 'à vérifier ou réparer'),
    stat(String(compte(['perdue', 'hors-service'])), 'perdues ou hors service'),
  );
  const manque = aEnvoyer - dispo;
  $('alerte-stock').hidden = manque <= 0;
  $('alerte-stock').textContent = manque > 0
    ? `Il manque ${pluriel(manque, 'tablette')} pour envoyer toutes les commandes.` : '';

  const filtre = $('filtre-stock').value;
  const parId = new Map(donnees.commandes.map((c) => [c.id, c]));
  $('stock-vide').hidden = stock.length > 0;
  remplirTable($('t-stock'), [
    { titre: 'N° de série' }, { titre: 'Modèle' }, { titre: 'État' }, { titre: 'Commande' }, { titre: 'SIM' },
    { titre: 'Pièces' }, { titre: 'Prix', n: 1 }, { titre: 'Achetée le' },
  ], stock.filter((t) => !filtre || t.affiche === filtre)
    .sort((a, b) => (b.acheteeLe || 0) - (a.acheteeLe || 0))
    .map((t) => {
      const c = parId.get(t.commande);
      return {
        onclick: () => ouvrirTablette(t.id),
        cellules: [
          t.numero || h('span', { class: 'muted' }, 'à saisir'),
          t.modele || '',
          badge(donnees.etats[t.affiche] || t.affiche, classeEtat(t.affiche)),
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

$('x-stock').addEventListener('click', () => {
  const parId = new Map(donnees.commandes.map((c) => [c.id, c]));
  csv('stock', ['N° de série', 'Modèle', 'Fournisseur', 'État', 'Commande', 'Client', 'SIM', 'Prix d\'achat', 'Achetée le', 'Notes'],
    donnees.stock.map((t) => {
      const c = parId.get(t.commande);
      return [t.numero, t.modele, t.fournisseur, donnees.etats[etatTablette(t)] || t.etat, c ? codeCommande(c.code) : '',
        c ? c.nom || c.email : '', t.sim, csvMontant(t.prixAchat), jour(t.acheteeLe), t.notes];
    }), false);
});

// Fiche d'une tablette : modification, pièces jointes, historique.
let tabletteOuverte = null;
function ouvrirTablette(id) {
  const t = donnees.stock.find((x) => x.id === id);
  if (!t) return;
  tabletteOuverte = t.id;
  const f = $('f-tablette');
  $('dt-titre').textContent = `Tablette ${t.numero || t.modele || ''}`.trim();
  f.numero.value = t.numero || '';
  f.modele.value = t.modele || '';
  f.sim.value = t.sim || '';
  f.notes.value = t.notes || '';
  f.etat.replaceChildren(...Object.entries(donnees.etats).map(([k, v]) => h('option', { value: k, selected: k === t.etat }, v)));
  const prises = new Set(donnees.stock.filter((x) => x.id !== t.id).map((x) => x.commande).filter(Boolean));
  f.commande.replaceChildren(h('option', { value: '' }, 'Aucune'),
    ...donnees.commandes.filter((c) => c.id === t.commande || (!prises.has(c.id) && c.expedition !== 'annulee'))
      .sort((a, b) => (b.creeLe || 0) - (a.creeLe || 0))
      .map((c) => h('option', { value: c.id, selected: c.id === t.commande }, nomCommande(c))));
  $('dt-pieces').replaceChildren(...(t.pieces || []).map((p) => h('li', {}, lienPiece(p),
    h('button', { type: 'button', class: 'link danger small', onclick: () => retirerPiece('stock', t.id, p) }, 'Retirer'))),
  ...piecesTablette(t).filter((p) => !(t.pieces || []).includes(p)).map((p) => h('li', {}, lienPiece(p), h('span', { class: 'muted small' }, ' (achat)'))));
  if (!$('dt-pieces').children.length) $('dt-pieces').append(h('li', { class: 'muted small' }, 'Aucune.'));
  $('dt-historique').replaceChildren(...(t.historique || []).filter((x) => x.le).reverse().map((x) => h('li', {},
    `${new Date(x.le).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} : ${donnees.etats[x.etat] || x.etat}`)));
  $('dt-retirer').hidden = !(t.etat === 'en-stock' && !t.commande && (t.historique || []).length <= 1);
  f.querySelector('.f-msg').hidden = true;
  $('d-tablette').showModal();
}

$('f-tablette').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  await enregistrer(f, async () => {
    await appeler('gestionStock', {
      action: 'modifier',
      id: tabletteOuverte,
      champs: {
        numero: f.numero.value, modele: f.modele.value, etat: f.etat.value, commande: f.commande.value || null,
        sim: f.sim.value, notes: f.notes.value,
      },
    });
    $('d-tablette').close();
  });
});

$('dt-fichier').addEventListener('change', async (e) => {
  const fichiers = [...e.target.files];
  e.target.value = '';
  if (!fichiers.length) return;
  await enregistrer($('f-tablette'), () => envoyerPieces('stock', tabletteOuverte, fichiers), 'Envoi…');
  ouvrirTablette(tabletteOuverte);
});

$('dt-retirer').addEventListener('click', async () => {
  if (!confirm('Retirer cette tablette du stock (erreur de saisie) ?')) return;
  await enregistrer($('f-tablette'), async () => {
    await appeler('gestionStock', { action: 'supprimer', id: tabletteOuverte });
    $('d-tablette').close();
  });
});

async function retirerPiece(collection, id, piece) {
  if (!confirm(`Retirer « ${piece.nom} » ?`)) return;
  try {
    await appeler('gestionPiece', { action: 'retirer', collection, id, chemin: piece.chemin });
    donnees = await lireDonnees(true);
    afficherTout();
    if (collection === 'stock') ouvrirTablette(id);
  } catch (e) {
    alert(messageErreur(e));
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
      `${enCours.filter((a) => a.statut === 'trialing').length} en essai · ${enCours.filter((a) => a.statut === 'past_due').length} impayé(s)`),
    stat(euros(mrr), 'revenu mensuel', 'abonnements payants'),
    stat(String(commandes.length), 'commandes', `${commandes.filter((c) => c.formule === 'sim').length} avec internet inclus`),
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
  'tablette-non-rendue': 'Tablette non rendue',
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
    alert(messageErreur(e));
  }
});

function afficherCompta() {
  const deps = depensesPeriode();
  remplirTable($('t-achats'), [
    { titre: 'Date' }, { titre: 'Fournisseur' }, { titre: 'Libellé' }, { titre: 'Catégorie' }, { titre: 'TTC', n: 1 },
    { titre: 'dont TVA', n: 1 }, { titre: 'Justificatifs' }, { titre: '' },
  ], deps.map((d) => [jour(d.date), d.fournisseur || '', libelleDepense(d), donnees.categories[d.categorie] || d.categorie,
    euros(d.montant), euros(d.tva),
    h('div', { class: 'pieces-liste' }, (d.pieces || []).map(lienPiece),
      d.justificatif ? h('a', { href: d.justificatif, target: '_blank', rel: 'noopener' }, 'Lien') : null,
      h('button', { type: 'button', class: 'link small no-print', onclick: () => { fichierDepense = d.id; choixFichier.click(); } }, '+ Joindre')),
    h('button', { type: 'button', class: 'link danger small no-print', onclick: () => supprimerDepense(d) }, 'Supprimer')]),
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

function libelleDepense(d) {
  return h('div', {}, d.libelle,
    d.numero ? h('span', { class: 'muted' }, ` · n° ${d.numero}`) : null,
    d.recurrence ? h('div', {}, badge('chaque mois', 'info'), ' ',
      h('button', { type: 'button', class: 'link small no-print', onclick: () => arreterDepense(d) }, 'Arrêter')) : null,
    d.depuis ? h('div', { class: 'muted small' }, 'ajoutée automatiquement') : null);
}

async function arreterDepense(d) {
  if (!confirm(`Ne plus ajouter « ${d.libelle} » chaque mois ? Les dépenses déjà inscrites restent.`)) return;
  try {
    await appeler('gestionDepense', { action: 'arreter', id: d.id });
    signalerChangement();
  } catch (e) {
    alert(messageErreur(e));
  }
}

async function supprimerDepense(d) {
  if (!confirm(`Supprimer la dépense « ${d.libelle} » (${euros(d.montant)}) et ses justificatifs ?`)) return;
  try {
    await appeler('gestionDepense', { action: 'supprimer', id: d.id });
    signalerChangement();
  } catch (e) {
    alert(messageErreur(e));
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
  $('filtre-stock').append(...Object.entries(donnees.etats).map(([k, v]) => h('option', { value: k }, v)));
  $('f-depense').elements.categorie.append(...Object.entries(donnees.categories)
    .map(([k, v]) => h('option', { value: k, selected: k === 'autre' }, v)));
}

function ouvrirFormulaire(id) {
  const f = $(id).querySelector('form');
  f.reset();
  const aujourdhui = new Date().toLocaleDateString('sv-SE');
  f.querySelectorAll('input[type="date"]').forEach((i) => { i.value = aujourdhui; });
  f.querySelector('.f-msg').hidden = true;
  $(id).showModal();
}
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
async function enregistrer(form, action, attente = 'Enregistrement…') {
  const boutons = form.querySelectorAll('button');
  boutons.forEach((b) => { b.disabled = true; });
  message(form, attente, true);
  try {
    await action();
    form.querySelector('.f-msg').hidden = true;
    donnees = await lireDonnees(true);
    afficherTout();
    return true;
  } catch (e) {
    console.error(e);
    message(form, messageErreur(e));
    return false;
  } finally {
    boutons.forEach((b) => { b.disabled = false; });
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
    });
    if (fichiers.length && r.depense) await envoyerPieces('depenses', r.depense, fichiers);
  });
  if (ok) {
    $('d-achat').close();
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
      numero: f.numero.value, recurrente: f.recurrente.checked,
    });
    if (fichiers.length) await envoyerPieces('depenses', r.id, fichiers);
  });
  if (ok) {
    $('d-depense').close();
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

const messageLu = (r) => ['Fiche remplie d\'après le document : vérifiez avant d\'enregistrer.',
  r.devise && r.devise !== 'EUR' ? `Attention, montants en ${r.devise}.` : null, r.remarque].filter(Boolean).join(' ');

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
    $('d-depense').close();
    ouvrirFormulaire('d-achat');
    const fa = $('f-stock');
    mettreFichier(fa, fichier);
    remplirAchat(fa, r);
    message(fa, messageLu(r), true);
  }
}

const choixLecture = h('input', { type: 'file', accept: 'application/pdf,image/*', hidden: true });
document.body.append(choixLecture);
choixLecture.addEventListener('change', () => {
  const fichier = choixLecture.files[0];
  choixLecture.value = '';
  if (fichier) deposer(fichier);
});
$('btn-lire').addEventListener('click', () => choixLecture.click());

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
  const ouvert = ['d-achat', 'd-depense'].find((id) => $(id).open);
  if (ouvert) {
    const f = $(ouvert).querySelector('form');
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
  for (const f of donnees.familles) {
    if (trouve(f.nom) && !donnees.commandes.some((c) => c.fid === f.id)) {
      res.push({ texte: f.nom, detail: 'Famille', ouvrir: () => { location.hash = '#familles'; } });
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
  location.hash = '#compta';
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

const memoire = {
  lire: (k, defaut) => { try { return localStorage.getItem(k) || defaut; } catch (e) { return defaut; } },
  ecrire: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* navigation privée */ } },
};
$('u-taux').value = memoire.lire('papote-urssaf-taux', '21,2');
$('u-rythme').value = memoire.lire('papote-urssaf-rythme', 'mois');

function afficherUrssaf() {
  const taux = Number(String($('u-taux').value).replace(',', '.'));
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
$('u-taux').addEventListener('change', () => {
  memoire.ecrire('papote-urssaf-taux', $('u-taux').value);
  if (stripe) afficherUrssaf();
});
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
  $('scan-msg').textContent = 'Visez le code-barres du numéro de série (étiquette de la boîte ou au dos de la tablette).';
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
