// Entrer dans sa famille avec son numéro de commande (entrer-par-commande.js, A40) : règles pures.
const test = require('node:test');
const assert = require('node:assert');
const { regles } = require('./entrer-par-commande');
const { jourDeParis, essaiSuivant, refusCommande, placeDuPayeur, ESSAIS_PAR_JOUR } = regles;

test('essais : 5 par compte et par jour de Paris, le compteur repart le lendemain', () => {
  const midi = Date.parse('2026-11-12T11:00:00Z');
  let c = null;
  for (let i = 1; i <= ESSAIS_PAR_JOUR; i++) {
    const r = essaiSuivant(c, midi);
    assert.strictEqual(r.ok, true, `essai ${i}`);
    assert.deepStrictEqual(r.compteur, { jour: '2026-11-12', essais: i });
    c = r.compteur;
  }
  assert.strictEqual(essaiSuivant(c, midi).ok, false, '6e essai du jour refusé');
  // 23 h 30 à Paris (22 h 30 UTC) : toujours le 12 ; minuit et quart à Paris : le 13, on recommence.
  assert.strictEqual(essaiSuivant(c, Date.parse('2026-11-12T22:30:00Z')).ok, false);
  const demain = essaiSuivant(c, Date.parse('2026-11-12T23:15:00Z'));
  assert.deepStrictEqual(demain, { ok: true, compteur: { jour: '2026-11-13', essais: 1 } });
  assert.strictEqual(jourDeParis(Date.parse('2026-07-01T22:30:00Z')), '2026-07-02', 'heure d\'été');
});

test('commande : payée avec sa famille préparée seulement', () => {
  assert.strictEqual(refusCommande(null), 'inconnue');
  assert.strictEqual(refusCommande({ fid: 'F1', famillePreparee: true, expedition: 'a-preparer' }), null);
  assert.strictEqual(refusCommande({ fid: 'F1', famillePreparee: true, expedition: 'envoyee' }), null);
  assert.strictEqual(refusCommande({ fid: 'F1', expedition: 'envoyee' }), 'sans-famille', 'commande d\'avant la famille préparée');
  assert.strictEqual(refusCommande({ fid: null, famillePreparee: true }), 'sans-famille');
  assert.strictEqual(refusCommande({ fid: 'F1', famillePreparee: true, expedition: 'annulee' }), 'annulee');
  assert.strictEqual(refusCommande({ fid: 'F1', famillePreparee: true, expedition: 'paiement-en-attente' }), 'pas-payee');
});

test('celui qui a commandé est toujours responsable : propriétaire si personne, sinon responsable (10 au plus)', () => {
  assert.strictEqual(placeDuPayeur({ createdBy: null }, 'paul'), 'proprietaire');
  assert.strictEqual(placeDuPayeur({}, 'paul'), 'proprietaire');
  assert.strictEqual(placeDuPayeur({ createdBy: 'julie' }, 'paul'), 'admin');
  assert.strictEqual(placeDuPayeur({ createdBy: 'julie', admins: ['a'] }, 'paul'), 'admin');
  assert.strictEqual(placeDuPayeur({ createdBy: 'paul' }, 'paul'), 'deja');
  assert.strictEqual(placeDuPayeur({ createdBy: 'julie', admins: ['paul'] }, 'paul'), 'deja');
  assert.strictEqual(placeDuPayeur({ createdBy: 'julie', admins: Array.from({ length: 10 }, (_, i) => `r${i}`) }, 'paul'), 'complet');
});
