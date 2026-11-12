// Alerte « sauvegarde du dimanche de plus de 8 jours » (sauvegarde-alerte.js) : règles pures et tâche du jour sur
// une base simulée. Le parcours sur l'émulateur est dans parcours/sauvegarde.parcours.js.
const test = require('node:test');
const assert = require('node:assert');
const { Timestamp } = require('firebase-admin/firestore');
const { alerteSauvegarde, ligneAFaire, etat } = require('./sauvegarde-alerte');

const JOUR = 864e5;
const T0 = Date.parse('2026-11-08T03:00:00Z'); // un dimanche

function fausseBase(initial) {
  const docs = new Map(initial ? [['interne/sauvegarde', { ...initial }]] : []);
  const ref = (chemin) => ({ chemin });
  return {
    docs,
    doc: ref,
    async runTransaction(f) {
      return f({
        get: async (r) => ({ exists: docs.has(r.chemin), data: () => ({ ...docs.get(r.chemin) }) }),
        set: (r, v) => docs.set(r.chemin, { ...v }),
        update: (r, v) => docs.set(r.chemin, { ...docs.get(r.chemin), ...v }),
      });
    },
  };
}

test('etat et ligne « À faire » : rien jusqu\'à 8 jours, puis la date de la dernière réussie', () => {
  const s = { derniereReussie: Timestamp.fromMillis(T0) };
  assert.strictEqual(etat(s, T0 + 8 * JOUR).enRetard, false, '8 jours pile : pas encore');
  assert.strictEqual(ligneAFaire(s, T0 + 7 * JOUR), null);
  assert.strictEqual(etat(s, T0 + 8 * JOUR + 60e3).enRetard, true);
  assert.match(ligneAFaire(s, T0 + 9 * JOUR + 3600e3), /dernière réussie date du 8 novembre \(9 jours\)/);
  assert.strictEqual(ligneAFaire(null, T0), null, 'pas de relevé : pas de ligne (la tâche du jour note le départ)');
  assert.match(ligneAFaire({ premierControle: Timestamp.fromMillis(T0) }, T0 + 10 * JOUR), /Aucune sauvegarde du dimanche réussie depuis 10 jours/);
});

test('alerteSauvegarde : un seul e-mail par retard, pas un par jour ; une nouvelle réussite remet à zéro', async () => {
  const envoyes = [];
  const prevenir = async (titre, detail) => envoyes.push({ titre, detail });
  const db = fausseBase({ derniereReussie: Timestamp.fromMillis(T0), erreur: null });

  for (let j = 1; j <= 8; j++) assert.strictEqual(await alerteSauvegarde({ db, prevenir, maintenant: T0 + j * JOUR }), null, `jour ${j}`);
  assert.strictEqual(envoyes.length, 0);
  // Jour 9 : l'e-mail part, puis plus rien les jours suivants.
  assert.strictEqual(await alerteSauvegarde({ db, prevenir, maintenant: T0 + 9 * JOUR }), 'alerte');
  for (let j = 10; j <= 20; j++) assert.strictEqual(await alerteSauvegarde({ db, prevenir, maintenant: T0 + j * JOUR }), null);
  assert.strictEqual(envoyes.length, 1);
  assert.match(envoyes[0].titre, /aucune réussie depuis 9 jours/);
  assert.match(envoyes[0].detail, /date du 8 novembre/);

  // Le PC note un échec : il est cité dans l'e-mail suivant. Une réussite le 22, puis plus rien jusqu'au 30 ; le 31,
  // un nouvel e-mail (nouvelle sauvegarde vieillie).
  const reussie = T0 + 22 * JOUR;
  db.docs.set('interne/sauvegarde', { ...db.docs.get('interne/sauvegarde'), derniereReussie: Timestamp.fromMillis(reussie) });
  assert.strictEqual(await alerteSauvegarde({ db, prevenir, maintenant: reussie + 8 * JOUR }), null);
  db.docs.set('interne/sauvegarde', { ...db.docs.get('interne/sauvegarde'), dernierEchec: Timestamp.fromMillis(reussie + 7 * JOUR), erreur: 'quota du disque dépassé' });
  assert.strictEqual(await alerteSauvegarde({ db, prevenir, maintenant: reussie + 9 * JOUR }), 'alerte');
  assert.strictEqual(await alerteSauvegarde({ db, prevenir, maintenant: reussie + 10 * JOUR }), null);
  assert.strictEqual(envoyes.length, 2);
  assert.match(envoyes[1].detail, /Dernier essai raté le .* : quota du disque dépassé/);
});

test('alerteSauvegarde : sans relevé, le premier contrôle sert de départ (pas d\'e-mail le jour de la mise en ligne)', async () => {
  const envoyes = [];
  const db = fausseBase(null);
  assert.strictEqual(await alerteSauvegarde({ db, prevenir: async (t) => envoyes.push(t), maintenant: T0 }), 'debut');
  assert.strictEqual(db.docs.get('interne/sauvegarde').premierControle.toMillis(), T0);
  assert.strictEqual(await alerteSauvegarde({ db, prevenir: async (t) => envoyes.push(t), maintenant: T0 + 5 * JOUR }), null);
  assert.strictEqual(await alerteSauvegarde({ db, prevenir: async (t) => envoyes.push(t), maintenant: T0 + 9 * JOUR }), 'alerte');
  assert.strictEqual(await alerteSauvegarde({ db, prevenir: async (t) => envoyes.push(t), maintenant: T0 + 10 * JOUR }), null);
  assert.deepStrictEqual(envoyes, ['Sauvegarde : aucune réussie depuis la mise en route (9 jours)']);
});

test('gestion.aFaire : la ligne de sauvegarde apparaît dans le récap du lundi', () => {
  const { aFaire } = require('./gestion').regles;
  const base = { commandes: [], stock: [], depenses: [], automatique: null, maintenant: T0 + 12 * JOUR };
  assert.deepStrictEqual(aFaire(base), []);
  const liste = aFaire({ ...base, sauvegarde: { derniereReussie: Timestamp.fromMillis(T0) } });
  assert.strictEqual(liste.length, 1);
  assert.match(liste[0], /^Sauvegarde du dimanche en retard/);
});
