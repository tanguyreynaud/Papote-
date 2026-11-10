const test = require('node:test');
const assert = require('node:assert');
const v = require('./factures-vente');

const T = Date.UTC(2026, 10, 3, 10) / 1000; // 3/11/2026
const facture = (o = {}) => ({ id: 'in_1', object: 'invoice', number: 'PAP-0001', status: 'paid', invoice_pdf: 'https://pdf/1', created: T, total: 2500, amount_paid: 2500, subscription: 'sub_A', ...o });

test('à garder : finalisée avec un numéro et un PDF (payée, ouverte, annulée), jamais un brouillon', () => {
  for (const status of ['paid', 'open', 'void', 'uncollectible']) assert.strictEqual(v.aGarder(facture({ status })), true, status);
  assert.strictEqual(v.aGarder(facture({ status: 'draft' })), false);
  assert.strictEqual(v.aGarder(facture({ number: null })), false);
  assert.strictEqual(v.aGarder(facture({ invoice_pdf: null })), false);
  assert.strictEqual(v.aGarder({ object: 'credit_note', number: 'AV-1', status: 'issued', pdf: 'https://pdf/a' }), true);
});

test('chemin : année d\'émission à Paris, type et numéro', () => {
  assert.strictEqual(v.cheminCopie(facture()), 'gestion/ventes/2026/facture-PAP-0001.pdf');
  // 31/12 à 23 h 30 UTC = 1er janvier à Paris.
  assert.strictEqual(v.cheminCopie(facture({ created: Date.UTC(2026, 11, 31, 23, 30) / 1000 })), 'gestion/ventes/2027/facture-PAP-0001.pdf');
  assert.strictEqual(v.cheminCopie({ object: 'credit_note', number: 'AV/2', created: T }), 'gestion/ventes/2026/avoir-AV_2.pdf');
});

test('PDF reconnu à son début ; abonnement lu aussi dans la nouvelle forme Stripe', () => {
  assert.strictEqual(v.estPdf(Buffer.from('%PDF-1.7 ...')), true);
  assert.strictEqual(v.estPdf(Buffer.from('<html>erreur</html>')), false);
  assert.strictEqual(v.estPdf(Buffer.alloc(0)), false);
  assert.strictEqual(v.idAbonnement({ parent: { subscription_details: { subscription: 'sub_B' } } }), 'sub_B');
  assert.deepStrictEqual(v.decouper('ABCD1234-0012'), { prefixe: 'ABCD1234', rang: 12 });
  assert.strictEqual(v.decouper('sans-numero-x'), null);
});

test('contrôle : tout va bien quand chaque facture a sa copie et son paiement', () => {
  const f1 = facture();
  const f2 = facture({ id: 'in_2', number: 'PAP-0002', subscription: 'sub_B' });
  const r = v.controleMois({
    factures: [f1, f2],
    mouvements: [{ facture: 'in_1', montant: 2500 }, { facture: 'in_2', montant: 2500 }],
    pieces: [{ id: 'in_1', type: 'facture', numero: 'PAP-0001' }, { id: 'in_2', type: 'facture', numero: 'PAP-0002' }],
  });
  assert.deepStrictEqual(r, []);
});

test('contrôle : copie manquante, payée sans paiement, doublon, trou de numérotation', () => {
  const ligne = (start) => ({ lines: { data: [{ period: { start } }] } });
  const f1 = facture({ ...ligne(100) });
  const f2 = facture({ id: 'in_2', number: 'PAP-0002', ...ligne(100) });
  const f3 = facture({ id: 'in_3', number: 'PAP-0005', status: 'open', amount_paid: 0, subscription: 'sub_C', ...ligne(100) });
  const r = v.controleMois({
    factures: [f1, f2, f3, facture({ id: 'in_d', status: 'draft' })],
    mouvements: [{ facture: 'in_1', montant: 2500 }],
    pieces: [{ id: 'in_1', type: 'facture', numero: 'PAP-0001' }, { id: 'in_3', type: 'facture', numero: 'PAP-0005' }],
  });
  assert.deepStrictEqual(r, [
    'Facture PAP-0002 : pas de copie du PDF chez Papote',
    'Facture PAP-0002 (25,00 €) : marquée payée mais aucun paiement trouvé',
    'Factures PAP-0001 et PAP-0002 : même abonnement, même mois (doublon ?)',
    'Numérotation : PAP-0002, PAP-0003, PAP-0004 manquent (aucune copie gardée)',
  ]);
});

test('contrôle : une facture annulée n\'est pas un doublon ; un remboursement n\'est pas un paiement', () => {
  const ligne = { lines: { data: [{ period: { start: 100 } }] } };
  const r = v.controleMois({
    factures: [facture({ status: 'void', amount_paid: 0, ...ligne }), facture({ id: 'in_2', number: 'PAP-0002', ...ligne })],
    mouvements: [{ facture: 'in_2', montant: -2500 }],
    pieces: [{ id: 'in_1', type: 'facture', numero: 'PAP-0001' }, { id: 'in_2', type: 'facture', numero: 'PAP-0002' }],
  });
  assert.deepStrictEqual(r, ['Facture PAP-0002 (25,00 €) : marquée payée mais aucun paiement trouvé']);
});

test('fiche gardée : type, numéro, montant, abonnement, empreinte', () => {
  const f = v.fiche(facture(), { chemin: 'c', octets: 10, sha256: 'x', maintenant: 5 });
  assert.deepStrictEqual(f, { type: 'facture', numero: 'PAP-0001', le: T * 1000, total: 2500, statut: 'paid', abonnement: 'sub_A', facture: null, chemin: 'c', octets: 10, sha256: 'x', copieLe: 5 });
  const a = v.fiche({ object: 'credit_note', id: 'cn_1', number: 'AV-1', created: T, amount: 6000, status: 'issued', invoice: 'in_1' }, { chemin: 'c', octets: 1, sha256: 'y', maintenant: 5 });
  assert.strictEqual(a.type, 'avoir');
  assert.strictEqual(a.total, 6000);
  assert.strictEqual(a.facture, 'in_1');
});
