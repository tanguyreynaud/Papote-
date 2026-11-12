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

  const r = await lib.restaurer({ attenteDebut: 0, db, auth, sauvegarde: fichier });
  assert.strictEqual(r.documents, 1209);
  assert.strictEqual(r.comptes, 2);
  assert.ok((await db.doc('families/intrus').get()).exists, 'sans --effacer, le reste est gardé');
  const apres = await lib.sauvegarder({ db, auth, projet: 'demo-papote', base: 'europe' });
  assert.deepStrictEqual(apres.documents.filter((d) => !['families/intrus', 'interne/restauration'].includes(d.chemin)), avant.documents);
  assert.deepStrictEqual(apres.comptes.map((c) => ({ ...c, creeLe: null })), avant.comptes.map((c) => ({ ...c, creeLe: null })));
  const doc = (await fam.get()).data();
  assert.ok(doc.createdAt instanceof Timestamp && doc.createdAt.toMillis() === 1_761_800_000_123);
  assert.ok(doc.lieu instanceof GeoPoint && doc.lieu.latitude === 44.9369);
  assert.strictEqual(doc.createur.path, 'families/fam1/members/julie');
  assert.deepStrictEqual([...doc.photo], [1, 2, 3, 250]);
  assert.strictEqual(doc['@type'], 'piège');
  assert.strictEqual((await auth.getUser('julie')).customClaims.admin, true);

  // --effacer : remise exacte.
  const r2 = await lib.restaurer({ attenteDebut: 0, db, sauvegarde: fichier, effacer: true });
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
    listes: 0,
    async getFiles(o = {}) {
      this.listes++;
      return [Object.entries(contenus).filter(([name]) => !o.prefix || name.startsWith(o.prefix)).map(([name, b]) => ({
        name, metadata: { md5Hash: md5(b), size: String(b.length), contentType: name.endsWith('.jpg') ? 'image/jpeg' : name.endsWith('.pdf') ? 'application/pdf' : 'video/mp4' },
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

// Firestore refuse une requête (un commit) de plus de 10 Mio ; l'émulateur, lui, l'accepte. La base est donc
// entourée d'un garde qui mesure chaque lot et refuse comme la vraie base. Photos en taille réelle
// (posts/{id}/media/image, jusqu'à 900 000 caractères) : 150 envois de 100 Kio = 15 Mio.
test('restauration de gros documents (photos) : aucun lot de plus de 10 Mio, tout est réécrit', { timeout: 120000 }, async () => {
  await vider();
  const LIMITE = 10 * 1024 * 1024;
  const lots = [];
  const garde = {
    databaseId: 'europe',
    doc: (chemin) => db.doc(chemin),
    batch: () => {
      const vrai = db.batch();
      let octets = 0;
      let n = 0;
      return {
        set(ref, donnees) { octets += Buffer.byteLength(JSON.stringify(lib.encoder(donnees))); n++; vrai.set(ref, donnees); return this; },
        delete(ref) { vrai.delete(ref); return this; },
        async commit() {
          lots.push({ n, octets });
          if (octets > LIMITE) throw new Error(`3 INVALID_ARGUMENT: Request payload size exceeds the limit: ${LIMITE} bytes.`);
          return vrai.commit();
        },
      };
    },
  };
  const photo = 'data:image/jpeg;base64,' + 'A'.repeat(100 * 1024);
  const documents = [];
  for (let i = 0; i < 150; i++) {
    const p = `families/famG/posts/p${String(i).padStart(3, '0')}`;
    documents.push({ chemin: p, donnees: { type: 'photo', hearts: 0 } });
    documents.push({ chemin: `${p}/media/image`, donnees: { data: photo } });
  }
  const r = await lib.restaurer({ attenteDebut: 0, db: garde, sauvegarde: { version: lib.VERSION, base: 'europe', documents, comptes: [] } });
  assert.strictEqual(r.documents, 300);
  assert.ok(lots.length >= 2, `écrit en plusieurs lots (${lots.length})`);
  assert.ok(lots.every((l) => l.octets <= LIMITE && l.n <= 400), JSON.stringify(lots));
  assert.strictEqual((await db.collection('families/famG/posts').get()).size, 150);
  assert.strictEqual((await db.doc('families/famG/posts/p149/media/image').get()).get('data'), photo);
  assert.strictEqual((await db.doc('interne/restauration').get()).get('enCours'), false, 'restauration finie');
});

// ---------- Format 2 (A31, 12/11) : un document par ligne, contrôle, rotation sûre, mauvaise base, gestion/ ----------

// Fausse base « virtuelle » : 25 familles pleines (240 envois avec leur aperçu de 100 ko chacune, ≈ 600 Mo), créées
// à la lecture, page par page, comme les rend Firestore. Avant, JSON.stringify de toute la base s'arrêtait vers
// 512 Mo (audit 12/11, essai S1 : « Invalid string length » à 25 familles).
function baseVirtuelle({ familles = 25, envois = 240, apercu = 100_000 }) {
  const APERCU = `data:image/jpeg;base64,${'A'.repeat(apercu)}`;
  const doc = (path, data, sous = []) => ({ ref: { path, listCollections: async () => sous }, data: () => data, id: path.split('/').pop() });
  const collection = (chemin, n, fabriquer) => {
    const lire = (apres, limite) => {
      const docs = [];
      for (let i = apres + 1; i < n && docs.length < limite; i++) docs.push(fabriquer(i));
      return { empty: !docs.length, size: docs.length, docs };
    };
    const requete = (apres) => ({
      limit: (l) => ({ get: async () => lire(apres, l) }),
      startAfter: (d) => requete(Number(d.id.slice(1))),
    });
    return { path: chemin, orderBy: () => requete(-1) };
  };
  const nom = (i) => `f${String(i).padStart(3, '0')}`;
  return {
    databaseId: 'europe',
    listCollections: async () => [collection('families', familles, (f) => doc(`families/${nom(f)}`, { name: `Mamie ${f}` },
      [collection(`families/${nom(f)}/posts`, envois, (i) => doc(`families/${nom(f)}/posts/${nom(i)}`, { type: 'photo', thumb: APERCU, authorName: 'Julie' }))]))],
  };
}

test('S1 : 25 familles pleines (≈ 600 Mo) s\'écrivent, se contrôlent et se relisent ligne à ligne, sans tout garder en mémoire', { timeout: 300000 }, async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'papote-gros-'));
  const memoireAvant = process.memoryUsage().rss;
  let memoireMax = 0;
  const s = await lib.ecrireSauvegarde({
    db: baseVirtuelle({}), dossier, projet: 'demo-papote',
    progression: () => { memoireMax = Math.max(memoireMax, process.memoryUsage().rss); },
  });
  assert.strictEqual(s.entete.documents.lignes, 25 + 25 * 240);
  assert.ok(s.entete.documents.octets > 512 * 1024 * 1024, `${s.entete.documents.octets} octets : au-delà de l'ancienne limite`);
  assert.ok(memoireMax - memoireAvant < 300 * 1024 * 1024, `mémoire : +${Math.round((memoireMax - memoireAvant) / 1048576)} Mo`);
  assert.strictEqual(s.entete.base, 'europe');
  assert.deepStrictEqual(fs.readdirSync(dossier), [s.nom], 'un seul dossier, complet (plus de .en-cours)');
  const relue = await lib.lireSauvegarde(s.dossier);
  let n = 0;
  let apercus = 0;
  for await (const d of relue.documents) { n++; if (d.donnees.thumb) apercus++; }
  assert.deepStrictEqual([n, apercus, relue.nbDocuments], [6025, 6000, 6025]);
  fs.rmSync(dossier, { recursive: true, force: true });
});

// Remplit la base de l'émulateur avec n documents « famille » (et une sous-collection).
async function remplir(n, prefixe = 'fam') {
  for (let i = 0; i < n; i++) {
    await db.doc(`families/${prefixe}${i}`).set({ name: `Mamie ${i}`, createdAt: Timestamp.fromMillis(1_761_800_000_000 + i) });
    await db.doc(`families/${prefixe}${i}/posts/p1`).set({ type: 'message', text: `Bisous ${i}` });
  }
}
const date = (jour, h = 3) => new Date(Date.UTC(2026, 10, jour, h, 0, 0));
const sauvegardesDe = (dossier) => fs.readdirSync(dossier).filter((f) => /^papote-/.test(f)).sort();

test('sauvegarde coupée au milieu : aucune ancienne effacée, rien de complet en plus ; la suivante fait le ménage', async () => {
  await vider();
  await remplir(30);
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'papote-coupee-'));
  const ok1 = await lib.ecrireSauvegarde({ db, auth, dossier, projet: 'demo-papote', garder: 1, le: date(1) });
  assert.strictEqual(ok1.entete.documents.lignes, 60);

  // Coupure après la première page lue (réseau, PC mis en veille…) : une erreur, pas de dossier complet.
  let pages = 0;
  await assert.rejects(() => lib.ecrireSauvegarde({
    db, auth, dossier, projet: 'demo-papote', garder: 1, le: date(8),
    progression: () => { if (++pages === 1) throw new Error('coupure réseau'); },
  }), /coupure réseau/);
  assert.deepStrictEqual(sauvegardesDe(dossier), [ok1.nom, 'papote-2026-11-08-03-00-00.en-cours'], 'l\'ancienne est toujours là (garder: 1 n\'a rien effacé)');
  await assert.rejects(() => lib.lireSauvegarde(path.join(dossier, 'papote-2026-11-08-03-00-00.en-cours')), /incomplète/);

  // Fichier coupé en plein milieu (PC éteint pendant l'écriture) : le contrôle le refuse.
  const coupe = path.join(dossier, 'copie-coupee');
  fs.cpSync(ok1.dossier, coupe, { recursive: true });
  const docs = path.join(coupe, 'documents.jsonl');
  fs.truncateSync(docs, Math.floor(fs.statSync(docs).size / 2));
  await assert.rejects(() => lib.verifierDossier(coupe), /coupée|illisible|lignes relues/);
  fs.rmSync(coupe, { recursive: true, force: true });

  // Le dimanche suivant réussit : la coupée est effacée, et la rotation (garder: 1) n'a lieu qu'après le contrôle.
  const ok3 = await lib.ecrireSauvegarde({ db, auth, dossier, projet: 'demo-papote', garder: 1, le: date(15) });
  assert.deepStrictEqual(ok3.effacees.sort(), [ok1.nom, 'papote-2026-11-08-03-00-00.en-cours']);
  assert.deepStrictEqual(sauvegardesDe(dossier), [ok3.nom]);
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('S2 : quatre sauvegardes vides de suite n\'effacent pas la dernière bonne ; les anciens .json partent seulement après 4 complètes', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'papote-rotation-'));
  fs.writeFileSync(path.join(dossier, 'papote-2026-10-25-03-00-00.json'), '{}'); // ancien format
  fs.writeFileSync(path.join(dossier, 'journal.txt'), 'x');
  await vider();
  await remplir(20);
  const bonne = await lib.ecrireSauvegarde({ db, dossier, projet: 'demo-papote', le: date(1) });
  await vider(); // base vidée par erreur : les dimanches suivants sauvegardent du vide
  const noms = [bonne.nom];
  for (let j = 2; j <= 6; j++) {
    const s = await lib.ecrireSauvegarde({ db, dossier, projet: 'demo-papote', le: date(j) });
    noms.push(s.nom);
    assert.strictEqual(s.entete.documents.lignes, 0);
  }
  const reste = sauvegardesDe(dossier);
  assert.ok(reste.includes(bonne.nom), 'la seule sauvegarde avec des données est gardée');
  assert.deepStrictEqual(reste, [bonne.nom, ...noms.slice(-4)], 'plus les 4 plus récentes');
  assert.ok(!reste.includes('papote-2026-10-25-03-00-00.json'), 'ancien format effacé une fois 4 sauvegardes complètes présentes');
  assert.ok(fs.existsSync(path.join(dossier, 'journal.txt')));
  // La base revient à la normale : la bonne n'est plus la plus récente pleine, elle part avec la rotation.
  await remplir(20);
  for (let j = 7; j <= 10; j++) await lib.ecrireSauvegarde({ db, dossier, projet: 'demo-papote', le: date(j) });
  assert.deepStrictEqual(sauvegardesDe(dossier), [7, 8, 9, 10].map((j) => lib.nomSauvegarde(date(j))));
  assert.deepStrictEqual(lib.garderDernieres(dossier, 0), [], '0 = tout garder');
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('S3 : une sauvegarde de « europe » est refusée dans « (default) », sauf --autre-base ; le relevé de sauvegarde n\'est jamais réécrit', async () => {
  await vider();
  await remplir(3);
  await db.doc('interne/sauvegarde').set({ derniereReussie: Timestamp.fromMillis(1000) });
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'papote-base-'));
  const s = await lib.ecrireSauvegarde({ db, auth, dossier, projet: 'demo-papote', le: date(1) });
  assert.strictEqual(s.entete.base, 'europe');
  const relue = await lib.lireSauvegarde(s.dossier);
  const defaut = getFirestore(app);
  await assert.rejects(() => lib.restaurer({ attenteDebut: 0, db: defaut, sauvegarde: relue }), /vient de la base « europe », pas de « \(default\) » : restauration refusée/);
  assert.strictEqual((await defaut.collection('families').get()).size, 0, 'rien écrit dans (default)');
  assert.strictEqual((await defaut.doc('interne/restauration').get()).exists, false, 'pas même le drapeau');
  // Format 1 sans base notée : refusé aussi.
  await assert.rejects(() => lib.restaurer({ attenteDebut: 0, db, sauvegarde: { version: 1, documents: [], comptes: [] } }), /base « inconnue »/);

  // Exprès : accepté.
  const r = await lib.restaurer({ attenteDebut: 0, db: defaut, sauvegarde: relue, autreBase: true });
  assert.strictEqual(r.documents, 6, 'familles et envois, pas interne/sauvegarde');
  assert.strictEqual((await defaut.doc('interne/sauvegarde').get()).exists, false);
  // Dans la bonne base, depuis le disque : identique ; le relevé de sauvegarde reste celui du moment.
  await vider();
  await db.doc('interne/sauvegarde').set({ derniereReussie: Timestamp.fromMillis(2000) });
  const r2 = await lib.restaurer({ attenteDebut: 0, db, sauvegarde: relue, effacer: true });
  assert.strictEqual(r2.documents, 6);
  assert.strictEqual((await db.doc('interne/sauvegarde').get()).get('derniereReussie').toMillis(), 2000, 'ni réécrit, ni effacé par --effacer');
  assert.strictEqual((await db.doc('families/fam2/posts/p1').get()).get('text'), 'Bisous 2');
  for (const c of await defaut.listCollections()) await defaut.recursiveDelete(c);
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('stockage : le dossier gestion/ est copié chaque dimanche (incrémental, contrôlé, réparé), pas les photos sans --photos', async () => {
  await vider();
  await remplir(1);
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'papote-gestion-'));
  const bucket = fauxBucket({
    'gestion/ventes/2026/F-2026-0001.pdf': Buffer.alloc(4000, 1), 'gestion/livres/2026-10.csv': Buffer.from('date;montant\n'),
    'gestion/achats/ticket.jpg': Buffer.alloc(900, 3), 'families/fam0/p1.jpg': Buffer.alloc(5000, 9),
  });
  const s1 = await lib.ecrireSauvegarde({ db, bucket, dossier, projet: 'demo-papote', le: date(1) });
  assert.deepStrictEqual(s1.entete.gestion, { fichiers: 3, nouveaux: 3, octets: 4000 + 13 + 900 });
  const fichiers = path.join(dossier, 'fichiers');
  assert.ok(fs.existsSync(path.join(fichiers, 'gestion', 'ventes', '2026', 'F-2026-0001.pdf')));
  assert.ok(!fs.existsSync(path.join(fichiers, 'families')), 'photos pas copiées par défaut');

  // Dimanche suivant : une facture de plus, une seule téléchargée ; une pièce supprimée du bucket reste dans la copie.
  bucket.contenus['gestion/ventes/2026/F-2026-0002.pdf'] = Buffer.alloc(4100, 2);
  delete bucket.contenus['gestion/achats/ticket.jpg'];
  const avant = bucket.telechargements;
  const s2 = await lib.ecrireSauvegarde({ db, bucket, dossier, projet: 'demo-papote', le: date(8) });
  assert.strictEqual(bucket.telechargements - avant, 1);
  assert.deepStrictEqual([s2.entete.gestion.fichiers, s2.entete.gestion.nouveaux], [4, 1]);
  assert.ok(fs.existsSync(path.join(fichiers, 'gestion', 'achats', 'ticket.jpg')));

  // Copie locale abîmée : retéléchargée, la sauvegarde réussit quand même.
  fs.writeFileSync(path.join(fichiers, 'gestion', 'livres', '2026-10.csv'), 'abîmé');
  const s3 = await lib.ecrireSauvegarde({ db, bucket, dossier, projet: 'demo-papote' }); // aujourd'hui : verifier-sauvegarde regarde l'âge
  assert.strictEqual(s3.entete.gestion.nouveaux, 1);
  assert.strictEqual(fs.readFileSync(path.join(fichiers, 'gestion', 'livres', '2026-10.csv'), 'utf8'), 'date;montant\n');

  // Bucket en panne : la sauvegarde échoue (pas de dossier complet de plus), les anciennes restent.
  const enPanne = { getFiles: async () => { throw new Error('503 stockage indisponible'); } };
  await assert.rejects(() => lib.ecrireSauvegarde({ db, bucket: enPanne, dossier, projet: 'demo-papote', le: date(22) }), /503/);
  assert.deepStrictEqual(sauvegardesDe(dossier).filter((f) => !f.endsWith('.en-cours')), [s1.nom, s2.nom, s3.nom]);

  // Remise dans le bucket (restaurer.bat --photos) depuis la copie.
  delete bucket.contenus['gestion/ventes/2026/F-2026-0001.pdf'];
  const rr = await lib.restaurerFichiers({ bucket, dossier: (await lib.lireSauvegarde(s3.dossier)).dossierFichiers });
  assert.ok(rr.remis >= 1);
  assert.strictEqual(bucket.contenus['gestion/ventes/2026/F-2026-0001.pdf'].length, 4000);

  // verifier-sauvegarde.js sur un dossier (format 2) avec sa copie gestion/ : VÉRIFIÉE.
  const sortie = execFileSync(process.execPath, [path.join(__dirname, 'verifier-sauvegarde.js'), s3.dossier], { encoding: 'utf8' });
  assert.match(sortie, /1 familles/);
  assert.match(sortie, /dont 4 pièces de gestion\//);
  assert.match(sortie, /Photos et vidéos : pas copiées/);
  assert.match(sortie, /Sauvegarde VÉRIFIÉE/);
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('copie chiffrée hors Google : dossier chiffré au fil de l\'eau, relu, rotation sûre ; dechiffrer-sauvegarde la remet en clair', async () => {
  await vider();
  await remplir(5);
  await db.doc('families/fam0/members/julie').set({ name: 'Julie', telephone: '0612345678' });
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'papote-clair-'));
  const racine = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papote-usb-')), 'Papote');
  const bucket = fauxBucket({ 'gestion/ventes/F-1.pdf': Buffer.alloc(3000, 5) });
  const PHRASE = 'cheval agrafe batterie correct';
  const s = await lib.ecrireSauvegarde({ db, auth, bucket, dossier, projet: 'demo-papote', le: date(1) });
  const c = await lib.copierChiffre({ source: s.dossier, racine, phrase: PHRASE, fichiers: path.join(dossier, 'fichiers') });
  assert.strictEqual(c.fichiers, 1);
  assert.deepStrictEqual(fs.readdirSync(c.dossier).sort(), ['comptes.jsonl.enc', 'documents.jsonl.enc', 'entete.json']);
  assert.ok(!fs.readFileSync(path.join(c.dossier, 'documents.jsonl.enc')).includes(Buffer.from('0612345678')), 'rien de lisible');
  assert.ok(fs.existsSync(path.join(racine, 'fichiers', 'gestion', 'ventes', 'F-1.pdf.enc')));
  // Deuxième copie : la pièce déjà chiffrée n'est pas refaite.
  const s2 = await lib.ecrireSauvegarde({ db, auth, bucket, dossier, projet: 'demo-papote', le: date(8) });
  assert.strictEqual((await lib.copierChiffre({ source: s2.dossier, racine, phrase: PHRASE, fichiers: path.join(dossier, 'fichiers') })).fichiers, 0);

  const lancer = (...args) => execFileSync(process.execPath, [path.join(__dirname, 'dechiffrer-sauvegarde.js'), ...args],
    { encoding: 'utf8', env: { ...process.env, PAPOTE_PHRASE_SAUVEGARDE: PHRASE } });
  assert.match(lancer(c.dossier), /Écrit et contrôlé : .*\(11 documents, 0 comptes/);
  const clair = path.join(`${racine}-clair`, s.nom);
  assert.strictEqual((await lib.verifierDossier(clair)).documents.sha256, s.entete.documents.sha256, 'identique à l\'original');
  assert.match(lancer(path.join(racine, 'fichiers')), /1 fichiers, 0 manquant\(s\), 0 abîmé\(s\)/);
  assert.strictEqual(fs.readFileSync(path.join(`${racine}-clair`, 'fichiers', 'gestion', 'ventes', 'F-1.pdf')).length, 3000);
  // La relecture se restaure (dossier en clair, fichiers à côté).
  const relue = await lib.lireSauvegarde(clair);
  assert.strictEqual(relue.dossierFichiers, path.join(`${racine}-clair`, 'fichiers'));
  // Mauvaise phrase : refus clair, rien d'écrit.
  assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, 'dechiffrer-sauvegarde.js'), c.dossier, path.join(racine, 'faux')],
    { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, PAPOTE_PHRASE_SAUVEGARDE: 'une autre phrase longue' } }), /Phrase secrète incorrecte/);
  assert.ok(!fs.existsSync(path.join(racine, 'faux', 'documents.jsonl')));
  fs.rmSync(dossier, { recursive: true, force: true });
  fs.rmSync(path.dirname(racine), { recursive: true, force: true });
});

// ---------- A34 : mots de passe des comptes « appels » des tablettes, confirmation de --effacer ----------

const PROJET_A34 = process.env.GCLOUD_PROJECT || 'demo-papote';
const PHRASE_A34 = 'cheval agrafe batterie correct';
// Paramètres de hachage factices (les vrais sont dans la console Firebase, jamais dans le dépôt).
const HACHAGE = { algorithm: 'SCRYPT', base64_signer_key: Buffer.alloc(64, 7).toString('base64'), base64_salt_separator: 'Bw==', rounds: 8, mem_cost: 14 };
const TABLETTE = 'tablette-appels-abcdefghij0123456789@tablettes.papote-famille.web.app';

test('mots de passe des tablettes : chiffrés à part (jamais en clair), copiés dans la copie chiffrée, remis avec les paramètres de hachage', async () => {
  await vider();
  await remplir(2);
  await auth.createUser({ uid: 'tab1', email: TABLETTE, password: 'Mot2PasseTireAuHasardDe32Signes' });
  await auth.createUser({ uid: 'julie', email: 'julie@exemple.fr', displayName: 'Julie' });
  const empreinte = (await auth.getUser('tab1')).passwordHash;
  assert.ok(empreinte, 'l\'émulateur rend l\'empreinte');
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'papote-mdp-'));

  // Sans phrase : rien de gardé, et l'entête le dit.
  const sans = await lib.ecrireSauvegarde({ db, auth, dossier, projet: 'demo-papote', le: date(1) });
  assert.deepStrictEqual(sans.entete.motsDePasse, { comptes: 1, chiffres: false });
  assert.ok(!fs.existsSync(path.join(sans.dossier, lib.MOTS_DE_PASSE)));

  const s = await lib.ecrireSauvegarde({ db, auth, dossier, projet: 'demo-papote', le: date(8), phrase: PHRASE_A34, hachage: HACHAGE });
  assert.strictEqual(s.entete.motsDePasse.comptes, 1);
  assert.strictEqual(s.entete.motsDePasse.hachage, true);
  const enClair = fs.readFileSync(path.join(s.dossier, 'comptes.jsonl'), 'utf8') + fs.readFileSync(path.join(s.dossier, 'entete.json'), 'utf8');
  assert.ok(!enClair.includes(empreinte) && !/passwordHash|"hash"|signer_key/.test(enClair), 'aucune empreinte ni clé en clair');
  const chiffre = fs.readFileSync(path.join(s.dossier, lib.MOTS_DE_PASSE));
  assert.ok(!chiffre.includes(Buffer.from(empreinte)) && !chiffre.includes(Buffer.from(HACHAGE.base64_signer_key)));
  const racine = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'papote-usb-')), 'Papote');
  const c = await lib.copierChiffre({ source: s.dossier, racine, phrase: PHRASE_A34 });
  assert.ok(fs.readFileSync(path.join(c.dossier, lib.MOTS_DE_PASSE)).equals(chiffre), 'copie chiffrée : le même fichier');

  // Comptes perdus. Sans phrase, ou avec une fausse : refus AVANT toute écriture.
  await auth.deleteUsers(['tab1', 'julie']);
  const relue = await lib.lireSauvegarde(s.dossier);
  await db.doc('interne/restauration').delete();
  await assert.rejects(() => lib.restaurer({ attenteDebut: 0, db, auth, sauvegarde: relue, attenteFin: 0 }), /phrase secrète nécessaire/);
  await assert.rejects(() => lib.restaurer({ attenteDebut: 0, db, auth, sauvegarde: relue, phrase: 'une autre phrase longue', attenteFin: 0 }), /Phrase secrète incorrecte/);
  assert.strictEqual((await db.doc('interne/restauration').get()).exists, false, 'rien écrit');

  // Avec la phrase : la tablette revient avec son empreinte, importée avec les paramètres de hachage du projet.
  const imports = [];
  const espion = { getUsers: (x) => auth.getUsers(x), importUsers: (u, o) => { imports.push({ u, o }); return auth.importUsers(u, o); } };
  const r = await lib.restaurer({ attenteDebut: 0, db, auth: espion, sauvegarde: relue, phrase: PHRASE_A34, attenteFin: 0 });
  assert.deepStrictEqual([r.comptes, r.avecMotDePasse, r.sansMotDePasse], [2, 1, 0]);
  const o = imports[0].o.hash;
  assert.deepStrictEqual([o.algorithm, o.rounds, o.memoryCost], ['SCRYPT', 8, 14]);
  assert.ok(o.key.equals(Buffer.alloc(64, 7)) && o.saltSeparator.equals(Buffer.from([7])));
  const tab = imports[0].u.find((u) => u.uid === 'tab1');
  assert.ok(tab.passwordHash.equals(Buffer.from(empreinte, 'base64')), 'empreinte remise telle quelle');
  assert.strictEqual(imports[0].u.find((u) => u.uid === 'julie').passwordHash, undefined);
  assert.strictEqual((await auth.getUser('tab1')).email, TABLETTE);

  // Sauvegarde sans paramètres de hachage : ils peuvent venir du PC au moment de la restauration ; sinon le compte
  // revient sans mot de passe, et c'est compté (restaurer.js l'affiche).
  const s2 = await lib.ecrireSauvegarde({ db, auth, dossier, projet: 'demo-papote', le: date(15), phrase: PHRASE_A34 });
  assert.strictEqual(s2.entete.motsDePasse.hachage, false);
  // Compte encore là : laissé tel quel.
  const r1 = await lib.restaurer({ attenteDebut: 0, db, auth, sauvegarde: await lib.lireSauvegarde(s2.dossier), phrase: PHRASE_A34, attenteFin: 0 });
  assert.deepStrictEqual([r1.comptes, r1.dejaLa], [0, 2]);
  await auth.deleteUsers(['tab1', 'julie']);
  const r2 = await lib.restaurer({ attenteDebut: 0, db, auth, sauvegarde: await lib.lireSauvegarde(s2.dossier), phrase: PHRASE_A34, attenteFin: 0 });
  assert.deepStrictEqual([r2.avecMotDePasse, r2.sansMotDePasse], [0, 1]);
  await auth.deleteUsers(['tab1', 'julie']);
  const r3 = await lib.restaurer({ attenteDebut: 0, db, auth, sauvegarde: await lib.lireSauvegarde(s2.dossier), phrase: PHRASE_A34, hachage: HACHAGE, attenteFin: 0 });
  assert.deepStrictEqual([r3.avecMotDePasse, r3.sansMotDePasse], [1, 0]);
  const relue2 = await lib.lireSauvegarde(s2.dossier);
  await assert.rejects(() => lib.restaurer({ attenteDebut: 0, db, auth, sauvegarde: relue2, phrase: PHRASE_A34, hachage: { rounds: 8 }, attenteFin: 0 }), /paramètres de hachage .* incomplets/);
  fs.rmSync(dossier, { recursive: true, force: true });
  fs.rmSync(path.dirname(racine), { recursive: true, force: true });
});

test('restaurer.js --effacer : liste de ce qui part, et il faut taper le nom de la base (rien par défaut)', { timeout: 180000 }, async () => {
  await vider();
  await remplir(2);
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'papote-effacer-'));
  const s = await lib.ecrireSauvegarde({ db, dossier, projet: PROJET_A34, le: date(1) });
  const cle = path.join(dossier, 'cle.json');
  fs.writeFileSync(cle, JSON.stringify({
    type: 'service_account', project_id: PROJET_A34, client_email: `outil@${PROJET_A34}.iam.gserviceaccount.com`,
    private_key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }));
  const lancer = (args, input) => {
    try {
      return { code: 0, sortie: execFileSync(process.execPath, [path.join(__dirname, 'restaurer.js'), s.dossier, ...args], {
        encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000,
        env: { ...process.env, PAPOTE_CLE_ADMIN: cle, PAPOTE_BASE: 'europe', PAPOTE_ATTENTE_DRAPEAU_MS: '0' },
      }) };
    } catch (e) { return { code: e.status, sortie: `${e.stdout || ''}${e.stderr || ''}` }; }
  };
  const nouvelles = async () => {
    await db.doc('families/nouvelle').set({ name: 'Créée après' });
    await db.doc('commandes/sub_apres').set({ code: 'APRES1' });
  };
  await nouvelles();

  // Sans --oui : la liste, rien de fait.
  const voir = lancer(['--effacer'], '');
  assert.strictEqual(voir.code, 0, voir.sortie);
  assert.match(voir.sortie, /ATTENTION : --effacer/);
  assert.match(voir.sortie, /2 document\(s\) de la base « europe » .* EFFACÉS/);
  assert.match(voir.sortie, /dont 1 famille\(s\) et 1 commande\(s\)/);
  assert.match(voir.sortie, /- families\/nouvelle/);

  // Entrée seule, mauvaise réponse, fin de saisie, mauvaise base en option : annulé, rien n'a changé.
  for (const [args, input] of [[[], '\n'], [[], 'oui\n'], [[], 'O\n'], [[], ''], [['--confirmer-base', '(default)'], '']]) {
    const r = lancer(['--oui', '--effacer', ...args], input);
    assert.strictEqual(r.code, 1, `${JSON.stringify(input)} : ${r.sortie}`);
    assert.match(r.sortie, /restauration ANNULÉE, rien n'a été changé/);
    assert.ok((await db.doc('families/nouvelle').get()).exists);
    assert.strictEqual((await db.doc('interne/restauration').get()).exists, false, 'pas même le drapeau');
  }

  // Le nom tapé : effacé et restauré.
  const ok = lancer(['--oui', '--effacer'], 'europe\n');
  assert.strictEqual(ok.code, 0, ok.sortie);
  assert.match(ok.sortie, /Pour confirmer, tapez le nom de la base \(europe\)/);
  assert.match(ok.sortie, /Restauré : 4 documents, 2 effacé\(s\)/);
  assert.strictEqual((await db.doc('families/nouvelle').get()).exists, false);
  assert.strictEqual((await db.doc('families/fam1').get()).get('name'), 'Mamie 1');

  // Sans clavier (tâche, script) : --confirmer-base europe.
  await nouvelles();
  const auto = lancer(['--oui', '--effacer', '--confirmer-base', 'europe'], '');
  assert.strictEqual(auto.code, 0, auto.sortie);
  assert.strictEqual((await db.doc('commandes/sub_apres').get()).exists, false);
  // Sans --effacer : aucune question.
  const simple = lancer(['--oui'], '');
  assert.strictEqual(simple.code, 0, simple.sortie);
  assert.doesNotMatch(simple.sortie, /tapez le nom/);
  fs.rmSync(dossier, { recursive: true, force: true });
});
