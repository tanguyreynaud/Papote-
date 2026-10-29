// Appel dans l'app Android : dans Chrome, Android coupe le micro dès qu'on quitte l'app. Ouverte par l'app
// Android, l'app famille passe donc l'appel à l'écran d'appel de l'app (une WebView avec « Appel en cours »
// dans la barre) : connecté au même compte par un jeton du serveur, il lance l'appel tout seul.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');
const tablette = require('../tablette');

banc.brancher();

// Adresses que la page demande d'ouvrir (intent://… vers l'app Android), sans les suivre.
async function espionnerNavigation(t) {
  const cdp = await t.context.newCDPSession(t.page);
  await cdp.send('Page.enable');
  const demandes = [];
  cdp.on('Page.frameRequestedNavigation', (e) => demandes.push(e.url));
  return demandes;
}

test('App Android : « Appel vidéo » passe à l\'écran d\'appel de l\'app, qui se connecte et appelle tout seul', async () => {
  const julie = await banc.telephone('Julie');
  // Ouverte par l'app Android (Ouverture.java ajoute ?quitter=1).
  await g.ouvrir(julie, '?quitter=1');
  // Le jeton est demandé dès l'arrivée sur l'accueil.
  const jeton = julie.page.waitForResponse((r) => r.url().includes('jetonAppelNatif'), { timeout: 60_000 });
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie.android@exemple.fr', prenom: 'Julie' });
  const uid = (await g.liste(`families/${fid}/members`)).find((m) => m.email === 'julie.android@exemple.fr').id;
  const mamie = await tablette.ouvrir(fid, tab);

  // Dans Chrome : après la confirmation, l'appel part vers l'app avec un jeton de connexion, pas d'ici.
  const demandes = await espionnerNavigation(julie);
  await julie.page.locator('#tile-call:not([disabled])').waitFor();
  assert.ok((await jeton).ok(), 'jeton de connexion reçu');
  await julie.page.click('#tile-call');
  await g.repondre(julie, 'Appeler');
  for (let i = 0; i < 50 && !demandes.length; i++) await julie.page.waitForTimeout(100);
  const lien = demandes.find((u) => u.startsWith('intent://appel?'));
  assert.ok(lien, `l'app Android est appelée : ${JSON.stringify(demandes)}`);
  assert.match(lien, /#Intent;scheme=papote;package=fr\.mapapote\.famille;end$/);
  const params = new URL(lien.replace(/^intent:/, 'https:').replace(/#Intent.*$/, '')).searchParams;
  assert.strictEqual(params.get('u'), `/?appeler=video&famille=${fid}`);
  assert.ok(params.get('connexion'), 'jeton de connexion');
  assert.ok(await julie.page.locator('#call').isHidden(), 'pas d\'appel dans Chrome');
  assert.strictEqual((await g.liste(`families/${fid}/calls`)).length, 0);

  // L'écran d'appel de l'app : la même page dans une WebView (window.PapoteNatif), jamais connectée avant.
  const ecran = await banc.telephone('Écran d\'appel de Julie');
  await ecran.context.addInitScript(() => {
    window.__natif = [];
    window.PapoteNatif = {
      etat: (etat, nom, video) => window.__natif.push([etat, nom, video]),
      fin: () => window.__natif.push(['fin']),
    };
  });
  await g.ouvrir(ecran, `${params.get('u').slice(1)}#connexion=${encodeURIComponent(params.get('connexion'))}`);
  // Connecté au compte de Julie, l'appel part sans redemander.
  await ecran.page.locator('#call').waitFor({ state: 'visible' });
  const appel = await g.attendreBase(async () => (await g.liste(`families/${fid}/calls`)).find((c) => c.callerUid === uid), 'appel écrit');
  assert.strictEqual(appel.callerName, 'Julie');
  assert.ok(!ecran.page.url().includes('connexion='), 'le jeton ne reste pas dans l\'adresse');
  await ecran.page.waitForFunction(() => window.__natif.some(([e]) => e === 'sonne'));

  await tablette.decrocher(mamie, appel.id);
  await ecran.page.waitForFunction(() => window.__natif.some(([e]) => e === 'en_cours'));
  const etats = await ecran.page.evaluate(() => window.__natif);
  assert.deepStrictEqual(etats.find(([e]) => e === 'en_cours'), ['en_cours', 'Mamie Emma', true]);

  // « Raccrocher » dans la notification de l'app : l'appel se termine et l'app en est prévenue.
  await ecran.page.evaluate(() => window.papoteRaccrocher());
  await ecran.page.locator('#call').waitFor({ state: 'hidden', timeout: 10_000 });
  await ecran.page.waitForFunction(() => window.__natif.some(([e]) => e === 'fin'));
  await mamie.arreterRelais();
});
