// La bulle du chat (vitrine/chat-support.js) dans un vrai navigateur, Chrome et Safari d'iPhone (WebKit) :
// dans l'appli, elle envoie le jeton de connexion et la famille ouverte ; sur le site, rien. Gestes de la vraie vie :
// double clic et Entrée en même temps (une seule question), jeton lent ou absent, coupure du réseau puis reprise.
// Lancer : NAVIGATEURS=chromium,webkit node --test chat-bulle.navigateur.js (Playwright installé à part, voir tests.yml).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit, devices } = require('playwright');

const BULLE = fs.readFileSync(path.join(__dirname, '..', 'vitrine', 'chat-support.js'), 'utf8');
const API = 'https://europe-west1-papote-famille.cloudfunctions.net/supportChat';
const NAVIGATEURS = (process.env.NAVIGATEURS || 'chromium').split(',').map((n) => n.trim()).filter(Boolean);

// Page minimale de l'appli (ou du site) avec la bulle ; crochets = ce que l'appli expose (window.papoteJeton…).
function page(crochets) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body><main>Papote</main><script>${crochets || ''}</script><script src="/chat-support.js"></script></body></html>`;
}

async function ouvrir(navigateur, nom, { hote = 'app.mapapote.fr', crochets = '', repondre } = {}) {
  const contexte = await navigateur.newContext(nom === 'webkit' ? { ...devices['iPhone 13'] } : { viewport: { width: 1200, height: 900 } });
  const p = await contexte.newPage();
  const recues = [];
  await p.route(`https://${hote}/`, (r) => r.fulfill({ contentType: 'text/html', body: page(crochets) }));
  await p.route(`https://${hote}/chat-support.js`, (r) => r.fulfill({ contentType: 'application/javascript', body: BULLE }));
  await p.route(API, async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    const req = { entetes: r.request().headers(), corps: JSON.parse(r.request().postData() || '{}') };
    recues.push(req);
    return (repondre || ((x, route) => route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ reponse: `Réponse ${recues.length}` }) })))(req, r);
  });
  await p.goto(`https://${hote}/`);
  await p.locator('.ps-bouton').click();
  await p.locator('.ps-panneau.ps-ouvert').waitFor();
  return { p, contexte, recues };
}

const APPLI = "window.papoteJeton = () => Promise.resolve('JETON-DE-TEST-0123456789abcdef'); window.papoteFamille = () => 'famille-123';";

for (const nom of NAVIGATEURS) {
  test.describe(`bulle du chat (${nom})`, () => {
    let navigateur;
    test.before(async () => { navigateur = await (nom === 'webkit' ? webkit : chromium).launch(); });
    test.after(async () => { await navigateur.close(); });

    test('appli connectée : jeton et famille envoyés, double clic + Entrée = une seule question, « … » tout de suite', async () => {
      let lacher;
      const attente = new Promise((r) => { lacher = r; });
      const { p, contexte, recues } = await ouvrir(navigateur, nom, {
        crochets: APPLI,
        repondre: async (req, route) => { await attente; route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ reponse: 'Votre tablette est en ligne.' }) }); },
      });
      await p.locator('.ps-saisie textarea').fill('Ma tablette est-elle en ligne ?');
      const envoyer = p.locator('.ps-saisie button');
      // Double toucher et Entrée presque en même temps.
      await envoyer.dblclick();
      // Pendant l'attente, la personne retape et appuie sur Entrée : rien ne part en double.
      await p.locator('.ps-saisie textarea').fill('Ma tablette est-elle en ligne ?');
      await p.locator('.ps-saisie textarea').press('Enter');
      await p.locator('.ps-attente').waitFor({ timeout: 1000 });
      assert.ok(await envoyer.isDisabled(), 'Envoyer grisé pendant l\'attente');
      await p.waitForTimeout(400);
      lacher();
      await p.getByText('Votre tablette est en ligne.').waitFor();
      assert.strictEqual(recues.length, 1, 'une seule question envoyée');
      assert.strictEqual(recues[0].entetes.authorization, 'Bearer JETON-DE-TEST-0123456789abcdef');
      assert.strictEqual(recues[0].corps.famille, 'famille-123');
      assert.strictEqual(recues[0].corps.page, 'appli');
      assert.strictEqual(await p.locator('.ps-moi').count(), 1, 'la question n\'apparaît qu\'une fois');
      // Question suivante : nouveau jeton demandé à l'appli (il peut avoir été renouvelé).
      await p.locator('.ps-saisie textarea').fill('Et la batterie ?');
      await p.locator('.ps-saisie textarea').press('Enter');
      await p.locator('.ps-ia', { hasText: 'Votre tablette est en ligne.' }).nth(1).waitFor();
      assert.strictEqual(recues.length, 2);
      assert.strictEqual(recues[1].entetes.authorization, 'Bearer JETON-DE-TEST-0123456789abcdef');
      await contexte.close();
    });

    test('appli sans compte connecté, ou appli ancienne : question envoyée sans jeton, comme avant', async () => {
      for (const crochets of ["window.papoteJeton = () => Promise.resolve(null); window.papoteFamille = () => 'famille-123';",
        "window.papoteJeton = () => Promise.resolve('JETON-DE-TEST-0123456789abcdef'); window.papoteFamille = () => null;",
        "window.papoteJeton = () => Promise.reject(new Error('déconnecté')); window.papoteFamille = () => 'famille-123';",
        "window.papoteJeton = () => { throw new Error('cassé'); }; window.papoteFamille = () => 'famille-123';",
        '']) {
        const { p, contexte, recues } = await ouvrir(navigateur, nom, { crochets });
        await p.locator('.ps-saisie textarea').fill('Bonjour');
        await p.locator('.ps-saisie textarea').press('Enter');
        await p.getByText('Réponse 1').waitFor();
        assert.strictEqual(recues.length, 1);
        assert.strictEqual(recues[0].entetes.authorization, undefined, `sans jeton (${crochets || 'pas de crochets'})`);
        assert.strictEqual(recues[0].corps.famille, undefined);
        await contexte.close();
      }
    });

    test('jeton qui ne vient pas : « … » tout de suite, question partie sans jeton au bout de 3 s', async () => {
      const { p, contexte, recues } = await ouvrir(navigateur, nom, { crochets: "window.papoteJeton = () => new Promise(() => {}); window.papoteFamille = () => 'famille-123';" });
      const debut = Date.now();
      await p.locator('.ps-saisie textarea').fill('Bonjour');
      await p.locator('.ps-saisie textarea').press('Enter');
      await p.locator('.ps-attente').waitFor({ timeout: 500 });
      await p.getByText('Réponse 1').waitFor({ timeout: 8000 });
      const duree = Date.now() - debut;
      assert.ok(duree >= 2800 && duree < 7000, `partie après ~3 s (${duree} ms)`);
      assert.strictEqual(recues[0].entetes.authorization, undefined);
      await contexte.close();
    });

    test('coupure du réseau : message calme, Envoyer revient, la question suivante passe', async () => {
      let coupe = true;
      const { p, contexte, recues } = await ouvrir(navigateur, nom, {
        crochets: APPLI,
        repondre: (req, route) => (coupe ? route.abort('internetdisconnected')
          : route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ reponse: 'Revoilà la réponse.' }) })),
      });
      await p.locator('.ps-saisie textarea').fill('Bonjour');
      await p.locator('.ps-saisie textarea').press('Enter');
      await p.getByText(/indisponible pour le moment/).waitFor();
      assert.ok(!(await p.locator('.ps-saisie button').isDisabled()), 'Envoyer revient');
      coupe = false;
      await p.locator('.ps-saisie textarea').fill('Vous êtes là ?');
      await p.locator('.ps-saisie textarea').press('Enter');
      await p.getByText('Revoilà la réponse.').waitFor();
      assert.strictEqual(recues.length, 2);
      assert.strictEqual(recues[1].entetes.authorization, 'Bearer JETON-DE-TEST-0123456789abcdef');
      await contexte.close();
    });

    test('site : jamais de jeton, même si une page l\'exposait', async () => {
      const { p, contexte, recues } = await ouvrir(navigateur, nom, { hote: 'mapapote.fr', crochets: '' });
      await p.locator('.ps-saisie textarea').fill('Où en est ma commande ABCD-2345 ?');
      await p.locator('.ps-saisie textarea').press('Enter');
      await p.getByText('Réponse 1').waitFor();
      assert.strictEqual(recues[0].corps.page, 'site');
      assert.strictEqual(recues[0].entetes.authorization, undefined);
      await contexte.close();
    });
  });
}
