// Règles Firestore (firestore.rules) et Storage (storage.rules), vérifiées sur l'émulateur : ce que l'appli
// famille et la tablette ont le droit d'écrire, et ce qui doit être refusé. Rien ne touche la vraie base.
// Deuxième partie (30/10, inspection « qui peut voir ou modifier quelle famille ») : une autre famille, un proche en
// attente, une invitation réutilisée, un responsable désigné, les ordres à la tablette, les photos dans Storage.
// Lancer : « npm test » dans tests/regles (Java nécessaire pour les émulateurs).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs, collection, collectionGroup, query, where, writeBatch, serverTimestamp, deleteField, Timestamp, setLogLevel } = require('firebase/firestore');
const { ref, uploadString, getBytes, deleteObject } = require('firebase/storage');

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
    storage: { rules: fs.readFileSync(path.join(__dirname, '../../storage.rules'), 'utf8') },
  });
});
test.after(() => env.cleanup());
test.beforeEach(async () => { await env.clearFirestore(); await env.clearStorage(); });

// Mon numéro de téléphone (chantier téléphone 29/10) : écrit par le proche sur sa fiche, à l'inscription ou après.
test('numéro de téléphone du proche : accepté bien formé, refusé sinon', async () => {
  await famille();
  await assertSucceeds(setDoc(doc(proche('paul'), `families/${FID}/members/paul`), fiche('paul', { status: 'pending', telephone: '06 12 34 56 78' })));
  await assertSucceeds(updateDoc(doc(proche('julie'), `families/${FID}/members/julie`), { telephone: '0712345678' }));
  await assertSucceeds(updateDoc(doc(proche('julie'), `families/${FID}/members/julie`), { telephone: null }));
  // Jamais hors forfait : étranger, fixe, « +33 » brut (l'app le réécrit en 06) sont refusés.
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}/members/julie`), { telephone: '+33612345678' }));
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}/members/julie`), { telephone: '+32 470 12 34 56' }));
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}/members/julie`), { telephone: '01 42 00 00 00' }));
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}/members/julie`), { telephone: 'zéro six' }));
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}/members/julie`), { telephone: '06 12 34 56 78 90 12 34 56' }));
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}/members/julie`), { telephone: 12345678 }));
  // Le numéro d'un autre proche n'est pas à moi.
  await assertFails(updateDoc(doc(proche('paul'), `families/${FID}/members/julie`), { telephone: '0612345678' }));
});

test('un proche arrivé avec le code famille attend l\'accord d\'un responsable', async () => {
  await famille();
  await assertFails(setDoc(doc(proche('paul'), `families/${FID}/members/paul`), fiche('paul', { status: 'active' })));
  await assertSucceeds(setDoc(doc(proche('paul'), `families/${FID}/members/paul`), fiche('paul', { status: 'pending' })));
  // En attente : il ne peut rien envoyer.
  await assertFails(setDoc(doc(proche('paul'), `families/${FID}/posts/p1`), envoi('paul')));
  await assertSucceeds(updateDoc(doc(proche('julie'), `families/${FID}/members/paul`), { status: 'active' }));
  await assertSucceeds(setDoc(doc(proche('paul'), `families/${FID}/posts/p1`), envoi('paul')));
});

test('un proche invité par e-mail entre directement, en consommant son invitation', async () => {
  await famille();
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), `families/${FID}/invitations/paul@exemple.fr`), {
    email: 'paul@exemple.fr', fid: FID, familyName: 'Mamie Emma',
  }));
  const paul = proche('paul');
  // L'invitation doit disparaître dans la même écriture (compte.js acceptInvitation, firebase.js joinFamily).
  await assertFails(setDoc(doc(paul, `families/${FID}/members/paul`), fiche('paul', { status: 'active' })));
  const lot = writeBatch(paul);
  lot.set(doc(paul, `families/${FID}/members/paul`), fiche('paul', { status: 'active' }));
  lot.delete(doc(paul, `families/${FID}/invitations/paul@exemple.fr`));
  await assertSucceeds(lot.commit());
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

// Tableau de bord (badge admin) : ordres à la tablette, fiche de membre, journal, volumes.
const admin = (uid = 'tanguy') => env.authenticatedContext(uid, {
  email: `${uid}@exemple.fr`, email_verified: true, admin: true, firebase: { sign_in_provider: 'google.com' },
}).firestore();

test('tableau de bord : ordres à la tablette (redémarrer, état, mise à jour, canal, remise à zéro)', async () => {
  await famille();
  const ordre = (extra) => ({ type: 'restart', target: 'tab', createdBy: 'tanguy', createdAt: serverTimestamp(), state: 'pending', ...extra });
  await assertSucceeds(setDoc(doc(admin(), `families/${FID}/commands/o1`), ordre()));
  await assertSucceeds(setDoc(doc(admin(), `families/${FID}/commands/o2`), ordre({ type: 'maj' })));
  await assertSucceeds(setDoc(doc(admin(), `families/${FID}/commands/o3`), ordre({ type: 'canal', canal: 'test' })));
  await assertSucceeds(setDoc(doc(admin(), `families/${FID}/commands/o4`), ordre({ type: 'usine', serie: 'Tab60P15EEA026347' })));
  // Garde-fous : canal inconnu, remise à zéro sans n° de série, ordre d'un autre, wifi (réservé à la famille), état faux.
  await assertFails(setDoc(doc(admin(), `families/${FID}/commands/k1`), ordre({ type: 'canal', canal: 'beta' })));
  await assertFails(setDoc(doc(admin(), `families/${FID}/commands/k2`), ordre({ type: 'usine' })));
  await assertFails(setDoc(doc(admin(), `families/${FID}/commands/k3`), ordre({ createdBy: 'julie' })));
  await assertFails(setDoc(doc(admin(), `families/${FID}/commands/k4`), ordre({ type: 'wifi', ssid: 'Box', security: 'wpa2', password: 'x' })));
  await assertFails(setDoc(doc(admin(), `families/${FID}/commands/k5`), ordre({ state: 'done' })));
  // Un proche sans badge ne peut pas envoyer « maj » ni « usine » (pas dans sa liste).
  await assertFails(setDoc(doc(proche('julie'), `families/${FID}/commands/k6`), { ...ordre({ type: 'usine', serie: 'X1234' }), createdBy: 'julie' }));
  // La tablette répond : « running » (redémarrage en cours) puis « done » ; l'admin lit et efface.
  await assertSucceeds(updateDoc(doc(tablette('tab'), `families/${FID}/commands/o1`), { state: 'running', result: 'La tablette redémarre…', doneAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(tablette('tab'), `families/${FID}/commands/o1`), { state: 'done', result: 'Revenue en 38 s', doneAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(tablette('tab'), `families/${FID}/commands/o2`), { state: 'bizarre' }));
  await assertSucceeds(getDoc(doc(admin(), `families/${FID}/commands/o1`)));
  await assertSucceeds(deleteDoc(doc(admin(), `families/${FID}/commands/o1`)));
  await assertFails(getDoc(doc(proche('paul'), `families/${FID}/commands/o2`)));
});

test('tableau de bord : fiche de la tablette, journal et volumes', async () => {
  await famille();
  await assertSucceeds(getDoc(doc(admin(), `families/${FID}/members/tab`)));
  await assertFails(getDoc(doc(proche('paul'), `families/${FID}/members/tab`)));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), `families/${FID}/logs/tab`), { lines: 'ok', version: '2.99.99' }));
  await assertSucceeds(getDoc(doc(admin(), `families/${FID}/logs/tab`)));
  await assertFails(getDoc(doc(proche('paul'), `families/${FID}/logs/tab`)));
  await assertSucceeds(updateDoc(doc(admin(), `families/${FID}`), { volume: 70, volumeAppel: 100, volumeSonnerie: 90, rev: 1 }));
  await assertFails(updateDoc(doc(admin(), `families/${FID}`), { volume: 5 }));
  await assertFails(updateDoc(doc(admin(), `families/${FID}`), { volume: 80, name: 'X' }));
});

test('espace Validation : l\'administrateur seul lit et écrit ses choix', async () => {
  const choix = { e: { xabc: { s: 'ok', c: '', h: 'h1', t: 1 } } };
  await assertSucceeds(setDoc(doc(admin(), 'validation/etat'), choix, { merge: true }));
  await assertSucceeds(getDoc(doc(admin(), 'validation/etat')));
  await assertFails(getDoc(doc(proche('julie'), 'validation/etat')));
  await assertFails(setDoc(doc(proche('julie'), 'validation/etat'), choix, { merge: true }));
  await assertFails(getDoc(doc(tablette('tab'), 'validation/etat')));
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'validation/etat')));
});

test('commandes et abonnement : jamais écrits par l\'appli', async () => {
  await famille();
  await assertFails(getDoc(doc(proche('julie'), 'commandes/sub_1')));
  await assertFails(setDoc(doc(proche('julie'), 'commandes/sub_1'), { fid: FID }));
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}`), { abonnement: { statut: 'offert' } }));
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}`), { nbProches: 0 }));
});

// ---------- Qui peut voir ou modifier quelle famille (inspection du 30/10) ----------

const FID2 = 'famille-rose';
// Deuxième famille (Ève et sa tablette), et dans la famille d'Emma : Paul responsable désigné, Léa simple proche,
// Marc arrivé avec le code, en attente.
async function deuxFamilles() {
  await famille();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, `families/${FID}`), { admins: ['paul'] }, { merge: true });
    await setDoc(doc(db, `families/${FID}/members/paul`), fiche('paul', { status: 'active' }));
    await setDoc(doc(db, `families/${FID}/members/lea`), fiche('lea', { name: 'Léa', status: 'active' }));
    await setDoc(doc(db, `families/${FID}/members/marc`), fiche('marc', { name: 'Marc', status: 'pending' }));
    await setDoc(doc(db, `families/${FID}/posts/p1`), { ...envoi('julie'), createdAt: Timestamp.now() });
    await setDoc(doc(db, `families/${FID}/commands/o1`), { type: 'status', target: 'tab', createdBy: 'paul', createdAt: Timestamp.now(), state: 'pending' });
    await setDoc(doc(db, `families/${FID}/logs/tab`), { lines: 'ok', version: '2.99.99' });
    await setDoc(doc(db, `families/${FID}/members/julie/private/push`), { tablette: 'jeton-julie' });
    await setDoc(doc(db, `families/${FID2}`), { name: 'Mamie Rose', code: 'ROSE2345', createdBy: 'eve', abonnement: { statut: 'actif' }, nbProches: 1 });
    await setDoc(doc(db, `invites/ROSE2345`), { fid: FID2, createdBy: 'eve' });
    await setDoc(doc(db, `families/${FID2}/members/eve`), fiche('eve', { name: 'Ève', code: 'ROSE2345', status: 'active' }));
    await setDoc(doc(db, `families/${FID2}/members/tab2`), { name: 'Tablette', role: 'tablette', pairing: 'AUTRE1234' });
  });
}
const ordre = (createdBy, extra = {}) => ({ type: 'restart', target: 'tab', createdBy, createdAt: serverTimestamp(), state: 'pending', ...extra });
const appel = (callerUid) => ({ callerUid, callerName: 'Ève', calleeUid: 'tab', calleeName: 'Tablette', state: 'ringing', offer: null, answer: null, createdAt: serverTimestamp(), endedAt: null });
const rappel = (createdBy) => ({ title: 'Cachet', kind: 'medicament', time: '12:00', repeat: 'daily', createdBy, createdAt: serverTimestamp() });

test('une autre famille : Ève (responsable chez Rose) ne voit ni n\'écrit rien chez Emma', async () => {
  await deuxFamilles();
  const eve = proche('eve');
  await assertFails(getDoc(doc(eve, `families/${FID}`)));
  await assertFails(getDoc(doc(eve, `families/${FID}/posts/p1`)));
  await assertFails(getDocs(collection(eve, `families/${FID}/posts`)));
  await assertFails(getDocs(collection(eve, `families/${FID}/members`)));
  await assertFails(getDoc(doc(eve, `families/${FID}/members/julie`)));
  await assertFails(getDoc(doc(eve, `families/${FID}/logs/tab`)));
  await assertFails(getDoc(doc(eve, `families/${FID}/commands/o1`)));
  await assertFails(getDoc(doc(eve, `families/${FID}/members/julie/private/push`)));
  await assertFails(setDoc(doc(eve, `families/${FID}/posts/p2`), envoi('eve')));
  await assertFails(setDoc(doc(eve, `families/${FID}/reminders/r1`), rappel('eve')));
  await assertFails(setDoc(doc(eve, `families/${FID}/calls/c1`), appel('eve')));
  await assertFails(setDoc(doc(eve, `families/${FID}/commands/o2`), ordre('eve')));
  await assertFails(updateDoc(doc(eve, `families/${FID}`), { veille: { active: true, de: 21, a: 6 }, rev: 2 }));
  await assertFails(updateDoc(doc(eve, `families/${FID}`), { admins: ['eve'] }));
  await assertFails(updateDoc(doc(eve, `families/${FID}`), { name: 'Mamie Ève' }));
  await assertFails(setDoc(doc(eve, `families/${FID}/invitations/ami@exemple.fr`), { email: 'ami@exemple.fr', fid: FID, familyName: 'Mamie Emma', invitedBy: 'Ève', createdAt: serverTimestamp() }));
  await assertFails(deleteDoc(doc(eve, `families/${FID}/members/lea`)));
  await assertFails(updateDoc(doc(eve, `families/${FID}/members/marc`), { status: 'active' }));
  // Ni s'inviter elle-même, ni réclamer la tablette d'Emma pour sa famille, ni lister les codes d'Emma.
  await assertFails(setDoc(doc(eve, `families/${FID}/members/eve`), fiche('eve', { status: 'active' })));
  await assertFails(setDoc(doc(eve, `invites/NOUV3AU2`), { fid: FID, createdBy: 'eve' }));
  await assertFails(getDocs(query(collection(eve, 'invites'), where('fid', '==', FID))));
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'pairings/LIBRE123'), {
    status: 'waiting', tabletUid: 'tab3', callsUid: 'tab3-appels', name: 'Tablette', createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
  }));
  await assertFails(updateDoc(doc(eve, 'pairings/LIBRE123'), { status: 'claimed', fid: FID, familyName: 'Mamie Emma', claimedBy: 'eve', claimedName: 'Ève' }));
  await assertSucceeds(updateDoc(doc(eve, 'pairings/LIBRE123'), { status: 'claimed', fid: FID2, familyName: 'Mamie Rose', claimedBy: 'eve', claimedName: 'Ève' }));
  // La requête « mes familles » (fiches membres qui portent mon uid) ne rend que les siennes.
  const miennes = await assertSucceeds(getDocs(query(collectionGroup(eve, 'members'), where('uid', '==', 'eve'))));
  assert.deepStrictEqual(miennes.docs.map((d) => d.ref.path), [`families/${FID2}/members/eve`]);
  await assertFails(getDocs(query(collectionGroup(eve, 'members'), where('uid', '==', 'julie'))));
  // La tablette de Rose ne lit pas la famille d'Emma et ne répond pas à ses ordres.
  await assertFails(getDoc(doc(tablette('tab2'), `families/${FID}`)));
  await assertFails(updateDoc(doc(tablette('tab2'), `families/${FID}/commands/o1`), { state: 'done', result: 'x', doneAt: serverTimestamp() }));
});

test('un proche en attente ne voit que sa fiche, et ne s\'accepte pas lui-même', async () => {
  await deuxFamilles();
  const marc = proche('marc');
  await assertSucceeds(getDoc(doc(marc, `families/${FID}/members/marc`)));
  await assertFails(getDoc(doc(marc, `families/${FID}`)));
  await assertFails(getDocs(collection(marc, `families/${FID}/posts`)));
  await assertFails(getDocs(collection(marc, `families/${FID}/members`)));
  await assertFails(setDoc(doc(marc, `families/${FID}/posts/p9`), envoi('marc')));
  await assertFails(setDoc(doc(marc, `families/${FID}/calls/c9`), appel('marc')));
  await assertFails(updateDoc(doc(marc, `families/${FID}/members/marc`), { status: 'active' }));
  // Un simple proche (Léa) ne l'accepte pas non plus ; un responsable (Paul) si.
  await assertFails(updateDoc(doc(proche('lea'), `families/${FID}/members/marc`), { status: 'active' }));
  await assertSucceeds(updateDoc(doc(proche('paul'), `families/${FID}/members/marc`), { status: 'active' }));
  await assertSucceeds(getDoc(doc(marc, `families/${FID}`)));
});

test('invitation par e-mail : à l\'adresse invitée seulement, consommée en entrant ; un proche retiré revient en attente', async () => {
  await deuxFamilles();
  const invitation = { email: 'paulo@exemple.fr', fid: FID, familyName: 'Mamie Emma', invitedBy: 'Julie', createdAt: serverTimestamp() };
  await assertSucceeds(setDoc(doc(proche('julie'), `families/${FID}/invitations/paulo@exemple.fr`), invitation));
  // Une autre adresse ne sert pas de l'invitation ; l'adresse invitée voit la sienne (requête « mes invitations »).
  await assertFails(setDoc(doc(proche('lea2'), `families/${FID}/members/lea2`), fiche('lea2', { status: 'active' })));
  await assertFails(getDocs(query(collectionGroup(proche('lea2'), 'invitations'), where('email', '==', 'paulo@exemple.fr'))));
  const miennes = await assertSucceeds(getDocs(query(collectionGroup(proche('paulo'), 'invitations'), where('email', '==', 'paulo@exemple.fr'))));
  assert.strictEqual(miennes.size, 1);
  // Entrer sans consommer l'invitation : refusé (sinon elle resservirait après un départ). Entrer en l'effaçant : accepté.
  const paulo = proche('paulo');
  await assertFails(setDoc(doc(paulo, `families/${FID}/members/paulo`), fiche('paulo', { status: 'active' })));
  const lot = writeBatch(paulo);
  lot.set(doc(paulo, `families/${FID}/members/paulo`), fiche('paulo', { status: 'active' }));
  lot.delete(doc(paulo, `families/${FID}/invitations/paulo@exemple.fr`));
  await assertSucceeds(lot.commit());
  await assertSucceeds(getDoc(doc(paulo, `families/${FID}`)));
  // Retiré par un responsable : plus d'invitation, il ne revient qu'en attente (le code famille), jamais actif tout seul.
  await assertSucceeds(deleteDoc(doc(proche('paul'), `families/${FID}/members/paulo`)));
  await assertFails(getDoc(doc(proche('paulo'), `families/${FID}`)));
  await assertFails(setDoc(doc(proche('paulo'), `families/${FID}/members/paulo`), fiche('paulo', { status: 'active' })));
  await assertSucceeds(setDoc(doc(proche('paulo'), `families/${FID}/members/paulo`), fiche('paulo', { status: 'pending' })));
  await assertFails(getDoc(doc(proche('paulo'), `families/${FID}`)));
});

test('responsables : désignés par un responsable, jamais au détriment du propriétaire ; un proche ne touche pas à la liste', async () => {
  await deuxFamilles();
  await assertSucceeds(updateDoc(doc(proche('paul'), `families/${FID}`), { admins: ['paul', 'lea'] }));
  await assertSucceeds(updateDoc(doc(proche('julie'), `families/${FID}`), { admins: ['paul'] }));
  await assertFails(updateDoc(doc(proche('lea'), `families/${FID}`), { admins: ['lea', 'marc'] }));
  await assertFails(updateDoc(doc(proche('paul'), `families/${FID}`), { createdBy: 'paul' }));
  await assertFails(updateDoc(doc(proche('paul'), `families/${FID}`), { admins: ['paul'], createdBy: 'paul' }));
  // Onze responsables : refusé (dix au plus).
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}`), { admins: Array.from({ length: 11 }, (_, i) => `r${i}`) }));
  // Le propriétaire ne peut être retiré ni par un responsable, ni par Papote, ni partir lui-même.
  await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), `families/${FID}`), { admins: ['paul'] }));
  await assertFails(deleteDoc(doc(proche('paul'), `families/${FID}/members/julie`)));
  await assertFails(deleteDoc(doc(admin(), `families/${FID}/members/julie`)));
  await assertFails(deleteDoc(doc(proche('julie'), `families/${FID}/members/julie`)));
  // Un responsable retire un proche ou refuse une demande ; un proche part de lui-même ; Papote peut aussi retirer.
  await assertSucceeds(deleteDoc(doc(proche('paul'), `families/${FID}/members/marc`)));
  await assertFails(deleteDoc(doc(proche('lea'), `families/${FID}/members/paul`)));
  await assertSucceeds(deleteDoc(doc(proche('lea'), `families/${FID}/members/lea`)));
  await assertSucceeds(deleteDoc(doc(admin(), `families/${FID}/members/paul`)));
  // Papote désigne un nouveau propriétaire (secours), personne d'autre.
  await assertSucceeds(updateDoc(doc(admin(), `families/${FID}`), { createdBy: 'paul', admins: [] }));
  // Les fiches ne changent ni de rôle ni de compte.
  await assertFails(updateDoc(doc(proche('lea'), `families/${FID}/members/lea`), { role: 'tablette' }));
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}/members/julie`), { uid: 'paul' }));
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}/members/julie`), { email: 'autre@exemple.fr' }));
});

test('ordres à la tablette : un responsable de CETTE famille ; la tablette ne répond qu\'aux siens', async () => {
  await deuxFamilles();
  const wifi = (par) => ordre(par, { type: 'wifi', ssid: 'Box', security: 'wpa2', password: 'secret' });
  await assertSucceeds(setDoc(doc(proche('paul'), `families/${FID}/commands/w1`), wifi('paul')));
  await assertFails(setDoc(doc(proche('lea'), `families/${FID}/commands/w2`), wifi('lea')));
  await assertFails(setDoc(doc(proche('paul'), `families/${FID}/commands/w3`), wifi('julie')));
  await assertFails(setDoc(doc(proche('eve'), `families/${FID}/commands/w4`), wifi('eve')));
  // La tablette lit et termine ses ordres (le mot de passe disparaît), pas ceux d'une autre tablette.
  await assertSucceeds(getDoc(doc(tablette('tab'), `families/${FID}/commands/w1`)));
  await assertSucceeds(updateDoc(doc(tablette('tab'), `families/${FID}/commands/w1`), { state: 'done', result: 'ok', doneAt: serverTimestamp(), password: deleteField() }));
  await assertFails(updateDoc(doc(tablette('tab'), `families/${FID}/commands/w1`), { state: 'done', target: 'tab2' }));
  await assertFails(updateDoc(doc(tablette('tab2'), `families/${FID}/commands/o1`), { state: 'done', result: 'x', doneAt: serverTimestamp() }));
  await assertFails(getDoc(doc(tablette('tab2'), `families/${FID}/commands/o1`)));
  // Un ordre visant une autre tablette : elle seule pourrait y répondre, elle ne le lit pas (autre famille).
  await assertSucceeds(setDoc(doc(proche('paul'), `families/${FID}/commands/w5`), { ...wifi('paul'), target: 'tab2' }));
  await assertFails(updateDoc(doc(tablette('tab'), `families/${FID}/commands/w5`), { state: 'done' }));
  await assertSucceeds(deleteDoc(doc(proche('paul'), `families/${FID}/commands/w5`)));
  await assertFails(deleteDoc(doc(proche('lea'), `families/${FID}/commands/w1`)));
});

test('jeton de notification (private) : lisible et modifiable de soi seul', async () => {
  await deuxFamilles();
  await assertSucceeds(getDoc(doc(proche('julie'), `families/${FID}/members/julie/private/push`)));
  await assertSucceeds(setDoc(doc(proche('julie'), `families/${FID}/members/julie/private/push`), { tablette: 'nouveau' }));
  await assertFails(getDoc(doc(proche('paul'), `families/${FID}/members/julie/private/push`)));
  await assertFails(setDoc(doc(proche('paul'), `families/${FID}/members/julie/private/push`), { tablette: 'pirate' }));
  await assertFails(getDoc(doc(admin(), `families/${FID}/members/julie/private/push`)));
  await assertFails(getDoc(doc(tablette('tab'), `families/${FID}/members/julie/private/push`)));
});

test('tablette revenue (fiche retirée par Papote) : elle ne lit plus rien de la famille', async () => {
  await deuxFamilles();
  await assertSucceeds(getDoc(doc(tablette('tab'), `families/${FID}`)));
  await assertSucceeds(deleteDoc(doc(admin(), `families/${FID}/members/tab`)));
  await assertFails(getDoc(doc(tablette('tab'), `families/${FID}`)));
  await assertFails(getDocs(collection(tablette('tab'), `families/${FID}/posts`)));
  await assertFails(setDoc(doc(tablette('tab'), `families/${FID}/calls/c1`), appel('tab')));
  // Papote ne retire pas un proche propriétaire par ce chemin, et un proche simple si.
  await assertFails(deleteDoc(doc(admin(), `families/${FID}/members/julie`)));
  await assertSucceeds(deleteDoc(doc(admin(), `families/${FID}/members/lea`)));
});

test('code d\'installation d\'une tablette : ouvre la famille à une tablette seulement, et à la bonne', async () => {
  await deuxFamilles();
  await assertSucceeds(setDoc(doc(admin(), 'invites/TABL2345'), { fid: FID, createdBy: 'tanguy', kind: 'tablette' }));
  await assertFails(setDoc(doc(proche('eve'), 'invites/TABL2346'), { fid: FID, createdBy: 'eve', kind: 'tablette' }));
  const membre = (code) => ({ name: 'Tablette', role: 'tablette', code, canCall: true, joinedAt: serverTimestamp() });
  await assertSucceeds(setDoc(doc(tablette('tab9'), `families/${FID}/members/tab9`), membre('TABL2345')));
  await assertFails(setDoc(doc(tablette('tab8'), `families/${FID2}/members/tab8`), membre('TABL2345')));
  await assertFails(setDoc(doc(tablette('tab7'), `families/${FID}/members/tab7`), membre(CODE)));
  // Un téléphone avec ce code : ni actif, ni en attente.
  await assertFails(setDoc(doc(proche('x'), `families/${FID}/members/x`), fiche('x', { code: 'TABL2345', status: 'active' })));
  await assertFails(setDoc(doc(proche('x'), `families/${FID}/members/x`), fiche('x', { code: 'TABL2345', status: 'pending' })));
});

// ---------- Storage : photos et vidéos des familles ----------

const stockage = (ctx) => ctx.storage('gs://demo-papote.appspot.com');
const procheStockage = (uid) => stockage(env.authenticatedContext(uid, { email: `${uid}@exemple.fr`, email_verified: true, firebase: { sign_in_provider: 'google.com' } }));
const adminStockage = () => stockage(env.authenticatedContext('tanguy', { email: 'tanguy@exemple.fr', email_verified: true, admin: true, firebase: { sign_in_provider: 'google.com' } }));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('photos (Storage) : les membres de la famille seulement, pas une autre famille ni un proche en attente', async () => {
  await deuxFamilles();
  await env.withSecurityRulesDisabled((ctx) => uploadString(ref(stockage(ctx), `families/${FID}/media/a.png`), PNG, 'data_url', { contentType: 'image/png' }));
  await assertSucceeds(getBytes(ref(procheStockage('lea'), `families/${FID}/media/a.png`)));
  await assertSucceeds(getBytes(ref(adminStockage(), `families/${FID}/media/a.png`)));
  await assertFails(getBytes(ref(procheStockage('eve'), `families/${FID}/media/a.png`)));
  await assertFails(getBytes(ref(procheStockage('marc'), `families/${FID}/media/a.png`)));
  await assertFails(getBytes(ref(procheStockage('inconnu'), `families/${FID}/media/a.png`)));
  await assertSucceeds(uploadString(ref(procheStockage('lea'), `families/${FID}/media/b.png`), PNG, 'data_url', { contentType: 'image/png' }));
  await assertFails(uploadString(ref(procheStockage('eve'), `families/${FID}/media/c.png`), PNG, 'data_url', { contentType: 'image/png' }));
  await assertFails(uploadString(ref(procheStockage('marc'), `families/${FID}/media/d.png`), PNG, 'data_url', { contentType: 'image/png' }));
  // Seulement des images, vidéos et sons ; effacé par un membre, pas par un étranger.
  // (Le remplacement d'un fichier existant, interdit par « allow update: if false », n'est pas vérifiable ici :
  // l'émulateur Storage le traite comme une création.)
  await assertFails(uploadString(ref(procheStockage('lea'), `families/${FID}/media/e.txt`), 'coucou', 'raw', { contentType: 'text/plain' }));
  await assertFails(deleteObject(ref(procheStockage('eve'), `families/${FID}/media/a.png`)));
  await assertSucceeds(deleteObject(ref(procheStockage('lea'), `families/${FID}/media/a.png`)));
  // En dehors du dossier des familles : rien pour personne.
  await assertFails(uploadString(ref(procheStockage('lea'), 'autre/x.png'), PNG, 'data_url', { contentType: 'image/png' }));
});

test('les règles du bucket Europe sont les mêmes, base « europe » au lieu de « (default) »', () => {
  const normale = fs.readFileSync(path.join(__dirname, '../../storage.rules'), 'utf8').replace(/^\/\/.*\n/gm, '');
  const europe = fs.readFileSync(path.join(__dirname, '../../storage-eu.rules'), 'utf8').replace(/^\/\/.*\n/gm, '');
  assert.strictEqual(europe.replace(/\/databases\/europe\//g, '/databases/(default)/'), normale);
});
