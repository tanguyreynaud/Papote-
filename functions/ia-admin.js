// IA de l'admin : répond aux « que faire si… » de la page #aide (web/admin.html), avec le guide et l'état du parc.
//
//   iaAdmin  appel depuis l'admin : { question } → { ok: true, reponse } ou { ok: false, raison, reponse }
//
// Ce que l'IA reçoit : le guide (admin-guide.md, même texte que la page #aide) et, lus en direct et en lecture
// seule, pour chaque tablette partie chez un client : sa fiche du stock, le nom de la famille, l'état de
// l'abonnement, son dernier signe de vie et sa batterie, sa carte SIM (statut, data du mois, fin du forfait), et
// une pause hospitalisation en cours. Jamais de téléphone, d'adresse, d'e-mail, de nom de client ni de photo :
// chaque lecture ne demande que ces champs-là (select / fieldMask) et resumeParc ne recopie qu'eux.
//
// L'IA n'agit jamais : elle dit quel écran ouvrir et quel bouton toucher. Seuls les liens vers des écrans de l'admin
// (et Stripe, l'état de Firebase) sont gardés dans la réponse ; tout autre lien inventé est retiré.
// La seule écriture est le compteur de questions du jour (iaAdminQuota/{jour}).
// Garde-fous : réservé au badge admin (vérifié ici, côté serveur), 40 questions par jour au total, réponse courte.
// Sans IA (panne, quota atteint), une phrase calme renvoie aux 6 cas du guide, qui marchent sans elle.
// Même clé Anthropic que le chat de support (outils/support/installer-support.bat), jamais dans le dépôt.

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const fs = require('fs');
const path = require('path');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const MODELE = 'claude-haiku-5-5';
const QUOTA_JOUR = 40; // questions par jour, tous admins confondus
const MAX_QUESTION = 500;
const MAX_TOKENS = 700; // trois à cinq étapes courtes
const MAX_TABLETTES = 60;
const GUIDE = fs.readFileSync(path.join(__dirname, 'admin-guide.md'), 'utf8');

const MESSAGE_QUOTA = 'L’aide a assez répondu pour aujourd’hui. Les 6 cas du guide, juste en dessous, donnent les étapes et les bons écrans.';
const MESSAGE_PANNE = 'L’aide ne répond pas pour le moment. Les 6 cas du guide, juste en dessous, donnent les étapes et les bons écrans.';
const MESSAGE_VIDE = 'Je n’ai pas de réponse sûre. Regardez les 6 cas du guide, juste en dessous.';

// Écrans de l'admin que la réponse peut ouvrir (ceux du guide), et les deux sites extérieurs du guide.
const LIENS_FIXES = ['#aide', '#accueil', '#commandes', '#clients/liste', '#clients/familles', '#stock/tablettes', '#stock/sim',
  '#compta/factures', 'https://dashboard.stripe.com', 'https://status.firebase.google.com'];

const CONSIGNES = `Tu aides l'administrateur de Papote (tablettes pour seniors prêtées aux familles, avec abonnement et carte SIM) à savoir quoi faire dans son espace admin.

Réponds en français, en vouvoyant, par 2 à 5 étapes numérotées (« 1. », « 2. »…), une phrase ou deux chacune, sans titre, sans gras, sans tableau. Commence directement par la première étape.
Appuie-toi d'abord sur le guide ci-dessous, puis sur l'état du parc s'il concerne la question (cite la tablette, la famille, le dernier signe de vie, la data du mois ou la fin du forfait quand c'est utile). Si une donnée manque, dis-le simplement. N'invente aucun bouton, écran ni délai qui n'est pas dans le guide.
Tu ne peux rien faire toi-même et tu ne vois que ce qui est écrit ici : ne dis jamais que tu as fait, vérifié ou envoyé quelque chose. Dis quel écran ouvrir et quel bouton toucher.
Pour ouvrir un écran, écris un lien au format [Libellé court](#ecran), seulement avec les adresses de la liste « Liens permis » ; aucun autre lien, aucune adresse web.
Si la question n'a rien à voir avec l'admin Papote, réponds en une phrase que tu n'aides que pour l'admin Papote et renvoie au guide [Que faire si…](#aide).`;

// ---------- Règles, sans dépendance (ia-admin.test.js) ----------

function enMillis(v) {
  if (v == null) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return typeof v === 'number' ? v : null;
}

function ilYA(ms, maintenant) {
  if (!ms) return 'jamais vu';
  const min = Math.max(0, Math.round((maintenant - ms) / 60000));
  if (min < 60) return `il y a ${min} min`;
  if (min < 48 * 60) return `il y a ${Math.round(min / 60)} h`;
  return `il y a ${Math.round(min / 1440)} j`;
}

function dansJours(ms, maintenant) {
  const j = Math.ceil((ms - maintenant) / 864e5);
  if (j < 0) return `fini depuis ${-j} j`;
  if (j === 0) return 'finit aujourd’hui';
  return `finit dans ${j} j`;
}

// Identifiant sûr dans une adresse #… (ids Firestore, T-001, sub_…).
const idSur = (v) => (typeof v === 'string' && /^[\w.-]{1,80}$/.test(v) ? v : null);
// Texte court sans retour à la ligne ni crochet (le nom de la famille ne peut pas fabriquer de lien).
const court = (v, max = 40) => String(v || '').replace(/[\r\n[\]()<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const ABONNEMENTS = {
  actif: 'actif', impaye: 'paiement en retard', suspendu: 'en pause (impayé)', resilie: 'résilié', aucun: 'aucun', offert: 'offert',
};
const ETATS_PARTIS = ['envoyee', 'chez-client', 'en-retour'];

// État du parc pour l'IA : une ligne par tablette partie chez un client, seulement les champs utiles (aucun
// téléphone, e-mail, adresse ni nom de personne). Renvoie { texte, liens } : liens = les fiches citées, permises
// dans la réponse en plus des écrans fixes.
function resumeParc({ stock = [], familles = new Map(), membres = new Map(), sims = new Map(), commandes = new Map() }, maintenant) {
  const lignes = [];
  const liens = new Set();
  const parties = stock.filter((t) => ETATS_PARTIS.includes(t.etat)).slice(0, MAX_TABLETTES);
  for (const t of parties) {
    const id = idSur(t.id);
    if (!id) continue;
    const morceaux = [`Tablette ${court(t.ref || id, 20)} [fiche](#tablette/${id})`, t.etat === 'chez-client' ? 'chez le client' : t.etat === 'envoyee' ? 'envoyée, pas encore jumelée' : 'en retour'];
    liens.add(`#tablette/${id}`);
    const f = t.fid ? familles.get(t.fid) : null;
    if (f) {
      if (f.nom) morceaux.push(`famille « ${court(f.nom)} »`);
      if (f.statut) morceaux.push(`abonnement ${ABONNEMENTS[f.statut] || court(f.statut, 20)}`);
      const grace = enMillis(f.graceJusqua);
      if (f.statut === 'impaye' && grace) morceaux.push(`mise en pause ${dansJours(grace, maintenant).replace('finit', 'prévue')}`);
    }
    const cid = idSur(t.commande);
    if (cid) {
      morceaux.push(`commande [commande](#commande/${cid})`);
      liens.add(`#commande/${cid}`);
      const c = commandes.get(cid);
      const pause = c && enMillis(c.pauseJusqua);
      if (pause && pause > maintenant) morceaux.push(`pause hospitalisation jusqu'au ${new Date(pause).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' })}`);
    }
    const m = t.tabletUid ? membres.get(t.tabletUid) : null;
    if (m) {
      morceaux.push(`dernier signe de vie ${ilYA(enMillis(m.lastOnline), maintenant)}`);
      if (typeof m.batterie === 'number') morceaux.push(`batterie ${Math.round(m.batterie)} %${m.enCharge ? ' en charge' : ''}`);
    } else if (t.etat === 'chez-client') {
      morceaux.push('pas de signe de vie connu');
    }
    const sid = idSur(t.simId);
    if (sid) {
      const s = sims.get(sid) || {};
      const sim = [`carte SIM [carte SIM](#sim/${sid})`];
      liens.add(`#sim/${sid}`);
      if (s.statut) sim.push(s.statut === 'active' ? 'active' : s.statut === 'suspendue' ? 'suspendue' : court(s.statut, 20));
      const forfaitMo = Number.isFinite(s.go) ? Math.round(s.go * 1000) : null;
      const mo = m && Number.isFinite(m.dataMoisMo) && m.dataMoisMo >= 0 ? Math.round(m.dataMoisMo) : null;
      if (mo != null) sim.push(`data du mois ${mo} Mo${forfaitMo ? ` sur ${forfaitMo} Mo` : ''}`);
      const fin = enMillis(s.prochaineRecharge);
      if (fin) sim.push(`forfait ${dansJours(fin, maintenant)}${s.renouvellementAuto ? ' (renouvelé tout seul)' : ''}`);
      morceaux.push(sim.join(', '));
    }
    lignes.push(`- ${morceaux.join(' · ')}`);
  }
  const texte = lignes.length ? lignes.join('\n') : '(aucune tablette chez un client)';
  return { texte, liens: [...liens] };
}

// Question tapée par l'admin : courte, et sans e-mail ni numéro de téléphone collé par mégarde.
function nettoyerQuestion(q) {
  if (typeof q !== 'string') return '';
  return q.replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[e-mail masqué]')
    .replace(/(?:\+\d{1,3}[\s.-]?)?\(?\d(?:[\s.\-()]?\d){8,}/g, '[numéro masqué]')
    .replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION);
}

// Réponse de l'IA : liens permis gardés, tout autre lien remplacé par son libellé, adresses nues retirées.
function filtrerLiens(texte, permis) {
  const ok = new Set(permis);
  return String(texte || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    // Une paire de parenthèses permise dans l'adresse (javascript:alert(1)) : retirée en entier.
    .replace(/\[([^\]\n]{1,80})\]\(\s*((?:[^()\s]|\([^()\s]*\))+)\s*\)/g, (_, libelle, href) => (ok.has(href) ? `[${libelle}](${href})` : libelle))
    // Adresses nues (https://…, www.…) hors des liens gardés : retirées, la ponctuation qui les suit reste.
    .replace(/(^|[^(\w])(?:https?:\/\/|www\.)[^\s()]*?(?=[.,;:!?]*(?:\s|$))/g, (tout, avant) => avant)
    .replace(/[ \t]{2,}/g, ' ').replace(/ +([.,])/g, '$1').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Compteur du jour (seule écriture de la fonction) : false si le quota est atteint ou si le compteur est illisible.
async function quotaOk(db, maintenant) {
  const jour = new Date(maintenant).toISOString().slice(0, 10);
  const ref = db.doc(`iaAdminQuota/${jour}`);
  return db.runTransaction(async (t) => {
    const s = await t.get(ref);
    const n = ((s.exists && s.get('n')) || 0) + 1;
    if (n > QUOTA_JOUR) return false;
    t.set(ref, { n, expire: new Date(maintenant + 7 * 864e5) }, { merge: true });
    return true;
  }).catch((e) => {
    logger.warn('Compteur de l’IA admin indisponible, question refusée', e.message);
    return false;
  });
}

// Lecture seule de l'état du parc : seulement les champs utiles à l'IA.
async function lireParc(db) {
  const [stock, familles, sims] = await Promise.all([
    db.collection('stock').where('etat', 'in', ETATS_PARTIS).select('ref', 'etat', 'fid', 'tabletUid', 'simId', 'commande').get(),
    db.collection('families').select('name', 'abonnement.statut', 'abonnement.graceJusqua').get(),
    db.collection('sims').select('statut', 'go', 'prochaineRecharge', 'renouvellementAuto').get(),
  ]);
  const fiches = stock.docs.map((d) => ({ id: d.id, ref: d.get('ref'), etat: d.get('etat'), fid: d.get('fid'), tabletUid: d.get('tabletUid'), simId: d.get('simId'), commande: d.get('commande') }));
  const jumelees = fiches.filter((t) => idSur(t.fid) && idSur(t.tabletUid));
  const avecCommande = fiches.filter((t) => idSur(t.commande));
  const [docsMembres, docsCommandes] = await Promise.all([
    jumelees.length ? db.getAll(...jumelees.map((t) => db.doc(`families/${t.fid}/members/${t.tabletUid}`)),
      { fieldMask: ['lastOnline', 'battery.level', 'battery.charging', 'sim.dataMoisMo'] }) : [],
    avecCommande.length ? db.getAll(...avecCommande.map((t) => db.doc(`commandes/${t.commande}`)), { fieldMask: ['pause.jusqua'] }) : [],
  ]);
  const membres = new Map(jumelees.map((t, i) => [t.tabletUid, docsMembres[i] && docsMembres[i].exists ? {
    lastOnline: docsMembres[i].get('lastOnline'), batterie: docsMembres[i].get('battery.level'),
    enCharge: docsMembres[i].get('battery.charging') === true, dataMoisMo: docsMembres[i].get('sim.dataMoisMo'),
  } : null]).filter(([, m]) => m));
  const commandes = new Map(avecCommande.map((t, i) => [t.commande, { pauseJusqua: docsCommandes[i] && docsCommandes[i].exists ? docsCommandes[i].get('pause.jusqua') : null }]));
  return {
    stock: fiches,
    familles: new Map(familles.docs.map((d) => [d.id, { nom: d.get('name'), statut: d.get('abonnement.statut'), graceJusqua: d.get('abonnement.graceJusqua') }])),
    sims: new Map(sims.docs.map((d) => [d.id, { statut: d.get('statut'), go: d.get('go'), prochaineRecharge: d.get('prochaineRecharge'), renouvellementAuto: d.get('renouvellementAuto') === true }])),
    membres,
    commandes,
  };
}

function quand(maintenant) {
  return new Date(maintenant).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

// Requête envoyée à Anthropic : consignes et guide fixes (mis en cache), puis l'état du parc et la question.
function requete(question, parc, maintenant) {
  const liens = [...LIENS_FIXES, ...parc.liens];
  return {
    model: MODELE,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
    system: [
      { type: 'text', text: CONSIGNES },
      { type: 'text', text: GUIDE, cache_control: { type: 'ephemeral' } },
      // Après le bloc mis en cache : l'état du parc change sans invalider le cache du guide.
      { type: 'text', text: `# État du parc (${quand(maintenant)}, heure de Paris)\n\n${parc.texte}\n\n# Liens permis\n\n${liens.join('\n')}` },
    ],
    messages: [{ role: 'user', content: question }],
  };
}

// Traitement d'une question, dépendances fournies (base, client Anthropic) pour les tests.
function creer({ db, client, maintenant = () => Date.now() }) {
  return async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Connectez-vous.');
    if (!request.auth.token || request.auth.token.admin !== true) throw new HttpsError('permission-denied', 'Réservé à l\'administrateur.');
    const question = nettoyerQuestion(request.data && request.data.question);
    if (question.length < 3) throw new HttpsError('invalid-argument', 'Écrivez votre question.');
    const t = maintenant();
    if (!(await quotaOk(db(), t))) return { ok: false, raison: 'quota', reponse: MESSAGE_QUOTA };
    let parc = { texte: '(état du parc illisible pour le moment)', liens: [] };
    try {
      parc = resumeParc(await lireParc(db()), t);
    } catch (e) {
      logger.warn('IA admin : état du parc illisible', e.message);
    }
    const corps = requete(question, parc, t);
    try {
      const r = await client().messages.create(corps);
      const brut = r.stop_reason === 'refusal' ? '' : (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const reponse = filtrerLiens(brut, [...LIENS_FIXES, ...parc.liens]);
      if (!reponse) return { ok: false, raison: 'vide', reponse: MESSAGE_VIDE };
      return { ok: true, reponse };
    } catch (e) {
      logger.error('IA admin', e.message || e);
      return { ok: false, raison: 'indisponible', reponse: MESSAGE_PANNE };
    }
  };
}

let anthropic;
exports.iaAdmin = onCall({ secrets: [ANTHROPIC_API_KEY], maxInstances: 2, timeoutSeconds: 60 }, creer({
  db: () => require('./base').db(),
  client: () => {
    if (!anthropic) anthropic = new (require('@anthropic-ai/sdk'))({ apiKey: ANTHROPIC_API_KEY.value(), maxRetries: 1, timeout: 40_000 });
    return anthropic;
  },
}));

exports._test = {
  creer, resumeParc, nettoyerQuestion, filtrerLiens, requete, quotaOk, lireParc, LIENS_FIXES, QUOTA_JOUR, MESSAGE_QUOTA, MESSAGE_PANNE, GUIDE, CONSIGNES,
};
