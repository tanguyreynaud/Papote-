// Carte « Julie a essayé de vous appeler à 10 h 01 » (A49, OUI de Tanguy 12/11) : à la place de la météo,
// sans bouton, jamais le mot « manqué ». Elle s'en va au premier de : un toucher sur la carte, un appel abouti
// avec cette personne (sortant ou entrant, téléphone ou visio), la veille du soir / 21 h ; jamais le lendemain ;
// elle survit à une relance de Papote.
// Lancement : node --test android/tests/
const test = require('node:test');
const assert = require('node:assert');
const { ouvrir, lot } = require('./banc');

const PROCHES = {
  faces: {}, birthdays: [],
  people: [
    { uid: 'julie', name: 'Julie', tel: '0612345678', responsable: false },
    { uid: 'paul', name: 'Paul', tel: '0700000000', responsable: true },
    { uid: 'marc', name: 'Marc', tel: '0611111111', responsable: false },
  ],
};
const JULIE = { numero: '0612345678', uid: 'julie', name: 'Julie' };
const PAUL = { numero: '0700000000', uid: 'paul', name: 'Paul' };
const MARC = { numero: '0611111111', uid: 'marc', name: 'Marc' };
const METEO = {
  current: { weather_code: 0, is_day: 1, temperature_2m: 14 },
  daily: { weather_code: [0, 3], temperature_2m_max: [16, 15], temperature_2m_min: [8, 7] },
};

async function donnees(b, champs) {
  await b.android('onPosts', lot([], champs));
  await b.android('onFamily', PROCHES);
  await b.android('onWeather', METEO).catch(() => {});
}

async function tablette(heure = '2026-10-26T10:00:00', champs = {}) {
  const b = await ouvrir(heure, { telephone: true });
  await donnees(b, champs);
  await b.avancer(8000);
  return b;
}

// Un proche appelle par la carte SIM, personne ne décroche (il raccroche).
async function sonneSansReponse(b, p) {
  await b.android('onGsm', { etat: 'sonne', sortant: false, ...p });
  await b.avancer(20000);
  await b.android('onGsm', { etat: 'fin', cause: 'manque', sortant: false, ...p });
  await b.avancer(5000); // « Julie a appelé » 4 s, puis l'accueil
}

const carte = async (b) => (await b.visible('#essai-appel')) ? (await b.texte('#essai-appel')).replace(/\s+/g, ' ').trim() : '';
const meteoVisible = (b) => b.page.evaluate(() => { const w = document.getElementById('weather'); return !!w && w.getClientRects().length > 0; });
async function sansErreur(b) {
  const erreurs = (await b.appels('erreurJS')).concat(await b.appels('logError'));
  assert.deepStrictEqual(erreurs, [], 'erreurs JavaScript');
}

test('A49 : Julie appelle, personne ne décroche : la carte à la place de la météo, sans « manqué » ; un toucher l’enlève', async () => {
  const b = await tablette();
  try {
    assert.ok(await meteoVisible(b), 'météo avant');
    await b.avancer(40000); // 10 h 00 min 48
    await sonneSansReponse(b, JULIE); // fin à 10 h 01
    assert.strictEqual(await carte(b), 'Julie a essayé de vous appeler à 10 h 01');
    assert.doesNotMatch(await b.texte('#essai-appel'), /manqu/i);
    assert.strictEqual(await b.page.evaluate(() => document.querySelectorAll('#essai-appel button').length), 0, 'pas de bouton');
    assert.ok(!(await meteoVisible(b)), 'la météo laisse la place');
    assert.ok(await b.visible('#sos-btn') && await b.visible('#view-home .call-btn'), 'SOS et Appeler toujours là');
    const couleur = await b.page.evaluate(() => getComputedStyle(document.querySelector('#essai-appel')).backgroundColor);
    assert.strictEqual(couleur, 'rgb(238, 242, 255)', 'fond indigo pâle #eef2ff');
    await b.toucher('#essai-appel');
    assert.strictEqual(await carte(b), '', 'touchée : partie');
    assert.ok(await meteoVisible(b), 'la météo revient');
    await b.page.reload();
    await donnees(b);
    await b.avancer(3000);
    assert.strictEqual(await carte(b), '', 'ne revient pas après une relance');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A49 : la carte survit à une relance de Papote', async () => {
  const b = await tablette();
  try {
    await sonneSansReponse(b, JULIE);
    const avant = await carte(b);
    assert.match(avant, /^Julie a essayé de vous appeler à 10 h 00$/);
    await b.page.reload();
    await donnees(b);
    await b.avancer(3000);
    assert.strictEqual(await carte(b), avant, 'même carte après la relance');
    assert.ok(!(await meteoVisible(b)));
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A49 : Mamie rappelle Julie par téléphone et Julie décroche : la carte s’en va (pas si Paul répond)', async () => {
  const b = await tablette();
  try {
    await sonneSansReponse(b, JULIE);
    // Appel abouti avec Paul : la carte de Julie reste.
    await b.android('onGsm', { etat: 'enLigne', sortant: true, ...PAUL });
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', sortant: true, ...PAUL });
    await b.avancer(5000);
    assert.match(await carte(b), /^Julie a essayé/);
    // Mamie appelle Julie : ça sonne seulement, la carte reste…
    await b.toucher('#view-home .call-btn');
    await b.page.evaluate(() => [...document.querySelectorAll('.call-person')].find((e) => e.textContent.includes('Julie')).click());
    await b.android('onGsm', { etat: 'appel', sortant: true, ...JULIE });
    await b.android('onGsm', { etat: 'enLigne', sortant: true, ...JULIE });
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', sortant: true, ...JULIE });
    await b.avancer(5000);
    assert.strictEqual(await carte(b), '', '… et s’en va une fois Julie en ligne');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A49 : Mamie rappelle et ça ne répond pas : la carte reste', async () => {
  const b = await tablette();
  try {
    await sonneSansReponse(b, JULIE);
    await b.toucher('#view-home .call-btn');
    await b.page.evaluate(() => [...document.querySelectorAll('.call-person')].find((e) => e.textContent.includes('Julie')).click());
    await b.android('onGsm', { etat: 'appel', sortant: true, ...JULIE });
    await b.android('onGsm', { etat: 'fin', cause: 'manque', sortant: true, ...JULIE });
    await b.avancer(6000);
    if (await b.visible('.call-out')) await b.page.evaluate(() => window.Papote.goHome && window.Papote.goHome());
    assert.match(await carte(b), /^Julie a essayé/);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A49 : Julie rappelle et Mamie décroche (téléphone) : la carte s’en va', async () => {
  const b = await tablette();
  try {
    await sonneSansReponse(b, JULIE);
    await b.android('onGsm', { etat: 'sonne', sortant: false, ...JULIE });
    await b.toucher('.call-answer');
    await b.android('onGsm', { etat: 'enLigne', sortant: false, ...JULIE });
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', sortant: false, ...JULIE });
    await b.avancer(5000);
    assert.strictEqual(await carte(b), '');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A49 : visio : appel internet de Julie sans réponse → carte ; Mamie décroche la visio suivante → partie (appels.js)', async () => {
  const b = await tablette();
  try {
    // appels.js prévient la page (Papote.essaiAppel / appelAbouti) : ici appelé comme le fait appels.js.
    await b.page.evaluate(() => window.Papote.essaiAppel('julie', 'Julie'));
    assert.match(await carte(b), /^Julie a essayé/);
    await b.page.evaluate(() => window.Papote.appelAbouti('paul', 'Paul'));
    assert.match(await carte(b), /^Julie a essayé/, 'Paul décroché : celle de Julie reste');
    await b.page.evaluate(() => window.Papote.appelAbouti('julie', 'Julie'));
    assert.strictEqual(await carte(b), '');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

// Visio par appels.js sur un Firebase imité (faux-firebase.js), comme appels.test.js.
const FAMILLE = {
  firebase: true, telephone: true, code: 'ABCD2345',
  base: {
    'invites/ABCD2345': { fid: 'F1', kind: 'tablette' },
    'families/F1': { name: 'Mamie' },
    'families/F1/members/julie': { name: 'Julie', role: 'famille', status: 'active' },
  },
};
async function visioDeJulie(b, id) {
  const o = await b.page.evaluate(async () => {
    const pc = new RTCPeerConnection();
    pc.addTransceiver('audio');
    pc.addTransceiver('video');
    const x = await pc.createOffer();
    await pc.setLocalDescription(x);
    window.__telephone = pc;
    return { type: x.type, sdp: x.sdp };
  });
  await b.ecrire(`families/F1/calls/${id}`, {
    callerUid: 'julie', callerName: 'Julie', state: 'ringing', offer: o, answer: null,
    createdAt: { __serverTimestamp: true }, endedAt: null,
  });
  await b.avancer(500);
}

test('A49 : visio réelle (appels.js) : sonnerie sans réponse → carte ; Mamie décroche la visio suivante → partie', async () => {
  const b = await ouvrir('2026-10-26T10:00:00', FAMILLE);
  try {
    await b.android('onPosts', lot([]));
    await b.android('onFamily', PROCHES);
    await b.avancer(3000);
    await visioDeJulie(b, 'v1');
    assert.ok(await b.visible('#call-ring'), 'ça sonne');
    await b.avancer(62000); // personne ne décroche : la sonnerie s'arrête au bout d'une minute
    assert.ok(!(await b.visible('#call-ring')));
    assert.match(await carte(b), /^Julie a essayé de vous appeler à 10 h 0\d$/);
    // L'appelant raccroche avant la réponse : la carte est mise à jour (toujours une seule).
    await visioDeJulie(b, 'v2');
    await b.ecrire('families/F1/calls/v2', { ...(await b.lire('families/F1/calls/v2')), state: 'ended' });
    await b.avancer(1500);
    assert.match(await carte(b), /^Julie a essayé/);
    // Julie rappelle en visio, Mamie décroche : la carte s'en va.
    await visioDeJulie(b, 'v3');
    await b.toucher('#ring-answer');
    await b.avancer(1000);
    assert.strictEqual(await carte(b), '');
  } finally { await b.fermer(); }
});

test('A49 : « Pas maintenant » sur l’appel de Julie : pas de carte (Mamie a vu qui appelait)', async () => {
  const b = await tablette();
  try {
    await b.android('onGsm', { etat: 'sonne', sortant: false, ...JULIE });
    await b.toucher('.call-decline');
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', sortant: false, ...JULIE });
    await b.avancer(5000);
    assert.strictEqual(await carte(b), '');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A49 : deux personnes : « Julie et Paul ont essayé de vous appeler » ; trois : la plus récente seule', async () => {
  const b = await tablette();
  try {
    await sonneSansReponse(b, JULIE);
    await sonneSansReponse(b, JULIE);
    assert.match(await carte(b), /^Julie a essayé de vous appeler à 10 h 00$/, 'deux fois Julie : une seule carte');
    await b.avancer(60000);
    await sonneSansReponse(b, PAUL);
    assert.strictEqual(await carte(b), 'Julie et Paul ont essayé de vous appeler');
    await b.avancer(60000);
    await sonneSansReponse(b, MARC);
    assert.match(await carte(b), /^Marc a essayé de vous appeler à 10 h 0\d$/);
    // Paul décroché : il reste Julie et Marc.
    await b.page.evaluate(() => window.Papote.appelAbouti('paul', 'Paul'));
    assert.strictEqual(await carte(b), 'Julie et Marc ont essayé de vous appeler');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A49 : deux prénoms trop longs pour tenir : la plus récente seule, avec l’heure', async () => {
  const b = await tablette();
  try {
    await b.page.evaluate(() => window.Papote.essaiAppel('a', 'Marie-Bernadette'));
    await b.page.evaluate(() => window.Papote.essaiAppel('b', 'Jean-Christophe'));
    assert.strictEqual(await carte(b), 'Jean-Christophe a essayé de vous appeler à 10 h 00');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A49 : 21 h : la carte s’en va (veille à 23 h), et ne revient pas le lendemain, même après une relance', async () => {
  const b = await tablette('2026-10-26T20:50:00');
  try {
    await sonneSansReponse(b, JULIE);
    assert.match(await carte(b), /^Julie a essayé de vous appeler à 20 h 50$/);
    await b.avancer(10 * 60000 + 30000); // 21 h 01
    assert.strictEqual(await carte(b), '', 'partie à 21 h');
    await b.page.clock.fastForward(11 * 3600000); // lendemain 8 h
    await b.avancer(2000);
    assert.strictEqual(await carte(b), '');
    await b.page.reload();
    await donnees(b);
    await b.avancer(3000);
    assert.strictEqual(await carte(b), '', 'pas de retour le lendemain');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A49 : la mise en veille du soir (20 h) l’efface ; elle ne revient pas au réveil', async () => {
  const b = await tablette('2026-10-26T19:50:00', { veille: { active: true, de: 20 * 60, a: 7 * 60 } });
  try {
    await sonneSansReponse(b, JULIE);
    assert.match(await carte(b), /^Julie a essayé/);
    await b.avancer(11 * 60000); // 20 h 01 : veille
    assert.ok((await b.appels('setSleep')).some((x) => x.args[0] === true), 'tablette en veille');
    await b.page.clock.fastForward(11 * 3600000); // 7 h passé : réveil
    await b.avancer(2000);
    assert.strictEqual(await carte(b), '', 'pas de carte le lendemain matin');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A49 : appel arrivé après 21 h (veille 23 h) : la carte reste jusqu’à la veille', async () => {
  const b = await tablette('2026-10-26T21:30:00');
  try {
    await sonneSansReponse(b, JULIE);
    assert.match(await carte(b), /^Julie a essayé de vous appeler à 21 h 30$/);
    await b.avancer(60 * 60000); // 22 h 30
    assert.match(await carte(b), /^Julie a essayé/);
    await b.avancer(40 * 60000); // 23 h 10 : veille
    assert.strictEqual(await carte(b), '');
    await sansErreur(b);
  } finally { await b.fermer(); }
});
