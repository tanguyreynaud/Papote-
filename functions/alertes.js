// Alerte sur le téléphone des responsables quand la tablette est débranchée ou ne répond plus.
//
//   alertesTablettes  toutes les 5 minutes : une notification par épisode (débranchée depuis
//                     plus de 10 min, ou silencieuse depuis plus de 1 h 10)
//   alerteMatin       chaque jour à 10 h (Paris, lancée par taches.js) : « {nom} n'a pas été vue depuis N jours » si la
//                     tablette ne l'a ni vue (lastSeen, caméra) ni touchée (lastActive) depuis N × 24 h ; N réglé par
//                     la famille de 1 à 5 jours (families/{fid}.alertePasVueJours, 2 par défaut, appli famille, Réglages).
//                     Le contrôle n'a lieu qu'une fois par jour : l'alerte arrive entre N et N + 1 jours après le
//                     dernier signe de vie.
//                     Délai par défaut 5 jours (Tanguy, 21/11/2026 : sans rien recevoir, Mamie n'a aucune raison de
//                     toucher la tablette ; ce filet ne sert que quand la famille n'envoie rien).
//   alerteNonVus      toutes les heures de 9 h à 20 h (Paris, taches.js) : « {nom} n'a pas vu vos 3 derniers envois »
//                     quand 3 envois ou rappels de suite sont restés sans « vu » et que la tablette ne l'a ni vue ni
//                     sentie depuis le premier (Tanguy, 21/11/2026 : l'alerte se fonde sur l'absence de réaction à ce
//                     qu'on lui envoie, pas sur l'absence de toucher).
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
// Délai réglable par la famille de 1 à 5 jours (Tanguy, 18/11/2026) : families/{fid}.alertePasVueJours, écrit par
// l'appli famille (Réglages) et vérifié par firestore.rules. PAS_VUE_MS reste le délai par défaut (5 jours depuis le
// 21/11/2026 : quand la famille envoie, c'est alerteNonVus qui prévient, bien plus tôt).
const PAS_VUE_MS = 120 * 60 * 60 * 1000;
const JOURS_PAS_VUE_DEFAUT = 5;
const JOURS_PAS_VUE_MIN = 1;
const JOURS_PAS_VUE_MAX = 5;
const JOUR_MS = 24 * 60 * 60 * 1000;

// Réglage de la famille -> nombre de jours sûr (entier de 1 à 5). Absent ou illisible : 5 (2 avant le 21/11/2026) ; hors bornes : ramené
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

// ---------- « N'a pas vu vos 3 derniers envois » (Tanguy, 21/11/2026) ----------
// Un envoi (photo, vidéo, message, vocal) ou un rappel « sans réponse » : pas de « vu » (visage ou OK) alors qu'il
// aurait dû être vu. Trois de suite, sans aucun signe de vie de la personne depuis le premier : on prévient les
// responsables, une fois par épisode. Tout signe de vie (toucher, visage, envoi lu, rappel vu ou fait) remet à zéro.
// Le serveur le déduit seul : rien à changer sur la tablette.
const NON_VUS_SEUIL = 3;
// Envoi : laissé à la tablette le temps de l'afficher (durée réglable 1 à 5 min) et de le noter « vu ».
const NON_VU_ENVOI_MS = 15 * 60_000;
// Rappel : affiché 1 h au plus à partir de son heure (tablette.js REMINDER_WINDOW_MIN), plus une marge.
const NON_VU_RAPPEL_MS = 75 * 60_000;
// On ne remonte pas plus loin (le filet « pas vue depuis N jours » prend le relais au-delà).
const NON_VUS_FENETRE_MS = 6 * JOUR_MS;
const HEURES_NON_VUS = { de: 9, a: 20 }; // jamais de notification inquiétante la nuit ni trop tôt

// « AAAA-MM-JJ HH:MM » (heure de la tablette, Paris) -> ms ; sinon null.
function heureTabletteEnMillis(texte) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/.exec(texte || '');
  if (!m) return null;
  const [an, mois, jour, h, min] = [m[1], m[2], m[3], m[4] || '00', m[5] || '00'].map(Number);
  // Décalage de Paris à cette date : on part de l'heure lue comme UTC et on corrige.
  const commeUtc = Date.UTC(an, mois - 1, jour, h, min);
  const decalage = minutesParis(commeUtc) - (h * 60 + min);
  const corr = ((decalage % 1440) + 2160) % 1440 - 720; // ramené entre -12 h et +12 h
  return commeUtc - corr * 60_000;
}

// Jour « AAAA-MM-JJ » et jour de la semaine (0 = dimanche) à Paris.
function jourEtSemaineParis(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const semaine = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { jour: `${parts.year}-${parts.month}-${parts.day}`, semaine };
}

// Même règle que happensOn sur la tablette (tablette.js).
function rappelCeJour(r, jour, semaine) {
  if (r.finLe && jour > r.finLe) return false;
  if (r.enPauseJusquau && jour <= r.enPauseJusquau) return false;
  if (r.repeat === 'daily') return true;
  if (r.repeat === 'weekly') return Array.isArray(r.days) && r.days.includes(semaine);
  return r.date === jour;
}

// Heures (ms) des rappels à afficher entre debut et fin, avec leur « vu » éventuel. vuLe : heure du dernier
// « vu » ou « fait » (lastSeen, lastAck) : une heure de rappel à laquelle il correspond (même jour, à partir de
// l'heure) est vue.
function occurrencesRappel(r, debut, fin) {
  if (!/^\d{2}:\d{2}$/.test(r.time || '')) return [];
  const sortie = [];
  const vus = [r.lastSeen, r.lastAck].filter((v) => typeof v === 'string');
  const cree = enMillis(r.createdAt) || 0;
  for (let t = debut - JOUR_MS; t <= fin + JOUR_MS; t += JOUR_MS) {
    const { jour, semaine } = jourEtSemaineParis(t);
    if (!rappelCeJour(r, jour, semaine)) continue;
    const quand = heureTabletteEnMillis(`${jour} ${r.time}`);
    if (quand === null || quand < debut || quand > fin || quand < cree) continue;
    if (sortie.some((o) => o.quand === quand)) continue;
    const vu = vus.some((v) => v.startsWith(jour) && heureTabletteEnMillis(v) >= quand);
    sortie.push({ quand, vu });
  }
  return sortie;
}

// Décision, sans base de données (alertes.test.js).
//   tablettes : fiches des tablettes de la famille ; envois : { createdAt, seenAt, type, authorUid } ;
//   rappels : documents de l'agenda ; veille : réglage de la famille.
// Renvoie { due, depuis, nombre } : depuis = dernier signe de vie (ms), nombre = envois et rappels sans réponse
// depuis.
function nonVus({ tablettes, envois = [], rappels = [], veille, maintenant }) {
  const rien = { due: false, depuis: null, nombre: 0 };
  if (!tablettes.length) return rien;
  // La tablette doit répondre : hors ligne, elle n'a rien reçu (l'alerte « ne répond plus » s'en charge).
  if (!tablettes.some((t) => enMillis(t.lastOnline) && etatAlerte(t, maintenant, veille) !== 'silence')) return rien;
  const uidsTablettes = new Set(tablettes.map((t) => t.uid).filter(Boolean));
  let signe = Math.max(0, ...tablettes.map((t) => derniereVue(t) || enMillis(t.joinedAt) || 0));
  if (!signe) return rien;
  const debut = Math.max(maintenant - NON_VUS_FENETRE_MS, 0);
  // Un envoi lu ou un rappel vu est aussi un signe de vie.
  const aMontrer = envois.filter((e) => e.type !== 'reply' && !uidsTablettes.has(e.authorUid));
  for (const e of aMontrer) signe = Math.max(signe, enMillis(e.seenAt) || 0);
  const occ = rappels.flatMap((r) => occurrencesRappel(r, debut, maintenant));
  for (const r of rappels) {
    for (const v of [r.lastSeen, r.lastAck]) {
      const ms = typeof v === 'string' ? heureTabletteEnMillis(v) : null;
      if (ms && ms <= maintenant) signe = Math.max(signe, ms);
    }
  }
  const depuis = Math.max(signe, debut);
  // Pendant la veille, rien n'est montré : ce qui arrive la nuit ne compte pas.
  const envoisSansReponse = aMontrer.filter((e) => {
    const quand = enMillis(e.createdAt);
    return quand && quand > depuis && maintenant - quand > NON_VU_ENVOI_MS && !enMillis(e.seenAt) && !enVeille(veille, quand);
  }).length;
  const rappelsSansReponse = occ.filter((o) => !o.vu && o.quand > depuis && maintenant - o.quand > NON_VU_RAPPEL_MS && !enVeille(veille, o.quand)).length;
  const nombre = envoisSansReponse + rappelsSansReponse;
  return { due: nombre >= NON_VUS_SEUIL, depuis: signe, nombre };
}

function messageNonVus(nom, nombre) {
  return {
    titre: `${nom} n'a pas vu vos ${nombre} derniers envois`,
    texte: 'Ni photo, ni message, ni rappel vu, et la tablette ne l\'a pas vue depuis. Un petit coup de fil pour prendre des nouvelles ?',
  };
}

// Lancée toutes les heures par taches.js ; ne fait rien hors de 9 h-20 h (Paris).
exports.alerteNonVus = async () => {
  const maintenant = Date.now();
  const heure = Math.floor(minutesParis(maintenant) / 60);
  if (heure < HEURES_NON_VUS.de || heure > HEURES_NON_VUS.a) return;
  const db = base();
  const enPause = await famillesEnPause(db, maintenant).catch((e) => { logger.warn('Pauses illisibles', e.message); return new Set(); });
  const familles = await db.collection('families').get();
  for (const fam of familles.docs) {
    const famille = fam.data();
    if (!estActif(famille.abonnement) || enPause.has(fam.id)) continue;
    try {
      const membres = await fam.ref.collection('members').where('role', '==', 'tablette').get();
      if (membres.empty) continue;
      const tablettes = membres.docs.map((t) => ({ ...t.data(), uid: t.id }));
      const depuisLe = new Date(maintenant - NON_VUS_FENETRE_MS);
      const [envois, rappels] = await Promise.all([
        fam.ref.collection('posts').where('createdAt', '>=', depuisLe).get(),
        fam.ref.collection('reminders').get(),
      ]);
      const r = nonVus({
        tablettes, veille: famille.veille, maintenant,
        envois: envois.docs.map((d) => d.data()), rappels: rappels.docs.map((d) => d.data()),
      });
      if (!r.due) continue;
      // Une seule alerte par épisode (même dernier signe de vie).
      if (famille.alerteNonVus && enMillis(famille.alerteNonVus.depuis) === r.depuis) continue;
      const responsables = [...new Set([famille.createdBy, ...(famille.admins || [])].filter(Boolean))];
      const n = await envoyer(db, fam.id, responsables, { type: 'alerte', ...messageNonVus(famille.name || 'Mamie', r.nombre) }, 6 * 3600);
      await fam.ref.update({ alerteNonVus: { le: new Date(maintenant), depuis: new Date(r.depuis), nombre: r.nombre } });
      await journal.noter(db, { genre: 'non-vus', fid: fam.id, tablette: tablettes.length === 1 ? tablettes[0].uid : null, telephones: n });
      logger.info(`Famille ${fam.id} : ${r.nombre} envois sans réponse, ${n} téléphone(s)`);
    } catch (e) {
      logger.error(`Famille ${fam.id} : alerte « non vus » non envoyée`, e.message);
    }
  }
};

exports.etatAlerte = etatAlerte;
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
exports.nonVus = nonVus;
exports.messageNonVus = messageNonVus;
exports.heureTabletteEnMillis = heureTabletteEnMillis;
exports.NON_VUS_SEUIL = NON_VUS_SEUIL;
