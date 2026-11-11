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
  assert.strictEqual(a.formuleValide('sim', 'incluse'), true);
  assert.strictEqual(a.formuleValide('sim', 'achetee'), false);
  assert.strictEqual(a.formuleValide('4g', 'incluse'), false);
});

test('offre unique : tout compris avec la carte SIM, même depuis un ancien lien Wi-Fi', () => {
  assert.strictEqual(a.formuleVendue('sim', 'incluse'), 'sim');
  assert.strictEqual(a.formuleVendue('wifi', 'incluse'), 'sim');
  assert.strictEqual(a.formuleVendue(undefined), 'sim');
  assert.strictEqual(a.formuleVendue('', 'incluse'), 'sim');
  assert.strictEqual(a.formuleVendue('sim', 'achetee'), null);
  assert.strictEqual(a.formuleVendue('4g', 'incluse'), null);
});

test('résiliation sans engagement : à la fin du mois payé', () => {
  const periode = T0 + 10 * JOUR;
  assert.strictEqual(a.dateResiliation(periode, T0), periode);
  assert.strictEqual(a.dateResiliation(null, T0), T0);
});

test('rien prélevé avant la réception : date de premier prélèvement d\'après le délai annoncé, jamais d\'« essai gratuit »', () => {
  // Une semaine de plus depuis l'offre unique (ligne SIM ouverte à la commande).
  assert.strictEqual(a.premierPrelevementMs('stock', T0), T0 + 37 * JOUR);
  assert.strictEqual(a.premierPrelevementMs('long', T0), T0 + 37 * JOUR, 'un seul délai annoncé, quel que soit le stock');
  assert.strictEqual(a.premierPrelevementMs('stock', T0, { dejaInstallee: true }), T0 + 30 * JOUR);
  // Abonnement Stripe : trial recalé à l'envoi, ou date de départ pas encore atteinte, sinon rien.
  assert.strictEqual(a.premierPrelevementDe({ status: 'trialing', trial_end: (T0 + JOUR) / 1000 }, T0), T0 + JOUR);
  assert.strictEqual(a.premierPrelevementDe({ status: 'active', billing_cycle_anchor: (T0 + JOUR) / 1000 }, T0), T0 + JOUR);
  assert.strictEqual(a.premierPrelevementDe({ status: 'active', billing_cycle_anchor: (T0 - JOUR) / 1000 }, T0), null);
  assert.strictEqual(a.premierPrelevementDe({ status: 'past_due', billing_cycle_anchor: (T0 + JOUR) / 1000 }, T0), null);
  assert.strictEqual(a.premierPrelevementDe(null, T0), null);
});

test('tablette incluse non rendue : pénalité après 30 jours', () => {
  assert.strictEqual(a.limiteRestitution(T0), T0 + 30 * JOUR);
  assert.strictEqual(a.limiteRestitution(T0, { deces: false }), T0 + 30 * JOUR);
  assert.strictEqual(a.limiteRestitution(T0, { deces: true }), T0 + 60 * JOUR, 'après un décès : 60 jours');
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

test('rétractation : paiement SEPA en attente = tablette pas partie, rien à rendre', () => {
  const c = { expedition: 'paiement-en-attente', creeLe: T0 - 60 * JOUR };
  assert.strictEqual(a.materielParti(c), false);
  assert.strictEqual(a.retractationPossible(c, T0), true);
});

test('rétractation : commande déjà annulée, plus rien à annuler', () => {
  assert.strictEqual(a.retractationPossible({ expedition: 'annulee', creeLe: T0 }, T0 + JOUR), false);
});

test('matériel parti : seulement une fois la tablette envoyée', () => {
  assert.strictEqual(a.materielParti({ expedition: 'a-preparer' }), false);
  assert.strictEqual(a.materielParti({ expedition: 'annulee' }), false);
  assert.strictEqual(a.materielParti({ expedition: 'annulee', envoyeeLe: T0 }), true);
  assert.strictEqual(a.materielParti({ expedition: 'envoyee' }), true);
  assert.strictEqual(a.materielParti(null), false);
});

test('rétractation : 30 jours après la réception estimée (envoi + 3 jours)', () => {
  const c = { expedition: 'envoyee', creeLe: T0, envoyeeLe: T0 + 2 * JOUR };
  assert.strictEqual(a.limiteRetractation(T0, T0 + 2 * JOUR), T0 + 35 * JOUR);
  assert.strictEqual(a.retractationPossible(c, T0 + 35 * JOUR), true);
  assert.strictEqual(a.retractationPossible(c, T0 + 35 * JOUR + 1), false);
});

test('rétractation : 30 jours après la vraie réception quand elle est connue', () => {
  const c = { expedition: 'envoyee', creeLe: T0, envoyeeLe: T0 + 2 * JOUR, preparation: { recuLe: T0 + 9 * JOUR } };
  assert.strictEqual(a.limiteRetractation(T0, T0 + 2 * JOUR, T0 + 9 * JOUR), T0 + 39 * JOUR);
  assert.strictEqual(a.receptionDe(c), T0 + 9 * JOUR);
  assert.strictEqual(a.retractationPossible(c, T0 + 39 * JOUR), true);
  assert.strictEqual(a.retractationPossible(c, T0 + 39 * JOUR + 1), false);
  assert.strictEqual(a.receptionDe({ expedition: 'envoyee' }), null);
});

test('mauvais payeur : contestation, impayés, matériel', () => {
  assert.deepStrictEqual(a.raisonsMauvaisPayeur({ expedition: 'envoyee' }, 'actif'), []);
  assert.deepStrictEqual(a.raisonsMauvaisPayeur({ contestations: [{ montant: 2000 }] }, null), ['prélèvement contesté à la banque']);
  assert.deepStrictEqual(a.raisonsMauvaisPayeur({ restitution: { statut: 'facturee' }, dernierMois: { statut: 'echec' } }, 'suspendu'),
    ['dernier mois impayé', 'matériel jamais rendu', 'abonnement impayé']);
  assert.deepStrictEqual(a.raisonsMauvaisPayeur(null, null), []);
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

test('reprise d\'un abonnement résilié : rien à annuler (pas de mise en service)', () => {
  assert.strictEqual(a.retractationPossible({ expedition: 'envoyee', creeLe: T0, envoyeeLe: T0, reprise: true }, T0 + JOUR), false);
  assert.strictEqual(a.retractationPossible({ expedition: 'envoyee', creeLe: T0, envoyeeLe: T0 }, T0 + JOUR), true);
});

test('famille suspendue depuis plus de 30 jours : retour de la tablette à demander', () => {
  assert.strictEqual(a.suspendueDepuisTrop({ statut: 'suspendu', suspenduLe: T0 - 31 * JOUR }, T0), true);
  assert.strictEqual(a.suspendueDepuisTrop({ statut: 'suspendu', suspenduLe: T0 - 29 * JOUR }, T0), false);
  // Anciennes familles sans suspenduLe : la date de mise à jour fait foi.
  assert.strictEqual(a.suspendueDepuisTrop({ statut: 'suspendu', majLe: T0 - 40 * JOUR }, T0), true);
  assert.strictEqual(a.suspendueDepuisTrop({ statut: 'impaye', suspenduLe: T0 - 40 * JOUR }, T0), false);
  assert.strictEqual(a.suspendueDepuisTrop(undefined, T0), false);
});

test('installation finie sans commande : 48 h de tolérance avant la pause', () => {
  assert.ok(a.TOLERANCE_INSTALLATION_MS === 48 * 3600e3);
  assert.strictEqual(a.toleranceDepassee({ statut: 'installation', toleranceJusqua: T0 - 1 }, T0), true);
  assert.strictEqual(a.toleranceDepassee({ statut: 'installation', toleranceJusqua: T0 + 1 }, T0), false);
  // Installation en cours (pas de tolérance posée) : rien ne change.
  assert.strictEqual(a.toleranceDepassee({ statut: 'installation' }, T0), false);
  assert.strictEqual(a.toleranceDepassee({ statut: 'aucun', toleranceJusqua: T0 - 1 }, T0), false);
});

test('qui prévenir quand le paiement échoue : une fois par épisode', () => {
  assert.strictEqual(a.avisPaiement({ statut: 'actif' }, 'impaye'), 'impaye');
  assert.strictEqual(a.avisPaiement({ statut: 'impaye' }, 'impaye'), null);
  assert.strictEqual(a.avisPaiement({ statut: 'impaye' }, 'suspendu'), 'suspendu');
  assert.strictEqual(a.avisPaiement({ statut: 'suspendu' }, 'suspendu'), null);
  assert.strictEqual(a.avisPaiement({ statut: 'suspendu' }, 'actif'), null);
  assert.strictEqual(a.avisPaiement(undefined, 'impaye'), 'impaye');
});

test('factures montrées à la famille : payées et à payer, sans brouillon ni annulée', () => {
  const base = { id: 'in_1', number: 'PAP-0001', created: 1761000000, amount_paid: 6000, amount_due: 6000, invoice_pdf: 'https://pdf', hosted_invoice_url: 'https://page' };
  assert.deepStrictEqual(a.factureClient({ ...base, status: 'paid' }), {
    id: 'in_1', numero: 'PAP-0001', le: 1761000000000, montant: 6000, statut: 'payee', pdf: 'https://pdf', page: 'https://page',
  });
  assert.strictEqual(a.factureClient({ ...base, status: 'open', amount_due: 2000 }).statut, 'a-payer');
  assert.strictEqual(a.factureClient({ ...base, status: 'open', amount_due: 2000 }).montant, 2000);
  assert.strictEqual(a.factureClient({ ...base, status: 'draft' }), null);
  assert.strictEqual(a.factureClient({ ...base, status: 'void' }), null);
});

test('garderAbonnementActuel : une deuxième commande ne remplace pas un abonnement en cours', () => {
  const actuel = { statut: 'actif', stripeSubscriptionId: 'sub_A' };
  assert.equal(a.garderAbonnementActuel(actuel, 'sub_B', 'active'), true);
  assert.equal(a.garderAbonnementActuel(actuel, 'sub_B', 'past_due'), true);
  // L'ancien est fini chez Stripe : le nouveau prend sa place (réabonnement après résiliation).
  assert.equal(a.garderAbonnementActuel(actuel, 'sub_B', 'canceled'), false);
  assert.equal(a.garderAbonnementActuel(actuel, 'sub_B', null), false);
  // Même abonnement, ou famille sans abonnement : rien à garder.
  assert.equal(a.garderAbonnementActuel(actuel, 'sub_A', 'active'), false);
  assert.equal(a.garderAbonnementActuel(null, 'sub_B', 'active'), false);
});

test('reprise malgré un retour : seulement Papote, retour anticipé encore attendu, sans main propre (02/11)', () => {
  assert.strictEqual(a.reprisePossible(null, false), true);
  assert.strictEqual(a.reprisePossible(undefined, true), true);
  assert.strictEqual(a.reprisePossible({ statut: 'attendue', anticipe: true }, true), true);
  assert.strictEqual(a.reprisePossible({ statut: 'attendue', anticipe: true }, false), false, 'la famille écrit à Papote');
  assert.strictEqual(a.reprisePossible({ statut: 'attendue' }, true), false, 'abonnement fini : retour normal');
  assert.strictEqual(a.reprisePossible({ statut: 'attendue', anticipe: true, mainPropreLe: 1 }, true), false);
  assert.strictEqual(a.reprisePossible({ statut: 'echec', anticipe: true }, true), false);
  assert.strictEqual(a.reprisePossible({ statut: 'rendue', anticipe: true }, true), false);
});

test('SEPA : moyen noté depuis le type Stripe (Link = carte)', () => {
  assert.strictEqual(a.moyenDe('card'), 'carte');
  assert.strictEqual(a.moyenDe('link'), 'carte');
  assert.strictEqual(a.moyenDe('sepa_debit'), 'sepa');
  assert.strictEqual(a.moyenDe('paypal'), 'paypal');
  assert.strictEqual(a.moyenDe(undefined), null);
});

test('SEPA : encart et e-mails 15 jours après le premier prélèvement par carte, relance unique à +30 jours (10/11)', () => {
  const fam = (paiement, abonnement = { statut: 'actif' }) => ({ paiement, abonnement });
  const carte = { moyen: 'carte', premierLe: T0 };
  // Avant J+15 : rien.
  assert.strictEqual(a.sepaPropose(fam(carte), T0 + 14 * JOUR), false);
  assert.strictEqual(a.mailSepaDu(fam(carte), T0 + 14 * JOUR), null);
  // J+15 : encart et premier e-mail.
  assert.strictEqual(a.sepaPropose(fam(carte), T0 + 15 * JOUR), true);
  assert.strictEqual(a.mailSepaDu(fam(carte), T0 + 15 * JOUR), 'mail');
  // Premier e-mail parti : rien avant 30 jours, puis une seule relance.
  const mail = { ...carte, sepaMailLe: T0 + 15 * JOUR };
  assert.strictEqual(a.mailSepaDu(fam(mail), T0 + 44 * JOUR), null);
  assert.strictEqual(a.mailSepaDu(fam(mail), T0 + 45 * JOUR), 'relance');
  assert.strictEqual(a.mailSepaDu(fam({ ...mail, sepaRelanceLe: T0 + 45 * JOUR }), T0 + 400 * JOUR), null);
  // L'encart reste tant que la famille paie par carte (il se masque 7 jours côté appli).
  assert.strictEqual(a.sepaPropose(fam({ ...mail, sepaRelanceLe: T0 + 45 * JOUR }), T0 + 400 * JOUR), true);
  // Firestore Timestamp accepté.
  assert.strictEqual(a.mailSepaDu(fam({ moyen: 'carte', premierLe: { toMillis: () => T0 } }), T0 + 15 * JOUR), 'mail');
});

test('SEPA : rien pour le SEPA, sans premier prélèvement, en retard, en pause, arrêt prévu ou offerte', () => {
  const tard = T0 + 100 * JOUR;
  const carte = { moyen: 'carte', premierLe: T0 };
  assert.strictEqual(a.sepaPropose({ paiement: { moyen: 'sepa', premierLe: T0 }, abonnement: { statut: 'actif' } }, tard), false);
  assert.strictEqual(a.sepaPropose({ paiement: { moyen: 'carte' }, abonnement: { statut: 'actif' } }, tard), false);
  assert.strictEqual(a.sepaPropose({ abonnement: { statut: 'actif' } }, tard), false);
  for (const statut of ['impaye', 'suspendu', 'resilie', 'offert', 'aucun', 'installation']) {
    assert.strictEqual(a.sepaPropose({ paiement: carte, abonnement: { statut } }, tard), false, statut);
    assert.strictEqual(a.mailSepaDu({ paiement: carte, abonnement: { statut } }, tard), null, statut);
  }
  assert.strictEqual(a.sepaPropose({ paiement: carte, abonnement: { statut: 'actif', resiliationLe: tard } }, tard), false);
  assert.strictEqual(a.sepaPropose({ paiement: carte }, tard), false);
  assert.strictEqual(a.sepaPropose(null, tard), false);
});

test('arrêt automatique (Tanguy, 11/11) : suspendue depuis 30 jours, pas encore arrêtée, avec un abonnement Stripe', () => {
  const base = { statut: 'suspendu', suspenduLe: T0 - 31 * JOUR, stripeSubscriptionId: 'sub_1' };
  assert.strictEqual(a.arretAutomatiqueDu(base, T0), true);
  assert.strictEqual(a.arretAutomatiqueDu({ ...base, suspenduLe: T0 - 29 * JOUR }, T0), false);
  assert.strictEqual(a.arretAutomatiqueDu({ ...base, resiliationLe: T0 + 10 * JOUR }, T0), false, 'déjà arrêtée');
  assert.strictEqual(a.arretAutomatiqueDu({ ...base, stripeSubscriptionId: null }, T0), false);
  assert.strictEqual(a.arretAutomatiqueDu({ ...base, statut: 'offert' }, T0), false);
});

test('remplacement de la tablette (Tanguy, 11/11) : panne gratuite, casse 130 €, perte 140 € ou 150 €, offerte jamais', () => {
  assert.strictEqual(a.montantRemplacement('panne', {}), 0);
  assert.strictEqual(a.montantRemplacement('casse', {}), 13000);
  assert.strictEqual(a.montantRemplacement('perte', {}), 14000);
  assert.strictEqual(a.montantRemplacement('perte', { enceinteFournie: true }), 15000);
  assert.strictEqual(a.montantRemplacement('casse', { offerte: true }), 0);
  assert.strictEqual(a.montantRemplacement('autre', {}), null);
  assert.strictEqual(a.montantRemplacement(undefined, {}), null);
  assert.strictEqual(a.descriptionRemplacement('casse'), 'Papote : tablette cassée, remplacée');
});
