const test = require('node:test');
const assert = require('node:assert');
const c = require('./couverture');

test('Lambert-93 : mêmes coordonnées que la bibliothèque de référence (pyproj), au millimètre', () => {
  const { x, y } = c.lambert93(45.764, 4.835); // Lyon
  assert.ok(Math.abs(x - 842612.2665) < 0.01 && Math.abs(y - 6519923.1023) < 0.01);
  const p = c.lambert93(47.21, -1.55); // Nantes
  assert.ok(Math.abs(p.x - 355796.0596) < 0.01 && Math.abs(p.y - 6688775.9024) < 0.01);
});

test('couverture 4G Bouygues : niveaux relevés sur la carte de l\'ARCEP (2026_T2)', () => {
  assert.strictEqual(c.niveauA(45.764, 4.835), 'TBC', 'Lyon, centre');
  assert.strictEqual(c.niveauA(48.85, 2.35), 'TBC', 'Paris');
  assert.strictEqual(c.niveauA(45.4882, 3.5141), 'CL', 'Livradois (Puy-de-Dôme) : limitée');
  assert.strictEqual(c.niveauA(48.0501, 5.694), null, 'Haute-Marne : pas de couverture');
  assert.strictEqual(c.niveauA(46.5, -3), null, 'en mer');
});

test('éligible seulement en très bonne ou bonne couverture, en France métropolitaine', () => {
  assert.deepStrictEqual(c.verifier('45.764', '4.835'), { niveau: 'TBC', eligible: true, trimestre: '2026_T2' });
  assert.strictEqual(c.verifier(45.4882, 3.5141).eligible, false, 'limitée : la tablette reste dans la maison');
  assert.strictEqual(c.verifier(48.0501, 5.694).eligible, false);
  assert.deepStrictEqual(c.verifier('50.85', '4.35'), { niveau: null, eligible: false, trimestre: '2026_T2' }, 'Bruxelles : hors carte');
  assert.deepStrictEqual(c.verifier('abc', ''), { niveau: null, eligible: false, trimestre: null });
  assert.strictEqual(c.coordonnees(-21.1, 55.5), null, 'La Réunion : hors France métropolitaine');
});

// Carré de côté d (m) autour d'un point, en Lambert-93 (comme les contours de la Géoplateforme).
function carre(lat, lon, d) {
  const { x, y } = c.lambert93(lat, lon);
  return { type: 'Polygon', coordinates: [[[x - d, y - d], [x + d, y - d], [x + d, y + d], [x - d, y + d], [x - d, y - d]]] };
}

test('commune seule : part de sa surface bien couverte', () => {
  assert.strictEqual(c.partCouverte(carre(45.764, 4.835, 1000)), 1, 'Lyon, centre');
  assert.strictEqual(c.partCouverte(carre(48.0501, 5.694, 300)), 0, 'Haute-Marne, zone blanche');
  const trouee = carre(45.764, 4.835, 1000);
  trouee.coordinates.push(carre(45.764, 4.835, 500).coordinates[0]);
  assert.strictEqual(c.partCouverte({ type: 'MultiPolygon', coordinates: [trouee.coordinates] }), 1, 'trou et multipolygone');
});

test('commune seule : acceptée à partir de 95 % bien couverts, sinon la rue est demandée', async () => {
  const contour = (g) => async (url) => {
    assert.match(url, /code_insee%3D'69123'/);
    return { ok: true, json: async () => ({ features: g ? [{ geometry: g }] : [] }) };
  };
  assert.deepStrictEqual(await c.verifierCommune('69123', { chercher: contour(carre(45.764, 4.835, 1000)) }), { part: 1, eligible: true, trimestre: '2026_T2' });
  assert.strictEqual(await c.verifierCommune('abc', { chercher: contour(null) }), null, 'code INSEE invalide');
  const p = await c.procheDepuisRequete({ padr: 'Lyon', plat: '45.76', plon: '4.83', pinsee: '69123' });
  assert.deepStrictEqual(p, { adresse: 'Lyon', lat: 45.76, lon: 4.83, niveau: 'commune:100', eligible: true }, 'résultat gardé en mémoire');
  const bof = { padr: 'Quelque part', plat: '48.05', plon: '5.69', pinsee: '52001' };
  const panne = async () => ({ ok: false, status: 500 });
  assert.strictEqual(await c.procheDepuisRequete(bof, { chercher: panne }), null, 'contour introuvable : pas de paiement');
  const blanc = async () => ({ ok: true, json: async () => ({ features: [{ geometry: carre(48.0501, 5.694, 300) }] }) });
  assert.strictEqual((await c.procheDepuisRequete(bof, { chercher: blanc })).eligible, false);
});
