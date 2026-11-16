// Ménage des données (Tanguy, 12/11 : A14, A25, A26) : menage.js, lancé chaque jour à 10 h avec rappelsJumelage
// (s.tache('rappelsJumelage') : le même créneau de tachesHoraires), et appelsManques à la fin de chaque appel.
//
// L'horloge de la simulation ne décale que Date.now() : les dates posées par l'émulateur (serverTimestamp, dates des
// comptes de connexion) restent à l'heure vraie, donc « vieilles » après s.avancer(91). Un document « récent » est
// écrit avec new Date(Date.now()).

const test = require('node:test');
const assert = require('node:assert');
const admin = require('firebase-admin');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher } = require('./commun');

brancher();

const existe = async (chemin) => (await s.db.doc(chemin).get()).exists;
const maintenant = () => new Date(Date.now());
const menage = () => s.tache('rappelsJumelage');

// Famille offerte installée par Julie (tablette dedans), Paul a rejoint : { fid, t, julie, paul }.
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
  return { fid, t, julie, paul };
}

// Appel de la tablette avec sa description technique (SDP) et ses candidats réseau, comme l'app Android.
async function appelAvecIp(t, vers) {
  const cid = await a.appelerDepuisLaTablette(t, { vers });
  const ref = s.db.doc(`families/${t.fid}/calls/${cid}`);
  await ref.update({ offer: { type: 'offer', sdp: 'v=0\r\nc=IN IP4 192.0.2.10\r\n', reseau: 'wifi' } });
  await ref.collection('callerCandidates').add({ candidate: 'candidate:1 1 udp 2122260223 192.0.2.10 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 });
  await ref.collection('callerCandidates').add({ candidate: 'candidate:2 1 udp 1686052607 203.0.113.7 54321 typ srflx', sdpMid: '0', sdpMLineIndex: 0 });
  await s.calme();
  return { cid, ref };
}

// ---------- A26 : adresses IP effacées à la fin de l'appel ----------

test('appel décroché puis raccroché : SDP et candidats effacés, qui a décroché et le réseau gardés', async () => {
  const { t, paul } = await famille();
  const { cid, ref } = await appelAvecIp(t, paul);
  // Paul décroche (web/js/appel.js, answerIncoming) et envoie ses candidats.
  await ref.update({ state: 'accepted', answer: { type: 'answer', sdp: 'v=0\r\nc=IN IP4 198.51.100.4\r\n', uid: paul.uid, name: 'Paul' } });
  await ref.collection('calleeCandidates').add({ candidate: 'candidate:3 1 udp 2122260223 198.51.100.4 40000 typ host', sdpMid: '0', sdpMLineIndex: 0 });
  await s.calme();
  assert.strictEqual((await ref.collection('calleeCandidates').get()).size, 1, 'pendant l\'appel, rien n\'est effacé');
  assert.ok((await s.lire(ref.path)).answer.sdp, 'pendant l\'appel, la réponse reste');

  await ref.update({ state: 'ended', endedAt: s.FieldValue.serverTimestamp() });
  await s.calme();
  const appel = await s.lire(ref.path);
  assert.deepStrictEqual(appel.offer, { type: 'offer', reseau: 'wifi' }, 'offre sans SDP, réseau gardé');
  assert.deepStrictEqual(appel.answer, { type: 'answer', uid: paul.uid, name: 'Paul' }, 'réponse sans SDP, qui a décroché gardé');
  assert.strictEqual(appel.state, 'ended');
  assert.ok(appel.createdAt && appel.endedAt, 'date et durée gardées');
  assert.strictEqual((await ref.collection('callerCandidates').get()).size, 0);
  assert.strictEqual((await ref.collection('calleeCandidates').get()).size, 0);
  assert.ok(!JSON.stringify(appel).match(/\d+\.\d+\.\d+\.\d+/), 'plus aucune adresse IP dans l\'appel');
  assert.ok(!s.notifications.some((n) => n.type === 'manque' && n.cid === cid), 'pas d\'« appel manqué » pour un appel décroché');
});

test('appel manqué : IP effacées, « Appel manqué » toujours envoyé ; appel de la famille vers la tablette aussi', async () => {
  const { fid, t, julie, paul } = await famille();
  const { cid, ref } = await appelAvecIp(t, paul);
  await ref.update({ state: 'missed', endedAt: s.FieldValue.serverTimestamp() });
  await s.calme();
  assert.ok(s.notifications.some((n) => n.type === 'manque' && n.cid === cid), '« Appel manqué de Mamie » envoyé');
  assert.strictEqual((await s.lire(ref.path)).offer.sdp, undefined);
  assert.strictEqual((await ref.collection('callerCandidates').get()).size, 0);

  // Julie appelle la tablette (web/js/appel.js, startCall), la tablette ne répond pas.
  const sortant = s.db.collection(`families/${fid}/calls`).doc();
  await sortant.set({
    callerUid: julie.uid, callerName: 'Julie', state: 'ringing', offer: { type: 'offer', sdp: 'v=0 192.0.2.99' },
    answer: null, createdAt: s.FieldValue.serverTimestamp(), endedAt: null,
  });
  await sortant.collection('callerCandidates').add({ candidate: 'candidate:9 1 udp 1 192.0.2.99 1 typ host' });
  await s.calme();
  await sortant.update({ state: 'missed', endedAt: s.FieldValue.serverTimestamp() });
  await s.calme();
  assert.deepStrictEqual((await s.lire(sortant.path)).offer, { type: 'offer' });
  assert.strictEqual((await sortant.collection('callerCandidates').get()).size, 0);
});

// ---------- A14 : journaux de plus de 90 jours ----------

test('ménage à 90 jours : vieux appels (et leurs sous-collections), ordres, alertes et incidents effacés ; récents et en cours gardés', async () => {
  const { fid, t, julie, paul } = await famille();
  // Il y a 91 jours (heure vraie de l'émulateur) : un appel manqué, un SOS, un ordre exécuté, un incident.
  const vieil = await appelAvecIp(t, paul);
  await vieil.ref.collection('calleeCandidates').add({ candidate: 'tardif 198.51.100.4' }); // arrivé après la fin
  await vieil.ref.update({ state: 'missed', endedAt: s.FieldValue.serverTimestamp() });
  await s.calme();
  await vieil.ref.collection('calleeCandidates').add({ candidate: 'encore plus tardif' });
  const sos = await a.appelerDepuisLaTablette(t, { sos: 1 });
  await s.db.doc(`families/${fid}/calls/${sos}`).update({ state: 'declined', endedAt: s.FieldValue.serverTimestamp() });
  await s.calme();
  assert.ok(await existe(`families/${fid}/calls/${sos}/prive/refus`), 'jeton de refus posé par la sonnerie');
  // Appel resté « accepted » (téléphone éteint en plein appel) et appel qui sonne encore : jamais effacés.
  const enCours = await a.appelerDepuisLaTablette(t, { vers: julie });
  await s.db.doc(`families/${fid}/calls/${enCours}`).update({ state: 'accepted', answer: { type: 'answer', uid: julie.uid } });
  await s.calme();
  const ordreFait = await s.db.collection(`families/${fid}/commands`).add({ type: 'son', target: t.callsUid, state: 'done', createdAt: s.FieldValue.serverTimestamp() });
  const ordreRate = await s.db.collection(`families/${fid}/commands`).add({ type: 'wifiScan', target: t.tabletUid, state: 'failed', createdAt: s.FieldValue.serverTimestamp() });
  const ordreAttend = await s.db.collection(`families/${fid}/commands`).add({ type: 'verrouiller', target: t.tabletUid, state: 'pending', revoquer: true, createdAt: s.FieldValue.serverTimestamp() });
  await s.appeler('incidentAppel', { cote: 'famille', raison: 'ice', detail: 'vieux' }, julie);
  await s.calme();
  const vieillesAlertes = (await s.db.collection('alertes').get()).docs.map((d) => d.id);
  assert.ok(vieillesAlertes.length >= 2, 'appel manqué et SOS notés');

  s.avancer(91);
  // Aujourd'hui : un appel fini, un ordre exécuté, une alerte et un incident récents ; un appel qui sonne.
  const recent = await s.db.collection(`families/${fid}/calls`).add({
    callerUid: t.callsUid, callerName: 'Mamie Emma', calleeUid: julie.uid, state: 'ended', offer: null, answer: null,
    createdAt: maintenant(), endedAt: maintenant(),
  });
  const sonne = await a.appelerDepuisLaTablette(t, { vers: paul });
  const ordreRecent = await s.db.collection(`families/${fid}/commands`).add({ type: 'son', target: t.callsUid, state: 'done', createdAt: maintenant() });
  const alerteRecente = await s.db.collection('alertes').add({ genre: 'sos', fid, le: maintenant() });
  const incidentRecent = await s.db.collection('incidentsAppels').add({ uid: julie.uid, raison: 'ice', le: maintenant() });
  await s.calme();

  await menage();
  await s.calme();
  const appels = (await s.db.collection(`families/${fid}/calls`).get()).docs.map((d) => d.id).sort();
  assert.deepStrictEqual(appels, [enCours, recent.id, sonne].sort(), 'vieux appels finis effacés, en cours, qui sonne et récent gardés');
  for (const sous of ['callerCandidates', 'calleeCandidates']) {
    assert.strictEqual((await vieil.ref.collection(sous).get()).size, 0, `${sous} de l'appel effacé`);
  }
  assert.ok(!(await existe(`families/${fid}/calls/${sos}/prive/refus`)), 'jeton de refus effacé avec son appel');
  const ordres = (await s.db.collection(`families/${fid}/commands`).get()).docs;
  const ids = ordres.map((d) => d.id);
  assert.ok(ids.includes(ordreAttend.id) && ids.includes(ordreRecent.id), 'ordre qui attend sa tablette et ordre récent gardés');
  assert.ok(![ordreFait.id, ordreRate.id].some((id) => ids.includes(id)), 'vieux ordres exécutés ou refusés effacés');
  // Les autres sont les ordres « pending » de l'installation (test du son), jamais lus par la tablette simulée.
  assert.ok(ordres.every((d) => d.id === ordreRecent.id || d.get('state') === 'pending'));
  assert.deepStrictEqual((await s.db.collection('alertes').get()).docs.map((d) => d.id), [alerteRecente.id]);
  assert.deepStrictEqual((await s.db.collection('incidentsAppels').get()).docs.map((d) => d.id), [incidentRecent.id]);
  assert.ok(await existe(`families/${fid}`), 'la famille elle-même n\'est pas touchée');
  assert.ok(await existe(`families/${fid}/members/${julie.uid}`));

  // Relancé : plus rien à faire, rien d'autre ne part.
  await menage();
  assert.strictEqual((await s.db.collection(`families/${fid}/calls`).get()).size, 3);
});

test('ménage à 90 jours par petits lots : 650 vieux appels effacés en plusieurs lots le même jour', async () => {
  const fid = 'famille-lots';
  await s.db.doc(`families/${fid}`).set({ name: 'Lots' });
  const vieux = new Date(Date.now() - 100 * s.JOUR);
  for (let i = 0; i < 650; i += 325) {
    const lot = s.db.batch();
    for (let j = i; j < Math.min(650, i + 325); j++) {
      lot.set(s.db.doc(`families/${fid}/calls/c${String(j).padStart(4, '0')}`), { state: 'ended', createdAt: vieux, callerUid: 'x' });
    }
    await lot.commit();
  }
  await s.calme();
  const bilan = await require('../menage')._test.menage(s.db, admin.auth());
  assert.strictEqual(bilan.appels, 650);
  assert.strictEqual((await s.db.collection(`families/${fid}/calls`).get()).size, 0);
});

// ---------- A25 : comptes de connexion sans famille depuis plus de 3 mois ----------

test('comptes sans famille depuis plus de 3 mois effacés ; membre, responsable, tablette, admin, commande en cours gardés', async () => {
  const { fid, julie, paul } = await famille();
  const auth = admin.auth();
  const parti = await s.compte('Luc', 'luc@exemple.fr'); // a quitté la famille
  await auth.createUser({ uid: 'anonyme-vieux' }); // compte anonyme de l'appli, jamais entré
  const enAttente = await s.compte('Marc', 'marc@exemple.fr');
  await a.rejoindre(enAttente, fid, { attente: true });
  const responsable = await s.compte('Anne', 'anne@exemple.fr');
  await s.db.doc(`families/${fid}`).update({ admins: s.FieldValue.arrayUnion(responsable.uid) });
  await auth.createUser({ uid: 'tablette-stock', email: 'tablette-abcdef@tablettes.papote-famille.web.app' });
  await auth.createUser({ uid: 'tablette-appels-stock', email: 'tablette-appels-abcdef@tablettes.papote-famille.web.app' });
  await auth.createUser({ uid: 'tanguy-vrai', email: 'tanguy@mapapote.fr' });
  await auth.setCustomUserClaims('tanguy-vrai', { admin: true });
  const acheteur = await s.compte('Zoé', 'zoe@exemple.fr'); // commande payée, tablette pas encore installée
  await s.db.doc('commandes/sub_zoe').set({ email: 'zoe@exemple.fr', expedition: 'envoyee', statutStripe: 'trialing', fid: null });
  const ancienClient = await s.compte('Yves', 'yves@exemple.fr'); // commande annulée
  await s.db.doc('commandes/sub_yves').set({ email: 'yves@exemple.fr', expedition: 'annulee', statutStripe: 'canceled', fid: null });
  await s.calme();

  // Aujourd'hui : tous les comptes sont récents, aucun n'est effacé.
  await menage();
  const tous = async () => (await auth.listUsers(1000)).users.map((u) => u.uid).sort();
  const avant = await tous();
  assert.ok(avant.includes(parti.uid) && avant.includes('anonyme-vieux'), 'compte sans famille de moins de 3 mois gardé');

  s.avancer(91);
  await menage();
  await s.calme();
  const apres = await tous();
  for (const u of [parti.uid, 'anonyme-vieux', ancienClient.uid]) assert.ok(!apres.includes(u), `${u} effacé`);
  for (const u of [julie.uid, paul.uid, enAttente.uid, responsable.uid, 'tablette-stock', 'tablette-appels-stock', 'tanguy-vrai', acheteur.uid]) {
    assert.ok(apres.includes(u), `${u} gardé`);
  }
  assert.strictEqual(apres.length, avant.length - 3);
  assert.ok(await existe(`families/${fid}/members/${julie.uid}`), 'aucune fiche de membre touchée');
});
