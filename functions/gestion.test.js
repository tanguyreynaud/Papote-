const test = require('node:test');
const assert = require('node:assert');
const { regles: g } = require('./gestion');

test('nature des mouvements Stripe', () => {
  assert.strictEqual(g.natureMouvement({ type: 'charge', source: { description: 'Subscription update' } }), 'abonnement');
  assert.strictEqual(g.natureMouvement({ type: 'charge', source: { description: 'Papote : tablette non rendue' } }),
    'tablette-non-rendue');
  assert.strictEqual(g.natureMouvement({ type: 'payment_refund', source: 're_1' }), 'remboursement');
  assert.strictEqual(g.natureMouvement({ type: 'refund' }), 'remboursement');
  assert.strictEqual(g.natureMouvement({ type: 'payout' }), 'virement');
  assert.strictEqual(g.natureMouvement({ type: 'stripe_fee' }), 'frais');
  assert.strictEqual(g.natureMouvement({ type: 'adjustment' }), 'autre');
});

test('montant mensuel d\'un abonnement', () => {
  const prix = (unit_amount, interval, extra = {}) => ({ price: { unit_amount, recurring: { interval, interval_count: 1 } }, ...extra });
  assert.strictEqual(g.mensuel({ items: { data: [prix(2000, 'month')] } }), 2000);
  assert.strictEqual(g.mensuel({ items: { data: [prix(24000, 'year')] } }), 2000);
  // Les 50 € de mise en service ne sont pas récurrents.
  assert.strictEqual(g.mensuel({ items: { data: [prix(3000, 'month'), { price: { unit_amount: 5000 } }] } }), 3000);
  assert.strictEqual(g.mensuel({ items: { data: [prix(1000, 'month', { quantity: 2 })] } }), 2000);
  assert.strictEqual(g.mensuel({}), 0);
});

test('saisies : montants et liens', () => {
  assert.strictEqual(g.centimes(8990), 8990);
  assert.strictEqual(g.centimes('8990'), 8990);
  assert.strictEqual(g.centimes(-1), null);
  assert.strictEqual(g.centimes(12.5), null);
  assert.strictEqual(g.centimes('abc'), null);
  assert.strictEqual(g.centimes(null), null);
  assert.strictEqual(g.centimes(''), null);
  assert.strictEqual(g.lien('https://exemple.fr/facture.pdf'), 'https://exemple.fr/facture.pdf');
  assert.strictEqual(g.lien('javascript:alert(1)'), null);
  assert.strictEqual(g.lien(''), null);
});

test('nom de fichier des pièces jointes', () => {
  assert.strictEqual(g.nomFichier('Facture Cdiscount n°12 été.pdf'), 'Facture-Cdiscount-n-12-ete.pdf');
  assert.strictEqual(g.nomFichier('../../secret'), '..-..-secret');
  assert.strictEqual(g.nomFichier(''), 'piece');
});
