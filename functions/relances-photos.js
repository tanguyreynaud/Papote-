// Petite relance des proches (Tanguy, 20/11/2026) : « Une photo pour Mamie Emma ? » sur le téléphone d'un proche qui
// n'a rien envoyé (photo, vidéo, message) depuis 7 jours. Sans reproche, en fin de journée (18 h, lancée par
// taches.js), jamais la nuit. Une par semaine ; après 2 relances restées sans envoi, une par mois. Repart de zéro dès
// que le proche envoie quelque chose.
//
// Rien quand ce n'est pas le moment :
//   - abonnement pas actif, ou famille en pause hospitalisation ;
//   - la tablette ne répond plus, ou « pas vue depuis N jours » (alertes.js) : la famille est déjà prévenue, et une
//     photo que personne ne regarde ne sert à rien ;
//   - proche arrivé il y a moins de 7 jours, en attente d'un responsable, ou la tablette elle-même ;
//   - proche qui a coupé « Petits rappels » (members/{uid}/private/push.rappelsPhotos == false, appli, Réglages).
// Le compte des relances est sur la fiche du proche : relancePhotos = { le, n } (écrit par le serveur seulement).
// Coût : une lecture des familles, de leurs membres et de leurs envois du dernier mois, une fois par jour.

const { logger } = require('firebase-functions/v2');
const { estActif } = require('./abonnement');
const { db: base } = require('./base');
const { envoyer } = require('./push');
const alertes = require('./alertes');

const JOUR = 24 * 3600_000;
const SANS_ENVOI = 7 * JOUR;
const ENTRE_RELANCES = 7 * JOUR;
const ENTRE_RELANCES_LONG = 30 * JOUR;
const RELANCES_AVANT_LONG = 2;
const FENETRE_ENVOIS = 31 * JOUR; // les envois relus pour trouver le dernier de chaque proche

function enMillis(date) {
  if (date == null) return null;
  if (typeof date === 'number') return date;
  if (date instanceof Date) return date.getTime();
  if (typeof date.toMillis === 'function') return date.toMillis();
  return null;
}

// Décision pour un proche, sans dépendance (relances-photos.test.js).
//   dernierEnvoi : son dernier envoi connu (ms) ou null ; arrivee : joinedAt (ms) ; etat : relancePhotos { le, n }.
// Renvoie { relancer, etat } : etat = ce qu'il faut écrire sur la fiche (null : rien à changer).
function decision({ dernierEnvoi, arrivee, etat, maintenant }) {
  const le = etat ? enMillis(etat.le) : null;
  let n = etat && Number.isInteger(etat.n) ? etat.n : 0;
  // Envoi après la dernière relance : on repart de zéro.
  const remise = le != null && dernierEnvoi != null && dernierEnvoi > le;
  if (remise) n = 0;
  const depuis = Math.max(dernierEnvoi || 0, arrivee || 0);
  if (!depuis || maintenant - depuis < SANS_ENVOI) {
    return { relancer: false, etat: remise ? { le: null, n: 0 } : null };
  }
  const derniere = remise ? null : le;
  const attente = n >= RELANCES_AVANT_LONG ? ENTRE_RELANCES_LONG : ENTRE_RELANCES;
  if (derniere != null && maintenant - derniere < attente) {
    return { relancer: false, etat: remise ? { le: null, n: 0 } : null };
  }
  return { relancer: true, etat: { le: maintenant, n: n + 1 } };
}

// Texte : du côté de la personne âgée, sans « vous n'avez pas… », sans accord au féminin (Papi Jean).
function message(nom) {
  const qui = nom || 'votre proche';
  return {
    titre: `Une photo pour ${qui} ?`,
    texte: `Un petit moment de votre journée, et ${qui} le voit tout de suite sur sa tablette.`,
  };
}

// La tablette répond et la personne a été vue récemment : sinon, pas de relance.
function tabletteRegardee(tablettes, famille, maintenant) {
  const reelles = tablettes.filter((t) => enMillis(t.lastOnline));
  if (!reelles.length) return false;
  if (reelles.every((t) => alertes.etatAlerte(t, maintenant) === 'silence')) return false;
  return !alertes.alertePasVueDue(tablettes, maintenant, famille.alertePasVueJours);
}

async function relancesPhotos({ db = base(), maintenant = Date.now(), pousser = envoyer } = {}) {
  const enPause = await alertes.famillesEnPause(db, maintenant).catch(() => new Set());
  const familles = await db.collection('families').get();
  let envoyees = 0;
  for (const fam of familles.docs) {
    const famille = fam.data();
    if (!estActif(famille.abonnement) || enPause.has(fam.id)) continue;
    try {
      const membres = await fam.ref.collection('members').get();
      const tablettes = membres.docs.filter((m) => m.get('role') === 'tablette').map((m) => m.data());
      if (!tabletteRegardee(tablettes, famille, maintenant)) continue;
      const proches = membres.docs.filter((m) => m.get('role') === 'famille' && m.get('status') !== 'pending');
      if (!proches.length) continue;
      const envois = await fam.ref.collection('posts').where('createdAt', '>=', new Date(maintenant - FENETRE_ENVOIS)).get();
      const dernier = new Map();
      for (const p of envois.docs) {
        const auteur = p.get('authorUid');
        const quand = enMillis(p.get('createdAt'));
        if (auteur && quand && quand > (dernier.get(auteur) || 0)) dernier.set(auteur, quand);
      }
      for (const m of proches) {
        const d = decision({
          dernierEnvoi: dernier.get(m.id) || null,
          arrivee: enMillis(m.get('joinedAt')),
          etat: m.get('relancePhotos'),
          maintenant,
        });
        if (d.relancer) {
          const prefs = await m.ref.collection('private').doc('push').get();
          if (prefs.exists && prefs.get('rappelsPhotos') === false) continue;
          const n = await pousser(db, fam.id, [m.id], { type: 'alerte', relance: 'photo', fid: fam.id, ...message(famille.name) }, 12 * 3600);
          // Aucun téléphone atteint (notifications pas autorisées) : rien de noté, on réessaiera demain.
          if (!n) continue;
          envoyees += 1;
        }
        if (d.etat) await m.ref.update({ relancePhotos: d.etat.le == null ? null : { le: new Date(d.etat.le), n: d.etat.n } });
      }
    } catch (e) {
      logger.error(`Famille ${fam.id} : relances photo non faites`, e.message);
    }
  }
  if (envoyees) logger.info(`Relances photo : ${envoyees} proche(s)`);
  return envoyees;
}

module.exports = { relancesPhotos, decision, message, tabletteRegardee, SANS_ENVOI, ENTRE_RELANCES, ENTRE_RELANCES_LONG };
