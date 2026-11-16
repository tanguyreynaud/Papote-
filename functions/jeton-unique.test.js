const test = require('node:test');
const assert = require('node:assert');
const { jetonsAjoutes, fichesARetirer, retirerAilleurs } = require('./jeton-unique');

test('jetonsAjoutes : seulement les nouveaux, navigateur et app Android', () => {
  assert.deepStrictEqual(jetonsAjoutes(null, { tokens: ['a'], natifs: ['n'] }), [
    { champ: 'tokens', jeton: 'a' }, { champ: 'natifs', jeton: 'n' },
  ]);
  assert.deepStrictEqual(jetonsAjoutes({ tokens: ['a'] }, { tokens: ['a', 'b'], natifs: [] }), [{ champ: 'tokens', jeton: 'b' }]);
  // Retrait (déconnexion, ménage d'un autre compte) : rien d'ajouté, donc pas de boucle.
  assert.deepStrictEqual(jetonsAjoutes({ tokens: ['a', 'b'], natifs: ['n'] }, { tokens: ['a'], natifs: [] }), []);
  assert.deepStrictEqual(jetonsAjoutes({ tokens: ['a'] }, null), []);
  // majLe, pingDemande, jetons de tablette : pas des jetons de téléphone.
  assert.deepStrictEqual(jetonsAjoutes({ tokens: ['a'] }, { tokens: ['a'], tablette: ['t'], majLe: 1 }), []);
  // Valeurs bizarres ignorées, doublons comptés une fois.
  assert.deepStrictEqual(jetonsAjoutes(null, { tokens: ['x', 'x', '', 3, null], natifs: 'pas une liste' }), [{ champ: 'tokens', jeton: 'x' }]);
  // Le même jeton passé de « tokens » à « natifs » est un ajout dans « natifs ».
  assert.deepStrictEqual(jetonsAjoutes({ tokens: ['j'] }, { natifs: ['j'] }), [{ champ: 'natifs', jeton: 'j' }]);
});

test('fichesARetirer : les autres comptes, toutes familles ; le même compte garde ses familles', () => {
  const trouvees = [
    'families/f1/members/moi/private/push',
    'families/f2/members/moi/private/push',
    'families/f1/members/autre/private/push',
    'families/f3/members/autre2/private/push',
    'families/f3/members/autre2/private/push',
    'families/f3/members/autre2/private/autre-chose',
    'ailleurs/x/private/push',
  ];
  assert.deepStrictEqual(fichesARetirer('moi', trouvees), [
    'families/f1/members/autre/private/push',
    'families/f3/members/autre2/private/push',
  ]);
  assert.deepStrictEqual(fichesARetirer('moi', ['families/f1/members/moi/private/push']), []);
});

// Base factice : collectionGroup('private').where(champ, 'array-contains', jeton) et doc(chemin).update.
function fausseBase(fiches) {
  const requetes = [];
  return {
    fiches,
    requetes,
    collectionGroup: (nom) => ({
      where: (champ, op, jeton) => ({
        get: async () => {
          assert.strictEqual(nom, 'private');
          assert.strictEqual(op, 'array-contains');
          requetes.push([champ, jeton]);
          const docs = Object.entries(fiches).filter(([, d]) => (d[champ] || []).includes(jeton)).map(([path]) => ({ ref: { path } }));
          return { docs };
        },
      }),
    }),
    doc: (chemin) => ({
      update: async (maj) => {
        if (!fiches[chemin]) throw Object.assign(new Error('absent'), { code: 5 });
        for (const [champ, v] of Object.entries(maj)) {
          // FieldValue.arrayRemove : on retrouve la valeur retirée dans son contenu.
          const retires = v._elements || v.elements || [];
          fiches[chemin][champ] = (fiches[chemin][champ] || []).filter((t) => !retires.includes(t));
        }
      },
    }),
  };
}

test('retirerAilleurs : le dernier compte inscrit garde le jeton, les autres le perdent', async () => {
  const db = fausseBase({
    'families/f1/members/julie/private/push': { natifs: ['N'], tokens: ['W', 'W2'] },
    'families/f1/members/paul/private/push': { natifs: ['N'], tokens: ['W'] },
    'families/f2/members/paul/private/push': { natifs: ['N'] },
    'families/f2/members/marc/private/push': { tokens: ['W'] },
  });
  const n = await retirerAilleurs(db, { uid: 'paul', avant: { tokens: [] }, apres: { natifs: ['N'], tokens: ['W'] } });
  assert.strictEqual(n, 3);
  assert.deepStrictEqual(db.fiches['families/f1/members/julie/private/push'], { natifs: [], tokens: ['W2'] });
  assert.deepStrictEqual(db.fiches['families/f2/members/marc/private/push'], { tokens: [] });
  assert.deepStrictEqual(db.fiches['families/f1/members/paul/private/push'], { natifs: ['N'], tokens: ['W'] });
  assert.deepStrictEqual(db.fiches['families/f2/members/paul/private/push'], { natifs: ['N'] });
});

test('retirerAilleurs : rien d\'ajouté, aucune requête (retrait, majLe)', async () => {
  const db = fausseBase({});
  assert.strictEqual(await retirerAilleurs(db, { uid: 'paul', avant: { tokens: ['W'] }, apres: { tokens: [] } }), 0);
  assert.strictEqual(await retirerAilleurs(db, { uid: 'paul', avant: { tokens: ['W'] }, apres: { tokens: ['W'], majLe: 2 } }), 0);
  assert.deepStrictEqual(db.requetes, []);
});
