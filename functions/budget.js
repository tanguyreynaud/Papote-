// Coupe-circuit de facturation : protège contre une facture Google Cloud qui s'emballe.
//
//   coupeCircuit  à chaque avis du budget Google Cloud (sujet Pub/Sub « budget-papote ») :
//                 30 € : e-mail d'alerte ; 100 € : e-mail « attention, coupure à 150 € » ;
//                 150 € : la facturation du projet est désactivée (tout s'arrête), puis e-mail.
//
// Google envoie l'avis du budget plusieurs fois par jour avec le coût du mois en cours (costAmount).
// Chaque palier n'est prévenu qu'une fois par mois (interne/budget dans la base, illisible côté client). Le coût affiché
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
  const lien = 'https://console.cloud.google.com/billing';
  if (palier === 'alerte') {
    return {
      subject: `Papote : la facture Google Cloud du mois atteint ${montant}`,
      text: `La facture Google Cloud de Papote atteint ${montant} ce mois-ci (alerte à ${PALIERS.alerte} €).\n\n`
        + `Rien n'est coupé. Pour information, le coupe-circuit coupera tout à ${PALIERS.coupure} €.\n\n${lien}`,
    };
  }
  if (palier === 'avertissement') {
    return {
      subject: `Attention : coupe-circuit bientôt, facture Google Cloud à ${montant}`,
      text: `Attention, la facture Google Cloud de Papote atteint ${montant} ce mois-ci.\n\n`
        + `Le coupe-circuit coupera tout à ${PALIERS.coupure} € : l'app famille, les tablettes et le site ne marcheront plus.\n`
        + `Si Papote a grandi et que c'est normal, montez le seuil (PALIERS dans functions/budget.js et le budget dans la console).\n`
        + `Sinon, regardez ce qui coûte : ${lien}`,
    };
  }
  if (!coupee) {
    return {
      subject: `URGENT : facture Google Cloud à ${montant}, le coupe-circuit n'a pas pu couper`,
      text: `La facture Google Cloud de Papote a atteint ${montant}, mais la facturation n'a pas pu être désactivée `
        + `(rôle « Gestionnaire de facturation de projet » manquant ?).\n\n`
        + `Coupez-la vous-même : ${lien} > Gestion des comptes > Papote > Désactiver la facturation.`,
    };
  }
  return {
    subject: `COUPE-CIRCUIT : facturation Google Cloud désactivée à ${montant}`,
    text: `La facture Google Cloud de Papote a atteint ${montant} ce mois-ci : la facturation du projet a été désactivée.\n\n`
      + `Les fonctions, l'app famille et les tablettes sont arrêtées ou limitées. Les données ne sont pas effacées.\n`
      + `Pour tout relancer : ${lien} > Gestion des comptes > Papote > Associer un compte de facturation.\n`
      + `Avant, trouvez ce qui a coûté (Rapports de facturation).`,
  };
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

const coupeCircuit = onMessagePublished(
  { topic: SUJET, secrets: [MAIL_MOT_DE_PASSE], maxInstances: 1, retry: false },
  async (event) => {
    const avis = event.data.message.json || {};
    const cout = Number(avis.costAmount) || 0;
    const periode = String(avis.costIntervalStart || '').slice(0, 7); // « 2026-10 »
    const atteint = palierAtteint(cout);
    const fiche = base().doc('interne/budget');

    const prevenir = await base().runTransaction(async (t) => {
      const etat = (await t.get(fiche)).data() || {};
      const deja = etat.periode === periode ? etat.palier : null;
      if (!aPrevenir(atteint, deja)) return false;
      t.set(fiche, { periode, palier: atteint, cout, le: new Date() });
      return true;
    });
    if (!prevenir) return;

    logger.warn('Budget Google Cloud', { cout, palier: atteint, periode });
    let coupee = true;
    if (atteint === 'coupure') {
      const projet = process.env.GCLOUD_PROJECT || JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId;
      try {
        await couperFacturation(projet);
      } catch (e) {
        logger.error('Coupe-circuit : la facturation n\'a pas pu être désactivée', e);
        coupee = false;
      }
    }
    await mail.envoyer({
      smtp: MAIL_SMTP.value(), expediteur: MAIL_EXPEDITEUR.value(), motDePasse: MAIL_MOT_DE_PASSE.value(),
      a: EMAIL_PAPOTE, contenu: message(atteint, cout, avis.currencyCode, coupee),
    });
  });

module.exports = { coupeCircuit, palierAtteint, aPrevenir, message, PALIERS };
