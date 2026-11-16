// Sauvegarde du dimanche en retard (audit 12/11, A31 ; défaut A15-3 : un échec du dimanche ne prévenait personne).
// La sauvegarde tourne sur le PC de Tanguy (outils/admin/sauvegarder.js, tâche Windows du dimanche) : quand elle
// réussit (écrite, relue et contrôlée), elle note la date dans interne/sauvegarde. Si le PC reste éteint, si la
// tâche n'est pas installée, si la sauvegarde échoue, rien n'arrive : c'est donc le serveur qui regarde.
//
// Chaque jour à 9 h (taches.js, dans tachesHoraires : pas de nouvelle tâche planifiée), alerteSauvegarde :
//   - plus de 8 jours depuis la dernière sauvegarde réussie → UN e-mail à Papote (prevenirPapote), une seule fois
//     pour cette sauvegarde (alerteEnvoyeePour) : pas un e-mail par jour. Une nouvelle sauvegarde réussie remet
//     le compteur ; si elle vieillit à son tour, un nouvel e-mail part.
//   - le relevé n'existe pas encore (avant la première sauvegarde de cette version) : la date du premier contrôle
//     est notée (premierControle) et sert de départ ; on ne prévient pas le jour même de la mise en ligne.
// Tant que le retard dure, une ligne « À faire » le dit (récap du lundi et accueil de l'admin : ligneAFaire).
//
// interne/sauvegarde : { derniereReussie, nom, base, documents, comptes, octets, fichiersGestion, copieChiffree,
//   dernierEchec, erreur } écrits par le PC ; { premierControle, alerteEnvoyeePour, alerteEnvoyeeLe } par ce fichier.
// Coût : une lecture et au plus une écriture par jour.
const { Timestamp } = require('firebase-admin/firestore');

const JOUR = 864e5;
const DELAI = 8 * JOUR;
const DOCUMENT = 'interne/sauvegarde';

const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : typeof v === 'number' ? v : null);
const date = (t) => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'Europe/Paris' });

// État du relevé (données du document, ou null) : { enRetard, depuis (ms), jours, reussie (bool), cle }.
function etat(s, maintenant) {
  if (!s) return { enRetard: false, depuis: null, jours: 0, reussie: false, cle: null };
  const reussie = ms(s.derniereReussie);
  const depuis = reussie || ms(s.premierControle);
  if (!depuis) return { enRetard: false, depuis: null, jours: 0, reussie: false, cle: null };
  return { enRetard: maintenant - depuis > DELAI, depuis, jours: Math.floor((maintenant - depuis) / JOUR), reussie: !!reussie, cle: String(depuis) };
}

const echec = (s) => (s && s.erreur && ms(s.dernierEchec) ? ` Dernier essai raté le ${date(ms(s.dernierEchec))} : ${s.erreur}` : '');

// La ligne « À faire » (récap du lundi, accueil de l'admin), ou null.
function ligneAFaire(s, maintenant) {
  const e = etat(s, maintenant);
  if (!e.enRetard) return null;
  return e.reussie
    ? `Sauvegarde du dimanche en retard : la dernière réussie date du ${date(e.depuis)} (${e.jours} jours). Allumer le PC et lancer sauvegarder.bat, puis regarder journal.txt`
    : `Aucune sauvegarde du dimanche réussie depuis ${e.jours} jours. Installer ou relancer la sauvegarde sur le PC (installer-sauvegarde-hebdo.bat), puis regarder journal.txt`;
}

// La tâche du jour. prevenir(titre, detail) : prevenirPapote d'index.js. Rend 'alerte', 'debut' ou null.
async function alerteSauvegarde({ db, prevenir, maintenant = Date.now() }) {
  const ref = db.doc(DOCUMENT);
  const decision = await db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) {
      t.set(ref, { premierControle: Timestamp.fromMillis(maintenant) });
      return { quoi: 'debut' };
    }
    const s = snap.data();
    const e = etat(s, maintenant);
    if (!e.enRetard || s.alerteEnvoyeePour === e.cle) return null;
    t.update(ref, { alerteEnvoyeePour: e.cle, alerteEnvoyeeLe: Timestamp.fromMillis(maintenant) });
    return { quoi: 'alerte', s, e };
  });
  if (!decision || decision.quoi !== 'alerte') return decision ? decision.quoi : null;
  const { s, e } = decision;
  await prevenir(
    e.reussie ? `Sauvegarde : aucune réussie depuis ${e.jours} jours` : `Sauvegarde : aucune réussie depuis la mise en route (${e.jours} jours)`,
    `${e.reussie ? `La dernière sauvegarde réussie de la base date du ${date(e.depuis)}.` : 'Aucune sauvegarde réussie n\'a encore été signalée par le PC.'}`
      + `${echec(s)} La sauvegarde du dimanche tourne sur le PC (tâche Windows « Papote - sauvegarde hebdomadaire ») : `
      + 'allumer le PC, lancer outils\\admin\\sauvegarder.bat et regarder journal.txt dans le dossier des sauvegardes. '
      + 'Cet e-mail ne part qu\'une fois ; la ligne reste dans « À faire » tant qu\'aucune sauvegarde ne réussit.',
  );
  return 'alerte';
}

module.exports = { alerteSauvegarde, ligneAFaire, etat, DELAI, DOCUMENT };
