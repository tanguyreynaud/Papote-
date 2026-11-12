// Famille préparée dès la commande (famille-preparee.js) : règles pures.
const test = require('node:test');
const assert = require('node:assert');
const { regles } = require('./famille-preparee');
const { prepareePour, decisionJumelage } = regles;
const statuts = require('./statuts');
const mail = require('./mail');

test('une commande du site reçoit sa famille au paiement, pas un abonnement pris dans l\'appli ni une reprise', () => {
  assert.strictEqual(prepareePour({ email: 'a@b.fr', fid: null }, {}), true);
  assert.strictEqual(prepareePour({ fid: 'F1' }, {}), false, 'déjà reliée : jamais une deuxième famille');
  assert.strictEqual(prepareePour({ fid: null }, { fid: 'F1' }), false, 'abonnement pris depuis l\'appli : famille connue');
  assert.strictEqual(prepareePour({ fid: null }, { dejaInstallee: '1' }), false);
  assert.strictEqual(prepareePour({ fid: null }, { reprise: '1' }), false);
  assert.strictEqual(prepareePour({ fid: null, offerte: true }, {}), false);
  assert.strictEqual(prepareePour({ fid: null, expedition: 'annulee' }, {}), false);
  assert.strictEqual(prepareePour(null, {}), false);
});

test('la tablette entre seule dans la famille de sa commande, seulement une fois le colis parti', () => {
  const fiche = { etat: 'envoyee', commande: 'sub_1', ref: 'T-003' };
  const commande = { fid: 'F1', expedition: 'envoyee' };
  const famille = { installation: { preparee: true } };
  assert.deepStrictEqual(decisionJumelage({ fiche, commande, famille }), { etat: 'jumeler', fid: 'F1' });
  assert.strictEqual(decisionJumelage({ fiche: null, commande, famille }).etat, 'inconnue', 'n° de série non prouvé : rien');
  assert.strictEqual(decisionJumelage({ fiche: { ...fiche, etat: 'perdue' }, commande, famille }).etat, 'bloquee', 'colis perdu : tablette refusée');
  assert.strictEqual(decisionJumelage({ fiche: { ...fiche, etat: 'hors-service' }, commande, famille }).etat, 'bloquee');
  assert.strictEqual(decisionJumelage({ fiche: { ...fiche, commande: null }, commande: null, famille }).etat, 'sans-commande');
  assert.strictEqual(decisionJumelage({ fiche, commande: { ...commande, fid: null }, famille: null }).etat, 'sans-famille');
  assert.strictEqual(decisionJumelage({ fiche, commande, famille: { installation: { etape: 'fini' } } }).etat, 'pas-preparee',
    'ancienne commande : le QR code comme avant');
  assert.strictEqual(decisionJumelage({ fiche, commande: { ...commande, expedition: 'a-preparer' }, famille }).etat, 'pas-envoyee',
    'allumée chez Tanguy pendant la préparation : pas encore dans la famille');
  assert.strictEqual(decisionJumelage({ fiche: { ...fiche, fid: 'F2' }, commande, famille }).etat, 'autre-famille');
  assert.strictEqual(decisionJumelage({ fiche: { ...fiche, fid: 'F1', etat: 'chez-client' }, commande, famille }).etat, 'jumeler',
    'tablette remise à zéro chez la famille : elle y revient seule');
});

test('« Colis déposé » refuse une tablette qui n\'est pas celle de la commande (A14-4)', () => {
  const reliees = [{ etat: 'preparee', ref: 'T-003' }];
  assert.strictEqual(statuts.refusAutreTablette('T-003', reliees), '');
  assert.strictEqual(statuts.refusAutreTablette('t3', reliees), '', 'saisie sans tiret ni zéros');
  assert.strictEqual(statuts.refusAutreTablette('', reliees), '', 'sans numéro saisi : rien n\'est vérifié');
  assert.match(statuts.refusAutreTablette('T-005', reliees), /T-005.*pas celle de cette commande \(T-003\)/);
  assert.match(statuts.refusAutreTablette('T-003', [{ etat: 'perdue', ref: 'T-003' }]), /pas celle/);
});

test('e-mails d\'une famille préparée : espace famille prêt, pas de code à scanner', () => {
  const lien = 'https://app.mapapote.fr/?code=ABCD-EFGH';
  const conf = mail.commandeConfirmee({ nom: 'Paul', code: 'WXYZ-2345', famille: lien });
  assert.match(conf.text, /espace famille Papote est déjà prêt/);
  assert.match(conf.text, /Ouvrir mon espace famille : https:\/\/app\.mapapote\.fr\/\?code=ABCD-EFGH/);
  assert.doesNotMatch(conf.text, /scanner|scannerez/);
  // Plus aucun code à scanner, même sans famille préparée (Tanguy 12/11, A29).
  const ancien = mail.commandeConfirmee({ nom: 'Paul', code: 'WXYZ-2345' });
  assert.doesNotMatch(ancien.text, /scann/);
  for (const m of [
    mail.colisParti({ nom: 'Paul', suivi: '123', lien: 'https://x', code: 'WXYZ-2345', preparee: true }),
    mail.tabletteRemise({ nom: 'Paul', code: 'WXYZ-2345', preparee: true }),
    mail.rappelJumelage({ nom: 'Paul', numero: 1, code: 'WXYZ-2345', preparee: true }),
  ]) {
    assert.match(m.text, /retrouve votre famille toute seule/);
    assert.doesNotMatch(m.text, /scannez/i);
  }
  assert.doesNotMatch(mail.colisParti({ nom: 'Paul', suivi: '123', lien: 'https://x', code: 'WXYZ-2345' }).text, /scannez/i);
});

// M0 (Tanguy 12/11) : une tablette qui a internet mais ne trouve pas sa famille prévient Papote tout de suite.
test('tablette connectée sans famille : Papote prévenu sauf si elle entre, ou si elle est encore chez lui', () => {
  const { alerteSansFamille } = regles;
  const p = { serie: 'R9XN', tabletUid: 'tab1' };
  const envoyee = { nom: 'Paul Martin', expedition: 'envoyee', fid: 'F1' };
  assert.strictEqual(alerteSansFamille({ decision: { etat: 'jumeler', fid: 'F1' }, p }), null);
  assert.strictEqual(alerteSansFamille({ decision: { etat: 'pas-envoyee' }, p }), null, 'allumée pendant la préparation');
  assert.strictEqual(alerteSansFamille({ decision: { etat: 'sans-commande' }, p, fiche: { etat: 'preparee', commande: null } }), null);
  assert.strictEqual(alerteSansFamille({ decision: { etat: 'pas-preparee' }, p, fiche: { commande: 'sub_1' }, commande: { expedition: 'a-preparer' } }), null);
  const inconnue = alerteSansFamille({ decision: { etat: 'inconnue' }, p });
  assert.strictEqual(inconnue.cle, 'R9XN_sans-commande');
  assert.strictEqual(inconnue.titre, 'Tablette connectée mais sans famille : n° de série R9XN');
  assert.match(inconnue.detail, /aucune tablette du stock n'a le n° de série R9XN.*Papote est prévenu/);
  assert.match(alerteSansFamille({ decision: { etat: 'inconnue' }, p, serieConnue: true }).detail, /pas prouvé/);
  const sansCommande = alerteSansFamille({ decision: { etat: 'sans-commande' }, p, fiche: { ref: 'T-007', etat: 'envoyee', commande: null } });
  assert.match(sansCommande.titre, /T-007$/);
  assert.match(sansCommande.detail, /n° de série R9XN.*aucune commande.*Reliez sa fiche/);
  const ancienne = alerteSansFamille({ decision: { etat: 'pas-preparee' }, p, fiche: { ref: 'T-008', commande: 'sub_1' }, commande: envoyee });
  assert.strictEqual(ancienne.cle, 'R9XN_sub_1');
  assert.match(ancienne.titre, /T-008 \(commande de Paul Martin\)/);
  assert.match(alerteSansFamille({ decision: { etat: 'bloquee' }, p, fiche: { ref: 'T-9', etat: 'perdue' } }).detail, /« perdue »/);
  assert.match(alerteSansFamille({ decision: { etat: 'autre-famille' }, p, fiche: { ref: 'T-9', commande: 'sub_2' }, commande: envoyee }).detail, /autre famille/);
  // Ni n° de série ni compte : rien pour reconnaître la tablette, pas d'alerte.
  assert.strictEqual(alerteSansFamille({ decision: { etat: 'inconnue' }, p: {} }), null);
});
