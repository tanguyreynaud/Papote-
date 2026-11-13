// Invitations de l'accueil (Tanguy, 13/11) : une seule à la fois, la plus importante d'abord ; quand elle est faite
// (ou repoussée par « Plus tard »), la suivante prend sa place. Ordre : notifications bloquées (app Android),
// « Recevoir les appels », mise en pause d'Android, numéro de la tablette, photo de profil, prélèvement (responsables).
// Dans la vraie vie, les deux premières et la 3e ne se croisent pas : « Recevoir les appels » est pour le navigateur,
// les notifications bloquées et la mise en pause pour l'app Android. D'où deux enchaînements : 1 → 3 → 4 → 5 → 6
// (app Android) et 2 → 4 → 6 (navigateur). À chaque fois : une seule carte visible à tout moment (relevé à chaque image),
// le compteur « 1 / N », le double appui qui ne fait qu'une chose. Chaque carte garde sa taille : les tuiles ne bougent
// jamais pendant un toucher ni dans l'instant qui suit (700 ms), puis glissent en douceur (au plus PAS_MAX px par image).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const banc = require('../banc');
const g = require('../gestes');

const { s } = banc;

banc.brancher();

const BADGES = ['notifs-nudge', 'push-nudge', 'pause-nudge', 'contact-encart', 'face-nudge', 'sepa-encart'];
const JETON = 'cJetonBadges:APA91b' + 'B'.repeat(140);
const JOUR = 24 * 3600 * 1000;
// Glissement de 250 ms : jusqu'à ~200 px de différence entre deux cartes, soit ~15 px par image en moyenne (60 images/s),
// davantage au milieu (ease-in-out) ; au-delà de 40 px d'une image à l'autre, c'est un saut.
const PAS_MAX = 40;
const ATTENTE_MIN_MS = 600; // la place ne bouge pas avant (700 ms après le doigt levé, moins la marge du relevé)
const capture = (t, nom) => t.page.screenshot({ path: path.join(__dirname, '..', 'captures', 'badges', `${nom}.png`) });

// Relevé à chaque image : le plus grand nombre de cartes visibles en même temps, et le mouvement des tuiles (plus grand
// pas d'une image à l'autre, nombre d'images où elles bougent, premier mouvement depuis le début du relevé).
async function surveiller(t) {
  await t.page.evaluate((ids) => {
    window.__releve = { max: 0, tMin: Infinity, tMax: -Infinity, images: 0, pasMax: 0, imagesMvt: 0, premier: null, debut: performance.now(), y: null };
    if (window.__surveille) return;
    window.__surveille = true;
    const vu = (e) => !!e && e.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
    (function image() {
      const r = window.__releve;
      if (!document.getElementById('view-home').hidden) {
        r.images++;
        r.max = Math.max(r.max, ids.filter((id) => vu(document.getElementById(id))).length);
        const y = document.querySelector('.tiles').getBoundingClientRect().top + window.scrollY;
        if (r.y !== null && Math.abs(y - r.y) >= 0.5) {
          r.pasMax = Math.max(r.pasMax, Math.abs(y - r.y));
          r.imagesMvt++;
          if (r.premier === null) r.premier = performance.now() - r.debut;
        }
        r.y = y;
        r.tMin = Math.min(r.tMin, y);
        r.tMax = Math.max(r.tMax, y);
      }
      requestAnimationFrame(image);
    })();
  }, BADGES);
}
/** Les tuiles n'ont bougé qu'après l'attente, et en glissant (pas de saut). */
function glissement(r, nom) {
  assert.ok(r.images > 5, 'relevé actif');
  assert.ok(r.pasMax <= PAS_MAX, `tuiles : saut de ${r.pasMax.toFixed(1)} px en une image (${nom})`);
  const course = r.tMax - r.tMin;
  if (course >= 0.5) {
    assert.ok(r.premier >= ATTENTE_MIN_MS, `tuiles parties ${Math.round(r.premier)} ms après le geste, avant le doigt levé (${nom})`);
    if (course > PAS_MAX) assert.ok(r.imagesMvt >= 3, `glissement en ${r.imagesMvt} images (${nom})`);
  }
}
const releve = (t) => t.page.evaluate(() => window.__releve);

/** Les cartes visibles, dans l'ordre. */
const visibles = (t) => t.page.evaluate((ids) => ids.filter((id) => document.getElementById(id)
  .checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })), BADGES);

/** Attend que cette carte (et elle seule) soit visible, avec ce compteur (null : pas de compteur). */
async function seule(t, id, compte) {
  await t.page.locator(`#${id}`).waitFor({ state: 'visible' });
  // Les cartes dues arrivent à leur rythme (famille, membres, abonnement) : le compteur se règle en quelques instants.
  await t.page.waitForFunction((attendu) => {
    const c = document.getElementById('badges-compte');
    return attendu ? !c.hidden && c.textContent === attendu : c.hidden;
  }, compte, { timeout: 10_000 }).catch(async () => {
    const c = t.page.locator('#badges-compte');
    assert.fail(`compteur sous ${id} : ${await c.isVisible() ? await c.innerText() : 'absent'}, attendu ${compte || 'absent'}`);
  });
  assert.deepStrictEqual(await visibles(t), [id], `seule ${id} est visible`);
}

/** Après un geste qui fait partir une carte : aucune carte, puis la suivante une fois le doigt levé, les tuiles qui glissent. */
async function remplacee(t, id, compte, nom) {
  await seule(t, id, compte);
  await t.page.waitForTimeout(400); // fin du glissement
  const r = await releve(t);
  assert.strictEqual(r.max, 1, `jamais deux cartes à la fois (${nom})`);
  glissement(r, nom);
}

async function famillePayee(t) {
  const r = await g.familleInstallee(t, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const abo = s.stripe.etat.abonnements.get(r.tab.commande);
  s.stripe.etat.clients.get(abo.customer).moyen = { id: 'pm_carte_test', type: 'card', card: { last4: '4242' } };
  s.avancer(31);
  s.stripe.finirEssai(r.tab.commande);
  await s.calme();
  // Premier prélèvement il y a 15 jours, à l'heure du téléphone : l'encart du prélèvement est dû.
  const maintenant = await t.page.evaluate(() => Date.now());
  await s.db.doc(`families/${r.fid}`).update({ 'paiement.premierLe': s.Timestamp.fromMillis(maintenant - 15 * JOUR) });
  const uid = (await g.liste(`families/${r.fid}/members`)).find((m) => m.email === 'julie@exemple.fr').id;
  return { ...r, uid };
}

// Photo retirée de la fiche, page ouverte (à l'ouverture suivante, la photo de l'inscription gardée par ce téléphone
// y revient d'elle-même : la carte « Ajoutez votre photo » ne se voit que tant que l'app reste ouverte, ou chez un
// proche inscrit avant la photo obligatoire).
const sansPhoto = (fid, uid) => s.db.doc(`families/${fid}/members/${uid}`).update({ face: null });
const avecNumero = (fid, tab) => s.db.doc(`families/${fid}/members/${tab.tabletUid}`).update({ telephone: '06 98 76 54 32' });

/** Les liens intent:// (réglages de l'app Android) demandés par la page. */
function liensAndroid(t) {
  const liste = [];
  t.page.on('request', (r) => { if (r.url().startsWith('intent://')) liste.push(r.url()); });
  return liste;
}

test('App Android : notifications bloquées → pause → numéro → photo → prélèvement, une carte à la fois', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab, uid } = await famillePayee(julie);
  await avecNumero(fid, tab);
  const intents = liensAndroid(julie);
  await g.ouvrirParApp(julie, `?natif=${JETON}&notifs=0&pause=1`);
  await g.attendreVue(julie, 'view-home', 30_000);
  await surveiller(julie);

  // 1. « Votre téléphone ne sonnera pas », en indigo plein, texte blanc ; 4 choses à faire.
  await seule(julie, 'notifs-nudge', '1 / 4');
  const style = await julie.page.evaluate(() => {
    const st = getComputedStyle(document.getElementById('notifs-nudge'));
    return { fond: st.backgroundColor, texte: st.color, titre: getComputedStyle(document.querySelector('#notifs-nudge strong')).color };
  });
  assert.deepStrictEqual(style, { fond: 'rgb(79, 70, 229)', texte: 'rgb(255, 255, 255)', titre: 'rgb(255, 255, 255)' });
  await capture(julie, '1-notifs');
  // Double appui : le réglage d'Android ne s'ouvre qu'une fois, la carte pâlit tout de suite.
  await g.doubleAppui(julie, '#notifs-nudge');
  assert.strictEqual(await julie.page.locator('#notifs-nudge').getAttribute('aria-busy'), 'true');
  await julie.page.waitForTimeout(500);
  assert.deepStrictEqual(intents.filter((u) => u.startsWith('intent://notifications')).length, 1, 'un seul réglage ouvert');
  // Notifications permises : Android rouvre l'app sans ?notifs=0.
  await g.ouvrir(julie, `?natif=${JETON}&pause=1`);
  await g.attendreVue(julie, 'view-home', 30_000);
  await surveiller(julie);

  // 3. « Empêcher Android de mettre Papote en pause » : double appui, un seul réglage, la carte part tout de suite.
  await seule(julie, 'pause-nudge', '1 / 3');
  // La photo de Julie retirée de sa fiche : « Ajoutez votre photo » prend son rang, derrière.
  await sansPhoto(fid, uid);
  await seule(julie, 'pause-nudge', '1 / 4');
  await surveiller(julie);
  await g.doubleAppui(julie, '#pause-nudge');
  assert.deepStrictEqual(await visibles(julie), [], 'partie tout de suite, la suivante attend le doigt levé');
  await remplacee(julie, 'contact-encart', '1 / 3', 'pause → numéro');
  assert.strictEqual(intents.filter((u) => u.startsWith('intent://sans-pause')).length, 1, 'un seul réglage ouvert');

  // 4. « C'est déjà fait » en double appui : la carte part, le 2e appui ne touche pas la carte suivante.
  await surveiller(julie);
  await g.doubleAppui(julie, '#contact-fait');
  await g.toast(julie, 'C\'est noté.');
  await remplacee(julie, 'face-nudge', '1 / 2', 'numéro → photo');
  assert.strictEqual(await g.vue(julie), 'view-home', 'le 2e appui n\'a pas ouvert la photo de profil');

  // 5. « Ajoutez votre photo » : double appui, le profil s'ouvre, rien d'autre.
  let fichiers = 0;
  julie.page.on('filechooser', () => { fichiers++; });
  await g.doubleAppui(julie, '#face-nudge');
  await g.attendreVue(julie, 'view-profile');
  await julie.page.waitForTimeout(500);
  assert.strictEqual(fichiers, 0, 'le 2e appui n\'a rien ouvert dans le profil');
  assert.strictEqual(await g.fenetresOuvertes(julie), 0);
  await julie.page.setInputFiles('#in-face-gallery', await g.photo({ texte: 'Julie' }));
  await julie.page.locator('#face-img').waitFor({ state: 'visible' });
  await g.retourAccueil(julie);

  // 6. Le prélèvement, seul, sans compteur ; « Plus tard » en double appui : plus rien, un seul effet.
  await seule(julie, 'sepa-encart', null);
  await surveiller(julie);
  await g.doubleAppui(julie, '#sepa-plus-tard');
  await g.toast(julie, 'reproposerons');
  await julie.page.waitForTimeout(1500);
  assert.deepStrictEqual(await visibles(julie), []);
  assert.strictEqual(await julie.page.locator('#badges-compte').isVisible(), false);
  assert.strictEqual(g.nbAppels('passerAuSepa'), 0, 'le 2e appui n\'a pas touché « Passer au prélèvement »');
  // Plus rien de dû : la place se referme en glissant, rien ne reste réservé.
  await julie.page.waitForFunction(() => document.getElementById('badges').offsetHeight === 0);
  const fin = await releve(julie);
  assert.strictEqual(fin.max, 1);
  glissement(fin, 'prélèvement → rien');
  assert.ok(fin.tMax - fin.tMin > 50, 'les tuiles sont remontées');
  await capture(julie, '6-plus-rien');
});

test('Navigateur : « Recevoir les appels » → numéro → prélèvement ; double appui sur chaque bouton = un seul effet', async () => {
  const julie = await banc.telephone('Julie');
  // Navigateur où les notifications sont possibles mais pas encore demandées (le banc les coupe d'habitude).
  await julie.context.route('https://www.gstatic.com/firebasejs/12.19.0/firebase-messaging.js', (route) => route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'access-control-allow-origin': '*' },
    body: `export async function isSupported() { return true; }
      export function getMessaging() { return {}; }
      export async function getToken() { return 'jeton-web-badges-${'w'.repeat(40)}'; }`,
  }));
  await julie.context.addInitScript(() => {
    window.__demandes = 0;
    class Notif {
      static get permission() { return localStorage.getItem('test.permission') || 'default'; }
      static async requestPermission() {
        window.__demandes++;
        await new Promise((ok) => setTimeout(ok, 300)); // la question du téléphone
        localStorage.setItem('test.permission', 'granted');
        return 'granted';
      }
    }
    window.Notification = Notif;
  });
  const { fid, tab } = await famillePayee(julie);
  await avecNumero(fid, tab);
  await julie.page.reload();
  await g.attendreVue(julie, 'view-home', 30_000);
  await surveiller(julie);

  // 2. « Recevoir les appels de Mamie Emma » : une seule demande d'autorisation, la carte pâlit pendant la question.
  await seule(julie, 'push-nudge', '1 / 3');
  await capture(julie, '2-push');
  await surveiller(julie);
  await g.doubleAppui(julie, '#push-nudge');
  assert.strictEqual(await julie.page.locator('#push-nudge').getAttribute('aria-busy'), 'true');
  await g.toast(julie, 'Notifications activées');
  await remplacee(julie, 'contact-encart', '1 / 2', 'appels → numéro');
  assert.strictEqual(await julie.page.evaluate(() => window.__demandes), 1, 'une seule demande');

  // 4. « Enregistrer le numéro » en double appui : une seule fiche contact.
  let fiches = 0;
  julie.page.on('download', () => { fiches++; });
  await surveiller(julie);
  await g.doubleAppui(julie, '#contact-oui');
  assert.strictEqual(await julie.page.locator('#contact-oui').innerText(), 'Un instant…', 'réaction visible tout de suite');
  await g.texteFenetre(julie).then((txt) => assert.match(txt, /Fiche contact de Mamie Emma prête/));
  await g.repondre(julie, 'OK');
  await remplacee(julie, 'sepa-encart', null, 'numéro → prélèvement');
  assert.strictEqual(fiches, 1, 'une seule fiche contact');

  // 6. « Passer au prélèvement » en double appui : une seule page Stripe.
  const [requete] = await Promise.all([
    julie.page.waitForRequest((r) => r.url().startsWith('https://checkout.stripe.test/')),
    g.doubleAppui(julie, '#sepa-oui'),
  ]);
  assert.ok(requete);
  assert.strictEqual(g.nbAppels('passerAuSepa'), 1);
});

test('Rien de dû : aucune carte ; une plus importante qui arrive sous le doigt attend qu\'il soit levé', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const uid = (await g.liste(`families/${fid}/members`)).find((m) => m.email === 'julie@exemple.fr').id;
  await julie.page.reload();
  await g.attendreVue(julie, 'view-home', 30_000);
  await julie.page.waitForTimeout(1500);
  assert.deepStrictEqual(await visibles(julie), [], 'photo, pas de numéro, pas de prélèvement à proposer : rien');
  assert.strictEqual(await julie.page.locator('#badges').evaluate((e) => e.offsetHeight), 0, 'aucune place réservée');
  assert.strictEqual(await julie.page.locator('#badges-compte').isVisible(), false);

  // La photo retirée : « Ajoutez votre photo », seule, sans compteur.
  await sansPhoto(fid, uid);
  await seule(julie, 'face-nudge', null);
  await julie.page.waitForTimeout(400); // la place a fini de s'ouvrir

  // Le doigt posé sur la carte, la tablette reçoit son numéro (plus important) : rien ne change sous le doigt.
  await surveiller(julie);
  const { x, y } = await g.centre(julie, '#face-nudge');
  const cdp = await julie.context.newCDPSession(julie.page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await avecNumero(fid, tab);
  await julie.page.locator('#badges-compte', { hasText: '/ 2' }).waitFor();
  await julie.page.waitForTimeout(1500);
  assert.deepStrictEqual(await visibles(julie), ['face-nudge'], 'toujours la même carte sous le doigt');
  const pendant = await releve(julie);
  assert.ok(pendant.images > 5 && pendant.tMax - pendant.tMin < 0.5, `tuiles immobiles sous le doigt : ${pendant.tMin} → ${pendant.tMax}`);
  await surveiller(julie);
  // Le doigt glisse et se lève sans toucher (pas de clic) : le numéro prend la place, les tuiles glissent ensuite.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await cdp.detach().catch(() => {});
  await remplacee(julie, 'contact-encart', '1 / 2', 'photo → numéro (plus important)');
  assert.strictEqual(await g.vue(julie), 'view-home');
});

test('Proche qui n\'est pas responsable : jamais le prélèvement ; la responsable l\'a après le numéro', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await famillePayee(julie);
  const paul = await banc.telephone('Paul');
  await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });
  await avecNumero(fid, tab);
  for (const t of [julie, paul]) {
    await t.page.reload();
    await g.attendreVue(t, 'view-home', 30_000);
  }
  await seule(julie, 'contact-encart', '1 / 2');
  await seule(paul, 'contact-encart', null);
  await g.doubleAppui(paul, '#contact-fait');
  await g.toast(paul, 'C\'est noté.');
  await paul.page.waitForTimeout(1500);
  assert.deepStrictEqual(await visibles(paul), [], 'pas de prélèvement pour Paul');
  await g.doubleAppui(julie, '#contact-fait');
  await seule(julie, 'sepa-encart', null);
});
