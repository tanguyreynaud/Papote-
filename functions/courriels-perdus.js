// E-mails perdus (audit des e-mails du 11/11, point 2 ; Tanguy, 12/11 : « très important »). Avant, un e-mail
// client qui n'arrivait pas ne laissait aucune trace. Deux cas, une seule collection courrielsPerdus/{id} :
//
// 1. Brevo accepte l'e-mail puis ne peut pas le remettre (adresse fausse, boîte pleine, contact bloqué, signalé
//    comme indésirable…). Brevo prévient la fonction brevoWebhook (index.js) : le rejet est noté sur la commande de
//    cette adresse (mailErreur, déjà affiché par l'admin) et devient une ligne « À faire » (gestion.js, aFaire).
// 2. L'envoi SMTP échoue tout de suite (Brevo en panne ou refuse) pour un e-mail important (tout ce qui n'est ni un
//    e-mail de confort, mail.CONFORT, ni un envoi en nombre) : mail.envoyer appelle noterEchecEnvoi (branché par
//    index.js avec mail.surEchec), l'e-mail est gardé et la tâche horaire suivante (tachesHoraires,
//    « courrielsAReessayer ») le renvoie UNE fois. Second échec : ligne « À faire », plus aucun essai.
//    L'appelant reçoit toujours l'erreur, comme avant (il peut noter mailErreur, journaliser…).
//
// Statuts : 'a-reessayer' → 'reessai-en-cours' → document effacé (reparti) ou 'a-faire' ; rejet Brevo : 'a-faire'
// tout de suite. 'traite' : Tanguy a réglé la ligne (gestionCourrielTraite) ou corrigé l'adresse de la commande.
//
// ---------- Réglage chez Brevo (une fois, à faire par Tanguy) ----------
// 1. Secret Manager : `firebase functions:secrets:set BREVO_WEBHOOK_SECRET --project papote-famille`, coller une
//    longue valeur au hasard (par exemple la sortie de `openssl rand -hex 32`). À créer AVANT le déploiement :
//    sans lui, le déploiement des fonctions s'arrête (ou demande la valeur). La valeur n'est jamais écrite dans le dépôt.
// 2. Brevo > Transactionnel > Paramètres > Webhook (ou Paramètres > Webhooks) > « Ajouter un webhook » :
//    URL  https://europe-west1-papote-famille.cloudfunctions.net/brevoWebhook?cle=<la valeur du secret>
//    Événements à cocher : Hard bounce, Soft bounce, Bloqué, Adresse invalide, Plainte (spam), Désinscrit, Erreur.
//    (Pas « Envoyé », « Délivré », « Ouvert », « Cliqué », « Différé » : ils ne disent pas qu'un e-mail est perdu.)
//    Si Brevo propose une authentification « Bearer / jeton » ou un en-tête personnalisé, on peut y mettre la même
//    valeur (Authorization: Bearer <valeur>, ou en-tête X-Papote-Cle) et retirer ?cle= de l'URL : la clé n'apparaît
//    alors plus dans l'adresse (les journaux de requêtes Google gardent l'adresse complète, visibles des seuls
//    administrateurs du projet).
// 3. Tester : bouton « Tester » de Brevo s'il existe, ou un envoi vers une adresse inexistante (par exemple
//    nimporte-quoi-1234@mapapote.fr) : une ligne « À faire » apparaît dans le récap (et dans l'admin quand
//    l'accueil affichera courrielsPerdus).

const crypto = require('node:crypto');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');

const COLLECTION = 'courrielsPerdus';
// Un échec SMTP est renvoyé à la tâche horaire SUIVANTE : pas par celle qui tourne au même moment (un e-mail
// raté par une autre tâche de la même heure, relancesPaniers…, attend l'heure d'après).
const DELAI_REESSAI = 10 * 60 * 1000;
// Un nouvel essai resté « en cours » plus longtemps (fonction arrêtée au milieu) n'est pas refait : « À faire ».
const REESSAI_BLOQUE = 30 * 60 * 1000;
// Taille gardée au plus pour le contenu de l'e-mail (un document Firestore : 1 Mio au plus).
const TAILLE_MAX = 700 * 1024;

// Événements de Brevo qui disent qu'un e-mail n'arrivera pas (ou que les suivants n'arriveront plus).
// Les autres (request, delivered, opened, click, deferred…) sont ignorés : Brevo réessaie lui-même un « deferred ».
const EVENEMENTS = {
  hard_bounce: 'adresse inexistante ou refusée par la messagerie du client',
  soft_bounce: 'refusé pour l\'instant (boîte pleine ou messagerie du client indisponible)',
  blocked: 'bloqué par Brevo (adresse déjà en échec, désinscrite ou signalée)',
  invalid_email: 'adresse e-mail mal écrite',
  spam: 'signalé comme indésirable par le destinataire',
  unsubscribed: 'désinscrit chez Brevo : les prochains e-mails à cette adresse seront bloqués',
  error: 'erreur chez Brevo',
};

const texte = (v, max = 300) => String(v == null ? '' : v).slice(0, max);
const minuscules = (a) => String(a || '').trim().toLowerCase();

// ---------- Secret du webhook ----------

function memeValeur(a, b) {
  const h = (x) => crypto.createHash('sha256').update(String(x)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

// Clé donnée par Brevo : ?cle=… dans l'URL, en-tête X-Papote-Cle, ou Authorization (Bearer <clé>, ou Basic avec la
// clé pour mot de passe). Sans secret configuré, tout est refusé.
function cleValide(req, secret) {
  if (!secret) return false;
  const essais = [];
  if (req.query && typeof req.query.cle === 'string') essais.push(req.query.cle);
  const entete = (n) => (typeof req.get === 'function' ? req.get(n) : req.headers && req.headers[n.toLowerCase()]);
  if (entete('x-papote-cle')) essais.push(String(entete('x-papote-cle')));
  const auth = String(entete('authorization') || '');
  let m;
  if ((m = /^Bearer\s+(.+)$/i.exec(auth))) essais.push(m[1].trim());
  if ((m = /^Basic\s+(.+)$/i.exec(auth))) {
    const dec = Buffer.from(m[1].trim(), 'base64').toString('utf8');
    essais.push(dec.includes(':') ? dec.slice(dec.indexOf(':') + 1) : dec);
  }
  return essais.some((e) => e && memeValeur(e, secret));
}

// ---------- Rejets envoyés par Brevo ----------

// Le corps d'un appel de Brevo : un événement, ou une liste (envoi groupé). Seuls les rejets, avec une adresse.
function evenementsDe(corps) {
  const liste = Array.isArray(corps) ? corps : corps && typeof corps === 'object' ? [corps] : [];
  return liste.filter((e) => e && EVENEMENTS[e.event] && typeof e.email === 'string' && e.email.includes('@'));
}

// Identifiant stable d'un événement : Brevo renvoie le même événement s'il n'a pas eu de réponse à temps.
function idEvenement(e) {
  const cle = [e.event, e['message-id'] || '', minuscules(e.email), e.ts_event || e.ts_epoch || e.ts || e.date || ''].join('|');
  return `brevo-${crypto.createHash('sha256').update(cle).digest('hex').slice(0, 32)}`;
}

// Commande de cette adresse : la plus récente pas annulée, sinon la plus récente.
async function commandeDe(db, email) {
  const a = minuscules(email);
  if (!a) return null;
  const snap = await db.collection('commandes').where('email', '==', a).get();
  if (snap.empty) return null;
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : 0);
  const docs = [...snap.docs].sort((x, y) => (x.get('expedition') === 'annulee') - (y.get('expedition') === 'annulee')
    || ms(y.get('creeLe')) - ms(x.get('creeLe')));
  return { id: docs[0].id, nom: docs[0].get('nom') || null, ref: docs[0].ref };
}

const jourHeure = (ms) => new Date(ms).toLocaleString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

// Texte noté sur la commande (mailErreur), lu par l'admin.
function texteCommande(d) {
  const sujet = d.sujet ? `« ${d.sujet} »` : '';
  if (d.origine === 'brevo') return `E-mail ${sujet} non reçu par ${d.a} (${d.raison}), le ${jourHeure(d.leMs)}`.replace(/ {2,}/g, ' ');
  if (d.statut === 'a-reessayer') return `E-mail ${sujet} non parti le ${jourHeure(d.leMs)} (${d.erreur}) : nouvel essai à l'heure suivante`.replace(/ {2,}/g, ' ');
  return `E-mail ${sujet} non parti, même au second essai (${d.erreurReessai || d.erreur})`.replace(/ {2,}/g, ' ');
}

async function noterSurCommande(commande, t, logger) {
  if (!commande) return;
  try {
    await commande.ref.update({ mailErreur: t, mailErreurLe: Timestamp.fromMillis(Date.now()) });
  } catch (e) {
    logger.warn(`Commande ${commande.id} : e-mail perdu non noté`, e.message);
  }
}

// Un événement de Brevo : noté une seule fois (create échoue si Brevo le renvoie).
async function noterRejet(db, e, logger = console) {
  const id = idEvenement(e);
  const a = minuscules(e.email);
  const commande = await commandeDe(db, a);
  const leMs = Date.now();
  const d = {
    origine: 'brevo', evenement: e.event, a, sujet: texte(e.subject, 200) || null,
    raison: EVENEMENTS[e.event], detail: texte(e.reason, 500) || null, messageId: texte(e['message-id'], 300) || null,
    statut: 'a-faire', commande: commande ? commande.id : null, nom: commande ? commande.nom : null,
    le: Timestamp.fromMillis(leMs), creeLe: FieldValue.serverTimestamp(),
  };
  try {
    await db.doc(`${COLLECTION}/${id}`).create(d);
  } catch (err) {
    if (err.code === 6 || /already exists/i.test(err.message || '')) return { id, deja: true };
    throw err;
  }
  logger.warn(`Brevo : e-mail à ${a} perdu (${e.event})${commande ? `, commande ${commande.id}` : ''}`);
  await noterSurCommande(commande, texteCommande({ ...d, leMs }), logger);
  return { id, commande: commande ? commande.id : null };
}

// La fonction onRequest (index.js, brevoWebhook). secret() : la valeur de BREVO_WEBHOOK_SECRET.
function webhookBrevo(db, secret, logger = console) {
  return async (req, res) => {
    if (!cleValide(req, secret())) {
      logger.warn('Webhook Brevo : clé absente ou fausse');
      res.status(401).send('Clé absente ou fausse');
      return;
    }
    if (req.method !== 'POST') { res.status(405).send('POST seulement'); return; }
    const evenements = evenementsDe(req.body);
    try {
      const notes = [];
      for (const e of evenements) notes.push(await noterRejet(db, e, logger));
      res.json({ recu: true, notes: notes.filter((n) => !n.deja).length });
    } catch (err) {
      // Brevo renverra l'événement plus tard.
      logger.error('Webhook Brevo : rejet non noté', err.message);
      res.status(500).send('Erreur, réessayer');
    }
  };
}

// ---------- Échecs SMTP au moment de l'envoi ----------

// Contenu gardé pour le nouvel essai : objet, HTML, texte, en-têtes. Pas les pièces jointes (livres comptables :
// rangés dans l'admin de toute façon) ni un contenu trop gros pour un document : ligne « À faire » tout de suite.
// Exception : les documents de Papote (functions/documents/, CGV en PDF jointes à la confirmation de commande, A13)
// sont gardés par leur nom de fichier et rejoints au nouvel essai.
const DOCUMENTS = require('node:path').join(__dirname, 'documents');
function documentDePapote(p) {
  return Boolean(p && typeof p.path === 'string' && require('node:path').dirname(p.path) === DOCUMENTS && !p.content);
}
function contenuGardable(contenu) {
  if (!contenu) return null;
  const pieces = contenu.attachments || [];
  if (!pieces.every(documentDePapote)) return null;
  const garde = { subject: texte(contenu.subject, 500), html: contenu.html || null, text: contenu.text || null };
  if (pieces.length) {
    garde.documents = pieces.map((p) => ({ filename: p.filename, fichier: require('node:path').basename(p.path), contentType: p.contentType || null }));
  }
  if (contenu.headers && typeof contenu.headers === 'object') garde.headers = contenu.headers;
  return Buffer.byteLength(JSON.stringify(garde)) <= TAILLE_MAX ? garde : null;
}

// Contenu gardé → contenu à envoyer : les documents de Papote redeviennent des pièces jointes.
function contenuARenvoyer(garde) {
  if (!garde || !garde.documents) return garde;
  const { documents, ...reste } = garde;
  return { ...reste, attachments: documents.map((x) => ({ filename: x.filename, path: require('node:path').join(DOCUMENTS, require('node:path').basename(x.fichier)), ...(x.contentType ? { contentType: x.contentType } : {}) })) };
}

// Branché sur mail.surEchec (index.js) : appelé par mail.envoyer quand l'envoi d'un e-mail important échoue.
// Ne lève jamais d'erreur (l'appelant reçoit déjà celle de l'envoi).
async function noterEchecEnvoi(db, { a, contenu } = {}, erreur, logger = console) {
  try {
    const adresse = minuscules(a);
    const garde = contenuGardable(contenu);
    const commande = await commandeDe(db, adresse).catch(() => null);
    const leMs = Date.now();
    const d = {
      origine: 'smtp', a: adresse, sujet: texte(contenu && contenu.subject, 200) || null,
      erreur: texte(erreur && erreur.message ? erreur.message : erreur, 500) || 'erreur inconnue',
      statut: garde ? 'a-reessayer' : 'a-faire', contenu: garde,
      raison: garde ? null : 'pièce jointe ou e-mail trop gros pour être gardé : pas de nouvel essai',
      commande: commande ? commande.id : null, nom: commande ? commande.nom : null,
      le: Timestamp.fromMillis(leMs), creeLe: FieldValue.serverTimestamp(), essais: 1,
    };
    const ref = await db.collection(COLLECTION).add(d);
    logger.warn(`E-mail « ${d.sujet} » à ${adresse} non parti (${d.erreur}) : ${garde ? 'nouvel essai à l\'heure suivante' : 'ligne « À faire »'}`);
    await noterSurCommande(commande, texteCommande({ ...d, leMs }), logger);
    return ref.id;
  } catch (e) {
    logger.warn('E-mail non parti, et pas noté pour un nouvel essai', e.message);
    return null;
  }
}

// La tâche horaire (taches.js, « courrielsAReessayer ») : chaque e-mail en attente est renvoyé une seule fois.
// expedier(a, contenu) : l'envoi SMTP direct (mail.expedier), sans repasser par mail.envoyer (pas de nouvel échec noté).
async function reessayer(db, expedier, logger = console) {
  const maintenant = Date.now();
  const snap = await db.collection(COLLECTION).where('statut', 'in', ['a-reessayer', 'reessai-en-cours']).get();
  const bilan = { repartis: 0, aFaire: 0 };
  for (const doc of snap.docs) {
    const d = doc.data();
    const le = d.le && d.le.toMillis ? d.le.toMillis() : 0;
    if (d.statut === 'reessai-en-cours') {
      const depuis = d.reessaiLe && d.reessaiLe.toMillis ? d.reessaiLe.toMillis() : 0;
      if (maintenant - depuis < REESSAI_BLOQUE) continue;
      await doc.ref.update({ statut: 'a-faire', erreurReessai: 'nouvel essai interrompu', contenu: FieldValue.delete() });
      bilan.aFaire += 1;
      continue;
    }
    if (maintenant - le < DELAI_REESSAI) continue;
    // Une seule tâche prend l'e-mail (deux passages en même temps ne l'envoient pas deux fois).
    const pris = await db.runTransaction(async (tx) => {
      const s = await tx.get(doc.ref);
      if (!s.exists || s.get('statut') !== 'a-reessayer') return false;
      tx.update(doc.ref, { statut: 'reessai-en-cours', reessaiLe: Timestamp.fromMillis(Date.now()) });
      return true;
    });
    if (!pris) continue;
    const commande = d.commande ? db.doc(`commandes/${d.commande}`) : null;
    const notes = [texteCommande({ ...d, leMs: le }), d.erreur];
    try {
      await expedier(d.a, contenuARenvoyer(d.contenu));
      await doc.ref.delete();
      bilan.repartis += 1;
      logger.log(`E-mail « ${d.sujet} » à ${d.a} reparti au second essai`);
      // L'erreur notée sur la commande pour cet e-mail (par nous ou par l'appelant) disparaît ; une autre reste.
      if (commande) {
        await db.runTransaction(async (tx) => {
          const c = await tx.get(commande);
          if (c.exists && notes.includes(c.get('mailErreur'))) tx.update(commande, { mailErreur: FieldValue.delete(), mailErreurLe: FieldValue.delete() });
        }).catch((e) => logger.warn(`Commande ${d.commande} : mailErreur non effacée`, e.message));
      }
    } catch (e) {
      const erreurReessai = texte(e && e.message ? e.message : e, 500) || 'erreur inconnue';
      await doc.ref.update({ statut: 'a-faire', erreurReessai, essais: 2, contenu: FieldValue.delete(), reessaiLe: Timestamp.fromMillis(Date.now()) });
      bilan.aFaire += 1;
      logger.error(`E-mail « ${d.sujet} » à ${d.a} non parti au second essai : ligne « À faire »`, erreurReessai);
      if (commande) {
        await noterSurCommande({ id: d.commande, ref: commande }, texteCommande({ ...d, statut: 'a-faire', erreurReessai }), logger);
      }
    }
  }
  return bilan;
}

// ---------- « À faire » ----------

// Une ligne par adresse (plusieurs e-mails perdus pour la même adresse ne font qu'une ligne).
// courriels : documents 'a-faire' ({ id, origine, a, sujet, raison, erreur, erreurReessai, commande, nom }).
function lignesAFaire(courriels = []) {
  const parAdresse = new Map();
  for (const c of courriels.filter((x) => x && x.statut === 'a-faire')) {
    if (!parAdresse.has(c.a)) parAdresse.set(c.a, []);
    parAdresse.get(c.a).push(c);
  }
  return [...parAdresse.entries()].map(([a, liste]) => {
    const c = liste[liste.length - 1];
    const qui = c.commande ? ` (commande de ${c.nom || a})` : liste.find((x) => x.commande) ? ` (commande de ${liste.find((x) => x.commande).nom || a})` : '';
    const autres = liste.length > 1 ? ` et ${liste.length - 1} autre${liste.length > 2 ? 's' : ''}` : '';
    const sujet = c.sujet ? `« ${c.sujet} »${autres}` : `${liste.length} e-mail${liste.length > 1 ? 's' : ''}`;
    if (c.origine === 'brevo') {
      return `E-mail ${sujet} non reçu par ${a}${qui} : ${c.raison}. Vérifier l'adresse avec le client`;
    }
    return `E-mail ${sujet} à ${a}${qui} non parti${c.essais === 2 || c.erreurReessai ? ' après un second essai' : ''} (${c.erreurReessai || c.raison || c.erreur}) : le renvoyer ou prévenir le client`;
  });
}

// Lecture pour l'admin et le récap : les lignes en attente (statut 'a-faire') et les e-mails en attente d'essai.
async function enAttente(db) {
  const snap = await db.collection(COLLECTION).where('statut', 'in', ['a-faire', 'a-reessayer', 'reessai-en-cours']).get();
  return snap.docs.map((d) => {
    const x = d.data();
    return {
      id: d.id, origine: x.origine, evenement: x.evenement || null, a: x.a, sujet: x.sujet || null, raison: x.raison || null,
      erreur: x.erreur || null, erreurReessai: x.erreurReessai || null, essais: x.essais || null, statut: x.statut,
      commande: x.commande || null, nom: x.nom || null, le: x.le && x.le.toMillis ? x.le.toMillis() : null,
    };
  }).sort((p, q) => (p.le || 0) - (q.le || 0));
}

// Ligne réglée par Tanguy (gestionCourrielTraite) : elle quitte « À faire ».
async function traiter(db, id) {
  const ref = db.doc(`${COLLECTION}/${id}`);
  const s = await ref.get();
  if (!s.exists) return false;
  await ref.update({ statut: 'traite', traiteLe: Timestamp.fromMillis(Date.now()), contenu: FieldValue.delete() });
  return true;
}

// Adresse de la commande corrigée (commandeModifiee) : les lignes de l'ancienne adresse pour cette commande sont
// réglées, et mailErreur s'efface s'il parlait d'un e-mail perdu.
async function adresseCorrigee(db, commande, ancienne, logger = console) {
  const a = minuscules(ancienne);
  if (!a) return 0;
  const snap = await db.collection(COLLECTION).where('commande', '==', commande).get();
  const aRegler = snap.docs.filter((d) => d.get('a') === a && ['a-faire', 'a-reessayer'].includes(d.get('statut')));
  for (const d of aRegler) {
    await d.ref.update({ statut: 'traite', traiteLe: Timestamp.fromMillis(Date.now()), traitePar: 'adresse corrigée', contenu: FieldValue.delete() });
  }
  if (aRegler.length) logger.log(`Commande ${commande} : adresse corrigée, ${aRegler.length} e-mail(s) perdu(s) réglé(s)`);
  return aRegler.length;
}

module.exports = {
  COLLECTION, EVENEMENTS, DELAI_REESSAI,
  cleValide, evenementsDe, idEvenement, noterRejet, webhookBrevo,
  contenuGardable, contenuARenvoyer, noterEchecEnvoi, reessayer, lignesAFaire, enAttente, traiter, adresseCorrigee, texteCommande,
};
