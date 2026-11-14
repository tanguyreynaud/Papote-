// SOS (A47, décision de Tanguy 12/11) : la chaîne du SOS survit à une relance de la page (chien de garde,
// onRenderProcessGone, relance de Papote) ; pas de deuxième SMS dans les 10 min ; sans réseau téléphonique,
// internet 15 s puis la carte SIM dès qu'elle peut ; bouton SOS toujours là, même sous la carte « Pas de réseau ».
// La relance est imitée par un vrai rechargement de la page (même navigateur : localStorage gardé, comme la
// WebView de la tablette) ; Android (phoneState, phoneReady) est imité par banc.js.
// Lancement : node --test android/tests/
const test = require('node:test');
const assert = require('node:assert');
const { ouvrir, lot, envoi } = require('./banc');

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

// Appel internet imité, posé avant chaque chargement : chaque départ (sos 1 ou 2) et chaque abandon notés ;
// window.__fin(etat) fait répondre (ou non) la famille au dernier appel.
function imiterInternet() {
  window.__internet = [];
  window.papoteCallFamily = (o) => {
    window.__internet.push(o.sos || o.to);
    window.__dernier = o;
    return {
      hangup() { window.__internet.push('raccroche'); },
      abandon() { window.__internet.push('abandon'); o.onState('missed', {}); },
    };
  };
  window.__fin = (etat) => window.__dernier && window.__dernier.onState(etat, {});
}

async function donnees(b, champs = {}) {
  await b.android('onPosts', lot([], champs));
  await b.android('onFamily', PROCHES);
}

async function tablette(etat = {}, champs = {}) {
  const b = await ouvrir('2026-10-26T10:00:00', { telephone: true, ...etat });
  await b.page.addInitScript(imiterInternet);
  await b.page.evaluate(imiterInternet);
  await donnees(b, champs);
  await b.avancer(8000); // l'écran de démarrage s'efface
  return b;
}

// Relance de Papote pendant le SOS : la page repart de zéro, Android lui redonne ses données.
// etatAndroid : ce qu'Android dit après la relance (appel SIM en cours : appelGsm).
async function relancer(b, etatAndroid = {}) {
  await b.page.addInitScript((x) => Object.assign(window.__etat, x), etatAndroid);
  await b.page.reload();
  await donnees(b);
  await b.avancer(2500); // resumeGsm : 1,5 s après le démarrage
}

const appelsTel = async (b) => (await b.appels('phoneCall')).map((a) => a.args[0]);
const internet = (b) => b.page.evaluate(() => window.__internet);
const ecran = async (b) => (await b.texte('.call-out')).replace(/\s+/g, ' ').trim();
const sos = (b) => b.page.evaluate(() => JSON.parse(localStorage.getItem('papote.sos') || 'null'));
async function sansErreur(b) {
  const erreurs = (await b.appels('erreurJS')).concat(await b.appels('logError'));
  assert.deepStrictEqual(erreurs, [], 'erreurs JavaScript');
}

// ---------- 1. Reprise après une relance ----------

test('A47-1 : relance pendant que ça sonne chez Paul : l’appel reste un appel de SOS, puis Julie', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    assert.deepStrictEqual(await appelsTel(b), ['0700000000']);
    await b.android('onGsm', { etat: 'appel', ...PAUL });
    await relancer(b, { appelGsm: { etat: 'appel', ...PAUL } });
    assert.match(await ecran(b), /SOS : ça sonne chez Paul/, 'écran de SOS, pas « Ça sonne… Chez Paul »');
    assert.ok(await b.page.evaluate(() => /\bsos\b/.test(document.querySelector('.call-out').className)));
    assert.strictEqual((await b.appels('sendSms')).length, 0, 'pas de deuxième SMS');
    assert.deepStrictEqual(await appelsTel(b), [], 'Paul pas rappelé : l’appel est toujours là');
    assert.strictEqual((await b.appels('sosDemarre')).length, 1, 'pause de l’abonnement de nouveau levée côté Android');
    // Paul ne répond pas : la chaîne continue vers Julie, comme sans relance.
    await b.etat({ appelGsm: {} });
    await b.android('onGsm', { etat: 'fin', cause: 'manque', ...PAUL });
    await b.avancer(600);
    assert.deepStrictEqual(await appelsTel(b), ['0612345678'], 'Julie appelée ensuite');
    assert.match(await ecran(b), /SOS : on appelle Julie/);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A47-1 : Android redonne l’appel en cours avant la reprise (onGsm « appel ») : toujours un appel de SOS', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    await b.android('onGsm', { etat: 'appel', ...PAUL });
    await b.page.addInitScript(() => { window.__etat.appelGsm = { etat: 'appel', sortant: true, numero: '0700000000', uid: 'paul', name: 'Paul' }; });
    await b.page.reload();
    await donnees(b);
    await b.android('onGsm', { etat: 'appel', ...PAUL }); // AppelGsm.ecouter rejoue le dernier état
    assert.match(await ecran(b), /SOS : ça sonne chez Paul/);
    await b.avancer(2500);
    assert.match(await ecran(b), /SOS : ça sonne chez Paul/, 'la reprise ne le double pas');
    assert.deepStrictEqual(await appelsTel(b), []);
    // 45 s sans réponse : la tablette raccroche, Julie ensuite.
    await b.avancer(45000);
    assert.strictEqual((await b.appels('phoneHangup')).length, 1, 'Paul raccroché au bout de 45 s');
    await b.etat({ appelGsm: {} });
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    await b.avancer(600);
    assert.deepStrictEqual(await appelsTel(b), ['0612345678']);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A47-1 : la messagerie de Paul « décroche » puis relance : la chaîne continue (pas « Appel terminé »)', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    await b.android('onGsm', { etat: 'appel', ...PAUL });
    await b.avancer(3000);
    await b.android('onGsm', { etat: 'enLigne', ...PAUL });
    await relancer(b, { appelGsm: { etat: 'enLigne', ...PAUL } });
    assert.match(await ecran(b), /En ligne avec Paul/);
    await b.avancer(10000);
    await b.etat({ appelGsm: {} });
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    await b.avancer(600);
    assert.deepStrictEqual(await appelsTel(b), ['0612345678'], '15 s en ligne : messagerie, Julie appelée');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A47-1 : l’appel de Paul s’est fini pendant la relance : Julie est appelée, sans nouveau SMS', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    await b.android('onGsm', { etat: 'appel', ...PAUL });
    await relancer(b, { appelGsm: {} });
    assert.strictEqual((await b.appels('sendSms')).length, 0);
    assert.deepStrictEqual(await appelsTel(b), ['0612345678']);
    assert.match(await ecran(b), /SOS : on appelle Julie/);
    assert.match(await ecran(b), /reçu votre SOS par SMS/, 'le SMS parti avant la relance compte toujours');
    // Julie et Marc ne répondent pas : l'appel par internet (2e essai, alerte du serveur), comme sans relance.
    for (const p of [JULIE, { sortant: true, numero: '0611111111', uid: 'marc', name: 'Marc' }]) {
      await b.android('onGsm', { etat: 'fin', cause: 'manque', ...p });
      await b.avancer(600);
    }
    assert.deepStrictEqual(await internet(b), [2], 'puis l’appel par internet (2e essai)');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A47-1 : relance pendant le décompte : le décompte revient (Annuler possible), puis l’appel part une fois', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(2000);
    await relancer(b);
    assert.ok(await b.visible('.sos-cancel'), 'décompte et « Annuler » de nouveau');
    await b.avancer(5500);
    assert.deepStrictEqual(await appelsTel(b), ['0700000000']);
    assert.strictEqual((await b.appels('sendSms')).length, 1, 'un SMS (aucun n’était parti)');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A47-1 : SOS par internet (sans carte SIM) relancé : l’essai reprend, puis le 2e essai', async () => {
  const b = await tablette({ telephone: false });
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    assert.deepStrictEqual(await internet(b), [1]);
    await relancer(b);
    assert.deepStrictEqual(await internet(b), [1], 'l’essai 1 repart après la relance');
    await b.page.evaluate(() => window.__fin('missed'));
    assert.deepStrictEqual(await internet(b), [1, 2]);
    await b.page.evaluate(() => window.__fin('missed'));
    assert.match(await ecran(b), /La famille est prévenue/);
    assert.strictEqual(await sos(b), null, 'SOS terminé : plus rien à reprendre');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A47-1 : un SOS de plus de 5 minutes n’est pas repris ; « Annuler » ne laisse rien à reprendre', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    await b.page.evaluate(() => {
      const e = JSON.parse(localStorage.getItem('papote.sos'));
      e.maj -= 6 * 60000; e.debut -= 6 * 60000;
      localStorage.setItem('papote.sos', JSON.stringify(e));
    });
    await relancer(b, { appelGsm: {} });
    assert.deepStrictEqual(await appelsTel(b), [], 'rien ne repart');
    assert.ok(!(await b.visible('.call-out')), 'accueil');
    assert.strictEqual(await sos(b), null);
    await b.toucher('#sos-btn');
    await b.toucher('.sos-cancel');
    assert.strictEqual(await sos(b), null, 'annulé : rien de gardé');
    await relancer(b);
    assert.ok(!(await b.visible('.call-out')));
    await sansErreur(b);
  } finally { await b.fermer(); }
});

// ---------- 2. Appuis répétés : un SMS par 10 minutes ----------

test('A47-2 : deuxième SOS 2 min après le premier (et après une relance) : pas de nouveau SMS, les appels repartent', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    assert.strictEqual((await b.appels('sendSms')).length, 1);
    // Paul répond pour de vrai : SOS fini.
    await b.android('onGsm', { etat: 'enLigne', ...PAUL });
    await b.avancer(60000);
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    await b.avancer(5000);
    assert.ok(!(await b.visible('.call-out')));
    await b.vider();
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    assert.strictEqual((await b.appels('sendSms')).length, 0, 'pas de 2e SMS');
    assert.deepStrictEqual(await appelsTel(b), ['0700000000'], 'Paul rappelé quand même');
    assert.match(await ecran(b), /reçu votre SOS par SMS/, 'la famille a bien le SMS d’il y a 2 min');
    // Relance de Papote : l'heure du dernier SMS est gardée.
    await b.android('onGsm', { etat: 'enLigne', ...PAUL });
    await b.avancer(45000);
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    await b.avancer(5000);
    await relancer(b, { appelGsm: {} });
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    assert.strictEqual((await b.appels('sendSms')).length, 0, 'toujours pas de 2e SMS après la relance');
    assert.deepStrictEqual(await appelsTel(b), ['0700000000']);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A47-2 : nouveau SOS 11 min après : le SMS repart ; SMS pas parti la 1re fois : retenté à l’appui suivant', async () => {
  const b = await tablette({ smsKo: true });
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    assert.strictEqual((await b.appels('sendSms')).length, 1);
    await b.android('onGsm', { etat: 'enLigne', ...PAUL });
    await b.avancer(45000);
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    await b.avancer(5000);
    await b.etat({ smsKo: false });
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    assert.strictEqual((await b.appels('sendSms')).length, 2, 'le SMS raté est retenté');
    await b.android('onGsm', { etat: 'enLigne', ...PAUL });
    await b.avancer(45000);
    await b.android('onGsm', { etat: 'fin', cause: 'raccroche', ...PAUL });
    await b.avancer(11 * 60000);
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    assert.strictEqual((await b.appels('sendSms')).length, 3, '11 min après : nouveau SMS');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

// ---------- 4. Pas de réseau téléphonique ----------

const SIM_SANS_RESEAU = { telephone: false, reseau: { wifi: 'Box', internet: true, mobile: false, sim: true } };

test('A47-4 : pas de réseau téléphonique : internet 15 s, puis la carte SIM dès que le réseau revient', async () => {
  const b = await tablette(SIM_SANS_RESEAU);
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    assert.deepStrictEqual(await internet(b), [1], 'SOS par internet d’abord');
    assert.strictEqual((await b.appels('sendSms')).length, 0);
    await b.avancer(14000);
    assert.deepStrictEqual(await internet(b), [1], 'pas abandonné avant 15 s');
    await b.avancer(1500);
    assert.deepStrictEqual(await internet(b), [1, 'abandon', 2], 'abandonné à 15 s, 2e essai (alerte) en attendant');
    // Le réseau téléphonique revient : SMS et appels par la carte SIM, l'appel internet est laissé.
    await b.etat({ telephone: true });
    await b.avancer(3500);
    assert.deepStrictEqual(await internet(b), [1, 'abandon', 2, 'abandon']);
    assert.strictEqual((await b.appels('sendSms')).length, 1, 'SMS de SOS');
    assert.deepStrictEqual(await appelsTel(b), ['0700000000'], 'Paul appelé par la carte SIM');
    assert.match(await ecran(b), /SOS : on appelle Paul/);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A47-4 : le réseau téléphonique revient pendant les 15 s : la carte SIM tout de suite', async () => {
  const b = await tablette(SIM_SANS_RESEAU);
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    await b.avancer(4000);
    await b.etat({ telephone: true });
    await b.avancer(3500);
    assert.deepStrictEqual(await internet(b), [1, 'abandon']);
    assert.deepStrictEqual(await appelsTel(b), ['0700000000']);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A47-4 : quelqu’un décroche sur internet avant 15 s : pas d’abandon, pas d’appel SIM', async () => {
  const b = await tablette(SIM_SANS_RESEAU);
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500);
    await b.page.evaluate(() => window.__fin('connected'));
    await b.avancer(20000);
    await b.etat({ telephone: true });
    await b.avancer(5000);
    assert.deepStrictEqual(await internet(b), [1]);
    assert.deepStrictEqual(await appelsTel(b), []);
    assert.match(await ecran(b), /En ligne avec/);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A47-4 : personne sur internet, toujours pas de réseau : la famille est prévenue, puis la carte SIM 3 min après (même après une relance)', async () => {
  const b = await tablette(SIM_SANS_RESEAU);
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500 + 15500);
    await b.page.evaluate(() => window.__fin('missed')); // 2e essai sans réponse : alerte du serveur
    assert.match(await ecran(b), /La famille est prévenue/);
    await b.avancer(10000);
    assert.ok(!(await b.visible('.call-out')), 'retour à l’accueil');
    await relancer(b);
    assert.strictEqual((await sos(b)).phase, 'attente-gsm', 'toujours en attente du réseau téléphonique');
    await b.avancer(3 * 60000);
    assert.deepStrictEqual(await appelsTel(b), []);
    await b.etat({ telephone: true });
    await b.avancer(3500);
    assert.strictEqual((await b.appels('sendSms')).length, 1);
    assert.deepStrictEqual(await appelsTel(b), ['0700000000']);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A47-4 : l’attente du réseau téléphonique s’arrête 10 min après l’appui', async () => {
  const b = await tablette(SIM_SANS_RESEAU);
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500 + 15500);
    await b.page.evaluate(() => window.__fin('missed'));
    await b.avancer(10 * 60000);
    await b.etat({ telephone: true });
    await b.avancer(5000);
    assert.deepStrictEqual(await appelsTel(b), []);
    assert.strictEqual(await sos(b), null);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A47-4 (témoin) : tablette sans carte SIM : l’appel internet n’est pas abandonné à 15 s', async () => {
  const b = await tablette({ telephone: false });
  try {
    await b.toucher('#sos-btn');
    await b.avancer(5500 + 20000);
    assert.deepStrictEqual(await internet(b), [1]);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

// ---------- 6. Bouton SOS toujours là ----------

async function sosDessus(b) {
  return b.page.evaluate(() => {
    const s = document.querySelector('#sos-btn');
    if (!s || s.hidden) return false;
    const r = s.getBoundingClientRect();
    if (r.width < 40 || r.height < 30) return false;
    const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!(e && e.closest('#sos-btn'));
  });
}

test('A47-6 : carte « Pas de réseau » (redémarrage sans réseau) : le bouton SOS reste visible et marche', async () => {
  const b = await ouvrir('2025-04-11T10:00:00', { telephone: true, reseau: { wifi: '', internet: false, mobile: false, sim: true } });
  try {
    await b.android('onPosts', lot([envoi({ seen: true })]));
    await b.android('onFamily', PROCHES);
    await b.avancer(8000);
    assert.ok(await b.visible('.sans-reseau'), 'carte « Pas de réseau »');
    assert.ok(await sosDessus(b), 'bouton SOS visible, rien par-dessus');
    const appeler = await b.page.evaluate(() => { const c = document.querySelector('#view-home .call-btn'); return !!c && c.getClientRects().length > 0; });
    assert.ok(!appeler, 'le reste du bloc de gauche s’efface toujours (Appeler)');
    await b.page.click('#sos-btn');
    await b.avancer(5500);
    assert.strictEqual((await b.appels('sendSms')).length, 1);
    assert.deepStrictEqual(await appelsTel(b), ['0700000000']);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('A47-6 : « Pas d’internet » et « Tablette débranchée » affichées : le bouton SOS reste dessus', async () => {
  const b = await ouvrir('2026-10-26T10:00:00', { telephone: true, secteur: false, reseau: { wifi: '', internet: false, mobile: false, sim: true } });
  try {
    await b.android('onPosts', lot([envoi({ seen: true })]));
    await b.android('onFamily', PROCHES);
    await b.avancer(80000);
    assert.ok(await b.visible('.net-banner'), 'étiquette « Pas d’internet »');
    assert.ok(await b.visible('.power-banner:not(.net-banner)'), 'étiquette « Tablette débranchée »');
    assert.ok(await sosDessus(b), 'bouton SOS visible, rien par-dessus');
    await b.page.click('#sos-btn');
    assert.ok(await b.visible('.sos-cancel'), 'décompte lancé');
    await sansErreur(b);
  } finally { await b.fermer(); }
});
