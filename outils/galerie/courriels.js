// Les e-mails dans les vraies boîtes (Tanguy, 30/10) : Gmail sur téléphone (320 à 412 px de large, polices web
// ignorées, mode sombre qui inverse les couleurs), Apple Mail (375 px, respecte « color-scheme »), Outlook (lecture
// à 600 px et plus, Word comme moteur : ignore max-width et border-radius). Rien n'est envoyé : chaque e-mail de la
// galerie (emails.js) est rendu dans ces conditions et jugé : pas de débordement, pas d'image à bloquer, poids sous
// la coupure de Gmail (102 ko), liens absolus, texte brut présent, couleurs écrites partout (lisibles une fois inversées).
'use strict';

const fs = require('fs');
const path = require('path');

const LARGEURS = [{ nom: 'Gmail Android étroit', w: 320 }, { nom: 'Apple Mail iPhone', w: 375 }, { nom: 'Gmail Android', w: 412 }, { nom: 'Outlook, volet 600', w: 600 }, { nom: 'Outlook, volet large', w: 900 }];
const COUPURE_GMAIL = 102 * 1024;

// Contraste WCAG entre deux couleurs #rrggbb, et après inversion (mode sombre de Gmail : l'inversion garde à peu près le contraste).
function lum(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contraste = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
const inverse = (hex) => `#${[1, 3, 5].map((i) => (255 - parseInt(hex.slice(i, i + 2), 16)).toString(16).padStart(2, '0')).join('')}`;

// Dans la page rendue : débordement, textes coupés, et les paires texte/fond rencontrées.
function juger() {
  const pb = [];
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1) pb.push(`déborde : ${de.scrollWidth} px pour ${de.clientWidth}`);
  const paires = new Set();
  const rgb2hex = (c) => { const m = c.match(/\d+/g); return m && m.length >= 3 ? `#${m.slice(0, 3).map((x) => Number(x).toString(16).padStart(2, '0')).join('')}` : null; };
  const fond = (el) => { for (let e = el; e; e = e.parentElement) { const bg = getComputedStyle(e).backgroundColor; if (!/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) return rgb2hex(bg); } return '#ffffff'; };
  for (const el of document.querySelectorAll('body *')) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const st = getComputedStyle(el);
    if (st.display === 'none' || el.closest('[style*="display:none"]')) continue;
    const r = el.getBoundingClientRect();
    if (r.right > de.clientWidth + 1) pb.push(`texte hors cadre : « ${el.textContent.trim().slice(0, 30)} »`);
    const fg = rgb2hex(st.color);
    const bg = fond(el);
    if (fg && bg) paires.add(`${fg} ${bg}`);
  }
  return { pb: [...new Set(pb)], paires: [...paires] };
}

async function verifier({ browser, dossierSource, progression }) {
  const mail = require(path.join(dossierSource, 'mail.js'));
  const { scenes } = require('./emails');
  const SCENES = scenes(mail).filter((s) => s.contenu);
  const resultats = [];
  let n = 0;
  for (const scene of SCENES) {
    const { html, text, subject } = scene.contenu;
    const pb = [];
    const octets = Buffer.byteLength(html, 'utf8');
    if (octets > COUPURE_GMAIL) pb.push(`${Math.round(octets / 1024)} ko : Gmail coupe l'e-mail à 102 ko`);
    const images = (html.match(/<img\b/gi) || []).length;
    if (images) pb.push(`${images} image(s) : invisibles quand la boîte bloque les images`);
    if (!/<meta name="color-scheme" content="light">/.test(html)) pb.push('pas de « color-scheme » : Apple Mail peut assombrir à sa façon');
    if (!text || text.trim().length < 20) pb.push('pas de version texte brut (aperçu, lecteurs d\'écran, vieux Outlook)');
    for (const lien of html.match(/href="([^"]*)"/g) || []) {
      const u = lien.slice(6, -1);
      if (!/^(https:\/\/|mailto:)/.test(u)) pb.push(`lien non absolu : ${u.slice(0, 60)}`);
    }
    if (!subject || subject.length > 78) pb.push(`objet trop long (${(subject || '').length} caractères, coupé à ~60 sur téléphone)`);
    const paires = new Set();
    for (const { nom, w } of LARGEURS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, locale: 'fr-FR' });
      const page = await ctx.newPage();
      await page.route('**/*', (r) => r.abort()); // ni police web, ni image : comme Gmail
      await page.setContent(html, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(100);
      const r = await page.evaluate(juger);
      for (const p of r.pb) pb.push(`${nom} (${w} px) : ${p}`);
      r.paires.forEach((p) => paires.add(p));
      await ctx.close();
    }
    for (const paire of paires) {
      const [fg, bg] = paire.split(' ');
      const clair = contraste(fg, bg);
      const sombre = contraste(inverse(fg), inverse(bg));
      if (clair < 4.5) pb.push(`texte ${fg} sur ${bg} : contraste ${clair.toFixed(1)} (clair)`);
      if (sombre < 4.5) pb.push(`texte ${fg} sur ${bg} : contraste ${sombre.toFixed(1)} une fois inversé (mode sombre Gmail)`);
    }
    resultats.push({ titre: scene.titre, groupe: scene.groupe, ko: Math.round(octets / 102.4) / 10, images, pb: [...new Set(pb)] });
    progression(`e-mails ${++n}/${SCENES.length}`);
  }
  return resultats;
}

function rapport(resultats, version, dossier) {
  const faux = resultats.filter((r) => r.pb.length);
  const lignes = [`e-mails (${version}) : ${resultats.length} e-mails rendus à ${LARGEURS.map((l) => l.w).join('/')} px sans police ni image, ${faux.length} avec un souci`];
  lignes.push(`  poids : ${Math.min(...resultats.map((r) => r.ko))} à ${Math.max(...resultats.map((r) => r.ko))} ko (coupure Gmail à 102 ko) ; images : ${resultats.reduce((t, r) => t + r.images, 0)}`);
  for (const r of faux) { lignes.push(`  - ${r.titre}`); r.pb.forEach((p) => lignes.push(`      ${p}`)); }
  const fichier = path.join(dossier, 'courriels.txt');
  fs.writeFileSync(fichier, lignes.join('\n') + '\n');
  return { fichier, texte: lignes.join('\n') };
}

module.exports = { verifier, rapport, LARGEURS };
