const test = require('node:test');
const assert = require('node:assert');
const p = require('./perte');

test('montant : le prix d\'un kit non rendu, 140 € ou 150 € avec l\'enceinte (CGV)', () => {
  assert.strictEqual(p.montant({}), 14000);
  assert.strictEqual(p.montant({ enceinteFournie: false }), 14000);
  assert.strictEqual(p.montant({ enceinteFournie: true }), 15000);
  assert.strictEqual(p.LIBELLE, 'Papote : tablette perdue ou volée');
});

test('clé d\'idempotence : par commande, tablette et essai (un nouvel essai après un refus en a une nouvelle)', () => {
  assert.strictEqual(p.cle('sub_1', 'T1'), 'perte-sub_1-T1-1');
  assert.strictEqual(p.cle('sub_1', 'T1', 2), 'perte-sub_1-T1-2');
});

test('paramètres de l\'appel admin', () => {
  assert.match(p.verifierParams({ action: 'x' }).erreur, /Action/);
  assert.match(p.verifierParams({ action: 'envoyer', commande: 'sub_1', ancienne: 'T1' }).erreur, /tablette qui part/);
  assert.match(p.verifierParams({ action: 'acheter', commande: 'a/b', ancienne: 'T1' }).erreur, /Commande/);
  assert.match(p.verifierParams({ action: 'acheter', commande: 'sub_1', ancienne: 'T1', sim: 3 }).erreur, /SIM/);
  assert.deepStrictEqual(p.verifierParams({ action: 'envoyer', commande: 'sub_1', ancienne: 'T1', nouveau: 'T2', sim: 'S1' }),
    { action: 'envoyer', commande: 'sub_1', ancienne: 'T1', nouveau: 'T2', sim: 'S1' });
});

test('la tablette à remplacer : coupée (perdue) et de cette commande', () => {
  assert.match(p.refusAncienne(null, 'sub_1'), /introuvable/);
  assert.match(p.refusAncienne({ etat: 'chez-client', commande: 'sub_1' }, 'sub_1'), /tout couper/);
  assert.match(p.refusAncienne({ etat: 'perdue', commande: 'sub_2' }, 'sub_1'), /pas celle/);
  assert.strictEqual(p.refusAncienne({ etat: 'perdue', commande: 'sub_1' }, 'sub_1'), '');
  assert.strictEqual(p.refusAncienne({ etat: 'perdue', commande: null, perdueDe: 'sub_1' }, 'sub_1'), '');
});

test('décision : jamais deux prélèvements, nouvel essai seulement après un refus', () => {
  const env = { action: 'envoyer', ancienne: 'T1', nouveau: 'T2' };
  const ach = { action: 'acheter', ancienne: 'T1' };
  assert.deepStrictEqual(p.decision(null, env), { nouveau: true, essai: 1 });
  // Double clic pendant le prélèvement : refusé.
  assert.strictEqual(p.decision({ tablette: 'T1', statut: 'prelevement', essai: 1, le: Date.now() }, env).code, 'already-exists');
  // Arrêt en plein prélèvement : au bout de 10 minutes, relance avec la même clé (Stripe ne prélève pas deux fois).
  assert.deepStrictEqual(p.decision({ tablette: 'T1', statut: 'prelevement', essai: 1, le: 0 }, env, 11 * 60 * 1000), { nouveau: true, essai: 1 });
  assert.strictEqual(p.decision({ tablette: 'T1', statut: 'prelevement', essai: 1, le: 0 }, env, 9 * 60 * 1000).code, 'already-exists');
  // Refus de la banque : nouvel essai, nouvelle clé.
  assert.deepStrictEqual(p.decision({ tablette: 'T1', statut: 'echec', essai: 1 }, env), { nouveau: true, essai: 2 });
  // Payée mais remplacement pas écrit : on termine sans reprélever.
  assert.deepStrictEqual(p.decision({ tablette: 'T1', statut: 'payee', essai: 1 }, env), { remplacer: true });
  assert.match(p.decision({ tablette: 'T1', statut: 'payee' }, ach).refus, /déjà payée/);
  // Remplacement en cours d'écriture : le second clic est refusé (relance permise après 10 minutes).
  assert.strictEqual(p.decision({ tablette: 'T1', statut: 'remplacement', remplacementLe: Date.now() }, env).code, 'already-exists');
  assert.deepStrictEqual(p.decision({ tablette: 'T1', statut: 'remplacement', remplacementLe: 0 }, env, 11 * 60 * 1000), { remplacer: true });
  // Déjà partie : rien de plus.
  assert.deepStrictEqual(p.decision({ tablette: 'T1', statut: 'envoyee' }, env), { deja: true });
  assert.deepStrictEqual(p.decision({ tablette: 'T1', statut: 'offerte' }, ach), { deja: true });
  // Achat : deux clics → une seule fiche ; l'envoi de la tablette achetée prélève (premier essai).
  assert.deepStrictEqual(p.decision(null, ach), { nouveau: true, essai: 1 });
  assert.deepStrictEqual(p.decision({ tablette: 'T1', statut: 'achat', essai: 1 }, ach), { deja: true });
  assert.deepStrictEqual(p.decision({ tablette: 'T1', statut: 'achat', essai: 1 }, env), { nouveau: true, essai: 2 });
  // Autre tablette perdue sur la même commande : seulement une fois la précédente finie, rangée dans pertesPassees.
  assert.match(p.decision({ tablette: 'T0', statut: 'achat' }, env).refus, /autre remplacement/);
  assert.deepStrictEqual(p.decision({ tablette: 'T0', statut: 'envoyee' }, env), { nouveau: true, essai: 1, archiver: true });
});

test('texte de l\'état pour l\'admin', () => {
  const euros = (c) => `${c / 100} €`;
  assert.match(p.texteStatut({ statut: 'echec', montant: 14000, erreur: 'Carte refusée' }, euros), /140 € refusé \(Carte refusée\) : rien n'est parti/);
  assert.match(p.texteStatut({ statut: 'envoyee', montant: 15000 }, euros), /150 € prélevés, tablette de remplacement partie/);
  assert.strictEqual(p.texteStatut(null, euros), '');
  assert.deepStrictEqual(p.resume({ statut: 'achat', montant: 14000, remplacante: 'T9', autre: 1 }), { statut: 'achat', montant: 14000, erreur: null, remplacante: 'T9' });
});
