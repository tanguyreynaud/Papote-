// Un seul message de fin par SOS (choix de Tanguy, 20/11). Le premier de ces événements envoie un SMS aux
// proches qui ont reçu le SMS d'alerte ; les suivants n'envoient plus rien :
//  - un appel du SOS resté en ligne 2 min 15 (avant, ce peut être une messagerie : elle coupe à 2 min 07) ;
//  - Mamie appuie sur « Raccrocher » pendant le SOS ;
//  - un proche touche « Je m'en occupe » dans l'app (families/{fid}.sosPris, passé par onFamily).
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
const PAUL = { sortant: true, numero: '0700000000', uid: 'paul', name: 'Paul' };
const JULIE = { sortant: true, numero: '0612345678', uid: 'julie', name: 'Julie' };
const DEBUT = '2026-11-20T10:00:00';

async function tablette(etat = {}) {
  const b = await ouvrir(DEBUT, { telephone: true, ...etat });
  await b.android('onPosts', lot([], { options: { sos: true } }));
  await b.android('onFamily', PROCHES);
  await b.avancer(8000);
  await b.page.evaluate(() => {
    window.__internet = [];
    window.papoteCallFamily = (o) => { window.__internet.push(o.sos || o.to); window.__etatInternet = o.onState; return { hangup() {} }; };
  });
  return b;
}
const sos = async (b) => { await b.toucher('#sos-btn'); await b.avancer(5100); };
const sms = async (b) => (await b.appels('sendSms')).map((a) => ({ a: a.args[0].split(',').sort().join(','), texte: a.args[1] }));
const numeros = async (b) => (await b.appels()).filter((a) => a.nom === 'phoneCall' || a.nom === 'phoneCallSos').map((a) => a.args[0]);
const signaux = async (b) => (await b.appels('sosSignaler')).map((a) => JSON.parse(a.args[0]).fin);
const ecran = async (b) => (await b.texte('.call-out')).replace(/\s+/g, ' ').trim();
const maintenant = (b) => b.page.evaluate(() => Date.now());
const jeMenOccupe = async (b, qui, le) => b.android('onFamily', { ...PROCHES, sosPris: { uid: qui.uid, nom: qui.name, le } });
async function sansErreur(b) {
  assert.deepStrictEqual((await b.appels('logError')).map((a) => a.args[0]), [], 'aucune erreur de la page');
}
const TOUS = '0611111111,0612345678,0700000000';

test('SOS : Paul reste en ligne 2 min 15 : un SMS « Paul a répondu » aux deux autres, pas avant, un seul', async () => {
  const b = await tablette();
  try {
    await sos(b);
    assert.strictEqual((await sms(b)).length, 1, 'le SMS d’alerte');
    assert.deepStrictEqual(await signaux(b), [''], 'SOS signalé à l’app, pas encore fini');
    await b.avancer(6000);
    await b.etat({ appelGsm: { etat: 'enLigne', ...PAUL } });
    await b.android('onGsm', { etat: 'enLigne', ...PAUL });
    await b.avancer(130000); // 2 min 10 : une messagerie aurait pu tenir jusque-là
    assert.strictEqual((await sms(b)).length, 1, 'rien avant 2 min 15');
    await b.avancer(6000);
    const envois = await sms(b);
    assert.strictEqual(envois.length, 2);
    assert.strictEqual(envois[1].a, '0611111111,0612345678', 'pas à Paul, il le sait');
    assert.match(envois[1].texte, /^Papote : Paul a répondu au SOS de /);
    assert.match(await ecran(b), /En ligne avec Paul/, 'l’appel n’est pas touché');
    // Ensuite Mamie raccroche, puis Julie touche « Je m'en occupe » : plus aucun message.
    await b.toucher('.call-hangup');
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    await jeMenOccupe(b, JULIE, await maintenant(b));
    await b.avancer(60000);
    assert.strictEqual((await sms(b)).length, 2, 'jamais plus d’un message de fin');
    assert.deepStrictEqual(await signaux(b), ['', 'repondu']);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS : une messagerie qui tient 2 min 07 puis coupe : aucun « a répondu »', async () => {
  const b = await tablette();
  try {
    await sos(b);
    await b.avancer(6000);
    await b.android('onGsm', { etat: 'enLigne', ...PAUL });
    await b.etat({ appelGsm: { etat: 'enLigne', ...PAUL } });
    await b.avancer(127000);
    await b.etat({ appelGsm: {} });
    await b.android('onGsm', { etat: 'fin', cause: 'distant', ...PAUL });
    await b.avancer(60000);
    assert.strictEqual((await sms(b)).length, 1, 'seulement le SMS d’alerte');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS : Mamie appuie sur « Raccrocher » : un SMS « a arrêté son SOS » à tous, un seul même au double appui', async () => {
  const b = await tablette();
  try {
    await sos(b);
    await b.android('onGsm', { etat: 'appel', ...PAUL });
    await b.avancer(6000);
    await b.page.evaluate(() => { const r = document.querySelector('.call-hangup'); r.click(); r.click(); });
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    const envois = await sms(b);
    assert.strictEqual(envois.length, 2);
    assert.strictEqual(envois[1].a, TOUS);
    assert.match(envois[1].texte, /^Papote : .+ a arrêté son SOS depuis sa tablette\. Appelez-la quand même\.$/);
    // Un « Je m'en occupe » qui arrive après : rien de plus.
    await jeMenOccupe(b, JULIE, await maintenant(b));
    await b.avancer(5 * 60000);
    assert.strictEqual((await sms(b)).length, 2);
    assert.deepStrictEqual(await signaux(b), ['', 'arrete']);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS : Julie touche « Je m’en occupe » pendant que ça sonne chez Paul : SMS aux autres, appel de Paul laissé, plus personne ensuite', async () => {
  const b = await tablette();
  try {
    await sos(b);
    await b.android('onGsm', { etat: 'appel', ...PAUL });
    await b.avancer(5000);
    await jeMenOccupe(b, JULIE, await maintenant(b));
    const envois = await sms(b);
    assert.strictEqual(envois.length, 2);
    assert.strictEqual(envois[1].a, '0611111111,0700000000', 'pas à Julie');
    assert.match(envois[1].texte, /^Papote : Julie s’occupe du SOS de /);
    assert.strictEqual((await b.appels('phoneHangup')).length, 0, 'l’appel en cours n’est pas coupé');
    // Paul ne répond pas : raccroché à 18 s, et la chaîne s'arrête là.
    await b.avancer(14000);
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    assert.match(await ecran(b), /Julie s’occupe de vous/);
    await b.avancer(5 * 60000);
    assert.deepStrictEqual(await numeros(b), ['0700000000'], 'ni Julie ni Marc ne sont appelés');
    assert.deepStrictEqual(await b.page.evaluate(() => window.__internet), [], 'pas d’appel par internet');
    assert.ok(!(await b.visible('.call-out')), 'retour à l’accueil');
    // La même fiche relue plus tard (autre synchronisation) : pas de deuxième SMS.
    await jeMenOccupe(b, JULIE, await maintenant(b));
    assert.strictEqual((await sms(b)).length, 2);
    assert.deepStrictEqual(await signaux(b), ['', 'pris']);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('« Je m’en occupe » après la fin des appels (personne n’a répondu) : le SMS part quand même, dans les 30 min', async () => {
  const b = await tablette();
  try {
    await sos(b);
    for (const p of [PAUL, JULIE, { sortant: true, numero: '0611111111', uid: 'marc', name: 'Marc' }]) {
      await b.android('onGsm', { etat: 'appel', ...p });
      await b.avancer(18500);
      await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...p });
      await b.avancer(7000);
    }
    await b.avancer(10 * 60000);
    assert.strictEqual((await sms(b)).length, 1);
    await jeMenOccupe(b, JULIE, await maintenant(b));
    const envois = await sms(b);
    assert.strictEqual(envois.length, 2);
    assert.match(envois[1].texte, /Julie s’occupe du SOS/);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('« Je m’en occupe » d’un SOS d’avant, ou sans aucun SOS, ou plus de 30 min après : aucun SMS', async () => {
  const b = await tablette();
  try {
    // Sans SOS.
    await jeMenOccupe(b, JULIE, await maintenant(b));
    assert.strictEqual((await sms(b)).length, 0);
    // Un vieux « Je m'en occupe » (hier) encore sur la fiche pendant un nouveau SOS.
    await sos(b);
    await jeMenOccupe(b, JULIE, (await maintenant(b)) - 24 * 3600000);
    assert.strictEqual((await sms(b)).length, 1, 'seulement le SMS d’alerte');
    await b.android('onGsm', { etat: 'appel', ...PAUL });
    await b.avancer(18500);
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    assert.deepStrictEqual((await numeros(b)).slice(0, 2), ['0700000000', '0612345678'], 'la chaîne continue');
    // 31 min plus tard : trop tard, la tablette ne dit plus rien.
    await b.avancer(31 * 60000);
    const avant = (await sms(b)).length;
    await jeMenOccupe(b, JULIE, await maintenant(b));
    assert.strictEqual((await sms(b)).length, avant);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SMS d’alerte pas parti : aucun message de fin non plus (personne ne saurait de quoi on parle)', async () => {
  const b = await tablette({ smsKo: true });
  try {
    await sos(b);
    await b.android('onGsm', { etat: 'appel', ...PAUL });
    await b.avancer(5000);
    const avant = (await b.appels('sendSms')).length;
    await jeMenOccupe(b, JULIE, await maintenant(b));
    await b.toucher('.call-hangup');
    assert.strictEqual((await b.appels('sendSms')).length, avant);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('page relancée pendant l’appel en ligne : le « a répondu » part quand même à 2 min 15, une seule fois', async () => {
  const b = await tablette();
  try {
    await sos(b);
    await b.avancer(6000);
    await b.etat({ appelGsm: { etat: 'enLigne', ...PAUL } });
    await b.android('onGsm', { etat: 'enLigne', ...PAUL });
    await b.avancer(60000);
    await b.page.addInitScript((x) => Object.assign(window.__etat, x), { appelGsm: { etat: 'enLigne', ...PAUL } });
    await b.page.reload();
    await b.android('onPosts', lot([], { options: { sos: true } }));
    await b.android('onFamily', PROCHES);
    await b.avancer(2500);
    assert.match(await ecran(b), /En ligne avec Paul/);
    assert.strictEqual((await b.appels('sendSms')).length, 0, 'rien à 1 min');
    await b.avancer(80000);
    const fins = (await b.appels('sendSms')).filter((a) => /a répondu/.test(a.args[1]));
    assert.strictEqual(fins.length, 1);
    await b.avancer(5 * 60000);
    assert.strictEqual((await b.appels('sendSms')).filter((a) => /a répondu/.test(a.args[1])).length, 1);
  } finally { await b.fermer(); }
});
