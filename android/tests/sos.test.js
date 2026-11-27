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

// Tanguy, 27/11 : « répondu » seulement après 2 min 15 en ligne (avant : 40 s).
test('SOS : Paul refuse l\'appel, sa messagerie reste en ligne 2 min 07 : pas une réponse, Julie est appelée', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    await b.android('onGsm', { etat: 'appel', ...PAUL });
    await b.avancer(6000);
    await b.android('onGsm', { etat: 'enLigne', ...PAUL }); // la messagerie décroche, comme une personne
    await b.page.evaluate(() => { window.__etat.appelGsm = { etat: 'enLigne', sortant: true }; }); // Android : l'appel est toujours là
    await b.avancer(127000);
    await b.page.evaluate(() => { window.__etat.appelGsm = {}; });
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    await b.avancer(1000);
    assert.deepStrictEqual(await appelsTel(b), ['0700000000', '0612345678'], 'Julie appelée après la messagerie de Paul');
    assert.match(await ecran(b), /SOS : on appelle Julie/);
  } finally { await b.fermer(); }
});

test('SOS (F-c, témoin) : vraie conversation de 2 min 20 avec Paul : la chaîne s\'arrête', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    await b.android('onGsm', { etat: 'appel', ...PAUL });
    await b.avancer(5000);
    await b.android('onGsm', { etat: 'enLigne', ...PAUL });
    await b.page.evaluate(() => { window.__etat.appelGsm = { etat: 'enLigne', sortant: true }; }); // Android : l'appel est toujours là
    await b.avancer(140000);
    await b.page.evaluate(() => { window.__etat.appelGsm = {}; });
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

test('SOS : « Annuler » rassure Mamie (« C’est annulé ») 3 s, un toucher ferme tout de suite, rien ne part', async () => {
  const b = await tablette({});
  try {
    await b.page.evaluate(() => { window.__sos = []; window.papoteCallFamily = (o) => { window.__sos.push(o); return { hangup() {} }; }; });
    await b.toucher('#sos-btn');
    await b.avancer(1000);
    await b.toucher('.sos-cancel');
    await b.avancer(300);
    assert.ok(await b.visible('.sos-annule'), 'message affiché');
    assert.match(await b.page.evaluate(() => document.querySelector('.sos-annule').textContent), /annulé.*Personne n’a été prévenu/);
    await b.avancer(3200);
    assert.ok(!(await b.visible('.call-out')), 'accueil au bout de 3 s');
    // Deuxième fois : un toucher ferme aussitôt.
    await b.toucher('#sos-btn');
    await b.toucher('.sos-cancel');
    await b.toucher('.sos-annule-zone');
    await b.avancer(200);
    assert.ok(!(await b.visible('.call-out')), 'fermé au toucher');
    await b.avancer(10000);
    assert.strictEqual(await b.page.evaluate(() => window.__sos.length), 0, 'aucun appel');
    assert.strictEqual((await b.appels('sendSms')).length, 0, 'aucun SMS');
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

// Depuis le 05/11 (Tanguy), l'écran verrouillé a son propre bouton SOS (ecrans.test.js) : ici, un toucher
// ailleurs sur l'écran verrouillé ne déclenche rien.
test('SOS (F-a) : tablette verrouillée (perdue) : un toucher hors du bouton SOS ne déclenche rien', async () => {
  const b = await tablette({}, { subscription: 'suspendu', perdue: true });
  try {
    const dessous = await b.page.evaluate(() => document.elementFromPoint(640, 400).closest('.perdue-screen') !== null);
    assert.ok(dessous, 'écran verrouillé au-dessus de tout');
    await b.page.mouse.click(640, 60);
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

// Audit Fable (5/11) : sans SMS parti (pas de carte SIM, pas de réseau), l'écran ne dit jamais que la famille l'a reçu.
test('SOS : SMS pas parti, jamais « La famille a reçu votre SOS »', async () => {
  const b = await tablette({ smsKo: true });
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    assert.strictEqual((await b.appels('sendSms')).length, 1, 'le SMS a été tenté');
    assert.doesNotMatch(await ecran(b), /reçu/i, 'pas de « reçu » sans SMS');
  } finally { await b.fermer(); }
});

test('SOS : SMS parti, l’écran le dit', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    assert.match(await ecran(b), /reçu votre SOS par SMS/);
  } finally { await b.fermer(); }
});

// Ordre d'appel du SOS choisi dans l'app (families/{fid}.sosOrdre, Tanguy 18/11).
test('SOS : ordre choisi dans l\'app (Marc puis Julie) : Marc appelé en premier, puis Julie, puis Paul', async () => {
  const b = await tablette();
  try {
    // Un uid inconnu (proche parti) est ignoré ; Paul, absent de la liste, vient à la suite.
    await b.android('onFamily', { ...PROCHES, sosOrdre: ['marc', 'parti', 'julie'] });
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    assert.deepStrictEqual(await appelsTel(b), ['0611111111'], 'Marc d\'abord');
    const MARC = { sortant: true, numero: '0611111111', uid: 'marc', name: 'Marc' };
    await b.android('onGsm', { etat: 'appel', ...MARC });
    await b.avancer(46000);
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...MARC });
    await b.avancer(2000);
    assert.deepStrictEqual(await appelsTel(b), ['0611111111', '0612345678'], 'puis Julie');
  } finally { await b.fermer(); }
});

test('SOS : ordre retiré dans l\'app (sosOrdre null) : retour à l\'ordre par défaut, responsable d\'abord', async () => {
  const b = await tablette();
  try {
    await b.android('onFamily', { ...PROCHES, sosOrdre: ['marc'] });
    await b.android('onFamily', { ...PROCHES, sosOrdre: null });
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    assert.deepStrictEqual(await appelsTel(b), ['0700000000']);
  } finally { await b.fermer(); }
});

// Tanguy, 27/11 (revue des règles, grande famille) : SMS à tous, appels aux 5 premiers seulement.
test('SOS, 7 proches : le SMS part aux 7, les 5 premiers sont appelés, puis la ligne est libre', async () => {
  const b = await tablette();
  try {
    const sept = ['Alice', 'Bruno', 'Chloé', 'David', 'Emma', 'Fanny', 'Gaël'].map((name, i) => ({ uid: 'p' + i, name, tel: '060000000' + i, responsable: i === 0 }));
    await b.android('onFamily', { faces: {}, birthdays: [], people: sept });
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    const sms = await b.appels('sendSms');
    assert.strictEqual(sms.length, 1);
    assert.strictEqual(sms[0].args[0].split(',').length, 7, 'SMS aux 7');
    for (let i = 0; i < 6; i++) {
      await b.avancer(19000); // sans réponse : raccroché à 18 s
      await b.android('onGsm', { etat: 'fin', sortant: true, cause: 'raccroche' });
      await b.avancer(1000);
    }
    assert.deepStrictEqual(await appelsTel(b), ['0600000000', '0600000001', '0600000002', '0600000003', '0600000004'], 'les 5 premiers, pas les 2 derniers');
    assert.ok((await b.appels('logAppel')).some((a) => /SMS à 7 proches, appels aux 5 premiers/.test(a.args[0])), 'journal');
  } finally { await b.fermer(); }
});
