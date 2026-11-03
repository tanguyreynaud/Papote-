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

// ---------- Photos et vidéos (Storage simulé) et vérification réelle ----------
// Le bucket est simulé (getFiles / download / upload) : l'émulateur Storage n'est pas lancé ici. Le script
// verifier-sauvegarde.js, lui, tourne pour de vrai sur l'émulateur Firestore à partir d'un fichier écrit sur le disque.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function fauxBucket(contenus) {
  const md5 = (b) => crypto.createHash('md5').update(b).digest('base64');
  return {
    contenus,
    telechargements: 0,
    async getFiles() {
      return [Object.entries(contenus).map(([name, b]) => ({
        name, metadata: { md5Hash: md5(b), size: String(b.length), contentType: name.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4' },
        download: async ({ destination }) => { this.telechargements++; fs.writeFileSync(destination, b); },
      }))];
    },
    async upload(local, { destination }) { contenus[destination] = fs.readFileSync(local); },
  };
}

test('photos et vidéos : copie incrémentale, vérification (fichier abîmé repéré), remise dans le bucket', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'papote-fichiers-'));
  const bucket = fauxBucket({
    'families/fam1/p1.jpg': Buffer.alloc(5000, 1), 'families/fam1/v1.mp4': Buffer.alloc(20000, 2), 'families/fam2/p2.jpg': Buffer.alloc(300, 3),
  });
  const r1 = await lib.sauvegarderFichiers({ bucket, dossier });
  assert.deepStrictEqual([r1.total, r1.copies, r1.octets], [3, 3, 25300]);
  assert.ok(fs.existsSync(path.join(dossier, 'families', 'fam1', 'v1.mp4')));

  // Deuxième passage : rien de nouveau → rien téléchargé. Une photo change, une arrive, une disparaît du bucket.
  const r2 = await lib.sauvegarderFichiers({ bucket, dossier });
  assert.strictEqual(r2.copies, 0);
  bucket.contenus['families/fam1/p1.jpg'] = Buffer.alloc(5000, 9);
  bucket.contenus['families/fam3/p3.jpg'] = Buffer.alloc(10, 4);
  delete bucket.contenus['families/fam2/p2.jpg'];
  const r3 = await lib.sauvegarderFichiers({ bucket, dossier });
  assert.strictEqual(r3.copies, 2, 'la photo changée et la nouvelle');
  assert.ok(fs.existsSync(path.join(dossier, 'families', 'fam2', 'p2.jpg')), 'la photo supprimée du bucket reste dans la copie');
  assert.deepStrictEqual([...fs.readFileSync(path.join(dossier, 'families', 'fam1', 'p1.jpg'))].slice(0, 2), [9, 9]);

  // Vérification : tout bon, puis un fichier abîmé et un manquant sont repérés.
  assert.deepStrictEqual(await lib.verifierFichiers(dossier), { total: 4, manquants: [], abimes: [] });
  fs.writeFileSync(path.join(dossier, 'families', 'fam1', 'v1.mp4'), Buffer.alloc(20000, 7));
  fs.unlinkSync(path.join(dossier, 'families', 'fam3', 'p3.jpg'));
  const v = await lib.verifierFichiers(dossier);
  assert.deepStrictEqual([v.manquants, v.abimes], [['families/fam3/p3.jpg'], ['families/fam1/v1.mp4']]);

  // Remise : le bucket a perdu fam1 ; seuls les fichiers absents ou différents sont renvoyés.
  fs.writeFileSync(path.join(dossier, 'families', 'fam1', 'v1.mp4'), Buffer.alloc(20000, 2));
  fs.writeFileSync(path.join(dossier, 'families', 'fam3', 'p3.jpg'), Buffer.alloc(10, 4));
  delete bucket.contenus['families/fam1/p1.jpg'];
  delete bucket.contenus['families/fam1/v1.mp4'];
  const rr = await lib.restaurerFichiers({ bucket, dossier });
  assert.strictEqual(rr.remis, 3, 'p1, v1 et p2 (absente du bucket)');
  assert.strictEqual(bucket.contenus['families/fam2/p2.jpg'].length, 300);
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('verifier-sauvegarde.js : une vraie sauvegarde sur le disque se relit ; un fichier abîmé ou un envoi sans fichier fait échouer', async () => {
  await vider();
  await db.doc('families/fam1').set({ name: 'Mamie Emma', createdAt: Timestamp.fromMillis(1_761_800_000_123) });
  await db.doc('families/fam1/posts/p1').set({ type: 'photo', storagePath: 'families/fam1/p1.jpg' });
  await db.doc('families/fam1/posts/p2').set({ type: 'photo', photos: [{ storagePath: 'families/fam1/p2.jpg' }] });
  await auth.createUser({ uid: 'julie', email: 'julie@exemple.fr' });
  const s = await lib.sauvegarder({ db, auth, projet: 'demo-papote', base: 'europe' });
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'papote-sauvegarde-'));
  const fichier = path.join(dossier, 'papote-test.json');
  fs.writeFileSync(fichier, JSON.stringify(s));
  const bucket = fauxBucket({ 'families/fam1/p1.jpg': Buffer.alloc(50, 1), 'families/fam1/p2.jpg': Buffer.alloc(60, 2) });
  await lib.sauvegarderFichiers({ bucket, dossier: path.join(dossier, 'fichiers') });
  await vider();

  const lancer = () => {
    try { return { code: 0, sortie: execFileSync(process.execPath, [path.join(__dirname, 'verifier-sauvegarde.js'), fichier], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (e) { return { code: e.status, sortie: `${e.stdout}${e.stderr}` }; }
  };
  const ok = lancer();
  assert.strictEqual(ok.code, 0, ok.sortie);
  assert.match(ok.sortie, /1 familles, 0 proches et tablettes, 2 envois/);
  assert.match(ok.sortie, /Les 2 fichiers cités par la base sont dans la copie/);
  assert.match(ok.sortie, /Sauvegarde VÉRIFIÉE/);

  fs.writeFileSync(path.join(dossier, 'fichiers', 'families', 'fam1', 'p1.jpg'), Buffer.alloc(50, 8));
  const abime = lancer();
  assert.strictEqual(abime.code, 1);
  assert.match(abime.sortie, /Fichiers abîmés : families\/fam1\/p1.jpg/);

  fs.rmSync(path.join(dossier, 'fichiers'), { recursive: true, force: true });
  await lib.sauvegarderFichiers({ bucket: fauxBucket({ 'families/fam1/p1.jpg': Buffer.alloc(50, 1) }), dossier: path.join(dossier, 'fichiers') });
  const manque = lancer();
  assert.strictEqual(manque.code, 1);
  assert.match(manque.sortie, /1 envoi\(s\) de la base sans fichier dans la copie \(ex\. families\/fam1\/p2.jpg\)/);
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('garderDernieres : seules les 4 sauvegardes les plus récentes restent, le reste du dossier n\'est pas touché', () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'papote-garder-'));
  const noms = ['papote-2026-10-04-03-00-00.json', 'papote-2026-10-11-03-00-01.json', 'papote-2026-10-18-03-00-00.json',
    'papote-2026-10-25-03-00-00.json', 'papote-2026-11-01-03-00-00.json', 'papote-2026-11-08-03-00-00.json'];
  for (const n of noms) fs.writeFileSync(path.join(dossier, n), '{}');
  fs.writeFileSync(path.join(dossier, 'journal.txt'), 'x');
  fs.writeFileSync(path.join(dossier, 'papote-test.json'), '{}'); // nom sans date : jamais effacé
  assert.deepStrictEqual(lib.garderDernieres(dossier, 4), noms.slice(0, 2));
  assert.deepStrictEqual(fs.readdirSync(dossier).sort(), [...noms.slice(2), 'journal.txt', 'papote-test.json'].sort());
  assert.deepStrictEqual(lib.garderDernieres(dossier, 4), [], 'rien de plus à effacer');
  assert.deepStrictEqual(lib.garderDernieres(dossier, 0), [], '0 = tout garder');
  fs.rmSync(dossier, { recursive: true, force: true });
});
