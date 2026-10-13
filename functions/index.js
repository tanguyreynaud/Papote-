// Fonctions serveur de Papote : abonnements et paiements Stripe.
//
//   commander          GET  depuis le site vitrine : ouvre la page de paiement Stripe
//   creerPaiement      appel depuis l'appli famille : paiement pour une famille existante
//   portailClient      appel depuis l'appli famille : carte bancaire, factures
//   resilierAbonnement appel depuis l'appli famille : résilie à la fin de l'engagement de 12 mois
//   annulerResiliation appel depuis l'appli famille : garde l'abonnement
//   rattacherCommande  appel depuis l'appli famille : relie une commande du site à la famille
//                      (par l'e-mail du compte, ou par le code de commande XXXX-XXXX)
//   codeCommande       GET depuis merci.html : code de commande à noter après le paiement
//   stripeWebhook      Stripe prévient ici de chaque paiement ou changement d'abonnement
//   finDeGrace         chaque heure : suspend les familles dont le délai de grâce est dépassé
//   retracter          appel depuis l'appli famille : annule la commande (14 jours), remboursée au retour
//   finDeContrat       appel depuis l'appli famille : rétractation possible, retour attendu, remboursement
//   restitutions       chaque jour : rappel 7 jours avant, puis 120 € si la tablette n'est pas rendue à temps
//   tabletteRendue     appel depuis le tableau de bord admin : la tablette incluse est revenue
//   etiquetteRetour    appel depuis le tableau de bord admin : lien de l'étiquette de retour prépayée
//   nouvelleFamille    famille créée : sans commande, statut « aucun »
//   nouveauMembre      créateur d'une famille : rattache sa commande faite sur le site
//   tabletteEnvoyee    appel depuis le tableau de bord admin : colis parti, numéro de suivi Mondial Relay
//   commandeModifiee   commande modifiée : e-mail d'envoi, de retour, d'étiquette ; remboursement au retour
//   rappelsJumelage    chaque jour : rappel au client dont la tablette n'est pas jumelée (J+5, J+12)
//   gestion*           page de gestion admin : stock, commandes, factures, comptabilité (gestion.js)
//
// État écrit sur families/{fid}.abonnement (voir abonnement.js), avec rev + 1 pour que la
// tablette relise la famille. Commandes : commandes/{id de l'abonnement Stripe}.
// Clés Stripe dans Secret Manager (outils/stripe/installer-stripe.bat), jamais dans le dépôt.

const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { setGlobalOptions, logger } = require('firebase-functions/v2');
const { defineSecret, defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const Stripe = require('stripe');
const regles = require('./abonnement');
const livraison = require('./livraison');
const mail = require('./mail');

admin.initializeApp();
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

setGlobalOptions({ region: 'europe-west1', maxInstances: 5 });

const STRIPE_SECRET = defineSecret('STRIPE_SECRET');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
const SITE_VITRINE = defineString('SITE_VITRINE', { default: 'https://mapapote.fr' });
const APPLI_FAMILLE = 'https://papote-famille.web.app/';
// E-mails : MAIL_SMTP (« hote:port:utilisateur ») et MAIL_EXPEDITEUR dans .env, mot de passe en secret.
const MAIL_SMTP = defineString('MAIL_SMTP', { default: 'smtp.gmail.com:465:' });
const MAIL_EXPEDITEUR = defineString('MAIL_EXPEDITEUR', { default: '' });
const MAIL_MOT_DE_PASSE = defineSecret('MAIL_MOT_DE_PASSE');

function envoyerMail(a, contenu) {
  return mail.envoyer({
    smtp: MAIL_SMTP.value(), expediteur: MAIL_EXPEDITEUR.value(),
    motDePasse: MAIL_MOT_DE_PASSE.value(), a, contenu,
  });
}

let stripeClient;
function stripe() {
  if (!stripeClient) stripeClient = new Stripe(STRIPE_SECRET.value());
  return stripeClient;
}

// ---------- Outils ----------

function versTimestamp(millis) {
  return millis == null ? null : Timestamp.fromMillis(millis);
}

function finDePeriodeMs(abo) {
  const fin = abo.current_period_end
    || (abo.items && abo.items.data[0] && abo.items.data[0].current_period_end);
  return fin ? fin * 1000 : null;
}

// Engagement de 12 mois à partir de la fin de l'essai (ou du début de l'abonnement).
function finEngagementMs(abo) {
  return regles.finEngagement((abo.trial_end || abo.start_date) * 1000);
}

async function tarifs(formule, tablette) {
  const cles = [regles.TARIFS[formule][tablette]];
  if (tablette === 'achetee') cles.push(regles.TARIF_TABLETTE);
  if (tablette === 'incluse') cles.push(regles.TARIF_MISE_EN_SERVICE);
  const { data } = await stripe().prices.list({ lookup_keys: cles, active: true });
  const parCle = Object.fromEntries(data.map((p) => [p.lookup_key, p.id]));
  for (const cle of cles) {
    if (!parCle[cle]) throw new Error(`Tarif Stripe introuvable : ${cle}`);
  }
  return cles.map((cle) => ({ price: parCle[cle], quantity: 1 }));
}

// Essai gratuit de 15 jours pour un nouveau client ; pas pour un client déjà abonné une fois.
async function sessionPaiement({ formule, tablette, fid, email, client, relais }) {
  const metadata = { formule, tablette, ...(relais ? livraison.relaisVersMeta(relais) : {}) };
  if (fid) metadata.fid = fid;
  const subscriptionData = { metadata };
  if (!client) {
    subscriptionData.trial_period_days = regles.ESSAI_JOURS;
    subscriptionData.trial_settings = { end_behavior: { missing_payment_method: 'cancel' } };
  }
  const params = {
    mode: 'subscription',
    line_items: await tarifs(formule, tablette),
    locale: 'fr',
    // Carte bancaire (Google Pay et Apple Pay compris) et Link, choisi par Tanguy le 2026-10-13. Pas de code promo.
    payment_method_types: ['card', 'link'],
    billing_address_collection: 'auto',
    phone_number_collection: { enabled: true },
    metadata,
    subscription_data: subscriptionData,
    payment_method_collection: 'always',
    success_url: fid ? `${APPLI_FAMILLE}?abonnement=ok`
      : `${SITE_VITRINE.value()}/merci.html?session={CHECKOUT_SESSION_ID}`,
    cancel_url: fid ? APPLI_FAMILLE : `${SITE_VITRINE.value()}/commande.html?formule=${formule}`,
  };
  // Commande du site : livrée au point relais choisi avant le paiement. Depuis l'appli : à l'adresse saisie.
  if (!relais) params.shipping_address_collection = { allowed_countries: ['FR', 'BE', 'LU'] };
  if (client) params.customer = client;
  else if (email) params.customer_email = email;
  return stripe().checkout.sessions.create(params);
}

// Réglages du portail client créés par outils/stripe/installer-stripe.js (metadata papote=1).
let portail;
async function configurationPortail() {
  if (!portail) {
    const { data } = await stripe().billingPortal.configurations.list({ active: true, limit: 20 });
    const conf = data.find((c) => c.metadata && c.metadata.papote === '1');
    portail = conf ? conf.id : undefined;
  }
  return portail;
}

// Responsable de la famille : créateur ou désigné dans admins.
async function familleDuResponsable(fid, uid) {
  if (typeof fid !== 'string' || !fid) throw new HttpsError('invalid-argument', 'Famille manquante.');
  const snap = await db.doc(`families/${fid}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Famille introuvable.');
  const fam = snap.data();
  if (fam.createdBy !== uid && !(fam.admins || []).includes(uid)) {
    throw new HttpsError('permission-denied', 'Réservé aux responsables de la famille.');
  }
  return fam;
}

// Résiliation et annulation : les responsables de la famille, ou l'administrateur de Papote (badge admin).
async function familleGeree(fid, request) {
  const { uid } = compteVerifie(request);
  if (request.auth.token.admin === true) {
    if (typeof fid !== 'string' || !fid) throw new HttpsError('invalid-argument', 'Famille manquante.');
    const snap = await db.doc(`families/${fid}`).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Famille introuvable.');
    return snap.data();
  }
  return familleDuResponsable(fid, uid);
}

function compteVerifie(request) {
  const token = request.auth && request.auth.token;
  if (!token || !token.email || !token.email_verified
    || (token.firebase && token.firebase.sign_in_provider === 'anonymous')) {
    throw new HttpsError('unauthenticated', 'Connectez-vous avec Google ou votre e-mail.');
  }
  return { uid: request.auth.uid, email: token.email.toLowerCase() };
}

// Applique l'abonnement Stripe à la famille. Relit toujours l'abonnement chez Stripe,
// pour ne jamais appliquer un événement ancien arrivé en retard.
async function appliquer(fid, abonnementId) {
  const abo = await stripe().subscriptions.retrieve(abonnementId);
  const ref = db.doc(`families/${fid}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const actuel = snap.data().abonnement;
    if (!regles.peutModifier(actuel)) {
      logger.info(`Famille ${fid} offerte : abonnement ${abonnementId} ignoré.`);
      return;
    }
    const { statut, graceJusqua } = regles.statutDepuisStripe(abo.status, actuel, Date.now());
    tx.update(ref, {
      abonnement: {
        statut,
        formule: abo.metadata.formule || null,
        tablette: abo.metadata.tablette || null,
        graceJusqua: versTimestamp(graceJusqua),
        finPeriode: versTimestamp(finDePeriodeMs(abo)),
        essaiJusqua: versTimestamp(abo.status === 'trialing' && abo.trial_end ? abo.trial_end * 1000 : null),
        engagementJusqua: versTimestamp(finEngagementMs(abo)),
        resiliationLe: versTimestamp(abo.cancel_at ? abo.cancel_at * 1000
          : (abo.cancel_at_period_end ? finDePeriodeMs(abo) : null)),
        stripeCustomerId: abo.customer,
        stripeSubscriptionId: abo.id,
        majLe: FieldValue.serverTimestamp(),
      },
      rev: FieldValue.increment(1),
    });
  });
  await db.doc(`commandes/${abo.id}`).set({ fid, statutStripe: abo.status }, { merge: true });
  await attendreRestitution(abo);
  if (abo.metadata.fid !== fid) {
    await stripe().subscriptions.update(abo.id, { metadata: { ...abo.metadata, fid } });
  }
}

// Fin d'un abonnement avec tablette incluse : la tablette est attendue sous 30 jours.
async function attendreRestitution(abo) {
  if (abo.status !== 'canceled' || abo.metadata.tablette !== 'incluse') return;
  const ref = db.doc(`commandes/${abo.id}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    // Rien à rendre si la tablette n'est jamais partie.
    if (snap.exists && (snap.get('restitution') || ['a-preparer', 'annulee'].includes(snap.get('expedition')))) return;
    const fin = (abo.ended_at || abo.canceled_at || Math.floor(Date.now() / 1000)) * 1000;
    tx.set(ref, {
      restitution: { statut: 'attendue', avant: versTimestamp(regles.limiteRestitution(fin)) },
    }, { merge: true });
  });
}

// Familles dont ce compte est responsable et qui n'ont pas d'abonnement en cours.
async function famillesSansAbonnement(uid) {
  const membres = await db.collectionGroup('members').where('uid', '==', uid).get();
  const fids = [...new Set(membres.docs.map((m) => m.ref.parent.parent.id))];
  const libres = [];
  for (const fid of fids) {
    const snap = await db.doc(`families/${fid}`).get();
    if (!snap.exists) continue;
    const fam = snap.data();
    const responsable = fam.createdBy === uid || (fam.admins || []).includes(uid);
    const statut = fam.abonnement && fam.abonnement.statut;
    if (responsable && ['aucun', 'resilie', 'suspendu'].includes(statut)) libres.push(fid);
  }
  return libres;
}

// Commande faite sur le site : retrouve la famille du client par son e-mail, s'il n'y en a qu'une.
async function chercherFamille(email) {
  try {
    const user = await admin.auth().getUserByEmail(email);
    const libres = await famillesSansAbonnement(user.uid);
    return libres.length === 1 ? libres[0] : null;
  } catch (e) {
    if (e.code === 'auth/user-not-found') return null;
    throw e;
  }
}

// ---------- Site vitrine ----------

exports.commander = onRequest({ secrets: [STRIPE_SECRET] }, async (req, res) => {
  const { formule, tablette } = req.query;
  if (!regles.formuleValide(formule, tablette)) {
    res.redirect(303, `${SITE_VITRINE.value()}/#tarifs`);
    return;
  }
  // Sans point relais, retour à la page de choix du point relais.
  const relais = livraison.relaisDepuisRequete(req.query);
  if (!relais) {
    res.redirect(303, `${SITE_VITRINE.value()}/commande.html?formule=${formule}&tablette=${tablette}`);
    return;
  }
  try {
    const session = await sessionPaiement({ formule, tablette, relais });
    res.redirect(303, session.url);
  } catch (e) {
    logger.error('commander', e);
    res.status(500).send("Le paiement n'a pas pu s'ouvrir. Réessayez dans un instant.");
  }
});

// ---------- Appli famille ----------

exports.creerPaiement = onCall({ secrets: [STRIPE_SECRET] }, async (request) => {
  const { uid, email } = compteVerifie(request);
  const { fid, formule, tablette } = request.data || {};
  if (!regles.formuleValide(formule, tablette)) throw new HttpsError('invalid-argument', 'Formule inconnue.');
  const fam = await familleDuResponsable(fid, uid);
  if (fam.abonnement && ['actif', 'impaye', 'offert'].includes(fam.abonnement.statut)) {
    throw new HttpsError('failed-precondition', 'Cette famille a déjà un abonnement.');
  }
  const client = fam.abonnement && fam.abonnement.stripeCustomerId;
  const session = await sessionPaiement({ formule, tablette, fid, email, client });
  return { url: session.url };
});

exports.portailClient = onCall({ secrets: [STRIPE_SECRET] }, async (request) => {
  const { uid } = compteVerifie(request);
  const fam = await familleDuResponsable((request.data || {}).fid, uid);
  const client = fam.abonnement && fam.abonnement.stripeCustomerId;
  if (!client) throw new HttpsError('failed-precondition', "Cette famille n'a pas encore d'abonnement.");
  const session = await stripe().billingPortal.sessions.create({
    customer: client,
    configuration: await configurationPortail(),
    return_url: APPLI_FAMILLE,
    locale: 'fr',
  });
  return { url: session.url };
});

// Résiliation en ligne : l'abonnement s'arrête à la fin de l'engagement, ou à la fin du mois
// déjà payé si l'engagement est terminé. Pendant l'essai gratuit : arrêt à la fin de l'essai.
exports.resilierAbonnement = onCall({ secrets: [STRIPE_SECRET] }, async (request) => {
  const { fid } = request.data || {};
  const fam = await familleGeree(fid, request);
  const id = fam.abonnement && fam.abonnement.stripeSubscriptionId;
  if (!id) throw new HttpsError('failed-precondition', "Cette famille n'a pas d'abonnement.");
  const abo = await stripe().subscriptions.retrieve(id);
  const maintenant = Date.now();
  const le = abo.status === 'trialing' && abo.trial_end
    ? abo.trial_end * 1000
    : regles.dateResiliation(finEngagementMs(abo), finDePeriodeMs(abo), maintenant);
  await stripe().subscriptions.update(id, {
    cancel_at: Math.ceil(le / 1000),
    proration_behavior: 'none',
  });
  await appliquer(fid, id);
  return { le };
});

exports.annulerResiliation = onCall({ secrets: [STRIPE_SECRET] }, async (request) => {
  const { fid } = request.data || {};
  const fam = await familleGeree(fid, request);
  const id = fam.abonnement && fam.abonnement.stripeSubscriptionId;
  if (!id) throw new HttpsError('failed-precondition', "Cette famille n'a pas d'abonnement.");
  await stripe().subscriptions.update(id, { cancel_at: '' });
  await appliquer(fid, id);
  return { ok: true };
});

// ---------- Rétractation et fin de contrat ----------

// Factures payées de l'abonnement (mise en service de 50 €, mois déjà prélevés).
async function facturesPayees(abonnementId) {
  const { data } = await stripe().invoices.list({ subscription: abonnementId, status: 'paid', limit: 100 });
  return data.filter((f) => f.amount_paid > 0 && f.payment_intent);
}

async function montantPaye(abonnementId) {
  return (await facturesPayees(abonnementId)).reduce((t, f) => t + f.amount_paid, 0);
}

// Rembourse tout ce qui a été payé pour cet abonnement. Rejouable sans double remboursement.
async function rembourser(abonnementId) {
  let total = 0;
  for (const f of await facturesPayees(abonnementId)) {
    const pi = typeof f.payment_intent === 'string' ? f.payment_intent : f.payment_intent.id;
    const r = await stripe().refunds.create({
      payment_intent: pi, reason: 'requested_by_customer', metadata: { commande: abonnementId },
    }, { idempotencyKey: `retractation-${f.id}` });
    total += r.amount;
  }
  return total;
}

async function commandeDeLaFamille(fid, request) {
  const fam = await familleGeree(fid, request);
  const id = fam.abonnement && fam.abonnement.stripeSubscriptionId;
  if (!id) throw new HttpsError('failed-precondition', "Cette famille n'a pas d'abonnement.");
  const ref = db.doc(`commandes/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Commande introuvable.');
  return { id, ref, snap };
}

// Annulation dans les 14 jours : l'abonnement s'arrête tout de suite. Tablette pas encore partie :
// remboursement immédiat. Déjà partie : remboursement dès son retour (voir commandeModifiee).
exports.retracter = onCall({ secrets: [STRIPE_SECRET, MAIL_MOT_DE_PASSE] }, async (request) => {
  const { fid } = request.data || {};
  const { id, ref } = await commandeDeLaFamille(fid, request);
  const montant = await montantPaye(id);
  const maintenant = Date.now();
  const partie = await db.runTransaction(async (tx) => {
    const c = (await tx.get(ref)).data();
    if (!regles.retractationPossible(c, maintenant)) {
      throw new HttpsError('failed-precondition', 'Le délai de 14 jours pour annuler la commande est dépassé.');
    }
    const envoyee = c.expedition !== 'a-preparer';
    tx.update(ref, envoyee ? {
      retractation: { le: Timestamp.fromMillis(maintenant), montant },
      remboursement: { statut: 'au-retour', montant },
      restitution: { statut: 'attendue', motif: 'retractation', avant: versTimestamp(regles.limiteRestitution(maintenant)) },
    } : {
      retractation: { le: Timestamp.fromMillis(maintenant), montant },
      expedition: 'annulee',
      remboursement: { statut: 'en-cours', montant },
    });
    return envoyee;
  });
  const abo = await stripe().subscriptions.retrieve(id);
  if (abo.status !== 'canceled') await stripe().subscriptions.cancel(id, { prorate: false, invoice_now: false });
  await appliquer(fid, id);
  if (partie) return { ok: true, remboursement: 'au-retour', montant };

  const c = (await ref.get()).data();
  try {
    const rembourse = await rembourser(id);
    await ref.update({ remboursement: { statut: 'fait', montant: rembourse, le: FieldValue.serverTimestamp() } });
    const envois = [envoyerMail(EMAIL_PAPOTE, mail.annulationAvantEnvoi({
      nom: c.nom, email: c.email, code: c.code ? regles.afficherCode(c.code) : null,
    }))];
    if (c.email) envois.push(envoyerMail(c.email, mail.commandeAnnulee({ nom: c.nom, rembourse })));
    (await Promise.allSettled(envois)).filter((r) => r.status === 'rejected')
      .forEach((r) => logger.error(`Commande ${id} : e-mail d'annulation non parti`, r.reason));
    return { ok: true, remboursement: 'fait', montant: rembourse };
  } catch (e) {
    logger.error(`Commande ${id} : remboursement refusé`, e.message);
    await ref.update({ 'remboursement.statut': 'echec', 'remboursement.erreur': e.message });
    throw new HttpsError('internal', 'La commande est annulée, mais le remboursement a échoué : nous le faisons à la main.');
  }
});

// Ce que l'appli affiche dans Abonnement : annulation possible, tablette à rendre, remboursement.
exports.finDeContrat = onCall({ secrets: [STRIPE_SECRET] }, async (request) => {
  const { id, snap } = await commandeDeLaFamille((request.data || {}).fid, request);
  const c = snap.data();
  const ms = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : null);
  const possible = regles.retractationPossible(c, Date.now());
  const r = c.restitution;
  return {
    retractation: possible ? {
      jusqua: c.expedition === 'a-preparer' ? null : regles.limiteRetractation(ms(c.creeLe), ms(c.envoyeeLe)),
      montant: await montantPaye(id),
    } : null,
    restitution: r ? { statut: r.statut, avant: ms(r.avant), etiquette: r.etiquette || null } : null,
    remboursement: c.remboursement ? { statut: c.remboursement.statut, montant: c.remboursement.montant || 0 } : null,
  };
});

// Code de commande d'un abonnement : créé une seule fois, à la première demande.
async function codeDe(abonnementId) {
  const ref = db.doc(`commandes/${abonnementId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists && snap.get('code')) return snap.get('code');
    let code;
    do {
      code = regles.nouveauCode();
    } while (!(await tx.get(db.collection('commandes').where('code', '==', code).limit(1))).empty);
    tx.set(ref, { code }, { merge: true });
    return code;
  });
}

exports.codeCommande = onRequest({ secrets: [STRIPE_SECRET], cors: true }, async (req, res) => {
  const session = String(req.query.session || '');
  if (!/^cs_[A-Za-z0-9_]+$/.test(session)) {
    res.status(400).json({ erreur: 'Paiement inconnu' });
    return;
  }
  try {
    const s = await stripe().checkout.sessions.retrieve(session);
    if (s.status !== 'complete' || !s.subscription) {
      res.status(404).json({ erreur: 'Paiement inconnu' });
      return;
    }
    // Récapitulatif à imprimer sur merci.html (seul celui qui a payé connaît l'identifiant du paiement).
    const meta = s.metadata || {};
    const details = s.customer_details || {};
    res.json({
      code: regles.afficherCode(await codeDe(s.subscription)),
      date: s.created,
      nom: details.name || null,
      email: details.email || s.customer_email || null,
      formule: meta.formule || null,
      payeCentimes: s.amount_total,
      relais: livraison.relaisDepuisMeta(meta),
    });
  } catch (e) {
    logger.warn('codeCommande', e.message);
    res.status(404).json({ erreur: 'Paiement inconnu' });
  }
});

exports.rattacherCommande = onCall({ secrets: [STRIPE_SECRET] }, async (request) => {
  const { uid, email } = compteVerifie(request);
  const { fid, code: saisie } = request.data || {};
  const fam = await familleDuResponsable(fid, uid);
  if (fam.abonnement && ['actif', 'impaye', 'offert'].includes(fam.abonnement.statut)) {
    throw new HttpsError('failed-precondition', 'Cette famille a déjà un abonnement.');
  }
  let commandes;
  if (saisie) {
    const code = regles.normaliserCode(saisie);
    if (!code) throw new HttpsError('invalid-argument', 'Ce code de commande ne ressemble pas à XXXX-XXXX.');
    commandes = await db.collection('commandes').where('code', '==', code).where('fid', '==', null).get();
    if (commandes.empty) throw new HttpsError('not-found', 'Aucune commande en attente avec ce code.');
  } else {
    commandes = await db.collection('commandes')
      .where('email', '==', email).where('fid', '==', null).get();
    if (commandes.empty) {
      throw new HttpsError('not-found', `Aucune commande en attente pour ${email}.`);
    }
  }
  const plusRecente = commandes.docs
    .sort((a, b) => (b.get('creeLe')?.toMillis() || 0) - (a.get('creeLe')?.toMillis() || 0))[0];
  await appliquer(fid, plusRecente.id);
  return { ok: true };
});

// ---------- Stripe ----------

exports.stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET, STRIPE_WEBHOOK_SECRET, MAIL_MOT_DE_PASSE] },
  async (req, res) => {
    let event;
    try {
      event = stripe().webhooks.constructEvent(
        req.rawBody, req.get('stripe-signature'), STRIPE_WEBHOOK_SECRET.value());
    } catch (e) {
      logger.warn('Signature Stripe refusée', e.message);
      res.status(400).send('Signature invalide');
      return;
    }

    try {
      if (event.type === 'checkout.session.completed') {
        await paiementTermine(event.data.object);
      } else if (event.type.startsWith('customer.subscription.')) {
        await abonnementModifie(event.data.object);
      }
      res.json({ recu: true });
    } catch (e) {
      // Stripe renverra l'événement plus tard.
      logger.error(`Événement ${event.type} ${event.id}`, e);
      res.status(500).send('Erreur');
    }
  });

async function paiementTermine(session) {
  if (!session.subscription) return;
  const details = session.customer_details || {};
  const adresse = (session.collected_information && session.collected_information.shipping_details)
    || session.shipping_details || null;
  const email = (details.email || session.customer_email || '').toLowerCase();
  const meta = session.metadata || {};
  const ref = db.doc(`commandes/${session.subscription}`);
  const existante = await ref.get();
  // La commande peut déjà exister avec son seul code, si merci.html l'a demandé avant ce message.
  if (!existante.exists || !existante.get('email')) {
    await ref.set({
      email,
      nom: details.name || null,
      telephone: details.phone || null,
      formule: meta.formule || null,
      tablette: meta.tablette || null,
      livraison: livraison.relaisDepuisMeta(meta)
        || (adresse ? { nom: adresse.name || null, adresse: adresse.address || null } : null),
      // Tablette à préparer et envoyer par Tanguy (« envoyee » une fois partie).
      expedition: 'a-preparer',
      stripeCustomerId: session.customer,
      fid: (existante.exists && existante.get('fid')) || null,
      creeLe: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  // Le code figure aussi sur les factures Stripe du client.
  const code = regles.afficherCode(await codeDe(session.subscription));
  await stripe().customers.update(session.customer, {
    invoice_settings: { custom_fields: [{ name: 'Code de commande Papote', value: code }] },
  });
  const fid = meta.fid || (existante.exists && existante.get('fid')) || await chercherFamille(email);
  if (fid) await appliquer(fid, session.subscription);
  await confirmerCommande(ref, email, code);
}

// E-mails « commande confirmée » au client et « nouvelle commande » à Papote, une seule fois
// (Stripe peut renvoyer le même événement). Un échec d'envoi ne fait pas échouer le paiement.
const EMAIL_PAPOTE = 'contact@mapapote.fr';
async function confirmerCommande(ref, email, code) {
  const premier = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (snap.get('mailConfirmation')) return null;
    t.update(ref, { mailConfirmation: FieldValue.serverTimestamp() });
    return snap.data();
  });
  if (!premier) return;
  await compterEtape('paye').catch((e) => logger.warn('Statistiques', e.message));
  const infos = { nom: premier.nom, code, relais: premier.livraison, formule: premier.formule };
  const envois = [envoyerMail(EMAIL_PAPOTE, mail.nouvelleCommande({ ...infos, email, telephone: premier.telephone }))];
  if (email) envois.push(envoyerMail(email, mail.commandeConfirmee(infos)));
  const resultats = await Promise.allSettled(envois);
  resultats.filter((r) => r.status === 'rejected')
    .forEach((r) => logger.error(`E-mail de commande non envoyé (${ref.id})`, r.reason));
}

async function abonnementModifie(abo) {
  const commande = await db.doc(`commandes/${abo.id}`).get();
  const fid = (abo.metadata && abo.metadata.fid) || (commande.exists && commande.get('fid'));
  if (fid) await appliquer(fid, abo.id);
  else if (commande.exists) await commande.ref.update({ statutStripe: abo.status });
}

// ---------- Statistiques de visite (sans cookie ni donnée personnelle) ----------
// Un compteur par jour dans statistiques/{AAAA-MM-JJ} : accueil, commande (page ouverte),
// relais (point choisi), paiement (clic sur Payer), paye (paiement reçu).
// Lecture : outils/admin/statistiques.bat.
const ETAPES = ['accueil', 'commande', 'relais', 'paiement'];
function compterEtape(etape) {
  const jour = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  return db.doc(`statistiques/${jour}`).set({ [etape]: FieldValue.increment(1) }, { merge: true });
}

exports.compter = onRequest({ cors: true, maxInstances: 2 }, async (req, res) => {
  const etape = String(req.query.e || '');
  if (!ETAPES.includes(etape)) {
    res.status(400).end();
    return;
  }
  await compterEtape(etape);
  res.status(204).end();
});

// ---------- Tâches automatiques ----------

exports.finDeGrace = onSchedule(
  { schedule: 'every 1 hours', timeZone: 'Europe/Paris' },
  async () => {
    const maintenant = Date.now();
    const impayes = await db.collection('families').where('abonnement.statut', '==', 'impaye').get();
    for (const snap of impayes.docs) {
      if (!regles.graceDepassee(snap.get('abonnement'), maintenant)) continue;
      await snap.ref.update({
        'abonnement.statut': 'suspendu',
        'abonnement.majLe': FieldValue.serverTimestamp(),
        rev: FieldValue.increment(1),
      });
      logger.info(`Famille ${snap.id} suspendue : délai de grâce dépassé.`);
    }
  });

// Tablette incluse non rendue dans les 30 jours : 120 € prélevés sur la carte de l'abonnement.
exports.restitutions = onSchedule(
  { schedule: 'every day 09:00', timeZone: 'Europe/Paris', secrets: [STRIPE_SECRET, MAIL_MOT_DE_PASSE] },
  async () => {
    const maintenant = Date.now();
    const attendues = await db.collection('commandes').where('restitution.statut', '==', 'attendue').get();
    for (const snap of attendues.docs) {
      const r = snap.get('restitution');
      if (regles.rappelRestitutionDu(r, maintenant) && snap.get('email')) {
        try {
          await envoyerMail(snap.get('email'), mail.rappelRestitution({
            nom: snap.get('nom'), avant: r.avant.toMillis(), lien: r.etiquette || null,
          }));
          await snap.ref.update({ 'restitution.rappelLe': FieldValue.serverTimestamp() });
        } catch (e) {
          logger.error(`Commande ${snap.id} : rappel de retour non parti`, e.message);
        }
      }
      if (!regles.restitutionEchue(snap.get('restitution'), maintenant)) continue;
      try {
        const abo = await stripe().subscriptions.retrieve(snap.id, { expand: ['customer'] });
        const moyen = abo.default_payment_method
          || (abo.customer.invoice_settings && abo.customer.invoice_settings.default_payment_method);
        if (!moyen) throw new Error('Aucune carte enregistrée');
        const paiement = await stripe().paymentIntents.create({
          amount: regles.PENALITE_NON_RESTITUTION,
          currency: 'eur',
          customer: abo.customer.id,
          payment_method: typeof moyen === 'string' ? moyen : moyen.id,
          off_session: true,
          confirm: true,
          description: 'Papote : tablette non rendue',
          metadata: { commande: snap.id },
        }, { idempotencyKey: `restitution-${snap.id}` });
        await snap.ref.update({
          'restitution.statut': 'facturee',
          'restitution.paiement': paiement.id,
          'restitution.majLe': FieldValue.serverTimestamp(),
        });
        logger.info(`Commande ${snap.id} : tablette non rendue, 120 € prélevés.`);
      } catch (e) {
        // Carte expirée ou refusée : à relancer à la main, depuis le tableau de bord Stripe.
        await snap.ref.update({
          'restitution.statut': 'echec',
          'restitution.erreur': e.message,
          'restitution.majLe': FieldValue.serverTimestamp(),
        });
        logger.warn(`Commande ${snap.id} : prélèvement de la tablette non rendue refusé`, e.message);
      }
    }
  });

// Le tableau de bord admin marque la tablette incluse comme revenue.
// Même règle que isAdmin() des règles Firestore : badge admin, ou l'adresse de Tanguy le temps du badge.
function verifierAdmin(request) {
  const token = request.auth && request.auth.token;
  const estAdmin = token && (token.admin === true
    || (token.email === 'tanguyreynaud22@gmail.com' && token.email_verified === true));
  if (!estAdmin) throw new HttpsError('permission-denied', 'Réservé à l\'administrateur.');
}

exports.tabletteRendue = onCall(async (request) => {
  verifierAdmin(request);
  const { commande } = request.data || {};
  if (typeof commande !== 'string' || !commande) throw new HttpsError('invalid-argument', 'Commande manquante.');
  const ref = db.doc(`commandes/${commande}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Commande introuvable.');
  if (snap.get('restitution.statut') === 'facturee') {
    throw new HttpsError('failed-precondition', 'Les 120 € ont déjà été prélevés : remboursez-les depuis Stripe.');
  }
  await ref.set({
    restitution: { statut: 'rendue', majLe: FieldValue.serverTimestamp() },
  }, { merge: true });
  return { ok: true };
});

// Lien de l'étiquette de retour prépayée (Mondial Relay, Sendcloud...) : envoyé au client par commandeModifiee.
exports.etiquetteRetour = onCall(async (request) => {
  verifierAdmin(request);
  const { commande, lien } = request.data || {};
  if (typeof commande !== 'string' || !commande) throw new HttpsError('invalid-argument', 'Commande manquante.');
  if (typeof lien !== 'string' || !/^https:\/\/\S{4,500}$/.test(lien.trim())) {
    throw new HttpsError('invalid-argument', 'Le lien doit commencer par https://');
  }
  const ref = db.doc(`commandes/${commande}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Commande introuvable.');
  if (!['attendue', 'echec'].includes(snap.get('restitution.statut'))) {
    throw new HttpsError('failed-precondition', "Aucune tablette n'est attendue pour cette commande.");
  }
  await ref.update({ 'restitution.etiquette': lien.trim(), 'restitution.etiquetteLe': FieldValue.serverTimestamp() });
  return { ok: true };
});

// Les déclencheurs Firestore doivent tourner dans la région de la base (REGION_FIRESTORE dans .env).
const REGION_FIRESTORE = process.env.REGION_FIRESTORE || 'europe-west1';

exports.nouvelleFamille = onDocumentCreated({ document: 'families/{fid}', region: REGION_FIRESTORE }, async (event) => {
  const ref = event.data.ref;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('abonnement')) return;
    tx.update(ref, {
      abonnement: { statut: 'aucun', majLe: FieldValue.serverTimestamp() },
    });
  });
});

exports.nouveauMembre = onDocumentCreated(
  { document: 'families/{fid}/members/{uid}', region: REGION_FIRESTORE, secrets: [STRIPE_SECRET] },
  async (event) => {
    const membre = event.data.data();
    const { fid, uid } = event.params;
    if (membre.role !== 'famille' || !membre.email) return;
    const fam = await db.doc(`families/${fid}`).get();
    if (!fam.exists || fam.get('createdBy') !== uid) return;
    const commandes = await db.collection('commandes')
      .where('email', '==', membre.email.toLowerCase()).where('fid', '==', null).limit(1).get();
    if (commandes.empty) return;
    await appliquer(fid, commandes.docs[0].id);
  });

// ---------- Envoi de la tablette ----------

// Le tableau de bord admin note le départ du colis : { commande, suivi } (numéro Mondial Relay).
// Corriger un numéro déjà saisi renvoie l'e-mail avec le bon lien.
exports.tabletteEnvoyee = onCall(async (request) => {
  verifierAdmin(request);
  const { commande } = request.data || {};
  const suivi = livraison.normaliserSuivi((request.data || {}).suivi);
  if (typeof commande !== 'string' || !commande) throw new HttpsError('invalid-argument', 'Commande manquante.');
  if (!suivi) throw new HttpsError('invalid-argument', 'Numéro de suivi invalide.');
  const ref = db.doc(`commandes/${commande}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Commande introuvable.');
  await ref.update({
    expedition: 'envoyee',
    suivi,
    envoyeeLe: snap.get('envoyeeLe') || FieldValue.serverTimestamp(),
    rappels: snap.get('rappels') || 0,
  });
  return { ok: true, lien: livraison.lienSuivi(suivi, snap.get('livraison.cp')) };
});

// Colis parti (ou numéro corrigé) : e-mail au client avec le lien de suivi.
// Écrit par tabletteEnvoyee ou par outils/admin/abonnements.bat envoyee.
// Aussi : tablette attendue (e-mails de retour), étiquette ajoutée, tablette revenue (remboursement).
exports.commandeModifiee = onDocumentUpdated(
  { document: 'commandes/{id}', region: REGION_FIRESTORE, secrets: [MAIL_MOT_DE_PASSE, STRIPE_SECRET] },
  async (event) => {
    const avant = event.data.before.data();
    const apres = event.data.after.data();
    await mailEnvoi(event, avant, apres);
    await suiviRetour(event, avant.restitution || {}, apres.restitution || {}, apres);
  });

async function mailEnvoi(event, avant, apres) {
  if (apres.expedition !== 'envoyee' || !apres.suivi || !apres.email) return;
  if (avant.expedition === 'envoyee' && avant.suivi === apres.suivi) return;
  const relais = apres.livraison && apres.livraison.transporteur ? apres.livraison : null;
  const code = apres.code ? regles.afficherCode(apres.code) : null;
  try {
    await envoyerMail(apres.email, mail.colisParti({
      nom: apres.nom, suivi: apres.suivi, relais, code,
      lien: livraison.lienSuivi(apres.suivi, relais && relais.cp),
    }));
    await event.data.after.ref.update({ mailEnvoiLe: FieldValue.serverTimestamp(), mailErreur: FieldValue.delete() });
  } catch (e) {
    logger.error(`Commande ${event.params.id} : e-mail d'envoi non parti`, e.message);
    await event.data.after.ref.update({ mailErreur: e.message });
  }
}

async function suiviRetour(event, rAvant, r, c) {
  const ref = event.data.after.ref;
  const id = event.params.id;
  const retractation = c.remboursement && c.remboursement.statut === 'au-retour' ? c.remboursement.montant : null;

  if (r.statut === 'attendue' && rAvant.statut !== 'attendue' && !r.mailLe) {
    await ref.update({ 'restitution.mailLe': FieldValue.serverTimestamp() });
    const avantMs = r.avant.toMillis();
    const envois = [envoyerMail(EMAIL_PAPOTE, mail.retourAPreparer({
      nom: c.nom, email: c.email, telephone: c.telephone, code: c.code ? regles.afficherCode(c.code) : null,
      relais: c.livraison, avant: avantMs, retractation,
    }))];
    if (c.email) envois.push(envoyerMail(c.email, mail.retourTablette({ nom: c.nom, avant: avantMs, retractation })));
    (await Promise.allSettled(envois)).filter((x) => x.status === 'rejected')
      .forEach((x) => logger.error(`Commande ${id} : e-mail de retour non parti`, x.reason));
  }

  if (r.etiquette && r.etiquette !== rAvant.etiquette && c.email) {
    try {
      await envoyerMail(c.email, mail.etiquetteRetour({
        nom: c.nom, lien: r.etiquette, avant: r.avant ? r.avant.toMillis() : null,
      }));
    } catch (e) {
      logger.error(`Commande ${id} : étiquette de retour non envoyée`, e.message);
      await ref.update({ 'restitution.mailErreur': e.message });
    }
  }

  if (r.statut === 'rendue' && rAvant.statut !== 'rendue') {
    let rembourse = 0;
    if (retractation != null) {
      try {
        rembourse = await rembourser(id);
        await ref.update({ remboursement: { statut: 'fait', montant: rembourse, le: FieldValue.serverTimestamp() } });
      } catch (e) {
        logger.error(`Commande ${id} : remboursement refusé`, e.message);
        await ref.update({ 'remboursement.statut': 'echec', 'remboursement.erreur': e.message });
        return;
      }
    }
    if (!c.email) return;
    try {
      await envoyerMail(c.email, mail.tabletteRecue({ nom: c.nom, rembourse }));
    } catch (e) {
      logger.error(`Commande ${id} : e-mail « tablette reçue » non parti`, e.message);
    }
  }
}

// Chaque jour : rappel au client dont la tablette est partie mais pas encore jumelée (J+5, J+12),
// puis signalement à l'administrateur (alerteJumelage) à J+20.
exports.rappelsJumelage = onSchedule(
  { schedule: 'every day 10:00', timeZone: 'Europe/Paris', secrets: [MAIL_MOT_DE_PASSE] },
  async () => {
    const maintenant = Date.now();
    const envoyees = await db.collection('commandes')
      .where('expedition', '==', 'envoyee').where('fid', '==', null).get();
    for (const snap of envoyees.docs) {
      const c = snap.data();
      const depart = c.envoyeeLe && c.envoyeeLe.toMillis();
      if (livraison.alerteDue(depart, maintenant) && !c.alerteJumelage) {
        await snap.ref.update({ alerteJumelage: true });
        logger.warn(`Commande ${snap.id} : tablette toujours pas jumelée 20 jours après l'envoi.`);
      }
      const numero = livraison.rappelDu(depart, c.rappels, maintenant);
      if (!numero || !c.email) continue;
      try {
        await envoyerMail(c.email, mail.rappelJumelage({
          nom: c.nom, numero, code: c.code ? regles.afficherCode(c.code) : null,
        }));
        await snap.ref.update({ rappels: numero, dernierRappelLe: FieldValue.serverTimestamp() });
      } catch (e) {
        logger.error(`Commande ${snap.id} : rappel de jumelage non parti`, e.message);
      }
    }
  });
const support = require('./support');
exports.supportChat = support.supportChat;
exports.bilanSupport = support.bilanSupport;

// Stock de tablettes, commandes, factures et comptabilité (page web/gestion.html, admin).
const gestion = require('./gestion');
exports.gestionDonnees = gestion.gestionDonnees;
exports.gestionStock = gestion.gestionStock;
exports.gestionDepense = gestion.gestionDepense;
exports.gestionStripe = gestion.gestionStripe;
exports.gestionCommande = gestion.gestionCommande;
exports.gestionPiece = gestion.gestionPiece;
exports.gestionLireFacture = gestion.gestionLireFacture;
exports.gestionAutomatique = gestion.gestionAutomatique;
exports.gestionAutomatiser = gestion.gestionAutomatiser;
exports.gestionReglages = gestion.gestionReglages;
exports.gestionRecap = gestion.gestionRecap;
exports.gestionRecapMaintenant = gestion.gestionRecapMaintenant;
exports.gestionCourrier = gestion.gestionCourrier;
exports.gestionCourrierMaintenant = gestion.gestionCourrierMaintenant;
exports.gestionCloture = gestion.gestionCloture;
exports.gestionCloturer = gestion.gestionCloturer;

// Nombre de proches d'une famille (membres « famille » qui ont rejoint), lu par les règles
// Firestore pour refuser un 31e proche. Recalculé à chaque arrivée, départ ou changement de membre.
exports.compterProches = onDocumentWritten(
  { document: 'families/{fid}/members/{uid}', region: REGION_FIRESTORE },
  async (event) => {
    const famille = admin.firestore().doc(`families/${event.params.fid}`);
    const membres = await famille.collection('members').where('role', '==', 'famille').get();
    const nbProches = membres.docs.filter((d) => d.get('status') !== 'pending').length;
    try {
      await famille.update({ nbProches });
    } catch (e) {
      // Famille supprimée : rien à compter.
      if (e.code !== 5) throw e;
    }
  });
