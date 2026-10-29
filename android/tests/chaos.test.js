// Garde-fous (29/10/2026) : la tablette ne reste jamais figée sur un écran d'appel ou de SOS.
// Essais « de chaos » : des événements dans le désordre (appel téléphone sans fin, fin en double,
// visio qui ne répond jamais, touchers au hasard, page rechargée en plein appel…), puis plus rien :
// l'accueil doit revenir tout seul, sans erreur JavaScript. Et une vraie conversation n'est jamais coupée.
// Lancement : node --test android/tests/
const test = require('node:test');
const assert = require('node:assert');
const { ouvrir, lot, envoi } = require('./banc');

const PROCHES = {
  faces: {}, birthdays: [],
  people: [
    { uid: 'julie', name: 'Julie', tel: '0612345678', responsable: true },
    { uid: 'anne', name: 'Anne', tel: '' }, // sans numéro : appelée par internet
  ],
};

const MIN = 60000;

// Appels par internet imités : papoteCallFamily ne répond jamais (bloqué), état réglable.
function visioImitee() {
  window.__visio = { etat: '', appels: 0, remises: 0, onState: null };
  window.papoteCallFamily = (o) => { window.__visio.appels++; window.__visio.onState = o.onState; window.__visio.etat = 'actif'; return { hangup() { window.__visio.etat = ''; } }; };
  window.papoteAppelsEtat = () => window.__visio.etat;
  window.papoteAppelsReset = () => { window.__visio.remises++; window.__visio.etat = ''; };
}

async function tablette(heure = '2026-10-26T10:00:00') {
  const b = await ouvrir(heure, { telephone: true });
  await b.page.evaluate(visioImitee);
  await b.android('onPosts', lot([]));
  await b.android('onFamily', PROCHES);
  await b.avancer(500);
  return b;
}

async function sansErreur(b) {
  const erreurs = (await b.appels('erreurJS')).concat(await b.appels('logError'));
  assert.deepStrictEqual(erreurs, [], 'erreurs JavaScript');
}

const ecranAppel = (b) => b.page.evaluate(() => {
  const vis = (e) => !!e && !e.hidden && !e.closest('[hidden]') && getComputedStyle(e).display !== 'none';
  const out = [...document.querySelectorAll('.call-out')].some(vis);
  return out || vis(document.getElementById('call-ring')) || vis(document.getElementById('call-view'));
});

const choisir = (b, prenom) => b.page.evaluate((p) => [...document.querySelectorAll('.call-person')].find((e) => e.textContent.includes(p)).click(), prenom);

test('Visio qui ne répond jamais : « Appel vers Anne… » se ferme tout seul après 3 min, noté dans le journal', async () => {
  const b = await tablette();
  try {
    await b.toucher('#view-home .call-btn');
    await choisir(b, 'Anne');
    assert.match(await b.texte('.call-out'), /Appel vers Anne/);
    await b.avancer(2 * MIN);
    assert.ok(await ecranAppel(b), 'encore là après 2 min');
    await b.avancer(2 * MIN);
    assert.ok(!(await ecranAppel(b)), 'retour à l’accueil');
    assert.ok(await b.visible('#view-home'));
    const notes = await b.appels('gardeFou');
    assert.strictEqual(notes.length, 1);
    assert.match(notes[0].args[0], /GARDE-FOU : écran bloqué 3 min/);
    assert.strictEqual(notes[0].args[1], true, 'journal envoyé tout de suite');
    assert.strictEqual(await b.page.evaluate(() => window.__visio.remises), 1, 'appels internet refermés');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('Une conversation téléphone de 20 min, écran immobile, n’est jamais coupée', async () => {
  const b = await tablette();
  try {
    await b.toucher('#view-home .call-btn');
    await choisir(b, 'Julie');
    await b.android('onGsm', { etat: 'appel', sortant: true, uid: 'julie', name: 'Julie' });
    await b.etat({ appelGsm: { etat: 'enLigne', sortant: true, uid: 'julie', name: 'Julie' } });
    await b.android('onGsm', { etat: 'enLigne', sortant: true, uid: 'julie', name: 'Julie' });
    await b.avancer(20 * MIN);
    assert.match(await b.texte('.call-out'), /En ligne avec Julie/);
    assert.strictEqual((await b.appels('gardeFou')).length, 0);
    assert.strictEqual((await b.appels('phoneHangup')).length, 0, 'jamais raccroché');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('Une visio en conversation depuis 20 min n’est jamais coupée', async () => {
  const b = await tablette();
  try {
    await b.toucher('#view-home .call-btn');
    await choisir(b, 'Anne');
    await b.page.evaluate(() => { window.__visio.etat = 'connecte'; window.__visio.onState('connected', { uid: 'anne', name: 'Anne' }); });
    await b.avancer(20 * MIN);
    assert.match(await b.texte('.call-out'), /En ligne avec Anne/);
    assert.strictEqual((await b.appels('gardeFou')).length, 0);
    assert.strictEqual(await b.page.evaluate(() => window.__visio.remises), 0);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('Le pouls part au démarrage puis toutes les 20 s (chien de garde Android)', async () => {
  const b = await tablette();
  try {
    const avant = (await b.appels('pouls')).length;
    assert.ok(avant >= 1, 'pouls au démarrage');
    await b.avancer(MIN);
    assert.strictEqual((await b.appels('pouls')).length - avant, 3);
  } finally { await b.fermer(); }
});

test('La nuit vers 3 h, la page repart à neuf (une fois), seulement si rien n’est en cours', async () => {
  const b = await tablette('2026-10-26T14:00:00');
  try {
    let chargements = 0;
    b.page.on('framenavigated', (f) => { if (f === b.page.mainFrame()) chargements++; });
    await b.page.clock.fastForward('12:59:00'); // 2 h 59
    await b.avancer(30 * 1000);
    assert.strictEqual(chargements, 0, 'pas avant 3 h');
    await b.avancer(2 * MIN);
    await new Promise((r) => setTimeout(r, 2000)); // le rechargement se fait après coup
    assert.strictEqual(chargements, 1, 'rechargée à 3 h');
    await b.page.evaluate(visioImitee);
    await b.android('onPosts', lot([]));
    await b.android('onFamily', PROCHES);
    await b.avancer(10 * MIN);
    await new Promise((r) => setTimeout(r, 2000));
    assert.strictEqual(chargements, 1, 'une seule fois');
  } finally { await b.fermer(); }
});

test('Pas de rechargement de nuit pendant un appel téléphone', async () => {
  const b = await tablette('2026-10-26T14:00:00');
  try {
    let chargements = 0;
    b.page.on('framenavigated', (f) => { if (f === b.page.mainFrame()) chargements++; });
    await b.page.clock.fastForward('12:50:00');
    await b.etat({ appelGsm: { etat: 'enLigne', sortant: false, uid: 'julie', name: 'Julie' } });
    await b.android('onGsm', { etat: 'sonne', uid: 'julie', name: 'Julie' });
    await b.android('onGsm', { etat: 'enLigne', uid: 'julie', name: 'Julie' });
    await b.avancer(20 * MIN);
    await new Promise((r) => setTimeout(r, 2000));
    assert.strictEqual(chargements, 0);
  } finally { await b.fermer(); }
});

// ---------- Chaos ----------

// Tirage reproductible (graine) : un échec se rejoue à l'identique.
function hasard(graine) {
  let s = graine >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

async function chaos(graine) {
  const r = hasard(graine);
  const un = (liste) => liste[Math.floor(r() * liste.length)];
  const b = await tablette();
  const journal = [];
  try {
    for (let i = 0; i < 120; i++) {
      const geste = un(['gsm', 'gsm', 'gsm', 'android', 'toucher', 'toucher', 'toucher', 'envoi', 'visio', 'temps', 'temps', 'recharger']);
      journal.push(geste);
      if (geste === 'gsm') {
        const qui = un([{ uid: 'julie', name: 'Julie' }, { uid: null, name: '' }]);
        await b.android('onGsm', { etat: un(['sonne', 'appel', 'enLigne', 'fin', 'fin', 'bidon']), sortant: r() < 0.5, cause: un(['occupe', 'erreur', 'raccroche', undefined]), ...qui });
      } else if (geste === 'android') {
        // Ce qu'Android répond à « où en est l'appel ? » : parfois un appel, souvent rien.
        await b.etat({ appelGsm: r() < 0.3 ? { etat: un(['appel', 'enLigne', 'sonne']), uid: 'julie', name: 'Julie' } : {} });
      } else if (geste === 'toucher') {
        await b.page.evaluate((x) => {
          const vis = (e) => !e.hidden && !e.closest('[hidden]') && getComputedStyle(e).display !== 'none' && !e.disabled;
          const boutons = [...document.querySelectorAll('.call-out button, #view-home button, #call-ring button, #overlay button, #call-view button')].filter(vis);
          if (boutons.length) boutons[Math.floor(x * boutons.length)].click();
        }, r());
      } else if (geste === 'envoi') {
        await b.android('onPosts', lot([envoi()]));
      } else if (geste === 'visio') {
        await b.page.evaluate((x) => {
          const v = window.__visio;
          if (!v.onState) return;
          const etats = ['ringing', 'connected', 'ended', 'missed', 'busy', 'failed'];
          const e = etats[Math.floor(x * etats.length)];
          v.etat = e === 'connected' ? 'connecte' : e === 'ringing' ? 'actif' : '';
          v.onState(e, { uid: 'anne', name: 'Anne' });
        }, r());
      } else if (geste === 'temps') {
        await b.avancer(Math.floor(r() * 70000));
      } else if (geste === 'recharger') {
        // Page rechargée en plein milieu (rechargement du chien de garde, mémoire…).
        await b.page.reload();
        await b.page.evaluate(visioImitee);
        await b.android('onPosts', lot([]));
        await b.android('onFamily', PROCHES);
      }
      await b.avancer(200);
    }
    // Plus rien : Android sans appel, aucune visio, personne ne touche l'écran.
    await b.etat({ appelGsm: {} });
    await b.page.evaluate(() => { window.__visio.etat = ''; });
    await b.avancer(5 * MIN);
    assert.ok(!(await ecranAppel(b)), `écran d'appel resté affiché (graine ${graine}, gestes : ${journal.join(' ')})`);
    await sansErreur(b);
  } finally { await b.fermer(); }
}

for (const graine of [1, 29, 1029, 2026, 77]) {
  test(`Chaos (graine ${graine}) : 120 événements dans le désordre, puis l’écran d’appel finit toujours par se fermer`, () => chaos(graine));
}
