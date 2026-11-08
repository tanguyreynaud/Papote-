// Installation d'une tablette par QR code (installation-qr.js) : Tanguy crée le QR dans l'admin (Stock › Installer
// une tablette), la tablette remise à zéro le scanne, Android installe Papote, qui s'inscrit avec le jeton.
// Jeton → inscription → nouvel essai (même tablette) → autre tablette refusée → QR expiré.

const test = require('node:test');
const assert = require('node:assert');
const { createHash } = require('node:crypto');
const s = require('./simulation');
const { brancher } = require('./commun');

brancher();

const TANGUY = { uid: 'tanguy-admin', email: 'tanguy@mapapote.fr', prenom: 'Tanguy', admin: true };
const empreinte = (cle) => createHash('sha256').update(cle).digest('hex');
const EXTRAS = 'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE';
const fichesParSerie = async (serie) => (await s.db.collection('stock').where('serieAndroid', '==', serie).get()).docs;

// Ce que la tablette envoie au premier démarrage, avec le jeton lu dans le QR (aucun compte).
// criteres : comme android/…/Installation.java. Les refus définitifs (la tablette oublie alors le jeton) sont des
// codes 400, 403 ou 404 ; tout le reste est retenté par la tablette.
const CRITERES_OK = { pouces: 10.1, android13: true, camera: true, simPin: false, ok: true, manque: '' };
const inscrire = (jeton, serie, extra = {}) => s.appeler('inscrireTablette', {
  jeton, serie, iccid: '89331500000000000001', modele: 'Tab 60 Pro', android: '14', criteresOk: true, criteres: CRITERES_OK, ...extra,
});
const DEFINITIF = ['invalid-argument', 'permission-denied', 'not-found'];
const refusDefinitif = (motif) => (e) => DEFINITIF.includes(e.code) && motif.test(e.message);

test('QR : jeton, inscription, nouvel essai, autre tablette refusée, expiration', async () => {
  // Réservé à l'administrateur.
  await assert.rejects(s.appeler('jetonInstallation', {}, null), /administrateur/);
  // Un achat de deux tablettes, enregistré avant l'installation.
  await s.appeler('gestionStock', { action: 'ajouter', quantite: 2, prixAchat: 12000, modele: 'Blackview Tab 60 Pro', fournisseur: 'Cdiscount' }, TANGUY);

  const qr = await s.appeler('jetonInstallation', { canal: 'stable' }, TANGUY);
  assert.match(qr.jeton, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(qr.expire > Date.now() + 23 * 3600 * 1000);
  assert.deepStrictEqual(qr.provisionnement[EXTRAS], { papote_jeton: qr.jeton, papote_canal: 'stable' });
  assert.match(qr.provisionnement['android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION'],
    /^https:\/\/raw\.githubusercontent\.com\/tanguyreynaud\/Papote-\/c{40}\/installation\/Papote\.apk$/);
  assert.strictEqual(qr.versionName, '2.99.120');
  const inst = await s.lire(`installations/${qr.jeton}`);
  assert.strictEqual(inst.serie, null);
  assert.strictEqual(inst.creePar, 'tanguy@mapapote.fr');

  // Première inscription : la plus ancienne fiche de l'achat devient la tablette, « Préparée », T-001.
  const r1 = await inscrire(qr.jeton, 'R9TT0001');
  assert.match(r1.appCheckKey, /^[A-Za-z0-9_-]{43}$/);
  assert.strictEqual(r1.ref, 'T-001');
  assert.strictEqual(r1.horsCriteres, false);
  assert.ok(!('code' in r1), 'pas de code tablette sur une fiche neuve');
  const cle1 = await s.lire(`clesTablettes/${empreinte(r1.appCheckKey)}`);
  assert.strictEqual(cle1.serie, 'R9TT0001');
  const [fiche] = await fichesParSerie('R9TT0001');
  assert.strictEqual(fiche.get('etat'), 'preparee');
  assert.strictEqual(fiche.get('prixAchat'), 12000, 'fiche de l\'achat reprise, pas une nouvelle');
  assert.strictEqual(fiche.get('iccid'), '89331500000000000001');
  assert.strictEqual(fiche.get('android'), '14');
  assert.strictEqual(fiche.get('horsCriteres'), null);
  // La clé n'est écrite nulle part dans la base ni dans les journaux.
  const tout = JSON.stringify([await s.lire(`installations/${qr.jeton}`), fiche.data(), s.journal]);
  assert.ok(!tout.includes(r1.appCheckKey), 'clé App Check gardée ou journalisée');

  // Nouvel essai de la même tablette (réponse perdue) : même fiche, même numéro, une clé valable de plus.
  const r2 = await inscrire(qr.jeton, 'R9TT0001');
  assert.strictEqual(r2.ref, 'T-001');
  assert.notStrictEqual(r2.appCheckKey, r1.appCheckKey);
  assert.ok(await s.lire(`clesTablettes/${empreinte(r1.appCheckKey)}`), 'la première clé reste valable');
  assert.ok(await s.lire(`clesTablettes/${empreinte(r2.appCheckKey)}`));
  assert.strictEqual((await fichesParSerie('R9TT0001')).length, 1);
  const enStock = (await s.db.collection('stock').get()).docs.filter((d) => d.get('etat') === 'en-stock');
  assert.strictEqual(enStock.length, 1, 'la deuxième tablette de l\'achat reste libre');
  assert.strictEqual((await s.lire(`installations/${qr.jeton}`)).essais, 2);

  // Une autre tablette avec le même QR : refusée, rien de noté.
  await assert.rejects(inscrire(qr.jeton, 'R9TT0002'), refusDefinitif(/autre tablette/));
  assert.strictEqual((await fichesParSerie('R9TT0002')).length, 0);

  // La clé reçue est bien celle que jetonAppCheck reconnaît (même format, même empreinte ; le jeton App Check
  // lui-même demande un compte Google, pas disponible dans la simulation).
  assert.ok(require('../appcheck').cleValide(r2.appCheckKey));

  // 24 h plus tard : expiré, même pour la bonne tablette.
  s.avancer(1.01);
  await assert.rejects(inscrire(qr.jeton, 'R9TT0001'), refusDefinitif(/expiré/));
  await assert.rejects(inscrire('x'.repeat(32), 'R9TT0001'), refusDefinitif(/inconnu/));
  await assert.rejects(inscrire('court', 'R9TT0001'), refusDefinitif(/Jeton/));
});

test('QR : tablette hors critères notée avec le détail (pas refusée) ; tablette d\'essai à part, pas à vendre', async () => {
  const qr = await s.appeler('jetonInstallation', { canal: 'test' }, TANGUY);
  const detail = ['Android 11', 'carte SIM avec code PIN'];
  const r = await inscrire(qr.jeton, 'VIEILLE01', {
    criteresOk: false, criteres: { pouces: 10.1, android13: false, camera: true, simPin: true, ok: false, manque: 'Android 11 ; carte SIM avec code PIN ; ' },
  });
  assert.strictEqual(r.horsCriteres, true);
  assert.strictEqual(r.canal, 'test');
  const [fiche] = await fichesParSerie('VIEILLE01');
  assert.deepStrictEqual(fiche.get('horsCriteres.detail'), detail);
  assert.strictEqual(fiche.get('simPin'), true);
  assert.match(fiche.get('notes'), /aucun achat/);
  // Hors critères : pas à vendre tant que l'administrateur ne l'a pas gardée.
  const stock = require('../stock');
  assert.strictEqual(await stock.nombreDisponibles(s.db), 0);
  await s.appeler('gestionStock', { action: 'modifier', id: fiche.id, champs: { horsCriteres: null } }, TANGUY);
  assert.strictEqual(await stock.nombreDisponibles(s.db), 1);
  const gardee = await s.lire(`stock/${fiche.id}`);
  assert.deepStrictEqual(gardee.horsCriteresAccepte.detail, detail);
  assert.strictEqual(gardee.simPin, false);

  // Tablette d'essai : fiche à part, sans numéro de carton, jamais à vendre ni complétée par un achat.
  const essai = await s.appeler('jetonInstallation', { essai: true }, TANGUY);
  const re = await inscrire(essai.jeton, 'ESSAI0001');
  assert.strictEqual(re.essai, true);
  assert.strictEqual(re.ref, null);
  const [fe] = await fichesParSerie('ESSAI0001');
  assert.strictEqual(fe.get('essai'), true);
  assert.strictEqual(await stock.nombreDisponibles(s.db), 1);
  await s.appeler('gestionStock', { action: 'ajouter', quantite: 1, prixAchat: 12000, modele: 'Tab 60 Pro', fournisseur: 'Cdiscount' }, TANGUY);
  assert.strictEqual((await s.lire(`stock/${fe.id}`)).prixAchat, null, 'l\'achat ne complète pas la tablette d\'essai');
  // Plusieurs inscriptions en même temps avec le même QR (deux tablettes) : une seule passe.
  const qr2 = await s.appeler('jetonInstallation', {}, TANGUY);
  const resultats = await Promise.allSettled([inscrire(qr2.jeton, 'DUO00001'), inscrire(qr2.jeton, 'DUO00002')]);
  assert.strictEqual(resultats.filter((x) => x.status === 'fulfilled').length, 1);
});

test('QR : pas plus de 20 jetons par heure', async () => {
  for (let i = 0; i < 20; i++) await s.appeler('jetonInstallation', {}, TANGUY);
  await assert.rejects(s.appeler('jetonInstallation', {}, TANGUY), /cette heure-ci/);
  s.avancer(0.05);
  assert.ok((await s.appeler('jetonInstallation', {}, TANGUY)).jeton);
});
