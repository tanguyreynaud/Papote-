// Espace « Validation » de l'admin (admin.html#validation) : tout voir et tout valider avant le 5 décembre.
//   Écrans    : les captures de la galerie (tablette, app famille, site, admin, e-mails), rangées par parcours,
//               chacune « Validé » ou « À revoir » avec un commentaire. Publiées par outils/galerie/publier-validation.bat
//               sur le site papote-validation (hébergement gratuit) ; un écran qui change après validation est signalé.
//   Parcours  : chaque flux expliqué étape par étape (validation-donnees.js), validé flux par flux.
//   Dépenses  : chaque poste, son coût par famille et les pistes pour le réduire.
//   Gestes    : les gestes humains (double clic, clavier, retour…) et comment ils sont vérifiés.
// Les choix sont dans un seul document validation/etat (admin seulement) : une lecture à l'ouverture, une écriture
// par choix.
import './retour.js';
import { annoncer } from './dialogue.js';
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';
import { FLUX, DEPENSES, GESTES, QUI, TESTS, PRIX_MOIS } from './validation-donnees.js';

const SITE = 'https://papote-validation.web.app';
const PARTIES = { tablette: 'Tablette', famille: 'App famille', vitrine: 'Site vitrine', admin: 'Admin', emails: 'E-mails' };
const ETATS = { ok: 'Validé', revoir: 'À revoir', change: 'A changé', avoir: 'À voir' };

const $ = (id) => document.getElementById(id);

// Élément HTML ; les textes passent par textContent (comme gestion.js).
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

// append / replaceChildren sans les « null » des éléments facultatifs (ils s'afficheraient en texte).
const net = (els) => els.flat(Infinity).filter((e) => e != null && e !== false);
const mettre = (el, ...els) => el.append(...net(els));
const remplacer = (el, ...els) => el.replaceChildren(...net(els));

const euros = (n) => n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const quand = (ms) => new Date(ms).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });

// Empreinte courte d'un parcours (son texte) : s'il change après validation, il repasse « a changé ».
function empreinte(objet) {
  const t = JSON.stringify(objet);
  let a = 5381;
  for (let i = 0; i < t.length; i++) a = ((a * 33) ^ t.charCodeAt(i)) >>> 0;
  return a.toString(36);
}

// ---------- Données : captures (site papote-validation) et choix (Firestore) ----------

let index = null; // { le, parties: [{ partie, source, le, ecrans }] }
let indexErreur = null;
let indexEnCours = null;
let etat = null; // { e: {}, f: {}, d: {}, g: {} }
let etatLu = 0;
let etatEnCours = null;
let etatErreur = null;
let uid = null;

function chargerIndex() {
  indexEnCours = indexEnCours || fetch(`${SITE}/index.json`, { cache: 'no-cache' })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((j) => { index = j; indexErreur = null; })
    .catch((e) => { indexErreur = e; console.warn('Captures de validation illisibles', e); })
    .finally(() => { indexEnCours = null; rendre(); });
  return indexEnCours;
}

let bddValidation = null;
// Même base que le reste de l'admin : celle d'origine, ou celle que config/base désigne (bascule en Europe).
async function bdd() {
  if (bddValidation) return bddValidation;
  const app = getApp('admin');
  let d = getFirestore(app);
  try {
    const c = (await getDoc(doc(d, 'config', 'base'))).data() || {};
    if (typeof c.database === 'string' && c.database && c.database !== '(default)') d = getFirestore(app, c.database);
  } catch (e) { console.warn('config/base illisible, base d\'origine gardée', e); }
  bddValidation = d;
  return d;
}

function chargerEtat() {
  if (!uid) return null;
  etatEnCours = etatEnCours || (async () => {
    const snap = await getDoc(doc(await bdd(), 'validation', 'etat'));
    const d = (snap.exists() && snap.data()) || {};
    etat = { e: d.e || {}, f: d.f || {}, d: d.d || {}, g: d.g || {} };
    etatLu = Date.now();
    etatErreur = null;
  })().catch((e) => { etatErreur = e; console.warn('Validation illisible', e); })
    .finally(() => { etatEnCours = null; rendre(); });
  return etatEnCours;
}

// Enregistre un choix (section e, f, d ou g) : le document est fusionné, seul ce choix change.
async function enregistrer(section, id, valeur) {
  const choix = { ...valeur, t: Date.now(), par: uid };
  await setDoc(doc(await bdd(), 'validation', 'etat'), { [section]: { [id]: choix } }, { merge: true });
  etat[section][id] = { ...(etat[section][id] || {}), ...choix };
}

// ---------- État d'un écran ----------

function etatEcran(e) {
  const c = etat && etat.e[e.id];
  if (!c || !c.s) return 'avoir';
  if (c.s === 'ok' && c.h && c.h !== e.h) return 'change';
  return c.s;
}

function compter(ecrans) {
  const n = { ok: 0, revoir: 0, change: 0, avoir: 0 };
  for (const e of ecrans) n[etatEcran(e)]++;
  return n;
}

const CLASSE_ETAT = { ok: 'ok', revoir: 'ko', change: 'ko', avoir: 'neutre' };
const badgeEtat = (s) => h('span', { class: `badge v-etat ${CLASSE_ETAT[s]}` }, ETATS[s]);

function barre(n, total) {
  const pct = (x) => `${total ? (100 * x) / total : 0}%`;
  return h('div', { class: 'v-barre', role: 'img', 'aria-label': `${n.ok} validés sur ${total}` },
    h('span', { class: 'v-ok', style: `width:${pct(n.ok)}` }),
    h('span', { class: 'v-revoir', style: `width:${pct(n.revoir + n.change)}` }));
}

// Parcours (groupes) d'une partie, dans l'ordre de la galerie.
function groupes(partie) {
  const g = [];
  for (const e of partie.ecrans) {
    let x = g[g.length - 1];
    if (!x || x.nom !== e.groupe) { x = { nom: e.groupe, ecrans: [] }; g.push(x); }
    x.ecrans.push(e);
  }
  return g;
}

const tousLesEcrans = () => (index ? index.parties.flatMap((p) => p.ecrans.map((e) => ({ ...e, partie: p.partie }))) : []);

// ---------- Boutons Validé / À revoir + commentaire (écrans, parcours, dépenses, gestes) ----------

// section : e, f, d, g ; id ; extra : champs gardés avec le choix (h = empreinte) ; libelles : [oui, non].
function blocChoix(section, id, extra = {}, libelles = ['Validé', 'À revoir'], { surChoix } = {}) {
  const actuel = () => (etat && etat[section][id]) || {};
  const msg = h('p', { class: 'v-msg', role: 'status' });
  const zone = h('textarea', { class: 'v-com', rows: 2, placeholder: 'Ce qui ne va pas, ce qu\'il faut changer…', 'aria-label': 'Commentaire' });
  zone.value = actuel().c || '';
  const garder = h('button', { type: 'button', class: 'secondary small-btn v-garder' }, 'Enregistrer le commentaire');
  const comBloc = h('div', { class: 'v-com-bloc', hidden: !(actuel().s === 'revoir' || actuel().c) }, zone, garder);
  const oui = h('button', { type: 'button', class: 'v-choix v-oui' }, libelles[0]);
  const non = h('button', { type: 'button', class: 'v-choix v-non' }, libelles[1]);

  // Choix fait sur cette version (même empreinte d'écran ou de parcours) : sinon, il est à refaire.
  const aJour = () => Object.entries(extra).every(([k, v]) => actuel()[k] === v);
  const peindre = () => {
    const s = aJour() ? actuel().s : '';
    oui.setAttribute('aria-pressed', String(s === 'ok'));
    non.setAttribute('aria-pressed', String(s === 'revoir'));
  };
  const erreur = (e) => {
    console.warn('Validation non enregistrée', e);
    msg.textContent = 'Pas enregistré (connexion ?). Réessaie.';
    msg.className = 'v-msg error';
  };
  const choisir = async (s) => {
    msg.textContent = '';
    // Même bouton une 2e fois : le choix est retiré (l'écran repasse « à voir »).
    // Un écran qui a changé depuis : « Validé » le valide de nouveau, il ne retire rien.
    const nouveau = actuel().s === s && aJour() ? '' : s;
    try {
      await enregistrer(section, id, { s: nouveau, c: zone.value.trim(), ...extra });
    } catch (e) { erreur(e); return; }
    peindre();
    if (nouveau === 'revoir') { comBloc.hidden = false; zone.focus(); }
    annoncer(nouveau === 'ok' ? libelles[0] : nouveau === 'revoir' ? libelles[1] : 'Choix retiré');
    if (surChoix) surChoix(nouveau);
  };
  oui.addEventListener('click', () => choisir('ok'));
  non.addEventListener('click', () => choisir('revoir'));
  garder.addEventListener('click', async () => {
    msg.textContent = '';
    try {
      await enregistrer(section, id, { s: actuel().s || 'revoir', c: zone.value.trim(), ...extra });
    } catch (e) { erreur(e); return; }
    peindre();
    msg.textContent = 'Commentaire enregistré.';
    msg.className = 'v-msg ok';
    annoncer('Commentaire enregistré');
    if (surChoix) surChoix(actuel().s);
  });
  const ajouter = h('button', { type: 'button', class: 'link small v-ajouter', hidden: !comBloc.hidden }, 'Ajouter un commentaire');
  ajouter.addEventListener('click', () => { comBloc.hidden = false; ajouter.hidden = true; zone.focus(); });
  peindre();
  return h('div', { class: 'v-bloc-choix' }, h('div', { class: 'v-choix-ligne' }, oui, non), ajouter, comBloc, msg);
}

// ---------- Onglet Écrans ----------

function carteEcran(e, liste) {
  const s = etatEcran(e);
  const tete = h('header', { class: 'v-ecran-tete' }, h('span', { class: 'v-num' }, e.num), h('h3', {}, e.titre), badgeEtat(s));
  const c = etat.e[e.id];
  const captures = h('div', { class: 'v-captures' }, e.captures.map((x) => h('button', {
    type: 'button', class: `v-capture v-${x.taille || 'ecran'}`, 'aria-label': `Agrandir ${e.num} ${x.taille || ''}`,
    onclick: () => zoom(liste, liste.indexOf(e)),
  }, h('img', { src: `${SITE}/${x.f}`, alt: '', loading: 'lazy', decoding: 'async' }), x.taille ? h('small', {}, x.taille) : null)));
  const carte = h('article', { class: 'card v-ecran', id: `v-${e.id}` },
    tete,
    e.note ? h('p', { class: 'muted small' }, e.note) : null,
    e.erreurs && e.erreurs.length ? h('p', { class: 'error small' }, `Signalé par la galerie : ${e.erreurs.join(' · ')}`) : null,
    s === 'change' ? h('p', { class: 'v-alerte small' }, `Validé le ${quand(c.t)}, mais l'écran a changé depuis : à regarder de nouveau.`) : null,
    captures,
    blocChoix('e', e.id, { h: e.h }, undefined, { surChoix: () => tete.replaceChild(badgeEtat(etatEcran(e)), tete.lastChild) }));
  return carte;
}

function vueEcrans(boite, [partieNom, groupe]) {
  if (indexErreur && !index) {
    mettre(boite, h('div', { class: 'card' },
      h('h2', {}, 'Les captures ne sont pas encore en ligne'),
      h('p', {}, 'Elles sont faites par la galerie sur ton PC, puis publiées sur un petit site gratuit (papote-validation). Une seule commande, environ 10 minutes :'),
      h('pre', { class: 'v-commande' }, 'cd C:\\Users\\tangu\\papote-deploiement\ngit fetch origin\ngit checkout --detach origin/main\ncd outils\\galerie\n.\\publier-validation.bat'),
      h('p', { class: 'muted small' }, 'Les choix déjà faits sont gardés : ils suivent chaque écran, même si son numéro change.'),
      h('button', { type: 'button', class: 'secondary small-btn', onclick: () => chargerIndex() }, 'Réessayer')));
    return;
  }
  if (!index) { mettre(boite, attente('Chargement des captures…')); return; }
  const tous = tousLesEcrans();

  // Liste d'un état (#validation/ecrans/etat/revoir) : tous les écrans à revoir, changés, à voir ou validés.
  if (partieNom === 'etat' && ETATS[groupe]) {
    const liste = tous.filter((e) => etatEcran(e) === groupe);
    mettre(boite, h('a', { class: 'retour', href: '#validation/ecrans' }, 'Retour'),
      h('h2', { class: 'v-titre' }, `${ETATS[groupe]} : ${liste.length} écran${liste.length > 1 ? 's' : ''}`),
      liste.length ? h('div', { class: 'v-grille' }, liste.map((e) => carteEcran(e, liste))) : h('p', { class: 'muted' }, 'Aucun écran.'));
    return;
  }

  const partie = index.parties.find((p) => p.partie === partieNom);
  if (!partie) {
    const n = compter(tous);
    mettre(boite, 
      h('div', { class: 'stats compact' }, ['ok', 'revoir', 'change', 'avoir'].map((s) => tuile(n[s], ETATS[s], `#validation/ecrans/etat/${s}`))),
      h('p', { class: 'muted small' }, `Captures faites le ${quand(index.le)} par la galerie, avec de fausses données. Chaque écran garde ton choix même si son numéro change.`),
      h('div', { class: 'v-liste' }, index.parties.map((p) => {
        const c = compter(p.ecrans);
        return h('a', { class: 'card v-ligne', href: `#validation/ecrans/${p.partie}` },
          h('div', { class: 'v-ligne-texte' }, h('strong', {}, PARTIES[p.partie] || p.partie),
            h('span', { class: 'muted small' }, `${p.ecrans.length} écrans · ${c.ok} validés · ${c.revoir + c.change} à revoir · ${c.avoir} à voir`)),
          barre(c, p.ecrans.length));
      })));
    return;
  }

  const gs = groupes(partie);
  const g = gs[Number(groupe)];
  if (!g) {
    mettre(boite, h('a', { class: 'retour', href: '#validation/ecrans' }, 'Retour'),
      h('h2', { class: 'v-titre' }, PARTIES[partie.partie] || partie.partie),
      h('p', { class: 'muted small' }, `Source : ${partie.source} · ${quand(partie.le)}`),
      h('div', { class: 'v-liste' }, gs.map((x, i) => {
        const c = compter(x.ecrans);
        return h('a', { class: 'card v-ligne', href: `#validation/ecrans/${partie.partie}/${i}` },
          h('div', { class: 'v-ligne-texte' }, h('strong', {}, x.nom || 'Écrans'),
            h('span', { class: 'muted small' }, `${x.ecrans[0].num} à ${x.ecrans[x.ecrans.length - 1].num} · ${c.ok}/${x.ecrans.length} validés${c.revoir + c.change ? ` · ${c.revoir + c.change} à revoir` : ''}`)),
          barre(c, x.ecrans.length));
      })));
    return;
  }
  const liste = g.ecrans.map((e) => ({ ...e, partie: partie.partie }));
  const suivant = gs[Number(groupe) + 1];
  mettre(boite, h('a', { class: 'retour', href: `#validation/ecrans/${partie.partie}` }, 'Retour'),
    h('div', { class: 'tete' }, h('h2', { class: 'v-titre' }, `${PARTIES[partie.partie]} · ${g.nom || 'Écrans'}`),
      h('button', { type: 'button', class: 'primary small-btn', onclick: () => zoom(liste, Math.max(0, liste.findIndex((e) => etatEcran(e) !== 'ok'))) }, 'Passer en revue en grand')),
    h('div', { class: 'v-grille' }, liste.map((e) => carteEcran(e, liste))),
    suivant ? h('a', { class: 'secondary v-suivant', href: `#validation/ecrans/${partie.partie}/${Number(groupe) + 1}` }, `Parcours suivant : ${suivant.nom}`) : null);
}

function tuile(valeur, texte, lien) {
  return h('a', { class: 'stat onglet v-tuile', href: lien }, h('span', {}, String(valeur)), h('p', {}, texte));
}

const attente = (texte) => h('div', { class: 'attente', role: 'status' }, h('span', { class: 'roue' }), h('p', {}, texte));

// ---------- Grand écran : une capture après l'autre, Validé / À revoir, flèches du clavier ----------

let zoomFermer = null;
function zoom(liste, i) {
  if (zoomFermer) zoomFermer();
  if (!liste.length) return;
  let pos = Math.min(Math.max(i, 0), liste.length - 1);
  const fond = h('div', { class: 'v-zoom', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Écran en grand' });
  const corps = h('div', { class: 'v-zoom-corps' });
  const prec = h('button', { type: 'button', class: 'secondary small-btn', onclick: () => aller(pos - 1) }, '← Précédent');
  const suiv = h('button', { type: 'button', class: 'secondary small-btn', onclick: () => aller(pos + 1) }, 'Suivant →');
  const fermer = h('button', { type: 'button', class: 'secondary small-btn', onclick: () => zoomFermer() }, 'Fermer');
  const compteur = h('span', { class: 'muted small' });
  fond.append(h('div', { class: 'v-zoom-barre' }, prec, compteur, suiv, fermer), corps);
  function aller(n) {
    if (n < 0 || n >= liste.length) return;
    pos = n;
    const e = liste[pos];
    prec.disabled = pos === 0;
    suiv.disabled = pos === liste.length - 1;
    compteur.textContent = `${pos + 1} / ${liste.length}`;
    remplacer(corps, 
      h('header', { class: 'v-ecran-tete' }, h('span', { class: 'v-num' }, e.num), h('h3', {}, e.titre), badgeEtat(etatEcran(e))),
      e.note ? h('p', { class: 'muted small' }, e.note) : null,
      h('div', { class: 'v-zoom-images' }, e.captures.map((x) => h('figure', {}, h('img', { src: `${SITE}/${x.f}`, alt: `${e.num} ${x.taille || ''}` }), x.taille ? h('figcaption', {}, x.taille) : null))),
      blocChoix('e', e.id, { h: e.h }, undefined, {
        // Validé : l'écran suivant vient tout seul ; À revoir : on reste pour écrire le commentaire.
        surChoix: (s) => { if (s === 'ok' && pos < liste.length - 1) setTimeout(() => aller(pos + 1), 250); else aller(pos); },
      }));
    corps.scrollTop = 0;
  }
  const touches = (ev) => {
    if (ev.target.closest('textarea, input')) return;
    if (ev.key === 'Escape') zoomFermer();
    else if (ev.key === 'ArrowRight') aller(pos + 1);
    else if (ev.key === 'ArrowLeft') aller(pos - 1);
  };
  zoomFermer = () => {
    document.removeEventListener('keydown', touches);
    fond.remove();
    document.body.classList.remove('v-zoom-ouvert');
    zoomFermer = null;
    rendre();
  };
  document.addEventListener('keydown', touches);
  document.body.classList.add('v-zoom-ouvert');
  document.body.append(fond);
  aller(pos);
  fermer.focus();
}

// ---------- Onglet Parcours ----------

function etatFlux(f) {
  const c = etat && etat.f[f.id];
  if (!c || !c.s) return 'avoir';
  if (c.s === 'ok' && c.v !== empreinte(f)) return 'change';
  return c.s;
}

function chipEmail(fonction) {
  const ecrans = tousLesEcrans().filter((e) => e.partie === 'emails' && e.fonction === fonction);
  if (!ecrans.length) return h('span', { class: 'badge neutre' }, `E-mail ${fonction}`);
  return h('button', { type: 'button', class: 'badge info v-mail', onclick: () => zoom(ecrans, 0) },
    `✉ ${ecrans[0].titre}${ecrans.length > 1 ? ` (+${ecrans.length - 1})` : ''}`);
}

const TEST_CLASSE = { auto: 'ok', main: 'info', non: 'ko' };

function vueParcours(boite, [id]) {
  const f = FLUX.find((x) => x.id === id);
  if (!f) {
    const n = { ok: 0, revoir: 0, change: 0, avoir: 0 };
    for (const x of FLUX) n[etatFlux(x)]++;
    mettre(boite, 
      h('p', { class: 'muted' }, 'Chaque parcours, de la commande au retour de la tablette : qui fait quoi, quel e-mail part, ce que ça coûte et si c\'est essayé. Valide-les un par un.'),
      h('p', { class: 'small' }, `${n.ok} validés · ${n.revoir + n.change} à revoir · ${n.avoir} à lire, sur ${FLUX.length}`),
      h('div', { class: 'v-liste' }, FLUX.map((x) => {
        const non = x.etapes.filter((e) => e.test && e.test[0] !== 'auto').length;
        return h('a', { class: 'card v-ligne', href: `#validation/parcours/${x.id}` },
          h('div', { class: 'v-ligne-texte' }, h('strong', {}, x.titre), h('span', { class: 'muted small' }, x.resume),
            h('span', { class: 'small' }, `${x.etapes.length} étapes${non ? ` · ${non} pas couvertes par un essai automatique` : ' · toutes essayées automatiquement'}`)),
          badgeEtat(etatFlux(x)));
      })));
    return;
  }
  if (!index && !indexErreur && !indexEnCours) chargerIndex();
  const s = etatFlux(f);
  mettre(boite, h('a', { class: 'retour', href: '#validation/parcours' }, 'Retour'),
    h('div', { class: 'tete' }, h('h2', { class: 'v-titre' }, f.titre), badgeEtat(s)),
    h('p', { class: 'muted' }, f.resume),
    s === 'change' ? h('p', { class: 'v-alerte small' }, 'Ce parcours a été modifié depuis ta validation : relis-le.') : null,
    h('ol', { class: 'v-etapes' }, f.etapes.map((e) => h('li', { class: 'card v-etape' },
      h('div', { class: 'v-etape-tete' }, h('span', { class: `badge v-qui v-qui-${e.qui}` }, QUI[e.qui] || e.qui), h('strong', {}, e.titre)),
      h('p', {}, e.detail),
      e.emails && e.emails.length ? h('div', { class: 'v-mails' }, e.emails.map(chipEmail)) : null,
      h('dl', { class: 'v-infos' },
        h('dt', {}, 'Coût'), h('dd', {}, e.cout || '—'),
        e.test ? [h('dt', {}, 'Essayé ?'), h('dd', {}, h('span', { class: `badge ${TEST_CLASSE[e.test[0]]}` }, TESTS[e.test[0]]), ' ', e.test[1])] : null)))),
    h('div', { class: 'card' }, h('h3', {}, 'Ton avis sur ce parcours'),
      blocChoix('f', f.id, { v: empreinte(f) }, ['Je suis d\'accord', 'À revoir'], { surChoix: () => rendre() })));
}

// ---------- Onglet Dépenses ----------

let familles = 10;
let dureeMois = 24;

function vueDepenses(boite) {
  const parMois = DEPENSES.reduce((t, d) => t + (d.parMois || 0), 0);
  const unique = DEPENSES.reduce((t, d) => t + (d.unique || 0), 0);
  const fixe = DEPENSES.reduce((t, d) => t + (d.fixe || 0), 0);
  const resultat = h('div', { class: 'stats compact' });
  const calculer = () => {
    const parFamille = parMois + unique / dureeMois + fixe / Math.max(familles, 1);
    remplacer(resultat, 
      h('div', { class: 'stat' }, h('span', {}, euros(parFamille)), h('p', {}, 'coûte une famille par mois'), h('small', {}, `dont ${euros(unique / dureeMois)} d'arrivée et ${euros(fixe / Math.max(familles, 1))} de frais fixes`)),
      h('div', { class: 'stat' }, h('span', { class: PRIX_MOIS - parFamille > 0 ? '' : 'neg' }, euros(PRIX_MOIS - parFamille)), h('p', {}, `reste sur ${PRIX_MOIS} € par famille et par mois`), h('small', {}, 'avant impôts, casse et impayés')),
      h('div', { class: 'stat' }, h('span', {}, euros(parMois * familles + fixe)), h('p', {}, `de dépenses par mois à ${familles} familles`), h('small', {}, `plus ${euros(unique)} à chaque nouveau client`)));
  };
  const champ = (libelle, valeur, min, max, changer) => {
    const input = h('input', { type: 'number', inputMode: 'numeric', min, max, value: valeur });
    input.addEventListener('input', () => {
      const n = Math.round(Number(input.value));
      if (Number.isFinite(n) && n >= min && n <= max) { changer(n); calculer(); }
    });
    return h('label', { class: 'v-champ' }, libelle, input);
  };
  calculer();
  mettre(boite, 
    h('p', { class: 'muted' }, 'Chaque dépense de Papote, ce qu\'elle coûte par famille, d\'où vient le chiffre et comment la réduire. Les chiffres marqués « estimé » ou « à vérifier » restent à confirmer sur une vraie facture.'),
    h('div', { class: 'v-champs' },
      champ('Familles', familles, 1, 5000, (n) => { familles = n; }),
      champ('Durée moyenne d\'un client (mois)', dureeMois, 1, 120, (n) => { dureeMois = n; })),
    resultat,
    h('p', { class: 'muted small' }, 'Ton calcul du 29/10 donnait environ 19,50 € de marge : ici, la tablette est amortie à 4 € par mois en plus.'),
    h('div', { class: 'v-liste' }, DEPENSES.map((d) => h('article', { class: 'card v-depense' },
      h('div', { class: 'tete' }, h('h3', {}, d.poste), h('strong', { class: 'v-montant' }, montant(d))),
      h('p', { class: 'muted small' }, `${d.quand} · ${d.sur}`),
      h('p', {}, d.detail),
      h('ul', { class: 'v-pistes' }, d.optimisation.map((o) => h('li', {}, o))),
      blocChoix('d', d.id, { v: empreinte(d) }, ['D\'accord', 'À revoir'])))));
}

function montant(d) {
  const p = [];
  if (d.parMois) p.push(`${euros(d.parMois)} / mois`);
  if (d.unique) p.push(`${euros(d.unique)} par client`);
  if (d.fixe) p.push(`${euros(d.fixe)} / mois en tout`);
  return p.join(' · ') || 'Gratuit';
}

// ---------- Onglet Gestes ----------

function vueGestes(boite) {
  const n = { auto: 0, main: 0, non: 0 };
  for (const g of GESTES) n[g.etat]++;
  const parties = [...new Set(GESTES.map((g) => g.partie))];
  mettre(boite, 
    h('p', { class: 'muted' }, 'Tout ce qu\'une vraie personne peut faire de travers, et comment c\'est vérifié. Ce qui est « à la main » ou « pas encore essayé » est à faire avant le 5 décembre ; dis « OK chez moi » quand tu l\'as essayé.'),
    h('p', { class: 'small' }, `${n.auto} essayés automatiquement · ${n.main} à essayer à la main · ${n.non} pas encore essayés`),
    parties.map((p) => [h('h3', { class: 'v-sous-titre' }, p), h('div', { class: 'v-liste' }, GESTES.filter((g) => g.partie === p).map((g) => h('article', { class: 'card v-geste' },
      h('div', { class: 'tete' }, h('strong', {}, g.geste), h('span', { class: `badge ${TEST_CLASSE[g.etat]}` }, TESTS[g.etat])),
      h('p', { class: 'muted small' }, g.comment),
      blocChoix('g', g.id, {}, ['OK chez moi', 'Problème']))))]));
}

// ---------- Affichage ----------

const VUES = { ecrans: vueEcrans, parcours: vueParcours, depenses: vueDepenses, gestes: vueGestes };

function rendre() {
  const [page, onglet, ...reste] = location.hash.slice(1).split('/');
  if (page !== 'validation') return;
  const nom = VUES[onglet] ? onglet : (document.querySelector('[data-panneau="validation"] .onglets .actif')?.dataset.onglet || 'ecrans');
  const boite = $(`v-${nom}`);
  if (!boite) return;
  boite.replaceChildren();
  if (!uid) { mettre(boite, attente('Connexion…')); return; }
  if (!etat) {
    if (etatErreur) {
      mettre(boite, h('div', { class: 'card' }, h('p', { class: 'error' }, 'Impossible de lire tes validations (connexion ou droits).'),
        h('button', { type: 'button', class: 'secondary small-btn', onclick: () => chargerEtat() }, 'Réessayer')));
    } else { mettre(boite, attente('Chargement de tes validations…')); chargerEtat(); }
    return;
  }
  if (nom === 'ecrans' && !index && !indexErreur && !indexEnCours) chargerIndex();
  VUES[nom](boite, reste.map(decodeURIComponent));
}

// Les choix sont relus en entrant dans Validation s'ils datent de plus d'une minute (un autre appareil a pu valider).
let pageAvant = '';
window.addEventListener('hashchange', () => {
  const page = location.hash.slice(1).split('/')[0];
  if (page === 'validation' && pageAvant !== 'validation' && etat && Date.now() - etatLu > 60_000) { etat = null; }
  pageAvant = page;
  if (zoomFermer && page !== 'validation') zoomFermer();
  rendre();
});
// Les onglets de la page changent l'adresse avec replaceState (gestion.js) : pas d'événement, on redessine au clic.
document.querySelectorAll('[data-panneau="validation"] .onglets [data-onglet]').forEach((b) => {
  b.addEventListener('click', () => setTimeout(rendre, 0));
});

onAuthStateChanged(getAuth(getApp('admin')), (u) => {
  uid = u ? u.uid : null;
  if (!u) { etat = null; }
  pageAvant = location.hash.slice(1).split('/')[0];
  rendre();
});
