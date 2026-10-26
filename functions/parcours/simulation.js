// Simulation du parcours client : les vraies fonctions de functions/index.js tournent ici, sur l'émulateur
// Firestore et l'émulateur d'authentification (lancés par « npm run parcours »), sans rien toucher en ligne.
//
//   Stripe      simulé en mémoire (faux-stripe.js) : rien n'est payé, aucune clé n'est utilisée
//   e-mails     gardés dans boite[] au lieu de partir
//   push        notifications gardées dans notifications[]
//   voix        lecture des messages désactivée (elle appellerait Google)
//   Storage     fichiers simulés (seules les suppressions comptent ici)
//   horloge     avancer(jours) fait passer le temps pour Date.now() (rappels, 30 jours, restitution…)
//
// Les déclencheurs Firestore (onDocumentCreated…) sont rejoués comme en ligne : la simulation écoute
// la base et appelle chaque déclencheur avec l'état avant/après. calme() attend que tout soit fini :
// déclencheurs, événements Stripe envoyés au webhook, et leurs suites. Une erreur dans un déclencheur
// ou un webhook refusé est notée dans erreurs[] : les tests vérifient qu'il n'y en a aucune.

const http = require('node:http');
const path = require('node:path');

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error('Lancez les tests du parcours avec « npm run parcours » (émulateurs Firestore et Auth).');
}

// ---------- Réglages, comme functions/.env et les secrets en ligne (valeurs factices) ----------
Object.assign(process.env, {
  GCLOUD_PROJECT: process.env.GCLOUD_PROJECT || 'demo-papote',
  STRIPE_SECRET: 'sk_test_simulation',
  STRIPE_WEBHOOK_SECRET: 'whsec_simulation',
  MAIL_MOT_DE_PASSE: 'simulation',
  MAIL_SMTP: 'smtp.simulation:465:papote',
  MAIL_EXPEDITEUR: 'Papote <contact@mapapote.fr>',
  SITE_VITRINE: 'https://mapapote.fr',
  COMMANDES_OUVERTES: 'non',
  ANTHROPIC_API_KEY: 'simulation',
  SENDCLOUD_API: 'simulation:simulation',
  FACTURES_MOT_DE_PASSE: 'simulation',
});

const erreurs = [];

// ---------- Horloge ----------
const vraiMaintenant = Date.now.bind(Date);
let decalage = 0;
Date.now = () => vraiMaintenant() + decalage;
const JOUR = 24 * 3600 * 1000;
function avancer(jours) {
  decalage += Math.round(jours * JOUR);
}

// Les sonneries insistent toutes les 12 s (appels.js) : en simulation, tout de suite.
const vraiSetTimeout = global.setTimeout;
global.setTimeout = (f, ms, ...args) => vraiSetTimeout(f, ms === 12_000 ? 5 : ms, ...args);

// ---------- Faux services ----------
const { creerFauxStripe } = require('./faux-stripe');
const stripe = creerFauxStripe(() => Date.now());
const resoudre = (m) => require.resolve(m, { paths: [path.join(__dirname, '..')] });
require.cache[resoudre('stripe')] = {
  id: resoudre('stripe'), filename: resoudre('stripe'), loaded: true,
  // eslint-disable-next-line prefer-arrow-callback
  exports: function Stripe() { return stripe.api; },
};

const boite = [];
const mail = require('../mail');
mail.envoyer = async ({ a, contenu }) => {
  boite.push({ a, sujet: contenu.subject, texte: contenu.text, le: Date.now() });
};

const notifications = [];
const push = require('../push');
push.envoyer = async (db, fid, uids, data) => {
  notifications.push({ fid, uids: [...uids], ...data });
  return uids.length;
};

require('../voix').voixDocument = async () => null;

// Coordonnées de la commune du point relais (installation.js) : réponse fixe, sans internet.
const vraiFetch = global.fetch;
global.fetch = async (url, options) => {
  if (String(url).startsWith('https://geo.api.gouv.fr/')) {
    return new Response(JSON.stringify([{ nom: 'Saint-Martin-de-Valamas', centre: { coordinates: [4.37, 44.94] } }]));
  }
  if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(String(url))) return vraiFetch(url, options);
  throw new Error(`Simulation : pas d'internet (${url})`);
};

const admin = require('firebase-admin');
const fichiersEffaces = [];
const faussePoubelle = {
  deleteFiles: async ({ prefix }) => { fichiersEffaces.push(prefix); },
  getFiles: async () => [[]],
  file: (nom) => ({ delete: async () => { fichiersEffaces.push(nom); }, save: async () => null, getSignedUrl: async () => ['https://simulation'] }),
};
Object.defineProperty(admin, 'storage', { value: () => ({ bucket: () => faussePoubelle }), configurable: true });

// Journaux des fonctions : gardés au lieu d'être affichés. Un logger.error compte comme une erreur
// (e-mail non parti, remboursement refusé…) ; les avertissements restent dans journal[].
const journal = [];
const logger = require('firebase-functions/logger');
const formater = (args) => args.map((x) => (x instanceof Error ? x.message : typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');
for (const niveau of ['debug', 'log', 'info', 'warn']) logger[niveau] = (...args) => journal.push(`${niveau} : ${formater(args)}`);
logger.error = (...args) => {
  journal.push(`error : ${formater(args)}`);
  erreurs.push(`logger.error : ${formater(args)}`);
};

// ---------- Les vraies fonctions ----------
const fonctions = require('../index');
const db = require('../base').db();
const { FieldValue, Timestamp } = require('firebase-admin/firestore');

// ---------- Déclencheurs Firestore rejoués ----------
const DECLENCHEURS = [
  { chemin: 'families/{fid}', creation: ['nouvelleFamille'] },
  { chemin: 'families/{fid}/members/{uid}', creation: ['nouveauMembre'], ecriture: ['compterProches'] },
  { chemin: 'families/{fid}/posts/{pid}', creation: ['quotaEnvois'], ecriture: ['voixEnvoi'] },
  { chemin: 'families/{fid}/reminders/{rid}', ecriture: ['voixRappel'] },
  { chemin: 'families/{fid}/calls/{cid}', creation: ['appelsSonnerie'], modification: ['appelsManques'] },
  { chemin: 'commandes/{id}', modification: ['commandeModifiee'] },
  { chemin: 'pairings/{code}', modification: ['gestionJumelage'] },
];

function correspond(modele, chemin) {
  const a = modele.split('/');
  const b = chemin.split('/');
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('{')) params[a[i].slice(1, -1)] = b[i];
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

const enCours = new Set();
let derniereActivite = Date.now();
const absent = (ref) => ({ exists: false, ref, id: ref.id, data: () => undefined, get: () => undefined });

function lancer(nom, evenement) {
  const p = Promise.resolve()
    .then(() => fonctions[nom].run(evenement))
    .catch((e) => erreurs.push(`${nom} (${evenement.chemin}) : ${e && e.stack ? e.stack : e}`))
    .finally(() => { enCours.delete(p); derniereActivite = vraiMaintenant(); });
  enCours.add(p);
}

function changement(avant, apres, ref) {
  const chemin = ref.path;
  derniereActivite = vraiMaintenant();
  for (const d of DECLENCHEURS) {
    const params = correspond(d.chemin, chemin);
    if (!params) continue;
    const change = { before: avant || absent(ref), after: apres || absent(ref) };
    if (!avant && apres) (d.creation || []).forEach((n) => lancer(n, { data: apres, params, chemin }));
    if (avant && apres) (d.modification || []).forEach((n) => lancer(n, { data: change, params, chemin }));
    (d.ecriture || []).forEach((n) => lancer(n, { data: change, params, chemin }));
  }
}

const ecoutes = [];
function ecouter() {
  const requetes = [
    db.collection('families'), db.collectionGroup('members'), db.collectionGroup('posts'),
    db.collectionGroup('reminders'), db.collectionGroup('calls'), db.collection('commandes'), db.collection('pairings'),
  ];
  return Promise.all(requetes.map((q) => new Promise((pret, rate) => {
    const connus = new Map();
    let premier = true;
    ecoutes.push(q.onSnapshot((snap) => {
      for (const c of snap.docChanges()) {
        const chemin = c.doc.ref.path;
        const avant = connus.get(chemin) || null;
        if (c.type === 'removed') connus.delete(chemin);
        else connus.set(chemin, c.doc);
        if (!premier) changement(avant, c.type === 'removed' ? null : c.doc, c.doc.ref);
      }
      if (premier) {
        premier = false;
        pret();
      }
    }, rate));
  })));
}

// ---------- Webhook Stripe et requêtes HTTP (site vitrine) ----------
const express = require('express');
let serveur;
let adresse;

function demarrerServeur() {
  const app = express();
  app.use(express.raw({ type: '*/*', limit: '1mb' }));
  app.all('/:nom', (req, res) => {
    req.rawBody = req.body;
    try {
      req.body = req.body && req.body.length ? JSON.parse(req.body.toString('utf8')) : {};
    } catch (e) {
      req.body = {};
    }
    const f = fonctions[req.params.nom];
    if (!f) return res.status(404).send('fonction inconnue');
    return f(req, res);
  });
  return new Promise((pret) => {
    serveur = http.createServer(app).listen(0, '127.0.0.1', () => {
      adresse = `http://127.0.0.1:${serveur.address().port}`;
      pret();
    });
  });
}

// GET ou POST vers une fonction « onRequest » ; les redirections ne sont pas suivies.
async function requete(nom, { query = {}, corps, entetes = {} } = {}) {
  const url = `${adresse}/${nom}?${new URLSearchParams(query)}`;
  const r = await vraiFetch(url, {
    method: corps ? 'POST' : 'GET', redirect: 'manual',
    headers: { ...(corps ? { 'content-type': 'application/json' } : {}), ...entetes },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  let json = null;
  try { json = JSON.parse(texte); } catch (e) { /* page ou texte */ }
  return { statut: r.status, redirection: r.headers.get('location'), texte, json };
}

// Événements Stripe en attente : envoyés au webhook, un par un, comme Stripe.
async function envoyerEvenementsStripe() {
  let n = 0;
  while (stripe.etat.evenements.length) {
    const ev = stripe.etat.evenements.shift();
    const r = await requete('stripeWebhook', { corps: ev, entetes: { 'stripe-signature': 'faux' } });
    if (r.statut !== 200) erreurs.push(`Webhook ${ev.type} refusé (${r.statut}) : ${r.texte}`);
    n += 1;
  }
  if (n) derniereActivite = vraiMaintenant();
  return n;
}

// Attend que plus rien ne bouge : déclencheurs finis, webhooks envoyés, et aucune écriture depuis 250 ms.
async function calme(maxMs = 30_000) {
  const debut = vraiMaintenant();
  for (;;) {
    await envoyerEvenementsStripe();
    if (enCours.size) await Promise.allSettled([...enCours]);
    await new Promise((r) => vraiSetTimeout(r, 60));
    if (!enCours.size && !stripe.etat.evenements.length && vraiMaintenant() - derniereActivite > 250) return;
    if (vraiMaintenant() - debut > maxMs) throw new Error(`La simulation ne se calme pas (${enCours.size} déclencheur(s) en cours).`);
  }
}

// ---------- Comptes et appels « onCall » ----------
const comptes = new Map();
async function compte(prenom, email, { admin: estAdmin = false } = {}) {
  const uid = `u-${prenom.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`;
  await admin.auth().createUser({ uid, email, emailVerified: true, displayName: prenom });
  const c = { uid, email, prenom, admin: estAdmin };
  comptes.set(uid, c);
  return c;
}

// Appelle une fonction onCall comme l'appli : request.auth vient du compte connecté.
function appeler(nom, data, qui) {
  const auth = qui ? {
    uid: qui.uid,
    token: { email: qui.email, email_verified: true, firebase: { sign_in_provider: 'password' }, ...(qui.admin ? { admin: true } : {}) },
  } : undefined;
  return fonctions[nom].run({ data, auth, rawRequest: { headers: {} } });
}

// Tâche planifiée (onSchedule) lancée tout de suite.
const tache = (nom) => fonctions[nom].run({ scheduleTime: new Date(Date.now()).toISOString() });

// ---------- Base ----------
// Vidage complet par l'API de l'émulateur (plus sûr que recursiveDelete pendant que la simulation écoute).
async function viderBase() {
  const projet = process.env.GCLOUD_PROJECT;
  for (const base of ['(default)', require('../base').BASE_FIRESTORE]) {
    const r = await vraiFetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projet}/databases/${base}/documents`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`Émulateur Firestore : vidage refusé (${r.status})`);
  }
  const r = await vraiFetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${projet}/accounts`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`Émulateur Auth : vidage refusé (${r.status})`);
}

const lire = async (chemin) => (await db.doc(chemin).get()).data();

async function demarrer() {
  await demarrerServeur();
  await ecouter();
}

async function arreter() {
  ecoutes.forEach((stop) => stop());
  await new Promise((r) => serveur.close(r));
  await Promise.all(admin.apps.map((a) => a.delete()));
}

// Remet la simulation à zéro entre deux scénarios.
async function remettreAZero() {
  await calme();
  await viderBase();
  await calme();
  stripe.vider();
  boite.length = 0;
  notifications.length = 0;
  erreurs.length = 0;
  journal.length = 0;
  fichiersEffaces.length = 0;
  decalage = 0;
}

module.exports = {
  demarrer, arreter, remettreAZero, calme, avancer, JOUR,
  stripe, boite, notifications, erreurs, journal, fichiersEffaces,
  fonctions, db, FieldValue, Timestamp, lire, compte, appeler, tache, requete,
};
