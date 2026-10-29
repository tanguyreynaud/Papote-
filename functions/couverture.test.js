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
