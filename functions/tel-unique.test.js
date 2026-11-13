// Un numéro de portable par proche dans une même famille (tel-unique.js) : règles pures.
const test = require('node:test');
const assert = require('node:assert');
const { telNormalise, masquer, doublons, texte, membresDe } = require('./tel-unique');

test('telNormalise : espaces, +33, 0033 ; rien d\'autre qu\'un portable français', () => {
  assert.strictEqual(telNormalise('06 12 34 56 78'), '0612345678');
  assert.strictEqual(telNormalise('+33 6 12 34 56 78'), '0612345678');
  assert.strictEqual(telNormalise('+33 06 12 34 56 78'), '0612345678');
  assert.strictEqual(telNormalise('0033712345678'), '0712345678');
  assert.strictEqual(telNormalise('01 23 45 67 89'), '');
  assert.strictEqual(telNormalise(''), '');
  assert.strictEqual(telNormalise(null), '');
});

test('masquer : début et fin seulement', () => {
  assert.strictEqual(masquer('+33 6 12 34 56 78'), '06 •• •• •• 78');
  assert.strictEqual(masquer('bof'), '');
});

test('doublons : même famille, numéros écrits autrement, tablette et autres familles à part', () => {
  const membres = [
    { fid: 'f1', uid: 'a', name: 'Paul', role: 'famille', telephone: '06 12 34 56 78' },
    { fid: 'f1', uid: 'b', name: 'Julie', role: 'famille', telephone: '+33612345678' },
    { fid: 'f1', uid: 't', name: 'Mamie', role: 'tablette', telephone: '06 12 34 56 78' },
    { fid: 'f1', uid: 'c', name: 'Léa', role: 'famille', telephone: '07 00 00 00 01' },
    { fid: 'f1', uid: 'd', name: 'Sans', role: 'famille' },
    { fid: 'f1', uid: 'e', name: 'Sans2', role: 'famille', telephone: null },
    { fid: 'f2', uid: 'x', name: 'Marc', role: 'famille', telephone: '07 00 00 00 01' },
  ];
  assert.deepStrictEqual(doublons(membres), [{ fid: 'f1', numero: '06 •• •• •• 78', prenoms: ['Julie', 'Paul'] }]);
});

test('doublons : rien quand chacun a le sien, liste vide ou absente', () => {
  assert.deepStrictEqual(doublons([
    { fid: 'f1', uid: 'a', name: 'Paul', role: 'famille', telephone: '0612345678' },
    { fid: 'f1', uid: 'b', name: 'Julie', role: 'famille', telephone: '0612345679' },
  ]), []);
  assert.deepStrictEqual(doublons([]), []);
  assert.deepStrictEqual(doublons(undefined), []);
});

test('doublons : trois proches, deux numéros en double, sans prénom', () => {
  const d = doublons([
    { fid: 'f1', name: 'Paul', telephone: '0612345678' },
    { fid: 'f1', name: 'Julie', telephone: '0612345678' },
    { fid: 'f1', name: '', telephone: '0612345678' },
    { fid: 'f1', name: 'Léa', telephone: '0700000001' },
    { fid: 'f1', name: 'Tom', telephone: '0700000001' },
  ]);
  assert.deepStrictEqual(d.map((x) => [x.numero, x.prenoms]), [
    ['06 •• •• •• 78', ['Julie', 'Paul', 'sans prénom']],
    ['07 •• •• •• 01', ['Léa', 'Tom']],
  ]);
});

test('texte : la ligne « À faire »', () => {
  assert.strictEqual(texte({ numero: '06 •• •• •• 78', prenoms: ['Julie', 'Paul'] }, 'Dupont'),
    'Numéro en double dans la famille Dupont : 06 •• •• •• 78 (Julie, Paul)');
  assert.strictEqual(texte({ numero: '06 •• •• •• 78', prenoms: ['Julie', 'Paul'] }, null),
    'Numéro en double dans la famille sans nom : 06 •• •• •• 78 (Julie, Paul)');
});

test('membresDe : seulement families/{fid}/members/{uid}', () => {
  // families/f1/members/a : document → collection members → document f1 → collection families.
  const ref = (chemin) => {
    const [c1, d1, c2] = chemin.split('/');
    return { parent: { id: c2, parent: { id: d1, parent: { id: c1, parent: null } } } };
  };
  const d = (chemin, data) => ({ id: chemin.split('/').pop(), ref: ref(chemin), get: (k) => data[k] });
  assert.deepStrictEqual(membresDe([
    d('families/f1/members/a', { name: 'Paul', role: 'famille', telephone: '0612345678' }),
    d('autre/x/members/b', { name: 'Julie', telephone: '0612345678' }),
  ]), [{ fid: 'f1', uid: 'a', name: 'Paul', role: 'famille', telephone: '0612345678' }]);
});
