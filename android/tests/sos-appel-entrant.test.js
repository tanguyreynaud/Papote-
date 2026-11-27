// Un proche appelle pendant le décompte de 5 s du SOS (choix de Tanguy, 19/11 : « décrocher l'appel ») :
// par la carte SIM ou par internet, son appel s'affiche normalement et le SOS est annulé proprement : il ne
// part pas (ni appel de la chaîne, ni SMS), rien ne reste noté « décompte », le journal le dit, et après
// l'appel la tablette revient à l'accueil.
// Avant : l'écran « Julie vous appelle » prenait la place du décompte, mais papote.sos restait en phase
// « decompte » (une relance de la page rouvrait un SOS) ; une visio sonnait par-dessus et le SOS partait dessous.
// Lancement : node --test android/tests/
const test = require('node:test');
const assert = require('node:assert');
const { ouvrir, lot } = require('./banc');

const PROCHES = {
  faces: {}, birthdays: [],
  people: [
    { uid: 'julie', name: 'Julie', tel: '0612345678', responsable: false },
    { uid: 'paul', name: 'Paul', tel: '0700000000', responsable: true },
  ],
};
// Julie appelle la tablette (carte SIM).
const JULIE_APPELLE = { sortant: false, numero: '0612345678', uid: 'julie', name: 'Julie' };

// Firebase imité (appels.js réel) pour les appels par internet.
const FAMILLE = {
  firebase: true,
  code: 'ABCD2345',
  base: {
    'invites/ABCD2345': { fid: 'F1', kind: 'tablette' },
    'families/F1': { name: 'Mamie' },
    'families/F1/members/julie': { name: 'Julie', role: 'famille', status: 'active' },
  },
};

async function tablette(etat = {}) {
  const b = await ouvrir('2026-11-19T10:00:00', { telephone: true, ...etat });
  await b.android('onPosts', lot([], { options: { sos: true } }));
  await b.android('onFamily', PROCHES);
  await b.avancer(8000); // l'écran de démarrage s'efface (et le compte des appels entre dans la famille)
  return b;
}

const numeros = async (b) => (await b.appels()).filter((a) => a.nom === 'phoneCall' || a.nom === 'phoneCallSos').map((a) => a.args[0]);
const journal = async (b) => (await b.appels('logAppel')).map((a) => a.args[0]);
const ecran = async (b) => (await b.texte('.call-out')).replace(/\s+/g, ' ').trim();
const sosGarde = (b) => b.page.evaluate(() => JSON.parse(localStorage.getItem('papote.sos') || 'null'));
const decompte = (b) => b.visible('.call-out.sos-countdown');
async function sansErreur(b) {
  const erreurs = (await b.appels('erreurJS')).concat(await b.appels('logError')).map((a) => a.args[0]);
  assert.deepStrictEqual(erreurs, [], 'aucune erreur de la page');
}

// Un appel par internet de Julie (comme l'app famille l'écrit).
async function visioDeJulie(b, id) {
  await b.ecrire(`families/F1/calls/${id}`, {
    callerUid: 'julie', callerName: 'Julie', state: 'ringing', offer: { type: 'offer', sdp: '' }, answer: null,
    createdAt: { __serverTimestamp: true }, endedAt: null,
  });
  await b.avancer(500);
}

async function sosAnnule(b, par) {
  assert.ok(!(await decompte(b)), 'plus de décompte à l’écran');
  assert.strictEqual(await sosGarde(b), null, 'rien gardé pour une reprise (pas de « décompte » bloqué)');
  assert.ok((await journal(b)).some((l) => new RegExp('SOS annulé pendant le décompte : appel entrant de Julie ' + par).test(l)), 'journal');
  await b.avancer(10000); // bien après la fin prévue du décompte
  assert.deepStrictEqual(await numeros(b), [], 'aucun appel de la chaîne du SOS');
  assert.deepStrictEqual(await b.appels('sendSms'), [], 'pas de SMS de SOS');
  assert.strictEqual(await sosGarde(b), null);
}

test('SOS : Julie appelle par la carte SIM pendant le décompte : son appel s’affiche, le SOS est annulé', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(2000);
    await b.android('onGsm', { etat: 'sonne', ...JULIE_APPELLE });
    assert.match(await ecran(b), /Julie\s*vous appelle/, 'écran d’appel normal');
    assert.ok(await b.visible('.call-answer'), '« Décrocher »');
    assert.deepStrictEqual((await b.appels('phoneHangup')), [], 'l’appel n’est pas refusé');
    await sosAnnule(b, 'par téléphone');
    assert.match(await ecran(b), /Julie\s*vous appelle/, 'toujours l’appel de Julie, pas d’écran de SOS');
    // Mamie décroche, parle, Julie raccroche : retour à l'accueil.
    await b.toucher('.call-answer');
    await b.android('onGsm', { etat: 'enLigne', ...JULIE_APPELLE });
    assert.match(await ecran(b), /En ligne avec Julie/);
    await b.avancer(30000);
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...JULIE_APPELLE });
    await b.avancer(4500);
    assert.ok(!(await b.visible('.call-out')), 'retour à l’accueil');
    assert.ok(await b.visible('#view-home'));
    assert.deepStrictEqual(await numeros(b), []);
    assert.strictEqual(await sosGarde(b), null);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS : Julie appelle par internet pendant le décompte : la visio sonne, le SOS est annulé', async () => {
  const b = await tablette(FAMILLE);
  try {
    await b.toucher('#sos-btn');
    await b.avancer(1500);
    await visioDeJulie(b, 'v1');
    assert.ok(await b.visible('#call-ring'), 'la visio de Julie sonne');
    assert.strictEqual(await b.texte('#ring-name'), 'Julie');
    assert.strictEqual((await b.lire('families/F1/calls/v1')).state, 'ringing', 'appel pas refusé');
    assert.ok(!(await b.visible('.call-out')), 'aucun écran de SOS derrière la sonnerie');
    await sosAnnule(b, 'par internet');
    assert.ok(await b.visible('#call-ring'), 'sonne encore');
    // Julie raccroche avant la réponse : accueil.
    await b.ecrire('families/F1/calls/v1', { state: 'ended' });
    await b.avancer(1000);
    assert.ok(!(await b.visible('#call-ring')));
    assert.ok(!(await b.visible('.call-out')));
    assert.deepStrictEqual(await numeros(b), []);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS : appel SIM puis visio pendant le décompte : SOS annulé une fois, aucun appel de la chaîne', async () => {
  const b = await tablette(FAMILLE);
  try {
    await b.toucher('#sos-btn');
    await b.avancer(1000);
    await b.android('onGsm', { etat: 'sonne', ...JULIE_APPELLE });
    await b.android('onGsm', { etat: 'fin', cause: 'manque', ...JULIE_APPELLE });
    await b.avancer(500);
    await visioDeJulie(b, 'v2');
    assert.strictEqual((await journal(b)).filter((l) => /SOS annulé/.test(l)).length, 1, 'une seule annulation notée');
    await sosAnnule(b, 'par téléphone');
    assert.ok(await b.visible('#call-ring'), 'la visio arrivée ensuite sonne normalement');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS : sans appel entrant, le décompte va au bout et la chaîne part (témoin)', async () => {
  const b = await tablette(FAMILLE);
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5100);
    assert.deepStrictEqual(await numeros(b), ['0700000000'], 'Paul (responsable) d’abord');
    assert.strictEqual((await sosGarde(b)).phase, 'tel');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS : le décompte quitte l’écran sans « Annuler » (autre écran d’appel) : plus de « décompte » gardé', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(1000);
    assert.strictEqual((await sosGarde(b)).phase, 'decompte');
    // Android annonce un appel sortant que la page n'a pas lancé (reprise d'écran) : il remplace le décompte.
    await b.android('onGsm', { etat: 'appel', sortant: true, numero: '0612345678', uid: 'julie', name: 'Julie' });
    assert.ok(!(await decompte(b)));
    await b.avancer(1100);
    assert.strictEqual(await sosGarde(b), null, 'le « décompte » gardé est effacé');
    await b.avancer(5000);
    assert.deepStrictEqual(await numeros(b), [], 'pas de SOS parti dans le dos de l’appel affiché');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

// Tanguy, 27/11 (revue des règles) : si l'appel qui a annulé le SOS n'est pas décroché, le SOS repart tout seul.
test('SOS : Julie appelle pendant le décompte, Mamie ne décroche pas : le SOS repart (décompte, puis SMS et appels)', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(2000);
    await b.android('onGsm', { etat: 'sonne', ...JULIE_APPELLE });
    await b.avancer(20000);
    await b.android('onGsm', { etat: 'fin', cause: 'manque', ...JULIE_APPELLE });
    await b.avancer(5000);
    assert.ok(await decompte(b), 'le décompte du SOS est revenu');
    assert.ok((await journal(b)).some((l) => /SOS relancé/.test(l)), 'journal');
    await b.avancer(5500);
    assert.strictEqual((await b.appels('sendSms')).length, 1, 'le SMS du SOS part');
    assert.deepStrictEqual(await numeros(b), ['0700000000'], 'Paul (responsable) appelé');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS : Julie appelle pendant le décompte, Mamie décroche : après l’appel, le SOS ne repart pas', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(2000);
    await b.android('onGsm', { etat: 'sonne', ...JULIE_APPELLE });
    await b.toucher('.call-answer');
    await b.android('onGsm', { etat: 'enLigne', ...JULIE_APPELLE });
    await b.avancer(30000);
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...JULIE_APPELLE });
    await b.avancer(15000);
    assert.ok(!(await decompte(b)), 'pas de décompte');
    assert.deepStrictEqual(await numeros(b), []);
    assert.deepStrictEqual(await b.appels('sendSms'), []);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS relancé après un appel manqué : « Annuler » pendant le nouveau décompte l’arrête pour de bon', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(2000);
    await b.android('onGsm', { etat: 'sonne', ...JULIE_APPELLE });
    await b.android('onGsm', { etat: 'fin', cause: 'manque', ...JULIE_APPELLE });
    await b.avancer(5000);
    assert.ok(await decompte(b));
    await b.toucher('.sos-cancel');
    await b.avancer(20000);
    assert.deepStrictEqual(await numeros(b), []);
    assert.deepStrictEqual(await b.appels('sendSms'), []);
    assert.strictEqual(await sosGarde(b), null);
    await sansErreur(b);
  } finally { await b.fermer(); }
});
