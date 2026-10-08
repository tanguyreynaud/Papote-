// Fonctions serveur de Papote : abonnements et paiements Stripe.
//
//   commander          GET  depuis le site vitrine : ouvre la page de paiement Stripe
//   creerPaiement      appel depuis l'appli famille : paiement pour une famille existante
//   portailClient      appel depuis l'appli famille : carte bancaire, factures
//   resilierAbonnement appel depuis l'appli famille : résilie à la fin de l'engagement de 12 mois
//   annulerResiliation appel depuis l'appli famille : garde l'abonnement
//   rattacherCommande  appel depuis l'appli famille : relie une commande du site à la famille
//   stripeWebhook      Stripe prévient ici de chaque paiement ou changement d'abonnement
//   finDeGrace         chaque heure : suspend les familles dont le délai de grâce est dépassé
//   restitutions       chaque jour : prélève 100 € si une tablette incluse n'est pas rendue à temps
//   tabletteRendue     appel depuis le tableau de bord admin : la tablette incluse est revenue
//   nouvelleFamille    famille créée : sans commande, statut « aucun »
//   nouveauMembre      créateur d'une famille : rattache sa commande faite sur le site
//
// État écrit sur families/{fid}.abonnement (voir abonnement.js), avec rev + 1 pour que la
// tablette relise la famille. Commandes : commandes/{id de l'abonnement Stripe}.
// Clés Stripe dans Secret Manager (outils/stripe/installer-stripe.bat), jamais dans le dépôt.

const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { setGlobalOptions, logger } = require('firebase-functions/v2');
const { defineSecret, defineString } = require('firebase-functions/params');
const admin = require('firebase-admin');
const Stripe = require('stripe');
const regles = require('./abonnement');

admin.initializeApp();
const db = admin.firestore();
const { FieldValue, Timestamp } = admin.firestore;

setGlobalOptions({ region: 'europe-west1', maxInstances: 5 });

const STRIPE_SECRET = defineSecret('STRIPE_SECRET');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
const SITE_VITRINE = defineString('SITE_VITRINE', { default: 'https://papote.web.app' });
const APPLI_FAMILLE = 'https://papote-famille.web.app/';

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
  const { data } = await stripe().prices.list({ lookup_keys: cles, active: true });
  const parCle = Object.fromEntries(data.map((p) => [p.lookup_key, p.id]));
  for (const cle of cles) {
    if (!parCle[cle]) throw new Error(`Tarif Stripe introuvable : ${cle}`);
  }
  return cles.map((cle) => ({ price: parCle[cle], quantity: 1 }));
}

// Essai gratuit de 15 jours pour un nouveau client ; pas pour un client déjà abonné une fois.
async function sessionPaiement({ formule, tablette, fid, email, client }) {
  const metadata = { formule, tablette };
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
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    phone_number_collection: { enabled: true },
    metadata,
    subscription_data: subscriptionData,
    payment_method_collection: 'always',
    success_url: fid ? `${APPLI_FAMILLE}?abonnement=ok` : `${SITE_VITRINE.value()}/merci.html`,
    cancel_url: fid ? APPLI_FAMILLE : `${SITE_VITRINE.value()}/#tarifs`,
  };
  // Adresse de livraison de la tablette.
  params.shipping_address_collection = { allowed_countries: ['FR', 'BE', 'CH', 'LU'] };
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
    if (snap.exists && snap.get('restitution')) return;
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
  try {
    const session = await sessionPaiement({ formule, tablette });
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
  const { uid } = compteVerifie(request);
  const { fid } = request.data || {};
  const fam = await familleDuResponsable(fid, uid);
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
  const { uid } = compteVerifie(request);
  const { fid } = request.data || {};
  const fam = await familleDuResponsable(fid, uid);
  const id = fam.abonnement && fam.abonnement.stripeSubscriptionId;
  if (!id) throw new HttpsError('failed-precondition', "Cette famille n'a pas d'abonnement.");
  await stripe().subscriptions.update(id, { cancel_at: '' });
  await appliquer(fid, id);
  return { ok: true };
});

exports.rattacherCommande = onCall({ secrets: [STRIPE_SECRET] }, async (request) => {
  const { uid, email } = compteVerifie(request);
  const { fid } = request.data || {};
  const fam = await familleDuResponsable(fid, uid);
  if (fam.abonnement && ['actif', 'impaye', 'offert'].includes(fam.abonnement.statut)) {
    throw new HttpsError('failed-precondition', 'Cette famille a déjà un abonnement.');
  }
  const commandes = await db.collection('commandes')
    .where('email', '==', email).where('fid', '==', null).get();
  if (commandes.empty) {
    throw new HttpsError('not-found', `Aucune commande en attente pour ${email}.`);
  }
  const plusRecente = commandes.docs
    .sort((a, b) => (b.get('creeLe')?.toMillis() || 0) - (a.get('creeLe')?.toMillis() || 0))[0];
  await appliquer(fid, plusRecente.id);
  return { ok: true };
});

// ---------- Stripe ----------

exports.stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET, STRIPE_WEBHOOK_SECRET] },
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
  const livraison = (session.collected_information && session.collected_information.shipping_details)
    || session.shipping_details || null;
  const email = (details.email || session.customer_email || '').toLowerCase();
  const meta = session.metadata || {};
  const ref = db.doc(`commandes/${session.subscription}`);
  const existante = await ref.get();
  if (!existante.exists) {
    await ref.set({
      email,
      nom: details.name || null,
      telephone: details.phone || null,
      formule: meta.formule || null,
      tablette: meta.tablette || null,
      livraison: livraison ? { nom: livraison.name || null, adresse: livraison.address || null } : null,
      // Tablette à préparer et envoyer par Tanguy (« envoyee » une fois partie).
      expedition: 'a-preparer',
      stripeCustomerId: session.customer,
      fid: null,
      creeLe: FieldValue.serverTimestamp(),
    });
  }
  const fid = meta.fid || (existante.exists && existante.get('fid')) || await chercherFamille(email);
  if (fid) await appliquer(fid, session.subscription);
}

async function abonnementModifie(abo) {
  const commande = await db.doc(`commandes/${abo.id}`).get();
  const fid = (abo.metadata && abo.metadata.fid) || (commande.exists && commande.get('fid'));
  if (fid) await appliquer(fid, abo.id);
  else if (commande.exists) await commande.ref.update({ statutStripe: abo.status });
}

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

// Tablette incluse non rendue dans les 30 jours : 100 € prélevés sur la carte de l'abonnement.
exports.restitutions = onSchedule(
  { schedule: 'every day 09:00', timeZone: 'Europe/Paris', secrets: [STRIPE_SECRET] },
  async () => {
    const maintenant = Date.now();
    const attendues = await db.collection('commandes').where('restitution.statut', '==', 'attendue').get();
    for (const snap of attendues.docs) {
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
        logger.info(`Commande ${snap.id} : tablette non rendue, 100 € prélevés.`);
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
exports.tabletteRendue = onCall(async (request) => {
  const token = request.auth && request.auth.token;
  // Même règle que isAdmin() des règles Firestore : badge admin, ou l'adresse de Tanguy le temps du badge.
  const estAdmin = token && (token.admin === true
    || (token.email === 'tanguyreynaud22@gmail.com' && token.email_verified === true));
  if (!estAdmin) throw new HttpsError('permission-denied', 'Réservé à l\'administrateur.');
  const { commande } = request.data || {};
  if (typeof commande !== 'string' || !commande) throw new HttpsError('invalid-argument', 'Commande manquante.');
  const ref = db.doc(`commandes/${commande}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Commande introuvable.');
  if (snap.get('restitution.statut') === 'facturee') {
    throw new HttpsError('failed-precondition', 'Les 100 € ont déjà été prélevés : remboursez-les depuis Stripe.');
  }
  await ref.set({
    restitution: { statut: 'rendue', majLe: FieldValue.serverTimestamp() },
  }, { merge: true });
  return { ok: true };
});

exports.nouvelleFamille = onDocumentCreated('families/{fid}', async (event) => {
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
  { document: 'families/{fid}/members/{uid}', secrets: [STRIPE_SECRET] },
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
