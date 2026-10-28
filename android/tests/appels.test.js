// Essais des appels de la tablette (appels.js) sur un Firebase imité (faux-firebase.js) :
// sonnerie, décrocher, raccrocher, appelant disparu, deuxième appel, pause, appel de Mamie, test du son.
// Lancement : node --test android/tests/
const test = require('node:test');
const assert = require('node:assert');
const { ouvrir, lot } = require('./banc');

const FAMILLE = {
  firebase: true,
  code: 'ABCD2345',
  base: {
    'invites/ABCD2345': { fid: 'F1', kind: 'tablette' },
    'families/F1': { name: 'Mamie' },
    'families/F1/members/julie': { name: 'Julie', role: 'famille', status: 'active' },
  },
};
const MOI = 'appels-tablette-appels-essai';

async function tablette(heure) {
  const b = await ouvrir(heure || '2026-10-26T10:00:00', FAMILLE);
  await b.android('onPosts', lot([]));
  await b.avancer(3000); // le compte des appels entre dans la famille
  assert.ok(await b.lire(`families/F1/members/${MOI}`), 'compte des appels dans la famille');
  return b;
}

// Offre WebRTC d'un « téléphone » (créée dans la page, pour qu'elle soit lisible par la tablette).
const offre = (b) => b.page.evaluate(async () => {
  const pc = new RTCPeerConnection();
  pc.addTransceiver('audio');
  pc.addTransceiver('video');
  const o = await pc.createOffer();
  await pc.setLocalDescription(o);
  window.__telephone = pc;
  return { type: o.type, sdp: o.sdp };
});

async function appelEntrant(b, id, champs = {}) {
  const o = champs.offer === undefined ? await offre(b) : champs.offer;
  await b.ecrire(`families/F1/calls/${id}`, {
    callerUid: 'julie', callerName: 'Julie', state: 'ringing', offer: o, answer: null,
    createdAt: { __serverTimestamp: true }, endedAt: null, ...champs, ...(champs.offer === undefined ? { offer: o } : {}),
  });
  await b.avancer(500);
}

test('appel entrant : ça sonne, « Décrocher » répond, la famille raccroche', async () => {
  const b = await tablette();
  try {
    await appelEntrant(b, 'c1');
    assert.ok(await b.visible('#call-ring'), 'écran de sonnerie');
    assert.strictEqual(await b.texte('#ring-name'), 'Julie');
    assert.deepStrictEqual((await b.appels('ring')).map((a) => a.args[0]), [true]);
    await b.toucher('#ring-answer');
    await b.patienter(3000);
    const appel = await b.lire('families/F1/calls/c1');
    assert.strictEqual(appel.state, 'accepted');
    assert.ok(appel.answer && appel.answer.sdp, 'réponse WebRTC écrite');
    assert.ok(await b.visible('#call-view'));
    assert.deepStrictEqual((await b.appels('inCall')).map((a) => a.args[0]), [true]);
    await b.ecrire('families/F1/calls/c1', { ...appel, state: 'ended' });
    await b.patienter(3000);
    assert.ok(!(await b.visible('#call-view')), 'fin de l\'appel');
    assert.deepStrictEqual((await b.appels('inCall')).map((a) => a.args[0]), [true, false]);
  } finally { await b.fermer(); }
});

test('appelant disparu pendant la sonnerie : elle s\'arrête au bout d\'une minute', async () => {
  const b = await tablette();
  try {
    await appelEntrant(b, 'c2');
    assert.ok(await b.visible('#call-ring'));
    await b.avancer(50000);
    assert.ok(await b.visible('#call-ring'), 'sonne encore à 50 s');
    await b.avancer(12000);
    assert.ok(!(await b.visible('#call-ring')), 'plus de sonnerie après 1 min');
    assert.deepStrictEqual((await b.appels('ring')).map((a) => a.args[0]), [true, false]);
    assert.strictEqual((await b.lire('families/F1/calls/c2')).state, 'missed');
  } finally { await b.fermer(); }
});

test('l\'appelant raccroche avant la réponse : la sonnerie s\'arrête tout de suite', async () => {
  const b = await tablette();
  try {
    await appelEntrant(b, 'c3');
    const appel = await b.lire('families/F1/calls/c3');
    await b.ecrire('families/F1/calls/c3', { ...appel, state: 'missed' });
    await b.avancer(500);
    assert.ok(!(await b.visible('#call-ring')));
  } finally { await b.fermer(); }
});

test('réponse impossible (offre illisible) : pas d\'écran bloqué sur « Connexion… »', async () => {
  const b = await tablette();
  try {
    await appelEntrant(b, 'c4', { offer: { type: 'offer', sdp: 'pas une offre' } });
    await b.toucher('#ring-answer');
    await b.patienter(5000);
    assert.ok(!(await b.visible('#call-view')), 'écran d\'appel refermé');
    assert.deepStrictEqual((await b.appels('inCall')).map((a) => a.args[0]), [true, false], 'mode appel quitté');
    assert.strictEqual((await b.lire('families/F1/calls/c4')).state, 'ended');
  } finally { await b.fermer(); }
});

test('deuxième appel pendant une sonnerie : refusé (« pas de réponse » pour lui)', async () => {
  const b = await tablette();
  try {
    await appelEntrant(b, 'c5');
    await appelEntrant(b, 'c6', { callerUid: 'paul', callerName: 'Paul' });
    assert.strictEqual(await b.texte('#ring-name'), 'Julie');
    assert.strictEqual((await b.lire('families/F1/calls/c6')).state, 'missed');
  } finally { await b.fermer(); }
});

test('Papote en pause : aucun appel ne sonne', async () => {
  const b = await tablette();
  try {
    await b.android('onPosts', lot([], { subscription: 'suspendu' }));
    await appelEntrant(b, 'c7');
    assert.ok(!(await b.visible('#call-ring')));
    assert.strictEqual((await b.lire('families/F1/calls/c7')).state, 'missed');
  } finally { await b.fermer(); }
});

test('écoute des appels coupée par une erreur : elle repart, les appels sonnent de nouveau', async () => {
  const b = await tablette();
  try {
    await b.page.evaluate(() => window.__fs.casser('families/F1/calls'));
    await b.avancer(31000);
    await appelEntrant(b, 'c8');
    assert.ok(await b.visible('#call-ring'), 'sonne après la reprise de l\'écoute');
  } finally { await b.fermer(); }
});

test('Mamie appelle Julie : ça sonne chez elle, puis « n\'a pas pu répondre » au bout d\'une minute', async () => {
  const b = await tablette();
  try {
    await b.android('onFamily', { faces: {}, birthdays: [], people: [{ uid: 'julie', name: 'Julie' }] });
    await b.toucher('#view-home .call-btn');
    assert.match(await b.texte('.call-out'), /Qui voulez-vous appeler/);
    await b.page.evaluate(() => [...document.querySelectorAll('.call-person')].find((e) => /Julie/.test(e.textContent)).click());
    await b.patienter(2000);
    const id = (await b.page.evaluate(() => [...window.__fs.docs.keys()].filter((k) => /^families\/F1\/calls\/[^/]+$/.test(k))))[0];
    const appel = await b.lire(id);
    assert.strictEqual(appel.calleeUid, 'julie');
    assert.strictEqual(appel.state, 'ringing');
    assert.ok(appel.offer && appel.offer.sdp, 'offre écrite');
    assert.match(await b.texte('.call-out'), /Ça sonne/);
    await b.avancer(60000);
    assert.match(await b.texte('.call-out'), /Julie n’a pas pu répondre/);
    assert.strictEqual((await b.lire(id)).state, 'missed');
  } finally { await b.fermer(); }
});

test('test du son demandé par le téléphone du proche : la tablette joue, puis répond « fait »', async () => {
  const b = await tablette();
  try {
    await b.ecrire('families/F1/commands/s1', { type: 'son', quoi: 'sonnerie', volume: 60, target: MOI, state: 'pending', createdAt: { __serverTimestamp: true } });
    await b.avancer(500);
    assert.deepStrictEqual((await b.appels('testSon')).map((a) => a.args.slice(0, 2)), [['sonnerie', 60]]);
    assert.strictEqual((await b.lire('families/F1/commands/s1')).state, 'done');
  } finally { await b.fermer(); }
});

// Garde-fou du forfait SIM (Forfait.java, pont simBudget) : la tablette est sur la carte SIM.
const SUR_SIM = { wifi: '', internet: true, mobile: true, sim: true, via: 'mobile' };

test('forfait SIM à 60 % : la visio continue en qualité réduite, « regime: eco » écrit pour le proche', async () => {
  const b = await tablette();
  try {
    await b.etat({ reseau: SUR_SIM, forfait: { plafondMo: 1000, consoMo: 650, niveau: 1, sim: true } });
    await appelEntrant(b, 'c1');
    await b.toucher('#ring-answer');
    await b.patienter(3000);
    const appel = await b.lire('families/F1/calls/c1');
    assert.strictEqual(appel.state, 'accepted');
    assert.strictEqual(appel.answer.reseau, 'sim');
    assert.strictEqual(appel.answer.regime, 'eco');
    assert.ok(appel.answer.sdp.includes('b=AS:150'), 'vidéo du proche demandée à 150 kbit/s');
    assert.ok(!appel.answer.sdp.includes('b=AS:500'));
    const lignes = appel.answer.sdp.split('\r\n');
    const video = lignes.findIndex((l) => l.startsWith('m=video'));
    assert.ok(lignes.slice(video).includes('a=sendrecv'), 'la vidéo passe toujours dans les deux sens');
  } finally { await b.fermer(); }
});

test('forfait SIM à 85 % : appel sans image (voie vidéo fermée), « regime: audio » écrit pour le proche', async () => {
  const b = await tablette();
  try {
    await b.etat({ reseau: SUR_SIM, forfait: { plafondMo: 1000, consoMo: 880, niveau: 2, sim: true } });
    await appelEntrant(b, 'c1');
    await b.toucher('#ring-answer');
    await b.patienter(3000);
    const appel = await b.lire('families/F1/calls/c1');
    assert.strictEqual(appel.state, 'accepted');
    assert.strictEqual(appel.answer.regime, 'audio');
    const lignes = appel.answer.sdp.split('\r\n');
    const video = lignes.findIndex((l) => l.startsWith('m=video'));
    assert.ok(video > 0, 'section vidéo présente dans la réponse');
    assert.ok(lignes.slice(video).includes('a=inactive'), 'voie vidéo fermée dans les deux sens');
    assert.ok(lignes.slice(0, video).includes('a=sendrecv'), 'le son passe');
    assert.strictEqual(await b.texte('#call-status'), 'Appel sans image');
    assert.ok(await b.visible('#call-view'));
  } finally { await b.fermer(); }
});

test('forfait SIM à 85 % mais tablette en Wi-Fi : rien ne change, visio pleine qualité', async () => {
  const b = await tablette();
  try {
    await b.etat({ forfait: { plafondMo: 1000, consoMo: 880, niveau: 2, sim: false } });
    await appelEntrant(b, 'c1');
    await b.toucher('#ring-answer');
    await b.patienter(3000);
    const appel = await b.lire('families/F1/calls/c1');
    assert.strictEqual(appel.answer.reseau, 'wifi');
    assert.strictEqual(appel.answer.regime, undefined);
    assert.ok(!appel.answer.sdp.includes('b=AS:'), 'réception sans plafond');
  } finally { await b.fermer(); }
});

// Réveil par le serveur (Push.java, functions/reveil.js) : pushReady() vrai = aucune écoute ouverte.
const ecoutes = (b) => b.page.evaluate(() => window.__fs.ecoutes.size);

test('réveil par le serveur : aucune écoute ouverte ; un push « appel » fait sonner, l\'appelant qui raccroche arrête la sonnerie', async () => {
  const b = await ouvrir('2026-10-26T10:00:00', { ...FAMILLE, push: true });
  try {
    await b.android('onPosts', lot([]));
    await b.avancer(3000);
    assert.strictEqual(await ecoutes(b), 0, 'pas d\'écoute Firestore ouverte');
    await appelEntrant(b, 'c1');
    await b.avancer(2000);
    assert.ok(!(await b.visible('#call-ring')), 'sans réveil, la tablette ne sait rien de l\'appel');
    await b.page.evaluate(() => window.Papote.onPush({ type: 'appel', id: 'c1' }));
    await b.avancer(500);
    assert.ok(await b.visible('#call-ring'), 'le réveil fait sonner');
    assert.strictEqual(await ecoutes(b), 1, 'cet appel-là est suivi le temps de la sonnerie');
    const appel = await b.lire('families/F1/calls/c1');
    await b.ecrire('families/F1/calls/c1', { ...appel, state: 'ended' });
    await b.avancer(500);
    assert.ok(!(await b.visible('#call-ring')), 'l\'appelant a raccroché : plus de sonnerie');
    assert.strictEqual(await ecoutes(b), 0, 'et plus rien d\'ouvert');
  } finally { await b.fermer(); }
});

test('réveil par le serveur : un push « ordre » joue le test du son demandé', async () => {
  const b = await ouvrir('2026-10-26T10:00:00', { ...FAMILLE, push: true });
  try {
    await b.android('onPosts', lot([]));
    await b.avancer(3000);
    const moi = await b.page.evaluate(() => window.__fs.lire(`families/F1/members/${'appels-tablette-appels-essai'}`) && 'appels-tablette-appels-essai');
    await b.ecrire('families/F1/commands/o1', { type: 'son', quoi: 'sonnerie', volume: 70, target: moi, state: 'pending', createdAt: { __serverTimestamp: true } });
    await b.avancer(2000);
    assert.strictEqual((await b.appels('testSon')).length, 0, 'rien sans réveil');
    await b.page.evaluate(() => window.Papote.onPush({ type: 'ordre', id: 'o1' }));
    await b.avancer(500);
    assert.deepStrictEqual((await b.appels('testSon')).map((a) => a.args.slice(0, 2)), [['sonnerie', 70]]);
    assert.strictEqual((await b.lire('families/F1/commands/o1')).state, 'done');
    await b.page.evaluate(() => window.Papote.onPush({ type: 'ordre', id: 'o1' }));
    await b.avancer(500);
    assert.strictEqual((await b.appels('testSon')).length, 1, 'un ordre déjà fait n\'est pas rejoué');
  } finally { await b.fermer(); }
});

test('jeton push écrit après le démarrage : les écoutes se ferment toutes seules', async () => {
  const b = await tablette();
  try {
    assert.ok((await ecoutes(b)) >= 3, 'écoutes en direct au départ (appels, famille, ordres, version)');
    await b.etat({ push: true });
    await b.avancer(16_000);
    assert.strictEqual(await ecoutes(b), 0, 'réveil par le serveur disponible : plus d\'écoute');
    await appelEntrant(b, 'c1');
    await b.page.evaluate(() => window.Papote.onPush({ type: 'appel', id: 'c1' }));
    await b.avancer(500);
    assert.ok(await b.visible('#call-ring'));
  } finally { await b.fermer(); }
});
