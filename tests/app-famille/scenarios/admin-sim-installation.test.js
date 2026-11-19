// « Installer la carte SIM » dans « Préparer l'envoi » (Tanguy, 13/11) : par les vrais clics de l'admin, avec les
// vraies fonctions serveur (functions/sim-installation.js) et la tablette jouée par ses écritures dans son code
// (pairings/{code}.simTest, sous les vraies règles). Chaque état de la carte a son message en mots simples,
// « C'est fait » reste éteint tant que le serveur ne dit pas OK, un double appui n'envoie qu'un ordre, et l'ordre
// suit la tablette quand son code change avant la réponse.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

const { s, acteurs: a } = banc;
const GSTATIC = 'https://www.gstatic.com/firebasejs/12.19.0/';
const ICCID = '8933010000000004321';

banc.brancher();
test.after(() => g.fermerTablettes());

async function ouvrirAdmin(nom, hash) {
  await banc.admin.auth().createUser({ uid: a.TANGUY.uid, email: a.TANGUY.email, emailVerified: true, displayName: 'Tanguy' }).catch(() => {});
  const jeton = await banc.admin.auth().createCustomToken(a.TANGUY.uid, { admin: true });
  const t = await banc.telephone(nom, { largeur: 1280, hauteur: 900 });
  await t.context.route('**/version.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await t.page.goto(`${banc.origine}/admin.html${hash}`);
  await t.page.evaluate(async ({ jeton: j, G }) => {
    const { getApp } = await import(`${G}firebase-app.js`);
    const { getAuth, signInWithCustomToken } = await import(`${G}firebase-auth.js`);
    await signInWithCustomToken(getAuth(getApp('admin')), j);
  }, { jeton, G: GSTATIC });
  await t.page.locator('#dashboard').waitFor({ state: 'visible' });
  return t;
}

// Commande payée, tablette préparée reliée, carte SIM notée : la préparation reprend à « Installer la carte SIM ».
async function aLEtapeSim() {
  const tablette = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: 'claire@exemple.fr', nom: 'Claire Dupont', carte: true });
  await s.appeler('gestionStock', { action: 'modifier', id: tablette.fiche, champs: { commande: id } }, a.TANGUY);
  await s.appeler('gestionSim', { action: 'ajouter', champs: { statut: 'active', operateur: 'Orange', iccid: ICCID, numero: '07 45 00 00 11', prix: 299, tablette: tablette.fiche,
    blocages: { surtaxes: true, smsPlus: true, internetPlus: true, etranger: true } } }, a.TANGUY);
  const faits = { mode: Date.now(), tablette: Date.now(), sim: Date.now() };
  await s.appeler('gestionParcours', { type: 'envoi', commande: id, preparation: { etape: 3, faits, tablette: tablette.fiche } }, a.TANGUY);
  const t = await ouvrirAdmin('ordinateur', `#commande/${id}`);
  await t.page.getByRole('button', { name: 'Reprendre la préparation' }).first().click();
  await t.page.locator('dialog.parcours[open]').waitFor();
  assert.strictEqual(await t.page.locator('.pc-corps h3').innerText(), 'Installer la carte SIM');
  return { t, tablette, id };
}

const message = (t) => t.page.locator('.pc-sim-message');
const suivantEteint = (t) => t.page.locator('.pc-suivant').isDisabled();
const toutesCoches = (t) => t.page.locator('.pc-sim-coches li').evaluateAll((li) => li.map((x) => `${x.classList.contains('ok') ? '✓' : '·'} ${x.innerText.replace(/\s+/g, ' ').trim()}`));
// Les coches de la carte, sans celle du répondeur (19/11, présente seulement avec les fonctions qui la donnent).
const coches = async (t) => (await toutesCoches(t)).filter((c) => !/Répondeur/.test(c));
const nbOrdres = () => banc.appels.filter((x) => x.nom === 'gestionStock' && x.data && x.data.action === 'simOrdre').length;

/** Attend que le message de l'étape (relu toutes les 3 s) corresponde. */
async function attendreMessage(t, re) {
  await t.page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.pc-sim-message')?.textContent || ''), re.source, { timeout: 15_000 });
  return message(t).innerText();
}

/** « Tester la carte » : l'effet se voit tout de suite, l'ordre arrive dans le code de la tablette. */
async function tester(t, tablette, bouton = 'Tester la carte') {
  const avant = (await s.lire(`pairings/${tablette.code}`)).ordre;
  await t.page.getByRole('button', { name: bouton }).click();
  await t.page.waitForFunction(() => /Ordre envoyé à T-\d+/.test(document.querySelector('.pc-sim-info')?.textContent || ''), null, { timeout: 10_000 });
  return g.ordreSim(tablette.code, { autreQue: avant && avant.id });
}

test('carte SIM : chaque état en mots simples, « C\'est fait » éteint tant que pas OK, double appui = un seul ordre, résultat trop vieux', async () => {
  const { t, tablette, id } = await aLEtapeSim();
  const p = t.page;
  // La tablette n'affiche pas encore son code : le bouton le dit, sans alarmer.
  await p.getByRole('button', { name: 'Tester la carte' }).click();
  await p.waitForFunction(() => /n'affiche pas encore son code/.test(document.querySelector('.pc-sim-info')?.textContent || ''));
  assert.ok(await suivantEteint(t));

  // Elle l'affiche (écran Bienvenue). Double appui : un seul ordre, et l'effet se voit tout de suite.
  await a.afficherCode(tablette);
  const avant = nbOrdres();
  await p.getByRole('button', { name: 'Tester la carte' }).dblclick();
  await p.waitForFunction(() => /Ordre envoyé à T-\d+ : test de la carte/.test(document.querySelector('.pc-sim-info')?.textContent || ''));
  const ordre = await g.ordreSim(tablette.code);
  assert.strictEqual(nbOrdres() - avant, 1, 'double appui : un seul appel');
  assert.strictEqual(ordre.type, 'simTest');
  assert.strictEqual(ordre.simAttendue, ICCID);
  assert.strictEqual((await s.lire(`stock/${tablette.fiche}`)).simOrdre.id, ordre.id);
  // Les deux boutons ont la même taille.
  const tailles = await p.locator('.pc-sim-boutons button').evaluateAll((b) => b.map((x) => { const r = x.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
  assert.deepStrictEqual(tailles[0], tailles[1], 'boutons de même taille');
  // Aucun orange, pas de fond vert.
  const couleurs = await p.locator('.pc-contenu').evaluate((z) => [z, ...z.querySelectorAll('*')]
    .flatMap((x) => [getComputedStyle(x).backgroundColor, getComputedStyle(x).color, getComputedStyle(x).borderLeftColor])
    .map((c) => (c.match(/\d+/g) || []).map(Number)));
  const orange = ([r, v, b]) => r > 200 && v >= 90 && v <= 190 && b < 90;
  assert.ok(!couleurs.some(orange), 'aucun orange');
  const fonds = await p.locator('.pc-contenu').evaluate((z) => [z, ...z.querySelectorAll('*')].map((x) => getComputedStyle(x).backgroundColor));
  assert.ok(!fonds.some((c) => /^rgba?\((21, 128, 61|22, 163, 74|74, 222, 128)/.test(c)), 'pas de fond vert');

  // Chaque état de la carte, chacun après un nouveau « Tester la carte ».
  const cas = [
    [{ etat: 'absente', iccid: null, mcc: null, mnc: null, operateur: null, inscrite: false, donnees: { ok: false, ms: null } }, /Aucune carte détectée : vérifiez qu'elle est bien dans la tablette/],
    [{ etat: 'pin', inscrite: false, donnees: { ok: false, ms: null } }, /La carte demande un code PIN : touchez « Retirer le code PIN »/],
    [{ etat: 'puk', inscrite: false, donnees: { ok: false, ms: null } }, /code PUK/],
    [{ etat: 'verrouillee', inscrite: false, donnees: { ok: false, ms: null } }, /verrouillée/],
    [{ etat: 'etrangere', mcc: '234', mnc: '15', operateur: 'Vodafone UK', itinerance: true }, /pas sur un réseau français/],
    [{ etat: 'sans-reseau', inscrite: false, donnees: { ok: false, ms: null } }, /ne capte pas encore le réseau/],
    [{ etat: 'donnees-ko', donnees: { ok: false, ms: null } }, /pas internet/],
    [{ iccid: '8933010000000009999' }, /Ce n'est pas la carte choisie.*…9999.*…4321/],
  ];
  let premier = true;
  for (const [resultat, re] of cas) {
    if (!premier) await tester(t, tablette);
    premier = false;
    await g.repondreSim(tablette, resultat);
    await attendreMessage(t, re);
    assert.ok(await suivantEteint(t), `${resultat.etat || 'mauvaise carte'} : « C'est fait » éteint`);
    assert.doesNotMatch(await message(t).innerText(), /erreur|échec|!/i, 'rien d\'anxiogène');
  }
  assert.match((await coches(t))[0], /^· Bonne carte \(…4321\)/, 'mauvaise carte : pas cochée');

  // Résultat qui date de plus de 10 minutes (copie retardée) : à refaire.
  const o = await tester(t, tablette);
  await s.db.doc(`pairings/${tablette.code}`).update({ simTest: {
    id: o.id, le: s.Timestamp.fromMillis(Date.now() - 11 * 60_000), iccid: ICCID, mcc: '208', mnc: '01', operateur: 'Orange',
    etat: 'ok', inscrite: true, itinerance: false, donnees: { ok: true, ms: 230 },
  } });
  await s.calme();
  await attendreMessage(t, /plus de 10 minutes/);
  assert.ok(await suivantEteint(t));
  assert.strictEqual((await s.lire(`stock/${tablette.fiche}`)).simTest.ok, false);

  // Le serveur refuse aussi le départ du colis sans test réussi.
  await assert.rejects(s.appeler('tabletteEnvoyee', { commande: id, mainPropre: true }, a.TANGUY), /Testez d'abord la carte SIM/);

  // Enfin la bonne carte, en France, avec internet : les quatre coches, et « C'est fait » s'allume.
  await tester(t, tablette);
  await g.repondreSim(tablette);
  await attendreMessage(t, /La carte marche/);
  assert.deepStrictEqual(await coches(t), ['✓ ✓ Bonne carte (…4321)', '✓ ✓ Réseau français (Orange)', '✓ ✓ Inscrite au réseau', '✓ ✓ Internet par la carte (230 ms)']);
  assert.ok(!(await suivantEteint(t)));
  await p.locator('.pc-suivant').click();
  await p.waitForFunction(() => document.querySelector('.pc-corps h3')?.textContent !== 'Installer la carte SIM');
  // Blocages déjà notés sur la carte : l'étape suivante est le carton.
  assert.strictEqual(await p.locator('.pc-corps h3').innerText(), 'La tablette dans le carton');
  assert.strictEqual((await s.lire(`stock/${tablette.fiche}`)).simTest.ok, true);
});

test('carte SIM : « Retirer le code PIN », le code de la tablette change avant la réponse (ordre reporté), puis le test « -apres-pin »', async () => {
  const { t, tablette } = await aLEtapeSim();
  await a.afficherCode(tablette);
  const premier = tablette.code;
  const ordre = await tester(t, tablette, 'Retirer le code PIN sur la tablette');
  assert.strictEqual(ordre.type, 'simPin');
  assert.match(await t.page.locator('.pc-sim-info').innerText(), /retrait du code PIN, puis test de la carte/);
  await attendreMessage(t, /quelques secondes/);

  // Un nouveau code s'affiche avant la réponse : l'ordre y est recopié, la tablette le lit là.
  await a.afficherCode(tablette);
  assert.notStrictEqual(tablette.code, premier);
  const reporte = await g.ordreSim(tablette.code);
  // Reporté comme le test qui suit le retrait du code PIN (la tablette exécute un id une seule fois).
  assert.deepStrictEqual([reporte.id, reporte.type, reporte.simAttendue], [`${ordre.id}-apres-pin`, 'simTest', ICCID]);
  assert.strictEqual(nbOrdres(), 1, 'reporté par le serveur, sans nouvel appui');

  // Code PIN retiré, test enchaîné par la tablette (id « -apres-pin ») sur son nouveau code.
  await g.repondreSim(tablette, {}, { id: `${ordre.id}-apres-pin` });
  await attendreMessage(t, /La carte marche/);
  assert.ok(!(await t.page.locator('.pc-suivant').isDisabled()));
  const fiche = await s.lire(`stock/${tablette.fiche}`);
  assert.strictEqual(fiche.simTest.id, `${ordre.id}-apres-pin`);
  assert.strictEqual(fiche.simTest.ok, true);
});

// Numéro d'essai (Tanguy, 17/11) : la tablette envoie un SMS puis appelle ce portable pendant le test. Numéro fictif :
// le dépôt est public.
test('carte SIM : numéro d\'essai noté une fois, puis « SMS parti » et « Appel passé » avec leur état', async () => {
  const { t, tablette } = await aLEtapeSim();
  const p = t.page;
  const nbNumero = () => banc.appels.filter((x) => x.nom === 'gestionStock' && x.data && x.data.action === 'simNumero').length;
  try {
    // Sans numéro : une ligne discrète pour en noter un, et le test se fait comme avant.
    await p.getByRole('button', { name: 'Noter mon portable' }).waitFor();
    assert.match(await p.locator('.pc-sim-numero').innerText(), /Pour recevoir un SMS et un appel de la tablette pendant le test/);
    await p.getByRole('button', { name: 'Noter mon portable' }).click();
    const champ = p.getByLabel('Portable pour le SMS et l\'appel d\'essai');
    // Les deux boutons ont la même taille.
    const tailles = await p.locator('.pc-sim-numero button').evaluateAll((b) => b.map((x) => { const r = x.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
    assert.deepStrictEqual(tailles[0], tailles[1], 'Enregistrer et Annuler de même taille');
    // Un fixe : refusé tout de suite, sans appel au serveur.
    await champ.fill('01 23 45 67 89');
    await p.getByRole('button', { name: 'Enregistrer' }).click();
    await p.waitForFunction(() => /commence par 06 ou 07/.test(document.querySelector('.pc-sim-numero-aide')?.textContent || ''));
    assert.strictEqual(nbNumero(), 0);
    // Double appui : un seul enregistrement, et la ligne le montre.
    await champ.fill('06 12 34 56 78');
    await p.getByRole('button', { name: 'Enregistrer' }).dblclick();
    await p.waitForFunction(() => /SMS et appel d'essai vers 06 12 34 56 78/.test(document.querySelector('.pc-sim-numero')?.textContent || ''));
    assert.strictEqual(nbNumero(), 1, 'double appui : un seul appel');
    assert.strictEqual((await s.lire('gestion/reglages')).numeroEssai, '+33612345678');

    // « Tester la carte » : l'ordre porte l'appel, l'écran annonce le SMS et l'appel en cours.
    await a.afficherCode(tablette);
    const ordre = await tester(t, tablette);
    assert.deepStrictEqual(ordre.appel, { numero: '+33612345678', secondes: 20, texte: `Papote : test de la carte SIM de ${tablette.ref}` });
    assert.match(await p.locator('.pc-sim-info').innerText(), /SMS et appel vers votre portable/);
    await attendreMessage(t, /appelle votre portable/);
    assert.deepStrictEqual((await coches(t)).slice(4), ['· SMS parti : en cours…', '· Appel passé : en cours…']);

    // La carte marche, le SMS part, mais le réseau refuse l'appel : message clair, « C'est fait » éteint.
    await g.repondreSim(tablette, { sms: { ok: true, code: -1, ms: 1800 }, appel: { ok: false, secondes: 0, raison: 'refuse' } });
    const refus = await attendreMessage(t, /n'a pas laissé passer l'appel/);
    assert.doesNotMatch(refus, /erreur|échec|!/i, 'rien d\'anxiogène');
    assert.deepStrictEqual((await coches(t)).slice(4), ['✓ ✓ SMS parti (1,8 s)', '· Appel passé : pas encore']);
    assert.ok(await suivantEteint(t));

    // Nouveau test : SMS parti et appel passé, les six coches, « C'est fait » s'allume.
    await tester(t, tablette);
    await g.repondreSim(tablette, { sms: { ok: true, code: -1, ms: 2100 }, appel: { ok: true, secondes: 20 } });
    await attendreMessage(t, /SMS parti et appel passé/);
    assert.deepStrictEqual(await coches(t), ['✓ ✓ Bonne carte (…4321)', '✓ ✓ Réseau français (Orange)', '✓ ✓ Inscrite au réseau',
      '✓ ✓ Internet par la carte (230 ms)', '✓ ✓ SMS parti (2,1 s)', '✓ ✓ Appel passé (20 s)']);
    assert.ok(!(await suivantEteint(t)));
    const fiche = await s.lire(`stock/${tablette.fiche}`);
    assert.deepStrictEqual([fiche.simTest.ok, fiche.simTest.avecAppel, fiche.simTest.appel.ok], [true, true, true]);
  } finally {
    // Numéro retiré : les autres scénarios testent sans SMS ni appel.
    await s.appeler('gestionStock', { action: 'simNumero', numero: '' }, a.TANGUY);
  }
});

// Répondeur de la ligne coupé par la tablette (##002#, Tanguy 19/11) : une coche de plus, jamais bloquante, et une
// phrase calme quand l'opérateur refuse. Seulement avec des fonctions serveur qui le donnent (branche claude/sim-repondeur).
const fonctionsAvecRepondeur = (() => {
  try { return typeof require(require('node:path').join(process.env.PAPOTE_FONCTIONS || require('node:path').join(__dirname, '..', '.fonctions', 'functions'), 'sim-installation.js')).etatRepondeur === 'function'; } catch (e) { return false; }
})();
test('carte SIM : « Répondeur coupé » après le test ; refus de l\'opérateur expliqué sans bloquer « C\'est fait »', { skip: !fonctionsAvecRepondeur && 'fonctions sans répondeur' }, async () => {
  const { t, tablette } = await aLEtapeSim();
  const p = t.page;
  await a.afficherCode(tablette);
  await tester(t, tablette);
  // Résultat de la carte d'abord : la coche du répondeur attend, « C'est fait » s'allume déjà.
  await g.repondreSim(tablette);
  await attendreMessage(t, /La carte marche/);
  await p.waitForFunction(() => [...document.querySelectorAll('.pc-sim-coches li')].some((li) => /Répondeur coupé : en cours…/.test(li.textContent)));
  assert.ok(!(await suivantEteint(t)), 'la carte suffit pour passer à la suite');
  assert.ok(await p.locator('.pc-sim-repondeur').isHidden());
  // L'opérateur refuse : phrase calme sous le verdict, l'envoi reste possible.
  await g.repondreSim(tablette, { repondeur: { ok: false, essais: 1, raison: 'refuse' } });
  await p.waitForFunction(() => /espace client/.test(document.querySelector('.pc-sim-repondeur')?.textContent || ''));
  assert.doesNotMatch(await p.locator('.pc-sim-repondeur').innerText(), /erreur|échec|!/i, 'rien d\'anxiogène');
  assert.ok((await toutesCoches(t)).includes('· Répondeur coupé : pas encore'));
  assert.ok(!(await suivantEteint(t)));
  // Coupé : coche verte, plus de phrase.
  await g.repondreSim(tablette, { repondeur: { ok: true, essais: 1 } });
  await p.waitForFunction(() => [...document.querySelectorAll('.pc-sim-coches li.ok')].some((li) => /Répondeur coupé/.test(li.textContent)));
  assert.ok(await p.locator('.pc-sim-repondeur').isHidden());
  assert.strictEqual((await s.lire(`stock/${tablette.fiche}`)).simTest.repondeur.ok, true);
});
