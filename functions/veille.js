// Heures de veille de la famille (families/{fid}.veille) : { active, de, deMin, a, aMin }, heures 0-23,
// minutes 0 ou 30. Sans réglage : de 23 h à 5 h (Tanguy, 17/11/2026 ; avant : 21 h-6 h 30).
// Bornes choisies par Tanguy : coucher (de) entre 19 h et 23 h 30, réveil (a) entre 5 h et 10 h, par demi-heure.
// Une famille avait { de: 21, a: 20, aMin: 30 } : la tablette dormait 23 h 30 par jour.
const { HttpsError } = require('firebase-functions/v2/https');

const VEILLE_DEFAUT = Object.freeze({ active: true, de: 23, deMin: 0, a: 5, aMin: 0 });
// En minutes depuis minuit.
const COUCHER_MIN = 19 * 60;
const COUCHER_MAX = 23 * 60 + 30;
const REVEIL_MIN = 5 * 60;
const REVEIL_MAX = 10 * 60;

const heureOk = (h) => Number.isInteger(h) && h >= 0 && h <= 23;
const minOk = (m) => m === undefined || m === null || m === 0 || m === 30;

// Une heure lue telle quelle ({ de, deMin } ou { a, aMin }) en minutes, ou null si elle est mal formée.
function lire(h, m) {
  if (!heureOk(h)) return null;
  return h * 60 + (m === 30 ? 30 : 0);
}

const borner = (t, min, max) => Math.min(max, Math.max(min, t));
const enHeure = (t) => ({ h: Math.floor(t / 60), m: t % 60 });

// Réglage sûr pour le serveur, quoi que contienne la base : jamais d'exception.
// Absent ou mal formé : la valeur par défaut (heure par heure). Hors bornes : ramené à la borne la plus proche.
function veilleSure(v) {
  if (!v || typeof v !== 'object') return { ...VEILLE_DEFAUT };
  const de = lire(v.de, v.deMin);
  const a = lire(v.a, v.aMin);
  const coucher = enHeure(borner(de === null ? VEILLE_DEFAUT.de * 60 + VEILLE_DEFAUT.deMin : de, COUCHER_MIN, COUCHER_MAX));
  const reveil = enHeure(borner(a === null ? VEILLE_DEFAUT.a * 60 + VEILLE_DEFAUT.aMin : a, REVEIL_MIN, REVEIL_MAX));
  return { active: v.active !== false, de: coucher.h, deMin: coucher.m, a: reveil.h, aMin: reveil.m };
}

// Pour une fonction qui écrit le réglage : refuse tout ce qui sort des bornes (même règle que l'app famille).
function exigerVeilleValide(v) {
  const refus = (msg) => { throw new HttpsError('invalid-argument', msg); };
  if (!v || typeof v !== 'object' || Array.isArray(v)) refus('Réglage de la veille manquant.');
  if (typeof v.active !== 'boolean') refus('Veille : « active » doit valoir oui ou non.');
  if (!heureOk(v.de) || !heureOk(v.a) || !minOk(v.deMin) || !minOk(v.aMin)) {
    refus('Veille : heures entières de 0 à 23, minutes 0 ou 30.');
  }
  const de = lire(v.de, v.deMin);
  const a = lire(v.a, v.aMin);
  if (de < COUCHER_MIN || de > COUCHER_MAX) refus('Heure de coucher entre 19 h et 23 h 30.');
  if (a < REVEIL_MIN || a > REVEIL_MAX) refus('Heure de réveil entre 5 h et 10 h.');
  return { active: v.active, de: v.de, deMin: v.deMin === 30 ? 30 : 0, a: v.a, aMin: v.aMin === 30 ? 30 : 0 };
}

module.exports = { VEILLE_DEFAUT, veilleSure, exigerVeilleValide, COUCHER_MIN, COUCHER_MAX, REVEIL_MIN, REVEIL_MAX };
