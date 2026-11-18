// Déclaration guidée depuis la bulle d'aide de l'appli famille (chantier 3 du chat, Tanguy 18/11/2026).
//
//   declarationChat  POST, en-tête Authorization: Bearer <jeton de l'appli>
//                    {famille, cle, motif, reponses: [{question, reponse}], message?, photos: [base64 JPEG], conversation}
//                    → {ok: true, id} ; {erreur} sinon (400 demande incomplète, 401 pas connecté, 429 trop de demandes)
//   gestionDeclarations  appel depuis l'admin (badge admin) :
//                    {action: 'lister'} → {declarations} (sans les photos) ;
//                    {action: 'photo', chemin} → {contenu (base64), type} ;
//                    {action: 'traiter', id, traitee} → {ok}
//
// Pour les cas où il faut un humain (chargeur, casse, écran fissuré, vol ou perte, colis abîmé, panne après les
// essais, données personnelles) : la personne choisit le motif, répond à 2 ou 3 questions et ajoute 1 à 3 photos,
// réduites par la bulle avant l'envoi (vitrine/chat-declaration.js). Photo obligatoire pour la casse, l'écran et
// le colis. La demande arrive complète dans l'admin (onglet Clients > Déclarations) et par e-mail à l'équipe,
// photos jointes : qui écrit, sa famille, l'état de la tablette au moment de la demande, l'abonnement, les réponses
// et la conversation du chat.
//
// Photos : envoyées DANS la demande (jamais déposées par le téléphone), rangées par le serveur dans
// families/{fid}/declarations/{id}/ du bucket. Aucune règle Storage ne les ouvre : seuls le serveur et l'admin (par
// gestionDeclarations) les lisent ; elles partent avec la famille si elle est effacée, et après 12 mois (purge.js).
//
// Gestes : la clé « cle » est tirée une fois par formulaire. Double appui, nouvel essai après une coupure réseau ou
// réponse perdue : même clé, même déclaration (document créé une seule fois, un seul e-mail).
// Aucune action sur l'argent ni sur la tablette : la déclaration est lue par l'équipe, qui décide.
// Garde-fous : 5 déclarations par personne et par jour, 60 par jour au total ; 3 photos de 2 Mo au plus.

const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const crypto = require('crypto');
const mail = require('./mail');
const { db: base, BUCKET_STORAGE } = require('./base');

const MAIL_SMTP = defineString('MAIL_SMTP', { default: 'smtp.gmail.com:465:' });
const MAIL_EXPEDITEUR = defineString('MAIL_EXPEDITEUR', { default: '' });
const MAIL_MOT_DE_PASSE = defineSecret('MAIL_MOT_DE_PASSE');

const EMAIL_SUPPORT = 'contact@mapapote.fr';
const ORIGINES = ['https://papote-famille.web.app', 'https://app.mapapote.fr'];
const JOUR = 86400e3;
const DUREE_MS = 365 * JOUR;

// Motifs : libellé (admin, e-mail) et photo demandée d'office (avis du fil Chat IA, 18/11).
const MOTIFS = {
  chargeur: { libelle: 'Chargeur perdu ou abîmé', photo: false },
  ecran: { libelle: 'Écran fissuré ou cassé', photo: true },
  casse: { libelle: 'Tablette abîmée', photo: true },
  vol: { libelle: 'Tablette volée ou perdue', photo: false },
  colis: { libelle: 'Colis abîmé ou incomplet', photo: true },
  panne: { libelle: 'Panne après les essais de dépannage', photo: false },
  donnees: { libelle: 'Mes données personnelles', photo: false },
  autre: { libelle: 'Autre demande', photo: false },
};
const MAX_PHOTOS = 3;
const MAX_PHOTO_OCTETS = 2 * 1024 * 1024;
const MAX_REPONSES = 8;
const QUOTA_PERSONNE = 5;
const QUOTA_JOUR = 60;
const DELAI_REPONSE = 'sous 48 h';

// ---------- Règles pures (declaration.test.js) ----------

const texte = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const texteLong = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

function photoValide(b64) {
  if (typeof b64 !== 'string' || b64.length > MAX_PHOTO_OCTETS * 1.4) return null;
  const octets = Buffer.from(b64.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
  // La bulle réenregistre chaque photo en JPEG : tout autre contenu est refusé.
  if (octets.length < 100 || octets.length > MAX_PHOTO_OCTETS || octets[0] !== 0xff || octets[1] !== 0xd8 || octets[2] !== 0xff) return null;
  return octets;
}

// Conversation du chat jointe à la déclaration : seulement des tours user/assistant, courts.
function conversationPropre(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-12)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: texteLong(m.content, 1000) }))
    .filter((m) => m.content);
}

// Corps de la demande → déclaration propre, ou { erreur } (message montré tel quel dans la bulle).
function lireDemande(corps) {
  const c = corps || {};
  const motif = Object.prototype.hasOwnProperty.call(MOTIFS, c.motif) ? c.motif : null;
  if (!motif) return { erreur: 'Choisissez ce qui se passe.' };
  const cle = typeof c.cle === 'string' && /^[\w-]{12,64}$/.test(c.cle) ? c.cle : null;
  if (!cle) return { erreur: 'Demande incomplète. Fermez le chat et recommencez.' };
  const reponses = (Array.isArray(c.reponses) ? c.reponses : []).slice(0, MAX_REPONSES)
    .map((r) => ({ question: texte(r && r.question, 120), reponse: texteLong(r && r.reponse, 600) }))
    .filter((r) => r.question && r.reponse);
  const brutes = Array.isArray(c.photos) ? c.photos : [];
  if (brutes.length > MAX_PHOTOS) return { erreur: `${MAX_PHOTOS} photos au plus.` };
  const photos = brutes.map(photoValide);
  if (photos.some((p) => !p)) return { erreur: 'Une photo ne passe pas. Retirez-la et choisissez-en une autre.' };
  if (MOTIFS[motif].photo && !photos.length) return { erreur: 'Ajoutez au moins une photo, elle nous aide à vous répondre vite.' };
  const message = texteLong(c.message, 1500);
  if (!reponses.length && !message) return { erreur: 'Dites-nous en quelques mots ce qui se passe.' };
  return { motif, cle, reponses, message, photos, conversation: conversationPropre(c.conversation) };
}

const idDeclaration = (uid, cle) => crypto.createHash('sha256').update(`${uid}:${cle}`).digest('hex').slice(0, 24);

function enMillis(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === 'function') return v.toMillis();
  return null;
}

// État de la tablette au moment de la demande, en clair, pour l'équipe (mêmes champs que « Derniers relevés »).
function etatTablette(m, ref, maintenant) {
  if (!m) return null;
  const sim = m.sim || {};
  const b = m.battery || {};
  const enLigne = enMillis(m.lastOnline);
  const reseau = m.sim
    ? [sim.bloquee ? 'carte SIM bloquée' : 'carte SIM', sim.reseau || sim.operateur || null, sim.signal >= 0 ? `signal ${sim.signal}/4` : null].filter(Boolean).join(', ')
    : 'Wi-Fi';
  return {
    ref: ref || null,
    enLigneLe: enLigne,
    horsLigne: !enLigne || maintenant - enLigne > 70 * 60e3,
    batterie: typeof b.level === 'number' ? Math.round(b.level) : null,
    enCharge: b.charging === true,
    reseau,
    dataMoisMo: typeof sim.dataMoisMo === 'number' ? sim.dataMoisMo : null,
    version: m.appVersion || null,
    vueLe: enMillis(m.lastActive),
  };
}

function ilYA(ms, maintenant) {
  if (!ms) return 'jamais';
  const min = Math.max(0, Math.round((maintenant - ms) / 60000));
  if (min < 60) return `il y a ${min} min`;
  if (min < 48 * 60) return `il y a ${Math.round(min / 60)} h`;
  return `il y a ${Math.round(min / 1440)} j`;
}

function resumeTablette(t, maintenant) {
  if (!t) return 'aucune tablette dans la famille';
  return [
    t.ref,
    t.horsLigne ? `hors ligne, dernier signe ${ilYA(t.enLigneLe, maintenant)}` : `en ligne (${ilYA(t.enLigneLe, maintenant)})`,
    t.batterie != null ? `batterie ${t.batterie} %${t.enCharge ? ' sur le chargeur' : ', débranchée'}` : null,
    t.reseau,
    t.dataMoisMo != null ? `${t.dataMoisMo} Mo ce mois` : null,
    t.version ? `version ${t.version}` : null,
  ].filter(Boolean).join(' · ');
}

// ---------- E-mails ----------

function mailEquipe(d, maintenant) {
  const e = mail.echapper;
  const a = d.auteur;
  return {
    ...mail.message(`Déclaration : ${MOTIFS[d.motif].libelle} · ${d.famille || 'famille'}`, [
      { fiche: [
        ['Motif', e(MOTIFS[d.motif].libelle)],
        ['Famille', e(d.famille || d.fid)],
        ['Par', e([a.nom, a.role].filter(Boolean).join(', '))],
        ['E-mail', a.email ? e(a.email) : null],
        ['Téléphone', a.telephone ? e(a.telephone) : null],
        ['Tablette', e(resumeTablette(d.tablette, maintenant))],
        ['Abonnement', d.abonnement ? e(d.abonnement) : null],
        ['Photos', d.photos.length ? `${d.photos.length}, jointe${d.photos.length > 1 ? 's' : ''} à cet e-mail` : 'aucune'],
      ] },
      ...d.reponses.map((r) => `<b>${e(r.question)}</b><br>${e(r.reponse).replace(/\n/g, '<br>')}`),
      d.message ? `<b>Message :</b><br>${e(d.message).replace(/\n/g, '<br>')}` : null,
      d.conversation.length ? 'Avant, dans le chat :' : null,
      ...d.conversation.map((m) => `<b>${m.role === 'user' ? 'Client' : 'Assistant'} :</b> ${e(m.content).replace(/\n/g, '<br>')}`),
      'À traiter dans l\'admin : Clients, onglet Déclarations.',
    ], a.email ? { texte: 'Répondre par e-mail', lien: `mailto:${a.email}` } : null, { interne: true }),
    ...(a.email ? { replyTo: a.email } : {}),
  };
}

function mailAuteur(d) {
  return mail.message('Bien reçu : votre demande à Papote', [
    `Bonjour${d.auteur.prenom ? ` ${mail.echapper(d.auteur.prenom)}` : ''},`,
    `Votre demande « ${mail.echapper(MOTIFS[d.motif].libelle)} » est bien arrivée${d.photos.length ? `, avec ${d.photos.length > 1 ? `vos ${d.photos.length} photos` : 'votre photo'}` : ''}.`,
    `Nous vous répondons ${DELAI_REPONSE}. Si vous avez quelque chose à ajouter, répondez simplement à cet e-mail.`,
  ], null);
}

// ---------- Déclaration ----------

// Garde-fou du jour : par personne et au total. Refus si le compteur ne répond pas (pas d'envoi sans limite).
async function quotaOk(db, uid, maintenant) {
  const jour = new Date(maintenant).toISOString().slice(0, 10);
  const personne = crypto.createHash('sha256').update(`${jour}${uid}`).digest('hex').slice(0, 24);
  const refPersonne = db.doc(`supportQuota/${jour}/declarations/${personne}`);
  const refJour = db.doc(`supportQuota/${jour}`);
  return db.runTransaction(async (t) => {
    const [p, j] = await Promise.all([t.get(refPersonne), t.get(refJour)]);
    const nP = (p.get('n') || 0) + 1;
    const nJ = (j.get('declarations') || 0) + 1;
    if (nP > QUOTA_PERSONNE || nJ > QUOTA_JOUR) return false;
    t.set(refPersonne, { n: nP }, { merge: true });
    t.set(refJour, { declarations: nJ, expire: new Date(maintenant + 7 * JOUR) }, { merge: true });
    return true;
  }).catch((e) => {
    logger.warn('Compteur des déclarations indisponible, demande refusée', e.message);
    return false;
  });
}

// Lecture seule de la famille, de la personne et de la tablette (seulement les champs utiles).
async function lireFamille(db, fid, uid) {
  const [famille, membre, tablettes, fiches] = await Promise.all([
    db.doc(`families/${fid}`).get(),
    db.doc(`families/${fid}/members/${uid}`).get(),
    db.collection(`families/${fid}/members`).where('role', '==', 'tablette').get(),
    db.collection('stock').where('fid', '==', fid).select('ref', 'tabletUid').get(),
  ]);
  const t = tablettes.docs.map((x) => ({ uid: x.id, ...x.data() }))
    .sort((x, y) => (enMillis(y.lastOnline) || 0) - (enMillis(x.lastOnline) || 0))[0] || null;
  const fiche = t && fiches.docs.find((f) => f.get('tabletUid') === t.uid);
  return {
    famille: famille.exists ? famille.data() : {},
    membre: membre.exists ? membre.data() : {},
    tablette: t,
    ref: (fiche && fiche.get('ref')) || (fiches.size === 1 ? fiches.docs[0].get('ref') : null),
  };
}

const ROLES = { proprietaire: 'propriétaire', responsable: 'responsable', membre: 'membre' };
const ABONNEMENTS = { actif: 'actif', impaye: 'paiement en retard', suspendu: 'en pause (impayé)', resilie: 'résilié', aucun: 'aucun', offert: 'offert', installation: 'en installation' };

// Le cœur, sans HTTP : qui = { uid, fid, role } déjà vérifié par quiEcrit (fiche-chat.js, chantier 2 du chat).
async function declarer({ qui, corps, db, stockage, envoyerMail, maintenant = Date.now() }) {
  const d = lireDemande(corps);
  if (d.erreur) return { status: 400, corps: { erreur: d.erreur } };
  const id = idDeclaration(qui.uid, d.cle);
  const ref = db.doc(`declarations/${id}`);
  // Même clé : déjà enregistrée (double appui, nouvel essai après une réponse perdue).
  if ((await ref.get()).exists) return { status: 200, corps: { ok: true, id } };
  if (!(await quotaOk(db, qui.uid, maintenant))) {
    return { status: 429, corps: { erreur: `Vous avez déjà envoyé plusieurs demandes aujourd’hui. Écrivez-nous à ${EMAIL_SUPPORT}.` } };
  }
  const lu = await lireFamille(db, qui.fid, qui.uid);
  const photos = [];
  for (let i = 0; i < d.photos.length; i++) {
    const chemin = `families/${qui.fid}/declarations/${id}/photo-${i + 1}.jpg`;
    await stockage().file(chemin).save(d.photos[i], { contentType: 'image/jpeg', resumable: false, metadata: { metadata: { auteur: qui.uid } } });
    photos.push({ chemin, octets: d.photos[i].length });
  }
  const nom = texte(lu.membre.name || qui.nom, 60);
  const declaration = {
    motif: d.motif,
    libelle: MOTIFS[d.motif].libelle,
    reponses: d.reponses,
    message: d.message,
    conversation: d.conversation,
    photos,
    fid: qui.fid,
    famille: texte(lu.famille.name, 60) || null,
    auteur: {
      uid: qui.uid,
      nom: nom || null,
      prenom: nom ? nom.split(' ')[0] : null,
      email: texte(qui.email || lu.membre.email, 120) || null,
      telephone: texte(lu.membre.telephone, 30) || null,
      role: ROLES[qui.role] || null,
    },
    tablette: etatTablette(lu.tablette, lu.ref, maintenant),
    abonnement: ABONNEMENTS[lu.famille.abonnement && lu.famille.abonnement.statut] || null,
    statut: 'nouvelle',
    creeLe: admin.firestore.Timestamp.fromMillis(maintenant),
  };
  try {
    await ref.create(declaration);
  } catch (e) {
    // Deux appuis arrivés en même temps : le second trouve la déclaration du premier.
    if (e.code === 6 || /already exists/i.test(e.message)) return { status: 200, corps: { ok: true, id } };
    throw e;
  }
  // E-mails : la déclaration est déjà dans l'admin, un e-mail non parti ne perd rien.
  try {
    await envoyerMail(EMAIL_SUPPORT, {
      ...mailEquipe(declaration, maintenant),
      attachments: d.photos.map((p, i) => ({ filename: `photo-${i + 1}.jpg`, content: p, contentType: 'image/jpeg' })),
    });
  } catch (e) {
    logger.error('Déclaration : e-mail à l\'équipe non envoyé (la déclaration est dans l\'admin)', e);
  }
  if (declaration.auteur.email) {
    try {
      await envoyerMail(declaration.auteur.email, mailAuteur(declaration));
    } catch (e) {
      logger.warn('Déclaration : accusé de réception non envoyé', e.message);
    }
  }
  return { status: 200, corps: { ok: true, id } };
}

const stockage = () => admin.storage().bucket(BUCKET_STORAGE);
const envoyeur = () => (a, contenu) => mail.envoyer({
  smtp: MAIL_SMTP.value(), expediteur: MAIL_EXPEDITEUR.value(), motDePasse: MAIL_MOT_DE_PASSE.value(), a, contenu,
});

exports.declarationChat = onRequest(
  { secrets: [MAIL_MOT_DE_PASSE], cors: ORIGINES, maxInstances: 3, timeoutSeconds: 60, memory: '512MiB' },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ erreur: 'POST attendu' });
    try {
      const qui = await require('./fiche-chat').quiEcrit(req, { db: base, verifier: (j) => admin.auth().verifyIdToken(j) });
      if (!qui) return res.status(401).json({ erreur: 'Reconnectez-vous à l’appli, puis recommencez.' });
      const { status, corps } = await declarer({ qui, corps: req.body, db: base(), stockage, envoyerMail: envoyeur() });
      return res.status(status).json(corps);
    } catch (e) {
      logger.error('declarationChat', e);
      return res.status(500).json({ erreur: `Envoi impossible pour le moment. Réessayez dans un instant, ou écrivez-nous à ${EMAIL_SUPPORT}.` });
    }
  });

// ---------- Admin ----------

const enClair = (snap) => {
  const d = snap.data();
  return { id: snap.id, ...d, creeLe: enMillis(d.creeLe), traiteeLe: enMillis(d.traiteeLe) };
};

async function gerer(data, db, store) {
  const action = data && data.action;
  if (action === 'lister') {
    const snap = await db.collection('declarations').orderBy('creeLe', 'desc').limit(100).get();
    return { declarations: snap.docs.map(enClair) };
  }
  if (action === 'photo') {
    const chemin = String((data && data.chemin) || '');
    if (!/^families\/[\w-]{1,128}\/declarations\/[a-f0-9]{24}\/photo-[1-3]\.jpg$/.test(chemin)) throw new HttpsError('invalid-argument', 'Photo inconnue.');
    const [octets] = await store().file(chemin).download();
    return { contenu: octets.toString('base64'), type: 'image/jpeg' };
  }
  if (action === 'traiter') {
    const id = String((data && data.id) || '');
    if (!/^[a-f0-9]{24}$/.test(id)) throw new HttpsError('invalid-argument', 'Déclaration inconnue.');
    const traitee = data.traitee !== false;
    await db.doc(`declarations/${id}`).update(traitee
      ? { statut: 'traitee', traiteeLe: admin.firestore.FieldValue.serverTimestamp() }
      : { statut: 'nouvelle', traiteeLe: admin.firestore.FieldValue.delete() });
    return { ok: true };
  }
  throw new HttpsError('invalid-argument', 'Action inconnue.');
}

exports.gestionDeclarations = onCall({ maxInstances: 2 }, async (request) => {
  if (!request.auth || request.auth.token.admin !== true) throw new HttpsError('permission-denied', 'Réservé à l\'administrateur.');
  return gerer(request.data, base(), stockage);
});

// ---------- Purge (purge.js, le 1er du mois) ----------

async function purgerDeclarations(db, maintenant = Date.now(), store = stockage) {
  const snap = await db.collection('declarations').where('creeLe', '<=', new Date(maintenant - DUREE_MS)).select('fid').get();
  let n = 0;
  for (const doc of snap.docs) {
    try {
      const fid = doc.get('fid');
      if (fid) await store().deleteFiles({ prefix: `families/${fid}/declarations/${doc.id}/`, force: true });
      await doc.ref.delete();
      n++;
    } catch (e) {
      logger.error(`Purge : déclaration ${doc.id} non effacée`, e);
    }
  }
  return n;
}

module.exports.declarer = declarer;
module.exports.purgerDeclarations = purgerDeclarations;
module.exports._test = { lireDemande, photoValide, conversationPropre, etatTablette, resumeTablette, idDeclaration, mailEquipe, mailAuteur, gerer, MOTIFS, MAX_PHOTOS, QUOTA_PERSONNE };
