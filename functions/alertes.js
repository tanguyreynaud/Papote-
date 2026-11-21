// Alerte sur le téléphone des responsables quand la tablette est débranchée ou ne répond plus.
//
//   alertesTablettes  toutes les 5 minutes : une notification par épisode (débranchée depuis
//                     plus de 10 min, ou silencieuse depuis plus de 1 h 10)
//   alerteMatin       chaque jour à 10 h (Paris, lancée par taches.js) : « {nom} n'a pas été vue depuis N jours » si la
//                     tablette ne l'a ni vue (lastSeen, caméra) ni touchée (lastActive) depuis N × 24 h ; N réglé par
//                     la famille de 1 à 5 jours (families/{fid}.alertePasVueJours, 2 par défaut, appli famille, Réglages).
//                     Le contrôle n'a lieu qu'une fois par jour : l'alerte arrive entre N et N + 1 jours après le
//                     dernier signe de vie.
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
const { veilleSure } = require('./veille');

const DEBRANCHEE_MS = 10 * 60_000;
// La tablette se signale toutes les 30 min sur la carte SIM (android/Sync.java, Tanguy 28/10) : deux tours
// manqués plus une marge avant d'alerter.
const SILENCE_MS = 70 * 60_000;
// Pendant les heures de veille de la famille (families/{fid}.veille, 23 h-5 h par défaut, veille.js), la tablette ne
// donne signe de vie que toutes les 2 h pour ménager la carte SIM (android/Sync.java ; 1 h avant le 21/11, Tanguy) :
// un tour manqué plus une marge, on tolère 3 h de silence avant d'alerter.
const SILENCE_NUIT_MS = 3 * 3600_000;
// Au réveil, le premier tour du matin arrive juste après la fin de la veille : la tolérance de nuit court
// encore 30 min, sinon un signe de vie de 5 h (avant un réveil à 6 h 30) déclencherait l'alerte à 6 h 30.
const GRACE_MATIN_MS = 30 * 60_000;

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

// Réglage de la famille : { active, de, deMin, a, aMin } (veille.js). Absent : de 23 h à 5 h. Une valeur
// hors bornes en base (coucher 19 h-23 h 30, réveil 5 h-10 h) est ramenée dans les bornes (veilleSure).

// Vrai pendant les heures de veille de la famille (active false = jamais).
// Même règle que Veille.inRange sur la tablette : [de, a[, en passant minuit ; de == a : jamais.
function enVeille(veille, maintenant) {
  const v = veilleSure(veille);
  if (!v.active) return false;
  const de = v.de * 60 + v.deMin;
  const a = v.a * 60 + v.aMin;
  const t = minutesParis(maintenant);
  if (de < a) return t >= de && t < a;
  if (de > a) return t >= de || t < a;
  return false;
}

// Silence toléré avant « ne répond plus » : 3 h pendant la veille et 30 min après, 1 h 10 sinon (aussi pour fiche-chat.js
// et l'appli : web/js/silence.js).
function silenceTolere(veille, maintenant) {
  return enVeille(veille, maintenant) || enVeille(veille, maintenant - GRACE_MATIN_MS) ? SILENCE_NUIT_MS : SILENCE_MS;
}

// Fiche de la tablette -> 'silence' | 'debranchee' | null. Une tablette qui ne répond plus
// n'envoie plus l'état de sa batterie : le silence passe avant. veille : réglage de la famille.
function etatAlerte(tablette, maintenant, veille) {
  const vue = enMillis(tablette.lastOnline);
  if (vue && maintenant - vue > silenceTolere(veille, maintenant)) return 'silence';
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
// Délai réglable par la famille de 1 à 5 jours (Tanguy, 18/11/2026) : families/{fid}.alertePasVueJours, écrit par
// l'appli famille (Réglages) et vérifié par firestore.rules. PAS_VUE_MS reste le délai par défaut (2 jours).
const PAS_VUE_MS = 48 * 60 * 60 * 1000;
const JOURS_PAS_VUE_DEFAUT = 2;
const JOURS_PAS_VUE_MIN = 1;
const JOURS_PAS_VUE_MAX = 5;
const JOUR_MS = 24 * 60 * 60 * 1000;

// Réglage de la famille -> nombre de jours sûr (entier de 1 à 5). Absent ou illisible : 2 ; hors bornes : ramené
// dans les bornes ; décimal : arrondi.
function joursPasVue(valeur) {
  if (typeof valeur !== 'number' || !Number.isFinite(valeur)) return JOURS_PAS_VUE_DEFAUT;
  return Math.min(JOURS_PAS_VUE_MAX, Math.max(JOURS_PAS_VUE_MIN, Math.round(valeur)));
}

// « 1 jour », « 3 jours ».
function joursTexte(jours) {
  return jours === 1 ? '1 jour' : `${jours} jours`;
}

// Texte de l'alerte pour un délai donné (en jours, déjà sûr).
function messagePasVue(nom, jours) {
  return {
    titre: `${nom} n'a pas été vue depuis ${joursTexte(jours)}`,
    texte: `La tablette ne l'a ni vue ni sentie depuis plus de ${jours * 24} heures. Un petit appel pour prendre des nouvelles ?`,
  };
}

function pasVueDepuisLongtemps(tablette, maintenant, jours) {
  const vue = derniereVue(tablette) || enMillis(tablette.joinedAt);
  const delai = jours === undefined ? PAS_VUE_MS : joursPasVue(jours) * JOUR_MS;
  return Boolean(vue) && maintenant - vue > delai;
}

// Due si aucune tablette ne l'a vue ni sentie depuis le délai de la famille (jours), et qu'au moins une tablette répond :
// une tablette hors ligne (box ou prise coupée) a déjà valu l'alerte « ne répond plus » aux responsables,
// inutile d'inquiéter en plus (D2, Tanguy 2026-10-27).
function alertePasVueDue(tablettes, maintenant, jours) {
  if (!tablettes.length) return false;
  if (tablettes.some((t) => !pasVueDepuisLongtemps(t, maintenant, jours))) return false;
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
    const jours = joursPasVue(famille.alertePasVueJours);
    if (!alertePasVueDue(tablettes, maintenant, jours)) continue;
    // Épisode = dernier signe de vie connu : déjà prévenu pour celui-ci, on attend qu'elle soit revue.
    const depuis = Math.max(0, ...tablettes.map((t) => derniereVue(t) || 0));
    if (famille.alertePasVue && enMillis(famille.alertePasVue.depuis) === depuis) continue;
    const responsables = [...new Set([famille.createdBy, ...(famille.admins || [])].filter(Boolean))];
    const nom = famille.name || 'Mamie';
    try {
      const n = await envoyer(db, fam.id, responsables, { type: 'alerte', ...messagePasVue(nom, jours) }, 6 * 3600);
      await fam.ref.update({ alertePasVue: { le: new Date(maintenant), depuis: new Date(depuis) }, alerteMatinLe: FieldValue.delete() });
      await journal.noter(db, { genre: 'pas-vue', fid: fam.id, tablette: idsTablettes.length === 1 ? idsTablettes[0] : null, telephones: n });
      logger.info(`Famille ${fam.id} : pas vue depuis ${joursTexte(jours)}, ${n} téléphone(s)`);
    } catch (e) {
      logger.error(`Famille ${fam.id} : alerte « pas vue » non envoyée`, e.message);
    }
  }
};

exports.etatAlerte = etatAlerte;
exports.silenceTolere = silenceTolere;
exports.famillesEnPause = famillesEnPause;
exports.message = message;
exports.enVeille = enVeille;
exports.pasVueDepuisLongtemps = pasVueDepuisLongtemps;
exports.alertePasVueDue = alertePasVueDue;
exports.HORAIRE_PAS_VUE = HORAIRE_PAS_VUE;
exports.numeroInconnu = numeroInconnu;
exports.PAS_VUE_MS = PAS_VUE_MS;
exports.joursPasVue = joursPasVue;
exports.messagePasVue = messagePasVue;
exports.JOURS_PAS_VUE_DEFAUT = JOURS_PAS_VUE_DEFAUT;
