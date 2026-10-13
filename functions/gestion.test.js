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

test('échéance suivante d\'une dépense mensuelle', () => {
  const jour = (s) => new Date(s).toISOString().slice(0, 10);
  assert.strictEqual(jour(g.moisSuivant(Date.UTC(2026, 0, 15, 12), 15)), '2026-02-15');
  // Le 31 devient le 28 en février, puis revient au 31 en mars.
  const fevrier = g.moisSuivant(Date.UTC(2026, 0, 31, 12), 31);
  assert.strictEqual(jour(fevrier), '2026-02-28');
  assert.strictEqual(jour(g.moisSuivant(fevrier, 31)), '2026-03-31');
  assert.strictEqual(jour(g.moisSuivant(Date.UTC(2026, 11, 5, 12), 5)), '2027-01-05');
});

test('lecture d\'une facture vers le formulaire', () => {
  const f = g.lectureVersFormulaire({
    estUneFacture: true,
    fournisseur: ' Cdiscount ',
    numero: 'F-123',
    date: '2026-10-02',
    totalTTC: 359.7,
    tva: 59.95,
    devise: 'EUR',
    categorie: 'tablettes',
    libelle: '3 tablettes',
    tablettes: { quantite: 3, modele: 'M107', prixUnitaireTTC: 119.9, numerosSerie: ['A1', ' ', 'A2', 'A3', 'A4'] },
    remarque: null,
  });
  assert.strictEqual(f.fournisseur, 'Cdiscount');
  assert.strictEqual(f.date, Date.UTC(2026, 9, 2, 12));
  assert.strictEqual(f.montant, 35970);
  assert.strictEqual(f.tva, 5995);
  assert.deepStrictEqual(f.tablettes, { quantite: 3, modele: 'M107', prixAchat: 11990, numeros: ['A1', 'A2', 'A3'] });
  // Valeurs absentes ou fantaisistes : rien plutôt qu'une erreur.
  const v = g.lectureVersFormulaire({ categorie: 'inconnue', date: 'hier', totalTTC: -3, tablettes: { quantite: 0 } });
  assert.strictEqual(v.categorie, 'autre');
  assert.strictEqual(v.date, null);
  assert.strictEqual(v.montant, null);
  assert.strictEqual(v.tablettes, null);
});
