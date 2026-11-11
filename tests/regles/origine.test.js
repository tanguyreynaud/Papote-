// Base d'origine « (default) » (firestore-origine.rules) et ancien bucket (storage.rules), fermés depuis la bascule
// en Europe (audit 8, N3, 11/11) : seuls config/base et le premier code de jumelage d'une tablette neuve y passent.
// Lancer : « npm test » dans tests/regles (Java nécessaire pour les émulateurs).

const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, getDoc, getDocs, deleteDoc, collection, serverTimestamp, Timestamp, setLogLevel } = require('firebase/firestore');
const { ref, uploadString, getBytes } = require('firebase/storage');

setLogLevel('silent');
let env;
const google = (uid) => env.authenticatedContext(uid, { email: `${uid}@exemple.fr`, email_verified: true, firebase: { sign_in_provider: 'google.com' } });
const anonyme = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } });
const admin = () => env.authenticatedContext('tanguy', { email: 'tanguy@exemple.fr', email_verified: true, admin: true, firebase: { sign_in_provider: 'google.com' } });

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-papote',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '../../firestore-origine.rules'), 'utf8') },
    storage: { rules: fs.readFileSync(path.join(__dirname, '../../storage.rules'), 'utf8') },
  });
});
test.after(() => env.cleanup());
test.beforeEach(async () => { await env.clearFirestore(); await env.clearStorage(); });

test('config/base reste lisible par tout compte connecté, jamais modifiable', async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'config/base'), { database: 'eu', bucket: 'papote-famille-eu' }));
  await assertSucceeds(getDoc(doc(anonyme('tab').firestore(), 'config/base')));
  await assertSucceeds(getDoc(doc(google('julie').firestore(), 'config/base')));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'config/base')));
  await assertFails(setDoc(doc(admin().firestore(), 'config/base'), { database: '(default)' }));
  await assertFails(getDocs(collection(google('julie').firestore(), 'config')));
});

test('N3 : un compte Google ne crée plus de famille, d\'invitation ni de membre ; rien ne se lit', async () => {
  const db = google('pirate').firestore();
  await assertFails(setDoc(doc(db, 'families/libre'), { name: 'Libre', code: 'ZZZZ2222', createdBy: 'pirate', createdAt: serverTimestamp() }));
  await assertFails(setDoc(doc(db, 'invites/ZZZZ2222'), { fid: 'libre', createdBy: 'pirate' }));
  await assertFails(setDoc(doc(db, 'families/libre/members/pirate'), { name: 'P', role: 'famille', code: 'ZZZZ2222', uid: 'pirate', email: 'pirate@exemple.fr', status: 'active' }));
  await assertFails(setDoc(doc(db, 'families/libre/posts/p1'), { type: 'message', text: 'x', authorUid: 'pirate' }));
  await assertFails(setDoc(doc(anonyme('x').firestore(), 'families/libre/members/x/private/push'), { a: 1 }));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'families/vieille'), { name: 'Vieille', createdBy: 'julie' }));
  await assertFails(getDoc(doc(google('julie').firestore(), 'families/vieille')));
  await assertFails(getDoc(doc(admin().firestore(), 'families/vieille')));
});

test('tablette neuve (APK d\'avant) : crée son code de jumelage, le relit et l\'efface ; personne d\'autre', async () => {
  const tab = anonyme('tab').firestore();
  const code = { tabletUid: 'tab', callsUid: 'tab-appels', name: 'Tablette', createdAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + 10 * 60e3), status: 'waiting' };
  await assertSucceeds(setDoc(doc(tab, 'pairings/QRST6789'), code));
  await assertSucceeds(getDoc(doc(tab, 'pairings/QRST6789')));
  await assertFails(getDoc(doc(google('julie').firestore(), 'pairings/QRST6789')));
  await assertFails(setDoc(doc(google('julie').firestore(), 'pairings/QRST6789'), { ...code, tabletUid: 'tab' }, { merge: true }));
  await assertFails(setDoc(doc(anonyme('robot').firestore(), 'pairings/ROBO2345'), { ...code, tabletUid: 'tab' }));
  await assertFails(setDoc(doc(tab, 'pairings/LONG2345'), { ...code, expiresAt: Timestamp.fromMillis(Date.now() + 60 * 60e3) }));
  await assertFails(deleteDoc(doc(anonyme('robot').firestore(), 'pairings/QRST6789')));
  await assertSucceeds(deleteDoc(doc(tab, 'pairings/QRST6789')));
});

test('ancien bucket : aucun dépôt ni lecture, même pour l\'administrateur', async () => {
  const st = (ctx) => ctx.storage('gs://demo-papote.appspot.com');
  await env.withSecurityRulesDisabled((ctx) => uploadString(ref(st(ctx), 'families/f/media/a.jpg'), 'x', 'raw', { contentType: 'image/jpeg' }));
  await assertFails(uploadString(ref(st(google('pirate')), 'families/libre/media/f.mp4'), 'x'.repeat(1000), 'raw', { contentType: 'video/mp4' }));
  await assertFails(getBytes(ref(st(google('julie')), 'families/f/media/a.jpg')));
  await assertFails(uploadString(ref(st(admin()), 'families/f/media/b.jpg'), 'x', 'raw', { contentType: 'image/jpeg' }));
});
