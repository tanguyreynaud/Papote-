// Promesses de l'app famille qui doivent rester vraies (audit « promesses » du 05/11/2026).
// Sans dépendance : node --test tests/promesses-app.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const web = path.join(__dirname, '..', 'web');
const texte = (f) => fs.readFileSync(path.join(web, f), 'utf8')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;| /g, ' ').replace(/\\'/g, "'").replace(/\s+/g, ' ');
const app = texte('index.html') + ' ' + texte('js/famille.js');

test('SOS : pas de « toute la famille sonne » ni « les téléphones sonnent » (SIM : SMS puis appels un par un)', () => {
  assert.doesNotMatch(app, /toute la famille sonne|les téléphones de la famille sonnent/);
  assert.match(app, /un par un/);
  assert.match(app, /pas un service d'urgence/);
});

test('Vos données : ne pas dire « personne d\'autre » (le compte admin de Papote peut lire, firestore.rules isAdmin)', () => {
  assert.doesNotMatch(app, /Personne d'autre, ni aucune publicité/);
  assert.match(app, /n'y accède que pour vous dépanner/);
});

test('veille annoncée = veille par défaut de l\'app', () => {
  const src = fs.readFileSync(path.join(web, 'js/famille.js'), 'utf8');
  assert.match(src, /const VEILLE_DEFAUT = \{ active: true, de: 21, a: 6, aMin: 30 \}/,
    'si la veille par défaut change, changer aussi le site (21 h à 6 h 30) et le guide du chat');
});
