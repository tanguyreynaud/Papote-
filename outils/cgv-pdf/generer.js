// CGV en PDF, jointes à l'e-mail de confirmation de commande (A13, Tanguy 12/11/2026) : support durable exigé
// pour un contrat conclu à distance. Fabriqué depuis vitrine/cgv.html (une seule source), gardé dans
// functions/documents/ avec l'empreinte de la page : si cgv.html change sans relancer ce script, les tests de
// functions/ deviennent rouges (mail.test.js).
//
// Lancer : node outils/cgv-pdf/generer.js   (Playwright et Chromium nécessaires, ceux des tests suffisent)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RACINE = path.join(__dirname, '..', '..');
const VITRINE = path.join(RACINE, 'vitrine');
const SORTIE = path.join(RACINE, 'functions', 'documents');
const TYPES = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.css': 'text/css', '.js': 'text/javascript' };

async function main() {
  const { chromium } = require('playwright');
  const serveur = http.createServer((req, res) => {
    const fichier = path.join(VITRINE, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!fichier.startsWith(VITRINE) || !fs.existsSync(fichier) || fs.statSync(fichier).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(fichier)] || 'application/octet-stream' });
    fs.createReadStream(fichier).pipe(res);
  });
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  const navigateur = await chromium.launch();
  try {
    const page = await navigateur.newPage();
    // Pas de bulle « Une question ? » sur papier.
    await page.route('**/chat-support.js', (route) => route.abort());
    await page.goto(`http://127.0.0.1:${serveur.address().port}/cgv.html`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    // Sur papier : pas de bouton « Retour », pas de place réservée en bas pour la bulle d'aide.
    await page.addStyleTag({ content: '.retour { display: none !important; } main { padding-bottom: 0 !important; }' });
    await page.pdf({
      path: path.join(SORTIE, 'cgv.pdf'), format: 'A4', printBackground: false,
      margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' },
      displayHeaderFooter: true, headerTemplate: '<span></span>',
      footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#5f5a6b">Papote · Conditions générales de vente · page <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
  } finally {
    await navigateur.close();
    serveur.close();
  }
  const empreinte = crypto.createHash('sha256').update(fs.readFileSync(path.join(VITRINE, 'cgv.html'))).digest('hex');
  fs.writeFileSync(path.join(SORTIE, 'cgv.empreinte'), `${empreinte}\n`);
  console.log(`functions/documents/cgv.pdf écrit (${fs.statSync(path.join(SORTIE, 'cgv.pdf')).size} octets), empreinte ${empreinte.slice(0, 12)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
