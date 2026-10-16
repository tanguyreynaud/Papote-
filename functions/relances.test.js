const test = require('node:test');
const assert = require('node:assert');
const { soirParis, relanceDue } = require('./relances');

const H = 3600e3;
// 15 octobre 2026, 14 h à Paris (12 h UTC, heure d'été).
const cree = Date.UTC(2026, 9, 15, 12);

test('19 h à Paris, été et hiver', () => {
  assert.strictEqual(soirParis(cree, 1), Date.UTC(2026, 9, 16, 17));
  // 22 octobre : encore l'heure d'été ; 1er novembre : heure d'hiver.
  assert.strictEqual(soirParis(cree, 7), Date.UTC(2026, 9, 22, 17));
  assert.strictEqual(soirParis(cree, 17), Date.UTC(2026, 10, 1, 18));
});

test('trois relances aux bons moments', () => {
  assert.strictEqual(relanceDue(cree, 0, cree + 30 * 60e3), null);
  assert.strictEqual(relanceDue(cree, 0, cree + H), 1);
  assert.strictEqual(relanceDue(cree, 1, cree + 2 * H), null);
  assert.strictEqual(relanceDue(cree, 1, Date.UTC(2026, 9, 16, 17)), 2);
  assert.strictEqual(relanceDue(cree, 2, Date.UTC(2026, 9, 20, 17)), null);
  assert.strictEqual(relanceDue(cree, 2, Date.UTC(2026, 9, 22, 17, 30)), 3);
  assert.strictEqual(relanceDue(cree, 3, Date.UTC(2026, 9, 30)), null);
});

test('relance en retard sautée, jamais deux à la suite', () => {
  // Rien d'envoyé et déjà le lendemain soir : seulement la 2e.
  assert.strictEqual(relanceDue(cree, 0, Date.UTC(2026, 9, 16, 18)), 2);
});
