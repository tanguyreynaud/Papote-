// Règles Firestore du parcours client (firestore.rules), vérifiées sur l'émulateur : ce que l'appli
// famille et la tablette ont le droit d'écrire, et ce qui doit être refusé. Rien ne touche la vraie base.
// Lancer : « npm test » dans tests/regles (Java nécessaire pour l'émulateur Firestore).

const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, updateDoc, deleteDoc, getDoc, serverTimestamp, deleteField, Timestamp, setLogLevel } = require('firebase/firestore');

// Les refus attendus (assertFails) ne sont pas des erreurs : pas de journal.
setLogLevel('silent');

const FID = 'famille-emma';
const CODE = 'ABCD2345';
const PAIRING = 'QRST6789';
let env;

// Compte Google ou e-mail vérifié (l'appli famille) ; la tablette a un compte anonyme.
const proche = (uid) => env.authenticatedContext(uid, {
  email: `${uid}@exemple.fr`, email_verified: true, firebase: { sign_in_provider: 'google.com' },
}).firestore();
const tablette = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } }).firestore();

// Famille installée par Julie, tablette jumelée, abonnement actif, n proches.
async function famille({ statut = 'actif', nbProches = 1, etape = 'fini' } = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, `families/${FID}`), {
      name: 'Mamie Emma', code: CODE, createdBy: 'julie', abonnement: { statut }, nbProches,
      installation: { etape, pairing: PAIRING },
    });
    await setDoc(doc(db, `invites/${CODE}`), { fid: FID, createdBy: 'julie' });
    await setDoc(doc(db, `families/${FID}/members/julie`), {
      name: 'Julie', role: 'famille', code: CODE, uid: 'julie', email: 'julie@exemple.fr', status: 'active',
    });
    await setDoc(doc(db, `families/${FID}/members/tab`), { name: 'Tablette', role: 'tablette', pairing: PAIRING });
    await setDoc(doc(db, `pairings/${PAIRING}`), {
      status: 'confirmed', fid: FID, tabletUid: 'tab', callsUid: 'tab-appels', name: 'Tablette',
      expiresAt: Timestamp.fromMillis(Date.now() + 20 * 60 * 1000), claimedBy: 'julie',
    });
  });
}

const fiche = (uid, extra = {}) => ({
  name: 'Paul', role: 'famille', code: CODE, uid, email: `${uid}@exemple.fr`, joinedAt: serverTimestamp(), ...extra,
});
const envoi = (uid, extra = {}) => ({
  type: 'photo', text: '', authorUid: uid, authorName: 'Julie', createdAt: serverTimestamp(), seenAt: null, hearts: 0,
  image: null, imageUrl: 'https://firebasestorage.googleapis.com/v0/b/papote/o/a.jpg', storagePath: `families/${FID}/media/a.jpg`, ...extra,
});

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-papote',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8') },
  });
});
test.after(() => env.cleanup());
test.beforeEach(() => env.clearFirestore());

test('un proche arrivé avec le code famille attend l\'accord d\'un responsable', async () => {
  await famille();
  await assertFails(setDoc(doc(proche('paul'), `families/${FID}/members/paul`), fiche('paul', { status: 'active' })));
  await assertSucceeds(setDoc(doc(proche('paul'), `families/${FID}/members/paul`), fiche('paul', { status: 'pending' })));
  // En attente : il ne peut rien envoyer.
  await assertFails(setDoc(doc(proche('paul'), `families/${FID}/posts/p1`), envoi('paul')));
  await assertSucceeds(updateDoc(doc(proche('julie'), `families/${FID}/members/paul`), { status: 'active' }));
  await assertSucceeds(setDoc(doc(proche('paul'), `families/${FID}/posts/p1`), envoi('paul')));
});

test('un proche invité par e-mail entre directement', async () => {
  await famille();
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), `families/${FID}/invitations/paul@exemple.fr`), {
    email: 'paul@exemple.fr', fid: FID, familyName: 'Mamie Emma',
  }));
  await assertSucceeds(setDoc(doc(proche('paul'), `families/${FID}/members/paul`), fiche('paul', { status: 'active' })));
});

test('le propriétaire met un proche en tête des appels ; un autre responsable non', async () => {
  await famille();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, `families/${FID}`), { admins: ['paul'] }, { merge: true });
    await setDoc(doc(db, `families/${FID}/members/paul`), fiche('paul', { status: 'active' }));
    await setDoc(doc(db, `families/${FID}/members/lea`), fiche('lea', { name: 'Léa', status: 'active' }));
  });
  await assertSucceeds(updateDoc(doc(proche('julie'), `families/${FID}/members/paul`), { enTete: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(proche('julie'), `families/${FID}/members/paul`), { enTete: deleteField() }));
  // Seulement l'heure du serveur, et rien d'autre en même temps.
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}/members/paul`), { enTete: Timestamp.fromMillis(0) }));
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}/members/paul`), { enTete: serverTimestamp(), name: 'Pierre' }));
  // Un responsable qui n'est pas le propriétaire, ou le proche lui-même : refusé.
  await assertFails(updateDoc(doc(proche('paul'), `families/${FID}/members/lea`), { enTete: serverTimestamp() }));
  await assertFails(updateDoc(doc(proche('paul'), `families/${FID}/members/paul`), { enTete: serverTimestamp() }));
  // Pas la tablette.
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}/members/tab`), { enTete: serverTimestamp() }));
});

test('31e proche refusé : ni par invitation, ni par le code, ni accepté par un responsable', async () => {
  await famille({ nbProches: 30 });
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `families/${FID}/invitations/paul@exemple.fr`), { email: 'paul@exemple.fr', fid: FID });
    await setDoc(doc(ctx.firestore(), `families/${FID}/members/marc`), fiche('marc', { status: 'pending' }));
  });
  await assertFails(setDoc(doc(proche('paul'), `families/${FID}/members/paul`), fiche('paul', { status: 'active' })));
  await assertFails(setDoc(doc(proche('lea'), `families/${FID}/members/lea`), fiche('lea', { status: 'pending' })));
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}/members/marc`), { status: 'active' }));
  // Une place se libère (29 proches) : de nouveau possible.
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), `families/${FID}`), { nbProches: 29 }));
  await assertSucceeds(updateDoc(doc(proche('julie'), `families/${FID}/members/marc`), { status: 'active' }));
});

test('la tablette entre dans la famille par son jumelage confirmé, un autre compte non', async () => {
  await famille();
  const membre = { name: 'Tablette', role: 'tablette', pairing: PAIRING, canCall: true, joinedAt: serverTimestamp() };
  await assertSucceeds(setDoc(doc(tablette('tab-appels'), `families/${FID}/members/tab-appels`), membre));
  await assertFails(setDoc(doc(tablette('pirate'), `families/${FID}/members/pirate`), membre));
});

test('la tablette entre encore quelques heures après la confirmation (wifi tombé pendant l\'installation)', async () => {
  await famille();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await deleteDoc(doc(db, `families/${FID}/members/tab`));
    // Code confirmé il y a 5 h (expiresAt = confirmation + 20 min) : la tablette n'a pas pu écrire sa fiche.
    await updateDoc(doc(db, `pairings/${PAIRING}`), { expiresAt: Timestamp.fromMillis(Date.now() - 5 * 3600 * 1000) });
  });
  const membre = { name: 'Tablette', role: 'tablette', pairing: PAIRING, canCall: true, joinedAt: serverTimestamp() };
  await assertSucceeds(setDoc(doc(tablette('tab'), `families/${FID}/members/tab`), membre));
  // Deux jours plus tard, plus d'entrée pour le compte principal (ni pour un autre compte).
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await deleteDoc(doc(db, `families/${FID}/members/tab`));
    await updateDoc(doc(db, `pairings/${PAIRING}`), { expiresAt: Timestamp.fromMillis(Date.now() - 48 * 3600 * 1000) });
  });
  await assertFails(setDoc(doc(tablette('tab'), `families/${FID}/members/tab`), membre));
  await assertFails(setDoc(doc(tablette('pirate'), `families/${FID}/members/pirate`), membre));
});

test('compte des appels de la tablette : revient après l\'expiration du jumelage tant que la tablette est membre', async () => {
  await famille();
  // Jumelage expiré depuis longtemps (réinstallations), la tablette principale est toujours membre.
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), `pairings/${PAIRING}`), {
    expiresAt: Timestamp.fromMillis(Date.now() - 48 * 3600 * 1000),
  }));
  const membre = { name: 'Tablette', role: 'tablette', pairing: PAIRING, canCall: true, joinedAt: serverTimestamp() };
  await assertSucceeds(setDoc(doc(tablette('tab-appels'), `families/${FID}/members/tab-appels`), membre));
  // Pas le compte principal hors délai, ni un autre compte.
  await assertFails(setDoc(doc(tablette('pirate'), `families/${FID}/members/pirate`), membre));
  // Tablette principale retirée de la famille : plus d'entrée possible.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, `families/${FID}/members/tab`), { name: 'Tablette', role: 'tablette', pairing: 'AUTRE1234' });
    await deleteDoc(doc(db, `families/${FID}/members/tab-appels`));
  });
  await assertFails(setDoc(doc(tablette('tab-appels'), `families/${FID}/members/tab-appels`), membre));
});

test('la tablette crée son code ; seul le serveur réserve et confirme', async () => {
  const db = tablette('tab2');
  const code = {
    status: 'waiting', tabletUid: 'tab2', callsUid: 'tab2-appels', name: 'Tablette', serie: 'SERIE1',
    createdAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
  };
  await assertSucceeds(setDoc(doc(db, 'pairings/NEWC0DE2'), code));
  await assertFails(setDoc(doc(db, 'pairings/NEWC0DE3'), { ...code, status: 'reserved' }));
  await assertFails(updateDoc(doc(proche('paul'), 'pairings/NEWC0DE2'), { status: 'reserved', claimedBy: 'paul', claimedName: 'Paul' }));
});

test('envois : autorisés pendant l\'installation et avec un abonnement actif, bloqués une fois résilié', async () => {
  await famille({ statut: 'installation', etape: 'photo' });
  await assertSucceeds(setDoc(doc(proche('julie'), `families/${FID}/posts/p1`), envoi('julie')));
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), `families/${FID}`), {
    abonnement: { statut: 'resilie' }, 'installation.etape': 'fini',
  }));
  await assertFails(setDoc(doc(proche('julie'), `families/${FID}/posts/p2`), envoi('julie')));
  await assertFails(setDoc(doc(proche('julie'), `families/${FID}/posts/m1`), envoi('julie', { type: 'message', text: 'Coucou' })));
});

test('anniversaire : photo facultative en JPEG (data URL), rien d\'autre', async () => {
  await famille();
  const db = proche('julie');
  const anniv = (photo) => ({ name: 'Léo', day: 2, month: 11, year: null, createdBy: 'Julie', createdAt: serverTimestamp(), ...(photo === undefined ? {} : { photo }) });
  await assertSucceeds(setDoc(doc(db, `families/${FID}/birthdays/a1`), anniv()));
  await assertSucceeds(setDoc(doc(db, `families/${FID}/birthdays/a2`), anniv('data:image/jpeg;base64,AAAA')));
  await assertSucceeds(setDoc(doc(db, `families/${FID}/birthdays/a3`), anniv(null)));
  await assertFails(setDoc(doc(db, `families/${FID}/birthdays/a4`), anniv('javascript:alert(1)')));
  await assertFails(setDoc(doc(db, `families/${FID}/birthdays/a5`), anniv('data:image/jpeg;base64,' + 'A'.repeat(200001))));
});

test('envois : un inconnu ne peut ni lire ni écrire ; légende limitée à 60 caractères', async () => {
  await famille();
  await assertFails(getDoc(doc(proche('inconnu'), `families/${FID}`)));
  await assertFails(setDoc(doc(proche('inconnu'), `families/${FID}/posts/p1`), envoi('inconnu')));
  await assertFails(setDoc(doc(proche('julie'), `families/${FID}/posts/p1`), envoi('paul')));
  await assertFails(setDoc(doc(proche('julie'), `families/${FID}/posts/p1`), envoi('julie', { text: 'x'.repeat(61) })));
  await assertSucceeds(setDoc(doc(proche('julie'), `families/${FID}/posts/p1`), envoi('julie', { text: 'Au parc' })));
});

test('appels : la tablette appelle quand l\'abonnement est actif, pas quand il est suspendu', async () => {
  await famille();
  const appel = {
    callerUid: 'tab', callerName: 'Mamie Emma', calleeUid: 'julie', calleeName: 'Julie',
    state: 'ringing', offer: null, answer: null, createdAt: serverTimestamp(), endedAt: null,
  };
  await assertSucceeds(setDoc(doc(tablette('tab'), `families/${FID}/calls/c1`), appel));
  // L'offre arrive ensuite, une seule fois, avec le réseau de la tablette (sim ou wifi, rien d'autre).
  await assertFails(updateDoc(doc(tablette('tab'), `families/${FID}/calls/c1`), { offer: { type: 'offer', sdp: 'x', reseau: '5g' } }));
  await assertFails(updateDoc(doc(tablette('tab'), `families/${FID}/calls/c1`), { offer: { type: 'offer', sdp: 'x', autre: 1 } }));
  await assertSucceeds(updateDoc(doc(tablette('tab'), `families/${FID}/calls/c1`), { offer: { type: 'offer', sdp: 'x', reseau: 'wifi' } }));
  // Forfait SIM entamé : le régime eco, mini ou audio seulement.
  await assertSucceeds(setDoc(doc(tablette('tab'), `families/${FID}/calls/c3`), appel));
  await assertFails(updateDoc(doc(tablette('tab'), `families/${FID}/calls/c3`), { offer: { type: 'offer', sdp: 'x', reseau: 'sim', regime: 'turbo' } }));
  await assertSucceeds(updateDoc(doc(tablette('tab'), `families/${FID}/calls/c3`), { offer: { type: 'offer', sdp: 'x', reseau: 'sim', regime: 'mini' } }));
  await assertFails(updateDoc(doc(tablette('tab'), `families/${FID}/calls/c1`), { offer: { type: 'offer', sdp: 'y' } }));
  await assertSucceeds(updateDoc(doc(proche('julie'), `families/${FID}/calls/c1`), { state: 'accepted', answer: { type: 'answer', sdp: 'x' } }));
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), `families/${FID}`), { abonnement: { statut: 'suspendu' } }));
  await assertFails(setDoc(doc(tablette('tab'), `families/${FID}/calls/c2`), appel));
});

test('commandes et abonnement : jamais écrits par l\'appli', async () => {
  await famille();
  await assertFails(getDoc(doc(proche('julie'), 'commandes/sub_1')));
  await assertFails(setDoc(doc(proche('julie'), 'commandes/sub_1'), { fid: FID }));
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}`), { abonnement: { statut: 'offert' } }));
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}`), { nbProches: 0 }));
});
