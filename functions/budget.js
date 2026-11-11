// Coupe-circuit de facturation : protège contre une facture Google Cloud qui s'emballe.
//
//   coupeCircuit  à chaque avis du budget Google Cloud (sujet Pub/Sub « budget-papote ») :
//                 30 € : e-mail d'alerte ; 100 € : e-mail « attention, coupure à 150 € » ;
//                 150 € : e-mail « coupure en cours », puis la facturation du projet est désactivée (tout s'arrête),
//                 puis e-mail de confirmation si les fonctions tournent encore.
//
// Google envoie l'avis du budget plusieurs fois par jour avec le coût du mois en cours (costAmount).
// Chaque palier n'est prévenu qu'une fois par mois (interne/budget dans la base, illisible côté client), et seulement
// compté quand l'e-mail est vraiment parti (traiterAvis). Le coût affiché
// par Google a quelques heures de retard : la coupure arrive donc un peu après 150 €.
//
// Réglage dans la console (une seule fois) : budget « Papote » de 150 € relié au sujet Pub/Sub
// « budget-papote », et le rôle « Gestionnaire de facturation de projet » donné au compte de
// service des fonctions. Pour tout relancer après une coupure : Facturation > Associer un compte.

const { onMessagePublished } = require('firebase-functions/v2/pubsub');
const { defineSecret, defineString } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const { db: base } = require('./base');
const mail = require('./mail');

const SUJET = 'budget-papote';
const PALIERS = { alerte: 30, avertissement: 100, coupure: 150 };
const ORDRE = ['alerte', 'avertissement', 'coupure'];
const EMAIL_PAPOTE = 'contact@mapapote.fr';

const MAIL_SMTP = defineString('MAIL_SMTP', { default: 'smtp.gmail.com:465:' });
const MAIL_EXPEDITEUR = defineString('MAIL_EXPEDITEUR', { default: '' });
const MAIL_MOT_DE_PASSE = defineSecret('MAIL_MOT_DE_PASSE');

// Palier le plus haut atteint par ce coût, ou null.
function palierAtteint(cout, paliers = PALIERS) {
  let atteint = null;
  for (const nom of ORDRE) if (cout >= paliers[nom]) atteint = nom;
  return atteint;
}

// Faut-il agir ? Seulement si le palier atteint est plus haut que le dernier prévenu ce mois-ci.
function aPrevenir(atteint, dejaPrevenu) {
  if (!atteint) return false;
  return ORDRE.indexOf(atteint) > ORDRE.indexOf(dejaPrevenu);
}

function message(palier, cout, devise, coupee = true) {
  const montant = `${cout.toFixed(2).replace('.', ',')} ${devise === 'EUR' ? '€' : devise}`;
  return mail.budget({ palier, montant, paliers: PALIERS, coupee });
}

// Retire le compte de facturation du projet (API Cloud Billing). Le compte de service des
// fonctions doit avoir le rôle « Gestionnaire de facturation de projet ».
async function couperFacturation(projet) {
  const { access_token: jeton } = await admin.credential.applicationDefault().getAccessToken();
  const url = `https://cloudbilling.googleapis.com/v1/projects/${projet}/billingInfo`;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${jeton}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ billingAccountName: '' }),
  });
  if (!r.ok) throw new Error(`Cloud Billing ${r.status} : ${await r.text()}`);
}

// Un avis du budget. Le palier est pris dans une transaction (deux avis en même temps : un seul agit), puis RENDU si
// rien n'a pu partir (audit des alertes, 11/11) : avant, un e-mail refusé (Brevo en panne, quota) laissait le palier
// noté, et plus rien ne repartait avant le palier suivant. Google renvoie l'avis plusieurs fois par jour : le tour
// suivant réessaie.
//   30 € et 100 €  e-mail ; s'il ne part pas, le palier est rendu et l'erreur remonte.
//   150 €          e-mail « coupure en cours » AVANT de couper (après, les fonctions peuvent être arrêtées), puis la
//                  coupure ; si elle échoue, e-mail urgent et palier rendu : chaque avis suivant réessaie de couper.
// outils : { fiche (document interne/budget), transaction(f), envoyer(contenu), couper(), journal } pour les tests.
async function traiterAvis(avis, outils) {
  const { fiche, transaction, envoyer, couper, journal } = outils;
  const cout = Number(avis.costAmount) || 0;
  const periode = String(avis.costIntervalStart || '').slice(0, 7); // « 2026-10 »
  const atteint = palierAtteint(cout);

  const avant = await transaction(async (t) => {
    const etat = (await t.get(fiche)).data() || {};
    const deja = etat.periode === periode ? etat.palier : null;
    if (!aPrevenir(atteint, deja)) return false;
    t.set(fiche, { periode, palier: atteint, cout, le: new Date() });
    return { etat };
  });
  if (!avant) return { fait: false };
  // Rien n'est parti : la fiche redevient ce qu'elle était, le prochain avis réessaie.
  const rendre = () => (Object.keys(avant.etat).length ? fiche.set(avant.etat) : fiche.delete());

  journal.warn('Budget Google Cloud', { cout, palier: atteint, periode });
  if (atteint !== 'coupure') {
    try {
      await envoyer(message(atteint, cout, avis.currencyCode));
    } catch (e) {
      await rendre();
      throw e;
    }
    return { fait: true, palier: atteint };
  }

  let prevenu = true;
  try {
    await envoyer(message('coupure', cout, avis.currencyCode, null));
  } catch (e) {
    prevenu = false;
    journal.error('Coupe-circuit : e-mail « coupure en cours » non parti', e.message);
  }
  try {
    await couper();
  } catch (e) {
    journal.error('Coupe-circuit : la facturation n\'a pas pu être désactivée', e);
    await rendre();
    await envoyer(message('coupure', cout, avis.currencyCode, false));
    return { fait: true, palier: atteint, coupee: false };
  }
  // Confirmation, si les fonctions tournent encore : sans elle, l'e-mail « en cours » a déjà tout dit.
  await envoyer(message('coupure', cout, avis.currencyCode, true))
    .catch((e) => journal.warn('Coupe-circuit : confirmation non partie', e.message));
  return { fait: true, palier: atteint, coupee: true, prevenu };
}

const coupeCircuit = onMessagePublished(
  { topic: SUJET, secrets: [MAIL_MOT_DE_PASSE], maxInstances: 1, retry: false },
  async (event) => {
    const projet = process.env.GCLOUD_PROJECT || JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId;
    await traiterAvis(event.data.message.json || {}, {
      fiche: base().doc('interne/budget'),
      transaction: (f) => base().runTransaction(f),
      envoyer: (contenu) => mail.envoyer({
        smtp: MAIL_SMTP.value(), expediteur: MAIL_EXPEDITEUR.value(), motDePasse: MAIL_MOT_DE_PASSE.value(),
        a: EMAIL_PAPOTE, contenu,
      }),
      couper: () => couperFacturation(projet),
      journal: logger,
    });
  });

module.exports = { coupeCircuit, traiterAvis, palierAtteint, aPrevenir, message, PALIERS };
