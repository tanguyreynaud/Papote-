// Un téléphone ne sonne que pour le dernier compte connecté dessus (bug Tanguy 2026-11 : son téléphone sonnait
// pour deux profils). Deux comptes sur un même téléphone ont le même jeton push : le serveur (jetonUnique) le
// retire du compte précédent. Un même compte dans deux familles le garde dans les deux.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher } = require('./commun');

brancher();

const fiche = (fid, uid) => s.db.doc(`families/${fid}/members/${uid}/private/push`);
const jetons = async (fid, uid) => {
  const d = (await fiche(fid, uid).get()).data() || {};
  return { tokens: d.tokens || [], natifs: d.natifs || [] };
};
const recoit = async (fid, uid) => (await s.db.doc(`families/${fid}/members/${uid}`).get()).get('recoitAppels');

test('deux comptes sur le même téléphone : seul le dernier inscrit garde le jeton (app Android puis navigateur)', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  await a.afficherCode(t);
  const fid = await a.installer(julie, t);
  await a.rejoindre(paul, fid);
  await s.calme();

  // Julie connectée sur le téléphone (app Android) ; elle a aussi un navigateur sur son ordinateur.
  await fiche(fid, julie.uid).set({ natifs: ['jeton-android-tel'], tokens: ['jeton-web-ordi'] });
  await s.calme();
  // Paul se connecte sur ce même téléphone, sans que Julie se soit déconnectée.
  await fiche(fid, paul.uid).set({ natifs: ['jeton-android-tel'] }, { merge: true });
  await s.calme();
  assert.deepStrictEqual(await jetons(fid, julie.uid), { natifs: [], tokens: ['jeton-web-ordi'] }, 'Julie ne garde que son ordinateur');
  assert.deepStrictEqual(await jetons(fid, paul.uid), { natifs: ['jeton-android-tel'], tokens: [] });
  assert.strictEqual(await recoit(fid, julie.uid), true, 'son ordinateur sonne encore');

  // Puis Paul ouvre l'app famille dans le navigateur de l'ordinateur de Julie.
  await fiche(fid, paul.uid).set({ tokens: s.FieldValue.arrayUnion('jeton-web-ordi') }, { merge: true });
  await s.calme();
  assert.deepStrictEqual(await jetons(fid, julie.uid), { natifs: [], tokens: [] });
  assert.deepStrictEqual(await jetons(fid, paul.uid), { natifs: ['jeton-android-tel'], tokens: ['jeton-web-ordi'] });
  assert.strictEqual(await recoit(fid, julie.uid), false, 'plus aucun téléphone pour Julie');
  assert.strictEqual(await recoit(fid, paul.uid), true);

  // Julie revient sur le téléphone : c'est à nouveau elle seule.
  await fiche(fid, julie.uid).set({ natifs: ['jeton-android-tel'] }, { merge: true });
  await s.calme();
  assert.deepStrictEqual((await jetons(fid, paul.uid)).natifs, []);
  assert.deepStrictEqual((await jetons(fid, julie.uid)).natifs, ['jeton-android-tel']);
});

test('même compte dans deux familles : il garde le jeton dans les deux, l\'autre compte le perd partout', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t1 = await a.tablettePreparee();
  await a.afficherCode(t1);
  const fidA = await a.installer(julie, t1, { nom: 'Mamie Emma' });
  const t2 = await a.tablettePreparee();
  await a.afficherCode(t2);
  const fidB = await a.installer(paul, t2, { nom: 'Papi Jean' });
  await a.rejoindre(julie, fidB);
  await a.rejoindre(paul, fidA);
  await s.calme();

  // Paul avait ce téléphone (navigateur), dans ses deux familles.
  await fiche(fidA, paul.uid).set({ tokens: ['jeton-web-tel'] });
  await fiche(fidB, paul.uid).set({ tokens: ['jeton-web-tel'] });
  await s.calme();
  assert.deepStrictEqual((await jetons(fidA, paul.uid)).tokens, ['jeton-web-tel'], 'même compte : gardé');
  assert.deepStrictEqual((await jetons(fidB, paul.uid)).tokens, ['jeton-web-tel'], 'même compte : gardé');

  // Julie s'y connecte et l'inscrit dans ses deux familles.
  await fiche(fidA, julie.uid).set({ tokens: ['jeton-web-tel'] });
  await s.calme();
  assert.deepStrictEqual((await jetons(fidA, paul.uid)).tokens, [], 'retiré de Paul, famille A');
  assert.deepStrictEqual((await jetons(fidB, paul.uid)).tokens, [], 'retiré de Paul, famille B aussi');
  await fiche(fidB, julie.uid).set({ tokens: ['jeton-web-tel'] });
  await s.calme();
  assert.deepStrictEqual((await jetons(fidA, julie.uid)).tokens, ['jeton-web-tel'], 'Julie le garde dans A');
  assert.deepStrictEqual((await jetons(fidB, julie.uid)).tokens, ['jeton-web-tel'], 'et dans B');
});
