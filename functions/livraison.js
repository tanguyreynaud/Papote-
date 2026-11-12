// Règles de livraison en point relais Mondial Relay, sans dépendance : testées par livraison.test.js.

const JOUR = 24 * 60 * 60 * 1000;
// Rappels au client dont la tablette est partie mais pas encore jumelée.
const RAPPELS_JOURS = [5, 12];
// Au-delà, la commande est signalée à l'administrateur.
const ALERTE_JOURS = 20;
// Tablette arrivée chez la personne (colis retiré, remise en main propre) et toujours hors famille : sans doute pas de
// connexion chez elle (pas de box, 4G faible). L'administrateur est prévenu (M0, Tanguy 12/11). Le seul endroit où
// régler ce délai (2 = 48 h ; 1 = 24 h) : les textes des alertes le reprennent.
const ALERTE_CONNEXION_JOURS = 2;
// Colis parti sans étiquette Sendcloud (n° de suivi tapé à la main) : personne ne note son retrait, il est compté
// arrivé à l'envoi + 3 jours (même estimation que les 30 jours pour changer d'avis, abonnement.js).
const ACHEMINEMENT_ESTIME_JOURS = 3;
// France seulement depuis l'offre unique (29/10/2026) : la carte SIM française n'est pas faite pour rester à l'étranger.
const PAYS_RELAIS = ['FR'];

function texte(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  return t && t.length <= max ? t : null;
}

// Point relais choisi sur le site (paramètres de l'adresse commander). null s'il est incomplet.
function relaisDepuisRequete(q) {
  const r = {
    id: texte(q.relais, 20),
    nom: texte(q.rnom, 100),
    adresse: texte(q.radr, 200),
    cp: texte(q.rcp, 10),
    ville: texte(q.rville, 100),
    pays: texte(q.rpays, 2),
  };
  if (!r.id || !/^[A-Za-z0-9-]+$/.test(r.id) || !r.nom || !r.cp || !r.ville) return null;
  // Prénom et nom de la personne qui retire le colis (étiquette Mondial Relay).
  const destinataire = texte(q.rdest, 80);
  if (destinataire) r.destinataire = destinataire;
  r.pays = (r.pays || 'FR').toUpperCase();
  if (!PAYS_RELAIS.includes(r.pays)) return null;
  return r;
}

// Le point relais voyage dans les métadonnées Stripe (clés « relais_* »).
function relaisVersMeta(r) {
  return {
    relais_id: r.id, relais_nom: r.nom, relais_adresse: r.adresse || '',
    relais_cp: r.cp, relais_ville: r.ville, relais_pays: r.pays,
    relais_destinataire: r.destinataire || '',
  };
}

function relaisDepuisMeta(m) {
  if (!m || !m.relais_id) return null;
  return {
    transporteur: 'mondial-relay', id: m.relais_id, nom: m.relais_nom || null,
    adresse: m.relais_adresse || null, cp: m.relais_cp || null,
    ville: m.relais_ville || null, pays: m.relais_pays || 'FR',
    destinataire: m.relais_destinataire || null,
  };
}

function normaliserSuivi(saisie) {
  if (typeof saisie !== 'string') return null;
  const s = saisie.replace(/\s+/g, '').toUpperCase();
  return /^[A-Z0-9]{6,30}$/.test(s) ? s : null;
}

function lienSuivi(suivi, cp) {
  const p = new URLSearchParams({ numeroExpedition: suivi });
  if (cp) p.set('codePostal', cp);
  return `https://www.mondialrelay.fr/suivi-de-colis/?${p}`;
}

// Numéro du rappel à envoyer maintenant (1, 2...), ou null. envoyeeMs : départ du colis.
function rappelDu(envoyeeMs, dejaEnvoyes, maintenant) {
  if (envoyeeMs == null) return null;
  const n = dejaEnvoyes || 0;
  if (n >= RAPPELS_JOURS.length) return null;
  return maintenant - envoyeeMs >= RAPPELS_JOURS[n] * JOUR ? n + 1 : null;
}

// recuMs : colis retiré (preparation.recuLe, nombre ou Timestamp).
function alerteConnexionDue(recuMs, maintenant) {
  const r = recuMs && typeof recuMs.toMillis === 'function' ? recuMs.toMillis() : recuMs;
  return Number.isFinite(r) && maintenant - r >= ALERTE_CONNEXION_JOURS * JOUR;
}

// Arrivée de la tablette chez la personne (pure, testée) : { le (ms), comment } ou null si on ne la connaît pas.
//   main-propre  remise par Papote (tabletteEnvoyee, mainPropre) : preparation.recuLe est le jour de la remise
//   retrait      colis retiré au relais (suivi Sendcloud « Delivered ») ou date notée dans l'admin
//   estimee      colis sans étiquette Sendcloud, retrait jamais noté : envoi + ACHEMINEMENT_ESTIME_JOURS
// Colis avec étiquette Sendcloud pas encore retiré : null (pas chez la personne ; « retour expéditeur » à part).
function arriveeTablette(c) {
  if (!c) return null;
  const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v);
  const recu = ms(c.preparation && c.preparation.recuLe);
  if (Number.isFinite(recu)) return { le: recu, comment: c.remise === 'main-propre' ? 'main-propre' : 'retrait' };
  const envoi = ms(c.envoyeeLe);
  if (c.etiquettes && c.etiquettes.aller && c.etiquettes.aller.colis) return null;
  return Number.isFinite(envoi) ? { le: envoi + ACHEMINEMENT_ESTIME_JOURS * JOUR, comment: 'estimee' } : null;
}

// « 48 h », « 24 h » : le délai de l'alerte, écrit comme Tanguy le dit.
const delaiConnexion = () => `${Math.round(ALERTE_CONNEXION_JOURS * 24)} h`;
const COMMENT_ARRIVEE = {
  'main-propre': 'remise en main propre',
  retrait: 'colis retiré',
  estimee: 'colis parti sans suivi',
};

// E-mail à Papote (titre, détail) et ligne de « À faire » de l'alerte « pas encore connectée » (pure, testée).
function alerteConnexion(c, comment) {
  const qui = c.nom || c.email || c.id || '';
  const quoi = COMMENT_ARRIVEE[comment] || COMMENT_ARRIVEE.retrait;
  const depuis = comment === 'estimee'
    ? `Colis parti il y a ${ALERTE_CONNEXION_JOURS + ACHEMINEMENT_ESTIME_JOURS} jours sans suivi Sendcloud (compté arrivé ${ACHEMINEMENT_ESTIME_JOURS} jours après l'envoi)`
    : comment === 'main-propre' ? `Remise en main propre il y a ${delaiConnexion()}` : `Colis retiré il y a ${delaiConnexion()}`;
  return {
    titre: `Tablette pas encore connectée, ${quoi} il y a ${comment === 'estimee' ? `${ALERTE_CONNEXION_JOURS + ACHEMINEMENT_ESTIME_JOURS} jours` : delaiConnexion()} : ${qui}`,
    detail: `${depuis} : la tablette n'est toujours pas entrée dans sa famille. L'écran de la tablette dit à la personne que Papote est prévenu et s'en occupe. Le plus souvent, elle n'a pas de connexion chez la personne (pas de box, wifi à choisir, 4G faible). Appelez le client pour l'aider.`,
    aFaire: `Tablette de ${qui} pas encore connectée, ${quoi} : appeler le client`,
  };
}

function alerteDue(envoyeeMs, maintenant) {
  return envoyeeMs != null && maintenant - envoyeeMs >= ALERTE_JOURS * JOUR;
}

module.exports = {
  RAPPELS_JOURS, ALERTE_JOURS, ALERTE_CONNEXION_JOURS, ACHEMINEMENT_ESTIME_JOURS, PAYS_RELAIS,
  arriveeTablette, alerteConnexion, delaiConnexion,
  relaisDepuisRequete, relaisVersMeta, relaisDepuisMeta,
  normaliserSuivi, lienSuivi, rappelDu, alerteDue, alerteConnexionDue,
};
