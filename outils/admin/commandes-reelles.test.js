// Garde-fou des outils qui vident la base (audit 12/11, N4) : repartir-des-tests et migrer-europe tournent pour de vrai
// sur l'émulateur Firestore (clé d'administration factice), avec et sans commande payée en clé réelle de Stripe.
// Lancement (depuis functions, qui a firebase-admin) :
//   NODE_PATH=$PWD/node_modules npx firebase-tools@14 emulators:exec --only firestore,auth --project demo-papote
//     --config parcours/firebase.json "node --test ../outils/admin/commandes-reelles.test.js"
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { commandesReelles } = require('./commandes-reelles');

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('À lancer sur l\'émulateur (FIRESTORE_EMULATOR_HOST).');
const PROJET = process.env.GCLOUD_PROJECT || 'demo-papote';
const app = admin.initializeApp({ projectId: PROJET }, 'garde-fou');
const europe = getFirestore(app, 'europe');
const ancienne = getFirestore(app);

// Clé d'administration factice : les outils l'exigent, l'émulateur ne la vérifie pas.
const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'papote-cle-'));
const cle = path.join(dossier, 'cle.json');
fs.writeFileSync(cle, JSON.stringify({
  type: 'service_account', project_id: PROJET, client_email: `outil@${PROJET}.iam.gserviceaccount.com`,
  private_key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
}));

async function vider() {
  for (const base of ['(default)', 'europe']) {
    const r = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJET}/databases/${base}/documents`, { method: 'DELETE' });
    assert.ok(r.ok, `vidage ${base} : ${r.status}`);
  }
}

function lancer(script, args) {
  try {
    const sortie = execFileSync(process.execPath, [path.join(__dirname, script), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
      env: { ...process.env, PAPOTE_CLE_ADMIN: cle, PAPOTE_BASE: 'europe', STRIPE_SECRET: '' },
    });
    return { code: 0, sortie };
  } catch (e) {
    return { code: e.status, sortie: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

async function baseDeTest(db) {
  await db.doc('families/f1').set({ name: 'Mamie Emma' });
  await db.doc('families/f1/members/julie').set({ name: 'Julie', role: 'famille', uid: 'julie' });
  await db.doc('commandes/sub_essai').set({ code: 'ESSAI1', email: 'essai@exemple.fr', expedition: 'envoyee', livemode: false, fid: 'f1' });
}

test.after(async () => {
  await app.delete();
  fs.rmSync(dossier, { recursive: true, force: true });
});

test('commandesReelles : seules les commandes livemode: true comptent (absent ou false = essai)', async () => {
  await vider();
  await baseDeTest(europe);
  await europe.doc('commandes/ancienne').set({ code: 'VIEILLE', email: 'v@exemple.fr' });
  assert.deepStrictEqual(await commandesReelles(europe), []);
  await europe.doc('commandes/sub_vraie').set({ code: 'VRAIE1', email: 'client@exemple.fr', livemode: true });
  assert.deepStrictEqual((await commandesReelles(europe)).map((d) => d.id), ['sub_vraie']);
});

test('repartir-des-tests --oui : refuse s\'il existe une commande payée en clé réelle, rien n\'est effacé', async () => {
  await vider();
  await baseDeTest(europe);
  await europe.doc('commandes/sub_vraie').set({ code: 'VRAIE1', nom: 'Paul Martin', email: 'client@exemple.fr', livemode: true, expedition: 'a-preparer' });
  const r = lancer('repartir-des-tests.js', ['--oui']);
  assert.strictEqual(r.code, 1, r.sortie);
  assert.match(r.sortie, /ARRÊT : repartir-des-tests refuse de tourner/);
  assert.match(r.sortie, /clé réelle de Stripe/);
  assert.match(r.sortie, /VRAIE1 · Paul Martin/);
  assert.match(r.sortie, /Rien n'a été changé/);
  assert.ok((await europe.doc('families/f1').get()).exists, 'famille gardée');
  assert.ok((await europe.doc('families/f1/members/julie').get()).exists, 'membre gardé');
  assert.ok((await europe.doc('commandes/sub_vraie').get()).exists, 'commande gardée');
  assert.ok((await europe.doc('commandes/sub_essai').get()).exists, 'commande d\'essai gardée aussi');
});

test('repartir-des-tests sans commande réelle : tourne comme avant (liste de ce qui serait effacé)', async () => {
  await vider();
  await baseDeTest(europe);
  const r = lancer('repartir-des-tests.js', []);
  assert.strictEqual(r.code, 0, r.sortie);
  assert.match(r.sortie, /Commandes à effacer : 1/);
  assert.match(r.sortie, /Rien n'a été changé. Relancer avec --oui/);
  assert.doesNotMatch(r.sortie, /ARRÊT/);
});

test('migrer-europe --oui : refuse si la base Europe (ou l\'ancienne) a une commande payée en clé réelle, rien n\'est copié', async () => {
  await vider();
  await europe.doc('commandes/sub_vraie').set({ code: 'VRAIE1', email: 'client@exemple.fr', livemode: true });
  await europe.doc('families/f1').set({ name: 'Mamie Emma (à jour)' });
  await ancienne.doc('families/f1').set({ name: 'Mamie Emma (16/10)' });
  const r = lancer('migrer-europe.js', ['--oui']);
  assert.strictEqual(r.code, 1, r.sortie);
  assert.match(r.sortie, /ARRÊT : migrer-europe refuse de tourner. La base « europe »/);
  assert.strictEqual((await europe.doc('families/f1').get()).get('name'), 'Mamie Emma (à jour)', 'base Europe pas réécrite');

  await vider();
  await ancienne.doc('commandes/sub_vraie').set({ code: 'VRAIE2', email: 'client@exemple.fr', livemode: true });
  const r2 = lancer('migrer-europe.js', ['--oui']);
  assert.strictEqual(r2.code, 1, r2.sortie);
  assert.match(r2.sortie, /La base « \(default\) »/);
  assert.ok(!(await europe.doc('commandes/sub_vraie').get()).exists, 'rien copié');
});
