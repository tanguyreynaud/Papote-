// Compteur de dépenses de l'API, calculé depuis les jetons renvoyés par chaque réponse.
// Prix au million de jetons (page des prix Anthropic, relevés le 03/11/2026). Lot (Batches) = moitié prix.
'use strict';

const fs = require('fs');
const path = require('path');

const PRIX = {
  'claude-haiku-5-5': { entree: 0.10, sortie: 0.50, ecritureCache: 0.125, lectureCache: 0.01 },
  'claude-sonnet-5-5': { entree: 2.00, sortie: 10.00, ecritureCache: 2.50, lectureCache: 0.10 },
  'claude-opus-5-5': { entree: 4.00, sortie: 20.00, ecritureCache: 5.00, lectureCache: 0.20 },
};

const FICHIER = path.join(__dirname, 'resultats', 'couts.json');

function lire() {
  try { return JSON.parse(fs.readFileSync(FICHIER, 'utf8')); } catch { return { total: 0, parModele: {}, appels: 0 }; }
}

let etat = lire();

function cout(modele, u, lot = false) {
  const p = PRIX[modele];
  if (!p) throw new Error(`Prix inconnu pour ${modele}`);
  const d = ((u.input_tokens || 0) * p.entree + (u.output_tokens || 0) * p.sortie
    + (u.cache_creation_input_tokens || 0) * p.ecritureCache + (u.cache_read_input_tokens || 0) * p.lectureCache) / 1e6;
  return lot ? d / 2 : d;
}

function ajouter(modele, usage, lot = false) {
  const d = cout(modele, usage, lot);
  etat = lire(); // plusieurs bancs peuvent tourner en même temps : on repart du fichier
  etat.total += d;
  etat.appels += 1;
  const m = etat.parModele[modele] || (etat.parModele[modele] = { dollars: 0, entree: 0, sortie: 0, cacheLu: 0, cacheEcrit: 0 });
  m.dollars += d; m.entree += usage.input_tokens || 0; m.sortie += usage.output_tokens || 0;
  m.cacheLu += usage.cache_read_input_tokens || 0; m.cacheEcrit += usage.cache_creation_input_tokens || 0;
  fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
  fs.writeFileSync(FICHIER, JSON.stringify(etat, null, 1));
  return d;
}

const total = () => (etat = lire()).total;
const dollars = (x) => `${x.toFixed(3).replace('.', ',')} $`;

module.exports = { PRIX, cout, ajouter, total, dollars, lire: () => (etat = lire()) };
