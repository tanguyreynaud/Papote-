// Les e-mails dans les vraies boîtes (Tanguy, 30/10 puis 3/11 : « tester les e-mails comme dans Gmail/Outlook sans
// vraie boîte »). Rien n'est envoyé, rien ne sort sur internet : chaque e-mail de la galerie (emails.js) est
// transformé comme le ferait chaque boîte, rendu dans Chromium, jugé et capturé.
//
//  1. Gmail sans styles : tout <style>, <link>, <script>, class, id, « position » et image de fond retirés (les
//     applis Gmail et les comptes non Google les enlèvent) ; seuls restent les styles en ligne. 360 et 1000 px.
//  2. Outlook bureau (moteur Word), approché : commentaires [if mso] appliqués, @media, max-width, border-radius,
//     flex/grid, padding des liens et taille des <div> ignorés, mso-padding-alt appliqué. 1000 px. Plus une
//     relecture du code d'après caniemail : erreur seulement pour ce qui casse vraiment, le reste en avertissement.
//  3. Mode sombre simulé : inversion totale (Outlook.com, applis Outlook, Gmail iOS) et partielle (appli Gmail
//     Android : seuls les fonds clairs et les textes foncés changent). Clarté inversée dans l'espace Lab (la teinte
//     reste) ; contraste de chaque texte ≥ 4,5 et pastilles (logo, numéros) visibles sur leur fond.
//  4. Largeurs 320 à 1000 px : rien de plus large que l'écran, aucun mot court coupé sur deux lignes (miseEnPage).
//  5. Images bloquées : chaque <img> a un alt (vide si décorative), une largeur et une hauteur ; rien ne s'effondre.
//
// Plus : poids sous la coupure de Gmail (102 ko), liens absolus, texte brut, objet pas trop long.
// Les captures de chaque mode vont dans sortie/images/courriels-*.jpg et sortie/courriels.html (même galerie,
// mêmes numéros E1, E2… que la galerie des e-mails). Ce n'est qu'une simulation : voir README.md pour ce qui ne
// se vérifie que dans une vraie boîte.
'use strict';

const fs = require('fs');
const path = require('path');
const { miseEnPage } = require('./commun');

// Le HTML tel quel, aux largeurs des boîtes.
const LARGEURS = [
  { nom: 'Gmail Android étroit', w: 320 }, { nom: 'Téléphone', w: 360 }, { nom: 'Apple Mail iPhone', w: 375 },
  { nom: 'Gmail Android', w: 412 }, { nom: 'Outlook, volet 600', w: 600 }, { nom: 'Outlook, volet large', w: 900 }, { nom: 'Ordinateur', w: 1000 },
];
const COUPURE_GMAIL = 102 * 1024;

// ---------- Transformations, comme chaque boîte ----------

// Retire des déclarations d'un attribut style="…" (noms en minuscules ou expressions).
function filtrerStyles(html, garder) {
  return html.replace(/\sstyle="([^"]*)"/gi, (m, s) => {
    const decl = s.split(';').map((d) => d.trim()).filter(Boolean).filter((d) => {
      const i = d.indexOf(':');
      return i > 0 && garder(d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim().toLowerCase());
    });
    return decl.length ? ` style="${decl.join(';')}"` : '';
  });
}

// Gmail le plus strict (appli, comptes non Google, transfert) : seuls les styles en ligne survivent.
function versionGmail(html) {
  const h = html
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/\s(class|id)="[^"]*"/gi, '');
  return filtrerStyles(h, (nom, val) => nom !== 'position' && nom !== 'background-image' && !/url\(/.test(val));
}

// Retire les blocs @media (et autres @…{…}) d'une feuille de style : Word les ignore.
function sansArobases(css) {
  let out = '';
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '@') {
      let j = css.indexOf('{', i);
      if (j < 0) break;
      let prof = 1;
      for (j++; j < css.length && prof; j++) { if (css[j] === '{') prof++; else if (css[j] === '}') prof--; }
      i = j - 1;
      continue;
    }
    out += css[i];
  }
  return out;
}

// Outlook bureau 2007-2021 (moteur Word), approché : ce qu'il ignore est retiré, ce qui ne vise que lui est appliqué.
function versionOutlook(html) {
  let h = html
    // <!--[if mso]>…<![endif]--> : visible dans Outlook seulement ; <!--[if !mso]><!-->…<!--<![endif]--> : caché.
    .replace(/<!--\[if !mso\]><!-->[\s\S]*?<!--<!\[endif\]-->/gi, '')
    .replace(/<!--\[if ([^\]]*)\]>([\s\S]*?)<!\[endif\]-->/gi, (m, cond, dedans) => (/mso/i.test(cond) && !/!\s*mso/i.test(cond) ? dedans : ''))
    .replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (m, a, css) => `<style${a}>${sansArobases(css)}</style>`)
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '');
  const IGNORE = new Set(['max-width', 'min-width', 'max-height', 'border-radius', 'box-shadow', 'opacity', 'position', 'background-image',
    'transform', 'overflow-wrap', 'text-overflow', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius']);
  // Par balise : padding, margin, width et height des éléments en ligne (a, span) ne comptent pas ; ceux des <div> non plus.
  h = h.replace(/<(a|span|div|p|td|th|table)\b([^>]*)>/gi, (m, tag, attrs) => {
    const t = tag.toLowerCase();
    const enLigne = t === 'a' || t === 'span';
    let alt = null;
    const a2 = filtrerStyles(` ${attrs}`, (nom, val) => {
      if (nom === 'mso-padding-alt') { alt = val; return false; }
      if (IGNORE.has(nom)) return false;
      if (nom === 'display' && /flex|grid|inline-block/.test(val)) return false;
      if (nom === 'background' && /url\(/.test(val)) return false;
      if (enLigne && /^(padding|margin|width|height|border)/.test(nom)) return false;
      if (t === 'div' && (nom === 'width' || nom === 'height')) return false;
      return true;
    }).slice(1);
    let res = `<${tag}${a2 ? ` ${a2.trim()}` : ''}>`;
    if (alt) res = /style="/.test(res) ? res.replace(/style="/, `style="padding:${alt};`) : res.replace(/>$/, ` style="padding:${alt}">`);
    return res;
  });
  return h;
}

// ---------- Relecture du code (Outlook et Gmail, d'après caniemail) ----------

// Dans la page (HTML d'origine) : { erreurs, avertissements }.
function relire() {
  const erreurs = [];
  const avert = [];
  const html = document.documentElement.outerHTML;
  const source = window.__source || html;
  const sty = (el) => (el.getAttribute('style') || '').toLowerCase();
  const decl = (el, nom) => { const m = sty(el).match(new RegExp(`(?:^|;)\\s*${nom}\\s*:\\s*([^;]+)`)); return m ? m[1].trim() : null; };
  const nom = (el) => el.tagName.toLowerCase() + (el.textContent.trim() ? ` « ${el.textContent.trim().replace(/\s+/g, ' ').slice(0, 25)} »` : '');

  for (const el of document.querySelectorAll('[style]')) {
    const d = decl(el, 'display');
    if (d && /flex|grid/.test(d) && !el.closest('[style*="display:none"]')) erreurs.push(`display:${d} sur ${nom(el)} : Outlook (Word) ne connaît ni flex ni grid, tout s'empile`);
    if (decl(el, 'position')) erreurs.push(`position sur ${nom(el)} : retiré par Gmail`);
    const bgImg = /url\(/.test(decl(el, 'background-image') || '') || /url\(/.test(decl(el, 'background') || '');
    if (bgImg) {
      const couleur = decl(el, 'background-color') || el.getAttribute('bgcolor') || /#[0-9a-f]{3,6}/.test(decl(el, 'background') || '');
      (couleur ? avert : erreurs).push(`image de fond sur ${nom(el)} : ignorée par Outlook et Gmail${couleur ? ' (couleur de repli présente)' : ', sans couleur de repli : texte sur fond vide'}`);
    }
    if (decl(el, 'max-width') && !/<!--\[if [^\]]*mso[^\]]*\]>\s*<table[^>]*width="\d+/i.test(source)) {
      erreurs.push(`max-width sur ${el.tagName.toLowerCase()} sans tableau de largeur fixe pour Outlook ([if mso]) : la carte s'étire sur toute la fenêtre d'Outlook`);
    }
    const r = decl(el, 'border-radius');
    if (r && el.tagName === 'DIV' && /50%|999/.test(r)) avert.push("rond fait d'un <div> arrondi (pastille, numéro) : carré dans Outlook, qui ignore aussi la taille d'un <div>");
    if (el.tagName === 'DIV' && (decl(el, 'width') || decl(el, 'height')) && !/50%|999/.test(r || '')) avert.push(`taille sur un <div> (${nom(el)}) : ignorée par Outlook`);
    if (/^(div|table)$/i.test(el.tagName) && /auto/.test(decl(el, 'margin') || '') && el.getAttribute('align') !== 'center' && el.parentElement?.getAttribute('align') !== 'center') avert.push(`margin:auto pour centrer (${el.tagName.toLowerCase()}) : Outlook ne centre pas ainsi, prévoir align="center"`);
    // Bouton : un lien avec du padding n'est cliquable que sur son texte dans Outlook, sauf repli mso.
    if (el.tagName === 'A' && decl(el, 'padding')) {
      const td = el.closest('td');
      const repli = (td && /mso-padding-alt/.test(sty(td))) || /v:roundrect/i.test(source);
      if (!repli) erreurs.push(`bouton ${nom(el)} : son padding est ignoré par Outlook (bouton réduit au texte) ; mettre mso-padding-alt sur la cellule ou un bouton VML`);
      if (!el.closest('table')) erreurs.push(`bouton ${nom(el)} hors tableau : préférer une cellule colorée (bouton « à toute épreuve »)`);
    }
  }
  for (const t of document.querySelectorAll('table')) {
    if (t.getAttribute('role') !== 'presentation') avert.push('tableau de mise en page sans role="presentation" : les lecteurs d\'écran l\'annoncent comme un tableau de données');
  }
  for (const img of document.querySelectorAll('img')) {
    const src = (img.getAttribute('src') || '').slice(0, 50);
    if (!img.hasAttribute('alt')) erreurs.push(`image ${src} sans alt (mettre alt="" si elle est décorative)`);
    else if (/\.(png|jpe?g|gif|svg|webp)$|^(image|img|photo|logo)$/i.test(img.getAttribute('alt').trim())) avert.push(`image ${src} : alt « ${img.getAttribute('alt')} » ne dit rien`);
    if (!img.hasAttribute('width')) erreurs.push(`image ${src} sans attribut width : Outlook l'affiche à sa taille réelle et casse la mise en page`);
    if (!img.hasAttribute('height')) avert.push(`image ${src} sans attribut height : la place n'est pas gardée quand les images sont bloquées`);
    avert.push(`image ${src} : vérifier qu'elle reste visible sur fond sombre (fond transparent)`);
  }
  for (const s of document.querySelectorAll('link[rel="stylesheet"], script')) erreurs.push(`<${s.tagName.toLowerCase()}> : retiré par toutes les boîtes`);
  for (const st of document.querySelectorAll('style')) {
    const css = st.textContent;
    if (/@font-face|@import/.test(css)) avert.push('police web (@font-face/@import) : ignorée par Gmail et Outlook, et Outlook passe alors en Times');
    if (/display\s*:\s*(flex|grid)/.test(css)) erreurs.push('display flex/grid dans <style> : Outlook l\'ignore');
    // Règles hors @media visant une classe ou un id : perdues quand Gmail retire <style>.
    const horsMedia = css.replace(/@[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    for (const m of horsMedia.matchAll(/([^{}]+)\{/g)) if (/[.#]/.test(m[1])) avert.push(`règle « ${m[1].trim()} » seulement dans <style> : perdue dans Gmail sans styles`);
  }
  for (const a of document.querySelectorAll('a[href]')) if (!/color/.test(sty(a))) avert.push(`lien « ${a.textContent.trim().slice(0, 25)} » sans couleur en ligne : bleu par défaut dans Gmail sans styles`);
  if (/'(Atkinson|Bricolage)/.test(source) && !/<!--\[if mso\]>(?:(?!<!\[endif\]-->)[\s\S])*<style[^>]*>[^<]*font-family/i.test(source)) {
    avert.push('police de la marque en premier sans repli pour Outlook ([if mso] <style> font-family:Arial) : risque de Times New Roman');
  }
  if (!/PixelsPerInch/.test(source)) avert.push('pas de PixelsPerInch 96 pour Outlook : largeurs agrandies sur les écrans à 120 dpi');
  return { erreurs: [...new Set(erreurs)], avert: [...new Set(avert)] };
}

// ---------- Mesures dans la page rendue ----------

// Fonctions de couleur et de contraste, injectées dans la page (window.__c).
function outilsCouleur() {
  const rgb = (c) => { const m = String(c).match(/[\d.]+/g); if (!m || m.length < 3) return null; return { r: +m[0], g: +m[1], b: +m[2], a: m.length > 3 ? +m[3] : 1 }; };
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const delin = (v) => { const x = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055; return Math.round(Math.min(1, Math.max(0, x)) * 255); };
  const lum = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const contraste = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
  // sRGB ↔ Lab (D65) : on inverse la clarté L, la teinte reste (comme les vraies inversions, à peu près).
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fi = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const versLab = ({ r, g, b }) => {
    const [R, G, B] = [lin(r), lin(g), lin(b)];
    const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
    return { L: 116 * f(Y) - 16, A: 500 * (f(X) - f(Y)), B: 200 * (f(Y) - f(Z)) };
  };
  const depuisLab = ({ L, A, B }) => {
    const fy = (L + 16) / 116, fx = fy + A / 500, fz = fy - B / 200;
    const X = fi(fx) * 0.95047, Y = fi(fy), Z = fi(fz) * 1.08883;
    const R = 3.2406 * X - 1.5372 * Y - 0.4986 * Z, G = -0.9689 * X + 1.8758 * Y + 0.0415 * Z, Bb = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
    return { r: delin(R), g: delin(G), b: delin(Bb), a: 1 };
  };
  const clarte = (c) => versLab(c).L;
  const inverser = (c) => { const l = versLab(c); return { ...depuisLab({ ...l, L: 100 - l.L }), a: c.a }; };
  const css = (c) => `rgb(${c.r}, ${c.g}, ${c.b})`;
  const hex = (c) => `#${[c.r, c.g, c.b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  window.__c = { rgb, lum, contraste, clarte, inverser, css, hex };
}

// Mode sombre simulé : 'total' inverse tout, 'partiel' seulement les fonds clairs (L > 60) et les textes foncés (L < 50).
function assombrir(mode) {
  const { rgb, clarte, inverser, css } = window.__c;
  const changer = [];
  const tous = [document.documentElement, document.body, ...document.querySelectorAll('body *')];
  for (const el of tous) {
    const st = getComputedStyle(el);
    const c = {};
    const bg = rgb(st.backgroundColor);
    if (bg && bg.a > 0 && (mode === 'total' || clarte(bg) > 60)) c.backgroundColor = css(inverser(bg));
    const fg = rgb(st.color);
    if (fg && (mode === 'total' || clarte(fg) < 50)) c.color = css(inverser(fg));
    for (const cote of ['Top', 'Right', 'Bottom', 'Left']) {
      const b = rgb(st[`border${cote}Color`]);
      if (b && parseFloat(st[`border${cote}Width`]) > 0 && (mode === 'total' || clarte(b) > 60)) c[`border${cote}Color`] = css(inverser(b));
    }
    changer.push([el, c]);
  }
  for (const [el, c] of changer) for (const [k, v] of Object.entries(c)) el.style.setProperty(k.replace(/[A-Z]/g, (x) => `-${x.toLowerCase()}`), v, 'important');
  // La boîte peint son propre fond sombre autour de l'e-mail.
  if (!rgb(getComputedStyle(document.documentElement).backgroundColor)?.a) document.documentElement.style.background = '#121212';
}

// Contraste de chaque texte visible sur son fond réel, et pastilles (logo, numéros) visibles sur ce qui les entoure.
function mesurer() {
  const { rgb, contraste, hex } = window.__c;
  const de = document.documentElement;
  const opaque = (c) => c && c.a > 0.5;
  const fondDe = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (opaque(c)) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const cache = (el) => { for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0 || parseFloat(s.maxHeight) === 0) return true; } return false; };
  const textes = [];
  for (const el of document.querySelectorAll('body *')) {
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    if (cache(el)) continue;
    const st = getComputedStyle(el);
    const fg = rgb(st.color);
    const bg = fondDe(el);
    const r = el.getBoundingClientRect();
    textes.push({ texte: el.textContent.trim().replace(/\s+/g, ' ').slice(0, 30), fg: hex(fg), bg: hex(bg), c: Math.round(contraste(fg, bg) * 100) / 100, horsCadre: r.right > de.clientWidth + 1 });
  }
  // Pastilles : petits éléments à fond propre (logo « P », numéros des étapes, boutons) : leur fond doit se détacher.
  const pastilles = [];
  for (const el of document.querySelectorAll('body *')) {
    const c = rgb(getComputedStyle(el).backgroundColor);
    if (!opaque(c) || cache(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.width > 80 || r.height > 80) continue;
    const autour = fondDe(el.parentElement);
    pastilles.push({ texte: el.textContent.trim().slice(0, 20), c: Math.round(contraste(c, autour) * 100) / 100, fond: hex(c), autour: hex(autour) });
  }
  // Boutons (liens à fond coloré ou dans une cellule colorée) : taille et place.
  const boutons = [...document.querySelectorAll('a')].filter((a) => {
    const td = a.closest('td');
    return td && opaque(rgb(getComputedStyle(td).backgroundColor)) && td.textContent.trim() === a.textContent.trim();
  }).map((a) => {
    const r = a.closest('td').getBoundingClientRect();
    return { texte: a.textContent.trim().slice(0, 30), h: Math.round(r.height), w: Math.round(r.width), dedans: r.right <= de.clientWidth + 1 && r.left >= -1 };
  });
  // Largeur de la carte (la cellule la plus large qui porte le titre).
  const h1 = document.querySelector('h1');
  const carte = h1 ? Math.round(h1.closest('td')?.getBoundingClientRect().width || 0) : 0;
  const mots = (document.body.innerText || '').split(/\s+/).filter((m) => /[a-zà-ÿ]{2}/i.test(m)).length;
  const images = [...document.querySelectorAll('img')].map((i) => ({ alt: i.getAttribute('alt'), w: i.getBoundingClientRect().width, h: i.getBoundingClientRect().height }));
  return { textes, pastilles, boutons, carte, mots, images };
}

// ---------- Les modes jugés et capturés ----------

// capture : figure de la galerie (classe CSS de page.js) ; sinon jugé sans capture.
const MODES = [
  { id: 'gmail', nom: 'Gmail sans styles', w: 360, html: versionGmail, capture: 'mode' },
  { id: 'gmail-large', nom: 'Gmail sans styles, ordinateur', w: 1000, html: versionGmail },
  { id: 'outlook', nom: 'Outlook (Word, approché)', w: 1000, html: versionOutlook, capture: 'mode-large' },
  { id: 'sombre-partiel', nom: 'Sombre partiel (Gmail Android)', w: 360, html: versionGmail, sombre: 'partiel', capture: 'mode' },
  { id: 'sombre-total', nom: 'Sombre total (Outlook, Gmail iOS)', w: 360, html: (h) => h, sombre: 'total', capture: 'mode' },
  { id: 'sans-images', nom: 'Images bloquées', w: 360, html: versionGmail, capture: 'mode' },
];

async function ouvrir(page, html, w) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await page.evaluate(outilsCouleur);
  await page.waitForTimeout(50);
}

async function verifier({ browser, dossierSource, progression, dossierImages }) {
  const mail = require(path.join(dossierSource, 'mail.js'));
  const { scenes } = require('./emails');
  const SCENES = scenes(mail).filter((s) => s.contenu);
  const resultats = [];
  const ecrans = [];
  const ctx = await browser.newContext({ viewport: { width: 360, height: 900 }, locale: 'fr-FR' });
  const page = await ctx.newPage();
  await page.route('**/*', (r) => r.abort()); // ni police web, ni image : rien ne sort
  let n = 0;
  let numCapture = 0;
  for (const [iScene, scene] of SCENES.entries()) {
    const { html, text, subject } = scene.contenu;
    const pb = [];
    const avert = [];
    const octets = Buffer.byteLength(html, 'utf8');
    if (octets > COUPURE_GMAIL) pb.push(`${Math.round(octets / 1024)} ko : Gmail coupe l'e-mail à 102 ko`);
    if (!/<meta name="color-scheme" content="light">/.test(html)) avert.push('pas de « color-scheme » : Apple Mail peut assombrir à sa façon');
    if (!text || text.trim().length < 20) pb.push('pas de version texte brut (aperçu, lecteurs d\'écran, vieux Outlook)');
    for (const lien of html.match(/href="([^"]*)"/g) || []) {
      const u = lien.slice(6, -1);
      if (!/^(https:\/\/|mailto:)/.test(u)) pb.push(`lien non absolu : ${u.slice(0, 60)}`);
    }
    if (!subject || subject.length > 78) pb.push(`objet trop long (${(subject || '').length} caractères, coupé à ~60 sur téléphone)`);

    // Relecture du code d'origine.
    await ouvrir(page, html, 600);
    await page.evaluate((s) => { window.__source = s; }, html);
    const lu = await page.evaluate(relire);
    pb.push(...lu.erreurs.map((e) => `Code : ${e}`));
    avert.push(...lu.avert);

    // Le HTML tel quel, à chaque largeur (styles gardés : Gmail web, Apple Mail).
    for (const { nom, w } of LARGEURS) {
      await ouvrir(page, html, w);
      for (const p of await miseEnPage(page)) pb.push(`${nom} (${w} px) : ${p}`);
      const m = await page.evaluate(mesurer);
      for (const t of m.textes) {
        if (t.horsCadre) pb.push(`${nom} (${w} px) : texte hors cadre « ${t.texte} »`);
        if (t.c < 4.5) pb.push(`${nom} (${w} px) : « ${t.texte} » ${t.fg} sur ${t.bg}, contraste ${t.c} (clair)`);
      }
    }

    // Chaque boîte simulée.
    for (const mode of MODES) {
      const quoi = `${mode.nom} (${mode.w} px)`;
      await ouvrir(page, mode.html(html), mode.w);
      if (mode.sombre) await page.evaluate(assombrir, mode.sombre);
      for (const p of await miseEnPage(page)) pb.push(`${quoi} : ${p}`);
      const m = await page.evaluate(mesurer);
      for (const t of m.textes) {
        if (t.horsCadre) pb.push(`${quoi} : texte hors cadre « ${t.texte} »`);
        if (t.c < 4.5) pb.push(`${quoi} : « ${t.texte} » ${t.fg} sur ${t.bg}, contraste ${t.c}`);
      }
      for (const p of m.pastilles) if (p.c < 1.25 && p.texte === '') avert.push(`${quoi} : pastille ${p.fond} presque invisible sur ${p.autour}`);
      for (const b of m.boutons) {
        if (!b.dedans) pb.push(`${quoi} : bouton « ${b.texte} » hors de l'écran`);
        if (b.h < 40) pb.push(`${quoi} : bouton « ${b.texte} » de ${b.h} px de haut (moins de 40 px : réduit au texte ?)`);
      }
      if (mode.w >= 1000 && m.carte > 640) pb.push(`${quoi} : la carte fait ${m.carte} px de large (lignes trop longues, max-width ignoré)`);
      if (mode.w <= 412 && m.carte && m.carte < 280) pb.push(`${quoi} : la carte ne fait que ${m.carte} px de large`);
      if (mode.id === 'sans-images') {
        if (m.mots < 15) pb.push(`${quoi} : il ne reste que ${m.mots} mots sans les images`);
        for (const i of m.images) if (i.alt && (i.w < 20 || i.h < 10)) pb.push(`${quoi} : image « ${i.alt} » effondrée (${Math.round(i.w)}×${Math.round(i.h)} px), son alt ne se lit pas`);
      }
      if (mode.capture && dossierImages) {
        const fichier = `courriels-${String(++numCapture).padStart(4, '0')}.jpg`;
        const erreurs = [];
        await page.screenshot({ path: path.join(dossierImages, fichier), type: 'jpeg', quality: 70, fullPage: true, timeout: 15000 })
          .catch((e) => erreurs.push('Capture : ' + e.message.split('\n')[0]));
        ecrans.push({ n: numCapture, groupe: scene.groupe, titre: scene.titre, note: scene.note, fonction: scene.fonction, taille: mode.nom, classe: mode.capture, fichier, erreurs, scene: iScene });
      }
    }
    const pbs = [...new Set(pb)];
    // Les soucis de l'e-mail s'affichent sous ses captures dans la galerie.
    for (const e of ecrans.filter((x) => x.scene === iScene)) e.erreurs.push(...pbs);
    resultats.push({ titre: scene.titre, groupe: scene.groupe, ko: Math.round(octets / 102.4) / 10, images: (html.match(/<img\b/gi) || []).length, pb: pbs, avert: [...new Set(avert)] });
    progression(`e-mails ${++n}/${SCENES.length}`);
  }
  await ctx.close();
  return { resultats, ecrans };
}

function rapport(resultats, version, dossier) {
  const faux = resultats.filter((r) => r.pb.length);
  const lignes = [`e-mails (${version}) : ${resultats.length} e-mails rendus à ${LARGEURS.map((l) => l.w).join('/')} px sans police ni image,`,
    `  et dans chaque boîte simulée : ${MODES.map((m) => `${m.nom} ${m.w} px`).join(' ; ')}.`,
    `  ${faux.length} avec une erreur.`];
  lignes.push(`  poids : ${Math.min(...resultats.map((r) => r.ko))} à ${Math.max(...resultats.map((r) => r.ko))} ko (coupure Gmail à 102 ko) ; images : ${resultats.reduce((t, r) => t + r.images, 0)}`);
  for (const r of faux) { lignes.push(`  - ${r.titre}`); r.pb.forEach((p) => lignes.push(`      ${p}`)); }
  // Avertissements (ne bloquent pas) : regroupés, avec le nombre d'e-mails concernés.
  const compte = new Map();
  for (const r of resultats) for (const a of r.avert) compte.set(a, (compte.get(a) || 0) + 1);
  if (compte.size) {
    lignes.push('', `Avertissements (ne bloquent pas, à garder en tête) :`);
    for (const [a, k] of [...compte].sort((x, y) => y[1] - x[1])) lignes.push(`  - ${a} (${k} e-mail${k > 1 ? 's' : ''})`);
  }
  const fichier = path.join(dossier, 'courriels.txt');
  fs.writeFileSync(fichier, lignes.join('\n') + '\n');
  return { fichier, texte: lignes.join('\n'), soucis: faux.length };
}

module.exports = { verifier, rapport, LARGEURS, MODES, versionGmail, versionOutlook };
