// Alerte sur le téléphone des responsables quand la tablette est débranchée ou ne répond plus.
//
//   alertesTablettes  toutes les 5 minutes : une notification par épisode (débranchée depuis
//                     plus de 10 min, ou silencieuse depuis plus de 45 min)
//   alerteMatin       chaque jour à 12h (Paris) : « {nom} n'a pas été vue ce matin » si la tablette
//                     ne l'a ni vue (lastSeen, caméra) ni touchée (lastActive) depuis minuit
//
// L'épisode est noté sur la fiche de la tablette (alerteType, alerteLe) et remis à zéro quand
// tout revient, pour ne pas prévenir toutes les 5 minutes. La décision est dans etatAlerte,
// sans dépendance (alertes.test.js).

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions/v2');
const { estActif } = require('./abonnement');
const { db: base } = require('./base');
const { envoyer } = require('./push');
const { FieldValue } = require('firebase-admin').firestore;

const DEBRANCHEE_MS = 10 * 60_000;
const SILENCE_MS = 45 * 60_000;

function enMillis(v) {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return typeof v === 'number' ? v : null;
}

// Fiche de la tablette -> 'silence' | 'debranchee' | null. Une tablette qui ne répond plus
// n'envoie plus l'état de sa batterie : le silence passe avant.
function etatAlerte(tablette, maintenant) {
  const vue = enMillis(tablette.lastOnline);
  if (vue && maintenant - vue > SILENCE_MS) return 'silence';
  const batterie = tablette.battery || {};
  const debranchee = enMillis(batterie.unpluggedAt);
  if (batterie.charging === false && debranchee && maintenant - debranchee > DEBRANCHEE_MS) return 'debranchee';
  return null;
}

function message(type, nom) {
  return type === 'silence'
    ? { titre: `La tablette de ${nom} ne répond plus`, texte: 'Est-elle branchée et connectée au Wi-Fi ?' }
    : { titre: `La tablette de ${nom} est débranchée`, texte: 'Pensez à rebrancher son chargeur.' };
}

// Familles en pause hospitalisation (commandes/{id}.pause, pauseHospitalisation) : aucune alerte de tablette
// pendant la pause (C4, Tanguy 2026-10-27) : la tablette est souvent éteinte à la maison.
async function famillesEnPause(db, maintenant) {
  const pauses = await db.collection('commandes').where('pause.jusqua', '>', new Date(maintenant)).get();
  return new Set(pauses.docs.map((d) => d.get('fid')).filter(Boolean));
}

exports.alertesTablettes = onSchedule({ schedule: 'every 5 minutes', timeZone: 'Europe/Paris' }, async () => {
  const db = base();
  const maintenant = Date.now();
  const enPause = await famillesEnPause(db, maintenant).catch((e) => { logger.warn('Pauses illisibles', e.message); return new Set(); });
  // Seulement les champs utiles des familles, et toutes les familles en même temps (et non l'une après l'autre) :
  // la tâche, lancée 288 fois par jour, finit plus vite et coûte moins de temps de calcul.
  const familles = await db.collection('families').select('abonnement', 'name', 'createdBy', 'admins').get();
  await Promise.all(familles.docs.map(async (fam) => {
    const famille = fam.data();
    // Abonnement suspendu : la tablette est en pause, pas d'alerte. Hospitalisation : pas d'alerte non plus.
    if (!estActif(famille.abonnement) || enPause.has(fam.id)) return;
    const tablettes = await fam.ref.collection('members').where('role', '==', 'tablette').get();
    for (const t of tablettes.docs) {
      const tablette = t.data();
      const type = etatAlerte(tablette, maintenant);
      try {
        if (!type) {
          if (tablette.alerteType) await t.ref.update({ alerteType: null, alerteLe: null });
          continue;
        }
        if (tablette.alerteType === type) continue; // déjà prévenu pour cet épisode
        const responsables = [...new Set([famille.createdBy, ...(famille.admins || [])].filter(Boolean))];
        const { titre, texte } = message(type, famille.name || 'Mamie');
        const n = await envoyer(db, fam.id, responsables, { type: 'alerte', titre, texte }, 6 * 3600);
        await t.ref.update({ alerteType: type, alerteLe: new Date(maintenant) });
        logger.info(`Famille ${fam.id}, tablette ${t.id} : alerte ${type}, ${n} téléphone(s)`);
      } catch (e) {
        logger.error(`Famille ${fam.id}, tablette ${t.id} : alerte non envoyée`, e.message);
      }
    }
  }));
});

// Jour « AAAA-MM-JJ » à Paris pour un instant donné.
function jourParis(ms) {
  return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms));
}

// Dernier signe de vie de la personne sur cette tablette (caméra ou toucher), en ms ; sinon null.
function derniereVue(tablette) {
  const vues = [tablette.lastSeen, tablette.lastActive].map(enMillis).filter(Boolean);
  return vues.length ? Math.max(...vues) : null;
}

// « Pas vue depuis deux jours » (Tanguy, 2026-10-28 : une journée sans toucher la tablette, c'est normal ;
// un week-end chez les enfants aussi ; au-delà de 48 h, un coup de fil vaut le coup). Jamais vue : on compte
// depuis l'arrivée de la tablette dans la famille (joinedAt), sinon rien.
const PAS_VUE_MS = 48 * 60 * 60 * 1000;
function pasVueDepuisLongtemps(tablette, maintenant) {
  const vue = derniereVue(tablette) || enMillis(tablette.joinedAt);
  return Boolean(vue) && maintenant - vue > PAS_VUE_MS;
}

// Due si aucune tablette ne l'a vue ni sentie depuis deux jours, et qu'au moins une tablette répond :
// une tablette hors ligne (box ou prise coupée) a déjà valu l'alerte « ne répond plus » aux responsables,
// inutile d'inquiéter en plus (D2, Tanguy 2026-10-27).
function alertePasVueDue(tablettes, maintenant) {
  if (!tablettes.length) return false;
  if (tablettes.some((t) => !pasVueDepuisLongtemps(t, maintenant))) return false;
  // Le compte d'appels de la tablette ne donne jamais de nouvelles : seules celles qui en ont donné comptent.
  return tablettes.some((t) => enMillis(t.lastOnline) && etatAlerte(t, maintenant) !== 'silence');
}

// Chaque midi : une seule alerte par épisode (tant qu'elle n'est pas revue, pas de rappel le lendemain),
// aux responsables de la famille.
exports.alerteMatin = onSchedule({ schedule: 'every day 12:00', timeZone: 'Europe/Paris' }, async () => {
  const db = base();
  const maintenant = Date.now();
  const enPause = await famillesEnPause(db, maintenant).catch((e) => { logger.warn('Pauses illisibles', e.message); return new Set(); });
  const familles = await db.collection('families').get();
  for (const fam of familles.docs) {
    const famille = fam.data();
    if (!estActif(famille.abonnement) || enPause.has(fam.id)) continue;
    const membres = await fam.ref.collection('members').get();
    const tablettes = membres.docs.filter((m) => m.get('role') === 'tablette').map((t) => t.data());
    if (!alertePasVueDue(tablettes, maintenant)) continue;
    // Épisode = dernier signe de vie connu : déjà prévenu pour celui-ci, on attend qu'elle soit revue.
    const depuis = Math.max(0, ...tablettes.map((t) => derniereVue(t) || 0));
    if (famille.alertePasVue && enMillis(famille.alertePasVue.depuis) === depuis) continue;
    const responsables = [...new Set([famille.createdBy, ...(famille.admins || [])].filter(Boolean))];
    const nom = famille.name || 'Mamie';
    try {
      const n = await envoyer(db, fam.id, responsables, {
        type: 'alerte',
        titre: `${nom} n'a pas été vue depuis deux jours`,
        texte: "La tablette ne l'a ni vue ni sentie depuis 48 heures. Un petit appel pour prendre des nouvelles ?",
      }, 6 * 3600);
      await fam.ref.update({ alertePasVue: { le: new Date(maintenant), depuis: new Date(depuis) }, alerteMatinLe: FieldValue.delete() });
      logger.info(`Famille ${fam.id} : pas vue depuis deux jours, ${n} téléphone(s)`);
    } catch (e) {
      logger.error(`Famille ${fam.id} : alerte « pas vue » non envoyée`, e.message);
    }
  }
});

exports.etatAlerte = etatAlerte;
exports.pasVueDepuisLongtemps = pasVueDepuisLongtemps;
exports.alertePasVueDue = alertePasVueDue;
exports.PAS_VUE_MS = PAS_VUE_MS;
