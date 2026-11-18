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

// V9 (testeur, 17/11) : « Installer l'app » flottait sur les tuiles, et le message du bas (« Photo envoyée ») se
// posait dessus. Il est dans la page, sous les tuiles. Recontrôle du 18/11 : en pastille indigo ombrée, coupée par la
// barre du bas selon la hauteur de l'écran et les cartes du haut, il avait encore l'air de flotter sur les tuiles ;
// c'est maintenant une ligne de la page, de la largeur des tuiles. Vérifié à chaque pas du défilement, debout et
// couché, du plus petit iPhone (320 × 568) au grand Android (412 × 915), zoom de la page à 130 % (écran plus étroit
// en px CSS) et grands caractères à 130 % (Réglages d'Android), avec et sans carte en haut de l'accueil, le message du
// bas affiché ; aussi sous WebKit (CI, iPhone 15 et SE).
const TAILLES_V9 = [[390, 844], [375, 667], [320, 568], [412, 915], [844, 390], [667, 375]];

/** Ce que cache ou ce qui cache « Installer l'app », à chaque pas du défilement de l'accueil. */
async function installerCache(t) {
  return t.page.evaluate(async () => {
    const out = new Set();
    const bouton = document.getElementById('btn-install');
    // Le message du bas, à sa place habituelle.
    const toast = document.createElement('p');
    toast.className = 'toast';
    toast.textContent = 'Photo envoyée';
    document.body.append(toast);
    const nom = (el) => el.id || (typeof el.className === 'string' ? el.className : el.tagName);
    const CONTENU = '.tile, .card, .badges > *, #tablette-en-route';
    const max = document.documentElement.scrollHeight - innerHeight;
    const pas = [];
    for (let y = 0; y < max; y += 40) pas.push(y);
    pas.push(max);
    for (const y of pas) {
      window.scrollTo(0, y);
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
      const b = bouton.getBoundingClientRect();
      const ici = `défilé de ${Math.round(scrollY)} px`;
      if (getComputedStyle(bouton).position !== 'static') out.add(`bouton ${getComputedStyle(bouton).position}`);
      // Une ligne de la page, pas une pastille posée : la largeur des tuiles.
      const tuiles = document.querySelector('#view-home .tiles').getBoundingClientRect();
      if (Math.abs(b.left - tuiles.left) > 1 || Math.abs(b.right - tuiles.right) > 1) out.add(`bouton pas de la largeur des tuiles (${Math.round(b.left)}-${Math.round(b.right)} / ${Math.round(tuiles.left)}-${Math.round(tuiles.right)})`);
      // Aucune tuile ni carte ne partage sa place.
      for (const el of document.querySelectorAll(`#view-home :is(${CONTENU})`)) {
        if (el.closest('[hidden]') || el.contains(bouton)) continue;
        const r = el.getBoundingClientRect();
        if (r.width && r.height && r.left < b.right - 1 && r.right > b.left + 1 && r.top < b.bottom - 1 && r.bottom > b.top + 1) out.add(`${nom(el)} sous le bouton (${ici})`);
      }
      // Ce qui est dessiné à sa place : le bouton n'est jamais au-dessus d'une tuile ou d'une carte.
      for (let i = 1; i < 6; i += 1) {
        for (let j = 1; j < 4; j += 1) {
          const x = b.left + (b.width * i) / 6;
          const yy = b.top + (b.height * j) / 4;
          if (yy < 0 || yy >= innerHeight) continue;
          const pile = document.elementsFromPoint(x, yy);
          const dessous = pile.slice(1).find((e) => !e.closest('#btn-install') && e.closest(CONTENU));
          if (pile[0]?.closest('#btn-install') && dessous) out.add(`bouton sur ${nom(dessous.closest(CONTENU))} (${ici})`);
          // Tout en bas de l'accueil : en entier, ni sous la barre du bas ni sous le message.
          if (y === max && !pile[0]?.closest('#btn-install')) out.add(`tout en bas, bouton caché par ${nom(pile[0])}`);
        }
      }
      if (y === max && (b.top < 0 || b.bottom > document.getElementById('nav').getBoundingClientRect().top + 1)) out.add(`tout en bas, bouton pas en entier au-dessus de la barre (${Math.round(b.top)}-${Math.round(b.bottom)})`);
    }
    toast.remove();
    window.scrollTo(0, 0);
    return [...out];
  });
}

test('V9 : « Installer l\'app » ne cache jamais rien, et le message du bas ne se pose pas dessus', async () => {
  const julie = await banc.telephone('Julie');
  await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await julie.page.locator('#btn-install').waitFor({ state: 'visible' });
  const echecs = [];
  for (const cartes of [false, true]) {
    // Les cartes du haut de l'accueil (« Ajoutez votre photo », tablette en route) poussent le bouton vers la barre.
    await julie.page.evaluate((oui) => {
      for (const id of ['face-nudge', 'tablette-en-route']) document.getElementById(id).hidden = !oui;
    }, cartes);
    for (const reglage of ['normal', 'zoom 130 %', 'caractères 130 %']) {
      await julie.page.evaluate((grand) => {
        for (const el of document.querySelectorAll('body *')) el.style.fontSize = '';
        if (!grand) return;
        const tailles = [...document.querySelectorAll('body *')].map((el) => [el, parseFloat(getComputedStyle(el).fontSize)]);
        for (const [el, px] of tailles) el.style.fontSize = `${px * 1.3}px`;
      }, reglage === 'caractères 130 %');
      for (const [l, h] of TAILLES_V9) {
        const z = reglage === 'zoom 130 %' ? 1.3 : 1;
        await julie.page.setViewportSize({ width: Math.round(l / z), height: Math.round(h / z) });
        await julie.page.waitForTimeout(100);
        const res = await installerCache(julie);
        if (res.length) echecs.push(`${l} × ${h}, ${reglage}, ${cartes ? 'avec' : 'sans'} cartes en haut : ${res.join(' ; ')}`);
      }
    }
  }
  assert.deepStrictEqual(echecs, []);
});
