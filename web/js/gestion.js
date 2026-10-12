// Page de gestion de l'administrateur : bilan, stock de tablettes, commandes, factures et comptabilité.
// Tout passe par les fonctions serveur gestion* (functions/gestion.js) : l'argent vient de Stripe,
// le stock et les dépenses de Firestore. Même app Firebase « admin » que le tableau de bord :
// connecté là-bas, connecté ici.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';

const app = initializeApp({
  apiKey: 'AIzaSyAvoivJR8p-u2VxUWzlyHzTgP20-5ZG_-E',
  authDomain: 'papote-famille.firebaseapp.com',
  projectId: 'papote-famille',
  storageBucket: 'papote-famille.firebasestorage.app',
  messagingSenderId: '807031084851',
  appId: '1:807031084851:web:b8048e2952cb1e893b1046',
}, 'admin');
const auth = getAuth(app);
const functions = getFunctions(app, 'europe-west1');
const appeler = (nom, data) => httpsCallable(functions, nom, { timeout: 130_000 })(data).then((r) => r.data);

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

// « 89,90 », « 89.9 », « 1 200 » → centimes ; null si illisible.
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
function remplirTable(table, colonnes, lignes, { total, vide = 'Rien sur cette période.' } = {}) {
  table.replaceChildren(
    h('thead', {}, h('tr', {}, colonnes.map((c) => h('th', { class: c.n ? 'n' : null }, c.titre)))),
    h('tbody', {},
      lignes.length ? lignes.map((l) => h('tr', {}, l.map((v, i) => h('td', { class: colonnes[i].n ? 'n' : null }, v ?? ''))))
        : h('tr', {}, h('td', { class: 'vide', colSpan: colonnes.length }, vide)),
      total ? h('tr', { class: 'total' }, total.map((v, i) => h('td', { class: colonnes[i].n ? 'n' : null }, v ?? ''))) : null),
  );
}

function stat(valeur, texte, detail, classe) {
  return h('div', { class: 'stat' }, h('span', { class: classe }, valeur), h('p', {}, texte), detail ? h('small', {}, detail) : null);
}

function badge(texte, classe) {
  return h('span', { class: `badge ${classe || ''}` }, texte);
}

// ---------- CSV pour Excel (séparateur « ; », virgule décimale, BOM UTF-8) ----------

const csvMontant = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));

function csv(nom, entetes, lignes) {
  const cellule = (v) => {
    const t = v == null ? '' : String(v);
    return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const texte = [entetes, ...lignes].map((l) => l.map(cellule).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿', texte], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { href: url, download: `papote-${nom}-${etiquettePeriode()}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- État ----------

let donnees = null; // gestionDonnees
let stripe = null; // gestionStripe pour la période
let periode = null; // { debut, fin } en millisecondes, fin exclue

function erreur(e) {
  console.error(e);
  $('erreur').textContent = e && e.code === 'functions/permission-denied'
    ? 'Ce compte n\'a pas le badge administrateur.'
    : `Erreur : ${(e && e.message) || e}`;
  $('erreur').hidden = false;
}

// ---------- Connexion ----------

$('btn-signin').addEventListener('click', async () => {
  $('signin-error').hidden = true;
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (e) {
    console.error(e);
    $('signin-error').textContent = 'La connexion a échoué. Réessayez.';
    $('signin-error').hidden = false;
  }
});
$('btn-signout').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, (user) => {
  $('signin').hidden = !!user;
  $('app').hidden = !user;
  $('who').textContent = user ? user.email : '';
  if (user) {
    chargerDonnees();
    changerPeriode();
  }
});

// ---------- Onglets ----------

document.querySelectorAll('[data-onglet]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-onglet]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  document.querySelectorAll('[data-panneau]').forEach((p) => { p.hidden = p.dataset.panneau !== b.dataset.onglet; });
  // Stock et commandes ne dépendent pas de la période.
  $('periode').hidden = ['stock', 'commandes'].includes(b.dataset.onglet);
}));

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

const dansPeriode = (ms) => ms != null && ms >= periode.debut && ms < periode.fin;

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
  $('erreur').hidden = true;
  const n = ++demande;
  try {
    const r = await appeler('gestionStripe', periode);
    if (n !== demande) return;
    stripe = r;
    $('p-etat').textContent = `Du ${jour(periode.debut)} au ${jour(periode.fin - 1)} · lu à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
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

async function chargerDonnees() {
  try {
    donnees = await appeler('gestionDonnees');
    preparerFormulaires();
    afficherTout();
  } catch (e) {
    erreur(e);
  }
}

function afficherTout() {
  if (donnees) {
    afficherStock();
    afficherCommandes();
  }
  if (donnees && stripe) {
    afficherBilan();
    afficherFactures();
    afficherCompta();
  }
}

// ---------- Calculs ----------

const ENCAISSEMENTS = ['abonnement', 'tablette-non-rendue'];

function recettes() {
  return stripe.mouvements.filter((m) => ENCAISSEMENTS.includes(m.nature) || m.nature === 'remboursement' || m.nature === 'litige');
}

function depensesPeriode() {
  return donnees.depenses.filter((d) => dansPeriode(d.date)).sort((a, b) => a.date - b.date);
}

// Totaux d'une liste de mouvements et de dépenses.
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

function nomCommande(c) {
  return [codeCommande(c.code), c.nom || c.email].filter(Boolean).join(' · ') || c.id;
}

// ---------- Bilan ----------

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
  const payants = enCours.filter((a) => a.statut !== 'trialing');
  const mrr = payants.reduce((s, a) => s + a.mensuel, 0);
  const commandes = donnees.commandes.filter((c) => dansPeriode(c.creeLe));
  const resilies = abos.filter((a) => dansPeriode(a.finLe));
  $('kpi-activite').replaceChildren(
    stat(String(enCours.length), 'abonnements en cours',
      `${enCours.filter((a) => a.statut === 'trialing').length} en essai · ${enCours.filter((a) => a.statut === 'past_due').length} impayé(s)`),
    stat(euros(mrr), 'revenu mensuel', 'abonnements payants, par mois'),
    stat(String(commandes.length), 'commandes sur la période',
      `${commandes.filter((c) => c.formule === 'sim').length} avec internet inclus`),
    stat(String(resilies.length), 'abonnements terminés sur la période'),
  );

  const lignes = bilanMensuel();
  const total = totaux(stripe.mouvements, depensesPeriode());
  const montant = (c, neg) => h('span', { class: neg && c ? 'neg' : null }, euros(c));
  remplirTable($('t-bilan'), [
    { titre: 'Mois' }, { titre: 'Encaissé', n: 1 }, { titre: 'Remboursé', n: 1 }, { titre: 'Frais Stripe', n: 1 },
    { titre: 'Net', n: 1 }, { titre: 'Dépenses', n: 1 }, { titre: 'Résultat', n: 1 },
  ], lignes.map((l) => [moisNom(l.cle), euros(l.encaisse), euros(l.rembourse), euros(l.frais), euros(l.net),
    euros(l.depenses), montant(l.resultat, l.resultat < 0)]),
  { total: ['Total', euros(total.encaisse), euros(total.rembourse), euros(total.frais), euros(total.net),
    euros(total.depenses), montant(total.resultat, total.resultat < 0)] });

  const parCat = {};
  for (const d of depensesPeriode()) parCat[d.categorie] = (parCat[d.categorie] || 0) + d.montant;
  remplirTable($('t-categories'), [{ titre: 'Catégorie' }, { titre: 'Montant', n: 1 }],
    Object.entries(parCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => [donnees.categories[k] || k, euros(v)]),
    { vide: 'Aucune dépense sur cette période.' });
}

$('x-bilan').addEventListener('click', () => {
  const l = bilanMensuel();
  const t = totaux(stripe.mouvements, depensesPeriode());
  csv('bilan', ['Mois', 'Encaissé', 'Remboursé', 'Frais Stripe', 'Net', 'Dépenses', 'Résultat'],
    [...l.map((x) => [moisNom(x.cle), csvMontant(x.encaisse), csvMontant(x.rembourse), csvMontant(x.frais),
      csvMontant(x.net), csvMontant(x.depenses), csvMontant(x.resultat)]),
    ['Total', csvMontant(t.encaisse), csvMontant(t.rembourse), csvMontant(t.frais), csvMontant(t.net),
      csvMontant(t.depenses), csvMontant(t.resultat)]]);
});
$('imprimer').addEventListener('click', () => window.print());

// ---------- Stock ----------

const DISPONIBLES = ['en-stock', 'preparee'];
const CHEZ_CLIENTS = ['envoyee', 'chez-client', 'en-retour'];

function afficherStock() {
  const stock = donnees.stock;
  const compte = (etats) => stock.filter((t) => etats.includes(t.etat)).length;
  const valeur = (etats) => stock.filter((t) => etats.includes(t.etat)).reduce((s, t) => s + (t.prixAchat || 0), 0);
  const aEnvoyer = donnees.commandes.filter((c) => etatCommande(c) === 'a-envoyer').length;
  const dispo = compte(DISPONIBLES);
  $('kpi-stock').replaceChildren(
    stat(String(dispo), 'disponibles', `valeur ${euros(valeur(DISPONIBLES))}`, dispo < aEnvoyer ? 'neg' : null),
    stat(String(aEnvoyer), 'commandes à envoyer'),
    stat(String(compte(CHEZ_CLIENTS)), 'chez les clients', `valeur ${euros(valeur(CHEZ_CLIENTS))}`),
    stat(String(compte(['a-reparer'])), 'à réparer'),
    stat(String(compte(['perdue', 'hors-service'])), 'perdues ou hors service'),
  );
  const manque = aEnvoyer - dispo;
  $('alerte-stock').hidden = manque <= 0;
  $('alerte-stock').textContent = manque > 0
    ? `Il manque ${manque} tablette${manque > 1 ? 's' : ''} pour envoyer toutes les commandes.` : '';

  const filtre = $('filtre-stock').value;
  const liste = stock.filter((t) => !filtre || t.etat === filtre)
    .sort((a, b) => (b.acheteeLe || 0) - (a.acheteeLe || 0));
  $('stock-vide').hidden = stock.length > 0;
  const commandes = donnees.commandes.slice().sort((a, b) => (b.creeLe || 0) - (a.creeLe || 0));
  const prises = new Set(stock.map((t) => t.commande).filter(Boolean));

  remplirTable($('t-stock'), [
    { titre: 'N° de série' }, { titre: 'Modèle' }, { titre: 'État' }, { titre: 'Commande' }, { titre: 'SIM' },
    { titre: 'Notes' }, { titre: 'Prix', n: 1 }, { titre: 'Achetée le' }, { titre: '' },
  ], liste.map((t) => {
    const enregistrer = (champ) => (e) => modifierTablette(t.id, { [champ]: e.target.value });
    const supprimable = t.etat === 'en-stock' && !t.commande && (t.historique || []).length <= 1;
    return [
      h('input', { value: t.numero || '', placeholder: 'à saisir', onchange: enregistrer('numero') }),
      t.modele || '',
      h('select', { onchange: enregistrer('etat') },
        Object.entries(donnees.etats).map(([k, v]) => h('option', { value: k, selected: k === t.etat }, v))),
      h('select', { onchange: enregistrer('commande') },
        h('option', { value: '' }, '—'),
        commandes.filter((c) => c.id === t.commande || (!prises.has(c.id) && c.expedition !== 'annulee'))
          .map((c) => h('option', { value: c.id, selected: c.id === t.commande }, nomCommande(c)))),
      h('input', { value: t.sim || '', placeholder: 'n° de ligne', onchange: enregistrer('sim') }),
      h('input', { value: t.notes || '', onchange: enregistrer('notes') }),
      euros(t.prixAchat),
      jour(t.acheteeLe),
      supprimable ? h('button', {
        type: 'button', class: 'link danger', title: 'Erreur de saisie', onclick: () => supprimerTablette(t),
      }, 'Retirer') : '',
    ];
  }), { vide: 'Aucune tablette.' });
}
$('filtre-stock').addEventListener('change', afficherStock);

async function modifierTablette(id, champs) {
  try {
    await appeler('gestionStock', { action: 'modifier', id, champs });
    await chargerDonnees();
  } catch (e) {
    erreur(e);
    chargerDonnees();
  }
}

async function supprimerTablette(t) {
  if (!confirm(`Retirer la tablette ${t.numero || t.modele || ''} du stock (erreur de saisie) ?`)) return;
  try {
    await appeler('gestionStock', { action: 'supprimer', id: t.id });
    await chargerDonnees();
  } catch (e) {
    erreur(e);
  }
}

$('x-stock').addEventListener('click', () => {
  const parId = new Map(donnees.commandes.map((c) => [c.id, c]));
  csv('stock', ['N° de série', 'Modèle', 'Fournisseur', 'État', 'Commande', 'Client', 'SIM', 'Prix d\'achat', 'Achetée le', 'Notes'],
    donnees.stock.map((t) => {
      const c = parId.get(t.commande);
      return [t.numero, t.modele, t.fournisseur, donnees.etats[t.etat] || t.etat, c ? codeCommande(c.code) : '',
        c ? c.nom || c.email : '', t.sim, csvMontant(t.prixAchat), jour(t.acheteeLe), t.notes];
    }));
});

// ---------- Commandes ----------

function afficherCommandes() {
  const toutes = donnees.commandes.slice().sort((a, b) => (b.creeLe || 0) - (a.creeLe || 0));
  const parEtat = {};
  for (const c of toutes) parEtat[etatCommande(c)] = (parEtat[etatCommande(c)] || 0) + 1;
  $('kpi-commandes').replaceChildren(
    stat(String(toutes.length), 'commandes au total'),
    stat(String(parEtat['a-envoyer'] || 0), 'à envoyer'),
    stat(String(parEtat['en-route'] || 0), 'envoyées, pas jumelées'),
    stat(String(parEtat.active || 0), 'en service'),
    stat(String(parEtat.retour || 0), 'tablettes à récupérer', null, parEtat.retour ? 'neg' : null),
  );
  const filtre = $('filtre-commandes').value;
  const tablettes = new Map(donnees.stock.filter((t) => t.commande).map((t) => [t.commande, t]));
  remplirTable($('t-commandes'), [
    { titre: 'Date' }, { titre: 'Code' }, { titre: 'Client' }, { titre: 'Formule' }, { titre: 'État' },
    { titre: 'Famille' }, { titre: 'Tablette' }, { titre: 'Retour / remboursement' },
  ], toutes.filter((c) => !filtre || etatCommande(c) === filtre).map((c) => {
    const [texte, classe] = ETATS_COMMANDE[etatCommande(c)];
    const t = tablettes.get(c.id);
    const r = c.restitution;
    const rb = c.remboursement;
    return [
      jour(c.creeLe),
      codeCommande(c.code),
      h('div', {}, c.nom || '', h('br'), h('span', { class: 'muted' }, [c.email, c.telephone].filter(Boolean).join(' · '))),
      formuleTexte(c),
      h('div', {}, badge(texte, classe), c.suivi ? h('div', { class: 'muted' }, `Suivi ${c.suivi}`) : null),
      c.famille ? `${c.famille}${c.abonnement ? ` (${ABONNEMENTS[c.abonnement] || c.abonnement})` : ''}` : '',
      t ? t.numero || t.modele || 'affectée' : (etatCommande(c) === 'a-envoyer' ? h('span', { class: 'muted' }, 'à affecter dans Stock') : ''),
      [r ? `${RETOURS[r.statut] || r.statut}${r.avant && r.statut === 'attendue' ? ` avant le ${jour(r.avant)}` : ''}` : null,
        rb ? `${euros(rb.montant)} ${REMBOURSEMENTS[rb.statut] || rb.statut}` : null].filter(Boolean).join(' · '),
    ];
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
  }));
});

// ---------- Factures ----------

const STATUTS_FACTURE = {
  paid: ['Payée', 'ok'], open: ['À payer', 'info'], uncollectible: ['Irrécouvrable', 'ko'],
  void: ['Annulée', ''], draft: ['Brouillon', ''],
};

function afficherFactures() {
  const toutes = stripe.factures.slice().sort((a, b) => b.le - a.le);
  const filtre = $('filtre-factures').value;
  const liste = toutes.filter((f) => !filtre || f.statut === filtre);
  const somme = (l, k) => l.reduce((s, f) => s + (f[k] || 0), 0);
  const ouvertes = toutes.filter((f) => f.statut === 'open');
  $('kpi-factures').replaceChildren(
    stat(String(toutes.filter((f) => f.statut !== 'draft' && f.statut !== 'void').length), 'factures émises'),
    stat(euros(somme(toutes.filter((f) => f.statut === 'paid'), 'total')), 'facturé et payé'),
    stat(euros(somme(ouvertes, 'du')), 'reste à encaisser', `${ouvertes.length} facture(s)`, ouvertes.length ? 'neg' : null),
  );
  remplirTable($('t-factures'), [
    { titre: 'N°' }, { titre: 'Date' }, { titre: 'Client' }, { titre: 'Détail' }, { titre: 'HT', n: 1 },
    { titre: 'TVA', n: 1 }, { titre: 'TTC', n: 1 }, { titre: 'Statut' }, { titre: '' },
  ], liste.map((f) => {
    const [texte, classe] = STATUTS_FACTURE[f.statut] || [f.statut, ''];
    return [f.numero || '—', jour(f.le), h('div', {}, f.client || '', h('br'), h('span', { class: 'muted' }, f.email || '')),
      f.lignes, euros(f.ht), euros(f.tva), euros(f.total), badge(texte, classe),
      f.lienPdf ? h('a', { href: f.lienPdf, target: '_blank', rel: 'noopener' }, 'PDF') : ''];
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
  return f ? f.numero : id || '';
}

function afficherCompta() {
  const lignes = recettes().sort((a, b) => a.le - b.le);
  const somme = (k) => lignes.reduce((s, m) => s + m[k], 0);
  const signe = (c) => h('span', { class: c < 0 ? 'neg' : null }, euros(c));
  remplirTable($('t-recettes'), [
    { titre: 'Date' }, { titre: 'Facture' }, { titre: 'Client' }, { titre: 'Nature' }, { titre: 'Règlement' },
    { titre: 'Montant', n: 1 }, { titre: 'Frais', n: 1 }, { titre: 'Net', n: 1 },
  ], lignes.map((m) => [jour(m.le), numeroFacture(m.facture), m.client || m.email || '', NATURES[m.nature] || m.nature,
    'Carte bancaire (Stripe)', signe(m.montant), euros(m.frais), signe(m.net)]),
  { total: lignes.length ? ['Total', '', '', '', '', signe(somme('montant')), euros(somme('frais')), signe(somme('net'))] : null });

  const deps = depensesPeriode();
  remplirTable($('t-achats'), [
    { titre: 'Date' }, { titre: 'Fournisseur' }, { titre: 'Libellé' }, { titre: 'Catégorie' }, { titre: 'TTC', n: 1 },
    { titre: 'dont TVA', n: 1 }, { titre: 'Justificatif' }, { titre: '' },
  ], deps.map((d) => [jour(d.date), d.fournisseur || '', d.libelle, donnees.categories[d.categorie] || d.categorie,
    euros(d.montant), euros(d.tva), d.justificatif ? h('a', { href: d.justificatif, target: '_blank', rel: 'noopener' }, 'Voir') : '',
    h('button', { type: 'button', class: 'link danger no-print', onclick: () => supprimerDepense(d) }, 'Supprimer')]),
  {
    total: deps.length ? ['Total', '', '', '', euros(deps.reduce((s, d) => s + d.montant, 0)),
      euros(deps.reduce((s, d) => s + (d.tva || 0), 0)), '', ''] : null,
    vide: 'Aucune dépense sur cette période.',
  });

  const virements = stripe.mouvements.filter((m) => m.nature === 'virement').sort((a, b) => a.le - b.le);
  remplirTable($('t-virements'), [{ titre: 'Date' }, { titre: 'Arrivée prévue' }, { titre: 'Montant', n: 1 }],
    virements.map((m) => [jour(m.le), jour(m.disponibleLe), euros(-m.montant)]),
    { vide: 'Aucun virement sur cette période.' });
}

async function supprimerDepense(d) {
  if (!confirm(`Supprimer la dépense « ${d.libelle} » (${euros(d.montant)}) ?`)) return;
  try {
    await appeler('gestionDepense', { action: 'supprimer', id: d.id });
    await chargerDonnees();
  } catch (e) {
    erreur(e);
  }
}

function exporterRecettes() {
  csv('livre-des-recettes', ['Date', 'Facture', 'Client', 'E-mail', 'Nature', 'Mode de règlement', 'Montant', 'Frais Stripe', 'Net', 'Référence Stripe'],
    recettes().sort((a, b) => a.le - b.le).map((m) => [jour(m.le), numeroFacture(m.facture), m.client, m.email,
      NATURES[m.nature] || m.nature, 'Carte bancaire (Stripe)', csvMontant(m.montant), csvMontant(m.frais), csvMontant(m.net), m.source || m.id]));
}

function exporterAchats() {
  csv('registre-des-achats', ['Date', 'Fournisseur', 'Libellé', 'Catégorie', 'Montant TTC', 'dont TVA', 'Justificatif'],
    depensesPeriode().map((d) => [jour(d.date), d.fournisseur, d.libelle, donnees.categories[d.categorie] || d.categorie,
      csvMontant(d.montant), csvMontant(d.tva), d.justificatif]));
}

function exporterMouvements() {
  csv('releve-stripe', ['Date', 'Disponible le', 'Type', 'Nature', 'Description', 'Client', 'Montant', 'Frais', 'Net', 'Référence'],
    stripe.mouvements.slice().sort((a, b) => a.le - b.le).map((m) => [jour(m.le), jour(m.disponibleLe), m.type,
      NATURES[m.nature] || m.nature, m.description, m.client || m.email, csvMontant(m.montant), csvMontant(m.frais),
      csvMontant(m.net), m.id]));
}

$('x-recettes').addEventListener('click', exporterRecettes);
$('x-achats').addEventListener('click', exporterAchats);
$('x-mouvements').addEventListener('click', exporterMouvements);
$('x-tout').addEventListener('click', async () => {
  // Petit délai entre les fichiers : certains navigateurs bloquent plusieurs téléchargements d'un coup.
  for (const f of [exporterRecettes, exporterAchats, exporterFactures, exporterMouvements]) {
    f();
    await new Promise((r) => setTimeout(r, 600));
  }
});

// ---------- Formulaires ----------

let formulairesPrets = false;
function preparerFormulaires() {
  if (formulairesPrets) return;
  formulairesPrets = true;
  const aujourdhui = new Date().toLocaleDateString('sv-SE');
  document.querySelectorAll('form input[type="date"]').forEach((i) => { i.value = aujourdhui; });
  $('filtre-stock').append(...Object.entries(donnees.etats).map(([k, v]) => h('option', { value: k }, v)));
  $('f-depense').elements.categorie.append(...Object.entries(donnees.categories)
    .filter(([k]) => k !== 'tablettes').concat([['tablettes', donnees.categories.tablettes]])
    .map(([k, v]) => h('option', { value: k }, v)));
}

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

$('f-stock').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const prix = enCentimes(f.prix.value);
  const tva = enCentimes(f.tva.value);
  if (!prix || Number.isNaN(tva)) return message(f, 'Montant illisible (ex. 89,90).');
  const numeros = f.numeros.value.split('\n').map((n) => n.trim()).filter(Boolean);
  const quantite = Number(f.quantite.value);
  if (numeros.length > quantite) return message(f, `${numeros.length} numéros pour ${quantite} tablette(s).`);
  f.querySelector('button').disabled = true;
  try {
    await appeler('gestionStock', {
      action: 'ajouter', quantite, modele: f.modele.value, fournisseur: f.fournisseur.value,
      prixAchat: prix, tva, acheteeLe: dateSaisie(f.date.value), numeros,
      justificatif: f.justificatif.value, depense: f.depense.checked,
    });
    message(f, `${quantite} tablette(s) ajoutée(s).`, true);
    f.numeros.value = '';
    await chargerDonnees();
  } catch (err) {
    message(f, err.message);
  } finally {
    f.querySelector('button').disabled = false;
  }
});

$('f-depense').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const montant = enCentimes(f.montant.value);
  const tva = enCentimes(f.tva.value);
  if (!montant || Number.isNaN(tva)) return message(f, 'Montant illisible (ex. 12,00).');
  f.querySelector('button').disabled = true;
  try {
    await appeler('gestionDepense', {
      action: 'ajouter', date: dateSaisie(f.date.value), categorie: f.categorie.value,
      fournisseur: f.fournisseur.value, libelle: f.libelle.value, montant, tva, justificatif: f.justificatif.value,
    });
    message(f, 'Dépense ajoutée.', true);
    f.libelle.value = '';
    f.montant.value = '';
    f.tva.value = '';
    f.justificatif.value = '';
    await chargerDonnees();
  } catch (err) {
    message(f, err.message);
  } finally {
    f.querySelector('button').disabled = false;
  }
});
