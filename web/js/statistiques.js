// Page « Statistiques » de l'admin (Tanguy, 17/11/2026 : « combien de personnes cliquent sur mon site vs le nombre
// de commandes, et où est-ce qu'elles s'arrêtent »). Compteurs du site sans cookie ni donnée personnelle
// (functions/statistiques.js), lus par la fonction gestionStatistiques. Rien ne s'écrit d'ici.
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { appeler, messageErreur } from './gestion-api.js';

const $ = (id) => document.getElementById(id);
function h(tag, attrs = {}, ...enfants) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const e of enfants.flat()) if (e != null && e !== false) el.append(e instanceof Node ? e : document.createTextNode(String(e)));
  return el;
}

// Le tunnel, dans l'ordre du site. « 4G trop faible », « rupture vue » et « Être prévenu » sont à part.
const TUNNEL = [
  ['visite', 'Visiteurs du site'],
  ['commande', 'Ouvrent la page de commande'],
  ['adresse', 'Choisissent la ville ou l\'adresse du proche'],
  ['couverture-ok', 'La 4G passe chez le proche'],
  ['relais', 'Choisissent un point relais'],
  ['coordonnees', 'Remplissent leur nom et leur e-mail'],
  ['paiement', 'Touchent « Payer »'],
  ['paye', 'Paient'],
];
// Nom court de chaque étape, pour la phrase « c'est ici qu'on perd le plus de monde ».
const COURT = { visite: 'l\'arrivée sur le site', commande: 'la page de commande', adresse: 'l\'adresse du proche', 'couverture-ok': 'la 4G',
  relais: 'le point relais', coordonnees: 'le nom et l\'e-mail', paiement: 'le bouton Payer', paye: 'le paiement' };
const SOURCES = {
  google: 'Google', bing: 'Bing', qwant: 'Qwant', duckduckgo: 'DuckDuckGo', ecosia: 'Ecosia', yahoo: 'Yahoo',
  facebook: 'Facebook', instagram: 'Instagram', whatsapp: 'WhatsApp', linkedin: 'LinkedIn', youtube: 'YouTube',
  tiktok: 'TikTok', pinterest: 'Pinterest', x: 'X (Twitter)', leboncoin: 'Leboncoin', email: 'Un e-mail',
  direct: 'Adresse tapée, favori ou lien sans origine', autre: 'Un autre site',
};
const PERIODES = [7, 30, 90];

const nombre = (n) => n.toLocaleString('fr-FR');
const pourcent = (a, b) => (b ? `${Math.round((100 * a) / b)} %` : '–');
const jourCourt = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });

let periode = 30;
try { periode = Number(localStorage.getItem('papote-stats-jours')) || 30; } catch (e) { /* navigation privée */ }
if (!PERIODES.includes(periode)) periode = 30;
const lus = new Map();
let enCours = null;
let connecte = false;

function barre(valeur, max, classe) {
  const largeur = max ? Math.max(valeur ? 1.5 : 0, (100 * valeur) / max) : 0;
  return h('span', { class: `stat-barre ${classe || ''}`, 'aria-hidden': 'true' }, h('span', { style: `width:${largeur.toFixed(1)}%` }));
}

function rendre() {
  const panneau = document.querySelector('[data-panneau="statistiques"]');
  if (!panneau || panneau.hidden) return;
  document.querySelectorAll('#stats-periode button').forEach((b) => {
    b.classList.toggle('actif', Number(b.dataset.jours) === periode);
    b.setAttribute('aria-pressed', String(Number(b.dataset.jours) === periode));
  });
  const r = lus.get(periode);
  if (!r) {
    $('stats-chiffres').replaceChildren();
    $('stats-tunnel').replaceChildren(h('p', { class: 'muted' }, 'Lecture des chiffres…'));
    for (const id of ['stats-sources', 'stats-jours']) $(id).replaceChildren();
    $('stats-perte').hidden = true;
    return;
  }
  const t = r.total;
  $('stats-chiffres').replaceChildren(
    h('div', { class: 'stat' }, h('span', {}, nombre(t.visite)), h('p', {}, 'Visiteurs')),
    h('div', { class: 'stat' }, h('span', {}, nombre(t.paye)), h('p', {}, 'Commandes payées')),
    h('div', { class: 'stat' }, h('span', {}, pourcent(t.paye, t.visite)), h('p', {}, 'Visiteurs qui commandent')),
    h('div', { class: 'stat' }, h('span', {}, nombre(t.prevenir)), h('p', {}, 'Inscrits « Être prévenu »')),
  );

  // Tunnel : chaque étape par rapport aux visiteurs, et combien de personnes partent entre deux étapes.
  let pire = null;
  const lignes = TUNNEL.map(([cle, texte], i) => {
    const n = t[cle] || 0;
    const avant = i ? t[TUNNEL[i - 1][0]] || 0 : 0;
    const perdus = i ? Math.max(0, avant - n) : 0;
    if (i && avant >= 5 && (!pire || perdus / avant > pire.part)) pire = { part: perdus / avant, perdus, avant, de: COURT[TUNNEL[i - 1][0]], a: COURT[cle] };
    return h('li', { class: 'stat-etape' },
      h('div', { class: 'stat-ligne' }, h('span', { class: 'stat-texte' }, texte), h('strong', {}, nombre(n)), h('span', { class: 'muted small stat-part' }, i ? pourcent(n, t.visite) : '')),
      barre(n, t.visite),
      i && perdus ? h('p', { class: 'muted small stat-perdus' }, `${nombre(perdus)} s'arrêtent avant (${pourcent(perdus, avant)})`) : null);
  });
  const aPart = [
    t['couverture-non'] ? `4G trop faible chez le proche : ${nombre(t['couverture-non'])} fois` : null,
    t.complet ? `page « plus de tablette » vue par ${nombre(t.complet)} visiteur${t.complet > 1 ? 's' : ''}` : null,
  ].filter(Boolean);
  $('stats-tunnel').replaceChildren(h('ol', { class: 'stat-tunnel' }, lignes),
    aPart.length ? h('p', { class: 'muted small' }, `À part : ${aPart.join(' · ')}.`) : null);
  $('stats-perte').hidden = !pire || !pire.perdus;
  if (pire && pire.perdus) {
    $('stats-perte').textContent = `C'est entre ${pire.de} et ${pire.a} que le plus de monde s'arrête : ${pourcent(pire.perdus, pire.avant)} partent.`;
  }

  // Provenance des visiteurs.
  const sources = Object.entries(r.sources || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const totalSources = sources.reduce((s, [, n]) => s + n, 0);
  $('stats-sources').replaceChildren(sources.length
    ? h('ul', { class: 'stat-sources' }, sources.map(([s, n]) => h('li', {},
      h('div', { class: 'stat-ligne' }, h('span', { class: 'stat-texte' }, SOURCES[s] || s), h('strong', {}, nombre(n)), h('span', { class: 'muted small stat-part' }, pourcent(n, totalSources))),
      barre(n, sources[0][1], 'clair'))))
    : h('p', { class: 'muted' }, 'Pas encore de visite avec sa provenance (comptée depuis le 17/11/2026).'));

  // Jour par jour, le plus récent en haut.
  const jours = [...r.jours].reverse();
  $('stats-jours').replaceChildren(jours.length
    ? h('div', { class: 'table stat-jours' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Jour'), h('th', { class: 'n' }, 'Visiteurs'), h('th', { class: 'n' }, 'Commande'), h('th', { class: 'n' }, 'Payer'), h('th', { class: 'n' }, 'Payées'))),
      h('tbody', {}, jours.map((j) => h('tr', {}, h('td', {}, jourCourt(j.jour)), h('td', { class: 'n' }, nombre(j.visite)), h('td', { class: 'n' }, nombre(j.commande)),
        h('td', { class: 'n' }, nombre(j.paiement)), h('td', { class: 'n' }, nombre(j.paye)))))))
    : h('p', { class: 'muted' }, 'Aucune visite sur cette période.'));
}

function charger(forcer = false) {
  if (!connecte || location.hash.slice(1).split('/')[0] !== 'statistiques') return;
  const lu = lus.get(periode);
  if (!forcer && lu && Date.now() - lu.lu < 5 * 60_000) { rendre(); return; }
  if (enCours === periode) return; // double clic : un seul appel
  const demande = periode;
  enCours = demande;
  $('stats-erreur').hidden = true;
  rendre();
  appeler('gestionStatistiques', { jours: demande })
    .then((r) => { lus.set(demande, { ...r, lu: Date.now() }); })
    .catch((e) => { $('stats-erreur').textContent = messageErreur(e); $('stats-erreur').hidden = false; })
    .finally(() => { if (enCours === demande) enCours = null; rendre(); });
}

document.querySelectorAll('#stats-periode button').forEach((b) => b.addEventListener('click', () => {
  periode = Number(b.dataset.jours);
  try { localStorage.setItem('papote-stats-jours', String(periode)); } catch (e) { /* navigation privée */ }
  charger();
}));
window.addEventListener('hashchange', () => charger());
onAuthStateChanged(getAuth(getApp('admin')), (u) => { connecte = !!u; if (!u) lus.clear(); charger(); });
