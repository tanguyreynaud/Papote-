// SOS de la tablette (audit 05/11) : pause de l'abonnement, enchaînement des proches par la carte SIM,
// messagerie vocale, appel par internet pendant la pause.
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

async function tablette(etat = {}, champs = {}) {
  const b = await ouvrir('2026-10-26T10:00:00', { telephone: true, ...etat });
  await b.android('onPosts', lot([], champs));
  await b.android('onFamily', PROCHES);
  await b.avancer(8000); // l'écran de démarrage (boot) s'efface
  // Appel internet imité : on note chaque départ (sos 1 ou 2).
  await b.page.evaluate(() => {
    window.__internet = [];
    window.papoteCallFamily = (o) => { window.__internet.push(o.sos || o.to); return { hangup() {} }; };
  });
  return b;
}
// Numéros appelés par la carte SIM (appel ordinaire ou appel de SOS).
const appelsTel = async (b) => (await b.appels()).filter((a) => a.nom === 'phoneCall' || a.nom === 'phoneCallSos').map((a) => a.args[0]);
const internet = (b) => b.page.evaluate(() => window.__internet);
const ecran = async (b) => (await b.texte('.call-out')).replace(/\s+/g, ' ').trim();

test('SOS (F-b) : Android retire l\'appel sans réponse 1 s après « fin » : le proche suivant est appelé quand même', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    await b.android('onGsm', { etat: 'appel', ...PAUL });
    await b.avancer(46000); // 45 s sans réponse : la page raccroche
    // Android réel : « fin » publiée à DISCONNECTING, l'appel n'est retiré (onCallRemoved) qu'un peu après :
    // jusque-là phoneCall répond false (AppelGsm.enCours()).
    await b.etat({ telephoneKo: true });
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    await b.avancer(1000);
    await b.etat({ telephoneKo: false }); // onCallRemoved
    await b.avancer(1000);
    const tel = await appelsTel(b);
    assert.strictEqual(tel[tel.length - 1], '0612345678', `Julie appelée après Paul (appels : ${tel.join(', ')})`);
    assert.ok(!tel.includes('0611111111'), 'Marc pas encore appelé');
    assert.deepStrictEqual(await internet(b), [], 'pas de repli internet tant qu\'il reste des proches');
    assert.match(await ecran(b), /SOS : on appelle Julie/);
  } finally { await b.fermer(); }
});

test('SOS (F-c) : la messagerie de Paul décroche (25 s « en ligne ») : la chaîne continue vers Julie', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    await b.android('onGsm', { etat: 'appel', ...PAUL });
    await b.avancer(20000);
    await b.android('onGsm', { etat: 'enLigne', ...PAUL }); // répondeur
    await b.avancer(25000);
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    await b.avancer(1000);
    const tel = await appelsTel(b);
    assert.deepStrictEqual(tel, ['0700000000', '0612345678'], 'Julie appelée après la messagerie de Paul');
    assert.match(await ecran(b), /SOS : on appelle Julie/);
  } finally { await b.fermer(); }
});

test('SOS (F-c, témoin) : vraie conversation de 60 s avec Paul : la chaîne s\'arrête', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    await b.android('onGsm', { etat: 'appel', ...PAUL });
    await b.avancer(5000);
    await b.android('onGsm', { etat: 'enLigne', ...PAUL });
    await b.avancer(60000);
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    await b.avancer(1000);
    assert.deepStrictEqual(await appelsTel(b), ['0700000000']);
    assert.match(await ecran(b), /Appel terminé/);
  } finally { await b.fermer(); }
});

test('SOS (F-a) : abonnement suspendu : gros bouton SOS sur l\'écran de pause, SMS et appels partent, la famille peut rappeler', async () => {
  const b = await tablette({}, { subscription: 'suspendu' });
  try {
    assert.ok(await b.visible('.pause-screen'), 'écran de pause');
    assert.ok(await b.visible('.pause-screen .pause-sos'), 'bouton SOS sur l\'écran de pause');
    await b.toucher('.pause-screen .pause-sos');
    // Le décompte est visible (Annuler touchable), plus sous l'écran de pause.
    const dessus = await b.page.evaluate(() => { const e = document.elementFromPoint(640, 400); return !!(e && e.closest('.call-out')); });
    assert.ok(dessus, 'écran SOS au-dessus de la pause');
    assert.strictEqual((await b.appels('sosDemarre')).length, 1, 'Android prévenu : pause levée pour le SOS');
    assert.strictEqual(await b.page.evaluate(() => window.papotePaused), false, 'appels.js laisse passer le SOS');
    await b.avancer(5500);
    assert.strictEqual((await b.appels('sendSms')).length, 1, 'SMS de SOS envoyé');
    assert.deepStrictEqual(await appelsTel(b), ['0700000000'], 'Paul appelé');
    // Personne ne décroche, la chaîne se termine ; 10 min après, Julie rappelle (SMS reçu) : ça sonne.
    for (const p of [PAUL, { sortant: true, numero: '0612345678', uid: 'julie', name: 'Julie' }, { sortant: true, numero: '0611111111', uid: 'marc', name: 'Marc' }]) {
      await b.android('onGsm', { etat: 'fin', cause: 'manque', ...p });
      await b.avancer(500);
    }
    await b.avancer(10 * 60000);
    await b.android('onGsm', { etat: 'sonne', sortant: false, numero: '0612345678', uid: 'julie', name: 'Julie' });
    const sonne = await b.page.evaluate(() => { const e = document.elementFromPoint(640, 400); return !!(e && e.closest('.gsm-ring')); });
    assert.ok(sonne, 'le rappel de Julie s\'affiche (pas caché par la pause)');
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', sortant: false, numero: '0612345678', uid: 'julie', name: 'Julie' });
    // 30 min après le SOS : la pause revient.
    await b.avancer(21 * 60000);
    assert.ok(await b.visible('.pause-screen'), 'pause de retour 30 min après le SOS');
    assert.strictEqual(await b.page.evaluate(() => window.papotePaused), true);
  } finally { await b.fermer(); }
});

test('SOS (F-a) : appui par erreur pendant la pause, « Annuler » : la pause revient aussitôt', async () => {
  const b = await tablette({}, { subscription: 'suspendu' });
  try {
    await b.toucher('.pause-screen .pause-sos');
    await b.toucher('.sos-cancel');
    await b.avancer(6000);
    assert.ok(await b.visible('.pause-screen'));
    assert.strictEqual((await b.appels('sendSms')).length, 0);
  } finally { await b.fermer(); }
});

test('SOS (F-a) : SOS désactivé par la famille : pas de bouton sur l\'écran de pause', async () => {
  const b = await tablette({}, { subscription: 'suspendu', options: { sos: false } });
  try {
    assert.ok(await b.visible('.pause-screen'));
    assert.ok(!(await b.visible('.pause-screen .pause-sos')));
  } finally { await b.fermer(); }
});

test('SOS (F-a) : abonnement suspendu, sans carte SIM : le SOS part par internet', async () => {
  const b = await tablette({ telephone: false }, { subscription: 'resilie' });
  try {
    await b.toucher('.pause-screen .pause-sos');
    await b.avancer(5500);
    assert.deepStrictEqual(await internet(b), [1], 'appel SOS internet lancé');
  } finally { await b.fermer(); }
});

test('SOS (F-a) : tablette verrouillée (perdue) : pas de SOS (pas de fausse alerte à la famille)', async () => {
  const b = await tablette({}, { subscription: 'suspendu', perdue: true });
  try {
    const dessous = await b.page.evaluate(() => document.elementFromPoint(640, 400).closest('.perdue-screen') !== null);
    assert.ok(dessous, 'écran verrouillé au-dessus de tout');
    await b.page.mouse.click(640, 400);
    await b.avancer(6000);
    assert.strictEqual((await b.appels('sendSms')).length, 0);
    assert.deepStrictEqual(await appelsTel(b), []);
  } finally { await b.fermer(); }
});

test('SOS : abonnement actif, rien ne change (bouton SOS de l\'accueil, appel SOS)', async () => {
  const b = await tablette();
  try {
    assert.ok(!(await b.visible('.pause-screen')));
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    assert.deepStrictEqual(await appelsTel(b), ['0700000000']);
  } finally { await b.fermer(); }
});
