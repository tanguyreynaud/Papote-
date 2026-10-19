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

exports.alertesTablettes = onSchedule({ schedule: 'every 5 minutes', timeZone: 'Europe/Paris' }, async () => {
  const db = base();
  const maintenant = Date.now();
  const familles = await db.collection('families').get();
  for (const fam of familles.docs) {
    const famille = fam.data();
    // Abonnement suspendu : la tablette est en pause, pas d'alerte.
    if (!estActif(famille.abonnement)) continue;
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
  }
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

exports.alerteMatin = onSchedule({ schedule: 'every day 12:00', timeZone: 'Europe/Paris' }, async () => {
  const db = base();
  const maintenant = Date.now();
  const aujourdhui = jourParis(maintenant);
  const familles = await db.collection('families').get();
  for (const fam of familles.docs) {
    const famille = fam.data();
    if (!estActif(famille.abonnement)) continue;
    const membres = await fam.ref.collection('members').get();
    const tablettes = membres.docs.filter((m) => m.get('role') === 'tablette');
    // Plusieurs tablettes : il suffit qu'une seule l'ait vue.
    if (!tablettes.length || tablettes.some((t) => !pasVueAujourdhui(t.data(), maintenant))) continue;
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
      logger.info(`Famille ${fam.id} : pas vue ce matin, ${n} téléphone(s)`);
    } catch (e) {
      logger.error(`Famille ${fam.id} : alerte du matin non envoyée`, e.message);
    }
  }
});

exports.etatAlerte = etatAlerte;
exports.pasVueAujourdhui = pasVueAujourdhui;
