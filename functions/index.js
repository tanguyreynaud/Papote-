// Fonctions serveur de Papote : abonnements et paiements Stripe.
//
//   commander          GET  depuis le site vitrine : ouvre la page de paiement Stripe (si une tablette est disponible)
//   stockDisponible    GET  depuis le site vitrine : { disponible: true|false } (stock.js)
//   creerPaiement      appel depuis l'appli famille : paiement pour une famille existante
//   portailClient      appel depuis l'appli famille : compte bancaire, factures
//   resilierAbonnement appel depuis l'appli famille : résilie à la fin du mois payé (sans engagement)
//   annulerResiliation appel depuis l'appli famille : garde l'abonnement
//   rattacherCommande  appel depuis l'appli famille : relie une commande du site à la famille
//                      (par l'e-mail du compte, ou par le code de commande XXXX-XXXX)
//   codeCommande       GET depuis merci.html : code de commande à noter après le paiement
//   stripeWebhook      Stripe prévient ici de chaque paiement ou changement d'abonnement
//   finDeGrace         chaque heure : suspend les familles dont le délai de grâce est dépassé
//   retracter          appel depuis l'appli famille : annule la commande (14 jours), remboursée au retour
//   finDeContrat       appel depuis l'appli famille : rétractation possible, retour attendu, remboursement
//   restitutions       chaque jour : rappel 7 jours avant, puis 170 € ou 200 € si la tablette n'est pas rendue à temps
//   tabletteRendue     appel depuis le tableau de bord admin : la tablette incluse est revenue
//   etiquetteRetour    appel depuis le tableau de bord admin : lien de l'étiquette de retour prépayée
//   nouvelleFamille    famille créée : sans commande, statut « aucun »
//   nouveauMembre      créateur d'une famille : rattache sa commande faite sur le site
//   tabletteEnvoyee    appel depuis le tableau de bord admin : colis parti, numéro de suivi Mondial Relay
//   commandeModifiee   commande modifiée : e-mail d'envoi, de retour, d'étiquette ; remboursement au retour
//   rappelsJumelage    chaque jour : rappel au client dont la tablette n'est pas jumelée (J+5, J+12)
//   coupeCircuit       avis du budget Google Cloud : e-mail à 30 € et 100 €, facturation coupée à 150 € (budget.js)
//   jetonAppCheck      POST depuis la tablette : jeton App Check contre sa clé d'installation (appcheck.js)
//   quota*             plafonds de stockage par famille appliqués par le serveur (quota.js)
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
const avis = require('./avis');
const relances = require('./relances');

const base = require('./base');
const stock = require('./stock');

// Bucket Europe après la migration (BUCKET_STORAGE dans .env), sinon celui du projet.
admin.initializeApp(base.BUCKET_STORAGE ? { storageBucket: base.BUCKET_STORAGE } : undefined);
const db = base.db();
const { FieldValue, Timestamp } = admin.firestore;

setGlobalOptions({ region: 'europe-west1', maxInstances: 5 });

const STRIPE_SECRET = defineSecret('STRIPE_SECRET');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
const SITE_VITRINE = defineString('SITE_VITRINE', { default: 'https://mapapote.fr' });
// Avant le lancement, le site affiche une liste d'attente au lieu de « Commander ». Les commandes passent
// quand même tant que Stripe est en clé de test (commande test avec la carte 4242, commande.html?essai) ;
// avec la clé réelle, il faut COMMANDES_OUVERTES=oui dans .env.
const COMMANDES_OUVERTES = defineString('COMMANDES_OUVERTES', { default: 'non' });
const commandesOuvertes = () => COMMANDES_OUVERTES.value() === 'oui' || STRIPE_SECRET.value().startsWith('sk_test_');
const APPLI_FAMILLE = 'https://app.mapapote.fr/';
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

// Essai gratuit d'un mois pour un nouveau client ; pas pour un client déjà abonné une fois.
async function sessionPaiement({ formule, tablette, fid, email, client, relais, accord, reservation }) {
  const metadata = { formule, tablette, ...(relais ? livraison.relaisVersMeta(relais) : {}) };
  // Tablette mise de côté pendant le paiement (stock.js), libérée au paiement ou à l'expiration de la page.
  if (reservation && reservation.id) metadata.reservation = reservation.id;
  // Case « nouvelles de Papote par e-mail » cochée sur commande.html : reportée sur la commande.
  if (accord) metadata.accord = '1';
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
    // Prélèvement SEPA seulement (Tanguy, 2026-10-20). Pas de code promo.
    payment_method_types: ['sepa_debit'],
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
  if (reservation && reservation.expireA) params.expires_at = reservation.expireA;
  if (!relais) params.shipping_address_collection = { allowed_countries: ['FR', 'BE', 'LU'] };
  // Factures au nom d'une société : numéro de TVA facultatif sur la page de paiement.
  params.tax_id_collection = { enabled: true };
  if (client) {
    params.customer = client;
    // Stripe l'exige avec tax_id_collection pour un client existant.
    params.customer_update = { name: 'auto', address: 'auto' };
  } else if (email) params.customer_email = email;
  try {
    return await stripe().checkout.sessions.create(params);
  } catch (e) {
    if (reservation && reservation.id) await stock.liberer(db, reservation.id).catch(() => null);
    throw e;
  }
}

// Une tablette du stock mise de côté pour ce paiement, ou null s'il n'y en a plus.
// En clé Stripe de test, une commande d'essai passe même sans stock, sans rien réserver.
async function reserverTablette() {
  const resa = await stock.reserver(db);
  if (resa || !STRIPE_SECRET.value().startsWith('sk_test_')) return resa;
  logger.info("Stock à 0 : commande d'essai acceptée (clé Stripe de test).");
  return { id: null, expireA: null };
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

// Invitation d'un proche par e-mail depuis l'appli famille : un vrai e-mail part, avec le lien du code
// famille. Réservé aux membres actifs ; 20 envois par jour et par famille (limites/invitations-{fid}).
const INVITATIONS_PAR_JOUR = 20;
exports.inviterParEmail = onCall({ secrets: [MAIL_MOT_DE_PASSE], maxInstances: 2 }, async (request) => {
  const { uid } = compteVerifie(request);
  const { fid } = request.data || {};
  const email = emailValide(request.data && request.data.email);
  if (typeof fid !== 'string' || !fid) throw new HttpsError('invalid-argument', 'Famille manquante.');
  if (!email) throw new HttpsError('invalid-argument', 'Adresse e-mail invalide.');
  const [famille, membre] = await Promise.all([
    db.doc(`families/${fid}`).get(), db.doc(`families/${fid}/members/${uid}`).get(),
  ]);
  if (!famille.exists) throw new HttpsError('not-found', 'Famille introuvable.');
  const fam = famille.data();
  const responsable = fam.createdBy === uid || (fam.admins || []).includes(uid);
  if (!responsable && !(membre.exists && (membre.get('status') || 'active') === 'active')) {
    throw new HttpsError('permission-denied', 'Réservé aux membres de la famille.');
  }
  if (!fam.code) throw new HttpsError('failed-precondition', 'Cette famille n\'a pas de code.');
  const jour = new Date().toISOString().slice(0, 10);
  const limite = db.doc(`limites/invitations-${fid}`);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(limite);
    const n = s.exists && s.get('jour') === jour ? s.get('n') : 0;
    if (n >= INVITATIONS_PAR_JOUR) {
      throw new HttpsError('resource-exhausted', 'Trop d\'invitations aujourd\'hui. Réessayez demain.');
    }
    tx.set(limite, { jour, n: n + 1 });
  });
  const code = String(fam.code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const lien = `${APPLI_FAMILLE}?code=${code.length === 8 ? regles.afficherCode(code) : code}`
    + (fam.name ? `&pour=${encodeURIComponent(fam.name)}` : '');
  await envoyerMail(email, mail.invitation({
    prenom: (membre.exists && membre.get('name')) || null, tablette: fam.name, lien, email,
  }));
  return { ok: true };
});

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
    if (snap.exists && (snap.get('restitution') || ['a-preparer', 'paiement-en-attente', 'annulee'].includes(snap.get('expedition')))) return;
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
  if (!commandesOuvertes()) {
    res.redirect(303, `${SITE_VITRINE.value()}/#lancement`);
    return;
  }
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
  const email = emailValide(req.query.email);
  const accord = req.query.accord === '1';
  try {
    // Plus de tablette disponible : liste d'attente « Être prévenu ».
    const reservation = await reserverTablette();
    if (!reservation) {
      res.redirect(303, `${SITE_VITRINE.value()}/#lancement`);
      return;
    }
    const session = await sessionPaiement({ formule, tablette, relais, email, accord, reservation });
    // Lien d'une relance : le panier d'origine est déjà noté.
    if (email && !req.query.relance) {
      await noterPanier(session.id, { email, accord, formule, relais, query: req.query })
        .catch((e) => logger.error('Panier non noté', e.message));
    }
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
  if (!commandesOuvertes()) throw new HttpsError('failed-precondition', 'Les commandes ouvrent très bientôt.');
  if (!regles.formuleValide(formule, tablette)) throw new HttpsError('invalid-argument', 'Formule inconnue.');
  const fam = await familleDuResponsable(fid, uid);
  if (fam.abonnement && ['actif', 'impaye', 'offert'].includes(fam.abonnement.statut)) {
    throw new HttpsError('failed-precondition', 'Cette famille a déjà un abonnement.');
  }
  const client = fam.abonnement && fam.abonnement.stripeCustomerId;
  const reservation = await reserverTablette();
  if (!reservation) throw stock.ERREUR_COMPLET();
  const session = await sessionPaiement({ formule, tablette, fid, email, client, reservation });
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

// Résiliation en ligne, sans engagement : l'abonnement s'arrête à la fin du mois déjà payé.
// Pendant l'essai gratuit : arrêt à la fin de l'essai.
exports.resilierAbonnement = onCall({ secrets: [STRIPE_SECRET] }, async (request) => {
  const { fid } = request.data || {};
  const fam = await familleGeree(fid, request);
  const id = fam.abonnement && fam.abonnement.stripeSubscriptionId;
  if (!id) throw new HttpsError('failed-precondition', "Cette famille n'a pas d'abonnement.");
  const abo = await stripe().subscriptions.retrieve(id);
  const maintenant = Date.now();
  const le = abo.status === 'trialing' && abo.trial_end
    ? abo.trial_end * 1000
    : regles.dateResiliation(finDePeriodeMs(abo), maintenant);
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

// Factures payées de l'abonnement (mise en service de 60 €, mois déjà prélevés).
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
      if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
        await paiementTermine(event.data.object);
      } else if (event.type === 'checkout.session.async_payment_failed') {
        await paiementSepaRefuse(event.data.object);
      } else if (event.type === 'checkout.session.expired') {
        await stock.liberer(db, (event.data.object.metadata || {}).reservation);
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

// Prélèvement SEPA : la page de paiement se termine avant que la banque confirme (quelques jours).
// La commande attend en « paiement-en-attente » (tablette déjà comptée dans le stock), puis passe
// « a-preparer » avec async_payment_succeeded ; les e-mails de confirmation partent à ce moment.
async function paiementTermine(session) {
  if (!session.subscription) return;
  const paye = session.payment_status !== 'unpaid';
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
      expedition: paye ? 'a-preparer' : 'paiement-en-attente',
      stripeCustomerId: session.customer,
      fid: (existante.exists && existante.get('fid')) || null,
      creeLe: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  // La commande « à préparer » compte désormais à la place de la réservation.
  await stock.liberer(db, meta.reservation);
  // Case « nouvelles de Papote par e-mail » cochée sur commande.html, lue par l'onglet Clients.
  if (meta.accord === '1') await ref.update({ marketing: true });
  // Panier de cette personne : payé, plus de relance.
  if (email) await db.doc(`paniers/${cleContact(email)}`).update({ payeLe: FieldValue.serverTimestamp() }).catch(() => null);
  // Le code figure aussi sur les factures Stripe du client.
  const code = regles.afficherCode(await codeDe(session.subscription));
  await stripe().customers.update(session.customer, {
    invoice_settings: { custom_fields: [{ name: 'Code de commande Papote', value: code }] },
  });
  if (!paye) return;
  if (existante.exists && existante.get('expedition') === 'paiement-en-attente') await ref.update({ expedition: 'a-preparer' });
  const fid = meta.fid || (existante.exists && existante.get('fid')) || await chercherFamille(email);
  if (fid) await appliquer(fid, session.subscription);
  await confirmerCommande(ref, email, code);
}

// Prélèvement SEPA refusé par la banque : commande annulée, abonnement arrêté, Papote prévenu.
async function paiementSepaRefuse(session) {
  if (!session.subscription) return;
  const ref = db.doc(`commandes/${session.subscription}`);
  const snap = await ref.get();
  if (!snap.exists || snap.get('expedition') !== 'paiement-en-attente') return;
  await ref.update({ expedition: 'annulee', annulation: 'sepa-refuse', annuleeLe: FieldValue.serverTimestamp() });
  await stripe().subscriptions.cancel(session.subscription).catch((e) => logger.warn('Annulation SEPA', e.message));
  const envois = [envoyerMail(EMAIL_PAPOTE, mail.sepaRefuse({ nom: snap.get('nom'), email: snap.get('email'), papote: true }))];
  if (snap.get('email')) envois.push(envoyerMail(snap.get('email'), mail.sepaRefuse({ nom: snap.get('nom') })));
  (await Promise.allSettled(envois)).filter((r) => r.status === 'rejected')
    .forEach((r) => logger.error(`E-mail SEPA refusé non envoyé (${ref.id})`, r.reason));
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

// ---------- Paniers abandonnés (functions/relances.js) ----------
const URL_COMMANDER = 'https://europe-west1-papote-famille.cloudfunctions.net/commander';
const URL_DESINSCRIPTION = 'https://europe-west1-papote-famille.cloudfunctions.net/desinscription';
const emailValide = (e) => (typeof e === 'string' && e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())
  ? e.trim().toLowerCase() : null);
// Même clé que contacts/ dans gestion.js (onglet Clients, désinscription).
const cleContact = (email) => require('node:crypto').createHash('sha256').update(email).digest('hex').slice(0, 32);

// Ouverture du paiement depuis le site : panier noté dans paniers/{clé de l'e-mail}, un par personne
// (un nouvel essai repart de zéro), lu par l'onglet Clients.
// Avec l'accord, l'adresse rejoint contacts/ avec un jeton de désinscription.
async function noterPanier(sessionId, { email, accord, formule, relais, query }) {
  const requete = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (typeof v === 'string' && !['email', 'accord', 'relance'].includes(k)) requete.set(k, v);
  }
  await db.doc(`paniers/${cleContact(email)}`).set({
    session: sessionId, email, nom: relais.destinataire || null, telephone: null, formule,
    ...(accord ? { marketing: true } : {}),
    requete: requete.toString(), relances: 0,
    creeLe: FieldValue.serverTimestamp(),
  });
  if (!accord) return;
  const ref = db.doc(`contacts/${cleContact(email)}`);
  const snap = await ref.get();
  await ref.set({
    email, consentement: true, source: 'commande', desinscritLe: FieldValue.delete(),
    ...(snap.exists && snap.get('jeton') ? {} : { jeton: require('node:crypto').randomBytes(16).toString('hex') }),
  }, { merge: true });
}

// Liste d'attente du lancement (site vitrine) : l'adresse rejoint contacts/ avec l'accord et un jeton de
// désinscription, source « liste-attente », pour l'e-mail d'ouverture des commandes (onglet Clients).
// Le site affiche « Être prévenu » à la place de « Commander » quand il n'y a plus de tablette.
exports.stockDisponible = onRequest({ cors: [/mapapote\.fr$/, /papote\.web\.app$/], maxInstances: 2 }, stock.routeDisponible(db, logger));

exports.listeAttente = onRequest({ cors: [/mapapote\.fr$/, /papote\.web\.app$/], maxInstances: 2 }, async (req, res) => {
  const d = req.method === 'POST' && req.body && typeof req.body === 'object' ? req.body : {};
  const email = emailValide(d.email);
  if (!email || d.accord !== true) {
    res.status(400).json({ erreur: 'E-mail ou accord manquant.' });
    return;
  }
  const prenom = typeof d.prenom === 'string' ? d.prenom.trim().slice(0, 60) : '';
  const ref = db.doc(`contacts/${cleContact(email)}`);
  const snap = await ref.get();
  await ref.set({
    email, consentement: true, desinscritLe: FieldValue.delete(),
    ...(prenom ? { prenom } : {}),
    ...(snap.exists ? {} : { source: 'liste-attente', creeLe: FieldValue.serverTimestamp() }),
    listeAttente: true, listeAttenteLe: FieldValue.serverTimestamp(),
    ...(snap.exists && snap.get('jeton') ? {} : { jeton: require('node:crypto').randomBytes(16).toString('hex') }),
  }, { merge: true });
  res.status(204).end();
});

// Toutes les heures : relances dues (1 h après, lendemain 19 h, une semaine après 19 h),
// seulement avec l'accord, sans paiement depuis et sans désinscription.
exports.relancesPaniers = onSchedule(
  { schedule: 'every 60 minutes', timeZone: 'Europe/Paris', secrets: [MAIL_MOT_DE_PASSE] },
  async () => {
    const maintenant = Date.now();
    const depuis = new Date(maintenant - 9 * relances.JOUR);
    const paniers = await db.collection('paniers').where('creeLe', '>=', depuis).get();
    for (const p of paniers.docs) {
      const d = p.data();
      if (!d.marketing || d.payeLe || !d.email || !d.creeLe) continue;
      const etape = relances.relanceDue(d.creeLe.toMillis(), d.relances, maintenant);
      if (!etape) continue;
      try {
        const deja = await db.collection('commandes').where('email', '==', d.email).limit(1).get();
        const contact = await db.doc(`contacts/${cleContact(d.email)}`).get();
        if (!deja.empty || (contact.exists && (contact.get('desinscritLe') || contact.get('consentement') === false))) {
          await p.ref.update({ relances: relances.RELANCES_MAX, relanceArretee: true });
          continue;
        }
        const desinscription = contact.exists && contact.get('jeton')
          ? `${URL_DESINSCRIPTION}?c=${contact.id}&j=${contact.get('jeton')}` : null;
        const lien = `${URL_COMMANDER}?${d.requete}&email=${encodeURIComponent(d.email)}&relance=${p.id}`;
        await envoyerMail(d.email, mail.relancePanier({ etape, nom: d.nom, formule: d.formule, lien, desinscription }));
        await p.ref.update({ relances: etape, [`relance${etape}Le`]: FieldValue.serverTimestamp() });
      } catch (e) {
        logger.error(`Relance ${etape} du panier ${p.id} non envoyée`, e.message);
      }
    }
  });

// Admin : e-mail d'ouverture des commandes à la liste d'attente. { test: true } l'envoie seulement à l'admin
// qui appelle. Sinon, une fois par contact (lancementEnvoyeLe), avec l'accord et sans désinscription.
exports.lancementListeAttente = onCall({ secrets: [MAIL_MOT_DE_PASSE], timeoutSeconds: 540 }, async (request) => {
  verifierAdmin(request);
  if (request.data && request.data.test === true) {
    const email = request.auth.token.email;
    if (!email) throw new HttpsError('failed-precondition', 'Compte sans e-mail.');
    await envoyerMail(email, mail.lancement({ prenom: 'Tanguy', desinscription: `${URL_DESINSCRIPTION}?c=test&j=test` }));
    return { envoyes: 1, test: true };
  }
  const contacts = await db.collection('contacts').where('listeAttente', '==', true).get();
  let envoyes = 0;
  let erreurs = 0;
  for (const c of contacts.docs) {
    const d = c.data();
    if (!d.email || d.consentement !== true || d.desinscritLe || d.lancementEnvoyeLe) continue;
    try {
      const desinscription = d.jeton ? `${URL_DESINSCRIPTION}?c=${c.id}&j=${d.jeton}` : null;
      await envoyerMail(d.email, mail.lancement({ prenom: d.prenom, desinscription }));
      await c.ref.update({ lancementEnvoyeLe: FieldValue.serverTimestamp() });
      envoyes += 1;
    } catch (e) {
      erreurs += 1;
      logger.error(`E-mail de lancement non envoyé (${c.id})`, e.message);
    }
  }
  return { envoyes, erreurs };
});

async function abonnementModifie(abo) {
  const commande = await db.doc(`commandes/${abo.id}`).get();
  const fid = (abo.metadata && abo.metadata.fid) || (commande.exists && commande.get('fid'));
  if (fid) await appliquer(fid, abo.id);
  else if (commande.exists) await commande.ref.update({ statutStripe: abo.status });
}

// ---------- Page d'accueil du site vitrine, avec les avis (functions/avis.js) ----------
// firebase.vitrine.json envoie « / » ici. Le gabarit vitrine/accueil.html est relu toutes les 5 minutes ;
// la page est gardée 5 minutes par le CDN : un avis modifié dans l'admin apparaît en 5 à 10 minutes.
let gabaritAccueil = { html: '', lu: 0 };
exports.accueil = onRequest({ maxInstances: 5, memory: '256MiB' }, async (req, res) => {
  try {
    if (!gabaritAccueil.html || Date.now() - gabaritAccueil.lu > 300e3) {
      const r = await fetch(`${SITE_VITRINE.value()}/accueil.html`);
      if (!r.ok) throw new Error(`accueil.html : ${r.status}`);
      gabaritAccueil = { html: await r.text(), lu: Date.now() };
    }
    let liste = [];
    try {
      const snap = await db.collection('avis').where('visible', '==', true).limit(avis.MAX_AVIS * 2).get();
      liste = snap.docs.map((d) => d.data());
    } catch (e) {
      logger.warn('Avis illisibles', e.message);
    }
    res.set('Cache-Control', 'public, max-age=60, s-maxage=300');
    res.type('html').send(avis.pageAvecAvis(gabaritAccueil.html, liste));
  } catch (e) {
    logger.error('Page d\'accueil', e);
    if (gabaritAccueil.html) res.type('html').send(avis.pageAvecAvis(gabaritAccueil.html, []));
    else res.redirect(302, '/accueil.html');
  }
});

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

// Tablette incluse non rendue dans les 30 jours : 170 € (200 € si un routeur 4G était dans le colis) prélevés sur la carte de l'abonnement.
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
            montant: regles.penaliteRestitution(snap.data()),
          }));
          await snap.ref.update({ 'restitution.rappelLe': FieldValue.serverTimestamp() });
        } catch (e) {
          logger.error(`Commande ${snap.id} : rappel de retour non parti`, e.message);
        }
      }
      if (!regles.restitutionEchue(snap.get('restitution'), maintenant)) continue;
      try {
        const paiement = await preleverMateriel(snap.id, regles.penaliteRestitution(snap.data()),
          'Papote : matériel non rendu', `restitution-${snap.id}`);
        await snap.ref.update({
          'restitution.statut': 'facturee',
          'restitution.paiement': paiement.id,
          'restitution.majLe': FieldValue.serverTimestamp(),
        });
        logger.info(`Commande ${snap.id} : tablette non rendue, ${mail.euros(regles.penaliteRestitution(snap.data()))} prélevés.`);
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

// Prélève du matériel non rendu sur la carte de l'abonnement. La description contient « non rendu » :
// gestion.js en fait une facture chaque nuit.
async function preleverMateriel(abonnement, montant, description, cle) {
  const abo = await stripe().subscriptions.retrieve(abonnement, { expand: ['customer'] });
  const moyen = abo.default_payment_method
    || (abo.customer.invoice_settings && abo.customer.invoice_settings.default_payment_method);
  if (!moyen) throw new Error('Aucun moyen de paiement enregistré');
  return stripe().paymentIntents.create({
    amount: montant,
    currency: 'eur',
    customer: abo.customer.id,
    payment_method: typeof moyen === 'string' ? moyen : moyen.id,
    off_session: true,
    confirm: true,
    description,
    metadata: { commande: abonnement },
  }, { idempotencyKey: cle });
}

// Le tableau de bord admin marque la tablette incluse comme revenue.
// Même règle que isAdmin() des règles Firestore : badge admin, ou l'adresse de Tanguy le temps du badge.
function verifierAdmin(request) {
  const token = request.auth && request.auth.token;
  const estAdmin = token && (token.admin === true
    || (token.email === 'tanguyreynaud22@gmail.com' && token.email_verified === true));
  if (!estAdmin) throw new HttpsError('permission-denied', 'Réservé à l\'administrateur.');
}

// manquants (facultatif) : éléments absents du colis retour, parmi 'tablette', 'chargeur', 'routeur'.
// Chacun est prélevé à son prix (tablette 160 €, chargeur et câble 10 €, routeur 30 €).
exports.tabletteRendue = onCall({ secrets: [STRIPE_SECRET] }, async (request) => {
  verifierAdmin(request);
  const { commande, manquants } = request.data || {};
  if (typeof commande !== 'string' || !commande) throw new HttpsError('invalid-argument', 'Commande manquante.');
  if (manquants != null && (!Array.isArray(manquants) || manquants.some((m) => !regles.PRIX_MATERIEL[m]))) {
    throw new HttpsError('invalid-argument', 'Éléments manquants invalides.');
  }
  const ref = db.doc(`commandes/${commande}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Commande introuvable.');
  if (snap.get('restitution.statut') === 'facturee') {
    throw new HttpsError('failed-precondition', 'Le matériel non rendu a déjà été prélevé : remboursez depuis Stripe si besoin.');
  }
  const liste = [...new Set(manquants || [])].filter((m) => regles.materielPrete(snap.data()).includes(m));
  const montant = regles.montantManquants(snap.data(), liste);
  const restitution = { statut: 'rendue', majLe: FieldValue.serverTimestamp() };
  if (montant > 0) {
    restitution.manquants = liste;
    try {
      const paiement = await preleverMateriel(snap.id, montant,
        `Papote : matériel non rendu (${liste.map((m) => regles.NOMS_MATERIEL[m]).join(', ')})`, `manquants-${snap.id}-${liste.join('-')}`);
      restitution.paiement = paiement.id;
      restitution.montant = montant;
    } catch (e) {
      restitution.statut = 'echec';
      restitution.erreur = e.message;
    }
  }
  await ref.set({ restitution }, { merge: true });
  return { ok: restitution.statut === 'rendue', montant, erreur: restitution.erreur || null };
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

// Les déclencheurs Firestore écoutent la base BASE_FIRESTORE et tournent dans sa région (base.js, .env).
const { REGION_FIRESTORE, BASE_FIRESTORE } = base;

exports.nouvelleFamille = onDocumentCreated({ document: 'families/{fid}', database: BASE_FIRESTORE, region: REGION_FIRESTORE }, async (event) => {
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
  { document: 'families/{fid}/members/{uid}', database: BASE_FIRESTORE, region: REGION_FIRESTORE, secrets: [STRIPE_SECRET] },
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
  { document: 'commandes/{id}', database: BASE_FIRESTORE, region: REGION_FIRESTORE, secrets: [MAIL_MOT_DE_PASSE, STRIPE_SECRET] },
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
    if (c.email) envois.push(envoyerMail(c.email, mail.retourTablette({ nom: c.nom, avant: avantMs, retractation, montant: regles.penaliteRestitution(c) })));
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
// Le jumelage d'une tablette du stock relie sa commande à la famille (gestion.gestionJumelage).
gestion.brancher({ appliquer });
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
exports.gestionSim = gestion.gestionSim;
exports.gestionAccessoire = gestion.gestionAccessoire;
exports.gestionEtiquette = gestion.gestionEtiquette;
exports.gestionAnnulerEtiquette = gestion.gestionAnnulerEtiquette;
exports.gestionClients = gestion.gestionClients;
exports.gestionConsentement = gestion.gestionConsentement;
exports.gestionCampagne = gestion.gestionCampagne;
exports.desinscription = gestion.desinscription;
exports.gestionSupprimerFamille = gestion.gestionSupprimerFamille;
exports.gestionFamilleOfferte = gestion.gestionFamilleOfferte;
exports.gestionParcours = gestion.gestionParcours;
exports.gestionRenvoyerCode = gestion.gestionRenvoyerCode;
exports.gestionJumelage = gestion.gestionJumelage;

// Nombre de proches d'une famille (membres « famille » qui ont rejoint), lu par les règles
// Firestore pour refuser un 31e proche. Recalculé à chaque arrivée, départ ou changement de membre.
exports.compterProches = onDocumentWritten(
  { document: 'families/{fid}/members/{uid}', database: BASE_FIRESTORE, region: REGION_FIRESTORE },
  async (event) => {
    const famille = db.doc(`families/${event.params.fid}`);
    const membres = await famille.collection('members').where('role', '==', 'famille').get();
    const nbProches = membres.docs.filter((d) => d.get('status') !== 'pending').length;
    try {
      await famille.update({ nbProches });
    } catch (e) {
      // Famille supprimée : rien à compter.
      if (e.code !== 5) throw e;
    }
  });

// Appels de la tablette vers la famille : sonnerie et appel manqué par notification push.
Object.assign(exports, require('./appels'));

// Protections contre une facture qui s'emballe : coupe-circuit à 150 € et plafonds de stockage.
exports.coupeCircuit = require('./budget').coupeCircuit;
// Jeton App Check des tablettes (clé posée à l'installation).
exports.jetonAppCheck = require('./appcheck').jetonAppCheck;
Object.assign(exports, (({ quotaFichier, quotaFichierEfface, quotaEnvois }) => ({ quotaFichier, quotaFichierEfface, quotaEnvois }))(require('./quota')));

// Alertes sur le téléphone des responsables : tablette débranchée ou qui ne répond plus.
exports.alertesTablettes = require('./alertes').alertesTablettes;
exports.alerteMatin = require('./alertes').alerteMatin;
