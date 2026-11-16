// Parcours de commande du site (vitrine/commande.html puis merci.html) sur téléphone, avec ce qui se passe
// APRÈS « Payer » : la galerie coupe la fonction commander (réponse 204), donc ni le retour depuis Stripe,
// ni les renvois du serveur (?trop=1, commande.html nu, erreur 500), ni le retour sur la page après avoir payé
// n'étaient rejoués. Ici, un faux « commander » et une fausse page Stripe les rejouent ; rien ne part sur internet.
//
// S1 à S8 : les défauts de l'audit du 11/11 (audit/commande-site-11-11.md), corrigés le même jour.
//
// Lancer : node --test outils/galerie/commande-site.test.js   (playwright installé, NODE_PATH si global)
//          CAPTURES=dossier pour garder une image de chaque constat.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { chromium } = require('playwright');
const { servir, RACINE } = require('./commun');
const vitrine = require('./vitrine');

const TELEPHONES = [
  { nom: 'petit téléphone (320 px)', width: 320, height: 568, mobile: true },
  { nom: 'téléphone Android courant (360 px)', width: 360, height: 740, mobile: true },
  { nom: 'iPhone (390 px)', width: 390, height: 844, mobile: true },
];
const TEL = TELEPHONES[1];
const STRIPE = 'https://checkout.stripe.test/c/pay/cs_test_audit';
const CORS = { 'Access-Control-Allow-Origin': '*' };
// Le vrai serveur répond par un renvoi 303 vers Stripe ; ici une page qui s'y rend aussitôt (un renvoi simulé vers
// un autre site partirait sur le vrai internet).
const versStripe = (r) => r.fulfill({ contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(STRIPE)})</script>` });

let browser, srv;
test.before(async () => {
  browser = await chromium.launch();
  srv = await servir(path.join(RACINE, 'vitrine'));
});
test.after(async () => { srv.close(); await browser.close(); });

let nCapture = 0;
async function capture(page, nom) {
  if (!process.env.CAPTURES) return;
  await page.screenshot({ path: path.join(process.env.CAPTURES, `${String(++nCapture).padStart(2, '0')}-${nom}.png`) }).catch(() => {});
}

// commander : ce que fait le faux serveur quand « Payer » est touché.
//   'stripe' (défaut) : renvoie vers la fausse page Stripe ; 'attend' : ne répond pas ; sinon une fonction (route).
async function ouvrir(fichier, { taille = TEL, commander = 'stripe', stock = () => true, session = null } = {}) {
  const appels = [];
  const { ctx, page, erreurs } = await vitrine.ouvrir(browser, srv.url, {
    fichier, session,
    routes: async (p) => {
      await p.route(/\/(stockDisponible|api\/stock)/, (r) => r.fulfill({ contentType: 'application/json', headers: CORS, body: JSON.stringify({ disponible: stock() }) }));
      await p.route('**/commander**', (r) => {
        appels.push(r.request().url());
        // 204 : le navigateur reste sur la page, comme pendant les 2 à 4 secondes d'attente du vrai serveur.
        if (commander === 'attend') return r.fulfill({ status: 204 });
        if (commander === 'stripe') return versStripe(r);
        return commander(r);
      });
      // Fausse page de paiement : « Retour » (cancel_url du serveur) et « Payer » (success_url).
      await p.route(/checkout\.stripe\.test/, (r) => r.fulfill({ contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><meta name="viewport" content="width=device-width"><title>Stripe (faux)</title>
          <a id="retour" href="${srv.url}/commande.html?formule=sim">← Papote</a>
          <a id="payer" href="${srv.url}/merci.html?session=cs_test_audit">Payer</a>` }));
      // « / » est servi par la fonction accueil : ici, la page elle-même.
      await p.route(/127\.0\.0\.1:\d+\/\?complet=1/, (r) => r.fulfill({ status: 302, headers: { Location: '/accueil.html?complet=1#prevenir' } }).catch(() => {}));
    },
  }, taille);
  return { ctx, page, erreurs, appels };
}

async function remplir(page, { nom = 'Marie Dupont', email = 'marie@exemple.fr' } = {}) {
  await page.fill('#adresse', 'lyon');
  await page.locator('#suggestions .point').first().click();
  await page.locator('#points .point:not(.fantome)').first().click();
  await page.fill('#destinataire', nom);
  await page.fill('#email', email);
  await page.waitForFunction(() => document.getElementById('payer').getAttribute('aria-disabled') === 'false');
}

const visible = (page, sel) => page.locator(sel).isVisible();
const texte = (page) => page.evaluate(() => document.body.innerText);

// ---------- Ce qui marche aujourd'hui ----------

for (const taille of TELEPHONES) {
  test(`Sur ${taille.nom} : la page ne dépasse jamais l'écran et « Payer » reste entier dans la barre`, async () => {
    const { ctx, page, erreurs } = await ouvrir('commande.html', { taille, commander: 'attend' });
    const largeur = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(await largeur() <= 0, 'page vide trop large');
    // « Payer » touché trop tôt : le message « Il reste à… » apparaît dans la barre.
    await page.locator('#payer').tap();
    assert.ok(await visible(page, '#manque'), 'aucun message quand il manque tout');
    await capture(page, `vide-payer-touche-${taille.width}`);
    await remplir(page, { nom: 'Marie-Christine Dupont-Lefebvre', email: 'mariechristine.dupontlefebvre@gmail.com' });
    assert.ok(await largeur() <= 0, 'page remplie trop large');
    const b = await page.locator('#payer').boundingBox();
    assert.ok(b.x >= 0 && b.x + b.width <= taille.width, 'bouton Payer coupé');
    assert.ok(b.height >= 44, `bouton Payer trop bas (${b.height} px)`);
    // La barre ne mange pas plus d'un tiers de l'écran.
    const barre = await page.locator('.barre').boundingBox();
    assert.ok(barre.height <= taille.height / 3, `barre de paiement trop haute (${Math.round(barre.height)} px sur ${taille.height})`);
    await capture(page, `remplie-${taille.width}`);
    assert.deepStrictEqual(erreurs, []);
    await ctx.close();
  });
}

test('Double appui sur « Payer » : un seul paiement ouvert, « Un instant… » affiché', async () => {
  const { ctx, page, appels } = await ouvrir('commande.html', { commander: 'attend' });
  await remplir(page);
  const b = await page.locator('#payer').boundingBox();
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.touchscreen.tap(x, y);
  await page.touchscreen.tap(x, y);
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(400);
  assert.strictEqual(await page.locator('#payer').innerText(), 'Un instant…');
  assert.strictEqual(appels.length, 1, `${appels.length} ouvertures de paiement pour un double appui`);
  await ctx.close();
});

test('Le lien de paiement porte tout ce que le serveur exige (adresse, relais, nom, e-mail)', async () => {
  const { ctx, page, appels } = await ouvrir('commande.html', { commander: 'attend' });
  await remplir(page);
  await page.check('#accord');
  await page.locator('#payer').tap();
  await page.waitForTimeout(300);
  const q = new URL(appels[0]).searchParams;
  for (const k of ['padr', 'plat', 'plon', 'pinsee', 'relais', 'rnom', 'rcp', 'rville', 'rdest', 'email']) assert.ok(q.get(k), `paramètre ${k} absent`);
  assert.strictEqual(q.get('accord'), '1');
  assert.strictEqual(q.get('rpays'), 'FR');
  await ctx.close();
});

test('Retour arrière depuis la page de paiement : tout est encore rempli et « Payer » est de nouveau actif', async () => {
  const { ctx, page } = await ouvrir('commande.html');
  await remplir(page);
  await page.locator('#payer').tap();
  await page.waitForURL(/checkout\.stripe\.test/);
  await page.goBack();
  await page.waitForFunction(() => document.getElementById('payer') && document.getElementById('payer').getAttribute('aria-disabled') === 'false');
  assert.strictEqual(await page.locator('#payer').innerText(), 'Payer 60 €');
  assert.strictEqual(await page.inputValue('#email'), 'marie@exemple.fr');
  assert.strictEqual(await page.inputValue('#destinataire'), 'Marie Dupont');
  await ctx.close();
});

test('« Payer » sans réseau : la page le dit, rien ne part, la commande reste remplie', async () => {
  const { ctx, page, appels } = await ouvrir('commande.html', { commander: 'attend' });
  await remplir(page);
  await ctx.setOffline(true);
  await page.locator('#payer').tap();
  assert.match(await page.locator('#manque').innerText(), /Pas de connexion/);
  assert.strictEqual(appels.length, 0);
  await ctx.close();
});

test('E-mail ou nom incomplet : « Payer » reste éteint et dit ce qui manque', async () => {
  const { ctx, page } = await ouvrir('commande.html', { commander: 'attend' });
  await remplir(page);
  for (const [champ, valeur, attendu] of [['#email', 'marie@exemple', /e-mail/], ['#email', 'marie exemple.fr', /e-mail/], ['#destinataire', 'Marie', /prénom et votre nom/]]) {
    const avant = await page.inputValue(champ);
    await page.fill(champ, valeur);
    assert.strictEqual(await page.locator('#payer').getAttribute('aria-disabled'), 'true', `${valeur} accepté`);
    assert.strictEqual(await page.locator('#payer').getAttribute('href'), null);
    assert.match(await page.locator('#manque').innerText(), attendu);
    await page.fill(champ, avant);
  }
  await ctx.close();
});

// ---------- Défauts de l'audit du 11/11, corrigés ----------

const MEME_PAGE = 'https://checkout.stripe.test/c/pay/cs_test_audit';

test('S1. Après avoir payé, la page de commande ne propose plus de payer la même commande', async () => {
  const { ctx, page } = await ouvrir('commande.html');
  await remplir(page);
  await page.locator('#payer').tap();
  await page.waitForURL(/checkout\.stripe\.test/);
  await page.locator('#payer').click();
  await page.waitForURL(/merci\.html/);
  await page.waitForTimeout(500);
  // Le client revient sur la page de commande (bouton Retour deux fois, ou « Commander » depuis l'accueil).
  await page.goto(`${srv.url}/commande.html`);
  await page.waitForTimeout(800);
  await capture(page, 'S1-apres-paiement');
  assert.ok(!(await visible(page, '#reprise')), '« Votre commande vous attend : il ne reste que le paiement » affiché alors que la commande est payée');
  assert.strictEqual(await page.locator('#payer').getAttribute('aria-disabled'), 'true', '« Payer 60 € » actif pour une commande déjà payée');
  assert.strictEqual(await page.inputValue('#email'), '', 'page de commande repartie de zéro');
  await ctx.close();
});

test('S1 bis. « Merci » ouverte sans paiement (pas de ?session) : la commande en cours reste gardée', async () => {
  const { ctx, page } = await ouvrir('commande.html', { commander: 'attend' });
  await remplir(page);
  await page.goto(`${srv.url}/merci.html`);
  await page.goto(`${srv.url}/commande.html`);
  await page.waitForTimeout(600);
  assert.ok(await visible(page, '#reprise'));
  await ctx.close();
});

test('S2. Renvoyé par le serveur avec ?trop=1 : le client lit pourquoi le paiement ne s\'ouvre pas', async () => {
  const { ctx, page, erreurs } = await ouvrir('commande.html', {
    commander: (r) => r.fulfill({ status: 303, headers: { Location: `${srv.url}/commande.html?trop=1` } }),
  });
  await remplir(page);
  await page.locator('#payer').tap();
  await page.locator('#avis').waitFor({ state: 'visible' });
  await capture(page, 'S2-trop');
  assert.match(await page.locator('#avis').innerText(), /Plusieurs paiements ont été ouverts[\s\S]*attendez une heure/);
  assert.ok(!(await visible(page, '#reprise')), '« il ne reste que le paiement » affiché en même temps que le refus');
  // La commande reste remplie, et le motif ne reste pas dans l'adresse (une page rechargée ne le répète pas).
  assert.strictEqual(await page.inputValue('#email'), 'marie@exemple.fr');
  assert.ok(!/trop/.test(page.url()));
  assert.deepStrictEqual(erreurs, []);
  await ctx.close();
});

test('S3. Le client revient de la page de paiement alors qu\'il tient la dernière tablette : il peut toujours payer', async () => {
  let reservee = false;
  const { ctx, page, appels } = await ouvrir('commande.html', {
    stock: () => !reservee, // une seule tablette en stock : elle est mise de côté dès que le paiement s'ouvre
    commander: (r) => { reservee = true; return versStripe(r); },
  });
  await remplir(page);
  await page.locator('#payer').tap();
  await page.waitForURL(/checkout\.stripe\.test/);
  // Lien « ← Papote » de la page Stripe (cancel_url) : la page de commande est rechargée.
  await page.locator('#retour').click();
  await page.waitForTimeout(1500);
  await capture(page, 'S3-derniere-tablette');
  assert.match(page.url(), /commande\.html/, `renvoyé vers ${page.url().replace(srv.url, '')}`);
  assert.ok(await visible(page, '#reprise'));
  // « Payer » repart vers le serveur, qui rouvre la même page (securite.parcours.js) ; même demande, mot pour mot.
  await page.locator('#payer').tap();
  await page.waitForURL(/checkout\.stripe\.test/);
  assert.strictEqual(page.url(), MEME_PAGE);
  assert.strictEqual(appels.length, 2);
  assert.strictEqual(appels[1], appels[0], 'la demande rejouée doit être identique pour retrouver la même page de paiement');
  // L'accueil non plus ne lui dit pas « Être prévenu » pendant son paiement.
  await page.goto(`${srv.url}/accueil.html`);
  await page.waitForTimeout(800);
  assert.strictEqual((await page.locator('.hero .js-commander').innerText()).trim(), 'Commander');
  await ctx.close();
});

test('S3 bis. Plus de tablette et aucun paiement en cours : toujours renvoyé vers « Être prévenu »', async () => {
  const { ctx, page } = await ouvrir('commande.html', { stock: () => false });
  await page.waitForURL(/complet=1/);
  assert.strictEqual((await page.locator('.hero .js-commander').innerText()).trim(), 'Être prévenu');
  await ctx.close();
});

for (const [motif, attendu, etape] of [['4g', /pas pu vérifier la 4G/, '#ok1'], ['relais', /point relais n'a pas été retenu/, '#ok2']]) {
  test(`S4. Le serveur refuse d'ouvrir le paiement (?refus=${motif}) : la page dit pourquoi et fait refaire l'étape`, async () => {
    const { ctx, page, erreurs } = await ouvrir('commande.html', {
      commander: (r) => r.fulfill({ status: 303, headers: { Location: `${srv.url}/commande.html?refus=${motif}` } }),
    });
    await remplir(page);
    await page.locator('#payer').tap();
    await page.locator('#avis').waitFor({ state: 'visible' });
    await capture(page, `S4-refus-${motif}`);
    assert.match(await page.locator('#avis').innerText(), attendu);
    assert.ok(!(await visible(page, '#reprise')));
    assert.ok(!(await visible(page, etape)), 'l\'étape refusée est encore cochée');
    assert.strictEqual(await page.locator('#payer').getAttribute('aria-disabled'), 'true', '« Payer » actif : le client repartirait en boucle');
    // Le reste est gardé.
    assert.strictEqual(await page.inputValue('#destinataire'), 'Marie Dupont');
    assert.deepStrictEqual(erreurs, []);
    await ctx.close();
  });
}

test('S5. Le paiement ne s\'ouvre pas (erreur du serveur) : le client revient sur sa commande remplie, « Payer » prêt', async () => {
  let n = 0;
  const { ctx, page } = await ouvrir('commande.html', {
    commander: (r) => (++n === 1 ? r.fulfill({ status: 303, headers: { Location: `${srv.url}/commande.html?erreur=1` } }) : versStripe(r)),
  });
  await remplir(page);
  await page.locator('#payer').tap();
  await page.locator('#avis').waitFor({ state: 'visible' });
  await capture(page, 'S5-erreur');
  assert.match(page.url(), /127\.0\.0\.1/);
  assert.match(await page.locator('#avis').innerText(), /Le paiement n'a pas pu s'ouvrir[\s\S]*« Payer »/);
  assert.strictEqual(await page.locator('#payer').innerText(), 'Payer 60 €');
  // Deuxième essai : le paiement s'ouvre.
  await page.locator('#payer').tap();
  await page.waitForURL(/checkout\.stripe\.test/);
  await ctx.close();
});

test('S6. Tous les liens et boutons de la page se touchent du doigt (44 px de haut au moins)', async () => {
  const { ctx, page } = await ouvrir('commande.html', { commander: 'attend' });
  // Brousse : la 4G ne passe pas partout, la rue est demandée et « Changer de ville » apparaît.
  await page.fill('#adresse', 'lyon');
  await page.locator('#suggestions .point').nth(1).click();
  await page.locator('#autre-ville').waitFor({ state: 'visible' });
  await page.locator('#points .point:not(.fantome)').first().waitFor();
  const petits = await page.evaluate(() => [...document.querySelectorAll('main a, main button')]
    .filter((el) => el.offsetParent && el.getBoundingClientRect().height < 44)
    .map((el) => `${el.textContent.trim().slice(0, 40)} (${Math.round(el.getBoundingClientRect().height)} px)`));
  assert.deepStrictEqual(petits, []);
  await ctx.close();
});

test('S7. La rue est demandée : la barre du bas dit « la rue », pas « la ville »', async () => {
  const { ctx, page } = await ouvrir('commande.html', { commander: 'attend' });
  await page.fill('#adresse', 'lyon');
  await page.locator('#suggestions .point').nth(1).click();
  await page.locator('#autre-ville').waitFor({ state: 'visible' });
  await page.locator('#payer').tap();
  assert.match(await page.locator('#manque').innerText(), /la rue/);
  await ctx.close();
});

test('S8. Petit téléphone (320 px) : le prix de la barre du bas n\'est pas coupé au milieu d\'un mot', async () => {
  const { ctx, page } = await ouvrir('commande.html', { taille: TELEPHONES[0], commander: 'attend' });
  const b = await page.locator('.barre-in b').boundingBox();
  const ligne = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.barre-in b')).lineHeight));
  assert.ok(b.height <= ligne + 2, `« 60 € aujourd'hui » tient sur ${Math.round(b.height / ligne)} lignes`);
  await page.locator('#payer').tap();
  await capture(page, 'S8-barre-320');
  await ctx.close();
});
