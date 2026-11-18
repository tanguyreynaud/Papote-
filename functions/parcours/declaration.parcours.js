// Déclaration guidée depuis la bulle d'aide de l'appli (declaration.js) : gestes humains côté serveur.
// Double appui arrivé en même temps, nouvel essai après une réponse perdue, garde-fou du jour, compte d'une autre
// famille, e-mail en panne (rien de perdu), lecture et « traitée » dans l'admin, purge après 12 mois.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher } = require('./commun');

brancher();

const EQUIPE = 'contact@mapapote.fr';
// Petit JPEG valable (en-tête FF D8 FF).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 9)]).toString('base64');

async function familleInstallee(proche) {
  const t = await a.tablettePreparee();
  await a.afficherCode(t);
  const fid = await a.installer(proche, t);
  return { fid, t };
}

// Jeton de connexion d'un compte, comme l'appli l'envoie (émulateur Auth).
async function jetonDe(compte) {
  const admin = require('firebase-admin');
  const perso = await admin.auth().createCustomToken(compte.uid);
  const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=cle-de-test`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: perso, returnSecureToken: true }),
  });
  return (await r.json()).idToken;
}

async function declarer(compte, fid, corps, jeton) {
  return s.requete('declarationChat', {
    corps: { famille: fid, ...corps },
    entetes: { authorization: `Bearer ${jeton || await jetonDe(compte)}` },
  });
}

const ecran = (cle) => ({ cle, motif: 'ecran', reponses: [{ question: 'Que s’est-il passé ?', reponse: 'Une chute' }], photos: [JPEG] });
const declarations = async () => (await s.db.collection('declarations').get()).docs;
const mailsEquipe = () => s.boite.filter((m) => m.a === EQUIPE && /^Déclaration/.test(m.sujet));

test('double appui arrivé en même temps, puis nouvel essai : une déclaration, un e-mail, photos rangées une fois', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const { fid } = await familleInstallee(julie);
  const jeton = await jetonDe(julie);
  const [r1, r2] = await Promise.all([declarer(julie, fid, ecran('cle-ecran-000001'), jeton), declarer(julie, fid, ecran('cle-ecran-000001'), jeton)]);
  assert.deepStrictEqual([r1.statut, r2.statut], [200, 200]);
  assert.strictEqual(r1.json.id, r2.json.id);
  const r3 = await declarer(julie, fid, ecran('cle-ecran-000001'), jeton);
  assert.strictEqual(r3.json.id, r1.json.id);
  await s.calme();
  const docs = await declarations();
  assert.strictEqual(docs.length, 1);
  const d = docs[0].data();
  assert.strictEqual(d.fid, fid);
  assert.strictEqual(d.auteur.uid, julie.uid);
  assert.strictEqual(d.auteur.email, 'julie@exemple.fr');
  assert.strictEqual(d.famille, 'Mamie Emma');
  assert.ok(d.tablette, 'état de la tablette noté');
  assert.strictEqual(d.statut, 'nouvelle');
  assert.strictEqual(mailsEquipe().length, 1, 'un seul e-mail à l\'équipe');
  assert.deepStrictEqual(mailsEquipe()[0].pieces, ['photo-1.jpg']);
  assert.strictEqual(s.boite.filter((m) => m.a === 'julie@exemple.fr' && /Bien reçu/.test(m.sujet)).length, 1);
  assert.ok(s.fichiersGardes.includes(`families/${fid}/declarations/${docs[0].id}/photo-1.jpg`));
});

test('refus : pas connecté, compte d\'une autre famille, tablette, photo manquante, motif inconnu', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { fid } = await familleInstallee(julie);
  const sans = await s.requete('declarationChat', { corps: { famille: fid, ...ecran('cle-ecran-000002') } });
  assert.strictEqual(sans.statut, 401);
  const faux = await s.requete('declarationChat', { corps: { famille: fid, ...ecran('cle-ecran-000002') }, entetes: { authorization: 'Bearer pas-un-jeton' } });
  assert.strictEqual(faux.statut, 401);
  assert.strictEqual((await declarer(paul, fid, ecran('cle-ecran-000002'))).statut, 401, 'Paul n\'est pas de la famille');
  const sansPhoto = await declarer(julie, fid, { ...ecran('cle-ecran-000003'), photos: [] });
  assert.strictEqual(sansPhoto.statut, 400);
  assert.match(sansPhoto.json.erreur, /photo/);
  assert.strictEqual((await declarer(julie, fid, { ...ecran('cle-ecran-000004'), motif: 'rembourser' })).statut, 400);
  assert.strictEqual((await declarations()).length, 0);
  assert.strictEqual(mailsEquipe().length, 0);
});

test('garde-fou : 5 demandes par personne et par jour, les autres proches passent toujours', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { fid } = await familleInstallee(julie);
  await a.rejoindre(paul, fid);
  await s.calme();
  const jeton = await jetonDe(julie);
  for (let i = 0; i < 5; i++) {
    assert.strictEqual((await declarer(julie, fid, { cle: `cle-panne-00000${i}`, motif: 'panne', message: `essai ${i}` }, jeton)).statut, 200);
  }
  const trop = await declarer(julie, fid, { cle: 'cle-panne-000009', motif: 'panne', message: 'encore' }, jeton);
  assert.strictEqual(trop.statut, 429);
  assert.match(trop.json.erreur, /contact@mapapote\.fr/);
  // Le même envoi rejoué (même clé) répond toujours « ok » sans compter.
  assert.strictEqual((await declarer(julie, fid, { cle: 'cle-panne-000000', motif: 'panne', message: 'essai 0' }, jeton)).statut, 200);
  assert.strictEqual((await declarer(paul, fid, { cle: 'cle-panne-paul01', motif: 'chargeur', message: 'perdu' })).statut, 200);
  await s.calme();
  assert.strictEqual((await declarations()).length, 6);
});

test('e-mail en panne : la déclaration est quand même gardée pour l\'admin', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const { fid } = await familleInstallee(julie);
  s.reglages.mailsEnPanne = 1;
  const r = await declarer(julie, fid, ecran('cle-ecran-000005'));
  assert.strictEqual(r.statut, 200);
  await s.calme();
  assert.strictEqual((await declarations()).length, 1);
  assert.ok(s.erreurs.some((e) => /e-mail à l'équipe non envoyé/.test(e)), 'l\'échec est signalé');
  s.erreurs.length = 0;
});

test('admin : liste, photo, « traitée » ; refusé sans badge ; purge après 12 mois avec les photos', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const { fid } = await familleInstallee(julie);
  const r = await declarer(julie, fid, ecran('cle-ecran-000006'));
  await s.calme();
  await assert.rejects(s.appeler('gestionDeclarations', { action: 'lister' }, julie), /Réservé/);
  const { declarations: liste } = await s.appeler('gestionDeclarations', { action: 'lister' }, a.TANGUY);
  assert.strictEqual(liste.length, 1);
  assert.strictEqual(liste[0].id, r.json.id);
  assert.strictEqual(typeof liste[0].creeLe, 'number');
  await assert.rejects(s.appeler('gestionDeclarations', { action: 'photo', chemin: 'families/x/media/y.jpg' }, a.TANGUY), /Photo inconnue/);
  // Deux clics sur « Marquer traitée » : même résultat.
  await Promise.all([1, 2].map(() => s.appeler('gestionDeclarations', { action: 'traiter', id: r.json.id, traitee: true }, a.TANGUY)));
  assert.strictEqual((await s.lire(`declarations/${r.json.id}`)).statut, 'traitee');
  await s.appeler('gestionDeclarations', { action: 'traiter', id: r.json.id, traitee: false }, a.TANGUY);
  assert.strictEqual((await s.lire(`declarations/${r.json.id}`)).statut, 'nouvelle');

  // Purge : rien avant 12 mois, tout (photos comprises) après.
  const { purgerDeclarations } = require('../declaration');
  const store = () => require('firebase-admin').storage().bucket();
  assert.strictEqual(await purgerDeclarations(s.db, Date.now() + 300 * 86400e3, store), 0);
  assert.strictEqual(await purgerDeclarations(s.db, Date.now() + 370 * 86400e3, store), 1);
  assert.strictEqual((await declarations()).length, 0);
  assert.ok(s.fichiersEffaces.includes(`families/${fid}/declarations/${r.json.id}/`));
});
