// Appels de Mamie par la carte SIM (appel ordinaire et SOS), règles choisies par Tanguy le 19/11 après
// les mesures sur T-003 (carte Sosh) :
//  - sans réponse au bout de 18 s : la tablette raccroche (la messagerie arrive au plus tôt à 20,2 s) ;
//  - « en ligne » en moins de 4,5 s : messagerie d'un téléphone éteint, la tablette raccroche ;
//  - les deux délais se règlent à distance (families/{fid}.reglagesAppel) ;
//  - pendant un SOS, « Raccrocher » arrête tout : l'appel en cours et les proches suivants.
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

async function tablette(etat = {}, famille = {}) {
  const b = await ouvrir('2026-11-19T10:00:00', { telephone: true, ...etat });
  await b.android('onPosts', lot([], { options: { sos: true } }));
  await b.android('onFamily', { ...PROCHES, ...famille });
  await b.avancer(8000);
  // Appel par internet imité : chaque départ est noté, avec de quoi lui envoyer un état plus tard.
  await b.page.evaluate(() => {
    window.__internet = [];
    window.__raccrochesInternet = 0;
    window.papoteCallFamily = (o) => {
      window.__internet.push(o.sos || o.to);
      window.__etatInternet = o.onState;
      return { hangup() { window.__raccrochesInternet++; } };
    };
  });
  return b;
}
const choisir = (b, prenom) => b.page.evaluate((p) => [...document.querySelectorAll('.call-person')].find((e) => e.textContent.includes(p)).click(), prenom);
const numeros = async (b) => (await b.appels()).filter((a) => a.nom === 'phoneCall' || a.nom === 'phoneCallSos').map((a) => a.args[0]);
const raccroches = async (b) => (await b.appels('phoneHangup')).length;
const journal = async (b) => (await b.appels('logAppel')).map((a) => a.args[0]);
const ecran = async (b) => (await b.texte('.call-out')).replace(/\s+/g, ' ').trim();
const appelNormal = async (b, prenom) => { await b.toucher('#view-home .call-btn'); await choisir(b, prenom); };
const sos = async (b) => { await b.toucher('#sos-btn'); await b.avancer(5100); }; // décompte de 5 s, puis l'appel part
async function sansErreur(b) {
  const erreurs = (await b.appels('logError')).map((a) => a.args[0]);
  assert.deepStrictEqual(erreurs, [], 'aucune erreur de la page');
}

// ---------- Messagerie directe (« en ligne » avant 4,5 s) ----------

test('appel ordinaire : « en ligne » au bout de 3 s = messagerie d’un téléphone éteint : raccroché, jamais « En ligne »', async () => {
  const b = await tablette();
  try {
    await appelNormal(b, 'Julie');
    await b.android('onGsm', { etat: 'appel', ...JULIE });
    await b.avancer(3000);
    await b.android('onGsm', { etat: 'enLigne', ...JULIE });
    assert.strictEqual(await raccroches(b), 1, 'raccroché tout de suite');
    assert.doesNotMatch(await ecran(b), /En ligne/, 'Mamie ne voit jamais « En ligne avec Julie »');
    assert.match((await journal(b))[0], /Appel : Julie « en ligne » en 3[.,]\d s, messagerie directe, raccroché$/);
    // Android redit « en ligne » avant d'avoir raccroché : toujours rien.
    await b.android('onGsm', { etat: 'enLigne', ...JULIE });
    assert.strictEqual(await raccroches(b), 1, 'un seul raccrochage');
    assert.doesNotMatch(await ecran(b), /En ligne/);
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...JULIE });
    assert.match(await ecran(b), /Julie n’a pas pu répondre/);
    await b.avancer(4500);
    assert.match(await ecran(b), /Qui voulez-vous appeler/, 'retour à la liste');
    assert.deepStrictEqual(await numeros(b), ['0612345678'], 'personne d’autre appelé');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('appel ordinaire : décroché à 4,4 s = messagerie ; à 4,7 s (le plus rapide mesuré) = Julie, « En ligne »', async () => {
  let b = await tablette();
  try {
    await appelNormal(b, 'Julie');
    await b.avancer(4400);
    await b.android('onGsm', { etat: 'enLigne', ...JULIE });
    assert.strictEqual(await raccroches(b), 1, '4,4 s : raccroché');
    assert.doesNotMatch(await ecran(b), /En ligne/);
  } finally { await b.fermer(); }
  b = await tablette();
  try {
    await appelNormal(b, 'Julie');
    await b.avancer(4700);
    await b.android('onGsm', { etat: 'enLigne', ...JULIE });
    assert.strictEqual(await raccroches(b), 0, '4,7 s : pas raccroché');
    assert.match(await ecran(b), /En ligne avec Julie/);
    // Une vraie conversation n'est jamais coupée par la tablette, même longue.
    await b.avancer(10 * 60000);
    assert.strictEqual(await raccroches(b), 0, 'toujours en ligne 10 min après');
    assert.deepStrictEqual(await journal(b), [], 'rien de noté');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS : la messagerie de Paul (téléphone éteint) décroche à 2 s : raccroché, Julie appelée, sans attendre', async () => {
  const b = await tablette();
  try {
    await sos(b);
    assert.deepStrictEqual(await numeros(b), ['0700000000']);
    await b.android('onGsm', { etat: 'appel', ...PAUL });
    await b.avancer(2000);
    await b.android('onGsm', { etat: 'enLigne', ...PAUL });
    assert.strictEqual(await raccroches(b), 1);
    assert.doesNotMatch(await ecran(b), /En ligne/);
    assert.match((await journal(b))[0], /SOS : Paul « en ligne » en 2[.,]\d s, messagerie directe, raccroché, proche suivant/);
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    await b.avancer(600);
    assert.deepStrictEqual(await numeros(b), ['0700000000', '0612345678'], 'Julie tout de suite après');
    assert.match(await ecran(b), /SOS : on appelle Julie/);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

// ---------- Sans réponse (18 s) ----------

test('SOS : Paul ne répond pas : raccroché entre 17 et 19 s (plus 45 s), puis Julie, puis Marc', async () => {
  const b = await tablette();
  try {
    await sos(b);
    await b.android('onGsm', { etat: 'appel', ...PAUL });
    await b.avancer(17000);
    assert.strictEqual(await raccroches(b), 0, 'pas encore à 17 s');
    assert.match(await ecran(b), /SOS : ça sonne chez Paul/);
    await b.avancer(2000);
    assert.strictEqual(await raccroches(b), 1, 'raccroché à 18 s');
    assert.match((await journal(b))[0], /SOS : Paul sans réponse après 18 s, raccroché, proche suivant/);
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    await b.avancer(600);
    assert.deepStrictEqual(await numeros(b), ['0700000000', '0612345678']);
    await b.android('onGsm', { etat: 'appel', ...JULIE });
    await b.avancer(19000);
    assert.strictEqual(await raccroches(b), 2, 'Julie : 18 s aussi');
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...JULIE });
    await b.avancer(600);
    assert.deepStrictEqual(await numeros(b), ['0700000000', '0612345678', '0611111111'], 'Marc ensuite');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('sans réponse : le délai ne repart pas de zéro quand Android annonce « ça sonne » plus tard', async () => {
  const b = await tablette();
  try {
    await appelNormal(b, 'Julie');
    await b.avancer(10000);
    await b.android('onGsm', { etat: 'appel', ...JULIE }); // réseau lent : « ça sonne » dit tard
    await b.avancer(7000);
    assert.strictEqual(await raccroches(b), 0, '17 s depuis le départ');
    await b.avancer(2000);
    assert.strictEqual(await raccroches(b), 1, '18 s depuis le départ de l’appel, pas depuis « ça sonne »');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

// ---------- Réglage à distance ----------

test('réglage à distance : 12 s sans réponse et règle de la messagerie coupée (0)', async () => {
  const b = await tablette({}, { reglagesAppel: { sansReponseMs: 12000, messagerieMs: 0 } });
  try {
    await appelNormal(b, 'Julie');
    await b.avancer(2000);
    await b.android('onGsm', { etat: 'enLigne', ...JULIE });
    assert.strictEqual(await raccroches(b), 0, 'règle coupée : un décroché à 2 s est gardé');
    assert.match(await ecran(b), /En ligne avec Julie/);
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...JULIE });
    await b.avancer(5000);
    await b.vider();
    await appelNormal(b, 'Julie');
    await b.avancer(11000);
    assert.strictEqual(await raccroches(b), 0);
    await b.avancer(2000);
    assert.strictEqual(await raccroches(b), 1, 'raccroché à 12 s');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('réglage à distance : valeurs folles bornées (10 à 45 s, 0 à 8 s) ; réglage retiré : retour à 18 s et 4,5 s', async () => {
  const b = await tablette({}, { reglagesAppel: { sansReponseMs: 500, messagerieMs: 60000 } });
  try {
    await appelNormal(b, 'Julie');
    await b.avancer(9000);
    assert.strictEqual(await raccroches(b), 0, 'jamais avant 10 s');
    await b.avancer(2000);
    assert.strictEqual(await raccroches(b), 1, 'raccroché à 10 s (plancher)');
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...JULIE });
    await b.avancer(5000);
    await b.vider();
    await appelNormal(b, 'Julie');
    await b.avancer(8500);
    await b.android('onGsm', { etat: 'enLigne', ...JULIE });
    assert.strictEqual(await raccroches(b), 0, 'messagerie directe : 8 s au plus, un décroché à 8,5 s est gardé');
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...JULIE });
    await b.avancer(5000);
    // Réglage retiré (ou jamais posé), texte à la place d'un nombre : valeurs par défaut.
    await b.android('onFamily', { ...PROCHES, reglagesAppel: null });
    await b.vider();
    await appelNormal(b, 'Julie');
    await b.avancer(17000);
    assert.strictEqual(await raccroches(b), 0);
    await b.avancer(2000);
    assert.strictEqual(await raccroches(b), 1, 'retour à 18 s');
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...JULIE });
    await b.avancer(5000);
    await b.android('onFamily', { ...PROCHES, reglagesAppel: { sansReponseMs: 'vite', messagerieMs: null } });
    await b.vider();
    await appelNormal(b, 'Julie');
    await b.avancer(3000);
    await b.android('onGsm', { etat: 'enLigne', ...JULIE });
    assert.strictEqual(await raccroches(b), 1, 'valeur illisible : 4,5 s par défaut');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

// ---------- « Raccrocher » pendant un SOS : tout s'arrête ----------

test('SOS : « Raccrocher » pendant que ça sonne chez Paul : raccroché, plus personne n’est appelé', async () => {
  const b = await tablette();
  try {
    await sos(b);
    await b.android('onGsm', { etat: 'appel', ...PAUL });
    await b.avancer(6000);
    await b.toucher('.call-hangup');
    assert.strictEqual(await raccroches(b), 1);
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    assert.match(await ecran(b), /Appel terminé/);
    await b.avancer(4500);
    assert.ok(!(await b.visible('.call-out')), 'retour à l’accueil');
    await b.avancer(5 * 60000);
    assert.deepStrictEqual(await numeros(b), ['0700000000'], 'ni Julie ni Marc');
    assert.deepStrictEqual(await b.page.evaluate(() => window.__internet), [], 'pas d’appel par internet non plus');
    assert.strictEqual(await raccroches(b), 1, 'aucun raccrochage de plus');
    assert.ok((await journal(b)).some((l) => /SOS : arrêté par « Raccrocher »/.test(l)));
    assert.strictEqual(await b.page.evaluate(() => Object.keys(localStorage).filter((k) => /sos/i.test(k) && !/sms/i.test(k)).length), 0, 'rien gardé pour une reprise');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS : « Raccrocher » sur une messagerie (en ligne depuis 10 s) : tout s’arrête, pas de proche suivant', async () => {
  const b = await tablette();
  try {
    await sos(b);
    await b.avancer(6000);
    await b.android('onGsm', { etat: 'enLigne', ...PAUL });
    assert.match(await ecran(b), /En ligne avec Paul/);
    await b.avancer(10000);
    await b.toucher('.call-hangup');
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    await b.avancer(60000);
    assert.deepStrictEqual(await numeros(b), ['0700000000']);
    assert.ok(!(await b.visible('.call-out')));
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS : double appui sur « Raccrocher » : un seul raccrochage, un seul arrêt', async () => {
  const b = await tablette();
  try {
    await sos(b);
    await b.android('onGsm', { etat: 'appel', ...PAUL });
    await b.avancer(3000);
    await b.page.evaluate(() => { const h = document.querySelector('.call-hangup'); h.click(); h.click(); });
    assert.strictEqual(await raccroches(b), 1);
    assert.strictEqual((await journal(b)).filter((l) => /arrêté/.test(l)).length, 1);
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    await b.avancer(60000);
    assert.deepStrictEqual(await numeros(b), ['0700000000']);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS : « Raccrocher » alors qu’Android n’a déjà plus d’appel (entre deux proches) : la chaîne s’arrête quand même', async () => {
  const b = await tablette();
  try {
    await sos(b);
    await b.android('onGsm', { etat: 'appel', ...PAUL });
    await b.avancer(19000); // Paul sans réponse : raccroché à 18 s
    await b.etat({ telephoneKo: true, raccrocherKo: true }); // la ligne se libère : l'appel de Julie attend
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    await b.avancer(700);
    assert.match(await ecran(b), /SOS : on appelle Julie/);
    await b.toucher('.call-hangup');
    await b.etat({ telephoneKo: false });
    await b.avancer(60000);
    assert.ok(!(await numeros(b)).includes('0611111111'), 'Marc jamais appelé');
    assert.ok(!(await b.visible('.call-out')), 'écran fermé');
    const tel = await numeros(b);
    await b.avancer(60000);
    assert.deepStrictEqual(await numeros(b), tel, 'plus aucun appel ensuite');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS par internet (tablette sans carte SIM) : « Raccrocher » arrête tout, pas de 2e essai', async () => {
  const b = await tablette({ telephone: false });
  try {
    await sos(b);
    assert.deepStrictEqual(await b.page.evaluate(() => window.__internet), [1], '1er essai par internet');
    await b.page.evaluate(() => window.__etatInternet('ringing', { names: ['Paul', 'Julie'] }));
    assert.match(await ecran(b), /Ça sonne/);
    await b.toucher('.call-hangup');
    assert.strictEqual(await b.page.evaluate(() => window.__raccrochesInternet), 1, 'appel internet raccroché');
    assert.ok(!(await b.visible('.call-out')), 'écran fermé');
    // L'appel abandonné finit par dire « personne n'a répondu » : pas de 2e essai pour autant.
    await b.page.evaluate(() => window.__etatInternet('missed', {}));
    await b.avancer(5 * 60000);
    assert.deepStrictEqual(await b.page.evaluate(() => window.__internet), [1], 'pas de 2e essai');
    assert.ok(!(await b.visible('.call-out')));
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('appel ordinaire (témoin) : « Raccrocher » raccroche comme avant, et un SOS lancé ensuite part normalement', async () => {
  const b = await tablette();
  try {
    await appelNormal(b, 'Julie');
    await b.avancer(6000);
    await b.android('onGsm', { etat: 'enLigne', ...JULIE });
    await b.toucher('.call-hangup');
    assert.strictEqual(await raccroches(b), 1);
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...JULIE });
    assert.match(await ecran(b), /Appel terminé/);
    await b.avancer(5000);
    assert.deepStrictEqual((await journal(b)).filter((l) => /SOS/.test(l)), [], 'aucune ligne de SOS');
    await b.vider();
    await sos(b);
    assert.deepStrictEqual(await numeros(b), ['0700000000'], 'le SOS appelle Paul');
    await sansErreur(b);
  } finally { await b.fermer(); }
});
