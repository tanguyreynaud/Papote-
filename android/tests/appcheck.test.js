// Jeton App Check de la page des appels (appels.js) avec le VRAI firebase-app-check, celui de la tablette.
// Firebase renouvelle un jeton à « émission + moitié de sa durée + 5 min » ; si on lui rend alors le même
// jeton, il le redemande aussitôt, sans pause. L'app Android gardait le sien 55 min : de la 35e à la 55e minute
// de chaque heure, la page tournait en boucle (≈ 4 000 demandes par seconde, 1,4 cœur sur T-003, 19/11).
// Ici : jamais de boucle, quel que soit l'âge du jeton et que le renouvellement réussisse, rate ou ne réponde pas.
// Lancement : npm install --no-save firebase@12.19.0, puis node --test android/tests/appcheck.test.js
const test = require('node:test');
const assert = require('node:assert');
const { ouvrir, lot } = require('./banc');

const FAMILLE = {
  firebase: true,
  code: 'ABCD2345',
  base: { 'invites/ABCD2345': { fid: 'F1', kind: 'tablette' }, 'families/F1': { name: 'Mamie' } },
};

async function tablette(appCheck) {
  const b = await ouvrir('2026-10-26T10:00:00', { ...FAMILLE, appCheck });
  await b.android('onPosts', lot([]));
  return b;
}
// Bond dans le temps (chaque minuterie échue part une fois), puis un peu de temps normal pour la suite.
const sauter = async (b, ms) => { await b.page.clock.fastForward(ms); await b.patienter(1500); };
const compter = async (b, nom) => (await b.appels(nom)).length;
const erreurs = async (b) => (await b.appels('erreurJS')).map((a) => a.args.join(' '));

for (const age of [36, 45, 54]) {
  test(`jeton vieux de ${age} min, Android en trouve un neuf : une seule demande, pas de boucle`, async () => {
    const b = await tablette({ ageMin: age, renouvelle: true });
    try {
      await b.patienter(6000);
      assert.strictEqual(await compter(b, 'appCheckRenouveler'), 1, 'un seul renouvellement demandé à Android');
      const lectures = await compter(b, 'appCheckToken');
      assert.ok(lectures >= 2 && lectures <= 6, `le jeton est lu quelques fois, pas en boucle (${lectures} lectures en 6 s)`);
      // Le jeton neuf est gardé : plus rien pendant 30 min, puis un renouvellement à la 35e minute.
      await b.vider();
      await sauter(b, 30 * 60000);
      assert.strictEqual(await compter(b, 'appCheckRenouveler'), 0, 'rien pendant les 30 premières minutes du jeton neuf');
      await sauter(b, 6 * 60000);
      assert.strictEqual(await compter(b, 'appCheckRenouveler'), 1, 'renouvelé une fois à la 35e minute');
      assert.ok(await compter(b, 'appCheckToken') <= 6, 'toujours pas de boucle après le 2e renouvellement');
      assert.deepStrictEqual(await erreurs(b), []);
    } finally { await b.fermer(); }
  });
}

test('jeton vieux de 40 min, serveur injoignable : Firebase attend avant de redemander (pas de boucle)', async () => {
  const b = await tablette({ ageMin: 40, renouvelle: false });
  try {
    await b.patienter(6000);
    assert.strictEqual(await compter(b, 'appCheckRenouveler'), 1, 'une seule demande à Android dans les 6 premières secondes');
    assert.ok(await compter(b, 'appCheckToken') <= 6, 'pas de boucle');
    // En une heure : quelques essais de plus en plus espacés (30 s, 1 min, 2 min… 16 min au plus), jamais des milliers.
    for (let i = 0; i < 12; i++) await sauter(b, 5 * 60000);
    const demandes = await compter(b, 'appCheckRenouveler');
    assert.ok(demandes >= 3 && demandes <= 12, `quelques essais espacés en une heure (${demandes})`);
    assert.ok(await compter(b, 'appCheckToken') <= 40, 'pas de boucle en une heure');
    assert.deepStrictEqual(await erreurs(b), []);
  } finally { await b.fermer(); }
});

test('Android ne répond jamais : la page n\'attend pas pour toujours et ne boucle pas', async () => {
  const b = await tablette({ ageMin: 40, muet: true });
  try {
    await b.patienter(3000);
    assert.strictEqual(await compter(b, 'appCheckRenouveler'), 1);
    for (let i = 0; i < 10; i++) await sauter(b, 60000);
    const demandes = await compter(b, 'appCheckRenouveler');
    assert.ok(demandes >= 2 && demandes <= 8, `la demande est refaite après 45 s sans réponse, puis de plus en plus tard (${demandes} en 10 min)`);
    assert.ok(await compter(b, 'appCheckToken') <= 30, 'pas de boucle');
    assert.deepStrictEqual(await erreurs(b), []);
  } finally { await b.fermer(); }
});

test('jeton tout neuf : gardé tel quel, aucun renouvellement', async () => {
  const b = await tablette({ ageMin: 2, renouvelle: true });
  try {
    await b.patienter(5000);
    assert.strictEqual(await compter(b, 'appCheckRenouveler'), 0);
    assert.ok(await compter(b, 'appCheckToken') <= 3);
    assert.deepStrictEqual(await erreurs(b), []);
  } finally { await b.fermer(); }
});

test('pas encore de jeton au démarrage : demandé une fois à Android, puis gardé', async () => {
  const b = await tablette({ ageMin: null, renouvelle: true });
  try {
    await b.patienter(5000);
    assert.strictEqual(await compter(b, 'appCheckRenouveler'), 1);
    assert.ok(await compter(b, 'appCheckToken') <= 6);
    assert.deepStrictEqual(await erreurs(b), []);
  } finally { await b.fermer(); }
});

test('« frais » : le même calcul que Firebase (émission + moitié + 5 min, au plus tard fin − 5 min)', async () => {
  const b = await tablette({ ageMin: 2, renouvelle: true });
  try {
    await b.patienter(1000);
    const frais = (ageMin) => b.page.evaluate((a) => window.papoteAppCheckFrais(window.__jetonAppCheck(a)), ageMin);
    assert.strictEqual(await frais(0), true);
    assert.strictEqual(await frais(34), true);
    assert.strictEqual(await frais(36), false, 'à la 36e minute Firebase le redemanderait aussitôt');
    assert.strictEqual(await frais(54), false);
    assert.strictEqual(await frais(59), false);
    assert.strictEqual(await frais(61), false, 'expiré');
    // Jeton sans heure d'émission lisible : compté comme émis maintenant (comme Firebase).
    const sansIat = (resteMin) => b.page.evaluate((r) => window.papoteAppCheckFrais({ token: 'illisible', expireTimeMillis: Date.now() + r * 60000 }), resteMin);
    assert.strictEqual(await sansIat(20), true);
    assert.strictEqual(await sansIat(4), false);
    assert.strictEqual(await b.page.evaluate(() => window.papoteAppCheckFrais(null)), false);
  } finally { await b.fermer(); }
});
