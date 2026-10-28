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
const journal = require('./journal-alertes');

const DEBRANCHEE_MS = 10 * 60_000;
const SILENCE_MS = 45 * 60_000;
// Pendant les heures de veille de la famille (families/{fid}.veille, 23 h-7 h par défaut), la tablette ne
// donne signe de vie qu'une fois par heure pour ménager la carte SIM (android/Sync.java, 28/10) : on
// tolère 2 h de silence avant d'alerter.
const SILENCE_NUIT_MS = 2 * 3600_000;

function enMillis(v) {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return typeof v === 'number' ? v : null;
}

// Heure à Paris (0-23) d'un instant.
function heureParis(ms) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)));
}

// Vrai pendant les heures de veille de la famille : { active, de, a } (absent = 23 h-7 h ; active false = jamais).
// Même règle que Veille.inRange sur la tablette : [de, a[, en passant minuit ; de == a : jamais.
function enVeille(veille, maintenant) {
  const v = veille || {};
  if (v.active === false) return false;
  const de = Number.isInteger(v.de) ? v.de : 23;
  const a = Number.isInteger(v.a) ? v.a : 7;
  const h = heureParis(maintenant);
  if (de < a) return h >= de && h < a;
  if (de > a) return h >= de || h < a;
  return false;
}

// Fiche de la tablette -> 'silence' | 'debranchee' | null. Une tablette qui ne répond plus
// n'envoie plus l'état de sa batterie : le silence passe avant. veille : réglage de la famille.
function etatAlerte(tablette, maintenant, veille) {
  const vue = enMillis(tablette.lastOnline);
  if (vue && maintenant - vue > (enVeille(veille, maintenant) ? SILENCE_NUIT_MS : SILENCE_MS)) return 'silence';
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
  const familles = await db.collection('families').select('abonnement', 'name', 'createdBy', 'admins', 'veille').get();
  await Promise.all(familles.docs.map(async (fam) => {
    const famille = fam.data();
    // Abonnement suspendu : la tablette est en pause, pas d'alerte. Hospitalisation : pas d'alerte non plus.
    if (!estActif(famille.abonnement) || enPause.has(fam.id)) return;
    const tablettes = await fam.ref.collection('members').where('role', '==', 'tablette').get();
    for (const t of tablettes.docs) {
      const tablette = t.data();
      const type = etatAlerte(tablette, maintenant, famille.veille);
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
        await journal.noter(db, { genre: type === 'silence' ? 'silence' : 'debranchee', fid: fam.id, tablette: t.id, telephones: n });
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

// Vrai si la tablette n'a ni vu ni senti la personne aujourd'hui (heure de Paris).
function pasVueAujourdhui(tablette, maintenant) {
  const aujourdhui = jourParis(maintenant);
  return ![tablette.lastSeen, tablette.lastActive]
    .map(enMillis)
    .some((ms) => ms && jourParis(ms) === aujourdhui);
}

// « Pas vue ce matin » est due si aucune tablette ne l'a vue ni sentie, et qu'au moins une tablette répond :
// une tablette hors ligne (box ou prise coupée) a déjà valu l'alerte « ne répond plus » aux responsables,
// inutile d'inquiéter toute la famille en plus (D2, Tanguy 2026-10-27).
function alerteMatinDue(tablettes, maintenant) {
  if (!tablettes.length) return false;
  if (tablettes.some((t) => !pasVueAujourdhui(t, maintenant))) return false;
  return tablettes.some((t) => etatAlerte(t, maintenant) !== 'silence');
}

exports.alerteMatin = onSchedule({ schedule: 'every day 12:00', timeZone: 'Europe/Paris' }, async () => {
  const db = base();
  const maintenant = Date.now();
  const aujourdhui = jourParis(maintenant);
  const enPause = await famillesEnPause(db, maintenant).catch((e) => { logger.warn('Pauses illisibles', e.message); return new Set(); });
  const familles = await db.collection('families').get();
  for (const fam of familles.docs) {
    const famille = fam.data();
    if (!estActif(famille.abonnement) || enPause.has(fam.id)) continue;
    const membres = await fam.ref.collection('members').get();
    const tablettes = membres.docs.filter((m) => m.get('role') === 'tablette');
    if (!alerteMatinDue(tablettes.map((t) => t.data()), maintenant)) continue;
    // Une seule alerte par jour (notée sur la famille, quelle que soit la tablette).
    if (famille.alerteMatinLe === aujourdhui) continue;
    const proches = membres.docs
      .filter((m) => m.get('role') === 'famille' && m.get('status') !== 'pending')
      .map((m) => m.id);
    const nom = famille.name || 'Mamie';
    try {
      const n = await envoyer(db, fam.id, proches, {
        type: 'alerte',
        titre: `${nom} n'a pas été vue ce matin`,
        texte: "La tablette ne l'a ni vue ni touchée depuis ce matin. Un petit appel pour prendre des nouvelles ?",
      }, 6 * 3600);
      await fam.ref.update({ alerteMatinLe: aujourdhui });
      await journal.noter(db, { genre: 'pas-vue', fid: fam.id, tablette: tablettes.length === 1 ? tablettes[0].id : null, telephones: n });
      logger.info(`Famille ${fam.id} : pas vue ce matin, ${n} téléphone(s)`);
    } catch (e) {
      logger.error(`Famille ${fam.id} : alerte du matin non envoyée`, e.message);
    }
  }
});

exports.etatAlerte = etatAlerte;
exports.enVeille = enVeille;
exports.pasVueAujourdhui = pasVueAujourdhui;
exports.alerteMatinDue = alerteMatinDue;
