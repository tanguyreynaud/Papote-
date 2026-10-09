// Règles de livraison en point relais Mondial Relay, sans dépendance : testées par livraison.test.js.

const JOUR = 24 * 60 * 60 * 1000;
// Rappels au client dont la tablette est partie mais pas encore jumelée.
const RAPPELS_JOURS = [5, 12];
// Au-delà, la commande est signalée à l'administrateur.
const ALERTE_JOURS = 20;
const PAYS_RELAIS = ['FR', 'BE', 'LU'];

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
  r.pays = (r.pays || 'FR').toUpperCase();
  if (!PAYS_RELAIS.includes(r.pays)) return null;
  return r;
}

// Le point relais voyage dans les métadonnées Stripe (clés « relais_* »).
function relaisVersMeta(r) {
  return {
    relais_id: r.id, relais_nom: r.nom, relais_adresse: r.adresse || '',
    relais_cp: r.cp, relais_ville: r.ville, relais_pays: r.pays,
  };
}

function relaisDepuisMeta(m) {
  if (!m || !m.relais_id) return null;
  return {
    transporteur: 'mondial-relay', id: m.relais_id, nom: m.relais_nom || null,
    adresse: m.relais_adresse || null, cp: m.relais_cp || null,
    ville: m.relais_ville || null, pays: m.relais_pays || 'FR',
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

function alerteDue(envoyeeMs, maintenant) {
  return envoyeeMs != null && maintenant - envoyeeMs >= ALERTE_JOURS * JOUR;
}

module.exports = {
  RAPPELS_JOURS, ALERTE_JOURS, PAYS_RELAIS,
  relaisDepuisRequete, relaisVersMeta, relaisDepuisMeta,
  normaliserSuivi, lienSuivi, rappelDu, alerteDue,
};
