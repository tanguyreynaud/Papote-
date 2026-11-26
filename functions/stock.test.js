const test = require('node:test');
const assert = require('node:assert');
const { tablettesDisponibles, placesDisponibles, vendable, delai } = require('./stock');

const maintenant = Date.parse('2026-10-19T14:00:00Z');
const compter = (d) => tablettesDisponibles({ stock: [], commandes: [], reservations: [], maintenant, ...d });

test('les fiches libres en stock ou préparées comptent', () => {
  assert.strictEqual(compter({ stock: [{ etat: 'en-stock' }, { etat: 'preparee' }, { etat: 'revenue' }, { etat: 'chez-client' }] }), 2);
});

test('une fiche reliée à une commande ne compte plus', () => {
  const stock = [{ etat: 'en-stock' }, { etat: 'preparee', commande: 'sub_1' }];
  assert.strictEqual(compter({ stock, commandes: [{ id: 'sub_1', expedition: 'a-preparer' }] }), 1);
});

test('une tablette jumelée à une famille sans commande (tablette de test) n\'est jamais à vendre', () => {
  assert.strictEqual(compter({ stock: [{ etat: 'en-stock', fid: 'famille-test' }] }), 0);
  assert.strictEqual(compter({ stock: [{ etat: 'preparee', fid: 'famille-test' }, { etat: 'en-stock' }] }), 1);
  assert.strictEqual(vendable(compter({ stock: [{ etat: 'en-stock', fid: 'famille-test' }] })), false);
});

test('une tablette pas mise en vente ne compte pas ; une fiche d\'avant (sans le champ) reste vendable (Tanguy, 25/11)', () => {
  assert.strictEqual(compter({ stock: [{ etat: 'en-stock', enVente: false }, { etat: 'preparee', enVente: false }] }), 0);
  assert.strictEqual(compter({ stock: [{ etat: 'preparee', enVente: false }, { etat: 'preparee', enVente: true }, { etat: 'en-stock' }] }), 2);
  assert.strictEqual(vendable(compter({ stock: [{ etat: 'preparee', enVente: false }] })), false);
});

test('une commande payée sans fiche prend une tablette', () => {
  const stock = [{ etat: 'en-stock' }, { etat: 'en-stock' }];
  const commandes = [{ id: 'a', expedition: 'a-preparer' }, { id: 'b', expedition: 'envoyee' }, { id: 'c', expedition: 'annulee' }];
  assert.strictEqual(compter({ stock, commandes }), 1);
});

test('un paiement en cours prend une tablette, plus après expiration', () => {
  const stock = [{ etat: 'en-stock' }];
  assert.strictEqual(compter({ stock, reservations: [{ expireLe: maintenant + 60_000 }] }), 0);
  assert.strictEqual(compter({ stock, reservations: [{ expireLe: { toMillis: () => maintenant - 1 } }] }), 1);
});

test('jamais en dessous de zéro', () => {
  assert.strictEqual(compter({ commandes: [{ id: 'a', expedition: 'a-preparer' }] }), 0);
});

test('une commande SEPA en attente de la banque garde sa tablette', () => {
  assert.strictEqual(compter({
    stock: [{ etat: 'en-stock' }, { etat: 'en-stock' }],
    commandes: [{ id: 'a', expedition: 'paiement-en-attente' }, { id: 'b', expedition: 'annulee' }],
  }), 1);
});

test('précommandes : stock + 10 commandes, 10 même avec un stock vide', () => {
  assert.strictEqual(placesDisponibles(0), 10);
  assert.strictEqual(placesDisponibles(3), 13);
  assert.strictEqual(placesDisponibles(-4), 6);
  assert.strictEqual(placesDisponibles(-10), 0);
  assert.strictEqual(placesDisponibles(-12), 0);
});

test('délai annoncé : stock, précommande jusqu\'à stock + 10, puis attente longue', () => {
  assert.strictEqual(delai(2), 'stock');
  assert.strictEqual(delai(1), 'stock');
  assert.strictEqual(delai(0), 'precommande');
  assert.strictEqual(delai(-9), 'precommande');
  assert.strictEqual(delai(-10), 'long');
  assert.strictEqual(delai(-40), 'long');
});

test('vendable : seulement le stock réel au lancement, précommandes si on vend sans stock', () => {
  assert.strictEqual(vendable(1), true);
  assert.strictEqual(vendable(0), false);
  assert.strictEqual(vendable(-3), false);
  assert.strictEqual(vendable(0, true), true);
  assert.strictEqual(vendable(-9, true), true);
  assert.strictEqual(vendable(-10, true), false);
});

test('accueil : l\'état du stock est écrit dans la page, une seule fois, et rien si le stock est illisible', () => {
  const { pageAvecStock } = require('./stock');
  const html = '<!doctype html>\n<html lang="fr">\n<head></head><body><a class="js-commander">Commander</a></body></html>';
  assert.match(pageAvecStock(html, true), /<html lang="fr" data-stock="ok">/);
  assert.match(pageAvecStock(html, false), /<html lang="fr" data-stock="complet">/);
  assert.strictEqual(pageAvecStock(html, null), html);
  assert.strictEqual(pageAvecStock(pageAvecStock(html, true), false), pageAvecStock(html, true), 'jamais deux fois');
  // Le vrai gabarit du site commence bien ainsi (sinon le stock ne serait jamais écrit).
  const vrai = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'vitrine', 'accueil.html'), 'utf8');
  assert.match(pageAvecStock(vrai, false), /data-stock="complet"/);
});

// Durées de garde du site (Tanguy, 20/11) : images 7 jours, polices 1 an, /api/stock 60 s, le reste redemandé.
// Les images n'ont pas d'empreinte dans leur nom : une image remplacée sous le même nom met jusqu'à 7 jours à
// changer chez un visiteur déjà venu ; pour un changement immédiat, lui donner un nouveau nom.
test('site : chaque image de vitrine/ est gardée 7 jours, les pages restent redemandées', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const racine = path.join(__dirname, '..');
  const regles = JSON.parse(fs.readFileSync(path.join(racine, 'firebase.vitrine.json'), 'utf8')).hosting.headers;
  const garde = (source) => regles.find((r) => r.source === source)?.headers.find((h) => h.key === 'Cache-Control')?.value;
  const images = regles.find((r) => /jpg/.test(r.source));
  assert.ok(images, 'une règle pour les images');
  assert.strictEqual(images.headers[0].value, 'public, max-age=604800');
  assert.ok(regles.indexOf(images) > regles.findIndex((r) => r.source === '**'), 'après « ** », sinon no-cache l\'emporte');
  const extensions = images.source.match(/@\(([^)]+)\)/)[1].split('|');
  const oubliees = fs.readdirSync(path.join(racine, 'vitrine'), { recursive: true })
    .filter((f) => /\.(jpe?g|png|webp|avif|svg|gif|ico)$/i.test(f))
    .filter((f) => !extensions.includes(path.extname(f).slice(1).toLowerCase()));
  assert.deepStrictEqual(oubliees, [], 'images sans durée de garde');
  assert.strictEqual(garde('**'), 'no-cache');
  assert.strictEqual(garde('/api/stock'), 'public, max-age=60, s-maxage=60');
});

// Sans cela, une image remplacée sous le même nom resterait 7 jours chez les visiteurs déjà venus.
test('site : chaque lien d\'image porte l\'empreinte du fichier (sinon : node outils/empreintes-images.js)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const outil = require('../outils/empreintes-images');
  assert.deepStrictEqual(outil.pagesEnRetard(), [], 'pages dont un lien d\'image n\'est pas à jour');
  const accueil = fs.readFileSync(path.join(__dirname, '..', 'vitrine', 'accueil.html'), 'utf8');
  assert.ok((accueil.match(/\.webp\?v=[0-9a-f]{8}/g) || []).length >= 15, 'les images de l\'accueil sont bien vues par l\'outil');
  // Image changée → lien changé ; adresse complète et nom inconnu laissés tels quels ; relancer ne change rien.
  const d = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'empreintes-'));
  try {
    fs.writeFileSync(path.join(d, 'a.webp'), 'un');
    const page = '<img src="a.webp" srcset="/a.webp 2x"><meta content="https://mapapote.fr/a.webp"><img src="b.png">';
    const v1 = outil.mettreAJour(page, d);
    assert.match(v1, /^<img src="a\.webp\?v=[0-9a-f]{8}" srcset="\/a\.webp\?v=[0-9a-f]{8} 2x"><meta content="https:\/\/mapapote\.fr\/a\.webp"><img src="b\.png">$/);
    assert.strictEqual(outil.mettreAJour(v1, d), v1);
    fs.writeFileSync(path.join(d, 'a.webp'), 'deux');
    assert.notStrictEqual(outil.mettreAJour(v1, d), v1);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
