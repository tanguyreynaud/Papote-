// Admin, Clients > Déclarations : les demandes faites depuis la bulle d'aide de l'appli (casse, écran, chargeur,
// vol ou perte, colis, panne, données), avec les photos, l'état de la tablette au moment de la demande, les réponses
// et la conversation du chat. Lues par gestionDeclarations (functions/declaration.js) : les photos ne sont ouvertes
// qu'au serveur et au badge admin, jamais par une règle Storage.
// « Marquer traitée » range la demande (on peut la remettre à traiter). Aucune action sur l'argent ici : la décision
// (remplacement, envoi d'un chargeur, retour…) se prend depuis la commande ou la fiche de la famille.
import { getApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { appeler, messageErreur } from './gestion-api.js';
import { boutonCharge, annoncer } from './dialogue.js';

const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...enfants) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const e of enfants.flat()) {
    if (e == null || e === false) continue;
    el.append(e instanceof Node ? e : document.createTextNode(String(e)));
  }
  return el;
}

function ilYA(ms) {
  if (!ms) return 'jamais';
  const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (min < 60) return `il y a ${min} min`;
  if (min < 48 * 60) return `il y a ${Math.round(min / 60)} h`;
  return `il y a ${Math.round(min / 1440)} j`;
}
const quand = (ms) => (ms ? new Date(ms).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

// État de la tablette noté au moment de la demande (pas en direct : la fiche de la famille l'a en direct).
export function resumeTablette(t, envoyeLe) {
  if (!t) return 'Aucune tablette dans la famille.';
  const depuis = (ms) => (ms && envoyeLe ? ilYA(ms - (Date.now() - envoyeLe)) : ilYA(ms));
  return [
    t.ref,
    t.horsLigne ? `hors ligne (dernier signe ${depuis(t.enLigneLe)} avant la demande)` : 'en ligne',
    t.batterie != null ? `batterie ${t.batterie} %${t.enCharge ? ' sur le chargeur' : ', débranchée'}` : null,
    t.reseau,
    t.dataMoisMo != null ? `${t.dataMoisMo} Mo ce mois` : null,
    t.version ? `version ${t.version}` : null,
  ].filter(Boolean).join(' · ');
}

let liste = null; // dernière lecture
let chargement = null;
const photosLues = new Map(); // chemin → adresse locale de la photo (gardée tant que la page est ouverte)

function zone() { return $('declarations'); }

function majCompteur() {
  const n = (liste || []).filter((d) => d.statut !== 'traitee').length;
  const pastille = $('declarations-n');
  if (!pastille) return;
  pastille.textContent = String(n);
  pastille.hidden = !n;
}

async function charger() {
  if (chargement) return chargement;
  chargement = appeler('gestionDeclarations', { action: 'lister' })
    .then((r) => { liste = r.declarations || []; majCompteur(); dessiner(); })
    .catch((e) => {
      const z = zone();
      if (z && !liste) z.replaceChildren(h('p', { class: 'erreur' }, messageErreur(e)));
    })
    .finally(() => { chargement = null; });
  return chargement;
}

function vignette(chemin, i) {
  const bouton = h('button', { type: 'button', class: 'decl-photo', 'aria-label': `Ouvrir la photo ${i + 1}` }, h('span', { class: 'muted small' }, 'Photo…'));
  const montrer = (url) => {
    bouton.replaceChildren(h('img', { src: url, alt: `Photo ${i + 1}` }));
    bouton.onclick = () => window.open(url, '_blank', 'noopener');
  };
  if (photosLues.has(chemin)) montrer(photosLues.get(chemin));
  else {
    appeler('gestionDeclarations', { action: 'photo', chemin }).then(({ contenu, type }) => {
      const octets = Uint8Array.from(atob(contenu), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([octets], { type }));
      photosLues.set(chemin, url);
      montrer(url);
    }).catch(() => { bouton.replaceChildren(h('span', { class: 'muted small' }, 'Photo illisible')); });
  }
  return bouton;
}

function carte(d) {
  const a = d.auteur || {};
  const traitee = d.statut === 'traitee';
  const bouton = h('button', { type: 'button', class: traitee ? 'secondary' : '' }, traitee ? 'Remettre à traiter' : 'Marquer traitée');
  bouton.addEventListener('click', async () => {
    if (bouton.getAttribute('aria-busy') != null) return; // double clic : un seul appel
    boutonCharge(bouton, true);
    try {
      await appeler('gestionDeclarations', { action: 'traiter', id: d.id, traitee: !traitee });
      d.statut = traitee ? 'nouvelle' : 'traitee';
      d.traiteeLe = traitee ? null : Date.now();
      annoncer(traitee ? 'Remise à traiter' : 'Marquée traitée');
      majCompteur();
      dessiner();
    } catch (e) {
      boutonCharge(bouton, false);
      annoncer(messageErreur(e));
    }
  });
  return h('article', { class: `card decl${traitee ? ' decl-traitee' : ''}`, 'data-id': d.id },
    h('div', { class: 'tete' },
      h('h3', {}, d.libelle || d.motif),
      h('span', { class: `badge ${traitee ? 'ok' : 'ko'}` }, traitee ? `traitée ${quand(d.traiteeLe)}` : 'à traiter')),
    h('p', { class: 'small' },
      h('a', { href: `#clients/familles/${encodeURIComponent(d.fid)}` }, d.famille || 'Famille'),
      ` · ${quand(d.creeLe)} · ${[a.nom, a.role].filter(Boolean).join(', ') || 'membre'}`),
    h('p', { class: 'small' },
      a.email ? h('a', { href: `mailto:${a.email}` }, a.email) : null,
      a.email && a.telephone ? ' · ' : null,
      a.telephone ? h('a', { href: `tel:${a.telephone}` }, a.telephone) : null),
    h('p', { class: 'small' }, h('b', {}, 'Tablette : '), resumeTablette(d.tablette, d.creeLe),
      d.abonnement ? [' · ', h('b', {}, 'abonnement : '), d.abonnement] : null),
    (d.reponses || []).length ? h('dl', { class: 'decl-reponses small' }, ...(d.reponses || []).flatMap((r) => [h('dt', {}, r.question), h('dd', {}, r.reponse)])) : null,
    d.message ? h('p', { class: 'decl-message' }, d.message) : null,
    (d.photos || []).length ? h('div', { class: 'decl-photos' }, ...(d.photos || []).map((p, i) => vignette(p.chemin, i))) : null,
    (d.conversation || []).length ? h('details', { class: 'small' }, h('summary', {}, `Conversation avec l'assistant (${d.conversation.length} messages)`),
      ...d.conversation.map((m) => h('p', {}, h('b', {}, m.role === 'user' ? 'Client : ' : 'Assistant : '), m.content))) : null,
    h('div', { class: 'actions no-print' }, bouton,
      a.email ? h('a', { class: 'button secondary', href: `mailto:${a.email}?subject=${encodeURIComponent(`Votre demande : ${d.libelle || ''}`)}` }, 'Répondre par e-mail') : null));
}

function dessiner() {
  const z = zone();
  if (!z || !liste) return;
  if (!liste.length) {
    z.replaceChildren(h('p', { class: 'muted' }, 'Aucune déclaration pour le moment. Elles arrivent ici quand un client fait une demande depuis la bulle d\'aide de l\'appli (casse, chargeur, vol, colis, panne).'));
    return;
  }
  const aTraiter = liste.filter((d) => d.statut !== 'traitee');
  const traitees = liste.filter((d) => d.statut === 'traitee');
  z.replaceChildren(
    aTraiter.length ? h('div', {}, ...aTraiter.map(carte)) : h('p', { class: 'muted' }, 'Tout est traité.'),
    traitees.length ? h('details', { class: 'decl-anciennes' }, h('summary', {}, `Déjà traitées (${traitees.length})`), ...traitees.map(carte)) : null,
  );
}

// Lu à l'ouverture de l'onglet (clic, adresse #clients/declarations, ou onglet retenu de la dernière fois), relu à
// chaque ouverture. Pas à la connexion : l'admin ne dépend pas de cette fonction pour ses autres pages.
let admin = false;
function siVisible() {
  const z = zone();
  if (admin && z && !z.hidden && z.closest('[data-panneau]') && !z.closest('[data-panneau]').hidden) charger();
}
onAuthStateChanged(getAuth(getApp('admin')), (user) => {
  admin = false;
  if (!user) return;
  user.getIdTokenResult().then((t) => { admin = t.claims.admin === true; siVisible(); }).catch(() => null);
});
window.addEventListener('hashchange', () => setTimeout(siVisible, 0));
// Page ou onglet montrés par gestion.js (après la connexion, ou onglet retenu) : attribut hidden retiré.
{
  const z = zone();
  const panneau = z && z.closest('[data-panneau]');
  const suivre = new MutationObserver(() => siVisible());
  if (z) suivre.observe(z, { attributes: true, attributeFilter: ['hidden'] });
  if (panneau) suivre.observe(panneau, { attributes: true, attributeFilter: ['hidden'] });
}
document.querySelectorAll('[data-panneau="clients"] .onglets [data-onglet="declarations"]').forEach((b) => b.addEventListener('click', () => setTimeout(siVisible, 0)));
