// Boutons de l'assistant (bulle d'aide, chat-support.js du site) : la bulle appelle window.papoteAller(nom), qui ouvre
// l'écran de l'appli et rend true, ou false quand ce n'est pas possible (la bulle retire alors le bouton).
// Chaque nom ouvre le bon écran depuis l'accueil, une page, un onglet ou la feuille Wi-Fi ; « retour » ramène à
// l'accueil ; deux appels de suite n'empilent qu'une entrée ; un nom inconnu ne fait rien ; false pendant un appel.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');
const tablette = require('../tablette');

const { s } = banc;

banc.brancher();

// Les noms que le serveur peut renvoyer pour l'appli : ACTIONS.appli de functions/support.js (branche du chat IA,
// claude/project-thread-xn4yb6). Un nom ajouté là-bas doit l'être ici et dans ECRANS_ALLER (web/js/famille.js).
const ACTIONS_APPLI = ['depanner', 'abonnement', 'wifi', 'inviter', 'membres', 'volumes', 'nuit', 'options', 'notifications', 'photos', 'messages', 'agenda', 'profil'];

// Écran attendu et carte amenée en haut (si elle est affichée pour ce proche).
const ATTENDU = {
  depanner: ['view-settings', '#remote-card'],
  wifi: ['view-settings', '#wifi-card'],
  membres: ['view-settings', '#members'],
  volumes: ['view-settings', '#volume-card'],
  nuit: ['view-settings', '#sleep-card'],
  options: ['view-settings', '#options-card'],
  inviter: ['view-invite'],
  abonnement: ['view-profile', '#abo-card'],
  profil: ['view-profile'],
  notifications: ['view-notifs'],
  photos: ['view-photos'],
  messages: ['view-messages'],
  agenda: ['view-agenda'],
};

const aller = (t, nom) => t.page.evaluate((n) => window.papoteAller(n), nom);
const niveau = (t) => t.page.evaluate(() => history.state?.niveau || 0);

/** L'écran du nom est affiché, sa carte visible à l'écran, la feuille Wi-Fi et la visionneuse fermées. */
async function verifierEcran(t, nom) {
  const [vue, carte] = ATTENDU[nom];
  await g.attendreVue(t, vue, 5_000);
  assert.ok(await t.page.locator('#sheet-wifi').isHidden(), `${nom} : feuille Wi-Fi fermée`);
  assert.ok(await t.page.locator('#viewer').isHidden(), `${nom} : visionneuse fermée`);
  if (!carte) return;
  const visible = await t.page.locator(carte).isVisible();
  if (!visible) return;
  await t.page.waitForFunction((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return r.top >= -2 && r.top < innerHeight - 40;
  }, carte, { timeout: 5_000 }).catch(async () => {
    const top = await t.page.evaluate((sel) => document.querySelector(sel).getBoundingClientRect().top, carte);
    throw new Error(`${nom} : ${carte} hors de l'écran (haut à ${top} px)`);
  });
}

/** « Retour » : l'accueil, et plus rien au-dessus de lui dans l'historique. */
async function retourAccueil(t) {
  await t.page.goBack();
  await g.attendreVue(t, 'view-home');
  assert.strictEqual(await niveau(t), 0, 'retour ramène sur l\'entrée de l\'accueil');
}

// Écrans de départ : la bulle s'ouvre par-dessus n'importe lequel.
const DEPARTS = {
  accueil: async () => {},
  page: async (t) => g.ouvrirTuile(t, 'agenda'),
  onglet: async (t) => {
    await t.page.click('.nav-item[data-tab="profile"]');
    await g.attendreVue(t, 'view-profile');
  },
  'feuille Wi-Fi': async (t, fid) => {
    // Tablette vue en ligne à l'instant : « Modifier » le Wi-Fi est proposé.
    const tab = (await g.liste(`families/${fid}/members`)).find((m) => m.role === 'tablette');
    await s.db.doc(`families/${fid}/members/${tab.id}`).update({ lastOnline: s.Timestamp.now(), wifi: { ssid: 'Livebox-Emma' } });
    await g.ouvrirTuile(t, 'settings');
    await t.page.locator('#wifi-modify').waitFor({ state: 'visible' });
    await t.page.click('#wifi-modify');
    await t.page.locator('#sheet-wifi').waitFor({ state: 'visible' });
  },
};

test('Boutons du chat : chaque nom ouvre son écran depuis l\'accueil, une page, un onglet, la feuille Wi-Fi ; retour = accueil', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie.aller@exemple.fr', prenom: 'Julie' });
  await julie.page.waitForFunction(() => typeof window.papoteAller === 'function');

  // Chaque nom que le serveur peut renvoyer est connu de l'appli (sinon la bulle retirerait le bouton).
  assert.deepStrictEqual(Object.keys(ATTENDU).sort(), [...ACTIONS_APPLI].sort());

  for (const [depart, aller0] of Object.entries(DEPARTS)) {
    for (const nom of ACTIONS_APPLI) {
      await aller0(julie, fid);
      assert.strictEqual(await aller(julie, nom), true, `${nom} depuis ${depart}`);
      await verifierEcran(julie, nom);
      await julie.page.waitForFunction(() => (history.state?.niveau || 0) === 1, null, { timeout: 5_000 }).catch(async () => {
        throw new Error(`${nom} depuis ${depart} : une seule entrée au-dessus de l'accueil attendue, niveau ${await niveau(julie)}`);
      });
      await retourAccueil(julie);
    }
  }
});

test('Boutons du chat : deux appels de suite (double appui) n\'empilent qu\'une entrée ; nom inconnu ignoré', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie.aller2@exemple.fr', prenom: 'Julie' });
  await julie.page.waitForFunction(() => typeof window.papoteAller === 'function');

  // Deux appels dans le même instant, depuis l'accueil puis depuis une page.
  for (const depart of ['accueil', 'page']) {
    await DEPARTS[depart](julie);
    assert.deepStrictEqual(await julie.page.evaluate(() => [window.papoteAller('depanner'), window.papoteAller('depanner')]), [true, true]);
    await verifierEcran(julie, 'depanner');
    await julie.page.waitForTimeout(500);
    assert.strictEqual(await niveau(julie), 1, `double appel depuis ${depart} : une seule entrée`);
    await retourAccueil(julie);
  }

  // Deux boutons différents touchés coup sur coup : le dernier l'emporte, toujours une seule entrée.
  await DEPARTS.onglet(julie);
  assert.deepStrictEqual(await julie.page.evaluate(() => [window.papoteAller('wifi'), window.papoteAller('inviter')]), [true, true]);
  await verifierEcran(julie, 'inviter');
  await julie.page.waitForTimeout(500);
  assert.strictEqual(await niveau(julie), 1);
  await retourAccueil(julie);

  // Un bouton comme celui de la bulle (désactivé au premier appui), touché deux fois vite : un seul écran ouvert.
  await julie.page.evaluate(() => {
    window.appelsAller = 0;
    const b = document.createElement('button');
    b.id = 'faux-bouton-bulle';
    b.type = 'button';
    b.textContent = 'Ouvrir « Volumes »';
    b.style.cssText = 'position:fixed;left:20px;bottom:120px;z-index:2147483000;padding:16px';
    b.onclick = () => {
      if (b.disabled) return;
      b.disabled = true;
      window.appelsAller++;
      window.papoteAller('volumes');
    };
    document.body.appendChild(b);
  });
  await g.doubleAppui(julie, '#faux-bouton-bulle');
  // (Le bouton reste, désactivé, le temps du double appui : le second toucher ne tombe pas sur la page dessous.)
  await julie.page.evaluate(() => document.getElementById('faux-bouton-bulle').remove());
  await verifierEcran(julie, 'volumes');
  assert.strictEqual(await julie.page.evaluate(() => window.appelsAller), 1);
  await julie.page.waitForTimeout(500);
  assert.strictEqual(await niveau(julie), 1);
  await retourAccueil(julie);

  // Noms inconnus ou piégés : false, rien ne bouge (ni l'écran, ni l'historique).
  await g.ouvrirTuile(julie, 'messages');
  for (const nom of ['inconnu', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'DEPANNER', '', null, 42, { nom: 'wifi' }]) {
    assert.strictEqual(await aller(julie, nom), false, `nom ${JSON.stringify(nom)}`);
  }
  await julie.page.waitForTimeout(300);
  await g.attendreVue(julie, 'view-messages');
  assert.strictEqual(await niveau(julie), 1);
  await retourAccueil(julie);
});

test('Boutons du chat : false pendant que la tablette sonne, avant la connexion ; carte réservée aux responsables', async () => {
  // Avant la connexion : rien à ouvrir.
  const inconnu = await banc.telephone('Inconnu');
  await g.ouvrir(inconnu);
  await inconnu.page.waitForFunction(() => typeof window.papoteAller === 'function');
  await g.attendreVue(inconnu, 'view-login');
  assert.strictEqual(await aller(inconnu, 'depanner'), false);
  await g.attendreVue(inconnu, 'view-login');

  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie.aller3@exemple.fr', prenom: 'Julie' });
  const uid = (await g.liste(`families/${fid}/members`)).find((m) => m.email === 'julie.aller3@exemple.fr').id;

  // La tablette appelle : l'écran de l'appel reste, la bulle retirera le bouton.
  const mamie = await tablette.ouvrir(fid, tab);
  const cid = await tablette.appeler(mamie, { vers: uid });
  await julie.page.locator('#incoming').waitFor({ state: 'visible' });
  for (const nom of ['depanner', 'abonnement', 'photos']) assert.strictEqual(await aller(julie, nom), false, nom);
  assert.ok(await julie.page.locator('#incoming').isVisible(), 'la sonnerie reste à l\'écran');
  await tablette.raccrocher(mamie, cid);
  await julie.page.locator('#incoming').waitFor({ state: 'hidden' });
  await g.attendreVue(julie, 'view-home');
  assert.strictEqual(await aller(julie, 'photos'), true, 'après l\'appel, les boutons marchent à nouveau');
  await verifierEcran(julie, 'photos');
  await retourAccueil(julie);

  // Un proche qui n'est pas responsable : « Dépanner » ouvre quand même les Réglages (la carte y est cachée).
  const paul = await banc.telephone('Paul');
  await g.rejoindre(julie, fid, paul, { email: 'paul.aller@exemple.fr', prenom: 'Paul' });
  assert.ok(await paul.page.locator('#remote-card').isHidden());
  for (const nom of ['depanner', 'wifi', 'volumes', 'nuit', 'options', 'membres']) {
    assert.strictEqual(await aller(paul, nom), true, nom);
    await verifierEcran(paul, nom);
    await retourAccueil(paul);
  }
});

test('Boutons du chat : conversation reprise du site (#chat=…) : false pendant le démarrage, l\'écran s\'ouvre dès l\'accueil prêt', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie.aller4@exemple.fr', prenom: 'Julie' });

  // Comme la bulle chargée dans l'appli : elle lit #chat=…, l'efface de l'adresse (replaceState de l'état actuel,
  // le reste du fragment gardé), puis appelle papoteAller une fois par seconde jusqu'à true.
  await julie.context.addInitScript(() => {
    window.essaisAller = [];
    const lu = new URLSearchParams(location.hash.slice(1));
    if (!lu.has('chat')) return;
    lu.delete('chat');
    const reste = lu.toString();
    history.replaceState(history.state, '', location.pathname + location.search + (reste ? `#${reste}` : ''));
    const essayer = () => {
      const r = typeof window.papoteAller === 'function' ? window.papoteAller('photos') : 'absent';
      window.essaisAller.push(r);
      if (r !== true) setTimeout(essayer, 1000);
    };
    window.addEventListener('DOMContentLoaded', essayer);
  });
  // Arrivée par le lien du site : une vraie ouverture de page (pas un simple changement de fragment).
  await julie.page.goto('about:blank');
  await g.ouvrir(julie, '#chat=eyJlY3JhbiI6InBob3RvcyJ9');
  await g.attendreVue(julie, 'view-photos');
  const essais = await julie.page.evaluate(() => window.essaisAller);
  assert.strictEqual(essais[essais.length - 1], true, JSON.stringify(essais));
  assert.ok(essais.slice(0, -1).every((r) => r !== true), `un seul true : ${JSON.stringify(essais)}`);
  assert.ok(essais.length >= 2, `l'appli n'était pas prête au premier appel : ${JSON.stringify(essais)}`);
  assert.strictEqual(await julie.page.evaluate(() => location.hash), '', 'le fragment #chat= est effacé');
  await julie.page.waitForTimeout(1500);
  assert.strictEqual((await julie.page.evaluate(() => window.essaisAller)).length, essais.length, 'plus d\'appel après true');
  assert.strictEqual(await niveau(julie), 1);
  await retourAccueil(julie);

  // Une question ouverte (Se déconnecter ?) : false, la question reste.
  await julie.page.click('.nav-item[data-tab="profile"]');
  await julie.page.click('#view-profile [data-action="logout"]');
  await julie.page.locator('.dialog-back:not(.closing) .dialog', { hasText: 'Se déconnecter' }).waitFor();
  assert.strictEqual(await aller(julie, 'agenda'), false);
  await g.attendreVue(julie, 'view-profile');
  await g.repondre(julie, 'Annuler');
});
