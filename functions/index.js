// Fonctions serveur de Papote : abonnements et paiements Stripe.
//
//   commander          GET  depuis le site vitrine : ouvre la page de paiement Stripe (si une tablette est disponible)
//   stockDisponible    GET  depuis le site vitrine : { disponible: true|false } (stock.js)
//   creerPaiement      appel depuis l'appli famille : paiement pour une famille existante
//   portailClient      appel depuis l'appli famille : compte bancaire, factures
//   resilierAbonnement appel depuis l'appli famille : résilie à la fin du mois en cours, prélevé à l'arrêt
//   annulerResiliation appel depuis l'appli famille : garde l'abonnement
//   rattacherCommande  appel depuis l'appli famille : relie une commande du site à la famille
//                      (par l'e-mail du compte, ou par le code de commande XXXX-XXXX)
//   codeCommande       GET depuis merci.html : code de commande à noter après le paiement
//   stripeWebhook      Stripe prévient ici de chaque paiement ou changement d'abonnement
//   finDeGrace         chaque heure : suspend les familles dont le délai de grâce est dépassé
//   retracter          appel depuis l'appli famille : annule la commande (30 jours), remboursée au retour
//   finDeContrat       appel depuis l'appli famille : rétractation possible, retour attendu, remboursement
//   restitutions       chaque jour : rappel 7 jours avant, puis 140 € ou 150 € (abonnement.js) si le matériel n'est pas rendu à temps
//   tabletteRendue     appel depuis le tableau de bord admin : la tablette incluse est revenue
//   etiquetteRetour    appel depuis le tableau de bord admin : lien de l'étiquette de retour prépayée
//   nouvelleFamille    famille créée : sans commande, statut « aucun »
//   nouveauMembre      créateur d'une famille : rattache sa commande faite sur le site
//   tabletteEnvoyee    appel depuis le tableau de bord admin : colis parti, numéro de suivi Mondial Relay
//   commandeModifiee   commande modifiée : e-mail d'envoi, de retour, d'étiquette ; remboursement au retour
//   reserverTablette   appel depuis l'appli famille : le premier proche scanne la tablette (installation.js)
//   nommerFamille      appel depuis l'appli famille : « Comment l'appelez-vous ? » crée la famille (installation.js)
//   finirInstallation  appel depuis l'appli famille : fin de l'installation, invitations (installation.js)
//   annulerInstallation appel depuis l'appli famille : « Annuler l'installation » efface la famille (installation.js)
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
const regles = require('./abonnement');
const livraison = require('./livraison');
const mail = require('./mail');
const avis = require('./avis');
const relances = require('./relances');

const base = require('./base');
const stock = require('./stock');
const push = require('./push');

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
  if (!stripeClient) stripeClient = new (require('stripe'))(STRIPE_SECRET.value());
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

// reprise : abonnement repris sur une tablette restée chez le proche (C3) : pas de mise en service.
async function tarifs(formule, tablette, { reprise = false } = {}) {
  const cles = [regles.TARIFS[formule][tablette], ...(reprise ? [] : [regles.TARIF_MISE_EN_SERVICE])];
  const { data } = await stripe().prices.list({ lookup_keys: cles, active: true });
  const parCle = Object.fromEntries(data.map((p) => [p.lookup_key, p.id]));
  for (const cle of cles) {
    if (!parCle[cle]) throw new Error(`Tarif Stripe introuvable : ${cle}`);
  }
  return cles.map((cle) => ({ price: parCle[cle], quantity: 1 }));
}

// Paiement du mois écoulé (Tanguy, 2026-10-21) : rien n'est prélevé tant que la tablette n'est pas arrivée
// (« trial » Stripe), ni pendant les 30 jours pour changer d'avis qui suivent la réception (debutApresReception),
// puis un prélèvement par mois ; le mois en cours est prélevé à l'arrêt (prelevementDernierMois).
// Chaque mois utilisé est donc payé une fois, à terme échu.
async function sessionPaiement({ formule, tablette, fid, email, client, relais, accord, reservation, dejaInstallee, reprise }) {
  const metadata = { formule, tablette, ...(relais ? livraison.relaisVersMeta(relais) : {}) };
  if (dejaInstallee) metadata.dejaInstallee = '1';
  // Reprise après une résiliation, tablette encore chez le proche : pas de 60 €, rien à annuler (C3).
  if (reprise) metadata.reprise = '1';
  // Tablette mise de côté pendant le paiement (stock.js), libérée au paiement ou à l'expiration de la page.
  if (reservation && reservation.id) metadata.reservation = reservation.id;
  // Délai annoncé au client (stock.js) : stock, precommande ou long.
  if (reservation && reservation.delai) metadata.delai = reservation.delai;
  // Case « nouvelles de Papote par e-mail » cochée sur commande.html : reportée sur la commande.
  if (accord) metadata.accord = '1';
  if (fid) metadata.fid = fid;
  // Plus d'essai gratuit affiché (Tanguy, 2026-10-27) : une date de premier prélèvement, estimée d'après le délai
  // annoncé puis recalée à l'envoi (debutApresReception), et une phrase sous le bouton qui dit la règle.
  const premier = regles.premierPrelevementMs(metadata.delai, Date.now(), { dejaInstallee: Boolean(dejaInstallee) });
  const subscriptionData = {
    metadata,
    billing_cycle_anchor: Math.ceil(premier / 1000),
    proration_behavior: 'none',
  };
  const regle = reprise
    ? 'Rien à régler aujourd\'hui. Premier prélèvement dans 30 jours, puis chaque mois pour le mois écoulé. Sans engagement.'
    : dejaInstallee
      ? 'Aujourd\'hui : la mise en service. Premier prélèvement de l\'abonnement dans 30 jours, puis chaque mois pour le mois écoulé. Sans engagement.'
      : 'Aujourd\'hui : la mise en service. L\'abonnement est compté à partir de la réception de la tablette : premier prélèvement 30 jours après, puis chaque mois pour le mois écoulé. Sans engagement.';
  const params = {
    mode: 'subscription',
    line_items: await tarifs(formule, tablette, { reprise }),
    locale: 'fr',
    // Carte (avec Apple Pay et Google Pay) en premier, prélèvement SEPA ensuite (Tanguy, 2026-10-26 : la carte
    // se tape en 20 secondes sur un téléphone, l'IBAN rarement sous la main). Pas de code promo.
    payment_method_types: ['card', 'sepa_debit'],
    billing_address_collection: 'auto',
    phone_number_collection: { enabled: true },
    metadata,
    subscription_data: subscriptionData,
    custom_text: { submit: { message: regle } },
    payment_method_collection: 'always',
    success_url: fid ? `${APPLI_FAMILLE}?abonnement=ok`
      : `${SITE_VITRINE.value()}/merci.html?session={CHECKOUT_SESSION_ID}`,
    cancel_url: fid ? APPLI_FAMILLE : `${SITE_VITRINE.value()}/commande.html?formule=${formule}`,
  };
  // Commande du site : livrée au point relais choisi avant le paiement. Depuis l'appli : à l'adresse saisie.
  if (reservation && reservation.expireA) params.expires_at = reservation.expireA;
  if (!relais && !dejaInstallee) params.shipping_address_collection = { allowed_countries: ['FR', 'BE', 'LU'] };
  // Plus de numéro de TVA sur la page de paiement (Tanguy, 2026-10-26) : un champ de moins, l'admin peut
  // compléter une facture à la main. Le téléphone reste demandé : il sert au suivi du colis et au doublon.
  if (client) {
    params.customer = client;
    params.customer_update = { name: 'auto', address: 'auto' };
  } else if (email) params.customer_email = email;
  try {
    return await stripe().checkout.sessions.create(params);
  } catch (e) {
    if (reservation && reservation.id) await stock.liberer(db, reservation.id).catch(() => null);
    throw e;
  }
}

// Une commande résiliée de la famille attend encore le retour de sa tablette : elle est toujours chez le proche.
async function tabletteARendre(fid) {
  const attendues = await db.collection('commandes').where('fid', '==', fid)
    .where('restitution.statut', 'in', ['attendue', 'echec']).get();
  return !attendues.empty;
}

// La famille a-t-elle déjà sa tablette (jumelage confirmé) ?
async function tabletteInstallee(fid) {
  const jumelages = await db.collection('pairings').where('fid', '==', fid).get();
  return jumelages.docs.some((d) => d.get('status') === 'confirmed');
}

// La tablette du stock jumelée à cette famille (« jumelée sans commande ») prend la nouvelle commande,
// et l'alerte de l'admin n'a plus lieu d'être. Reprise (C3) : la tablette de l'ancienne commande résiliée passe
// sur la nouvelle, et le retour attendu de l'ancienne est annulé (plus de 140 € à prélever).
async function relierTabletteInstallee(fid, commande, { reprise = false } = {}) {
  if (reprise) {
    const anciennes = await db.collection('commandes').where('fid', '==', fid)
      .where('restitution.statut', 'in', ['attendue', 'echec']).get();
    await Promise.all(anciennes.docs.filter((d) => d.id !== commande).map((d) => d.ref.update({
      'restitution.statut': 'annulee', 'restitution.motif': 'reprise', 'restitution.reprisePar': commande,
      'restitution.majLe': FieldValue.serverTimestamp(),
    })));
  }
  const fiches = await db.collection('stock').where('fid', '==', fid).get();
  await Promise.all(fiches.docs.filter((d) => reprise || !d.get('commande'))
    .map((d) => d.ref.update({
      commande, etat: 'chez-client',
      ...(d.get('alerteJumelage') === 'jumelée sans commande' ? { alerteJumelage: null } : {}),
    })));
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

// Membre actif de la famille (fiche présente, pas en attente) : même règle que isMember() des règles Firestore.
async function membreActif(fid, uid) {
  const membre = await db.doc(`families/${fid}/members/${uid}`).get();
  return membre.exists && (membre.get('status') || 'active') !== 'pending';
}

// Responsable de la famille : créateur ou désigné dans admins, et toujours membre (un ancien responsable
// parti de la famille peut rester dans admins : il ne doit plus toucher à l'abonnement).
async function familleDuResponsable(fid, uid) {
  if (typeof fid !== 'string' || !fid) throw new HttpsError('invalid-argument', 'Famille manquante.');
  const snap = await db.doc(`families/${fid}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Famille introuvable.');
  const fam = snap.data();
  if ((fam.createdBy !== uid && !(fam.admins || []).includes(uid)) || !(await membreActif(fid, uid))) {
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
  // Membre actif seulement, responsable compris (un ancien responsable parti de la famille n'invite plus).
  if (!(membre.exists && (membre.get('status') || 'active') === 'active')) {
    throw new HttpsError('permission-denied', 'Réservé aux membres de la famille.');
  }
  if (!fam.code) throw new HttpsError('failed-precondition', 'Cette famille n\'a pas de code.');
  const jour = new Date(Date.now()).toISOString().slice(0, 10);
  // Deux plafonds : par famille, et par compte (créer des familles à la chaîne ne permet pas d'envoyer
  // des e-mails Papote sans limite).
  const limites = [db.doc(`limites/invitations-${fid}`), db.doc(`limites/invitations-compte-${uid}`)];
  await db.runTransaction(async (tx) => {
    const snaps = await Promise.all(limites.map((l) => tx.get(l)));
    const nombres = snaps.map((s) => (s.exists && s.get('jour') === jour ? s.get('n') : 0));
    if (nombres.some((n) => n >= INVITATIONS_PAR_JOUR)) {
      throw new HttpsError('resource-exhausted', 'Trop d\'invitations aujourd\'hui. Réessayez demain.');
    }
    limites.forEach((l, i) => tx.set(l, { jour, n: nombres[i] + 1 }));
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
  const commande = await db.doc(`commandes/${abonnementId}`).get();
  if (commande.exists && commande.get('offerte')) return appliquerOfferte(fid, commande);
  const abo = await stripe().subscriptions.retrieve(abonnementId);
  const ref = db.doc(`families/${fid}`);
  const changement = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const actuel = snap.data().abonnement;
    if (!regles.peutModifier(actuel)) {
      logger.info(`Famille ${fid} offerte : abonnement ${abonnementId} ignoré.`);
      return null;
    }
    const { statut, graceJusqua } = regles.statutDepuisStripe(abo.status, actuel, Date.now());
    // Date de suspension gardée (C2 : « suspendue depuis N jours » dans À faire), tant que ça dure.
    const suspenduLe = statut === 'suspendu'
      ? ((actuel && actuel.statut === 'suspendu' && actuel.suspenduLe) || Timestamp.fromMillis(Date.now())) : null;
    tx.update(ref, {
      abonnement: {
        statut,
        suspenduLe,
        formule: abo.metadata.formule || null,
        tablette: abo.metadata.tablette || null,
        graceJusqua: versTimestamp(graceJusqua),
        finPeriode: versTimestamp(finDePeriodeMs(abo)),
        essaiJusqua: versTimestamp(regles.premierPrelevementDe(abo, Date.now())),
        resiliationLe: versTimestamp(abo.cancel_at ? abo.cancel_at * 1000
          : (abo.cancel_at_period_end ? finDePeriodeMs(abo) : null)),
        stripeCustomerId: abo.customer,
        stripeSubscriptionId: abo.id,
        majLe: FieldValue.serverTimestamp(),
      },
      rev: FieldValue.increment(1),
    });
    // Suspendue pour impayé puis arrêtée (C2) : pas de dernier mois en plus de la dette (prelevementDernierMois).
    if (statut === 'resilie' && actuel && actuel.statut === 'suspendu') {
      tx.set(db.doc(`commandes/${abo.id}`), { dernierMois: { statut: 'aucun', motif: 'famille suspendue pour impayé', le: FieldValue.serverTimestamp() } }, { merge: true });
    }
    return { avis: regles.avisPaiement(actuel, statut), graceJusqua, premiereFois: !(actuel && actuel.stripeSubscriptionId === abo.id) };
  });
  await db.doc(`commandes/${abo.id}`).set({ fid, statutStripe: abo.status }, { merge: true });
  await attendreRestitution(abo);
  if (abo.metadata.fid !== fid) {
    await stripe().subscriptions.update(abo.id, { metadata: { ...abo.metadata, fid } });
  }
  if (changement && changement.premiereFois) await promouvoirPayeur(fid, commande.exists ? commande.get('email') : null);
  if (changement && changement.avis) await prevenirPaiement(fid, abo.id, changement.avis, changement.graceJusqua);
}

// Celui qui a payé la commande devient responsable de la famille s'il en est un simple proche (B1, Tanguy
// 2026-10-27) : il voit l'abonnement et peut résilier. Le propriétaire reste celui qui a installé.
async function promouvoirPayeur(fid, email) {
  if (!email) return;
  const membres = await db.collection(`families/${fid}/members`).where('email', '==', String(email).toLowerCase()).get();
  const ref = db.doc(`families/${fid}`);
  await db.runTransaction(async (tx) => {
    const fam = await tx.get(ref);
    if (!fam.exists) return;
    const admins = fam.get('admins') || [];
    const nouveaux = membres.docs
      .filter((m) => m.get('role') === 'famille' && (m.get('status') || 'active') === 'active')
      .map((m) => m.id).filter((uid) => uid !== fam.get('createdBy') && !admins.includes(uid));
    if (!nouveaux.length || admins.length + nouveaux.length > 10) return;
    tx.update(ref, { admins: [...admins, ...nouveaux] });
  });
}

// Paiement échoué ou Papote en pause (C1) : notification aux responsables et e-mail à l'adresse de la commande.
// Avant, personne n'était prévenu par Papote (la tablette disait pourtant « la famille a été prévenue »).
async function prevenirPaiement(fid, commandeId, avis, graceJusqua) {
  try {
    const [fam, commande] = await Promise.all([db.doc(`families/${fid}`).get(), db.doc(`commandes/${commandeId}`).get()]);
    if (!fam.exists) return;
    const nom = fam.get('name') || 'Mamie';
    const responsables = [...new Set([fam.get('createdBy'), ...(fam.get('admins') || [])].filter(Boolean))];
    const pauseLe = graceJusqua || Date.now() + regles.DELAI_GRACE_JOURS * 24 * 3600e3;
    const notification = avis === 'impaye'
      ? { titre: 'Le paiement de Papote a échoué', texte: `La tablette de ${nom} se mettra en pause le ${mail.dateEnClair(pauseLe)}. Touchez pour régler.` }
      : { titre: 'Papote est en pause', texte: `L'abonnement de ${nom} n'a pas été réglé. Touchez pour régler : tout reviendra.` };
    const envois = [push.envoyer(db, fid, responsables, { type: 'alerte', ...notification, fid, abonnement: '1' }, 24 * 3600)];
    const email = commande.exists && commande.get('email');
    if (email) {
      const infos = { nom: commande.get('nom'), famille: fam.get('name'), pauseLe, lien: APPLI_FAMILLE };
      envois.push(envoyerMail(email, avis === 'impaye' ? mail.paiementEchoue(infos) : mail.papoteEnPause(infos)));
    }
    (await Promise.allSettled(envois)).filter((r) => r.status === 'rejected')
      .forEach((r) => logger.error(`Famille ${fid} : avis « ${avis} » non envoyé`, r.reason));
  } catch (e) {
    logger.error(`Famille ${fid} : avis « ${avis} »`, e.message);
  }
}

// Commande offerte (gestionCommandeOfferte, les mamies) reliée à sa famille, par la tablette ou par son code :
// pas d'abonnement Stripe, la famille passe « offerte » (jamais en pause). Un abonnement payant en cours l'emporte.
async function appliquerOfferte(fid, commande) {
  const ref = db.doc(`families/${fid}`);
  const reliee = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    if (['actif', 'impaye', 'suspendu'].includes(snap.get('abonnement.statut'))) {
      logger.warn(`Famille ${fid} : abonnement payant en cours, commande offerte ${commande.id} pas reliée.`);
      return false;
    }
    tx.update(ref, {
      'abonnement.statut': 'offert', 'abonnement.formule': commande.get('formule') || null,
      'abonnement.majLe': FieldValue.serverTimestamp(), 'abonnement.par': 'commande offerte',
      rev: FieldValue.increment(1),
    });
    return true;
  });
  if (reliee) {
    await commande.ref.update({ fid });
    await promouvoirPayeur(fid, commande.get('email'));
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
    // Toujours une réservation : les commandes ne ferment plus, seul le délai annoncé change (stock.js).
    const reservation = await reserverTablette();
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
  // Famille suspendue pour impayé : pas de deuxième abonnement (60 € de plus, dette oubliée) ; le paiement en
  // retard se règle dans le portail Stripe (C3, Tanguy 2026-10-27).
  if (fam.abonnement && fam.abonnement.statut === 'suspendu' && fam.abonnement.stripeSubscriptionId) {
    throw new HttpsError('failed-precondition', 'Réglez d\'abord le paiement en retard (« Gérer le paiement ») : tout reviendra automatiquement.');
  }
  // Résiliée, tablette encore chez le proche (retour attendu) : reprise sans mise en service, et le retour
  // attendu est annulé au paiement (relierTabletteInstallee).
  if (fam.abonnement && fam.abonnement.statut === 'resilie' && await tabletteARendre(fid)) {
    const session = await sessionPaiement({ formule, tablette, fid, email, client, dejaInstallee: true, reprise: true });
    return { url: session.url };
  }
  // Tablette déjà installée chez le proche (la famille naît au jumelage) : rien à envoyer, le premier
  // mois court dès aujourd'hui et le premier prélèvement tombe 30 jours plus tard.
  if (await tabletteInstallee(fid)) {
    const session = await sessionPaiement({ formule, tablette, fid, email, client, dejaInstallee: true });
    return { url: session.url };
  }
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

// Résiliation en ligne, sans engagement : l'abonnement s'arrête à la fin du mois en cours,
// qui est prélevé à l'arrêt (prelevementDernierMois).
exports.resilierAbonnement = onCall({ secrets: [STRIPE_SECRET, MAIL_MOT_DE_PASSE] }, async (request) => {
  const { fid } = request.data || {};
  const fam = await familleGeree(fid, request);
  const id = fam.abonnement && fam.abonnement.stripeSubscriptionId;
  if (!id) throw new HttpsError('failed-precondition', "Cette famille n'a pas d'abonnement.");
  const abo = await stripe().subscriptions.retrieve(id);
  const maintenant = Date.now();
  const le = regles.premierPrelevementDe(abo, maintenant) || regles.dateResiliation(finDePeriodeMs(abo), maintenant);
  await stripe().subscriptions.update(id, {
    cancel_at: Math.ceil(le / 1000),
    proration_behavior: 'none',
  });
  await appliquer(fid, id);
  return { le };
});

exports.annulerResiliation = onCall({ secrets: [STRIPE_SECRET, MAIL_MOT_DE_PASSE] }, async (request) => {
  const { fid } = request.data || {};
  const fam = await familleGeree(fid, request);
  const id = fam.abonnement && fam.abonnement.stripeSubscriptionId;
  if (!id) throw new HttpsError('failed-precondition', "Cette famille n'a pas d'abonnement.");
  await stripe().subscriptions.update(id, { cancel_at: '' });
  await appliquer(fid, id);
  return { ok: true };
});

// Hospitalisation du proche (Tanguy, 2026-10-22) : sur justificatif, l'admin met les prélèvements en pause
// jusqu'à une date (rien n'est prélevé pour les mois de pause, la tablette continue de marcher), ou les
// reprend plus tôt. Un décès, lui, est une résiliation comme une autre.
const PAUSE_MAX_JOURS = 186;
exports.pauseHospitalisation = onCall({ secrets: [STRIPE_SECRET] }, async (request) => {
  verifierAdmin(request);
  const { commande, jusqua } = request.data || {};
  if (typeof commande !== 'string' || !/^[A-Za-z0-9_]{5,80}$/.test(commande)) throw new HttpsError('invalid-argument', 'Commande manquante.');
  const ref = db.doc(`commandes/${commande}`);
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Commande introuvable.');
  let abo;
  try {
    abo = await stripe().subscriptions.retrieve(commande);
  } catch (e) {
    throw new HttpsError('failed-precondition', 'Stripe ne connaît pas cet abonnement (commande de test ?).');
  }
  if (jusqua == null) {
    await stripe().subscriptions.update(commande, { pause_collection: '' });
    await ref.update({ pause: FieldValue.delete() });
    return { ok: true, reprise: true };
  }
  const fin = Number(jusqua);
  if (!Number.isFinite(fin) || fin <= Date.now() || fin > Date.now() + PAUSE_MAX_JOURS * 24 * 3600e3) {
    throw new HttpsError('invalid-argument', 'Choisissez une date de reprise dans les 6 prochains mois.');
  }
  if (!['active', 'past_due'].includes(abo.status) || regles.premierPrelevementDe(abo, Date.now())) {
    throw new HttpsError('failed-precondition', 'Pause possible seulement pour un abonnement en cours (pas pendant les 30 premiers jours).');
  }
  await stripe().subscriptions.update(commande, {
    pause_collection: { behavior: 'void', resumes_at: Math.ceil(fin / 1000) },
  });
  await ref.update({ pause: { motif: 'hospitalisation', jusqua: Timestamp.fromMillis(fin), le: FieldValue.serverTimestamp() } });
  return { ok: true, jusqua: fin };
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

// Annulation dans les 30 jours : l'abonnement s'arrête tout de suite. Tablette pas encore partie :
// remboursement immédiat. Déjà partie : remboursement dès son retour (voir commandeModifiee).
exports.retracter = onCall({ secrets: [STRIPE_SECRET, MAIL_MOT_DE_PASSE] }, async (request) => {
  const { fid } = request.data || {};
  const { id, ref } = await commandeDeLaFamille(fid, request);
  const montant = await montantPaye(id);
  const maintenant = Date.now();
  const partie = await db.runTransaction(async (tx) => {
    const c = (await tx.get(ref)).data();
    if (!regles.retractationPossible(c, maintenant)) {
      throw new HttpsError('failed-precondition', 'Le délai de 30 jours pour annuler la commande est dépassé.');
    }
    // Paiement SEPA pas encore confirmé : la tablette n'est pas partie non plus, rien à rendre.
    const envoyee = regles.materielParti(c);
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

  // Tablette déjà choisie pour cette commande dans l'admin (« Préparer l'envoi ») : de nouveau libre,
  // comme pour une annulation faite par l'admin (gestionAnnulerCommande).
  const tablettes = await db.collection('stock').where('commande', '==', id).get();
  await Promise.all(tablettes.docs.filter((t) => ['en-stock', 'preparee'].includes(t.get('etat'))).map((t) => t.ref.update({
    commande: null, majLe: FieldValue.serverTimestamp(),
    historique: FieldValue.arrayUnion({ le: maintenant, etat: t.get('etat'), par: 'client', commande: null, motif: 'commande annulée par le client' }),
  })));
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
      jusqua: c.expedition === 'a-preparer' ? null : regles.limiteRetractation(ms(c.creeLe), ms(c.envoyeeLe), regles.receptionDe(c)),
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

exports.rattacherCommande = onCall({ secrets: [STRIPE_SECRET, MAIL_MOT_DE_PASSE] }, async (request) => {
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
      } else if (['invoice.paid', 'invoice.payment_failed', 'payment_intent.payment_failed'].includes(event.type)) {
        await paiementAPart(event.type, event.data.object);
      } else if (event.type === 'charge.dispute.created') {
        await contestation(event.data.object);
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
      // Abonnement pris dans l'appli avec la tablette déjà chez le proche : rien à envoyer, reçue aujourd'hui.
      ...(meta.dejaInstallee === '1' ? {
        expedition: 'envoyee', envoyeeLe: FieldValue.serverTimestamp(),
        preparation: { recuLe: Date.now(), recuPar: 'déjà installée' },
      } : {}),
      // Reprise d'un abonnement résilié (C3) : pas de mise en service, pas de délai pour changer d'avis.
      ...(meta.reprise === '1' ? { reprise: true } : {}),
      delai: meta.delai || null,
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
  await verifierDoublon(ref, session, email).catch((e) => logger.warn(`Commande ${ref.id} : doublon non vérifié`, e.message));
  if (!paye) return;
  // Commande annulée pendant que la banque confirmait le prélèvement SEPA : remboursée, pas confirmée.
  if (existante.exists && existante.get('expedition') === 'annulee') {
    await paiementApresAnnulation(ref, existante);
    return;
  }
  if (existante.exists && existante.get('expedition') === 'paiement-en-attente' && meta.dejaInstallee !== '1') await ref.update({ expedition: 'a-preparer' });
  const fid = meta.fid || (existante.exists && existante.get('fid')) || await chercherFamille(email);
  if (fid) await appliquer(fid, session.subscription);
  if (fid && meta.dejaInstallee === '1') await relierTabletteInstallee(fid, session.subscription, { reprise: meta.reprise === '1' });
  await confirmerCommande(ref, email, code);
}

// Le prélèvement SEPA d'une commande annulée entre-temps (client ou admin) a fini par passer : l'argent
// est rendu tout de suite (rejouable sans double remboursement) et Papote est prévenu.
async function paiementApresAnnulation(ref, snap) {
  let detail;
  try {
    const rembourse = await rembourser(ref.id);
    await ref.update({ remboursement: { statut: 'fait', montant: rembourse, le: FieldValue.serverTimestamp() } });
    detail = `${mail.euros(rembourse)} remboursés automatiquement`;
  } catch (e) {
    logger.error(`Commande ${ref.id} : remboursement après annulation refusé`, e.message);
    await ref.update({ 'remboursement.statut': 'echec', 'remboursement.erreur': e.message });
    detail = 'le remboursement automatique a échoué : à faire à la main dans Stripe';
  }
  await prevenirPapote(`Paiement reçu pour une commande annulée : ${snap.get('nom') || snap.get('email') || ref.id}`, snap,
    `La banque a confirmé le prélèvement SEPA d'une commande déjà annulée : ${detail}. Aucune tablette à envoyer.`);
}

// Client qui recommande : même IBAN ou même carte (empreinte Stripe), e-mail, téléphone ou adresse qu'une autre commande.
// commandes/{id}.alerteDoublon = { commandes: [{ id, code, nom }], mauvaisPayeur, raisons } ; l'admin le montre
// avant l'envoi (Tanguy, 2026-10-22), et un mauvais payeur déclenche aussi un e-mail à Papote. Rien n'est bloqué.
const normaliser = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
async function verifierDoublon(ref, session, email) {
  if ((await ref.get()).get('alerteDoublon')) return;
  const details = session.customer_details || {};
  const abo = await stripe().subscriptions.retrieve(session.subscription, { expand: ['default_payment_method'] });
  const pm = abo.default_payment_method && typeof abo.default_payment_method === 'object' ? abo.default_payment_method : null;
  const a = details.address || {};
  const empreinte = {
    iban: (pm && pm.sepa_debit && pm.sepa_debit.fingerprint) || null,
    ibanFin: (pm && pm.sepa_debit && pm.sepa_debit.last4) || null,
    // Même carte bancaire qu'une autre commande (empreinte Stripe, pas le numéro).
    carte: (pm && pm.card && pm.card.fingerprint) || null,
    carteFin: (pm && pm.card && pm.card.last4) || null,
    // Nom du titulaire du compte, affiché dans l'admin à côté de celui qui commande (souvent un proche).
    titulaire: (pm && pm.billing_details && pm.billing_details.name) || null,
    telephone: details.phone ? normaliser(details.phone).slice(-9) : null,
    adresse: a.line1 && a.postal_code ? `${normaliser(a.line1)}|${normaliser(a.postal_code)}` : null,
  };
  await ref.update({ empreinte });
  const requetes = [
    empreinte.iban && db.collection('commandes').where('empreinte.iban', '==', empreinte.iban).get(),
    empreinte.carte && db.collection('commandes').where('empreinte.carte', '==', empreinte.carte).get(),
    email && db.collection('commandes').where('email', '==', email).get(),
    empreinte.telephone && db.collection('commandes').where('empreinte.telephone', '==', empreinte.telephone).get(),
    empreinte.adresse && db.collection('commandes').where('empreinte.adresse', '==', empreinte.adresse).get(),
  ].filter(Boolean);
  const autres = new Map();
  for (const r of await Promise.all(requetes)) {
    for (const d of r.docs) {
      const c = d.data();
      // Une commande annulée avant l'envoi ne compte pas.
      if (d.id !== ref.id && !(c.expedition === 'annulee' && !c.envoyeeLe) && !c.offerte) autres.set(d.id, c);
    }
  }
  if (!autres.size) return;
  const raisons = new Set();
  for (const c of autres.values()) {
    const fam = c.fid ? await db.doc(`families/${c.fid}`).get() : null;
    regles.raisonsMauvaisPayeur(c, fam && fam.exists ? fam.get('abonnement.statut') : null).forEach((x) => raisons.add(x));
  }
  const alerte = {
    commandes: [...autres].map(([id, c]) => ({ id, code: c.code ? regles.afficherCode(c.code) : null, nom: c.nom || c.email || null })),
    mauvaisPayeur: raisons.size > 0,
    raisons: [...raisons],
  };
  await ref.update({ alerteDoublon: alerte });
  if (alerte.mauvaisPayeur) {
    const snap = await ref.get();
    await prevenirPapote(`Ne pas envoyer : ${snap.get('nom') || email || 'un client'} a déjà été mauvais payeur`, snap,
      `Nouvelle commande d'un client déjà connu (${alerte.raisons.join(', ')}). Vérifiez avant d'envoyer la tablette.`);
  }
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

// Prélèvements faits hors de l'abonnement : le dernier mois (facture « dernierMois ») et le matériel non
// rendu (paiement « non rendu »). En SEPA, la banque peut refuser quelques jours après : l'admin le voit
// dans « À faire » (dernierMois.statut ou restitution.statut « echec »).
async function paiementAPart(type, objet) {
  const meta = objet.metadata || {};
  if (!meta.commande || !/^[A-Za-z0-9_]{5,80}$/.test(meta.commande)) return;
  const ref = db.doc(`commandes/${meta.commande}`);
  const snap = await ref.get();
  if (!snap.exists) return;
  if (type.startsWith('invoice.') && meta.dernierMois === '1') {
    const echec = type === 'invoice.payment_failed';
    await ref.update({
      'dernierMois.statut': echec ? 'echec' : 'fait',
      'dernierMois.erreur': echec ? erreurPaiement(objet.last_finalization_error || null) || 'Prélèvement refusé par la banque' : FieldValue.delete(),
    });
    if (echec) await prevenirPapote(`Dernier mois non prélevé : ${snap.get('nom') || snap.get('email') || snap.id}`, snap);
  } else if (type === 'payment_intent.payment_failed' && /non rendu/.test(objet.description || '')) {
    if (!snap.get('restitution')) return;
    await ref.update({
      'restitution.statut': 'echec',
      'restitution.erreur': erreurPaiement(objet.last_payment_error) || 'Prélèvement refusé par la banque',
      'restitution.majLe': FieldValue.serverTimestamp(),
    });
    await prevenirPapote(`Prélèvement du matériel refusé : ${snap.get('nom') || snap.get('email') || snap.id}`, snap);
  }
}

const erreurPaiement = (e) => (e && (e.message || e.code)) || null;

// Prélèvement contesté par le client auprès de sa banque (SEPA : 8 semaines sans motif, 13 mois sinon).
async function contestation(litige) {
  let commande = null;
  try {
    const pi = litige.payment_intent && await stripe().paymentIntents.retrieve(
      typeof litige.payment_intent === 'string' ? litige.payment_intent : litige.payment_intent.id, { expand: ['invoice'] });
    commande = (pi && pi.metadata && pi.metadata.commande)
      || (pi && pi.invoice && typeof pi.invoice === 'object' && (pi.invoice.subscription || (pi.invoice.metadata || {}).commande)) || null;
  } catch (e) {
    logger.warn('Contestation : paiement illisible', e.message);
  }
  if (typeof commande === 'object' && commande) commande = commande.id;
  const ref = commande ? db.doc(`commandes/${commande}`) : null;
  const snap = ref ? await ref.get() : null;
  if (snap && snap.exists) {
    await ref.update({ contestations: FieldValue.arrayUnion({
      id: litige.id, montant: litige.amount, motif: litige.reason || null, le: Date.now(),
    }) });
  }
  await prevenirPapote(`Prélèvement contesté (${mail.euros(litige.amount)}) : ${snap && snap.exists ? snap.get('nom') || snap.get('email') || snap.id : 'commande inconnue'}`,
    snap && snap.exists ? snap : null, 'Le client a contesté un prélèvement auprès de sa banque. L\'argent est repris par la banque : voir la commande dans l\'admin et le litige dans Stripe.');
}

async function prevenirPapote(titre, snap, detail) {
  try {
    await envoyerMail(EMAIL_PAPOTE, mail.alerteAdmin({
      titre, detail: detail || 'Voir la commande dans l\'admin (À faire).', commande: snap ? snap.id : null,
    }));
  } catch (e) {
    logger.error(`Alerte non envoyée : ${titre}`, e.message);
  }
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
  const infos = { nom: premier.nom, code, relais: premier.livraison, formule: premier.formule, delai: premier.delai,
    dejaInstallee: !!(premier.preparation && premier.preparation.recuPar === 'déjà installée'), reprise: premier.reprise === true };
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
    await envoyerMail(email, mail.lancement({ prenom: 'Tanguy', desinscription: `${URL_DESINSCRIPTION}?test=1` }));
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
  await prelevementDernierMois(abo);
}

// Paiement du mois écoulé : l'abonnement Stripe est prélevé d'avance après un premier mois sans
// prélèvement, donc le dernier mois utilisé (celui qui vient de finir) reste dû à l'arrêt.
// Seulement pour une résiliation (pas une commande annulée dans les 30 jours, ni un impayé).
// Une seule fois par commande (dernierMois noté dans commandes/{id}).
async function prelevementDernierMois(abo) {
  if (abo.status !== 'canceled') return;
  if (!(abo.cancellation_details && abo.cancellation_details.reason === 'cancellation_requested')) return;
  const item = ((abo.items && abo.items.data) || []).find((i) => i.price && i.price.recurring);
  if (!item || !item.price.unit_amount) return;
  const montant = item.price.unit_amount * (item.quantity || 1);
  const ref = db.doc(`commandes/${abo.id}`);
  // Famille suspendue pour impayé dont Tanguy arrête l'abonnement (C2) : pas de dernier mois en plus de la dette.
  const commandeDoc = await ref.get();
  const famille = commandeDoc.exists && commandeDoc.get('fid') ? await db.doc(`families/${commandeDoc.get('fid')}`).get() : null;
  if (famille && famille.exists && famille.get('abonnement.statut') === 'suspendu') {
    logger.info(`Commande ${abo.id} : famille suspendue, pas de dernier mois.`);
    return;
  }
  const aPrelever = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const c = snap.exists ? snap.data() : {};
    if (c.dernierMois || c.retractation || c.offerte || ['a-preparer', 'paiement-en-attente', 'annulee'].includes(c.expedition)) return false;
    tx.set(ref, { dernierMois: { statut: 'en-cours', montant, le: FieldValue.serverTimestamp() } }, { merge: true });
    return true;
  });
  if (!aPrelever) return;
  try {
    const client = typeof abo.customer === 'string' ? abo.customer : abo.customer.id;
    const moyen = abo.default_payment_method
      && (typeof abo.default_payment_method === 'string' ? abo.default_payment_method : abo.default_payment_method.id);
    await stripe().invoiceItems.create({
      customer: client, amount: montant, currency: item.price.currency,
      description: 'Dernier mois d\'abonnement Papote (mois écoulé)', metadata: { commande: abo.id },
    }, { idempotencyKey: `dernier-mois-ligne-${abo.id}` });
    const facture = await stripe().invoices.create({
      customer: client, collection_method: 'charge_automatically', pending_invoice_items_behavior: 'include',
      ...(moyen ? { default_payment_method: moyen } : {}), metadata: { commande: abo.id, dernierMois: '1' },
    }, { idempotencyKey: `dernier-mois-facture-${abo.id}` });
    await stripe().invoices.finalizeInvoice(facture.id);
    // Prélèvement SEPA : la banque confirme (ou refuse) quelques jours plus tard, voir paiementAPart.
    const payee = await stripe().invoices.pay(facture.id)
      .catch((e) => { logger.warn(`Commande ${abo.id} : dernier mois en attente`, e.message); return null; });
    await ref.update({ 'dernierMois.statut': payee && payee.status === 'paid' ? 'fait' : 'en-attente', 'dernierMois.facture': facture.id });
  } catch (e) {
    logger.error(`Commande ${abo.id} : dernier mois non prélevé`, e.message);
    await ref.update({ 'dernierMois.statut': 'echec', 'dernierMois.erreur': e.message });
  }
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
  { schedule: 'every 1 hours', timeZone: 'Europe/Paris', secrets: [MAIL_MOT_DE_PASSE] },
  async () => {
    const maintenant = Date.now();
    const impayes = await db.collection('families').where('abonnement.statut', '==', 'impaye').get();
    for (const snap of impayes.docs) {
      if (!regles.graceDepassee(snap.get('abonnement'), maintenant)) continue;
      await snap.ref.update({
        'abonnement.statut': 'suspendu',
        'abonnement.suspenduLe': Timestamp.fromMillis(maintenant),
        'abonnement.majLe': FieldValue.serverTimestamp(),
        rev: FieldValue.increment(1),
      });
      logger.info(`Famille ${snap.id} suspendue : délai de grâce dépassé.`);
      // La famille est prévenue (C1) : la tablette affiche « la famille a été prévenue ».
      await prevenirPaiement(snap.id, snap.get('abonnement.stripeSubscriptionId'), 'suspendu', null);
    }
    // Installation finie sans commande reliée (B3) : 48 h de tolérance, puis « aucun » (Papote en pause).
    const tolerees = await db.collection('families').where('abonnement.statut', '==', 'installation').get();
    for (const snap of tolerees.docs) {
      if (!regles.toleranceDepassee(snap.get('abonnement'), maintenant)) continue;
      await snap.ref.update({
        abonnement: { statut: 'aucun', majLe: FieldValue.serverTimestamp() },
        rev: FieldValue.increment(1),
      });
      logger.warn(`Famille ${snap.id} : toujours aucune commande reliée 48 h après l'installation, Papote en pause.`);
    }
  });

// Tablette incluse non rendue dans les 30 jours : le matériel prêté (abonnement.js, penaliteRestitution) prélevé sur le compte de l'abonnement.
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
      // Jamais de prélèvement pour une tablette qui n'est pas partie (commande annulée avant l'envoi).
      if (!regles.materielParti(snap.data())) {
        logger.warn(`Commande ${snap.id} : retour attendu mais tablette jamais envoyée, rien prélevé.`);
        continue;
      }
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
// Même règle que isAdmin() des règles Firestore et que gestion.js : le badge admin seulement.
function verifierAdmin(request) {
  const token = request.auth && request.auth.token;
  const estAdmin = token && token.admin === true;
  if (!estAdmin) throw new HttpsError('permission-denied', 'Réservé à l\'administrateur.');
}

// manquants (facultatif) : éléments absents du colis retour, parmi 'tablette', 'chargeur', 'enceinte'.
// Chacun est prélevé à son prix (tablette 130 €, chargeur et câble 10 €, enceinte 10 €).
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
  { document: 'families/{fid}/members/{uid}', database: BASE_FIRESTORE, region: REGION_FIRESTORE, secrets: [STRIPE_SECRET, MAIL_MOT_DE_PASSE] },
  async (event) => {
    const membre = event.data.data();
    const { fid, uid } = event.params;
    if (membre.status === 'pending') {
      await prevenirDemande(fid, uid, membre);
      return;
    }
    if (membre.role !== 'famille' || !membre.email) return;
    const fam = await db.doc(`families/${fid}`).get();
    if (!fam.exists) return;
    if (fam.get('createdBy') !== uid) {
      await prevenirArrivee(fid, uid, membre, fam);
      // Celui qui a payé la commande de cette famille arrive après l'installation : responsable (B1).
      const payee = await db.collection('commandes').where('fid', '==', fid).where('email', '==', membre.email.toLowerCase()).limit(1).get();
      if (!payee.empty) await promouvoirPayeur(fid, membre.email);
      return;
    }
    // Secours seulement : la commande se relie normalement par la tablette (n° de série du jumelage,
    // gestion.js appliquerJumelage), car celui qui installe n'est pas forcément celui qui a payé. L'e-mail ne
    // sert que s'il désigne une seule commande pas encore reliée et dont aucune tablette installée n'est connue.
    const commandes = await db.collection('commandes')
      .where('email', '==', membre.email.toLowerCase()).where('fid', '==', null).limit(2).get();
    if (commandes.size !== 1) return;
    const id = commandes.docs[0].id;
    const tablettes = await db.collection('stock').where('commande', '==', id).get();
    if (tablettes.docs.some((t) => t.get('serieAndroid'))) return;
    await appliquer(fid, id);
  });

// Quelqu'un demande à rejoindre la famille (fiche « pending ») : les responsables (createdBy + admins)
// reçoivent une notification et un e-mail, une seule fois (limites/demande-{fid}-{uid}, créé une fois).
// Notification : { type: 'demande' } pour l'app web (sw.js) ; l'app Android ne connaît que « alerte ».
async function prevenirDemande(fid, uid, membre) {
  try {
    await db.doc(`limites/demande-${fid}-${uid}`).create({ le: FieldValue.serverTimestamp() });
  } catch (e) {
    if (e.code === 6) return; // déjà prévenu (événement renvoyé)
    throw e;
  }
  const fam = await db.doc(`families/${fid}`).get();
  if (!fam.exists) return;
  const responsables = [...new Set([fam.get('createdBy'), ...(fam.get('admins') || [])])].filter((r) => r && r !== uid);
  if (!responsables.length) return;
  const prenom = membre.name || 'Quelqu\'un';
  const titre = `${prenom} veut rejoindre la famille`;
  const texte = 'Touchez pour accepter ou refuser';
  const envois = [
    push.envoyer(db, fid, responsables, { type: 'demande', titre, texte, fid }, 86400, { websSeulement: true }),
    push.envoyer(db, fid, responsables, { type: 'alerte', titre, texte }, 86400, { natifsSeulement: true }),
  ];
  const comptes = await Promise.all(responsables.map((r) => admin.auth().getUser(r).catch(() => null)));
  const contenu = mail.demandeRejoindre({ prenom: membre.name, email: membre.email, famille: fam.get('name') });
  comptes.filter((c) => c && c.email).forEach((c) => envois.push(envoyerMail(c.email, contenu)));
  (await Promise.allSettled(envois)).filter((r) => r.status === 'rejected')
    .forEach((r) => logger.error(`Demande ${fid}/${uid} : prévenir les responsables`, r.reason));
}

// Un proche invité par e-mail est entré directement : les responsables reçoivent une notification.
async function prevenirArrivee(fid, uid, membre, fam) {
  const responsables = [...new Set([fam.get('createdBy'), ...(fam.get('admins') || [])])].filter((r) => r && r !== uid);
  if (!responsables.length) return;
  const titre = `${membre.name || 'Un proche'} a rejoint la famille`;
  const texte = 'Invitation acceptée : rien à faire de votre côté.';
  const envois = [
    push.envoyer(db, fid, responsables, { type: 'arrivee', titre, texte, fid }, 86400, { websSeulement: true }),
    push.envoyer(db, fid, responsables, { type: 'alerte', titre, texte }, 86400, { natifsSeulement: true }),
  ];
  (await Promise.allSettled(envois)).filter((r) => r.status === 'rejected')
    .forEach((r) => logger.error(`Arrivée ${fid}/${uid} : prévenir les responsables`, r.reason));
}

// ---------- Envoi de la tablette ----------

// Le tableau de bord admin note le départ du colis : { commande, suivi } (numéro Mondial Relay).
// Corriger un numéro déjà saisi renvoie l'e-mail avec le bon lien.
// { commande, mainPropre: true } : tablette remise en main propre par Tanguy (A1, 2026-10-27) : pas de colis,
// reçue le jour même, les 30 jours pour changer d'avis et le premier prélèvement partent d'aujourd'hui.
exports.tabletteEnvoyee = onCall(async (request) => {
  verifierAdmin(request);
  const { commande, mainPropre } = request.data || {};
  const suivi = livraison.normaliserSuivi((request.data || {}).suivi);
  if (typeof commande !== 'string' || !commande) throw new HttpsError('invalid-argument', 'Commande manquante.');
  if (!suivi && mainPropre !== true) throw new HttpsError('invalid-argument', 'Numéro de suivi invalide.');
  const ref = db.doc(`commandes/${commande}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Commande introuvable.');
  if (mainPropre === true) {
    if (snap.get('expedition') === 'envoyee') throw new HttpsError('failed-precondition', 'Cette commande est déjà envoyée.');
    const maintenant = Date.now();
    await ref.update({
      expedition: 'envoyee', remise: 'main-propre', suivi: FieldValue.delete(),
      envoyeeLe: Timestamp.fromMillis(maintenant), rappels: snap.get('rappels') || 0,
      'preparation.recuLe': maintenant, 'preparation.recuPar': 'remise en main propre',
    });
    return { ok: true, lien: null };
  }
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
    await debutApresReception(event, avant, apres);
    await suiviRetour(event, avant.restitution || {}, apres.restitution || {}, apres);
  });

// Tablette partie : le premier mois commence à la réception (estimée à l'envoi + 3 jours, puis recalée sur
// la vraie date dès qu'on la connaît : preparation.recuLe). Le premier prélèvement tombe à la fin des
// 30 jours pour changer d'avis (même date que limiteRetractation), pas avant.
async function debutApresReception(event, avant, apres) {
  if (!apres.envoyeeLe || !apres.stripeCustomerId) return;
  const recue = regles.receptionDe(apres);
  if (avant.envoyeeLe && (recue == null || recue === regles.receptionDe(avant))) return;
  const fin = regles.limiteRetractation(apres.creeLe && apres.creeLe.toMillis(), apres.envoyeeLe.toMillis(), recue);
  if (fin <= Date.now() + 60 * 60 * 1000) return;
  try {
    const abo = await stripe().subscriptions.retrieve(event.params.id);
    // Un mois déjà prélevé : rien à recaler. Sinon, « trial » jusqu'à la date voulue (Stripe y recale aussi le
    // début des mois, billing_cycle_anchor).
    const premier = regles.premierPrelevementDe(abo, Date.now());
    if (!premier || Math.abs(premier - fin) < 60 * 60 * 1000) return;
    await stripe().subscriptions.update(event.params.id, { trial_end: Math.ceil(fin / 1000), proration_behavior: 'none' });
  } catch (e) {
    logger.error(`Commande ${event.params.id} : début de l'abonnement non recalé`, e.message);
  }
}

async function mailEnvoi(event, avant, apres) {
  if (apres.expedition !== 'envoyee' || !apres.email) return;
  // Remise en main propre (A1) : « votre tablette est chez vous », une fois, sans lien de suivi.
  if (apres.remise === 'main-propre') {
    if (avant.remise === 'main-propre' || apres.mailEnvoiLe) return;
    try {
      await envoyerMail(apres.email, mail.tabletteRemise({ nom: apres.nom, code: apres.code ? regles.afficherCode(apres.code) : null }));
      await event.data.after.ref.update({ mailEnvoiLe: FieldValue.serverTimestamp(), mailErreur: FieldValue.delete() });
    } catch (e) {
      logger.error(`Commande ${event.params.id} : e-mail de remise non parti`, e.message);
      await event.data.after.ref.update({ mailErreur: e.message });
    }
    return;
  }
  if (!apres.suivi) return;
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

// « X a résilié son abonnement » à Papote, avec le suivi du colis de retour s'il existe déjà.
async function avisResiliation(id, c, retractation) {
  const retour = (c.etiquettes && c.etiquettes.retour) || {};
  try {
    await envoyerMail(EMAIL_PAPOTE, mail.resiliation({
      nom: c.nom, email: c.email, code: c.code ? regles.afficherCode(c.code) : null, commande: id, retractation,
      suivi: retour.suivi || null, lienSuivi: retour.lienSuivi || null,
    }));
  } catch (e) {
    logger.error(`Commande ${id} : avis de résiliation non parti`, e.message);
  }
}

async function suiviRetour(event, rAvant, r, c) {
  const ref = event.data.after.ref;
  const id = event.params.id;
  const retractation = c.remboursement && c.remboursement.statut === 'au-retour' ? c.remboursement.montant : null;

  // Tablette attendue : le client reçoit UN seul e-mail, le mode d'emploi avec l'étiquette à coller. Avec la
  // vraie clé Stripe, l'étiquette est créée la nuit suivante (gestionAutomatique) et cet e-mail part avec elle
  // (plus bas). En mode test, aucune étiquette n'est créée : le mode d'emploi part seul, tout de suite.
  if (r.statut === 'attendue' && rAvant.statut !== 'attendue' && !r.mailLe) {
    await ref.update({ 'restitution.mailLe': FieldValue.serverTimestamp() });
    const etiquetteAutomatique = STRIPE_SECRET.value().startsWith('sk_live_') && c.expedition === 'envoyee';
    // L'avis à Papote part avec le suivi du colis de retour quand l'étiquette sera créée (plus bas) ;
    // sans étiquette automatique (mode test), il part tout de suite, sans suivi.
    if (!etiquetteAutomatique) await avisResiliation(id, c, retractation);
    if (c.email && !r.etiquette && !etiquetteAutomatique) {
      try {
        await envoyerMail(c.email, mail.retourTablette({ nom: c.nom, avant: r.avant.toMillis(), retractation, montant: regles.penaliteRestitution(c) }));
      } catch (e) {
        logger.error(`Commande ${id} : e-mail de retour non parti`, e.message);
      }
    }
  }

  const finDeContrat = ['attendue', 'echec'].includes(r.statut);
  if (r.etiquette && r.etiquette !== rAvant.etiquette && finDeContrat && !r.avisLe) {
    await ref.update({ 'restitution.avisLe': FieldValue.serverTimestamp() });
    await avisResiliation(id, c, retractation);
  }

  if (r.etiquette && r.etiquette !== rAvant.etiquette && c.email) {
    try {
      await envoyerMail(c.email, mail.etiquetteRetour({
        nom: c.nom, lien: r.etiquette, avant: r.avant ? r.avant.toMillis() : null,
        fin: ['attendue', 'echec'].includes(r.statut), retractation, montant: regles.penaliteRestitution(c),
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
    // Commande offerte (famille supprimée, matériel repris par Papote) : pas d'e-mail au proche.
    if (!c.email || c.offerte) return;
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
        // Tanguy prévenu par e-mail (A3) : le premier prélèvement tombe dans 13 jours, à lui d'appeler le client.
        await prevenirPapote(`Tablette pas installée 20 jours après l'envoi : ${c.nom || c.email || snap.id}`, snap,
          'La tablette est partie il y a 20 jours et n\'est toujours pas reliée à une famille. Appelez le client avant le premier prélèvement (33 jours après l\'envoi). Colis revenu chez vous ? « Colis revenu » sur la commande l\'annule et rembourse les 60 €.');
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
exports.gestionCommandeOfferte = gestion.gestionCommandeOfferte;
exports.gestionAnnulerCommande = gestion.gestionAnnulerCommande;
exports.gestionParcours = gestion.gestionParcours;
exports.gestionRenvoyerCode = gestion.gestionRenvoyerCode;
exports.gestionJumelage = gestion.gestionJumelage;

// Installation d'une nouvelle tablette depuis le téléphone du premier proche (installation.js).
const installation = require('./installation').brancher({
  db, compteVerifie, envoyerMail, mail, appli: APPLI_FAMILLE, logger, stockage: () => admin.storage().bucket(base.BUCKET_STORAGE),
  // B3 : une seule commande en attente à l'e-mail d'un membre → reliée ; sinon Tanguy est prévenu.
  relierParEmail: async (fid, emails) => {
    const lots = [];
    for (let i = 0; i < emails.length; i += 10) lots.push(emails.slice(i, i + 10));
    const trouvees = new Map();
    for (const lot of lots) {
      const r = await db.collection('commandes').where('email', 'in', lot).where('fid', '==', null).get();
      r.docs.filter((d) => d.get('expedition') !== 'annulee').forEach((d) => trouvees.set(d.id, d));
    }
    if (trouvees.size !== 1) return trouvees.size;
    await appliquer(fid, [...trouvees.keys()][0]);
    return 1;
  },
  prevenirPapote: (titre, detail) => prevenirPapote(titre, null, detail),
  notifier: (fid, uids, data) => push.envoyer(db, fid, uids, data, 24 * 3600),
});
exports.reserverTablette = onCall({ maxInstances: 2 }, installation.reserverTablette);
exports.nommerFamille = onCall({ secrets: [MAIL_MOT_DE_PASSE], maxInstances: 2 }, installation.nommerFamille);
exports.finirInstallation = onCall({ secrets: [MAIL_MOT_DE_PASSE], maxInstances: 2 }, installation.finirInstallation);
exports.annulerInstallation = onCall({ timeoutSeconds: 300, memory: '512MiB', maxInstances: 2 }, installation.annulerInstallation);

// « N téléphones reçoivent les appels » dans l'appli (D1, Tanguy 2026-10-27) : les jetons sont privés
// (members/{uid}/private/push), l'appli ne peut pas les lire pour les autres ; le serveur pose
// members/{uid}.recoitAppels (vrai si au moins un jeton, navigateur ou app Android) à chaque écriture.
exports.telephoneAppels = onDocumentWritten(
  { document: 'families/{fid}/members/{uid}/private/push', database: BASE_FIRESTORE, region: REGION_FIRESTORE },
  async (event) => {
    const apres = event.data && event.data.after;
    const recoit = Boolean(apres && apres.exists && ((apres.get('tokens') || []).length || (apres.get('natifs') || []).length));
    const membre = db.doc(`families/${event.params.fid}/members/${event.params.uid}`);
    try {
      const snap = await membre.get();
      if (!snap.exists || Boolean(snap.get('recoitAppels')) === recoit) return;
      await membre.update({ recoitAppels: recoit });
    } catch (e) {
      if (e.code !== 5) throw e;
    }
  });

// Nombre de proches d'une famille (membres « famille » qui ont rejoint), lu par les règles
// Firestore pour refuser un 31e proche. Recalculé seulement quand un proche arrive, part ou est accepté :
// pas aux battements de la tablette (2 à 3 écritures toutes les 10 min), qui relisaient toute la famille.
const estProche = (snap) => Boolean(snap && snap.exists && snap.get('role') === 'famille' && snap.get('status') !== 'pending');
exports.compterProches = onDocumentWritten(
  { document: 'families/{fid}/members/{uid}', database: BASE_FIRESTORE, region: REGION_FIRESTORE },
  async (event) => {
    if (estProche(event.data && event.data.before) === estProche(event.data && event.data.after)) return;
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

// Voix des messages et des rappels sur la tablette : son créé une fois, rejoué autant qu'il faut (voix.js).
const voix = require('./voix');
exports.voixEnvoi = onDocumentWritten(
  { document: 'families/{fid}/posts/{pid}', database: BASE_FIRESTORE, region: REGION_FIRESTORE, maxInstances: 3 },
  async (event) => {
    const apres = event.data && event.data.after;
    if (!apres || !apres.exists) return;
    const data = apres.data();
    const chemin = apres.ref.path;
    if (data.type === 'reply') { console.log(`Voix ${chemin} : réponse de la tablette, rien à lire`); return; }
    try {
      const fait = await voix.voixDocument(db, apres.ref, data, 'text', data.authorUid, data.authorName);
      // Journal en texte simple (lisible avec « firebase functions:log »), sauf les relectures sans changement.
      if (fait !== 'déjà lu') console.log(`Voix ${chemin} (${data.type || '?'}) : ${fait}`);
    } catch (e) {
      // La tablette lira avec sa propre voix.
      console.error(`Voix ${chemin} : ÉCHEC ${e && e.message ? e.message : e}`);
    }
  });
exports.voixRappel = onDocumentWritten(
  { document: 'families/{fid}/reminders/{rid}', database: BASE_FIRESTORE, region: REGION_FIRESTORE, maxInstances: 3 },
  async (event) => {
    const apres = event.data && event.data.after;
    if (!apres || !apres.exists) return;
    try {
      // Rappels : l'auteur n'est noté que par son prénom, voix Kore.
      const fait = await voix.voixDocument(db, apres.ref, apres.data(), 'title', null);
      if (fait !== 'déjà lu') console.log(`Voix ${apres.ref.path} : ${fait}`);
    } catch (e) {
      console.error(`Voix ${apres.ref.path} : ÉCHEC ${e && e.message ? e.message : e}`);
    }
  });
