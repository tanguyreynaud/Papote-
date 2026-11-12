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
    // Règles du bucket Europe, lues dans la base de l'émulateur (une seule base ici, « (default) »).
    storage: { rules: fs.readFileSync(path.join(__dirname, '../../storage-eu.rules'), 'utf8').replace(/\/databases\/europe\//g, '/databases/(default)/') },
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

test('fuseau horaire : la tablette remonte son fuseau dans sa fiche, un proche ne peut pas le changer', async () => {
  await famille();
  await assertSucceeds(updateDoc(doc(tablette('tab'), `families/${FID}/members/tab`), { fuseau: 'Europe/Paris' }));
  await assertSucceeds(updateDoc(doc(tablette('tab'), `families/${FID}/members/tab`), { fuseau: 'America/Montreal', appVersion: '2.99.109' }));
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}/members/tab`), { fuseau: 'Europe/Paris' }));
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

// A29 (Tanguy 12/11) : « il ne doit y avoir aucune trace de l'ancien parcours », seul Papote relie une tablette.
// Un responsable ne réclame plus une tablette pour sa famille, la tablette n'accepte plus de réclamation, et un proche
// ne liste plus les réservations faites à son nom. La tablette garde « Recommencer » sur une réservation de Papote.
test('A29 : aucune appli de client ne relie une tablette, même un responsable pour sa propre famille', async () => {
  await famille();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const base = { tabletUid: 'tab9', callsUid: 'tab9-appels', name: 'Tablette', createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 10 * 60 * 1000) };
    await setDoc(doc(db, 'pairings/ATTE2345'), { ...base, status: 'waiting' });
    await setDoc(doc(db, 'pairings/RECL2345'), { ...base, status: 'claimed', fid: FID, familyName: 'Mamie Emma', claimedBy: 'julie', claimedName: 'Julie' });
    await setDoc(doc(db, 'pairings/RESA2345'), { ...base, status: 'reserved', claimedBy: 'julie', claimedName: 'Julie' });
  });
  const julie = proche('julie');
  await assertFails(updateDoc(doc(julie, 'pairings/ATTE2345'), { status: 'claimed', fid: FID, familyName: 'Mamie Emma', claimedBy: 'julie', claimedName: 'Julie' }));
  await assertFails(updateDoc(doc(julie, 'pairings/ATTE2345'), { status: 'confirmed', fid: FID }));
  await assertFails(updateDoc(doc(tablette('tab9'), 'pairings/RECL2345'), { status: 'confirmed' }));
  await assertFails(updateDoc(doc(tablette('tab9'), 'pairings/RECL2345'), { status: 'refused' }));
  await assertFails(getDocs(query(collection(julie, 'pairings'), where('claimedBy', '==', 'julie'))));
  // La tablette, devant soi, peut toujours recommencer une réservation faite par Papote.
  await assertSucceeds(updateDoc(doc(tablette('tab9'), 'pairings/RESA2345'), { status: 'cancelled' }));
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
  // Tablette perdue : verrouiller / déverrouiller, toujours avec le n° de série.
  await assertSucceeds(setDoc(doc(admin(), `families/${FID}/commands/o5`), ordre({ type: 'verrouiller', serie: 'Tab60P15EEA026347' })));
  await assertSucceeds(setDoc(doc(admin(), `families/${FID}/commands/o6`), ordre({ type: 'deverrouiller', serie: 'Tab60P15EEA026347' })));
  await assertFails(setDoc(doc(admin(), `families/${FID}/commands/k0`), ordre({ type: 'verrouiller' })));
  await assertFails(setDoc(doc(proche('julie'), `families/${FID}/commands/k7`), { ...ordre({ type: 'verrouiller', serie: 'X1234' }), createdBy: 'julie' }));
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

test('tableau de bord : « Vu » sur l\'alerte réseau mobile, sur la fiche de la tablette seulement', async () => {
  await famille();
  const vu = (extra) => ({ reseauVu: { niveau: 1, dbm: -112, le: Date.now(), ...extra } });
  await assertSucceeds(updateDoc(doc(admin(), `families/${FID}/members/tab`), vu()));
  await assertSucceeds(updateDoc(doc(admin(), `families/${FID}/members/tab`), vu({ niveau: 3, dbm: null })));
  // La tablette continue d'écrire ses relevés sur sa fiche.
  await assertSucceeds(updateDoc(doc(tablette('tab'), `families/${FID}/members/tab`), { battery: { level: 80, charging: true } }));
  // Rien d'autre sur la fiche, pas sur la fiche d'un proche, pas par un proche, pas de champ en plus.
  await assertFails(updateDoc(doc(admin(), `families/${FID}/members/tab`), { ...vu(), name: 'X' }));
  await assertFails(updateDoc(doc(admin(), `families/${FID}/members/julie`), vu()));
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}/members/tab`), vu()));
  await assertFails(updateDoc(doc(admin(), `families/${FID}/members/tab`), vu({ note: 'x' })));
  await assertFails(updateDoc(doc(admin(), `families/${FID}/members/tab`), vu({ niveau: 'faible' })));
  await assertFails(updateDoc(doc(admin(), `families/${FID}/members/tab`), { reseauVu: 'vu' }));
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

test('installation par QR : jetons et clés de tablette jamais lus ni écrits par une appli, même admin', async () => {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'installations/J'), { serie: null });
    await setDoc(doc(ctx.firestore(), 'clesTablettes/E'), { serie: 'S1' });
  });
  for (const db of [admin(), proche('julie'), tablette('tab'), env.unauthenticatedContext().firestore()]) {
    for (const chemin of ['installations/J', 'clesTablettes/E']) {
      await assertFails(getDoc(doc(db, chemin)));
      await assertFails(setDoc(doc(db, chemin), { serie: 'S2' }));
    }
    await assertFails(getDocs(collection(db, 'installations')));
  }
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
  // Même pour sa propre famille : plus aucune appli ne relie une tablette (A29, voir le test dédié).
  await assertFails(updateDoc(doc(eve, 'pairings/LIBRE123'), { status: 'claimed', fid: FID2, familyName: 'Mamie Rose', claimedBy: 'eve', claimedName: 'Ève' }));
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
  const wifi = (par) => ordre(par, { type: 'wifi', ssid: 'Box', security: 'wpa2' });
  await assertSucceeds(setDoc(doc(proche('paul'), `families/${FID}/commands/w1`), wifi('paul')));
  await assertFails(setDoc(doc(proche('lea'), `families/${FID}/commands/w2`), wifi('lea')));
  await assertFails(setDoc(doc(proche('paul'), `families/${FID}/commands/w3`), wifi('julie')));
  await assertFails(setDoc(doc(proche('eve'), `families/${FID}/commands/w4`), wifi('eve')));
  // La tablette lit et termine ses ordres (le mot de passe disparaît), pas ceux d'une autre tablette.
  await assertSucceeds(getDoc(doc(tablette('tab'), `families/${FID}/commands/w1`)));
  await assertSucceeds(updateDoc(doc(tablette('tab'), `families/${FID}/commands/w1`), { state: 'done', result: 'ok', issue: 'connectee', doneAt: serverTimestamp(), password: deleteField() }));
  await assertFails(updateDoc(doc(tablette('tab'), `families/${FID}/commands/w1`), { state: 'failed', issue: 'peut-etre' }));
  await assertFails(updateDoc(doc(tablette('tab'), `families/${FID}/commands/w1`), { state: 'done', target: 'tab2' }));
  await assertFails(updateDoc(doc(tablette('tab2'), `families/${FID}/commands/o1`), { state: 'done', result: 'x', doneAt: serverTimestamp() }));
  await assertFails(getDoc(doc(tablette('tab2'), `families/${FID}/commands/o1`)));
  // Un ordre visant une autre tablette : elle seule pourrait y répondre, elle ne le lit pas (autre famille).
  await assertSucceeds(setDoc(doc(proche('paul'), `families/${FID}/commands/w5`), { ...wifi('paul'), target: 'tab2' }));
  await assertFails(updateDoc(doc(tablette('tab'), `families/${FID}/commands/w5`), { state: 'done' }));
  await assertSucceeds(deleteDoc(doc(proche('paul'), `families/${FID}/commands/w5`)));
  await assertFails(deleteDoc(doc(proche('lea'), `families/${FID}/commands/w1`)));
});

test('wifi depuis l\'appli (A36) : mot de passe jamais dans l\'ordre, à part, lisible de la seule tablette, expiré', async () => {
  await deuxFamilles();
  const heure = (h) => Timestamp.fromMillis(Date.now() + h * 3_600_000);
  const cmd = (id) => `families/${FID}/commands/${id}`;
  const wifi = (par, extra = {}) => ordre(par, { type: 'wifi', ssid: 'Freebox-Jardin', security: 'wpa2', ...extra });
  const secret = (par, extra = {}) => ({ password: 'bon-mot-de-passe', createdBy: par, expireAt: heure(1), ...extra });
  const envoyer = (db, id, par, extraCmd = {}, extraSecret = {}) => {
    const lot = writeBatch(db);
    lot.set(doc(db, cmd(id)), wifi(par, extraCmd));
    lot.set(doc(db, `${cmd(id)}/secret/wifi`), secret(par, extraSecret));
    return lot.commit();
  };
  // L'ancienne façon (mot de passe dans l'ordre, lisible de tous les responsables) est refusée.
  await assertFails(setDoc(doc(proche('paul'), cmd('v1')), wifi('paul', { password: 'bon-mot-de-passe' })));
  // L'ordre et son secret, ensemble, par un responsable de la famille.
  await assertSucceeds(envoyer(proche('paul'), 's1', 'paul'));
  // Pas un proche sans badge, pas une autre famille, pas au nom d'un autre, pas sur un autre ordre que wifi.
  await assertFails(envoyer(proche('lea'), 's2', 'lea'));
  await assertFails(envoyer(proche('eve'), 's3', 'eve'));
  await assertFails(envoyer(proche('paul'), 's4', 'paul', {}, { createdBy: 'julie' }));
  await assertFails(setDoc(doc(proche('julie'), `${cmd('s1')}/secret/wifi`), secret('julie')));
  await assertSucceeds(setDoc(doc(proche('paul'), cmd('r1')), ordre('paul')));
  await assertFails(setDoc(doc(proche('paul'), `${cmd('r1')}/secret/wifi`), secret('paul')));
  // Autre nom que « wifi », champ en plus, mot de passe trop court ou trop long, expiration absente, passée ou lointaine.
  const lot = (id, nom, extra) => {
    const db = proche('paul');
    const b = writeBatch(db);
    b.set(doc(db, cmd(id)), wifi('paul'));
    b.set(doc(db, `${cmd(id)}/secret/${nom}`), { ...secret('paul'), ...extra });
    return b.commit();
  };
  await assertFails(lot('x1', 'autre', {}));
  await assertFails(lot('x2', 'wifi', { ssid: 'Box' }));
  await assertFails(lot('x3', 'wifi', { password: 'court' }));
  await assertFails(lot('x4', 'wifi', { password: 'x'.repeat(64) }));
  await assertFails(lot('x5', 'wifi', { expireAt: null }));
  await assertFails(lot('x6', 'wifi', { expireAt: heure(-0.1) }));
  await assertFails(lot('x7', 'wifi', { expireAt: heure(3) }));
  // Lisible de la seule tablette visée : ni l'auteur, ni les autres responsables, ni une autre tablette.
  await assertSucceeds(getDoc(doc(tablette('tab'), `${cmd('s1')}/secret/wifi`)));
  await assertFails(getDoc(doc(proche('paul'), `${cmd('s1')}/secret/wifi`)));
  await assertFails(getDoc(doc(proche('julie'), `${cmd('s1')}/secret/wifi`)));
  await assertFails(getDoc(doc(tablette('tab2'), `${cmd('s1')}/secret/wifi`)));
  await assertFails(getDocs(collection(tablette('tab'), `${cmd('s1')}/secret`)));
  await assertFails(updateDoc(doc(proche('paul'), `${cmd('s1')}/secret/wifi`), { password: 'autre-mot-de-passe' }));
  // La tablette prend l'ordre (running, sans mot de passe) et efface le secret dans la même écriture.
  const tab = tablette('tab');
  const prise = writeBatch(tab);
  prise.update(doc(tab, cmd('s1')), { state: 'running', result: 'La tablette essaie « Freebox-Jardin »…' });
  prise.delete(doc(tab, `${cmd('s1')}/secret/wifi`));
  await assertSucceeds(prise.commit());
  await assertSucceeds(updateDoc(doc(tab, cmd('s1')), { state: 'failed', result: 'Mot de passe refusé', issue: 'mot-de-passe', doneAt: serverTimestamp() }));
  // Expiré : plus lisible, même par la tablette (la TTL de Firestore l'efface ensuite).
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), cmd('e1')), { ...wifi('paul'), createdAt: Timestamp.now() });
    await setDoc(doc(ctx.firestore(), `${cmd('e1')}/secret/wifi`), { ...secret('paul'), expireAt: heure(-0.01) });
  });
  await assertFails(getDoc(doc(tablette('tab'), `${cmd('e1')}/secret/wifi`)));
  // L'auteur le retire (fenêtre fermée avant que la tablette le prenne) ; un autre responsable ne peut pas.
  await assertSucceeds(envoyer(proche('paul'), 's5', 'paul'));
  await assertFails(deleteDoc(doc(proche('julie'), `${cmd('s5')}/secret/wifi`)));
  await assertFails(deleteDoc(doc(tablette('tab2'), `${cmd('s5')}/secret/wifi`)));
  await assertSucceeds(deleteDoc(doc(proche('paul'), `${cmd('s5')}/secret/wifi`)));
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

test('règles publiées : base « europe » pour les familles, ancienne base et ancien bucket fermés (audit 8, N3)', () => {
  const conf = JSON.parse(fs.readFileSync(path.join(__dirname, '../../firebase.json'), 'utf8'));
  const regles = Object.fromEntries(conf.firestore.map((b) => [b.database, b.rules]));
  assert.deepStrictEqual(regles, { '(default)': 'firestore-origine.rules', europe: 'firestore.rules' });
  const buckets = Object.fromEntries(conf.storage.map((b) => [b.bucket, b.rules]));
  assert.deepStrictEqual(buckets, { 'papote-famille.firebasestorage.app': 'storage.rules', 'papote-famille-eu': 'storage-eu.rules' });
  const ancien = fs.readFileSync(path.join(__dirname, '../../storage.rules'), 'utf8').replace(/^\/\/.*\n/gm, '');
  assert.match(ancien, /allow read, write: if false;/);
  assert.doesNotMatch(ancien, /if (?!false)/);
  // Le bucket Europe ne lit que la base « europe ».
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../../storage-eu.rules'), 'utf8'), /databases\/\(default\)/);
});

// ---------- Audit 8 (11/11) ----------

test('S4 : famille résiliée, suspendue ou jamais abonnée : plus aucun dépôt dans Storage ; 30 Mo au plus', async () => {
  for (const statut of ['resilie', 'suspendu', 'aucun']) {
    await env.clearFirestore();
    await famille({ statut });
    await assertFails(uploadString(ref(procheStockage('julie'), `families/${FID}/media/${statut}.png`), PNG, 'data_url', { contentType: 'image/png' }));
  }
  await env.clearFirestore();
  await famille({ statut: 'aucun', etape: 'photo' });
  await assertFails(uploadString(ref(procheStockage('julie'), `families/${FID}/media/b.png`), PNG, 'data_url', { contentType: 'image/png' }));
  await env.clearFirestore();
  await famille({ statut: 'installation', etape: 'photo' });
  await assertSucceeds(uploadString(ref(procheStockage('julie'), `families/${FID}/media/c.png`), PNG, 'data_url', { contentType: 'image/png' }));
  await env.clearFirestore();
  await famille();
  await assertSucceeds(uploadString(ref(procheStockage('julie'), `families/${FID}/media/d.mp4`), 'x'.repeat(29 * 1024 * 1024), 'raw', { contentType: 'video/mp4' }));
  await assertFails(uploadString(ref(procheStockage('julie'), `families/${FID}/media/e.mp4`), 'x'.repeat(31 * 1024 * 1024), 'raw', { contentType: 'video/mp4' }));
});

test('R-F2 : installation jamais finie passée « aucun » par le serveur : plus d\'envoi ni d\'appel', async () => {
  await famille({ statut: 'aucun', etape: 'photo' });
  await assertFails(setDoc(doc(proche('julie'), `families/${FID}/posts/p1`), envoi('julie')));
  await assertFails(setDoc(doc(proche('julie'), `families/${FID}/calls/c1`), appel('julie')));
  await env.clearFirestore();
  await famille({ statut: 'installation', etape: 'photo' });
  await assertSucceeds(setDoc(doc(proche('julie'), `families/${FID}/posts/p1`), envoi('julie')));
});

test('R7 : jeton privé seulement « push », dans sa propre famille, champs connus et petits', async () => {
  await famille();
  const julie = proche('julie');
  await assertSucceeds(setDoc(doc(julie, `families/${FID}/members/julie/private/push`), { tokens: ['a'], majLe: serverTimestamp() }, { merge: true }));
  await assertSucceeds(setDoc(doc(julie, `families/${FID}/members/julie/private/push`), { natifs: ['n'], natifsV: 2, majLe: serverTimestamp() }, { merge: true }));
  await assertSucceeds(setDoc(doc(tablette('tab'), `families/${FID}/members/tab/private/push`), { tablette: ['t'], pingDemande: serverTimestamp() }, { merge: true }));
  await assertFails(setDoc(doc(julie, `families/${FID}/members/julie/private/nimporte`), { tokens: ['a'] }));
  await assertFails(setDoc(doc(julie, `families/${FID}/members/julie/private/push`), { gros: 'z'.repeat(1000) }, { merge: true }));
  await assertFails(setDoc(doc(julie, `families/${FID}/members/julie/private/push`), { tokens: Array.from({ length: 21 }, (_, i) => `j${i}`) }, { merge: true }));
  // Compte sans fiche dans la famille, ou famille qui n'existe pas : refusé.
  await assertFails(setDoc(doc(tablette('inconnu'), `families/${FID}/members/inconnu/private/push`), { tablette: ['x'] }));
  await assertFails(setDoc(doc(tablette('inconnu'), 'families/aucune/members/inconnu/private/push'), { tablette: ['x'] }));
});

test('R8 : un jumelage confirmé ne s\'efface plus par un inconnu, même expiré', async () => {
  await famille();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `pairings/${PAIRING}`), { status: 'confirmed', fid: FID, tabletUid: 'tab', callsUid: 'tab-appels', name: 'Tablette', expiresAt: Timestamp.fromMillis(Date.now() - 60e3) });
    await setDoc(doc(ctx.firestore(), 'pairings/VIEU2345'), { status: 'waiting', tabletUid: 'autre', callsUid: 'autre', name: 'T', expiresAt: Timestamp.fromMillis(Date.now() - 60e3) });
  });
  await assertFails(deleteDoc(doc(tablette('inconnu'), `pairings/${PAIRING}`)));
  await assertSucceeds(deleteDoc(doc(tablette('inconnu'), 'pairings/VIEU2345')));
  await assertSucceeds(deleteDoc(doc(tablette('tab'), `pairings/${PAIRING}`)));
});
