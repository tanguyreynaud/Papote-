// En-têtes de sécurité de l'appli famille et de l'admin (audit du 19/11/2026, W1 et W2).
// Sans dépendance : node --test tests/entetes-securite.test.js
//
// L'appli et l'admin sont servis par la même adresse. Sans ces en-têtes, une page piégée peut afficher l'admin ou
// l'appli dans un cadre invisible et faire cliquer la personne connectée sur « Résilier », « Rembourser » ou
// « Supprimer la famille » (détournement de clic). Aucune page de Papote n'affiche l'appli dans un cadre.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const racine = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(racine, 'firebase.json'), 'utf8'));
const regles = config.hosting.headers || [];
// Les pages (l'accueil « / » et tous les .html) portent les en-têtes ; pas « ** » : l'adresse réservée
// /__/auth/iframe, que la connexion Google affiche dans un cadre caché, ne doit jamais les recevoir.
const SOURCES_PAGES = ['/', '**/*.html'];
const valeurs = (source, nom) => {
  const r = regles.find((h) => h.source === source);
  const e = r && r.headers.find((x) => x.key.toLowerCase() === nom.toLowerCase());
  return e ? e.value : null;
};
const entete = (nom) => {
  const v = SOURCES_PAGES.map((s) => valeurs(s, nom));
  assert.ok(v.every((x) => x === v[0]), `${nom} : même valeur pour « / » et les .html`);
  return v[0];
};

test('La connexion Google garde son cadre caché : rien de plus que le cache sur « ** »', () => {
  const tout = regles.find((h) => h.source === '**');
  assert.deepEqual(tout.headers.map((h) => h.key), ['Cache-Control']);
});

test('Aucune autre page ne peut afficher l\'appli ou l\'admin dans un cadre', () => {
  assert.equal(entete('X-Frame-Options'), 'DENY');
  assert.match(entete('Content-Security-Policy') || '', /frame-ancestors 'none'/);
});

test('Pas de greffon, pas de <base> détourné, type des fichiers respecté, adresse complète jamais envoyée ailleurs', () => {
  const csp = entete('Content-Security-Policy') || '';
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.equal(entete('X-Content-Type-Options'), 'nosniff');
  assert.equal(entete('Referrer-Policy'), 'strict-origin-when-cross-origin');
});

test('La politique ne bride ni les scripts ni les connexions (Google, Stripe, Firebase) : à faire à part, avec essais réels', () => {
  const csp = entete('Content-Security-Policy') || '';
  assert.doesNotMatch(csp, /script-src|connect-src|default-src/);
});

test('Les pages de l\'appli n\'utilisent ni cadre ni <base> ni greffon (sinon ces en-têtes les casseraient)', () => {
  const web = path.join(racine, 'web');
  for (const f of fs.readdirSync(web).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(web, f), 'utf8');
    assert.doesNotMatch(html, /<(iframe|object|embed|base)[\s>]/i, f);
  }
});

test('Toujours relu à chaque ouverture (une nouvelle version arrive tout de suite)', () => {
  assert.equal(valeurs('**', 'Cache-Control'), 'no-cache');
});
