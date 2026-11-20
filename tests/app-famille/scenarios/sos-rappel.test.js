// SOS resté sans réponse (Tanguy, 20/11 : « Quand je clique sur la notif personne n'a pu répondre il ne se passe rien,
// j'arrive juste sur l'accueil », puis « Oui avec une popup »). La notification « Mamie Emma a appuyé sur SOS » ouvre
// l'app sur /?famille=…&rappeler=1&sos=1&quand=<ms> (web/sw.js, et l'app Android : Appels.urlRappelSos) : la fenêtre de
// l'app (jamais confirm/alert) dit « Mamie Emma a appuyé sur SOS », l'heure, et « Rappeler Mamie Emma » lance l'appel
// comme la tuile. Essayé : app fermée (ouverte par l'adresse), app déjà ouverte (le vrai code du service worker, chargé
// avec un faux `self` comme dans partage.test.js, prévient la page), notification touchée deux fois = une seule
// fenêtre, double appui sur « Rappeler » = un seul appel.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

const FENETRE = '.dialog-back:not(.closing) .dialog.dialog-sos';
const RAPPELER = `${FENETRE} button:has-text("Rappeler Mamie Emma")`;
const appelsDe = async (fid, uid) => (await g.liste(`families/${fid}/calls`)).filter((c) => c.callerUid === uid);
const heureFr = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

/** Vérifie la fenêtre SOS : titre, heure, deux boutons de même taille, aucune autre fenêtre. */
async function verifierFenetre(t, quand) {
  const f = t.page.locator(FENETRE);
  await f.waitFor({ state: 'visible' });
  assert.strictEqual(await f.locator('.dialog-title').innerText(), 'Mamie Emma a appuyé sur SOS');
  assert.strictEqual(await f.locator('p').first().innerText(), `Aujourd'hui à ${heureFr(quand)}. Personne n'a pu répondre.`);
  const boutons = await f.locator('.dialog-buttons button').evaluateAll((bs) => bs.map((b) => ({ texte: b.textContent, l: b.offsetWidth, h: b.offsetHeight })));
  assert.deepStrictEqual(boutons.map((b) => b.texte), ['Rappeler Mamie Emma', 'Plus tard']);
  assert.strictEqual(boutons[0].l, boutons[1].l, 'boutons de même largeur');
  assert.strictEqual(boutons[0].h, boutons[1].h, 'boutons de même hauteur');
  assert.ok(boutons[0].h >= 48, `boutons assez grands : ${boutons[0].h} px`);
  assert.strictEqual(await t.page.locator('.dialog-back:not(.closing)').count(), 1, 'une seule fenêtre');
}

/** Double appui sur « Rappeler » : un seul appel écrit, l'écran d'appel reste ouvert (le 2e toucher n'a pas raccroché). */
async function rappelerEnDoubleAppui(t, fid, uid) {
  const avant = (await appelsDe(fid, uid)).length;
  await g.doubleAppui(t, RAPPELER);
  await t.page.locator('#call').waitFor({ state: 'visible' });
  await g.attendreBase(async () => (await appelsDe(fid, uid)).length > avant, 'appel écrit');
  await t.page.waitForTimeout(2500);
  const appels = await appelsDe(fid, uid);
  assert.strictEqual(appels.length, avant + 1, 'un seul appel pour le double appui');
  assert.strictEqual(appels[appels.length - 1].state, 'ringing', 'l\'appel sonne toujours chez Mamie');
  assert.ok(await t.page.locator('#call').isVisible(), 'écran d\'appel ouvert');
  assert.strictEqual(await t.page.locator('.dialog-back:not(.closing)').count(), 0, 'plus de fenêtre');
}

async function raccrocher(t) {
  await t.page.click('#call-hangup');
  await t.page.locator('#call').waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
}

/**
 * Le vrai web/sw.js, chargé dans la page avec un faux `self` : reçoit `data` (message du serveur), affiche la
 * notification, puis la notification est touchée `touchers` fois, l'app déjà ouverte. Chaque toucher prévient la page
 * (postMessage du service worker, rejoué sur navigator.serviceWorker comme le navigateur le fait).
 * Renvoie { titre, options, url, messages }.
 */
function serviceWorker(t, data, { touchers = 1 } = {}) {
  return t.page.evaluate(async ({ data: d, touchers: n }) => {
    const src = await (await fetch('/sw.js')).text();
    const ecoutes = {};
    const vu = { messages: [] };
    const fenetre = {
      url: location.href,
      focus: async () => {},
      postMessage: (m) => {
        vu.messages.push(m);
        navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: m }));
      },
    };
    const faux = {
      addEventListener: (nom, f) => { ecoutes[nom] = f; },
      location,
      skipWaiting() {},
      clients: { claim() {}, matchAll: async () => [fenetre], openWindow: async (u) => { vu.ouverte = u; } },
      registration: { showNotification: async (titre, options) => { vu.titre = titre; vu.options = options; } },
    };
    new Function('self', src)(faux);
    let attente = null;
    ecoutes.push({ data: { json: () => ({ data: d }) }, waitUntil: (p) => { attente = p; } });
    await attente;
    for (let i = 0; i < n; i++) {
      ecoutes.notificationclick({ notification: { data: vu.options.data, close() {} }, waitUntil: (p) => { attente = p; } });
      await attente;
    }
    vu.url = vu.options.data.url;
    return vu;
  }, { data, touchers });
}

test('SOS sans réponse, app fermée : la notification ouvre « Mamie Emma a appuyé sur SOS » à l\'heure du SOS ; double appui sur « Rappeler » = un appel', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const uid = (await g.lire(`families/${fid}`)).createdBy;
  const quand = Date.now() - 3 * 60_000;

  // App fermée : la notification ouvre l'app (page chargée de zéro) sur l'adresse « Rappeler » du SOS.
  await julie.page.goto(`${banc.origine}/__vide.html`);
  await julie.page.goto(`${banc.origine}/?famille=${fid}&rappeler=1&sos=1&quand=${quand}`);
  await verifierFenetre(julie, quand);
  // L'adresse est nettoyée : actualiser ne rouvre pas la fenêtre.
  assert.strictEqual(new URL(julie.page.url()).search, '');

  await rappelerEnDoubleAppui(julie, fid, uid);
  await raccrocher(julie);
});

test('SOS sans réponse, app déjà ouverte : le service worker la prévient ; notification touchée deux fois = une fenêtre ; « Plus tard » n\'appelle pas ; « Rappeler » une fois', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const uid = (await g.lire(`families/${fid}`)).createdBy;
  await julie.page.locator('#tile-call:not([disabled])').waitFor();
  const quand = Date.now() - 60_000;
  const sos = { type: 'alerte', urgence: 'sos', fid, quand: String(quand), titre: 'Mamie Emma a appuyé sur SOS', texte: 'Personne n\'a pu répondre. Rappelez dès que possible.' };

  // La notification elle-même : son titre, l'étiquette à part, et l'adresse « Rappeler » du SOS.
  const vu = await serviceWorker(julie, sos, { touchers: 2 });
  assert.strictEqual(vu.titre, 'Mamie Emma a appuyé sur SOS');
  assert.strictEqual(vu.options.tag, 'alerte-sos');
  assert.strictEqual(vu.url, `/?famille=${fid}&rappeler=1&sos=1&quand=${quand}`);
  assert.strictEqual(vu.ouverte, undefined, 'app déjà ouverte : pas de deuxième page');
  assert.strictEqual(vu.messages.length, 2);
  // Deux touchers : une seule fenêtre.
  await verifierFenetre(julie, quand);
  await julie.page.waitForTimeout(500);
  assert.strictEqual(await julie.page.locator('.dialog-back').count(), 1, 'une seule fenêtre pour deux touchers');

  // « Plus tard » : la fenêtre se ferme, aucun appel.
  await g.repondre(julie, 'Plus tard');
  await julie.page.waitForTimeout(800);
  assert.strictEqual((await appelsDe(fid, uid)).length, 0, '« Plus tard » n\'appelle pas');
  assert.strictEqual(await julie.page.locator('.dialog-back').count(), 0);

  // Notification retouchée : la fenêtre revient ; double appui sur « Rappeler » = un seul appel.
  await serviceWorker(julie, sos);
  await verifierFenetre(julie, quand);
  await rappelerEnDoubleAppui(julie, fid, uid);
  // Notification touchée encore pendant l'appel : pas de fenêtre, pas de deuxième appel.
  await serviceWorker(julie, sos);
  await julie.page.waitForTimeout(800);
  assert.strictEqual(await julie.page.locator('.dialog-back').count(), 0, 'pas de fenêtre pendant l\'appel');
  assert.strictEqual((await appelsDe(fid, uid)).length, 1);
  await raccrocher(julie);
});

test('Autres notifications inchangées : une alerte de la tablette ouvre l\'accueil, un appel manqué propose de rappeler sans parler de SOS', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await julie.page.locator('#tile-call:not([disabled])').waitFor();
  const alerte = await serviceWorker(julie, { type: 'alerte', titre: 'Tablette débranchée', texte: 'Branchez-la.' });
  assert.strictEqual(alerte.url, '/');
  assert.strictEqual(alerte.options.tag, 'alerte-tablette');
  await julie.page.waitForTimeout(500);
  assert.strictEqual(await julie.page.locator('.dialog-back').count(), 0, 'alerte ordinaire : pas de fenêtre');

  const manque = await serviceWorker(julie, { type: 'manque', cid: 'c1', nom: 'Mamie Emma' });
  assert.strictEqual(manque.url, '/?rappeler=1');
  assert.match(await g.texteFenetre(julie), /Rappeler Mamie Emma en vidéo \?/);
  assert.strictEqual(await julie.page.locator('.dialog-sos').count(), 0);
  await g.repondre(julie, 'Annuler');
  assert.strictEqual((await g.liste(`families/${fid}/calls`)).length, 0);
});
