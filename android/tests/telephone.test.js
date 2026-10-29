// Essais des appels par la carte SIM (chantier téléphone, 29/10/2026) : Mamie appelle par téléphone,
// un proche appelle (Décrocher), SOS par SMS + appels un à un, visio refusée pendant un appel téléphone.
// Android (AppelGsm.java) est imité : la page reçoit Papote.onGsm({etat, sortant, uid, name, cause}).
// Lancement : node --test android/tests/
const test = require('node:test');
const assert = require('node:assert');
const { ouvrir, lot } = require('./banc');

const PROCHES = {
  faces: {}, birthdays: [],
  people: [
    { uid: 'julie', name: 'Julie', tel: '0612345678', responsable: false },
    { uid: 'paul', name: 'Paul', tel: '0700000000', responsable: true },
    { uid: 'anne', name: 'Anne', tel: '' },
  ],
};

async function tablette(etat = {}) {
  const b = await ouvrir('2026-10-26T10:00:00', { telephone: true, ...etat });
  await b.android('onPosts', lot([]));
  await b.android('onFamily', PROCHES);
  await b.avancer(500);
  return b;
}

async function sansErreur(b) {
  const erreurs = (await b.appels('erreurJS')).concat(await b.appels('logError'));
  assert.deepStrictEqual(erreurs, [], 'erreurs JavaScript');
}

const choisir = (b, prenom) => b.page.evaluate((p) => [...document.querySelectorAll('.call-person')].find((e) => e.textContent.includes(p)).click(), prenom);

test('Mamie appelle Julie par téléphone : ça sonne, en ligne, puis « Appel terminé »', async () => {
  const b = await tablette();
  try {
    await b.toucher('#view-home .call-btn');
    await choisir(b, 'Julie');
    const appels = await b.appels('phoneCall');
    assert.deepStrictEqual(appels.map((a) => a.args[0]), ['0612345678']);
    assert.match(await b.texte('.call-out'), /Appel vers Julie/);
    await b.android('onGsm', { etat: 'appel', sortant: true, numero: '0612345678', uid: 'julie', name: 'Julie' });
    assert.match(await b.texte('.call-out'), /Ça sonne/);
    assert.match(await b.texte('.call-out'), /Chez Julie/);
    await b.android('onGsm', { etat: 'enLigne', sortant: true, numero: '0612345678', uid: 'julie', name: 'Julie' });
    assert.match(await b.texte('.call-out'), /En ligne avec Julie/);
    assert.ok(await b.visible('.call-hangup'), 'bouton Raccrocher');
    await b.toucher('.call-hangup');
    assert.strictEqual((await b.appels('phoneHangup')).length, 1, 'Raccrocher passe par Android');
    await b.android('onGsm', { etat: 'fin', sortant: true, cause: 'raccroche', uid: 'julie', name: 'Julie' });
    assert.match(await b.texte('.call-out'), /Appel terminé/);
    // La photo de Julie (son initiale), pas le collage de la famille (bug du 29/10 : trois visages).
    assert.strictEqual(await b.page.evaluate(() => document.querySelectorAll('.call-out .call-face').length), 1);
    assert.strictEqual(await b.texte('.call-out .call-face'), 'J');
    await b.avancer(4500);
    assert.ok(!(await b.visible('.call-out')), 'retour à l’accueil');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('Julie ne répond pas : la tablette raccroche au bout de 45 s, puis la liste des personnes', async () => {
  const b = await tablette();
  try {
    await b.toucher('#view-home .call-btn');
    await choisir(b, 'Julie');
    await b.android('onGsm', { etat: 'appel', sortant: true, uid: 'julie', name: 'Julie' });
    await b.avancer(44000);
    assert.strictEqual((await b.appels('phoneHangup')).length, 0);
    await b.avancer(2000);
    assert.strictEqual((await b.appels('phoneHangup')).length, 1, 'raccroché à 45 s');
    await b.android('onGsm', { etat: 'fin', sortant: true, cause: 'raccroche', uid: 'julie', name: 'Julie' });
    assert.match(await b.texte('.call-out'), /Julie n’a pas pu répondre/);
    await b.avancer(4500);
    assert.match(await b.texte('.call-out'), /Qui voulez-vous appeler/);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('Paul est déjà en ligne : « occupé » ; l’appel qui ne part pas : « n’a pas pu partir »', async () => {
  const b = await tablette();
  try {
    await b.toucher('#view-home .call-btn');
    await choisir(b, 'Paul');
    assert.deepStrictEqual((await b.appels('phoneCall')).map((a) => a.args[0]), ['0700000000']);
    await b.android('onGsm', { etat: 'fin', sortant: true, cause: 'occupe', uid: 'paul', name: 'Paul' });
    assert.match(await b.texte('.call-out'), /Paul est déjà en ligne/);
    await b.avancer(4500);
    await b.etat({ telephoneKo: true });
    await choisir(b, 'Paul');
    assert.match(await b.texte('.call-out'), /n’a pas pu partir/);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('Anne n’a pas de numéro : l’appel passe par internet comme avant (pas de téléphone)', async () => {
  const b = await tablette({ appelsKo: true });
  try {
    await b.toucher('#view-home .call-btn');
    await choisir(b, 'Anne');
    assert.strictEqual((await b.appels('phoneCall')).length, 0, 'pas d’appel téléphone');
    assert.match(await b.texte('.call-out'), /pas encore disponible|Appel vers Anne/);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('Julie appelle par téléphone : ça sonne avec sa photo, « Décrocher » répond, Julie raccroche', async () => {
  const b = await tablette();
  try {
    await b.android('onGsm', { etat: 'sonne', sortant: false, numero: '0612345678', uid: 'julie', name: 'Julie' });
    assert.ok(await b.visible('.call-out'), 'écran d’appel');
    assert.match(await b.texte('.call-out .call-title'), /Julie/);
    assert.match(await b.texte('.call-out'), /vous appelle/);
    assert.deepStrictEqual((await b.appels('ring')).map((a) => a.args[0]), [true], 'sonnerie');
    assert.strictEqual((await b.appels('phoneAnswer')).length, 0, 'jamais décroché tout seul');
    await b.avancer(30000);
    assert.strictEqual((await b.appels('phoneAnswer')).length, 0, 'toujours pas décroché tout seul');
    await b.toucher('.call-answer');
    assert.strictEqual((await b.appels('phoneAnswer')).length, 1);
    await b.android('onGsm', { etat: 'enLigne', sortant: false, numero: '0612345678', uid: 'julie', name: 'Julie' });
    assert.match(await b.texte('.call-out'), /En ligne avec Julie/);
    assert.ok((await b.appels('ring')).some((a) => a.args[0] === false), 'sonnerie arrêtée');
    await b.android('onGsm', { etat: 'fin', sortant: false, cause: 'raccroche', uid: 'julie', name: 'Julie' });
    assert.match(await b.texte('.call-out'), /Appel terminé/);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('« Pas maintenant » refuse l’appel ; un appel non décroché se termine par « Julie a appelé »', async () => {
  const b = await tablette();
  try {
    await b.android('onGsm', { etat: 'sonne', sortant: false, uid: 'julie', name: 'Julie' });
    await b.toucher('.call-decline');
    assert.strictEqual((await b.appels('phoneHangup')).length, 1);
    await b.android('onGsm', { etat: 'fin', sortant: false, cause: 'refuse', uid: 'julie', name: 'Julie' });
    assert.match(await b.texte('.call-out'), /Julie a appelé/);
    await b.avancer(4500);
    assert.ok(!(await b.visible('.call-out')));
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('la nuit, un appel téléphone rallume l’écran le temps de l’appel', async () => {
  const b = await ouvrir('2026-10-26T23:30:00', { telephone: true });
  try {
    await b.android('onPosts', lot([]));
    await b.android('onFamily', PROCHES);
    await b.avancer(2000);
    assert.ok((await b.appels('setSleep')).some((a) => a.args[0] === true), 'en veille');
    await b.vider();
    await b.android('onGsm', { etat: 'sonne', sortant: false, uid: 'julie', name: 'Julie' });
    assert.deepStrictEqual((await b.appels('setSleep')).map((a) => a.args[0]), [false], 'écran rallumé');
    const voileNoir = () => b.page.evaluate(() => document.querySelector('.night-clock').parentElement.style.display !== 'none');
    assert.strictEqual(await voileNoir(), false, 'l’écran noir de veille ne cache pas l’appel');
    await b.avancer(3000);
    assert.strictEqual(await voileNoir(), false, 'toujours visible pendant que ça sonne');
    assert.ok(!(await b.appels('setSleep')).some((a) => a.args[0] === true), 'pas rendormie pendant l’appel');
    await b.android('onGsm', { etat: 'fin', sortant: false, cause: 'manque', uid: 'julie', name: 'Julie' });
    await b.avancer(5500); // « Julie a appelé » 4 s, puis la veille reprend
    assert.ok((await b.appels('setSleep')).some((a) => a.args[0] === true), 'écran éteint après l’appel');
    assert.strictEqual(await voileNoir(), true);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS par téléphone : un SMS à tous, Paul (responsable) appelé d’abord, puis Julie, qui décroche', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    const sms = await b.appels('sendSms');
    assert.strictEqual(sms.length, 1, 'un SMS');
    assert.strictEqual(sms[0].args[0], '0700000000,0612345678', 'responsable en tête, Anne sans numéro');
    assert.match(sms[0].args[1], /SOS Papote : Mamie a appuyé sur le bouton SOS/);
    assert.deepStrictEqual((await b.appels('phoneCall')).map((a) => a.args[0]), ['0700000000']);
    // Un écran SOS clair, pas « Appel vers Paul… » (galerie du 29/10).
    assert.match(await b.texte('.call-out .call-title'), /SOS : on appelle Paul/);
    assert.match(await b.texte('.call-out'), /La famille a reçu votre SOS par SMS/);
    assert.ok(await b.page.evaluate(() => /\bsos\b/.test(document.querySelector('.call-out').className)), 'classe sos');
    await b.android('onGsm', { etat: 'appel', sortant: true, numero: '0700000000', uid: 'paul', name: 'Paul' });
    assert.match(await b.texte('.call-out .call-title'), /SOS : ça sonne chez Paul/);
    await b.avancer(46000);
    assert.strictEqual((await b.appels('phoneHangup')).length, 1, 'Paul ne répond pas : raccroché');
    await b.android('onGsm', { etat: 'fin', sortant: true, cause: 'raccroche', numero: '0700000000', uid: 'paul', name: 'Paul' });
    assert.deepStrictEqual((await b.appels('phoneCall')).map((a) => a.args[0]), ['0700000000', '0612345678'], 'Julie ensuite');
    assert.match(await b.texte('.call-out .call-title'), /SOS : on appelle Julie/);
    // Android répète la fin de l'appel de Paul (onCallRemoved) : l'appel de Julie continue.
    await b.android('onGsm', { etat: 'fin', sortant: true, cause: 'raccroche', numero: '0700000000', uid: 'paul', name: 'Paul' });
    assert.match(await b.texte('.call-out .call-title'), /SOS : on appelle Julie/);
    assert.strictEqual((await b.appels('phoneCall')).length, 2, 'pas d’appel sauté');
    await b.android('onGsm', { etat: 'enLigne', sortant: true, uid: 'julie', name: 'Julie' });
    assert.match(await b.texte('.call-out'), /En ligne avec Julie/);
    await b.android('onGsm', { etat: 'fin', sortant: true, cause: 'raccroche', uid: 'julie', name: 'Julie' });
    assert.match(await b.texte('.call-out'), /Appel terminé/);
    assert.strictEqual((await b.appels('phoneCall')).length, 2, 'personne d’autre appelé');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS par téléphone : personne ne décroche → l’appel internet d’avant prévient la famille', async () => {
  const b = await tablette({ appelsKo: true });
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    for (const [uid, name] of [['paul', 'Paul'], ['julie', 'Julie']]) {
      await b.android('onGsm', { etat: 'appel', sortant: true, uid, name });
      await b.avancer(46000);
      await b.android('onGsm', { etat: 'fin', sortant: true, cause: 'raccroche', uid, name });
    }
    assert.strictEqual((await b.appels('phoneCall')).length, 2);
    // appels.js ne charge pas (appelsKo) : le 2e essai par internet ne peut pas partir, Mamie le voit.
    assert.match(await b.texte('.call-out'), /pas encore disponible|La famille est prévenue/);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('sans téléphone (tablette Wi-Fi) : le SOS et les appels passent par internet comme avant', async () => {
  const b = await tablette({ telephone: false, appelsKo: true });
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    assert.strictEqual((await b.appels('sendSms')).length, 0);
    assert.strictEqual((await b.appels('phoneCall')).length, 0);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('Raccrocher alors qu’Android n’a plus d’appel : l’écran se ferme quand même (bug du 29/10)', async () => {
  const b = await tablette({ raccrocherKo: true });
  try {
    await b.toucher('#view-home .call-btn');
    await choisir(b, 'Julie');
    await b.android('onGsm', { etat: 'enLigne', sortant: true, uid: 'julie', name: 'Julie' });
    assert.match(await b.texte('.call-out'), /En ligne avec Julie/);
    await b.toucher('.call-hangup');
    assert.strictEqual((await b.appels('phoneHangup')).length, 1);
    // Pas de « fin » d'Android : l'écran dit quand même « Appel terminé », puis l'accueil.
    assert.match(await b.texte('.call-out'), /Appel terminé/);
    await b.avancer(4500);
    assert.ok(!(await b.visible('.call-out')), 'retour à l’accueil');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('écran d’appel sans nouvelle d’Android pendant 60 s : il se ferme si l’appel n’existe plus', async () => {
  const b = await tablette({ appelGsm: { etat: 'enLigne', sortant: true, uid: 'julie', name: 'Julie' } });
  try {
    await b.toucher('#view-home .call-btn');
    await choisir(b, 'Julie');
    await b.android('onGsm', { etat: 'enLigne', sortant: true, uid: 'julie', name: 'Julie' });
    // Android dit toujours « en ligne » : l'écran reste, aussi longtemps que dure l'appel.
    await b.avancer(130000);
    assert.match(await b.texte('.call-out'), /En ligne avec Julie/);
    // Android n'a plus d'appel (phoneState vide) sans l'avoir dit : au contrôle suivant, l'écran se ferme.
    await b.page.evaluate(() => { window.__etat.appelGsm = {}; });
    await b.avancer(52000); // contrôle suivant à 180 s
    assert.match(await b.texte('.call-out'), /Appel terminé/);
    await b.avancer(4500);
    assert.ok(!(await b.visible('.call-out')), 'retour à l’accueil');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('« Appel vers Julie… » sans aucun état d’Android : fermé au bout de 60 s, liste des personnes', async () => {
  const b = await tablette();
  try {
    await b.toucher('#view-home .call-btn');
    await choisir(b, 'Julie');
    await b.avancer(59000);
    assert.match(await b.texte('.call-out'), /Appel vers Julie/);
    await b.avancer(2000);
    assert.match(await b.texte('.call-out'), /Julie n’a pas pu répondre/);
    await b.avancer(4500);
    assert.match(await b.texte('.call-out'), /Qui voulez-vous appeler/);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('page rechargée pendant un appel téléphone : l’écran d’appel revient', async () => {
  const b = await ouvrir('2026-10-26T10:00:00', { telephone: true, appelGsm: { etat: 'enLigne', sortant: true, uid: 'julie', name: 'Julie' } });
  try {
    await b.android('onPosts', lot([]));
    await b.android('onFamily', PROCHES);
    await b.avancer(2000);
    assert.match(await b.texte('.call-out'), /En ligne avec Julie/);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('déjà en visio par internet : un appel téléphone qui arrive est refusé', async () => {
  const b = await tablette();
  try {
    await b.page.evaluate(() => { document.getElementById('call-view').hidden = false; });
    await b.android('onGsm', { etat: 'sonne', sortant: false, uid: 'julie', name: 'Julie' });
    assert.strictEqual((await b.appels('phoneHangup')).length, 1, 'refusé');
    assert.strictEqual((await b.appels('ring')).length, 0, 'pas de sonnerie');
    await sansErreur(b);
  } finally { await b.fermer(); }
});
