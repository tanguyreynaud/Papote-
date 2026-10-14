const test = require('node:test');
const assert = require('node:assert');
const { sectionAvis, pageAvecAvis } = require('./avis');

test('aucun avis visible : pas de section', () => {
  assert.strictEqual(sectionAvis([]), '');
  assert.strictEqual(sectionAvis([{ prenom: 'A', texte: 'x', visible: false }]), '');
  assert.strictEqual(pageAvecAvis('<main><!-- AVIS --></main>', []), '<main></main>');
});

test('avis visibles triés, échappés, avec note', () => {
  const html = sectionAvis([
    { prenom: 'Luc', texte: 'Deux', visible: true, ordre: 2 },
    { prenom: 'Anne <b>', relation: 'fille de Jeanne', ville: 'Lyon', texte: 'Un "super"', note: 4, visible: true, ordre: 1 },
  ]);
  assert.ok(html.indexOf('Anne') < html.indexOf('Luc'));
  assert.ok(html.includes('Anne &lt;b&gt;'));
  assert.ok(html.includes('fille de Jeanne, Lyon'));
  assert.ok(html.includes('★★★★☆'));
  assert.ok(!html.includes('<b>Anne <b>'));
});
