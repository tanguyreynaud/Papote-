// Outils partagés par la galerie : récupérer les fichiers d'une branche, les servir en local,
// fabriquer de fausses photos et de faux visages (aucune vraie donnée, aucun accès à Firebase).
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const RACINE = path.resolve(__dirname, '..', '..');

function git(args, opts = {}) {
  return execFileSync('git', ['-C', RACINE, ...args], { encoding: opts.encoding ?? 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Copie le dossier `dossier` tel qu'il est sur `source` dans un dossier temporaire.
 * source = une branche ou un commit (origin/... est d'abord mis à jour), ou « ici » pour les fichiers du disque.
 * Renvoie { dir, version } : le dossier copié et le commit utilisé.
 */
function extraire(source, dossier) {
  if (source === 'ici') return { dir: path.join(RACINE, dossier), version: 'fichiers du disque' };
  if (source.startsWith('origin/')) {
    try { git(['fetch', '--quiet', 'origin', source.slice('origin/'.length)]); } catch (e) {
      console.warn(`  (pas de réseau pour mettre à jour ${source}, on prend la copie locale)`);
    }
  }
  const sha = git(['rev-parse', '--short', source]).trim();
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'papote-galerie-'));
  const tar = execFileSync('git', ['-C', RACINE, 'archive', '--format=tar', source, dossier], { maxBuffer: 512 * 1024 * 1024 });
  // tar existe sous Windows 10+ comme sous Linux.
  execFileSync('tar', ['-x', '-C', dest], { input: tar });
  return { dir: path.join(dest, dossier), version: `${source} @ ${sha}` };
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2',
};

/** Petit serveur de fichiers sur un port libre. Renvoie { url, close }. */
function servir(dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let f = path.join(dir, p);
      if (!f.startsWith(dir)) { res.writeHead(403); res.end(); return; }
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
      if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }));
  });
}

// ---------- Fausses images (SVG, avec leur vraie taille pour le portrait / paysage) ----------

const PAYSAGES = [
  ['#7dd3fc', '#e0f2fe', '#65a30d', '#3f6212', '#fde047'],
  ['#fca5a5', '#fde68a', '#0e7490', '#155e75', '#fff7ed'],
  ['#a5b4fc', '#e0e7ff', '#a16207', '#713f12', '#fef9c3'],
  ['#86efac', '#f0fdf4', '#1d4ed8', '#1e3a8a', '#fef08a'],
  ['#f9a8d4', '#fdf2f8', '#7c3aed', '#4c1d95', '#fffbeb'],
];

/** Une « photo » : ciel, soleil, collines, et un numéro pour la reconnaître. */
function fausseImage(n, largeur, hauteur) {
  const [c1, c2, h1, h2, s] = PAYSAGES[n % PAYSAGES.length];
  const w = largeur, h = hauteur;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#c)"/>
<circle cx="${w * 0.72}" cy="${h * 0.3}" r="${Math.min(w, h) * 0.09}" fill="${s}"/>
<path d="M0 ${h * 0.7} Q ${w * 0.25} ${h * 0.52} ${w * 0.5} ${h * 0.68} T ${w} ${h * 0.62} V ${h} H 0 Z" fill="${h1}"/>
<path d="M0 ${h * 0.84} Q ${w * 0.35} ${h * 0.7} ${w * 0.7} ${h * 0.86} T ${w} ${h * 0.8} V ${h} H 0 Z" fill="${h2}"/>
<text x="${w * 0.06}" y="${h * 0.14}" font-family="sans-serif" font-size="${Math.min(w, h) * 0.07}" fill="#0f172a" opacity=".45">Photo ${n + 1} · ${w > h ? 'paysage' : 'portrait'}</text>
</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

const TEINTES = ['#4f46e5', '#0891b2', '#be185d', '#15803d', '#7c3aed', '#b45309'];

/** Un « visage » : un rond de couleur avec l'initiale. */
function fauxVisage(nom, n = 0) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
<rect width="400" height="400" fill="${TEINTES[n % TEINTES.length]}"/>
<circle cx="200" cy="160" r="80" fill="#fff" opacity=".85"/><path d="M60 400c10-90 70-140 140-140s130 50 140 140z" fill="#fff" opacity=".85"/>
<text x="200" y="185" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="80" fill="${TEINTES[n % TEINTES.length]}">${nom.charAt(0)}</text>
</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

/** Un faux QR code (des carrés au hasard, toujours les mêmes). */
function fauxQr() {
  let x = 7;
  const rnd = () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
  let cases = '';
  for (let i = 0; i < 29; i++) for (let j = 0; j < 29; j++) {
    const coin = (i < 8 && j < 8) || (i < 8 && j > 20) || (i > 20 && j < 8);
    if (!coin && rnd() > 0.5) cases += `<rect x="${j}" y="${i}" width="1" height="1"/>`;
  }
  const oeil = (a, b) => `<rect x="${a}" y="${b}" width="7" height="7"/><rect x="${a + 1}" y="${b + 1}" width="5" height="5" fill="#fff"/><rect x="${a + 2}" y="${b + 2}" width="3" height="3"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 33 33" width="330" height="330"><rect x="-2" y="-2" width="33" height="33" fill="#fff"/><g fill="#000">${cases}${oeil(0, 0)}${oeil(22, 0)}${oeil(0, 22)}</g></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

module.exports = { RACINE, extraire, servir, fausseImage, fauxVisage, fauxQr };
