const test = require('node:test');
const assert = require('node:assert');
const { palierAtteint, aPrevenir, message, traiterAvis } = require('./budget');

test('paliers : rien sous 30 €, puis alerte, avertissement, coupure', () => {
  assert.strictEqual(palierAtteint(12.4), null);
  assert.strictEqual(palierAtteint(30), 'alerte');
  assert.strictEqual(palierAtteint(99.99), 'alerte');
  assert.strictEqual(palierAtteint(100), 'avertissement');
  assert.strictEqual(palierAtteint(151), 'coupure');
});

test('chaque palier n’est prévenu qu’une fois par mois', () => {
  assert.strictEqual(aPrevenir('alerte', null), true);
  assert.strictEqual(aPrevenir('alerte', 'alerte'), false);
  assert.strictEqual(aPrevenir('avertissement', 'alerte'), true);
  assert.strictEqual(aPrevenir('alerte', 'avertissement'), false);
  assert.strictEqual(aPrevenir('coupure', 'alerte'), true);
  assert.strictEqual(aPrevenir(null, null), false);
});

test('l’avertissement à 100 € annonce la coupure à 150 €', () => {
  const m = message('avertissement', 104.5, 'EUR');
  assert.match(m.subject, /coupe-circuit bientôt/);
  assert.match(m.text, /coupera tout à 150 €/);
  assert.match(m.text, /104,50 €/);
});

test('coupure ratée : e-mail urgent pour couper à la main', () => {
  assert.match(message('coupure', 152, 'EUR', false).subject, /n'a pas pu couper/);
  assert.match(message('coupure', 152, 'EUR').subject, /COUPE-CIRCUIT/);
});

// ---------- traiterAvis : le palier n'est compté que si l'alerte est partie (audit des alertes, 11/11) ----------

// Fausse fiche interne/budget et faux services ; mailEnPanne / coupureEnPanne : nombre d'essais qui échouent.
function banc({ mailEnPanne = 0, coupureEnPanne = 0 } = {}) {
  const b = { etat: null, mails: [], coupures: 0, ordre: [], mailEnPanne, coupureEnPanne };
  const fiche = {
    set: async (v) => { b.etat = { ...v }; },
    delete: async () => { b.etat = null; },
  };
  const outils = {
    fiche,
    transaction: (f) => f({ get: async () => ({ data: () => (b.etat ? { ...b.etat } : undefined) }), set: (_, v) => { b.etat = { ...v }; } }),
    envoyer: async (contenu) => {
      if (b.mailEnPanne > 0) { b.mailEnPanne -= 1; throw new Error('Brevo refuse'); }
      b.mails.push(contenu.subject);
      b.ordre.push('mail');
    },
    couper: async () => {
      if (b.coupureEnPanne > 0) { b.coupureEnPanne -= 1; throw new Error('Cloud Billing 403'); }
      b.coupures += 1;
      b.ordre.push('coupure');
    },
    journal: { warn() {}, error() {} },
  };
  b.avis = (cout, mois = '2026-11') => traiterAvis({ costAmount: cout, costIntervalStart: `${mois}-01T00:00:00Z`, currencyCode: 'EUR' }, outils);
  return b;
}

test('30 € : un seul e-mail, même si Google renvoie l’avis dix fois', async () => {
  const b = banc();
  for (let i = 0; i < 10; i++) await b.avis(31 + i);
  assert.strictEqual(b.mails.length, 1);
  assert.match(b.mails[0], /atteint 31,00 €/);
  assert.strictEqual(b.coupures, 0);
});

test('e-mail des 30 € refusé : le palier est rendu, l’avis suivant le renvoie (avant : plus rien jusqu’à 100 €)', async () => {
  const b = banc({ mailEnPanne: 2 });
  await assert.rejects(b.avis(31), /Brevo refuse/);
  assert.strictEqual(b.etat, null, 'rien de noté');
  await assert.rejects(b.avis(33), /Brevo refuse/);
  await b.avis(35);
  assert.deepStrictEqual(b.mails.length, 1, 'l’alerte part dès que l’e-mail remarche');
  assert.strictEqual(b.etat.palier, 'alerte');
  await b.avis(36);
  assert.strictEqual(b.mails.length, 1, 'puis une seule fois');
});

test('e-mail des 100 € refusé : le palier des 30 € déjà prévenu est gardé, les 100 € repartent', async () => {
  const b = banc();
  await b.avis(40);
  b.mailEnPanne = 1;
  await assert.rejects(b.avis(101));
  assert.strictEqual(b.etat.palier, 'alerte');
  await b.avis(102);
  assert.strictEqual(b.mails.length, 2);
  assert.match(b.mails[1], /coupe-circuit bientôt/);
});

test('150 € : l’e-mail part AVANT la coupure, puis la confirmation ; une seule coupure', async () => {
  const b = banc();
  const r = await b.avis(151);
  assert.deepStrictEqual(b.ordre, ['mail', 'coupure', 'mail']);
  assert.match(b.mails[0], /coupure de la facturation en cours/);
  assert.match(b.mails[1], /facturation Google Cloud désactivée/);
  assert.deepStrictEqual(r, { fait: true, palier: 'coupure', coupee: true, prevenu: true });
  await b.avis(155);
  assert.strictEqual(b.coupures, 1);
  assert.strictEqual(b.mails.length, 2);
});

test('150 € et e-mail en panne : la facturation est coupée quand même', async () => {
  const b = banc({ mailEnPanne: 2 });
  const r = await b.avis(151);
  assert.strictEqual(b.coupures, 1);
  assert.deepStrictEqual(b.mails, []);
  assert.strictEqual(r.prevenu, false);
  assert.strictEqual(b.etat.palier, 'coupure', 'coupée : pas de nouvel essai');
});

test('150 € et coupure refusée : e-mail urgent, et chaque avis suivant réessaie de couper', async () => {
  const b = banc({ coupureEnPanne: 1 });
  const r = await b.avis(151);
  assert.strictEqual(r.coupee, false);
  assert.match(b.mails[1], /n'a pas pu couper/);
  assert.strictEqual(b.etat, null, 'palier rendu');
  await b.avis(152);
  assert.strictEqual(b.coupures, 1, 'coupée au 2e avis');
  assert.match(b.mails[3], /désactivée/);
  assert.strictEqual(b.etat.palier, 'coupure');
});

test('nouveau mois : les paliers repartent de zéro', async () => {
  const b = banc();
  await b.avis(31, '2026-11');
  await b.avis(31, '2026-12');
  assert.strictEqual(b.mails.length, 2);
});
