// Accessibilité (inspection n° 4, 30/10/2026) : chaque écran de l'appli famille, du site, de l'admin et de la tablette passé à
// axe-core (règles WCAG 2.0/2.1 niveau A et AA, celles que suivent les lecteurs d'écran et les contrôles de contraste), plus
// trois règles « seniors » à nous : texte de moins de 16 px, cible tactile de moins de 44 px, image sans légende.
// Les constats sont regroupés par règle (un même défaut sur 150 écrans = une ligne), avec des exemples.
//   node galerie.js --accessibilite [famille vitrine admin tablette] [--famille=<branche|ici>]
'use strict';

const fs = require('fs');
const path = require('path');

const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const LOCALE = JSON.parse(fs.readFileSync(require.resolve('axe-core/locales/fr.json'), 'utf8'));
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
// La tablette est à 1,5 m des yeux, en plus grand : on ne juge pas la taille de son texte ni de ses cibles.
const MIN_TEXTE = { famille: 16, vitrine: 15, admin: 14, tablette: 0 };
const MIN_CIBLE = { famille: 44, vitrine: 40, admin: 32, tablette: 0 };

// Règles maison, dans la page : rendent [{ regle, cible, detail }].
function seniors({ minTexte, minCible }) {
  const pb = [];
  const visible = (el) => {
    if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) <= 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  };
  const nom = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''} « ${(el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40)} »`;
  if (minTexte) {
    for (const el of document.querySelectorAll('p, li, label, button, a, input, select, textarea, h1, h2, h3, h4, span, small, td, th, dt, dd, summary')) {
      if (!visible(el)) continue;
      const texte = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
      if (!texte) continue;
      const taille = parseFloat(getComputedStyle(el).fontSize);
      if (taille < minTexte) pb.push({ regle: 'texte-petit', cible: nom(el), detail: `${Math.round(taille)} px (minimum ${minTexte})` });
    }
  }
  if (minCible) {
    for (const el of document.querySelectorAll('button, [role=button], a[href], input[type=checkbox], input[type=radio], summary')) {
      if (!visible(el) || el.closest('p, li, td') && el.tagName === 'A') continue; // un lien dans une phrase a le droit d'être petit
      const r = el.getBoundingClientRect();
      if (Math.max(r.width, r.height) < minCible || Math.min(r.width, r.height) < Math.min(24, minCible)) {
        pb.push({ regle: 'cible-petite', cible: nom(el), detail: `${Math.round(r.width)} × ${Math.round(r.height)} px (minimum ${minCible})` });
      }
    }
  }
  for (const img of document.querySelectorAll('img')) {
    if (!visible(img) || img.hasAttribute('alt') || img.getAttribute('role') === 'presentation') continue;
    pb.push({ regle: 'image-sans-alt', cible: nom(img), detail: (img.getAttribute('src') || '').split('/').pop().slice(0, 40) });
  }
  return pb;
}

async function balayer({ browser, base, partie, progression }) {
  const mod = require(`./${partie}`);
  const scenes = mod.SCENES.filter((s) => !s.avant);
  // Admin : la taille est par écran (pc ou téléphone) ; ailleurs la première (téléphone, ou paysage pour la tablette).
  const tailleDe = (s) => (partie === 'admin' ? mod.TAILLES[(s.tailles || ['pc'])[0]] : mod.TAILLES[0]);
  const constats = []; // { regle, impact, aide, lien, cible, html, scene }
  let faits = 0;
  for (const scene of scenes) {
    let ouvert;
    try {
      ouvert = await mod.ouvrir(browser, base, scene, tailleDe(scene));
    } catch (e) {
      constats.push({ regle: 'écran impossible à ouvrir', impact: 'outil', aide: e.message.split('\n')[0], cible: '', scene: scene.titre });
      continue;
    }
    const { ctx, page } = ouvert;
    try {
      await page.addScriptTag({ content: AXE });
      const r = await page.evaluate(async ([tags, locale]) => {
        window.axe.configure({ locale });
        // Les écrans cachés derrière une fenêtre ouverte sont inertes : on ne juge que ce qui est visible.
        return window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'], elementRef: false });
      }, [TAGS, LOCALE]).catch((e) => ({ violations: [{ id: 'axe en erreur', impact: 'outil', help: e.message.split('\n')[0], helpUrl: '', nodes: [{ target: [''], html: '' }] }] }));
      for (const v of r.violations) {
        for (const n of v.nodes) {
          constats.push({ regle: v.id, impact: v.impact, aide: v.help, lien: v.helpUrl, cible: n.target.join(' '), html: (n.html || '').slice(0, 120), scene: scene.titre, detail: (n.any || []).concat(n.all || [], n.none || []).map((c) => c.message).filter(Boolean)[0] || '' });
        }
      }
      const maison = await page.evaluate(seniors, { minTexte: MIN_TEXTE[partie] || 0, minCible: MIN_CIBLE[partie] || 0 }).catch(() => []);
      for (const p of maison) constats.push({ regle: p.regle, impact: 'seniors', aide: p.regle === 'texte-petit' ? 'Texte trop petit pour une vue faible' : p.regle === 'cible-petite' ? 'Bouton trop petit pour un doigt peu sûr' : 'Image sans texte de remplacement', lien: '', cible: p.cible, html: '', scene: scene.titre, detail: p.detail });
    } finally {
      await ctx.close();
    }
    progression(`${partie} : ${++faits}/${scenes.length} écrans`);
  }
  return { total: scenes.length, constats };
}

// Un défaut = une règle sur une cible (le même bouton sur 100 écrans compte une fois) ; les lignes disent sur combien d'écrans.
function rapport(parties, dossier) {
  const lignes = [];
  for (const { nom, version, total, constats } of parties) {
    const parRegle = new Map();
    for (const c of constats) {
      if (!parRegle.has(c.regle)) parRegle.set(c.regle, { impact: c.impact, aide: c.aide, lien: c.lien, cibles: new Map() });
      const r = parRegle.get(c.regle);
      const cle = c.cible || c.html;
      if (!r.cibles.has(cle)) r.cibles.set(cle, { scenes: new Set(), html: c.html, detail: c.detail });
      r.cibles.get(cle).scenes.add(c.scene);
    }
    const defauts = [...parRegle.values()].reduce((n, r) => n + r.cibles.size, 0);
    lignes.push(`${nom} (${version}) : ${total} écrans, ${parRegle.size} règle(s) enfreinte(s), ${defauts} élément(s) distinct(s)`);
    const ordre = { critical: 0, serious: 1, moderate: 2, minor: 3, seniors: 4, outil: 5 };
    for (const [regle, r] of [...parRegle].sort((a, b) => (ordre[a[1].impact] ?? 9) - (ordre[b[1].impact] ?? 9) || b[1].cibles.size - a[1].cibles.size)) {
      lignes.push(`  [${r.impact}] ${regle} : ${r.aide} (${r.cibles.size} élément(s))${r.lien ? ` ${r.lien}` : ''}`);
      let n = 0;
      for (const [cible, x] of r.cibles) {
        if (n++ >= 8) { lignes.push(`      … et ${r.cibles.size - 8} autre(s)`); break; }
        lignes.push(`      ${cible}${x.detail ? ` : ${x.detail}` : ''}${x.html ? `  ${x.html}` : ''}  (${x.scenes.size} écran(s), ex. ${[...x.scenes][0]})`);
      }
    }
  }
  const texte = lignes.join('\n');
  const fichier = path.join(dossier, 'accessibilite.txt');
  fs.writeFileSync(fichier, `${texte}\n`);
  return { fichier, texte };
}

module.exports = { balayer, rapport, seniors };
