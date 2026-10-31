// Sauvegarde puis restauration sur l'émulateur : tous les types de valeurs, les sous-collections à plusieurs niveaux,
// les comptes ; la base restaurée est identique à l'originale. Lancement (depuis functions, qui a firebase-admin) :
//   npx firebase-tools@14 emulators:exec --only firestore,auth --project demo-papote --config parcours/firebase.json
//     "node --test ../outils/admin/sauvegarde.test.js"
const test = require('node:test');
const assert = require('node:assert');
const admin = require('firebase-admin');
const { getFirestore, Timestamp, GeoPoint } = require('firebase-admin/firestore');
const lib = require('./sauvegarde-lib');

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('À lancer sur l\'émulateur (FIRESTORE_EMULATOR_HOST).');
const app = admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-papote' });
const db = getFirestore(app, 'europe');
const auth = admin.auth(app);

async function vider() {
  const projet = process.env.GCLOUD_PROJECT || 'demo-papote';
  for (const url of [
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projet}/databases/europe/documents`,
    process.env.FIREBASE_AUTH_EMULATOR_HOST && `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${projet}/accounts`,
  ].filter(Boolean)) {
    const r = await fetch(url, { method: 'DELETE' });
    assert.ok(r.ok, `vidage ${url} : ${r.status}`);
  }
}

test.after(async () => { await app.delete(); });

test('sauvegarde puis restauration : la base revient à l\'identique, types et sous-collections compris', async () => {
  await vider();
  const fam = db.doc('families/fam1');
  await fam.set({
    name: 'Mamie Emma', createdAt: Timestamp.fromMillis(1_761_800_000_123), rev: 3, nbProches: 2, options: { sos: true, radio: null },
    veille: { de: 21, a: 6.5 }, lieu: new GeoPoint(44.9369, 4.3683), createur: db.doc('families/fam1/members/julie'),
    photo: Buffer.from([1, 2, 3, 250]), tags: ['a', { b: Timestamp.fromMillis(5) }], '@type': 'piège', vide: '', faux: false,
  });
  await db.doc('families/fam1/members/julie').set({ name: 'Julie', role: 'famille', joinedAt: Timestamp.now() });
  await db.doc('families/fam1/members/julie/private/push').set({ jeton: 'abc', le: Timestamp.now() });
  await db.doc('families/fam1/posts/p1').set({ type: 'photo', hearts: 1, text: 'Bisous ❤️' });
  await db.doc('families/fam1/posts/p1/media/image').set({ data: Buffer.alloc(3000, 7) });
  await db.doc('config/base').set({ database: 'europe' });
  for (let i = 0; i < 1203; i++) await db.doc(`stock/t${String(i).padStart(4, '0')}`).set({ ref: `T-${i}`, etat: 'preparee' });
  await auth.createUser({ uid: 'julie', email: 'julie@exemple.fr', displayName: 'Julie', emailVerified: true });
  await auth.createUser({ uid: 'anonyme1' });
  await auth.setCustomUserClaims('julie', { admin: true });

  const avant = await lib.sauvegarder({ db, auth, projet: 'demo-papote', base: 'europe' });
  assert.strictEqual(avant.documents.length, 1203 + 6);
  assert.strictEqual(avant.comptes.length, 2);
  // Le fichier passe par JSON, comme sur le disque.
  const fichier = JSON.parse(JSON.stringify(avant));

  await vider();
  assert.strictEqual((await lib.toutLire(db)).length, 0, 'base vide avant restauration');
  await db.doc('families/intrus').set({ name: 'créée après la sauvegarde' });

  const r = await lib.restaurer({ db, auth, sauvegarde: fichier });
  assert.strictEqual(r.documents, 1209);
  assert.strictEqual(r.comptes, 2);
  assert.ok((await db.doc('families/intrus').get()).exists, 'sans --effacer, le reste est gardé');
  const apres = await lib.sauvegarder({ db, auth, projet: 'demo-papote', base: 'europe' });
  assert.deepStrictEqual(apres.documents.filter((d) => d.chemin !== 'families/intrus'), avant.documents);
  assert.deepStrictEqual(apres.comptes.map((c) => ({ ...c, creeLe: null })), avant.comptes.map((c) => ({ ...c, creeLe: null })));
  const doc = (await fam.get()).data();
  assert.ok(doc.createdAt instanceof Timestamp && doc.createdAt.toMillis() === 1_761_800_000_123);
  assert.ok(doc.lieu instanceof GeoPoint && doc.lieu.latitude === 44.9369);
  assert.strictEqual(doc.createur.path, 'families/fam1/members/julie');
  assert.deepStrictEqual([...doc.photo], [1, 2, 3, 250]);
  assert.strictEqual(doc['@type'], 'piège');
  assert.strictEqual((await auth.getUser('julie')).customClaims.admin, true);

  // --effacer : remise exacte.
  const r2 = await lib.restaurer({ db, sauvegarde: fichier, effacer: true });
  assert.strictEqual(r2.documents, 1209);
  assert.ok(!(await db.doc('families/intrus').get()).exists, 'avec effacer, l\'intrus disparaît');
});
