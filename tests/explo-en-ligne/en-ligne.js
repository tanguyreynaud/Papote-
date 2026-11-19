// Testeur « vrai proche » 19/11 : le site et l'app famille EN LIGNE, sans paiement, sans compte.
// Chrome (Pixel 7) puis Safari (iPhone 15). Captures et journal dans SORTIE.
const { chromium, webkit, devices } = require('playwright');
const fs = require('fs'), path = require('path');
const SORTIE = process.env.SORTIE || path.join(__dirname, 'sortie');
fs.mkdirSync(SORTIE, { recursive: true });
const SITE = 'https://mapapote.fr', APP = 'https://papote-famille.web.app';
const journal = [];
const note = (...a) => { const l = a.join(' '); console.log(l); journal.push(l); };
const INTERDIT = [/tanguy/i, /reynaud/i, /0?6[ .]?76[ .]?77[ .]?11[ .]?70/, /\+33 ?6 ?76/];
let n = 0;

async function verifierTexte(page, ou, autorise) {
  const t = await page.evaluate(() => document.body ? document.body.innerText : '');
  for (const r of INTERDIT) {
    const m = t.match(new RegExp('.{0,60}' + r.source + '.{0,60}', 'gi')) || [];
    for (const x of m) note(`  ${autorise ? 'PERMIS' : 'TROUVÉ'} [${ou}] ${r} → « ${x.replace(/\s+/g, ' ')} »`);
  }
  return t;
}
async function cap(page, mot, nom, plein = false) {
  n++;
  const f = `${mot}-${String(n).padStart(3, '0')}-${nom}.png`;
  try { await page.screenshot({ path: path.join(SORTIE, f), fullPage: plein, timeout: 20000 }); } catch (e) { note('  capture ratée', f, e.message); }
  note('  📷', f);
}
async function etape(nom, f) { note('## ' + nom); try { await f(); } catch (e) { note('  ÉCHEC :', e.message.split('\n')[0]); } }

async function tour(moteur, appareil, mot) {
  const navigateur = await moteur.launch();
  const ctx = await navigateur.newContext({ ...devices[appareil], locale: 'fr-FR', timezoneId: 'Europe/Paris' });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') note('  console:', m.text().slice(0, 200)); });
  page.on('pageerror', e => note('  ERREUR JS:', e.message.slice(0, 200)));
  page.on('response', r => { if (r.status() >= 400 && !/google|gstatic|stripe/.test(r.url())) note('  HTTP', r.status(), r.url().slice(0, 140)); });
  note(`\n# ${mot} : ${appareil}`);

  // Pages du site : texte complet, recherche du prénom et du 06
  for (const [p, autorise] of [['/', false], ['/cgv', false], ['/mentions', true], ['/confidentialite', false], ['/resilier', false], ['/commande', false], ['/merci', false], ['/desinscription', false], ['/page-qui-nexiste-pas', false]]) {
    await etape('page ' + p, async () => {
      const r = await page.goto(SITE + p, { waitUntil: 'networkidle', timeout: 45000 });
      note('  statut', r && r.status(), 'titre', await page.title());
      await page.waitForTimeout(800);
      let t;
      if (p === '/') {
        // L'histoire de Papote est le seul endroit permis : on la vérifie à part
        const hist = await page.evaluate(() => { const h = [...document.querySelectorAll('h2,h3')].find(x => /histoire de Papote/i.test(x.textContent)); const s = h && (h.closest('section') || h.parentElement); return s ? s.innerText : ''; });
        note('  histoire trouvée :', hist ? 'oui' : 'NON', '|', hist.slice(0, 160).replace(/\s+/g, ' '));
        t = await page.evaluate(h => { const c = document.body.cloneNode(true); [...c.querySelectorAll('h2,h3')].filter(x => /histoire de Papote/i.test(x.textContent)).forEach(x => (x.closest('section') || x.parentElement).remove()); return c.innerText; });
        for (const r2 of INTERDIT) { const m = t.match(new RegExp('.{0,60}' + r2.source + '.{0,60}', 'gi')) || []; for (const x of m) note(`  TROUVÉ [/ hors histoire] ${r2} → « ${x.replace(/\s+/g, ' ')} »`); }
      } else t = await verifierTexte(page, p, autorise);
      if (p === '/cgv') note('  date CGV :', (t.match(/En vigueur[^\n.]*/) || ['ABSENTE'])[0]);
      await cap(page, mot, 'site' + (p === '/' ? '-accueil' : p.replace(/\//g, '-')), true);
    });
  }

  await etape('menu ☰ : ouvrir, toucher ailleurs', async () => {
    await page.goto(SITE + '/', { waitUntil: 'networkidle' });
    const b = page.locator('#menu-bouton');
    if (!(await b.isVisible())) { note('  pas de bouton ☰ visible'); return; }
    await b.tap(); await page.waitForTimeout(400); await cap(page, mot, 'menu-ouvert');
    note('  menu visible après appui :', await page.locator('#menu').isVisible());
    await page.touchscreen.tap(20, 700); await page.waitForTimeout(400);
    note('  menu visible après toucher ailleurs :', await page.locator('#menu').isVisible());
    await cap(page, mot, 'menu-apres-toucher-ailleurs');
  });

  await etape('pied de page', async () => {
    const t = await page.evaluate(() => { const f = document.querySelector('footer'); return f ? f.innerText : 'PAS DE FOOTER'; });
    note('  pied :', t.replace(/\s+/g, ' ').slice(0, 400));
    await page.locator('footer').scrollIntoViewIfNeeded().catch(() => {});
    await cap(page, mot, 'pied-de-page');
  });

  // Chat du site : qui est derrière, numéro de téléphone
  const questions = mot === 'and' ? ['Qui est derrière Papote ? Comment s\'appelle le fondateur ?', 'Je voudrais votre numéro de téléphone pour vous appeler'] : ['Qui est le fondateur de Papote et quel est son numéro ?'];
  await etape('chat du site', async () => {
    await page.goto(SITE + '/', { waitUntil: 'networkidle' });
    const bulle = page.locator('.ps-bouton');
    note('  bulle visible :', await bulle.isVisible());
    await bulle.tap(); await page.waitForTimeout(600);
    await cap(page, mot, 'chat-ouvert');
    for (const q of questions) {
      const avant = await page.locator('.ps-ia').count();
      await page.locator('.ps-saisie textarea, .ps-saisie input').first().fill(q);
      await page.keyboard.press('Enter');
      const t0 = Date.now();
      await page.waitForFunction(a => { const x = document.querySelectorAll('.ps-ia'); return x.length > a && !document.querySelector('.ps-attente'); }, avant, { timeout: 60000 }).catch(() => note('  pas de réponse en 60 s'));
      await page.waitForTimeout(1500);
      const rep = await page.locator('.ps-ia').last().innerText().catch(() => '');
      note(`  Q « ${q} » → (${((Date.now() - t0) / 1000).toFixed(1)} s) « ${rep.replace(/\s+/g, ' ').slice(0, 500)} »`);
      for (const r of INTERDIT) if (r.test(rep)) note('  TROUVÉ dans la réponse du chat :', r);
      await cap(page, mot, 'chat-reponse');
    }
  });

  // Commande jusqu'à « Payer » sans appuyer
  await etape('commande sans payer', async () => {
    await page.goto(SITE + '/commande', { waitUntil: 'networkidle' });
    await cap(page, mot, 'commande-depart');
    const adr = page.locator('#adresse');
    await adr.fill('');
    await adr.pressSequentially('12 rue de la République Lyon', { delay: 40 });
    await page.waitForTimeout(2500);
    await cap(page, mot, 'commande-suggestions');
    const sug = page.locator('#suggestions > *').first();
    if (await sug.count()) { await sug.tap(); } else note('  aucune suggestion');
    await page.waitForTimeout(5000);
    note('  verdict :', (await page.locator('#verdict').innerText().catch(() => '')).replace(/\s+/g, ' '));
    await cap(page, mot, 'commande-verdict', true);
    const ok1 = page.locator('#ok1'); if (await ok1.isVisible().catch(() => false)) { await ok1.tap(); await page.waitForTimeout(800); }
    const cp = page.locator('#cp');
    if (await cp.isVisible().catch(() => false)) {
      await cp.fill('69002'); await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(6000);
      const pts = page.locator('#points > *');
      note('  points relais :', await pts.count());
      await cap(page, mot, 'commande-relais', true);
      if (await pts.count()) { await pts.first().tap(); await page.waitForTimeout(800); }
      const ok2 = page.locator('#ok2'); if (await ok2.isVisible().catch(() => false)) { await ok2.tap(); await page.waitForTimeout(800); }
    }
    await cap(page, mot, 'commande-qui', true);
    const t = await verifierTexte(page, 'commande remplie', false);
    note('  bouton Payer :', await page.locator('#payer').innerText().catch(() => '?'), 'aria-disabled=', await page.locator('#payer').getAttribute('aria-disabled').catch(() => '?'));
    note('  (Payer NON touché)');
  });

  // App famille sans compte
  await etape('app famille, premier écran', async () => {
    const r = await page.goto(APP + '/', { waitUntil: 'networkidle', timeout: 45000 });
    note('  statut', r && r.status());
    await page.waitForTimeout(4000);
    await verifierTexte(page, 'app accueil', false);
    await cap(page, mot, 'app-depart', true);
    const boutons = await page.evaluate(() => [...document.querySelectorAll('button,a')].filter(b => b.offsetParent).map(b => b.innerText.trim()).filter(Boolean));
    note('  boutons visibles :', boutons.join(' | ').slice(0, 400));
  });
  await etape('app famille, lien par e-mail (sans envoyer)', async () => {
    const b = page.getByText(/e-mail/i).first();
    if (await b.isVisible().catch(() => false)) { await b.tap(); await page.waitForTimeout(800); await cap(page, mot, 'app-email'); await verifierTexte(page, 'app e-mail', false); }
    else note('  pas de choix e-mail visible');
  });
  await etape('app famille, invitation inconnue', async () => {
    await page.goto(APP + '/?invitation=ESSAI-INCONNU', { waitUntil: 'networkidle' });
    await page.waitForTimeout(4000);
    await verifierTexte(page, 'app invitation', false);
    await cap(page, mot, 'app-invitation-inconnue', true);
  });
  await etape('chat dans l\'app sans compte', async () => {
    const bulle = page.locator('.ps-bouton, [aria-label*="assistance" i], [aria-label*="aide" i]').first();
    note('  bulle d\'aide visible :', await bulle.isVisible().catch(() => false));
  });
  await navigateur.close();
}

(async () => {
  const qui = process.env.MOTEURS || 'and,ios';
  if (qui.includes('and')) await tour(chromium, 'Pixel 7', 'and');
  if (qui.includes('ios')) await tour(webkit, 'iPhone 15', 'ios');
  fs.writeFileSync(path.join(SORTIE, 'journal.md'), journal.join('\n') + '\n');
})();
