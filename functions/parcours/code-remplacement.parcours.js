// Code de tablette de remplacement (audit 8, R2 ; Tanguy 12/11) : préparé par l'admin, valable 7 jours, une seule
// tablette. Ici le côté serveur (gestionCodeRemplacement) ; l'usage unique et l'échéance sont tenus par les règles
// Firestore (tests/regles, branche de l'appli : « code de tablette de remplacement »).

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher } = require('./commun');

brancher();

const FID = 'famille-remplacement';
const JOUR = 24 * 3600 * 1000;

async function famille() {
  await s.db.doc(`families/${FID}`).set({ name: 'Mamie Rose', code: 'FAMI2345', createdBy: 'julie', abonnement: { statut: 'aucun' } });
  await s.db.doc('invites/FAMI2345').set({ fid: FID, createdBy: 'julie' });
}
const code = (action) => s.appeler('gestionCodeRemplacement', { fid: FID, action }, a.TANGUY);

test('code de remplacement : réservé à l\'admin, 7 jours, un seul code au double appui', async () => {
  await famille();
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  await assert.rejects(s.appeler('gestionCodeRemplacement', { fid: FID, action: 'nouveau' }, julie), /administrateur/);
  assert.deepStrictEqual(await code('lire'), { code: null, etat: 'absent' });

  // Double clic : deux appels en même temps, puis un troisième juste après : un seul code.
  const avant = Date.now();
  const [r1, r2] = await Promise.all([code('nouveau'), code('nouveau')]);
  const r3 = await code('nouveau');
  assert.match(r1.code, /^[A-Z0-9]{8}$/);
  assert.strictEqual(r2.code, r1.code);
  assert.strictEqual(r3.code, r1.code);
  assert.strictEqual(r3.deja, true);
  const codes = await s.db.collection('invites').where('fid', '==', FID).where('kind', '==', 'tablette').get();
  assert.strictEqual(codes.size, 1);
  const invite = codes.docs[0].data();
  assert.strictEqual(invite.createdBy, a.TANGUY.uid);
  const duree = invite.expire.toMillis() - invite.creeLe.toMillis();
  assert.strictEqual(duree, 7 * JOUR);
  assert.ok(invite.creeLe.toMillis() >= avant - 1000);
  const lu = await code('lire');
  assert.strictEqual(lu.code, r1.code);
  assert.strictEqual(lu.etat, 'valable');
  assert.strictEqual(lu.expire, invite.expire.toMillis());
  // Le code famille n'est pas touché.
  assert.ok(await s.lire('invites/FAMI2345'));

  // Expiré au bout de 7 jours : l'admin le voit.
  s.avancer(7.01);
  assert.strictEqual((await code('lire')).etat, 'expire');
});

test('nouveau code : l\'ancien libre (et un vieux code sans échéance) ne marche plus, un code déjà pris reste', async () => {
  await famille();
  // Code de tablette d'avant le 12/11 (sans échéance, jamais pris) et code déjà pris par une tablette.
  await s.db.doc('invites/VIEUX234').set({ fid: FID, createdBy: a.TANGUY.uid, kind: 'tablette' });
  await s.db.doc('invites/PRIS2345').set({ fid: FID, createdBy: a.TANGUY.uid, kind: 'tablette', usedBy: 'tab1', callsUid: 'tab1-appels' });
  const r1 = await code('nouveau');
  assert.ok(!await s.lire('invites/VIEUX234'));
  assert.ok(await s.lire('invites/PRIS2345'));

  // Plus d'une minute après : un vrai nouveau code, le premier (libre) est effacé.
  s.avancer(2 / (24 * 60));
  const r2 = await code('nouveau');
  assert.notStrictEqual(r2.code, r1.code);
  assert.strictEqual(r2.deja, false);
  assert.ok(!await s.lire(`invites/${r1.code}`));
  assert.ok(await s.lire(`invites/${r2.code}`));

  // Pris par la tablette (écriture de la tablette, voir firestore.rules) : l'admin voit « utilisé » et quand.
  await s.db.doc(`invites/${r2.code}`).update({ usedBy: 'tab2', callsUid: 'tab2-appels', usedAt: s.Timestamp.fromMillis(Date.now()) });
  const lu = await code('lire');
  assert.strictEqual(lu.etat, 'utilise');
  assert.ok(lu.utiliseLe > 0);
  // Un code pris n'est pas rendu au double appui, et il reste après un nouveau code.
  const r3 = await code('nouveau');
  assert.notStrictEqual(r3.code, r2.code);
  assert.ok(await s.lire(`invites/${r2.code}`));
});

test('famille supprimée : ses codes de tablette et leur suivi partent avec elle', async () => {
  await famille();
  const r = await code('nouveau');
  await s.appeler('gestionSupprimerFamille', { fid: FID, nom: 'Mamie Rose' }, a.TANGUY);
  assert.ok(!await s.lire(`invites/${r.code}`));
  assert.ok(!await s.lire(`codesRemplacement/${FID}`));
  await assert.rejects(code('nouveau'), /introuvable/);
});
