// Alerte de fin de forfait SIM (forfait-alerte.js) : seuils 80 et 95 %, une fois par forfait, message selon ce que fait
// l'opérateur au bout (débit réduit ou internet coupé), et « sans doute coupée » plutôt que « hors ligne ».
const test = require('node:test');
const assert = require('node:assert');
const f = require('./forfait-alerte');
const mail = require('./mail');
const { message } = require('./alertes');

// Jeudi 19 novembre 2026, 15 h à Paris.
const JOUR = Date.parse('2026-11-19T14:00:00Z');
const NUIT = Date.parse('2026-11-19T22:30:00Z'); // 23 h 30 à Paris
const tablette = (mo, extra = {}) => ({
  lastOnline: new Date(JOUR - 5 * 60_000),
  sim: { dataCycleMo: mo, plafondMo: 1000, niveau: 0, cycleDebut: '2026-11-05' },
  ...extra,
});
const REDUIT = { mo: 1000, debut: '2026-11-05', finForfait: 'reduit' };
const BLOQUE = { mo: 1000, jour: 5, finForfait: 'bloque' };

test('fin du forfait : 30 jours après un pass, le même jour le mois suivant sinon', () => {
  assert.strictEqual(f.finDuCycle('2026-11-05', { debut: '2026-10-06' }), '2026-12-05');
  assert.strictEqual(f.finDuCycle('2026-12-20', { debut: '2026-12-20' }), '2027-01-19');
  assert.strictEqual(f.finDuCycle('2026-11-05', { jour: 5 }), '2026-12-05');
  assert.strictEqual(f.finDuCycle('2026-12-28', { jour: 28 }), '2027-01-28');
  assert.strictEqual(f.finDuCycle('2026-11-05', null), '2026-12-05', 'sans réglage : la tablette repart le même jour du mois');
  assert.strictEqual(f.finDuCycle('', REDUIT), null);
  assert.strictEqual(f.jourTexte('2026-12-05'), '5 décembre');
});

test('état du forfait : rien sans SIM, sans limite, ou une fois le forfait reparti ; « reduit » par défaut', () => {
  assert.strictEqual(f.etatForfait({}, REDUIT, JOUR), null);
  assert.strictEqual(f.etatForfait(tablette(500, { sim: { dataCycleMo: 500, plafondMo: 0, cycleDebut: '2026-11-05' } }), REDUIT, JOUR), null);
  assert.strictEqual(f.etatForfait(tablette(-1), REDUIT, JOUR), null, 'conso inconnue');
  assert.strictEqual(f.etatForfait(tablette(990), REDUIT, Date.parse('2026-12-05T10:00:00Z')), null, 'forfait reparti');
  const e = f.etatForfait(tablette(812), { mo: 1000, jour: 5 }, JOUR);
  assert.deepStrictEqual({ ...e }, { pourCent: 81, conso: 812, plafond: 1000, cycle: '2026-11-05', fin: '2026-12-05', type: 'reduit', silencieuse: false });
  assert.strictEqual(f.etatForfait(tablette(812), BLOQUE, JOUR).type, 'bloque');
  assert.strictEqual(f.etatForfait(tablette(812, { lastOnline: new Date(JOUR - 3 * 3600_000) }), BLOQUE, JOUR).silencieuse, true);
});

test('80 % : Papote seulement ; 95 % : Papote et la famille (en journée) ; une seule fois par forfait', () => {
  const etat = (mo, t = JOUR, x = {}) => f.etatForfait(tablette(mo, x), REDUIT, t);
  assert.strictEqual(f.decider(etat(790), undefined, JOUR).note, null);
  const a = f.decider(etat(800), undefined, JOUR);
  assert.deepStrictEqual([a.admin, a.famille, a.coupee], [80, false, false]);
  assert.deepStrictEqual(a.note, { cycle: '2026-11-05', admin: [80] });
  assert.strictEqual(f.decider(etat(870), a.note, JOUR).note, null, 'déjà prévenu pour 80 %');
  const b = f.decider(etat(960), a.note, JOUR);
  assert.deepStrictEqual([b.admin, b.famille, b.coupee], [95, true, false]);
  assert.deepStrictEqual(b.note, { cycle: '2026-11-05', admin: [80, 95], famille: true });
  assert.strictEqual(f.decider(etat(999), b.note, JOUR).note, null, 'rien de plus jusqu\'au forfait suivant');
  // Forfait suivant : tout recommence.
  const suivant = f.etatForfait({ ...tablette(820), sim: { dataCycleMo: 820, plafondMo: 1000, cycleDebut: '2026-12-05' } }, REDUIT, Date.parse('2026-12-20T10:00:00Z'));
  assert.strictEqual(f.decider(suivant, b.note, Date.parse('2026-12-20T10:00:00Z')).admin, 80);
});

test('deux seuils passés d\'un coup : un seul e-mail à Papote ; la nuit, la famille attend le matin', () => {
  const etat = f.etatForfait(tablette(970), REDUIT, NUIT);
  const nuit = f.decider(etat, undefined, NUIT);
  assert.deepStrictEqual([nuit.admin, nuit.famille], [95, false]);
  assert.deepStrictEqual(nuit.note, { cycle: '2026-11-05', admin: [80, 95] });
  const matin = Date.parse('2026-11-20T07:05:00Z'); // 8 h 05
  const m = f.decider(f.etatForfait(tablette(975, { lastOnline: new Date(matin) }), REDUIT, matin), nuit.note, matin);
  assert.deepStrictEqual([m.admin, m.famille], [null, true]);
});

test('forfait « internet coupé » passé 95 % puis silencieux : Papote sait que c\'est le forfait, une fois', () => {
  const vue = new Date(JOUR - 3 * 3600_000);
  const avant = { cycle: '2026-11-05', admin: [80, 95], famille: true };
  const d = f.decider(f.etatForfait(tablette(980, { lastOnline: vue }), BLOQUE, JOUR), avant, JOUR);
  assert.deepStrictEqual([d.admin, d.famille, d.coupee], [null, false, true]);
  assert.strictEqual(f.decider(f.etatForfait(tablette(980, { lastOnline: vue }), BLOQUE, JOUR), d.note, JOUR).note, null);
  // Débit réduit : une tablette silencieuse n'est pas « coupée » par le forfait.
  assert.strictEqual(f.decider(f.etatForfait(tablette(980, { lastOnline: vue }), REDUIT, JOUR), avant, JOUR).note, null);
  // Silencieuse sous 95 % : rien ici (l'alerte « ne répond plus » s'en charge).
  assert.strictEqual(f.decider(f.etatForfait(tablette(900, { lastOnline: vue }), BLOQUE, JOUR), { cycle: '2026-11-05', admin: [80] }, JOUR).note, null);
  const t = f.emailAdmin(f.etatForfait(tablette(980, { lastOnline: vue }), BLOQUE, JOUR), { nom: 'Mamie Jeanne', famille: 'f1', coupee: true });
  assert.strictEqual(t.subject, 'Tablette de Mamie Jeanne : internet sans doute coupé par le forfait');
  assert.match(t.text, /sans doute l'opérateur qui a coupé internet au bout du forfait, pas une panne\. Internet revient le 5 décembre/);
  assert.doesNotMatch(t.subject + t.text, /hors ligne/i);
});

test('e-mails à Papote : seuil, conso, ce qui arrive au bout du forfait', () => {
  const e80 = f.emailAdmin(f.etatForfait(tablette(812), REDUIT, JOUR), { nom: 'Mamie Jeanne', famille: 'f1', seuil: 80 });
  assert.strictEqual(e80.subject, 'Forfait SIM à 80 % : tablette de Mamie Jeanne');
  assert.match(e80.text, /812 Mo utilisés sur 1 Go depuis le 5 novembre\. Forfait « débit réduit » au bout : les appels vidéo seront plus lents jusqu'au 5 décembre\./);
  assert.doesNotMatch(e80.text, /famille est prévenue/);
  const e95 = f.emailAdmin(f.etatForfait(tablette(960), BLOQUE, JOUR), { nom: 'Mamie Jeanne', famille: 'f1', seuil: 95 });
  assert.match(e95.text, /Forfait « internet coupé » au bout : sans recharge, la tablette n'aura plus internet jusqu'au 5 décembre \(sauf en wifi\)\. La famille est prévenue par e-mail/);
});

test('e-mail à la famille : calme, adapté au forfait, avec la date', () => {
  const fin = Date.parse('2026-12-05T12:00:00Z');
  const r = mail.forfaitPresqueEpuise({ nom: 'Mamie', type: 'reduit', fin });
  assert.strictEqual(r.subject, 'La tablette de Mamie a presque utilisé son forfait internet du mois');
  assert.match(r.text, /La tablette de Mamie a presque utilisé son forfait internet du mois : jusqu'au 5 décembre les appels vidéo seront plus lents ; branchez-la au wifi si vous pouvez\./);
  const b = mail.forfaitPresqueEpuise({ nom: 'Mamie', type: 'bloque', fin });
  assert.match(b.text, /La tablette de Mamie a presque utilisé son forfait internet du mois : internet sera coupé jusqu'au 5 décembre ; branchez-la au wifi si vous pouvez\./);
  for (const m of [r, b]) {
    assert.doesNotMatch(m.text, /urgent|attention|!|alerte/i);
    assert.doesNotMatch(m.html, /#f97316|#ea580c|#fb923c|orange|#dc2626/i, 'ni orange ni rouge');
  }
});

test('« ne répond plus » adouci quand le forfait « internet coupé » est sans doute épuisé', () => {
  const silence = new Date(JOUR - 90 * 60_000);
  assert.strictEqual(f.coupeeParForfait(tablette(970, { lastOnline: silence }), BLOQUE, JOUR), '2026-12-05');
  assert.strictEqual(f.coupeeParForfait(tablette(970, { lastOnline: silence }), REDUIT, JOUR), null);
  assert.strictEqual(f.coupeeParForfait(tablette(900, { lastOnline: silence }), BLOQUE, JOUR), null);
  assert.deepStrictEqual(message('silence', 'Mamie', '2026-12-05'), {
    titre: 'La tablette de Mamie n\'a sans doute plus internet',
    texte: 'Son forfait du mois est épuisé, internet revient le 5 décembre. Branchez-la au wifi si vous pouvez.',
  });
  assert.strictEqual(message('silence', 'Mamie', null).titre, 'La tablette de Mamie ne répond plus');
  assert.strictEqual(message('debranchee', 'Mamie', '2026-12-05').titre, 'La tablette de Mamie est débranchée');
});
