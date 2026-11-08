// Alerte sur le téléphone des responsables quand la tablette est débranchée ou ne répond plus.
//
//   alertesTablettes  toutes les 5 minutes : une notification par épisode (débranchée depuis
//                     plus de 10 min, ou silencieuse depuis plus de 1 h 10)
//   alerteMatin       chaque jour à 10 h (Paris, lancée par taches.js) : « {nom} n'a pas été vue depuis deux jours » si la
//                     tablette ne l'a ni vue (lastSeen, caméra) ni touchée (lastActive) depuis 48 h
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
const journal = require('./journal-alertes');

const DEBRANCHEE_MS = 10 * 60_000;
// La tablette se signale toutes les 30 min sur la carte SIM (android/Sync.java, Tanguy 28/10) : deux tours
// manqués plus une marge avant d'alerter.
const SILENCE_MS = 70 * 60_000;
// Pendant les heures de veille de la famille (families/{fid}.veille, 21 h-6 h 30 par défaut), la tablette ne
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
// Minutes écoulées depuis minuit, à Paris.
function minutesParis(ms) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(ms)).split(':').map(Number);
  return h * 60 + m;
}

// Réglage de la famille : { active, de, a } en heures (0-23) et, en plus, deMin / aMin (0 ou 30) pour les
// demi-heures. Absent : de 21 h à 6 h 30.
const VEILLE_DEFAUT = { de: 21, deMin: 0, a: 6, aMin: 30 };

// Vrai pendant les heures de veille de la famille (active false = jamais).
// Même règle que Veille.inRange sur la tablette : [de, a[, en passant minuit ; de == a : jamais.
function enVeille(veille, maintenant) {
  const v = veille || VEILLE_DEFAUT;
  if (v.active === false) return false;
  const de = (Number.isInteger(v.de) ? v.de : 21) * 60 + (v.deMin === 30 ? 30 : 0);
  const a = (Number.isInteger(v.a) ? v.a : 6) * 60 + (v.aMin === 30 ? 30 : 0);
  const t = minutesParis(maintenant);
  if (de < a) return t >= de && t < a;
  if (de > a) return t >= de || t < a;
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

// coupee : jour où internet revient, quand le forfait « internet coupé » est sans doute épuisé (forfait-alerte.js) :
// pas de « ne répond plus » inquiétant, la vraie raison et le geste utile.
function message(type, nom, coupee) {
  if (type === 'silence' && coupee) {
    const fin = require('./forfait-alerte').jourTexte(coupee);
    return { titre: `La tablette de ${nom} n'a sans doute plus internet`, texte: `Son forfait du mois est épuisé, internet revient le ${fin}. Branchez-la au wifi si vous pouvez.` };
  }
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

// Tablettes à regarder à ce tour : seulement celles qui peuvent avoir une alerte à donner ou à retirer, par trois
// requêtes sur toutes les familles à la fois (index COLLECTION_GROUP de firestore.indexes.json) :
//   muettes depuis plus de SILENCE_MS (le seuil le plus court : la veille ne fait que l'allonger),
//   débranchées (battery.charging == false), ou en alerte (alerteType posé, à remettre à zéro si tout est revenu).
// Avant : la liste des familles puis une requête par famille, soit ~3 lectures par famille toutes les 5 minutes
// (~90 000 lectures par jour à 100 familles, ~900 000 à 1 000). Maintenant : ~1 lecture par tablette à problème.
async function tablettesARegarder(db, maintenant) {
  const membres = db.collectionGroup('members').where('role', '==', 'tablette');
  const [muettes, debranchees, enAlerte] = await Promise.all([
    membres.where('lastOnline', '<', new Date(maintenant - SILENCE_MS)).get(),
    membres.where('battery.charging', '==', false).get(),
    membres.where('alerteType', 'in', ['silence', 'debranchee']).get(),
  ]);
  const parChemin = new Map();
  for (const d of [...muettes.docs, ...debranchees.docs, ...enAlerte.docs]) parChemin.set(d.ref.path, d);
  const parFamille = new Map();
  for (const d of parChemin.values()) {
    const fid = d.ref.parent.parent.id;
    if (!parFamille.has(fid)) parFamille.set(fid, []);
    parFamille.get(fid).push(d);
  }
  return parFamille;
}

exports.alertesTablettes = onSchedule({ schedule: 'every 5 minutes', timeZone: 'Europe/Paris' }, async () => {
  const db = base();
  const maintenant = Date.now();
  const [enPause, parFamille] = await Promise.all([
    famillesEnPause(db, maintenant).catch((e) => { logger.warn('Pauses illisibles', e.message); return new Set(); }),
    tablettesARegarder(db, maintenant),
  ]);
  if (!parFamille.size) return;
  // Seulement les familles concernées, et seulement les champs utiles.
  const fids = [...parFamille.keys()];
  const familles = await db.getAll(...fids.map((fid) => db.doc(`families/${fid}`)),
    { fieldMask: ['abonnement', 'name', 'createdBy', 'admins', 'veille', 'forfaitSim'] });
  await Promise.all(familles.map(async (fam) => {
    if (!fam.exists) return;
    const famille = fam.data();
    // Abonnement suspendu : la tablette est en pause, pas d'alerte. Hospitalisation : pas d'alerte non plus.
    if (!estActif(famille.abonnement) || enPause.has(fam.id)) return;
    for (const t of parFamille.get(fam.id)) {
      const tablette = t.data();
      const type = etatAlerte(tablette, maintenant, famille.veille);
      try {
        if (!type) {
          if (tablette.alerteType) await t.ref.update({ alerteType: null, alerteLe: null });
          continue;
        }
        if (tablette.alerteType === type) continue; // déjà prévenu pour cet épisode
        // Deux tours en même temps (tour en retard, nouvel essai) : un seul prend l'épisode et prévient.
        const pris = await db.runTransaction(async (tx) => {
          if ((await tx.get(t.ref)).get('alerteType') === type) return false;
          tx.update(t.ref, { alerteType: type, alerteLe: new Date(maintenant) });
          return true;
        });
        if (!pris) continue;
        const responsables = [...new Set([famille.createdBy, ...(famille.admins || [])].filter(Boolean))];
        const { titre, texte } = message(type, famille.name || 'Mamie', type === 'silence' && require('./forfait-alerte').coupeeParForfait(tablette, famille.forfaitSim, maintenant));
        let n;
        try {
          n = await envoyer(db, fam.id, responsables, { type: 'alerte', titre, texte }, 6 * 3600);
        } catch (e) {
          // Rien n'est parti : l'épisode est rendu, le tour suivant réessaie.
          await t.ref.update({ alerteType: tablette.alerteType || null, alerteLe: tablette.alerteLe || null });
          throw e;
        }
        await journal.noter(db, { genre: type === 'silence' ? 'silence' : 'debranchee', fid: fam.id, tablette: t.id, telephones: n });
        logger.info(`Famille ${fam.id}, tablette ${t.id} : alerte ${type}, ${n} téléphone(s)`);
      } catch (e) {
        logger.error(`Famille ${fam.id}, tablette ${t.id} : alerte non envoyée`, e.message);
      }
    }
  }));
});

// Numéro de la tablette jamais écrit sur sa fiche (ni numéro, ni « aucun » = null).
function numeroInconnu(tablette) {
  return tablette.telephone === undefined;
}

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

// Chaque jour à 10 h (Tanguy, 29/10 : une heure où l'on peut appeler, jamais la nuit) : une seule alerte par
// épisode (tant qu'elle n'est pas revue, pas de rappel le lendemain), aux responsables de la famille.
const HORAIRE_PAS_VUE = 'every day 10:00';
// Lancée par taches.js (tachesHoraires) à l'heure de HORAIRE_PAS_VUE.
exports.alerteMatin = async () => {
  const db = base();
  const maintenant = Date.now();
  const enPause = await famillesEnPause(db, maintenant).catch((e) => { logger.warn('Pauses illisibles', e.message); return new Set(); });
  const familles = await db.collection('families').get();
  for (const fam of familles.docs) {
    const famille = fam.data();
    const membres = await fam.ref.collection('members').get();
    // Numéro de la tablette jamais écrit dans la famille (carte SIM reliée avant le 29/10/2026) : retrouvé ici, une
    // fois par jour (avant : toutes les 5 minutes dans alertesTablettes), abonnement actif ou non.
    for (const t of membres.docs) {
      if (t.get('role') !== 'tablette' || !numeroInconnu(t.data())) continue;
      await require('./gestion').completerNumeroTablette(fam.id, t.id)
        .catch((e) => logger.warn(`Famille ${fam.id}, tablette ${t.id} : numéro non retrouvé`, e.message));
    }
    if (!estActif(famille.abonnement) || enPause.has(fam.id)) continue;
    const docsTablettes = membres.docs.filter((m) => m.get('role') === 'tablette');
    const idsTablettes = docsTablettes.map((t) => t.id);
    const tablettes = docsTablettes.map((t) => t.data());
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
      await journal.noter(db, { genre: 'pas-vue', fid: fam.id, tablette: idsTablettes.length === 1 ? idsTablettes[0] : null, telephones: n });
      logger.info(`Famille ${fam.id} : pas vue depuis deux jours, ${n} téléphone(s)`);
    } catch (e) {
      logger.error(`Famille ${fam.id} : alerte « pas vue » non envoyée`, e.message);
    }
  }
};

exports.etatAlerte = etatAlerte;
exports.message = message;
exports.enVeille = enVeille;
exports.pasVueDepuisLongtemps = pasVueDepuisLongtemps;
exports.alertePasVueDue = alertePasVueDue;
exports.HORAIRE_PAS_VUE = HORAIRE_PAS_VUE;
exports.numeroInconnu = numeroInconnu;
exports.PAS_VUE_MS = PAS_VUE_MS;
