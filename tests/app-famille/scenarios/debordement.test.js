// Textes longs (Tanguy, 17/11 : un nom de commune long était coupé net dans Météo) : nom de la tablette, prénoms et
// e-mails des proches, réseaux Wi-Fi, communes. Partout dans l'app famille, un texte passe à la ligne ; jamais coupé
// net, jamais hors de l'écran (« … » seulement en dernier recours, le nom entier lisible ailleurs). Aussi en taille
// iPhone SE sous WebKit (CI).

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

const { s } = banc;

banc.brancher();

const NOM_TABLETTE = 'Grand-mère Marie-Thérèse de Montmorency'; // 39 caractères
const PRENOM_LONG = 'Jean-Baptiste-Emmanuel-Alexandre-Louis'; // 38
const EMAIL_LONG = 'jean-baptiste.emmanuel.alexandre@exemple-de-domaine-tres-long.fr';
const SSID_LONG = 'Livebox-Maison-GrandMere-5G-ABCD'; // 32, le plus long d'un Wi-Fi
const COMMUNE_LONGUE = 'Saint-Remy-en-Bouzemont-Saint-Genest-et-Isson';

/** Ce qui déborde à l'écran : texte coupé net (overflow caché sans « … »), ou hors de l'écran. */
async function debordements(t, ou) {
  const res = await t.page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const out = [];
    if (document.documentElement.scrollWidth > W + 1) out.push(`page plus large que l'écran (${document.documentElement.scrollWidth} > ${W})`);
    const nom = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`;
    const defile = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(p).overflowX) && p.scrollWidth > p.clientWidth + 1) return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('[hidden], .sr-only, svg, option, select')) continue;
      const texte = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
      if (!texte) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      if (defile(el)) continue;
      const extrait = texte.slice(0, 50);
      if (r.right > W + 1 || r.left < -1) out.push(`hors de l'écran : ${nom(el)} « ${extrait} » (${Math.round(r.left)} à ${Math.round(r.right)} sur ${W})`);
      if (el.scrollWidth > el.clientWidth + 1 && /(hidden|clip)/.test(cs.overflowX) && cs.textOverflow !== 'ellipsis') {
        out.push(`coupé net : ${nom(el)} « ${extrait} »`);
      }
    }
    return out;
  });
  assert.deepStrictEqual(res, [], `${ou} (${t.largeur} × ${t.hauteur})`);
}

test('Textes longs : nom de la tablette, prénoms, e-mails, Wi-Fi, communes passent à la ligne, jamais coupés ni hors de l\'écran', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const paul = await banc.telephone('Paul');
  await g.rejoindre(julie, fid, paul, { email: EMAIL_LONG, prenom: PRENOM_LONG });
  await paul.context.close();
  // Une demande pour rejoindre (e-mail long) et une invitation en attente (e-mail long).
  const lea = await banc.telephone('Léa');
  const { code } = await g.lire(`families/${fid}`);
  await g.inscrire(lea, `lea.${EMAIL_LONG}`, 'Marie-Léa-Clémentine-Joséphine', { suite: `?code=${code}` });
  await g.attendreVue(lea, 'view-join');
  await lea.page.click('#form-join button[type=submit]');
  await g.attendreVue(lea, 'view-pending');
  await lea.context.close();
  const tab = (await g.liste(`families/${fid}/members`)).find((m) => m.role === 'tablette');
  await s.db.doc(`families/${fid}/members/${tab.id}`).update({ lastOnline: s.Timestamp.now(), wifi: { ssid: SSID_LONG } });

  // Le nom de la tablette, changé dans Réglages : partout dans l'app.
  await g.ouvrirTuile(julie, 'settings');
  await julie.page.click('#family-name-card .setting-modify');
  await julie.page.fill('#family-name', NOM_TABLETTE);
  await julie.page.click('#family-name-card .setting-edit button[type=submit]');
  await g.toast(julie, 'Nom enregistré');
  await julie.page.locator('#members li', { hasText: PRENOM_LONG }).waitFor();
  await debordements(julie, 'Réglages');

  // Météo : le nom entier, à la ligne, dans la liste comme une fois choisi.
  await julie.page.click('#meteo-card .setting-modify');
  await julie.page.fill('#meteo-cp', '69650');
  const choix = julie.page.locator('#meteo-commune label', { hasText: 'Saint-Germain-au-Mont-d\'Or' });
  await choix.waitFor();
  assert.strictEqual(await choix.locator('input').isChecked(), false, 'deux communes : aucune choisie d\'office');
  await debordements(julie, 'Météo, deux communes');
  await julie.page.click('#meteo-card .setting-edit button[type=submit]');
  await julie.page.locator('#meteo-error', { hasText: 'Touchez la commune' }).waitFor();
  await julie.page.fill('#meteo-cp', '51290');
  const longue = julie.page.locator('#meteo-commune label', { hasText: COMMUNE_LONGUE });
  await longue.waitFor();
  assert.ok(await longue.locator('input').isChecked(), 'une seule commune : déjà choisie');
  assert.match(await longue.innerText(), new RegExp(`${COMMUNE_LONGUE} · 51290 · Marne`.replace(/\s+/g, '\\s+')));
  const lignes = await longue.locator('span').evaluate((e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight || 20)));
  await debordements(julie, 'Météo, commune longue');
  await julie.page.click('#meteo-card .setting-edit button[type=submit]');
  await g.toast(julie, 'Ville envoyée à la tablette');
  assert.strictEqual((await g.lire(`families/${fid}`)).meteoVille.nom, COMMUNE_LONGUE);
  await julie.page.locator('#meteo-current', { hasText: COMMUNE_LONGUE }).waitFor();
  assert.strictEqual(await julie.page.locator('#meteo-current').innerText(), COMMUNE_LONGUE, `nom entier (${lignes} ligne(s) dans la liste)`);
  await debordements(julie, 'Météo enregistrée');

  // Wi-Fi : le réseau au nom long, entier.
  await julie.page.locator('#wifi-current', { hasText: SSID_LONG }).waitFor();
  await julie.page.click('#wifi-modify');
  const scan = await g.attendreBase(async () => (await g.liste(`families/${fid}/commands`)).find((c) => c.type === 'wifiScan'), 'recherche des réseaux');
  await s.db.doc(`families/${fid}/commands/${scan.id}`).update({
    state: 'done', doneAt: s.Timestamp.now(),
    reseaux: [{ ssid: SSID_LONG, security: 'wpa2', signal: 4 }, { ssid: 'FreeWifi_secure-Bbox-AB12CD34EF', security: 'open', signal: 2 }],
  });
  await julie.page.locator('#wifi-list .wifi-name', { hasText: SSID_LONG }).waitFor();
  await julie.page.locator('#wifi-list .wifi-choice').first().click();
  await julie.page.locator('#wifi-list .wifi-info').waitFor();
  await julie.page.waitForTimeout(400);
  await debordements(julie, 'Wi-Fi de la tablette');
  await julie.page.click('#wifi-close');
  await julie.page.locator('#sheet-wifi').waitFor({ state: 'hidden' });

  // Accueil (demande pour rejoindre, titre), Inviter (invitation en attente), Profil.
  await julie.page.click('#view-settings .back');
  await g.attendreVue(julie, 'view-home');
  await julie.page.locator('#pending-banner', { hasText: 'Marie-Léa-Clémentine-Joséphine' }).waitFor();
  await julie.page.locator('#family-title, #family-switch').filter({ visible: true, hasText: NOM_TABLETTE }).first().waitFor();
  await debordements(julie, 'Accueil');
  await julie.page.click('#btn-invite');
  await g.attendreVue(julie, 'view-invite');
  await julie.page.fill('#invite-email', `invitee.${EMAIL_LONG}`);
  await julie.page.click('#form-invite button[type=submit]');
  await julie.page.locator('#invitations-sent li', { hasText: 'invitee.' }).waitFor();
  await debordements(julie, 'Inviter');
  await julie.page.click('#view-invite .back');
  await g.attendreVue(julie, 'view-home');
  for (const page of ['photos', 'messages', 'agenda']) {
    await g.ouvrirTuile(julie, page);
    await debordements(julie, page);
    await julie.page.click(`#view-${page} .back`);
    await g.attendreVue(julie, 'view-home');
  }
  await julie.page.click('.nav-item[data-tab="profile"]');
  await g.attendreVue(julie, 'view-profile');
  await debordements(julie, 'Profil');
});
