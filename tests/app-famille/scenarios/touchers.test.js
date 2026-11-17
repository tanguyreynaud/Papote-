// Audit des touchers (Tanguy, 17/11 : « on a l'impression de pouvoir cliquer mais ça ne fait rien ») : tout ce qui a
// l'air de se toucher dans l'app famille réagit tout de suite (une page, une fenêtre, un mot en bas, un état qui
// change). Ici, ce que l'audit a trouvé sans effet, puis la liste de ce qui a été vérifié, page par page.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

const { s } = banc;

banc.brancher();

/** Touche l'élément et renvoie ce qui a bougé à l'écran dans les 0,7 s (changements de la page, choix de fichier). */
async function effet(t, selecteur) {
  await t.page.evaluate(() => {
    window.__effets = 0;
    window.__sonde?.disconnect();
    window.__sonde = new MutationObserver((ms) => { window.__effets += ms.length; });
    window.__sonde.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  let fichier = false;
  const choix = (fc) => { fichier = true; fc.setFiles([]).catch(() => {}); };
  t.page.on('filechooser', choix);
  await t.page.locator(selecteur).filter({ visible: true }).first().click();
  await t.page.waitForTimeout(700);
  t.page.off('filechooser', choix);
  const n = await t.page.evaluate(() => { window.__sonde.disconnect(); return window.__effets; });
  return { n, fichier };
}

async function famille() {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const tab = (await g.liste(`families/${fid}/members`)).find((m) => m.role === 'tablette');
  await s.db.doc(`families/${fid}/members/${tab.id}`).update({ lastOnline: s.Timestamp.now(), wifi: { ssid: 'Livebox-Emma' } });
  const paul = await banc.telephone('Paul');
  await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });
  await paul.context.close();
  return { julie, fid };
}

test('Touchers sans effet trouvés par l\'audit : membres, « Non lu », photos de profil, agenda, notifications, réglages', async () => {
  const { julie } = await famille();
  const p = julie.page;

  // Réglages > Membres : chaque ligne répond.
  await g.ouvrirTuile(julie, 'settings');
  await p.locator('#members li', { hasText: 'Paul' }).locator('.member-email').click();
  assert.match(await g.texteFenetre(julie), /Paul/);
  await g.repondre(julie, 'Annuler');
  await p.locator('#members li', { hasText: 'Tablette de Mamie Emma' }).locator('.member-name').click();
  assert.match(await g.texteFenetre(julie), /En ligne par le Wi-Fi « Livebox-Emma »/);
  await g.repondre(julie, 'OK');
  // La photo de Mamie, ronde et vide : « Choisir une photo ».
  assert.ok((await effet(julie, '#tface-empty')).fichier, 'photo de Mamie : choix d\'une photo');
  // Le titre et la valeur d'un réglage : comme « Modifier ».
  await p.click('#sleep-value');
  await p.locator('#form-sleep').waitFor();
  await p.click('#sleep-card .setting-cancel');
  await p.click('#family-name-card h2');
  await p.locator('#form-family-name').waitFor();
  await p.click('#family-name-card .setting-cancel');
  await p.click('#wifi-current');
  await p.locator('#sheet-wifi').waitFor();
  await p.click('#wifi-close');
  await p.locator('#sheet-wifi').waitFor({ state: 'hidden' });
  // Sa propre ligne (son badge « Responsable ») : où changer ses informations.
  await p.locator('#members li', { hasText: 'Julie' }).locator('.badge', { hasText: 'Responsable' }).click();
  await g.toast(julie, 'C\'est vous : votre prénom, votre photo et votre numéro se changent dans Profil.');
  await p.click('#view-settings .back');
  await g.attendreVue(julie, 'view-home');
  await p.click('.nav-item[data-tab="profile"]');
  await g.attendreVue(julie, 'view-profile');
  assert.ok((await effet(julie, '#face-img, #face-empty')).fichier, 'ma photo : choix d\'une photo');

  // Photos : « Non lu » dit que Mamie ne l'a pas encore vue.
  await g.retourAccueil(julie);
  await g.ouvrirTuile(julie, 'photos');
  await p.locator('#photos .read-badge').first().click();
  await g.toast(julie, 'Mamie Emma ne l\'a pas encore vue.');
  await p.click('#view-photos .back');
  await g.attendreVue(julie, 'view-home');

  // Agenda : la ligne d'un anniversaire ouvre sa modification ; double appui : une seule fenêtre, et le retour la ferme.
  await g.ouvrirTuile(julie, 'agenda');
  await g.doubleAppui(julie, '#birthdays li.reminder .reminder-title');
  await p.locator('#sheet-reminder').waitFor();
  await p.waitForTimeout(700);
  assert.ok(await p.locator('#sheet-reminder').isVisible(), 'le 2e toucher ne referme pas la fenêtre');
  assert.strictEqual(await p.locator('#reminder-title').innerText(), 'Modifier l\'anniversaire');
  await p.goBack();
  await p.locator('#sheet-reminder').waitFor({ state: 'hidden' });
  await g.attendreVue(julie, 'view-agenda');
  await p.click('#view-agenda .back');
  await g.attendreVue(julie, 'view-home');

  // Notifications : chacune ouvre ce dont elle parle, et le retour y ramène.
  await p.click('#btn-bell');
  await g.attendreVue(julie, 'view-notifs');
  await p.locator('#notifs li', { hasText: 'Paul a rejoint la famille' }).click();
  await g.attendreVue(julie, 'view-settings');
  await p.goBack();
  await g.attendreVue(julie, 'view-notifs');
  await p.locator('#notifs li', { hasText: 'envoyé une photo' }).first().click();
  await g.attendreVue(julie, 'view-photos');
});

test('Audit : chaque élément qui a l\'air de se toucher réagit, page par page', async () => {
  const { julie } = await famille();
  const p = julie.page;
  const verifier = async (selecteurs) => {
    for (const sel of selecteurs) {
      const r = await effet(julie, sel);
      assert.ok(r.n > 0 || r.fichier, `${sel} : aucun effet visible`);
      // Revenir à la page de départ : fenêtre, feuille ou page ouverte.
      if (await p.locator('.dialog-back:not(.closing)').count()) await p.locator('.dialog-back:not(.closing) .dialog .dialog-buttons button').last().click();
      await p.waitForTimeout(200);
    }
  };
  // Accueil.
  await verifier(['#tablet-chip']);
  // Réglages : les réglages de la tablette (titre, valeur, Modifier), la ligne d'un membre, « Obtenir l'état ».
  await g.ouvrirTuile(julie, 'settings');
  for (const carte of ['family-name-card', 'meteo-card', 'options-card', 'volume-card', 'sleep-card']) {
    for (const cible of ['h2', '.setting-value', '.setting-modify']) {
      await verifier([`#${carte} ${cible}`]);
      await p.click(`#${carte} .setting-cancel`);
    }
  }
  await verifier(['#members li:has-text("Paul") .member-name', '#tface-camera', '#tface-gallery', '#remote-card [data-cmd="status"]']);
  // Volumes : « Écouter » dit en bas que la tablette sonne ; plus de récapitulatif.
  await p.click('#volume-card .setting-modify');
  await verifier(['#volume-card .volume-essai[data-essai="voix"]']);
  await g.toast(julie, 'Écoutez la tablette : elle parle.');
  await p.click('#volume-card .setting-cancel');
  // Profil.
  await p.click('#view-settings .back');
  await g.attendreVue(julie, 'view-home');
  await p.click('.nav-item[data-tab="profile"]');
  await g.attendreVue(julie, 'view-profile');
  for (const carte of ['my-name-card', 'my-genre-card']) {
    for (const cible of ['h2', '.setting-value']) {
      await verifier([`#${carte} ${cible}`]);
      await p.click(`#${carte} .setting-cancel`);
    }
  }
  await verifier(['#view-profile .seg:not(.active)', '#face-camera', '#face-gallery']);
});
