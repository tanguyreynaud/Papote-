// Un seul message de fin par SOS (Tanguy, 20/11 : « jamais plus d'un de ces messages »). La tablette signale son SOS
// sur sa fiche (members/{uid}.sos = { debut, fin, uid, nom }, joué ici par écriture directe, comme Sync.signalerSos) :
//   - SOS qui court (fin vide, moins de 30 min) : la fenêtre de l'app « Mamie Emma a appuyé sur SOS » s'ouvre seule,
//     avec « Rappeler Mamie Emma », « Je m'en occupe » et « Plus tard », de même taille ;
//   - « Je m'en occupe » touché deux fois = un seul appel à sosJeMenOccupe ; le serveur écrit families/{fid}.sosPris ;
//     l'autre proche voit aussitôt « Julie s'en occupe », avec OK seulement ;
//   - SOS fini (repondu, arrete) : la même fenêtre dit comment, avec OK seulement ;
//   - notification « Personne n'a pu répondre » touchée pendant le SOS : la même fenêtre, avec « Je m'en occupe ».
// Jamais confirm/alert (banc.js : erreur), une seule fenêtre à la fois.
// PAPOTE_CAPTURES_SOS=<dossier> : captures 390 px de large, écran ×2 (Chromium).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

const FENETRE = '.dialog-back:not(.closing) .dialog.dialog-sos';
const PRENDRE = `${FENETRE} button:has-text("Je m'en occupe")`;
const heureFr = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

async function tabletteDe(fid) {
  const tabs = (await g.liste(`families/${fid}/members`)).filter((m) => m.role === 'tablette');
  assert.ok(tabs.length, 'tablette dans la famille');
  return tabs[0].id;
}
// La tablette signale son SOS (comme Sync.signalerSos : le champ sos seul, sur sa fiche).
const signaler = (fid, uid, sos) => banc.s.db.doc(`families/${fid}/members/${uid}`).update({ sos });

/** La fenêtre SOS : { titre, texte, boutons: [{ texte, l, h, actif }] }, une seule fenêtre ouverte. */
async function fenetre(t, titre) {
  const f = t.page.locator(FENETRE);
  await f.waitFor({ state: 'visible' });
  if (titre) await t.page.locator(`${FENETRE} .dialog-title`, { hasText: titre }).waitFor({ timeout: 15_000 });
  assert.strictEqual(await t.page.locator('.dialog-back:not(.closing)').count(), 1, `[${t.nom}] une seule fenêtre`);
  return {
    titre: await f.locator('.dialog-title').innerText(),
    texte: await f.locator('p').first().innerText(),
    boutons: await f.locator('.dialog-buttons button').evaluateAll((bs) => bs.map((b) => ({ texte: b.textContent, l: b.offsetWidth, h: b.offsetHeight, actif: !b.disabled }))),
  };
}
const libelles = (f) => f.boutons.map((b) => b.texte);
function memeTaille(f) {
  for (const b of f.boutons) {
    assert.strictEqual(b.l, f.boutons[0].l, 'boutons de même largeur');
    assert.strictEqual(b.h, f.boutons[0].h, 'boutons de même hauteur');
    assert.ok(b.h >= 48, `boutons assez grands : ${b.h} px`);
  }
}
const appelsPrendre = () => banc.appels.filter((a) => a.nom === 'sosJeMenOccupe');

// Capture à l'écran ×2 : l'écran tel qu'il est (sans ses scripts) recopié dans une page 390 px de large, densité 2.
async function capture(t, nom) {
  const dossier = process.env.PAPOTE_CAPTURES_SOS;
  if (!dossier || banc.WEBKIT) return;
  await t.page.waitForTimeout(400); // fin de l'animation d'ouverture ou du changement
  const html = (await t.page.content()).replace(/<script\b[\s\S]*?<\/script>/gi, '');
  const ctx = await t.context.browser().newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR' });
  try {
    const p = await ctx.newPage();
    await p.goto(`${banc.origine}/__vide.html`);
    await p.setContent(html, { waitUntil: 'load' });
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: path.join(dossier, `${nom}.png`), animations: 'disabled' });
  } finally {
    await ctx.close();
  }
}

test('SOS qui court : la fenêtre s\'ouvre chez les deux proches ; « Je m\'en occupe » en double appui = un appel ; l\'autre voit « Julie s\'en occupe »', async () => {
  const julie = await banc.telephone('Julie');
  const paul = await banc.telephone('Paul');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const uidJulie = (await g.lire(`families/${fid}`)).createdBy;
  await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });
  const tab = await tabletteDe(fid);
  const debut = Date.now() - 2 * 60_000;

  await signaler(fid, tab, { debut, fin: '', uid: '', nom: '' });
  for (const t of [julie, paul]) {
    const f = await fenetre(t, 'Mamie Emma a appuyé sur SOS');
    assert.strictEqual(f.texte, `Aujourd'hui à ${heureFr(debut)}. La tablette prévient la famille.`);
    assert.deepStrictEqual(libelles(f), ['Rappeler Mamie Emma', 'Je m\'en occupe', 'Plus tard']);
    memeTaille(f);
  }
  await capture(julie, 'sos-en-cours');

  // Julie touche deux fois « Je m'en occupe » : une seule demande, sosPris écrit par le serveur.
  await g.doubleAppui(julie, PRENDRE);
  await g.attendreBase(async () => (await g.lire(`families/${fid}`)).sosPris, 'sosPris écrit');
  const pris = (await g.lire(`families/${fid}`)).sosPris;
  assert.strictEqual(pris.uid, uidJulie);
  assert.strictEqual(pris.nom, 'Julie');
  assert.strictEqual(pris.debut, debut);
  assert.ok(pris.le && typeof pris.le.toMillis === 'function', 'le : heure du serveur');
  const fj = await fenetre(julie, 'Vous vous en occupez');
  assert.deepStrictEqual(libelles(fj), ['OK']);
  await julie.page.waitForTimeout(1500);
  assert.strictEqual(appelsPrendre().length, 1, 'un seul appel pour le double appui');

  // Paul, sans rien toucher : la fenêtre ouverte dit que Julie s'en occupe, OK seulement.
  const fp = await fenetre(paul, 'Julie s\'en occupe');
  assert.deepStrictEqual(libelles(fp), ['OK']);
  assert.strictEqual(fp.texte, `SOS : aujourd'hui à ${heureFr(debut)}.`);
  await capture(paul, 'sos-julie-s-en-occupe');

  // La tablette a lu sosPris et le note sur sa fiche : rien ne change, aucune autre fenêtre.
  await signaler(fid, tab, { debut, fin: 'pris', uid: uidJulie, nom: 'Julie' });
  await paul.page.waitForTimeout(800);
  assert.strictEqual((await fenetre(paul)).titre, 'Julie s\'en occupe');
  await g.repondre(paul, 'OK');
  await g.repondre(julie, 'OK');
  await paul.page.waitForTimeout(800);
  for (const t of [julie, paul]) assert.strictEqual(await t.page.locator('.dialog-back').count(), 0, `[${t.nom}] fenêtre fermée pour de bon`);
  assert.strictEqual(appelsPrendre().length, 1, 'Paul n\'a rien demandé');
  assert.strictEqual((await g.liste(`families/${fid}/calls`)).length, 0, 'aucun appel lancé');
});

test('Deux proches touchent « Je m\'en occupe » en même temps : le premier gagne, l\'autre lit « … s\'en occupe déjà »', async () => {
  const julie = await banc.telephone('Julie');
  const paul = await banc.telephone('Paul');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });
  const tab = await tabletteDe(fid);
  const debut = Date.now() - 60_000;
  await signaler(fid, tab, { debut, fin: '', uid: '', nom: '' });
  await fenetre(julie, 'Mamie Emma a appuyé sur SOS');
  await fenetre(paul, 'Mamie Emma a appuyé sur SOS');
  // Les deux touchers partent ensemble (fenêtres ouvertes et posées) : aucun ne voit encore la réponse de l'autre.
  await julie.page.waitForTimeout(500);
  const toucher = (t) => t.page.evaluate((sel) => document.querySelector(sel).click(), `${FENETRE} button.sos-prendre`);
  await Promise.all([toucher(julie), toucher(paul)]);
  await g.attendreBase(async () => (await g.lire(`families/${fid}`)).sosPris, 'sosPris écrit');
  const gagnant = (await g.lire(`families/${fid}`)).sosPris.nom;
  const [g1, perdant] = gagnant === 'Julie' ? [julie, paul] : [paul, julie];
  assert.deepStrictEqual(libelles(await fenetre(g1, 'Vous vous en occupez')), ['OK']);
  await perdant.page.locator(`${FENETRE} p`, { hasText: `${gagnant} s'en occupe déjà.` }).waitFor({ timeout: 15_000 });
  const fp = await fenetre(perdant, `${gagnant} s'en occupe`);
  assert.deepStrictEqual(libelles(fp), ['OK']);
  assert.strictEqual(appelsPrendre().length, 2, 'une demande par proche');
  assert.strictEqual((await g.lire(`families/${fid}`)).sosPris.nom, gagnant, 'le premier garde la main');
});

test('SOS fini : la même fenêtre dit comment (quelqu\'un au téléphone, arrêté), OK seulement ; la notification pendant le SOS montre « Je m\'en occupe »', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const tab = await tabletteDe(fid);

  // SOS qui court puis la tablette a eu quelqu'un au téléphone : la fenêtre ouverte change, OK seulement.
  const debut = Date.now() - 60_000;
  await signaler(fid, tab, { debut, fin: '', uid: '', nom: '' });
  await fenetre(julie, 'Mamie Emma a appuyé sur SOS');
  await signaler(fid, tab, { debut, fin: 'repondu', uid: 'paul', nom: 'Paul' });
  let f = await fenetre(julie, 'Mamie Emma a eu quelqu\'un au téléphone');
  assert.deepStrictEqual(libelles(f), ['OK']);
  assert.strictEqual(f.texte, `Paul a répondu. SOS : aujourd'hui à ${heureFr(debut)}.`);
  await g.repondre(julie, 'OK');

  // Nouveau SOS, fermé par « Plus tard », puis arrêté sur la tablette : dit une fois, OK seulement.
  const debut2 = Date.now() - 30_000;
  await signaler(fid, tab, { debut: debut2, fin: '', uid: '', nom: '' });
  await fenetre(julie, 'Mamie Emma a appuyé sur SOS');
  await g.repondre(julie, 'Plus tard');
  await julie.page.waitForTimeout(600);
  assert.strictEqual(await julie.page.locator('.dialog-back').count(), 0, '« Plus tard » ferme');
  await signaler(fid, tab, { debut: debut2, fin: 'arrete', uid: '', nom: '' });
  f = await fenetre(julie, 'Mamie Emma a arrêté le SOS');
  assert.deepStrictEqual(libelles(f), ['OK']);
  await g.repondre(julie, 'OK');
  // Une fiche qui bouge encore (batterie) ne rouvre rien.
  await banc.s.db.doc(`families/${fid}/members/${tab}`).update({ battery: { level: 80, charging: true } });
  await julie.page.waitForTimeout(800);
  assert.strictEqual(await julie.page.locator('.dialog-back').count(), 0, 'rien de rouvert');

  // La notification « Personne n'a pu répondre » touchée pendant un SOS qui court (app fermée) : « Je m'en occupe ».
  const debut3 = Date.now() - 20_000;
  await signaler(fid, tab, { debut: debut3, fin: '', uid: '', nom: '' });
  await fenetre(julie, 'Mamie Emma a appuyé sur SOS');
  await julie.page.goto(`${banc.origine}/__vide.html`);
  await julie.page.goto(`${banc.origine}/?famille=${fid}&rappeler=1&sos=1&quand=${debut3}`);
  f = await fenetre(julie, 'Mamie Emma a appuyé sur SOS');
  assert.strictEqual(f.texte, `Aujourd'hui à ${heureFr(debut3)}. Personne n'a pu répondre.`);
  assert.deepStrictEqual(libelles(f), ['Rappeler Mamie Emma', 'Je m\'en occupe', 'Plus tard']);
  memeTaille(f);
  await julie.page.waitForTimeout(800);
  assert.strictEqual(await julie.page.locator('.dialog-back').count(), 1, 'une seule fenêtre (notification et SOS en direct)');
  await g.repondre(julie, 'Plus tard');

  // La même notification une fois le SOS arrêté : la fenêtre le dit, OK seulement.
  await signaler(fid, tab, { debut: debut3, fin: 'arrete', uid: '', nom: '' });
  await julie.page.goto(`${banc.origine}/__vide.html`);
  await julie.page.goto(`${banc.origine}/?famille=${fid}&rappeler=1&sos=1&quand=${debut3}`);
  f = await fenetre(julie, 'Mamie Emma a arrêté le SOS');
  assert.deepStrictEqual(libelles(f), ['OK']);
  await g.repondre(julie, 'OK');
  assert.strictEqual(appelsPrendre().length, 0);
  assert.strictEqual((await g.liste(`families/${fid}/calls`)).length, 0, 'aucun appel lancé');
});
