// Garde-fous des règles Firestore que rien ne vérifiait (audit sécurité de la nuit du 19/11) : chaque essai retire
// tour à tour une seule condition de firestore.rules dans sa tête — si quelqu'un l'efface par erreur, il devient rouge.
// Trouvés en retirant une à une les 253 conditions « && … » des règles : 155 ne faisaient échouer aucun essai de
// regles.test.js. Ici les plus sérieuses (qui a le droit), pas les contrôles de forme.
// Lancer : « npm test » dans tests/regles.

const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc, updateDoc, writeBatch, serverTimestamp, Timestamp, setLogLevel, arrayUnion } = require('firebase/firestore');

setLogLevel('silent');

const FID = 'famille-emma';
const CODE = 'ABCD2345';
const PAIRING = 'QRST6789';
let env;

const compte = (uid, jeton) => env.authenticatedContext(uid, jeton).firestore();
const proche = (uid) => compte(uid, { email: `${uid}@exemple.fr`, email_verified: true, firebase: { sign_in_provider: 'google.com' } });
const tablette = (uid) => compte(uid, { firebase: { sign_in_provider: 'anonymous' } });
const sansRegles = (f) => env.withSecurityRulesDisabled((ctx) => f(ctx.firestore()));

// Famille de Julie (propriétaire), Paul proche accepté sans être responsable, tablette jumelée, abonnement actif.
async function famille({ etape = 'fini' } = {}) {
  await sansRegles(async (db) => {
    await setDoc(doc(db, `families/${FID}`), {
      name: 'Mamie Emma', code: CODE, createdBy: 'julie', abonnement: { statut: 'actif' }, nbProches: 2,
      installation: { etape, pairing: PAIRING },
    });
    await setDoc(doc(db, `invites/${CODE}`), { fid: FID, createdBy: 'julie' });
    for (const [uid, name] of [['julie', 'Julie'], ['paul', 'Paul']]) {
      await setDoc(doc(db, `families/${FID}/members/${uid}`), {
        name, role: 'famille', code: CODE, uid, email: `${uid}@exemple.fr`, status: 'active',
      });
    }
    await setDoc(doc(db, `families/${FID}/members/tab`), { name: 'Tablette', role: 'tablette', pairing: PAIRING });
    await setDoc(doc(db, `pairings/${PAIRING}`), {
      status: 'confirmed', fid: FID, tabletUid: 'tab', callsUid: 'tab-appels', name: 'Tablette',
      expiresAt: Timestamp.fromMillis(Date.now() + 20 * 60 * 1000),
    });
  });
}

const fiche = (uid, extra = {}) => ({
  name: 'Zoé', role: 'famille', code: CODE, uid, email: `${uid}@exemple.fr`, joinedAt: serverTimestamp(), status: 'pending', ...extra,
});
const ficheTablette = (extra = {}) => ({ name: 'Tablette', role: 'tablette', joinedAt: serverTimestamp(), canCall: true, ...extra });

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-papote',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '../../firestore.rules'), 'utf8') },
  });
});
test.after(() => env.cleanup());
test.beforeEach(() => env.clearFirestore());

test('entrer avec le code famille : un vrai compte à l\'adresse vérifiée, sa propre fiche, son uid et son adresse', async () => {
  await famille();
  const chemin = `families/${FID}/members/zoe`;
  await assertSucceeds(setDoc(doc(proche('zoe'), chemin), fiche('zoe')));
  await sansRegles((db) => setDoc(doc(db, chemin), {}).then(() => writeBatch(db).delete(doc(db, chemin)).commit()));
  // Compte anonyme qui se donne une adresse, ou adresse jamais vérifiée : refusés.
  await assertFails(setDoc(doc(compte('zoe', { email: 'zoe@exemple.fr', email_verified: true, firebase: { sign_in_provider: 'anonymous' } }), chemin), fiche('zoe')));
  await assertFails(setDoc(doc(compte('zoe', { email: 'zoe@exemple.fr', email_verified: false, firebase: { sign_in_provider: 'password' } }), chemin), fiche('zoe')));
  // La fiche d'un autre (identifiant du document), l'uid ou l'adresse d'un autre dans la fiche : refusés.
  await assertFails(setDoc(doc(proche('zoe'), `families/${FID}/members/victime`), fiche('zoe')));
  await assertFails(setDoc(doc(proche('zoe'), chemin), fiche('zoe', { uid: 'victime' })));
  await assertFails(setDoc(doc(proche('zoe'), chemin), fiche('zoe', { email: 'victime@exemple.fr' })));
});

test('réglages de la famille : un proche accepté qui n\'est pas responsable ne change rien', async () => {
  await famille({ etape: 'photo' });
  const f = (uid) => doc(proche(uid), `families/${FID}`);
  const essais = [
    { name: 'Mamie Rose' },
    { meteoVille: { nom: 'Lyon' }, rev: 1 },
    { volume: 50, rev: 1 },
    { installation: { etape: 'son', pairing: PAIRING } },
    { textSize: 'grande', rev: 1 },
  ];
  for (const e of essais) await assertFails(updateDoc(f('paul'), e));
  for (const e of essais) await assertSucceeds(updateDoc(f('julie'), e));
  // Nouveau code famille (créé dans la même écriture) : un responsable seulement.
  const lot = (uid) => {
    const db = proche(uid);
    const l = writeBatch(db);
    l.set(doc(db, 'invites/WXYZ2345'), { fid: FID, createdBy: uid });
    l.update(doc(db, `families/${FID}`), { code: 'WXYZ2345' });
    return l.commit();
  };
  await assertFails(lot('paul'));
  await assertSucceeds(lot('julie'));
});

test('code famille : créé au nom de celui qui l\'écrit', async () => {
  await famille();
  await assertFails(setDoc(doc(proche('julie'), 'invites/WXYZ2345'), { fid: FID, createdBy: 'paul' }));
  await assertSucceeds(setDoc(doc(proche('julie'), 'invites/WXYZ2345'), { fid: FID, createdBy: 'julie' }));
});

test('jumelage : créé pour son propre compte ; « Recommencer » ne change que le statut', async () => {
  const code = (extra = {}) => ({
    tabletUid: 'tab2', callsUid: 'tab2-appels', name: 'Tablette', status: 'waiting',
    createdAt: serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + 10 * 60 * 1000), ...extra,
  });
  await assertFails(setDoc(doc(tablette('tab2'), 'pairings/AAAA2345'), code({ tabletUid: 'autre' })));
  await assertSucceeds(setDoc(doc(tablette('tab2'), 'pairings/AAAA2345'), code()));
  await sansRegles((db) => updateDoc(doc(db, 'pairings/AAAA2345'), { status: 'reserved', fid: FID }));
  await assertFails(updateDoc(doc(tablette('tab2'), 'pairings/AAAA2345'), { status: 'cancelled', fid: 'autre-famille' }));
  await assertSucceeds(updateDoc(doc(tablette('tab2'), 'pairings/AAAA2345'), { status: 'cancelled' }));
});

test('tablette qui entre par son jumelage : code confirmé, de cette famille, fiche sans statut ni code', async () => {
  await famille();
  const entrer = (extra = {}, fid = FID) => setDoc(doc(tablette('tab2'), `families/${fid}/members/tab2`), ficheTablette({ pairing: 'BBBB2345', ...extra }));
  const poser = (v) => sansRegles((db) => setDoc(doc(db, 'pairings/BBBB2345'), {
    status: 'confirmed', fid: FID, tabletUid: 'tab2', callsUid: 'tab2-appels', name: 'Tablette',
    expiresAt: Timestamp.fromMillis(Date.now() + 10 * 60 * 1000), ...v,
  }));
  // Code seulement réservé, ou confirmé pour une autre famille : refusé.
  await poser({ status: 'reserved' });
  await assertFails(entrer());
  await poser({ fid: 'autre-famille' });
  await assertFails(entrer());
  await poser({});
  // Une tablette ne se déclare pas « en attente » ou « active », et ne porte pas de code famille.
  await assertFails(entrer({ status: 'active' }));
  await assertFails(entrer({ code: CODE }));
  await assertSucceeds(entrer());
});

test('compte des appels qui revient : code confirmé de cette famille, compte principal toujours membre', async () => {
  await famille();
  await sansRegles((db) => updateDoc(doc(db, `pairings/${PAIRING}`), { expiresAt: Timestamp.fromMillis(Date.now() - 48 * 3600 * 1000) }));
  const revenir = (extra = {}) => setDoc(doc(tablette('tab-appels'), `families/${FID}/members/tab-appels`), ficheTablette({ pairing: PAIRING, ...extra }));
  await assertFails(revenir({ status: 'active' }));
  await assertFails(revenir({ code: CODE }));
  // Code fermé (tablette sortie de la famille, functions/tablette-volee.js fermerCodes) : plus de retour.
  await sansRegles((db) => updateDoc(doc(db, `pairings/${PAIRING}`), { status: 'closed' }));
  await assertFails(revenir());
  await sansRegles((db) => updateDoc(doc(db, `pairings/${PAIRING}`), { status: 'confirmed', fid: 'autre-famille' }));
  await assertFails(revenir());
  await sansRegles((db) => updateDoc(doc(db, `pairings/${PAIRING}`), { fid: FID }));
  // Le compte principal n'est plus membre : le compte des appels ne revient pas seul.
  await sansRegles((db) => writeBatch(db).delete(doc(db, `families/${FID}/members/tab`)).commit());
  await assertFails(revenir());
  await sansRegles((db) => setDoc(doc(db, `families/${FID}/members/tab`), { name: 'Tablette', role: 'tablette', pairing: PAIRING }));
  await assertSucceeds(revenir());
});

test('accepter un proche : seulement le passer « active » ; photo et droit d\'appeler sur la bonne fiche', async () => {
  await famille();
  await sansRegles((db) => setDoc(doc(db, `families/${FID}/members/zoe`), { name: 'Zoé', role: 'famille', code: CODE, uid: 'zoe', email: 'zoe@exemple.fr', status: 'pending' }));
  const admin = compte('tanguy', { admin: true });
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}/members/zoe`), { status: 'refuse' }));
  await assertFails(updateDoc(doc(admin, `families/${FID}/members/zoe`), { status: 'refuse' }));
  await assertSucceeds(updateDoc(doc(proche('julie'), `families/${FID}/members/zoe`), { status: 'active' }));
  // Photo choisie par un responsable : celle de la tablette, pas celle d'un proche.
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}/members/paul`), { face: null }));
  await assertSucceeds(updateDoc(doc(proche('julie'), `families/${FID}/members/tab`), { face: null }));
  // Droit d'appeler : donné à un proche, pas à la fiche de la tablette.
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}/members/tab`), { canCall: false }));
  await assertSucceeds(updateDoc(doc(proche('julie'), `families/${FID}/members/paul`), { canCall: true }));
  // « En tête des appels » : le propriétaire pour un autre, pas pour lui-même.
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}/members/julie`), { enTete: serverTimestamp() }));
});

test('invitation par e-mail : pour l\'adresse du document et pour cette famille', async () => {
  await famille();
  const inviter = (extra) => setDoc(doc(proche('julie'), `families/${FID}/invitations/zoe@exemple.fr`), {
    email: 'zoe@exemple.fr', fid: FID, familyName: 'Mamie Emma', invitedBy: 'julie', createdAt: serverTimestamp(), ...extra,
  });
  await assertFails(inviter({ email: 'autre@exemple.fr' }));
  await assertFails(inviter({ fid: 'autre-famille' }));
  await assertSucceeds(inviter({}));
});

// Tanguy, 20/11 : une invitation par e-mail vaut 30 jours.
test('invitation par e-mail : 30 jours, date du serveur seulement, renvoyée par un responsable, jamais périmée pour la famille préparée', async () => {
  await famille();
  const JOUR = 24 * 3600 * 1000;
  const ilYA = (jours) => Timestamp.fromMillis(Date.now() - jours * JOUR);
  const chemin = (email) => `families/${FID}/invitations/${email}`;
  const poser = (email, extra) => sansRegles((db) => setDoc(doc(db, chemin(email)), { email, fid: FID, familyName: 'Mamie Emma', invitedBy: 'julie', ...extra }));
  const entrer = (uid) => {
    const db = proche(uid);
    const lot = writeBatch(db);
    lot.set(doc(db, `families/${FID}/members/${uid}`), fiche(uid, { status: 'active' }));
    lot.delete(doc(db, chemin(`${uid}@exemple.fr`)));
    return lot.commit();
  };
  // 31 jours : n'entre plus. 29 jours : entre. Sans date : n'entre pas.
  await poser('vieux@exemple.fr', { createdAt: ilYA(31) });
  await assertFails(entrer('vieux'));
  await poser('recent@exemple.fr', { createdAt: ilYA(29) });
  await assertSucceeds(entrer('recent'));
  await poser('sansdate@exemple.fr', {});
  await assertFails(entrer('sansdate'));
  // Celle de la famille préparée à la commande (écrite par le serveur) n'expire pas.
  await poser('payeur@exemple.fr', { createdAt: ilYA(200), invitedBy: 'Papote', preparee: true });
  await assertSucceeds(entrer('payeur'));
  // Un responsable ne choisit pas la date (ni ancienne, ni dans un an) et ne pose pas « preparee ».
  const inviter = (extra) => setDoc(doc(proche('julie'), chemin('vieux@exemple.fr')), {
    email: 'vieux@exemple.fr', fid: FID, familyName: 'Mamie Emma', invitedBy: 'julie', createdAt: serverTimestamp(), ...extra,
  });
  await assertFails(inviter({ createdAt: Timestamp.fromMillis(Date.now() + 365 * JOUR) }));
  await assertFails(inviter({ createdAt: ilYA(1) }));
  await assertFails(inviter({ preparee: true }));
  // « Renvoyer » : la même invitation réécrite avec la date du jour ; elle fait de nouveau entrer.
  await assertSucceeds(inviter({}));
  await assertSucceeds(entrer('vieux'));
});

test('envois : « vu » et bisous seulement ; fichier ajouté par l\'auteur de l\'envoi', async () => {
  await famille();
  await sansRegles((db) => setDoc(doc(db, `families/${FID}/posts/p1`), { type: 'message', text: 'Bonjour', authorUid: 'julie', authorName: 'Julie', seenAt: null, hearts: 0 }));
  await assertFails(updateDoc(doc(proche('paul'), `families/${FID}/posts/p1`), { hearts: 1, text: 'Autre texte' }));
  await assertSucceeds(updateDoc(doc(proche('paul'), `families/${FID}/posts/p1`), { hearts: 1, seenAt: serverTimestamp() }));
  await assertFails(setDoc(doc(proche('paul'), `families/${FID}/posts/p1/media/image`), { data: 'x' }));
  await assertSucceeds(setDoc(doc(proche('julie'), `families/${FID}/posts/p1/media/image`), { data: 'x' }));
});

test('ordres à la tablette : créés « en attente » ; la réponse ne porte jamais de mot de passe ; secret au nom de l\'auteur', async () => {
  await famille();
  const ordre = (extra = {}) => ({ type: 'restart', target: 'tab', createdBy: 'julie', createdAt: serverTimestamp(), state: 'pending', ...extra });
  await assertFails(setDoc(doc(proche('julie'), `families/${FID}/commands/c1`), ordre({ state: 'done' })));
  await assertSucceeds(setDoc(doc(proche('julie'), `families/${FID}/commands/c1`), ordre()));
  await assertFails(updateDoc(doc(tablette('tab'), `families/${FID}/commands/c1`), { state: 'done', result: 'ok', password: 'secret123' }));
  await assertSucceeds(updateDoc(doc(tablette('tab'), `families/${FID}/commands/c1`), { state: 'done', result: 'ok' }));
  // Mot de passe du wifi : seulement avec un ordre wifi que l'on vient d'écrire soi-même.
  await sansRegles(async (db) => {
    await updateDoc(doc(db, `families/${FID}`), { admins: ['paul'] });
    await setDoc(doc(db, `families/${FID}/commands/c2`), { type: 'wifi', target: 'tab', createdBy: 'julie', state: 'pending', ssid: 'Maison', security: 'wpa2' });
  });
  const secret = (uid) => setDoc(doc(proche(uid), `families/${FID}/commands/c2/secret/wifi`), {
    password: 'motdepasse', createdBy: uid, expireAt: Timestamp.fromMillis(Date.now() + 3600 * 1000),
  });
  await assertFails(secret('paul'));
  await assertSucceeds(secret('julie'));
});

test('journal de la tablette : écrit par le compte lui-même, membre de la famille', async () => {
  await famille();
  const journal = (ctx, uid) => setDoc(doc(ctx, `families/${FID}/logs/${uid}`), { lines: 'ligne', version: '2.99', updatedAt: serverTimestamp() });
  await assertFails(journal(proche('paul'), 'tab'));
  await assertFails(journal(tablette('inconnue'), 'inconnue'));
  await assertSucceeds(journal(tablette('tab'), 'tab'));
  // Lignes nouvelles seulement (21/11) : ajoutées à « ajouts », « lines » gardé ; au plus 20 morceaux en attente.
  const ajout = (texte) => updateDoc(doc(tablette('tab'), `families/${FID}/logs/tab`), { ajouts: arrayUnion(texte), version: '2.99', updatedAt: serverTimestamp() });
  await assertSucceeds(ajout('nouvelle ligne'));
  await assertFails(updateDoc(doc(proche('julie'), `families/${FID}/logs/tab`), { ajouts: arrayUnion('x'), updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(tablette('tab'), `families/${FID}/logs/tab`), { autre: 1, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(tablette('tab'), `families/${FID}/logs/tab`), { ajouts: Array.from({ length: 21 }, (_, i) => `l${i}`), updatedAt: serverTimestamp() }));
});

test('appels : lancés en son nom et « ringing » ; l\'offre ajoutée par l\'appelant seulement', async () => {
  await famille();
  const appel = (extra = {}) => ({ callerUid: 'julie', callerName: 'Julie', calleeUid: 'tab', calleeName: 'Mamie', state: 'ringing', createdAt: serverTimestamp(), ...extra });
  await assertFails(setDoc(doc(proche('julie'), `families/${FID}/calls/a1`), appel({ callerUid: 'paul' })));
  await assertFails(setDoc(doc(proche('julie'), `families/${FID}/calls/a1`), appel({ state: 'accepted' })));
  await assertSucceeds(setDoc(doc(proche('julie'), `families/${FID}/calls/a1`), appel()));
  await assertFails(updateDoc(doc(proche('paul'), `families/${FID}/calls/a1`), { offer: { type: 'offer', sdp: 'v=0' } }));
  await assertSucceeds(updateDoc(doc(proche('julie'), `families/${FID}/calls/a1`), { offer: { type: 'offer', sdp: 'v=0' } }));
});
