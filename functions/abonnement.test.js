const test = require('node:test');
const assert = require('node:assert');
const a = require('./abonnement');

const JOUR = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 8);

test('famille sans champ abonnement : active', () => {
  assert.strictEqual(a.estActif(undefined), true);
  assert.strictEqual(a.estActif({}), true);
});

test('statuts actifs et bloqués', () => {
  for (const s of ['offert', 'actif', 'impaye']) assert.strictEqual(a.estActif({ statut: s }), true, s);
  for (const s of ['suspendu', 'resilie', 'aucun']) assert.strictEqual(a.estActif({ statut: s }), false, s);
});

test('paiement réussi : actif, sans délai de grâce', () => {
  assert.deepStrictEqual(a.statutDepuisStripe('active', { statut: 'suspendu', graceJusqua: T0 }, T0),
    { statut: 'actif', graceJusqua: null });
});

test('premier retard : impayé avec 7 jours de grâce', () => {
  const r = a.statutDepuisStripe('past_due', { statut: 'actif' }, T0);
  assert.strictEqual(r.statut, 'impaye');
  assert.strictEqual(r.graceJusqua, T0 + 7 * JOUR);
});

test('retard qui se prolonge : le délai ne repart pas de zéro', () => {
  const actuel = { statut: 'impaye', graceJusqua: T0 + 2 * JOUR };
  const r = a.statutDepuisStripe('past_due', actuel, T0);
  assert.deepStrictEqual(r, { statut: 'impaye', graceJusqua: T0 + 2 * JOUR });
});

test('retard après la fin du délai : suspendu', () => {
  const actuel = { statut: 'suspendu', graceJusqua: T0 - JOUR };
  assert.strictEqual(a.statutDepuisStripe('past_due', actuel, T0).statut, 'suspendu');
});

test('impayé définitif, résiliation, premier paiement en attente', () => {
  assert.strictEqual(a.statutDepuisStripe('unpaid', null, T0).statut, 'suspendu');
  assert.strictEqual(a.statutDepuisStripe('canceled', null, T0).statut, 'resilie');
  assert.strictEqual(a.statutDepuisStripe('incomplete', null, T0).statut, 'aucun');
});

test('fin du délai de grâce', () => {
  assert.strictEqual(a.graceDepassee({ statut: 'impaye', graceJusqua: T0 - 1 }, T0), true);
  assert.strictEqual(a.graceDepassee({ statut: 'impaye', graceJusqua: T0 + 1 }, T0), false);
  assert.strictEqual(a.graceDepassee({ statut: 'actif' }, T0), false);
});

test('une famille offerte ne change jamais', () => {
  assert.strictEqual(a.peutModifier({ statut: 'offert' }), false);
  assert.strictEqual(a.peutModifier({ statut: 'actif' }), true);
  assert.strictEqual(a.peutModifier(undefined), true);
});

test('formules', () => {
  assert.strictEqual(a.formuleValide('wifi', 'incluse'), true);
  assert.strictEqual(a.formuleValide('sim', 'achetee'), true);
  assert.strictEqual(a.formuleValide('4g', 'incluse'), false);
});

test('résiliation sans engagement : à la fin du mois payé', () => {
  const periode = T0 + 10 * JOUR;
  assert.strictEqual(a.dateResiliation(periode, T0), periode);
  assert.strictEqual(a.dateResiliation(null, T0), T0);
});

test('essai gratuit d\'un mois', () => {
  assert.strictEqual(a.ESSAI_JOURS, 30);
});

test('tablette incluse non rendue : pénalité après 30 jours', () => {
  assert.strictEqual(a.limiteRestitution(T0), T0 + 30 * JOUR);
  assert.strictEqual(a.restitutionEchue({ statut: 'attendue', avant: T0 - 1 }, T0), true);
  assert.strictEqual(a.restitutionEchue({ statut: 'attendue', avant: T0 + JOUR }, T0), false);
  assert.strictEqual(a.restitutionEchue({ statut: 'rendue', avant: T0 - 1 }, T0), false);
  assert.strictEqual(a.restitutionEchue({ statut: 'facturee', avant: T0 - 1 }, T0), false);
});

test('code de commande', () => {
  const code = a.nouveauCode();
  assert.strictEqual(code.length, 8);
  assert.strictEqual(a.normaliserCode(code), code);
  assert.strictEqual(a.normaliserCode(' abcd-efgh '), 'ABCDEFGH');
  assert.strictEqual(a.normaliserCode('ABCD-EFG0'), null);
  assert.strictEqual(a.normaliserCode('ABC'), null);
  assert.strictEqual(a.afficherCode('ABCDEFGH'), 'ABCD-EFGH');
});

test('rétractation : toujours possible avant l\'envoi', () => {
  assert.strictEqual(a.retractationPossible({ expedition: 'a-preparer', creeLe: T0 - 60 * JOUR }, T0), true);
});

test('rétractation : 30 jours après la réception estimée (envoi + 3 jours)', () => {
  const c = { expedition: 'envoyee', creeLe: T0, envoyeeLe: T0 + 2 * JOUR };
  assert.strictEqual(a.limiteRetractation(T0, T0 + 2 * JOUR), T0 + 35 * JOUR);
  assert.strictEqual(a.retractationPossible(c, T0 + 35 * JOUR), true);
  assert.strictEqual(a.retractationPossible(c, T0 + 35 * JOUR + 1), false);
});

test('rétractation : une seule fois', () => {
  assert.strictEqual(a.retractationPossible({ expedition: 'a-preparer', retractation: { le: T0 } }, T0), false);
  assert.strictEqual(a.retractationPossible(null, T0), false);
});

test('rappel de restitution : une fois, dans les 7 derniers jours', () => {
  const r = { statut: 'attendue', avant: T0 + 10 * JOUR };
  assert.strictEqual(a.rappelRestitutionDu(r, T0), false);
  assert.strictEqual(a.rappelRestitutionDu(r, T0 + 3 * JOUR), true);
  assert.strictEqual(a.rappelRestitutionDu({ ...r, rappelLe: T0 }, T0 + 3 * JOUR), false);
  assert.strictEqual(a.rappelRestitutionDu(r, T0 + 10 * JOUR), false);
  assert.strictEqual(a.rappelRestitutionDu({ ...r, statut: 'rendue' }, T0 + 3 * JOUR), false);
});

test('matériel non rendu : prix par élément, plafonné au matériel prêté', () => {
  assert.strictEqual(a.penaliteRestitution({ formule: 'wifi' }), 14000);
  assert.strictEqual(a.penaliteRestitution({ formule: 'sim', enceinteFournie: true }), 15000);
  assert.strictEqual(a.montantManquants({ formule: 'wifi' }, ['chargeur']), 1000);
  assert.strictEqual(a.montantManquants({}, ['enceinte', 'chargeur', 'chargeur']), 1000);
  assert.strictEqual(a.montantManquants({ enceinteFournie: true }, ['enceinte']), 1000);
  assert.strictEqual(a.montantManquants({ enceinteFournie: true }, []), 0);
  assert.strictEqual(a.PENALITE_NON_RESTITUTION, 14000);
});
