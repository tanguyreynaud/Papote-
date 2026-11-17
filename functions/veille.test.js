const test = require('node:test');
const assert = require('node:assert');
const { VEILLE_DEFAUT, veilleSure, exigerVeilleValide } = require('./veille');

test('veille par défaut : de 23 h à 5 h (Tanguy, 17/11/2026)', () => {
  assert.deepStrictEqual({ ...VEILLE_DEFAUT }, { active: true, de: 23, deMin: 0, a: 5, aMin: 0 });
  assert.deepStrictEqual(veilleSure(undefined), { active: true, de: 23, deMin: 0, a: 5, aMin: 0 });
  assert.deepStrictEqual(veilleSure(null), { active: true, de: 23, deMin: 0, a: 5, aMin: 0 });
  assert.deepStrictEqual(veilleSure('21-6'), { active: true, de: 23, deMin: 0, a: 5, aMin: 0 });
});

test('réglage dans les bornes : gardé tel quel', () => {
  assert.deepStrictEqual(veilleSure({ active: true, de: 22, deMin: 30, a: 7 }), { active: true, de: 22, deMin: 30, a: 7, aMin: 0 });
  assert.deepStrictEqual(veilleSure({ active: false, de: 19, a: 10 }), { active: false, de: 19, deMin: 0, a: 10, aMin: 0 });
  assert.deepStrictEqual(veilleSure({ de: 23, deMin: 30, a: 5 }), { active: true, de: 23, deMin: 30, a: 5, aMin: 0 });
});

test('réglage d\'une vraie famille { de: 21, a: 20, aMin: 30 } : réveil ramené à 10 h', () => {
  assert.deepStrictEqual(veilleSure({ de: 21, a: 20, aMin: 30 }), { active: true, de: 21, deMin: 0, a: 10, aMin: 0 });
});

test('hors bornes : ramené à la borne la plus proche ; mal formé : valeur par défaut, heure par heure', () => {
  assert.deepStrictEqual(veilleSure({ active: true, de: 0, deMin: 30, a: 23, aMin: 30 }), { active: true, de: 19, deMin: 0, a: 10, aMin: 0 });
  assert.deepStrictEqual(veilleSure({ active: true, de: 18, deMin: 30, a: 4, aMin: 30 }), { active: true, de: 19, deMin: 0, a: 5, aMin: 0 });
  assert.deepStrictEqual(veilleSure({ active: true, de: 10, deMin: 30, a: 10, aMin: 30 }), { active: true, de: 19, deMin: 0, a: 10, aMin: 0 });
  assert.deepStrictEqual(veilleSure({ active: true, de: '22', a: 7.5 }), { active: true, de: 23, deMin: 0, a: 5, aMin: 0 });
  assert.deepStrictEqual(veilleSure({ active: true, de: 22, a: 25 }), { active: true, de: 22, deMin: 0, a: 5, aMin: 0 });
  // Minutes autres que 30 : comptées 0, comme sur la tablette (Veille.minutes).
  assert.deepStrictEqual(veilleSure({ de: 22, deMin: 15, a: 7, aMin: 45 }), { active: true, de: 22, deMin: 0, a: 7, aMin: 0 });
});

test('écriture : réglage dans les bornes accepté', () => {
  assert.deepStrictEqual(exigerVeilleValide({ active: true, de: 23, deMin: 30, a: 5 }), { active: true, de: 23, deMin: 30, a: 5, aMin: 0 });
  assert.deepStrictEqual(exigerVeilleValide({ active: false, de: 19, deMin: 0, a: 10, aMin: 0 }), { active: false, de: 19, deMin: 0, a: 10, aMin: 0 });
});

test('écriture : hors bornes ou mal formé, refusé (invalid-argument, message en français)', () => {
  const refuse = (v, motif) => assert.throws(() => exigerVeilleValide(v), (e) => e.code === 'invalid-argument' && motif.test(e.message));
  refuse({ active: true, de: 21, a: 20, aMin: 30 }, /réveil entre 5 h et 10 h/);
  refuse({ active: true, de: 0, deMin: 30, a: 7 }, /coucher entre 19 h et 23 h 30/);
  refuse({ active: true, de: 18, deMin: 30, a: 7 }, /coucher/);
  refuse({ active: true, de: 22, a: 10, aMin: 30 }, /réveil/);
  refuse({ active: true, de: 22, a: 4, aMin: 30 }, /réveil/);
  refuse({ active: true, de: 22, deMin: 15, a: 7 }, /minutes 0 ou 30/);
  refuse({ active: true, de: '22', a: 7 }, /heures entières/);
  refuse({ de: 22, a: 7 }, /active/);
  refuse(null, /manquant/);
});
