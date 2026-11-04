// Tâches planifiées regroupées (Tanguy, 4/11) : Cloud Scheduler facture 0,10 $ par tâche et par mois au-delà de 3.
// Il n'y a donc plus que deux tâches planifiées en ligne :
//
//   alertesTablettes  toutes les 5 minutes (alertes.js, inchangée)
//   tachesHoraires    toutes les heures pile (Paris) : lance les tâches ci-dessous qui tombent à cette heure-là
//
// Chaque tâche garde son heure d'avant (PLANNING) et reste une simple fonction async dans son fichier
// (alertes.alerteMatin, purge.purgeMensuelle, gestion.gestionAutomatique…, index.js relancesPaniers…). Elles tournent
// en même temps, comme quand chacune avait sa propre fonction : une tâche en erreur est journalisée (logger.error) et
// n'empêche jamais les autres.

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');

const HEURE = 3600e3;
const TOUTES_LES_HEURES = 'toutes les heures';

// Heure de chaque tâche, à Paris (les anciennes « schedule » entre parenthèses).
//   heure : 0-23 ; lundi : seulement le lundi ; premier : seulement le 1er du mois.
const PLANNING = {
  relancesPaniers: TOUTES_LES_HEURES, //       (every 60 minutes)
  finDeGrace: TOUTES_LES_HEURES, //            (every 1 hours)
  gestionCourrier: TOUTES_LES_HEURES, //       (every 60 minutes)
  gestionAutomatique: { heure: 4 }, //         (every day 04:00)
  restitutions: { heure: 9 }, //               (every day 09:00)
  rappelsJumelage: { heure: 10 }, //           (every day 10:00)
  alerteMatin: { heure: 10 }, //               (alertes.HORAIRE_PAS_VUE : every day 10:00)
  gestionRecap: { heure: 8, lundi: true }, //  (every monday 08:00)
  bilanSupport: { heure: 9, lundi: true }, //  (every monday 09:00)
  purgeMensuelle: { heure: 4, premier: true }, // (1 of month 04:00)
  gestionCloture: { heure: 5, premier: true }, // (0 5 1 * *)
};

// Heure, jour de la semaine et jour du mois à Paris de l'heure pile la plus proche (Cloud Scheduler part à l'heure
// pile, parfois quelques secondes après : on arrondit pour ne jamais tomber sur l'heure d'avant).
function heureParis(ms) {
  const pile = Math.round(ms / HEURE) * HEURE;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23', weekday: 'short', day: 'numeric',
  }).formatToParts(new Date(pile)).map((p) => [p.type, p.value]));
  return { heure: Number(parts.hour), lundi: parts.weekday === 'Mon', jour: Number(parts.day) };
}

// Les tâches à lancer à cet instant.
function aLancer(ms) {
  const h = heureParis(ms);
  return Object.entries(PLANNING).filter(([, quand]) => quand === TOUTES_LES_HEURES || (
    quand.heure === h.heure && (!quand.lundi || h.lundi) && (!quand.premier || h.jour === 1)
  )).map(([nom]) => nom);
}

// Lance les tâches dues en même temps ; chacune est isolée : son erreur est journalisée, les autres continuent.
async function lancer(taches, ms) {
  const noms = aLancer(ms);
  const resultats = await Promise.allSettled(noms.map(async (nom) => {
    if (typeof taches[nom] !== 'function') throw new Error('tâche introuvable');
    return taches[nom]();
  }));
  const bilan = {};
  resultats.forEach((r, i) => {
    bilan[noms[i]] = r.status === 'fulfilled' ? 'ok' : 'erreur';
    if (r.status === 'rejected') logger.error(`Tâche planifiée ${noms[i]} en erreur`, r.reason);
  });
  return bilan;
}

// Toutes les clés dont une des tâches a besoin.
const SECRETS = ['STRIPE_SECRET', 'SENDCLOUD_API', 'MAIL_MOT_DE_PASSE', 'ANTHROPIC_API_KEY', 'FACTURES_MOT_DE_PASSE'].map((n) => defineSecret(n));

// La fonction planifiée, avec les tâches (nom → fonction async) branchées par index.js.
// Durée : le pire est le 1er du mois à 4 h (gestionAutomatique ≤ 300 s, purgeMensuelle et gestionCourrier ≤ 540 s,
// en parallèle) ; 1800 s (le maximum d'une tâche planifiée v2) laisse de la marge même si elles se suivaient
// (≈ 1400 s). Mémoire : 1 Gio, trois tâches à 512 Mio pouvant tourner ensemble.
function planifier(taches) {
  const f = onSchedule(
    { schedule: '0 * * * *', timeZone: 'Europe/Paris', secrets: SECRETS, timeoutSeconds: 1800, memory: '1GiB' },
    (event) => {
      const t = event && Date.parse(event.scheduleTime);
      return lancer(taches, Number.isFinite(t) ? t : Date.now());
    });
  f.taches = taches;
  return f;
}

module.exports = { planifier, PLANNING, _test: { heureParis, aLancer, lancer, TOUTES_LES_HEURES } };
