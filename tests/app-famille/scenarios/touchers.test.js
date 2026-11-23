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

  // Réglages > La famille > Membres : chaque ligne répond.
  await g.ouvrirFamille(julie);
  await p.locator('#members li', { hasText: 'Paul' }).locator('.member-email').click();
  assert.match(await g.texteFenetre(julie), /Paul/);
  await g.repondre(julie, 'Annuler');
  await p.locator('#members li', { hasText: 'Tablette de Mamie Emma' }).locator('.member-name').click();
  assert.match(await g.texteFenetre(julie), /En ligne par le Wi-Fi « Livebox-Emma »/);
  await g.repondre(julie, 'OK');
  // La photo de Mamie, ronde et vide : « Choisir une photo ».
  await g.panneau(julie, 'tablette');
  // La photo de Mamie touchée ouvre « Modifier » ; ouverte, le menu photo (appareil photo, galerie : Tanguy, 23/11),
  // et « Choisir dans la galerie » ouvre le choix d'une photo.
  await p.click('#tface-empty');
  await p.locator('#form-family-name').waitFor();
  await p.click('#tface-empty');
  assert.match(await g.texteFenetre(julie), /Appareil photo[\s\S]*Galerie/);
  assert.doesNotMatch(await g.texteFenetre(julie), /Retirer/, 'rien à retirer sans photo');
  await p.waitForTimeout(600);
  const choisi = p.waitForEvent('filechooser');
  await g.repondre(julie, 'Galerie');
  await (await choisi).setFiles([]).catch(() => {});
  await p.click('#family-name-card .setting-cancel');
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
  await g.panneau(julie, 'famille');
  await p.locator('#members li', { hasText: 'Julie' }).locator('.badge', { hasText: 'Responsable' }).click();
  await g.toast(julie, 'C\'est vous. Votre prénom, votre photo, votre numéro et « Quitter cette famille » sont dans « Mon profil ».');
  await g.retourAccueil(julie); // Réglages : plus de flèche, la barre du bas (23/11)
  await g.attendreVue(julie, 'view-home');
  await g.ouvrirProfil(julie);
  await g.attendreVue(julie, 'view-profile');
  // Ma photo touchée ouvre « Modifier » ; ouverte, elle propose de choisir une photo.
  await p.locator('#face-img, #face-empty').filter({ visible: true }).first().click();
  await p.locator('#form-my-name').waitFor();
  // Ouverte, la fenêtre photo (Tanguy, 23/11) : Appareil photo et Galerie, une croix pour fermer.
  await p.locator('#face-img, #face-empty').filter({ visible: true }).first().click();
  assert.match(await g.texteFenetre(julie), /Appareil photo[\s\S]*Galerie/);
  await p.waitForTimeout(600);
  await p.click('.dialog-back:not(.closing) .dialog-croix'); // la croix ferme la fenêtre (Tanguy, 23/11)
  await p.locator('.dialog-back').first().waitFor({ state: 'detached' });
  await p.click('#my-name-card .setting-cancel');

  // Photos : « Envoyé, pas vu » dit que Mamie ne l'a pas encore vue.
  await g.retourAccueil(julie);
  await g.ouvrirTuile(julie, 'photos');
  assert.equal((await p.locator('#photos .read-badge.unread').first().textContent()).trim(), 'Envoyé, pas vu');
  await p.locator('#photos .read-badge').first().click();
  await g.toast(julie, 'Mamie Emma ne l\'a pas encore vue.');
  await p.click('#view-photos .back');
  await g.attendreVue(julie, 'view-home');

  // Réglages dans la barre du bas (Tanguy, 20/11) ; double appui, une seule page : « retour » ramène à l'accueil.
  await p.locator('#nav-reglages').dblclick();
  await g.attendreVue(julie, 'view-settings');
  await p.goBack();
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
  for (const carte of ['family-name-card', 'meteo-card', 'duree-card', 'radio-card', 'sos-ordre-card', 'volume-card', 'sleep-card']) {
    for (const cible of carte === 'family-name-card' ? ['h2', '.setting-modify'] : ['h2', '.setting-value', '.setting-modify']) {
      await verifier([`#${carte} ${cible}`]);
      await p.click(`#${carte} .setting-cancel`);
    }
  }
  await p.click('#family-name-card .setting-modify');
  await verifier(['#tface-changer']);
  await p.click('#family-name-card .setting-cancel');
  await verifier(['#remote-card summary', '#remote-card [data-cmd="status"]']);
  await g.panneau(julie, 'famille');
  await verifier(['#members li:has-text("Paul") .member-name']);
  await g.panneau(julie, 'tablette');
  // Volumes : chaque « Écouter » (sonnerie, vidéos et messages, appels) dit en bas que la tablette joue ;
  // plus de récapitulatif.
  await p.click('#volume-card .setting-modify');
  await verifier(['#volume-card .volume-essai[data-essai="voix"]']);
  await g.toast(julie, 'Écoutez la tablette : elle parle.');
  await verifier(['#volume-card .volume-essai[data-essai="appel"]']);
  await g.toast(julie, 'Écoutez la tablette : elle parle comme pendant un appel.');
  await verifier(['#volume-card .volume-essai[data-essai="sonnerie"]']);
  await g.toast(julie, 'Écoutez la tablette : elle sonne.');
  await p.click('#volume-card .setting-cancel');
  // Profil.
  await g.retourAccueil(julie); // Réglages : plus de flèche, la barre du bas (23/11)
  await g.attendreVue(julie, 'view-home');
  await g.ouvrirProfil(julie);
  await g.attendreVue(julie, 'view-profile');
  for (const carte of ['my-name-card', 'my-genre-card']) {
    for (const cible of carte === 'my-name-card' ? ['h2', '.setting-modify'] : ['h2', '.setting-value']) {
      await verifier([`#${carte} ${cible}`]);
      await p.click(`#${carte} .setting-cancel`);
    }
  }
  await verifier(['#apparence-card summary', '#view-profile [data-theme-choice]:not(.active)']);
  await p.click('#my-name-card .setting-modify');
  await verifier(['#face-changer']);
});

// V14 (testeur, 17/11) : « Tout télécharger » sur une page Photos vide ne servait à rien. Caché tant qu'il n'y a
// aucune photo, il revient avec la première.
test('V14 : « Tout télécharger » caché sur la page Photos vide, de retour avec la première photo', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const photos = (await s.db.collection(`families/${fid}/posts`).where('type', '==', 'photo').get()).docs;
  assert.ok(photos.length, 'la photo de l\'installation');
  await Promise.all(photos.map((d) => d.ref.delete()));
  await g.ouvrirTuile(julie, 'photos');
  await julie.page.locator('#photos-empty').waitFor({ state: 'visible' });
  assert.strictEqual(await julie.page.locator('#btn-photos-zip').isVisible(), false, 'rien à télécharger');
  await photos[0].ref.set(photos[0].data());
  await julie.page.locator('#btn-photos-zip').waitFor({ state: 'visible' });
  assert.strictEqual(await julie.page.locator('#photos-empty').isVisible(), false);
});
