// Relevé d'audit (26/11/2026) : chaque écran de la galerie est ouvert et mesuré dans le navigateur. Rien n'est jugé à l'œil.
//   textes      tous les textes visibles (pour la relecture : même mot, même ton, fautes)
//   cibles      zones à toucher plus petites que le minimum de la partie
//   petits      textes plus petits que le minimum de la partie
//   contraste   texte dont le contraste avec son fond est sous 4,5 (3 pour un gros texte)
//   couleurs    couleurs qui ne viennent pas de la charte (variables CSS de :root)
//   marges      texte ou bouton trop près du bord de l'écran, ou marge de page différente des autres écrans
//   coupes      texte coupé (points de suspension ou rogné), page plus large que l'écran
//   node releve.js <partie> [taille] [--src=<dossier>] [--gros]   (gros = texte agrandi de 30 %)
'use strict';

const fs = require('fs');
const path = require('path');

const MIN = {
  famille: { cible: 44, texte: 16, bord: 12 },
  vitrine: { cible: 44, texte: 15, bord: 12 },
  admin: { cible: 36, texte: 14, bord: 8 },
  tablette: { cible: 88, texte: 22, bord: 16 },
};

function relever({ min, gros }) {
  const L = innerWidth; const H = innerHeight;
  const out = { textes: [], cibles: [], petits: [], contraste: [], couleurs: [], marges: [], coupes: [], gouttiere: null, charte: [] };
  if (gros) {
    const tous = [...document.querySelectorAll('body *')];
    const tailles = tous.map((el) => parseFloat(getComputedStyle(el).fontSize));
    tous.forEach((el, i) => { if (tailles[i]) el.style.fontSize = `${tailles[i] * gros}px`; });
  }
  const vis = (e) => {
    if (!e || !e.checkVisibility || !e.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    if (e.closest('[inert], [aria-hidden="true"]')) return false;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let p = e; p && p !== document.documentElement; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/hidden|clip/.test(s.overflowY) && p.getBoundingClientRect().height < 2) return false;
      if (parseFloat(s.opacity) < 0.05) return false;
    }
    return true;
  };
  // Vraiment à l'écran : le point du milieu appartient à l'élément (pas caché sous une fenêtre, pas hors champ).
  const dessus = (e) => {
    const r = e.getBoundingClientRect();
    const x = Math.min(L - 1, Math.max(0, r.left + r.width / 2)); const y = r.top + r.height / 2;
    if (y < 0 || y > H) return true; // hors du cadre : la page défile, on le compte
    const t = document.elementFromPoint(x, y);
    return !t || e.contains(t) || t.contains(e) || !!(t.closest('label') && t.closest('label').contains(e));
  };
  const nom = (e) => (e.id ? '#' + e.id : e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''));
  const chemin = (e) => (e.id || !e.parentElement || e.parentElement === document.body ? nom(e) : nom(e.parentElement) + ' > ' + nom(e));
  const txt = (e, n = 60) => (e.innerText || e.textContent || e.value || e.getAttribute('aria-label') || e.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, n);

  // --- couleurs
  const rgba = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const sur = (haut, bas) => ({ r: haut.r * haut.a + bas.r * (1 - haut.a), g: haut.g * haut.a + bas.g * (1 - haut.a), b: haut.b * haut.a + bas.b * (1 - haut.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  // Fond réel sous un élément : on remonte en empilant les fonds ; une image ou un dégradé = indéterminé.
  const fondDe = (e) => {
    const pile = [];
    for (let p = e; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      if (p.tagName === 'IMG' || p.tagName === 'VIDEO' || p.tagName === 'CANVAS') return null;
      const c = rgba(s.backgroundColor);
      if (c && c.a > 0) { pile.push(c); if (c.a >= 1) break; }
    }
    let f = { r: 255, g: 255, b: 255, a: 1 };
    const racine = rgba(getComputedStyle(document.documentElement).backgroundColor);
    if (racine && racine.a >= 1 && !pile.some((c) => c.a >= 1)) f = racine;
    for (let i = pile.length - 1; i >= 0; i--) f = sur(pile[i], f);
    return f;
  };
  const opaciteDe = (e) => { let o = 1; for (let p = e; p; p = p.parentElement) o *= parseFloat(getComputedStyle(p).opacity); return o; };

  // Charte : toutes les couleurs déclarées en variables sur :root (thème en cours).
  const charte = new Set(['#ffffff', '#000000']);
  const sonde = document.createElement('i'); sonde.style.display = 'none'; document.body.appendChild(sonde);
  for (const feuille of document.styleSheets) {
    let regles; try { regles = feuille.cssRules; } catch (_) { continue; }
    const voir = (rs) => { for (const r of rs) { if (r.cssRules && !r.style) { voir(r.cssRules); continue; } if (r.cssRules) voir(r.cssRules); if (!r.style) continue; for (const p of r.style) if (p.startsWith('--')) { sonde.style.color = ''; sonde.style.color = `var(${p})`; const c = rgba(getComputedStyle(sonde).color); if (sonde.style.color && c) charte.add(hex(c)); } } };
    try { voir(regles); } catch (_) { /* feuille illisible */ }
  }
  sonde.remove();
  out.charte = [...charte];
  const couleurs = new Map();
  const noter = (c, usage, e) => {
    if (!c || c.a === 0) return;
    const h = hex(c);
    if (charte.has(h)) return;
    const cle = h + '|' + usage;
    if (!couleurs.has(cle)) couleurs.set(cle, { couleur: h, usage, n: 0, ex: chemin(e) + ' « ' + txt(e, 30) + ' »' });
    couleurs.get(cle).n++;
  };

  // --- textes, tailles, contraste, marges
  const vusTexte = new Set();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let gout = 1e9;
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const e = n.parentElement; const t = n.textContent.replace(/\s+/g, ' ').trim();
    if (!t || !e || e.closest('script, style, noscript, option, template') || !vis(e)) continue;
    const s = getComputedStyle(e);
    const taille = parseFloat(s.fontSize);
    const r0 = document.createRange(); r0.selectNodeContents(n);
    const rs = [...r0.getClientRects()].filter((c) => c.width > 1 && c.height > 1);
    if (!rs.length) continue;
    const gauche = Math.min(...rs.map((c) => c.left)); const droite = Math.max(...rs.map((c) => c.right));
    const role = e.closest('button, [role=button], a') ? 'bouton' : e.closest('h1, h2, h3, h4, [role=heading]') ? 'titre' : e.closest('label') ? 'etiquette' : 'texte';
    if (!vusTexte.has(role + t)) { vusTexte.add(role + t); out.textes.push({ t, role, taille: Math.round(taille * 10) / 10, gras: parseInt(s.fontWeight, 10) >= 600 }); }
    if (!dessus(e)) continue;
    if (/[a-zà-ÿ0-9]/i.test(t) && taille < min.texte && !gros) out.petits.push({ sig: chemin(e), detail: `${Math.round(taille * 10) / 10} px : « ${t.slice(0, 50)} »`, taille });
    // contraste
    const fg0 = rgba(s.color); const bg = fondDe(e);
    if (fg0 && bg && /[a-zà-ÿ0-9]/i.test(t)) {
      const o = opaciteDe(e);
      const fg = sur({ ...fg0, a: fg0.a * o }, bg);
      const k = ratio(fg, bg);
      const grosTexte = taille >= 24 || (taille >= 18.66 && parseInt(s.fontWeight, 10) >= 700);
      if (k < (grosTexte ? 3 : 4.5)) out.contraste.push({ sig: chemin(e) + '|' + hex(fg) + '/' + hex(bg), detail: `${k.toFixed(2)} (${hex(fg)} sur ${hex(bg)}, ${Math.round(taille)} px${e.closest(':disabled, [aria-disabled=true]') ? ', grisé' : ''}) : « ${t.slice(0, 40)} »`, k, grise: !!e.closest(':disabled, [aria-disabled=true]') });
    }
    noter(rgba(s.color), 'texte', e);
    // marges : texte à moins de min.bord du bord (hors éléments en plein écran : photo, bandeau)
    const fixe = (() => { for (let p = e; p; p = p.parentElement) if (/fixed|sticky/.test(getComputedStyle(p).position)) return true; return false; })();
    if (droite > 0 && gauche < L) {
      if (gauche >= 0 && gauche < min.bord) out.marges.push({ sig: 'gauche|' + chemin(e), detail: `à ${Math.round(gauche)} px du bord gauche : « ${t.slice(0, 40)} »` });
      if (droite <= L + 1 && L - droite < min.bord && s.textAlign !== 'left' && s.textAlign !== 'start' || (droite <= L + 1 && L - droite < min.bord / 2)) out.marges.push({ sig: 'droite|' + chemin(e), detail: `à ${Math.round(L - droite)} px du bord droit : « ${t.slice(0, 40)} »` });
      if (droite > L + 1) out.coupes.push({ sig: 'hors|' + chemin(e), detail: `dépasse l'écran de ${Math.round(droite - L)} px : « ${t.slice(0, 40)} »` });
      if (!fixe && gauche >= 0 && e.closest('main, .page, .page-pad, section, article') && !e.closest('dialog, .dialog, .sheet, nav')) gout = Math.min(gout, gauche);
    }
    // texte coupé
    if ((s.textOverflow === 'ellipsis' || /hidden|clip/.test(s.overflowX)) && e.scrollWidth > e.clientWidth + 1 && s.whiteSpace === 'nowrap') out.coupes.push({ sig: 'coupe|' + chemin(e), detail: `texte coupé (${e.scrollWidth - e.clientWidth} px cachés) : « ${t.slice(0, 50)} »` });
    if (s.webkitLineClamp && s.webkitLineClamp !== 'none' && e.scrollHeight > e.clientHeight + 2) out.coupes.push({ sig: 'coupe|' + chemin(e), detail: `texte coupé en hauteur : « ${t.slice(0, 50)} »` });
  }
  out.gouttiere = gout < 1e9 ? Math.round(gout) : null;
  if (document.documentElement.scrollWidth > L + 1) out.coupes.push({ sig: 'large|page', detail: `page plus large que l'écran de ${document.documentElement.scrollWidth - L} px` });
  // textes hors du flux : indications des champs, noms des boutons sans texte, textes des images
  for (const e of document.querySelectorAll('[placeholder], [aria-label], img[alt], [title]')) {
    if (!vis(e)) continue;
    for (const [a, role] of [['placeholder', 'indication'], ['aria-label', 'nom lu'], ['alt', 'image'], ['title', 'bulle']]) {
      const t = (e.getAttribute(a) || '').trim();
      if (t && !vusTexte.has(role + t)) { vusTexte.add(role + t); out.textes.push({ t, role, taille: 0, gras: false }); }
    }
  }

  // --- fonds et bords hors charte
  for (const e of document.querySelectorAll('body *')) {
    if (!vis(e)) continue;
    const s = getComputedStyle(e);
    const b = rgba(s.backgroundColor); if (b && b.a >= 0.5) noter(b, 'fond', e);
    if (parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none') { const c = rgba(s.borderTopColor); if (c && c.a >= 0.5) noter(c, 'bord', e); }
  }
  out.couleurs = [...couleurs.values()];

  // --- zones à toucher
  const vusCible = new Set();
  for (const e of document.querySelectorAll('button, [role=button], a[href], input, select, textarea, summary, [onclick], [tabindex="0"]')) {
    if (!vis(e) || !dessus(e) || e.disabled || e.type === 'hidden') continue;
    if (e.tagName === 'A' && getComputedStyle(e).display === 'inline' && e.closest('p, li, td, span, small, label')) continue; // lien dans une phrase
    let r = e.getBoundingClientRect();
    // case à cocher ou bouton radio : c'est l'étiquette entière qu'on touche
    if (/checkbox|radio|file/.test(e.type || '')) { const l = e.closest('label') || (e.id && document.querySelector(`label[for="${e.id}"]`)); if (l) r = l.getBoundingClientRect(); }
    if (r.width < 1) continue;
    if (Math.min(r.width, r.height) < min.cible - 0.5) {
      const sig = chemin(e) + '|' + txt(e, 24).replace(/\d+/g, 'N');
      if (vusCible.has(sig)) continue; vusCible.add(sig);
      out.cibles.push({ sig, detail: `${Math.round(r.width)} × ${Math.round(r.height)} px : ${nom(e)} « ${txt(e, 40)} »`, w: r.width, h: r.height });
    }
    // bouton trop près du bord
    if (r.left >= 0 && r.right <= L && (r.left < min.bord / 2 || L - r.right < min.bord / 2) && r.width < L * 0.9 && !e.closest('nav')) out.marges.push({ sig: 'bouton|' + chemin(e), detail: `bouton à ${Math.round(Math.min(r.left, L - r.right))} px du bord : « ${txt(e, 30)} »` });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const partie = args.find((a) => !a.startsWith('--') && MIN[a]);
  const src = (args.find((a) => a.startsWith('--src=')) || '').slice(6);
  const gros = args.includes('--gros') ? 1.3 : 0;
  const sombre = args.includes('--sombre');
  const etroit = args.includes('--etroit');
  const nomTaille = (args.find((a) => a.startsWith('--taille=')) || '').slice(9);
  const { chromium } = require('playwright');
  const { servir, fausseVideo } = require('./commun');
  const mod = require(`./${partie}`);
  const dossiers = { famille: 'web', admin: 'web', vitrine: 'vitrine', tablette: 'android/app/src/main/assets' };
  const serveur = await servir(path.join(src, dossiers[partie]));
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--lang=fr-FR'] });
  const video = partie === 'famille' ? await fausseVideo(browser) : null;
  let taille = partie === 'admin' ? mod.TAILLES[nomTaille || 'tel'] : (mod.TAILLES.find((t) => t.nom === nomTaille) || mod.TAILLES[0]);
  if (etroit) taille = { ...taille, nom: 'petit', width: 360, height: 640 };
  const scenes = mod.SCENES.filter((s) => !s.avant && (partie !== 'admin' || !nomTaille || (s.tailles || ['pc']).includes(nomTaille) || true));
  const travaux = scenes.map((scene, i) => ({ scene, i }));
  const res = [];
  let faits = 0;
  async function ouvrier() {
    for (let job = travaux.shift(); job; job = travaux.shift()) {
      const { scene, i } = job;
      let o;
      try { o = partie === 'famille' ? await mod.ouvrir(browser, serveur.url, scene, taille, video) : await mod.ouvrir(browser, serveur.url, scene, taille); } catch (e) { res.push({ i, scene: scene.titre, groupe: scene.groupe, erreur: e.message.split('\n')[0] }); continue; }
      const { ctx, page } = o;
      try {
        if (sombre) { await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForTimeout(300); }
        await page.evaluate(() => document.getAnimations().forEach((a) => { const t = a.effect && a.effect.getTiming(); if (t && t.iterations !== Infinity) { try { a.finish(); } catch (_) {} } })).catch(() => {});
        const r = await page.evaluate(relever, { min: MIN[partie], gros });
        res.push({ i, scene: scene.titre, groupe: scene.groupe || '', ...r });
      } catch (e) { res.push({ i, scene: scene.titre, groupe: scene.groupe, erreur: e.message.split('\n')[0] }); } finally { await ctx.close(); }
      ++faits;
    }
  }
  await Promise.all([ouvrier(), ouvrier(), ouvrier(), ouvrier()]);
  await browser.close(); serveur.close();
  res.sort((a, b) => a.i - b.i);
  const sortie = path.join(__dirname, 'sortie'); fs.mkdirSync(sortie, { recursive: true });
  const suffixe = [partie, taille.nom.replace(/\s+/g, '-'), gros ? 'gros' : '', sombre ? 'sombre' : ''].filter(Boolean).join('-');
  fs.writeFileSync(path.join(sortie, `releve-${suffixe}.json`), JSON.stringify(res));
  // Résumé : un constat = une signature, avec le nombre d'écrans et le premier écran.
  const lignes = [`${partie} ${taille.width} × ${taille.height}${gros ? ', texte +30 %' : ''}${sombre ? ', mode sombre' : ''} : ${res.length} écrans, ${res.filter((r) => r.erreur).length} non ouverts`];
  for (const r of res.filter((x) => x.erreur)) lignes.push(`  NON OUVERT ${r.i + 1}. ${r.scene} : ${r.erreur}`);
  for (const type of ['cibles', 'petits', 'contraste', 'couleurs', 'marges', 'coupes']) {
    const vus = new Map();
    for (const r of res) for (const c of r[type] || []) {
      const sig = type === 'couleurs' ? c.couleur + '|' + c.usage : c.sig;
      if (!vus.has(sig)) vus.set(sig, { ...c, ecrans: 0, premier: `${r.i + 1}. ${r.groupe} / ${r.scene}` });
      vus.get(sig).ecrans++;
    }
    lignes.push(`== ${type} : ${vus.size}`);
    const tri = [...vus.values()].sort((a, b) => b.ecrans - a.ecrans);
    for (const c of tri) lignes.push(type === 'couleurs' ? `  [${c.ecrans} écrans] ${c.couleur} en ${c.usage} (${c.n} fois sur le 1er) ; ex. ${c.ex} ; ${c.premier}` : `  [${c.ecrans} écrans] ${c.detail} ; ${c.sig} ; ${c.premier}`);
  }
  const g = {}; for (const r of res) if (r.gouttiere != null) (g[r.gouttiere] = g[r.gouttiere] || []).push(`${r.i + 1}`);
  lignes.push('== marge de page (px du bord gauche au premier texte) : ' + Object.entries(g).map(([k, v]) => `${k} px sur ${v.length} écrans${v.length <= 6 ? ' (' + v.join(', ') + ')' : ''}`).join(' ; '));
  fs.writeFileSync(path.join(sortie, `releve-${suffixe}.txt`), lignes.join('\n') + '\n');
  // Textes, pour la relecture : un texte une fois, avec son premier écran.
  const tv = new Map();
  for (const r of res) for (const t of r.textes || []) { const k = t.t; if (!tv.has(k)) tv.set(k, { ...t, premier: `${r.i + 1}`, n: 0 }); tv.get(k).n++; }
  fs.writeFileSync(path.join(sortie, `textes-${suffixe}.txt`), [...tv.values()].map((t) => `${t.premier}\t${t.role}\t${t.t}`).join('\n') + '\n');
  process.stderr.write(`\n${lignes.slice(0, 1).join('\n')}\n`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { relever, MIN };
