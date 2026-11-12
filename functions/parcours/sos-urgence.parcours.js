// A47 (Tanguy 12/11) : le SOS côté serveur.
//   3. Le SOS est lancé par la tablette seule : un appel marqué SOS ('SOS', 'SOS 2') écrit par un proche (les règles
//      Firestore le refusent déjà, tests/regles sur la branche de l'appli) ne fait sonner personne, n'alerte personne
//      et n'envoie aucun e-mail, même s'il se termine sans réponse.
//   5. Les notifications d'un SOS portent urgence = 'sos' (appel du 1er et du 2e essai, alerte « a appuyé sur SOS »),
//      jamais celles d'un appel ordinaire : l'appli Android les affiche en urgence.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher } = require('./commun');

brancher();

const journal = async () => (await s.appeler('gestionDonnees', {}, a.TANGUY)).alertes.map((x) => x.genre).sort();

// Famille offerte installée par Julie, Paul a rejoint : { fid, t, julie, paul }.
async function famille() {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  await a.afficherCode(t);
  const fid = await a.installer(julie, t);
  await s.appeler('gestionFamilleOfferte', { fid, offerte: true }, a.TANGUY);
  await a.rejoindre(paul, fid);
  await s.calme();
  s.notifications.length = 0;
  s.boite.length = 0;
  return { fid, t, julie, paul };
}

test('A47-5 : SOS sans réponse aux deux essais : appels et alerte portent urgence = « sos »', async () => {
  const { fid, t, julie, paul } = await famille();
  const c1 = await a.appelerDepuisLaTablette(t, { sos: 1 });
  const appel1 = s.notifications.filter((n) => n.type === 'appel' && n.cid === c1);
  assert.ok(appel1.length >= 1, 'le 1er essai sonne');
  appel1.forEach((n) => assert.strictEqual(n.urgence, 'sos', 'sonnerie du 1er essai marquée SOS'));
  await s.db.doc(`families/${fid}/calls/${c1}`).update({ state: 'missed' });
  await s.calme();
  const c2 = await a.appelerDepuisLaTablette(t, { sos: 2 });
  const appel2 = s.notifications.filter((n) => n.type === 'appel' && n.cid === c2);
  assert.ok(appel2.length >= 1);
  appel2.forEach((n) => assert.strictEqual(n.urgence, 'sos', 'sonnerie du 2e essai marquée SOS'));
  await s.db.doc(`families/${fid}/calls/${c2}`).update({ state: 'missed' });
  await s.calme();
  const alerte = s.notifications.filter((n) => n.type === 'alerte' && /a appuyé sur SOS/.test(n.titre));
  assert.strictEqual(alerte.length, 1);
  assert.strictEqual(alerte[0].urgence, 'sos', 'alerte « a appuyé sur SOS » marquée');
  assert.deepStrictEqual(alerte[0].uids.sort(), [julie.uid, paul.uid].sort());
  // Les valeurs des données FCM sont des chaînes.
  [...appel1, ...appel2, ...alerte].forEach((n) => assert.strictEqual(typeof n.urgence, 'string'));
});

test('A47-5 : appel ordinaire de la tablette (vers Julie), manqué : aucun marqueur d\'urgence', async () => {
  const { fid, t, julie } = await famille();
  const cid = await a.appelerDepuisLaTablette(t, { vers: julie });
  const sonne = s.notifications.filter((n) => n.cid === cid);
  assert.ok(sonne.some((n) => n.type === 'appel'), 'ça sonne chez Julie');
  await s.db.doc(`families/${fid}/calls/${cid}`).update({ state: 'missed' });
  await s.calme();
  assert.ok(s.notifications.some((n) => n.type === 'manque'), 'appel manqué');
  s.notifications.forEach((n) => assert.ok(!('urgence' in n), `pas d'urgence sur « ${n.type} »`));
  // Appel « toute la famille » ordinaire (bouton Appeler, sans proche choisi) : pas d'urgence non plus.
  const tous = await a.appelerDepuisLaTablette(t, {});
  assert.ok(s.notifications.some((n) => n.type === 'appel' && n.cid === tous));
  s.notifications.forEach((n) => assert.ok(!('urgence' in n)));
});

test('A47-3 : un proche qui écrit lui-même un appel « SOS » (ou « SOS 2 ») : personne ne sonne, aucune alerte, aucun e-mail', async () => {
  const { fid, julie } = await famille();
  for (const calleeName of ['SOS', 'SOS 2']) {
    const ref = s.db.collection(`families/${fid}/calls`).doc();
    await ref.set({
      callerUid: julie.uid, callerName: 'Julie', calleeUid: null, calleeName,
      state: 'ringing', offer: null, answer: null, createdAt: s.FieldValue.serverTimestamp(), endedAt: null,
    });
    await s.calme();
    await ref.update({ state: 'missed' });
    await s.calme();
  }
  assert.deepStrictEqual(s.notifications, [], 'aucune notification');
  assert.deepStrictEqual(s.boite, [], 'aucun e-mail (ni « SOS sans proche », ni « sans téléphone »)');
  assert.deepStrictEqual(await journal(), [], 'rien au journal des alertes');
});
