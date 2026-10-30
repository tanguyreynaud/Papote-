// Aucun bouton sans effet (Tanguy, 30/10 : « l'utilisateur doit toujours savoir si ça charge, si le bouton a été
// appuyé »). Pour chaque bouton différent de l'app famille et de l'admin (le premier écran où il apparaît), on
// rouvre l'écran, on bloque le serveur (il ne répond jamais), on touche le bouton et on regarde l'écran pendant
// 0,7 s : il doit se passer quelque chose de visible (roue, bouton grisé, fenêtre, message, autre page, choix
// d'un fichier…). Sinon le bouton est signalé : c'est ce que vit quelqu'un qui touche et ne voit rien venir.
// Chaque écran est aussi rafraîchi une fois : il doit revenir, sans erreur ni écran vide.
// Ne vérifie pas le message de fin (réussite ou erreur) une fois que le serveur répond : à regarder dans la galerie.
'use strict';

const fs = require('fs');
const path = require('path');

const SEL = 'button, [role=button], input[type=submit], input[type=button], a.primary, a.secondary, a.btn';

// Boutons visibles et touchables de l'écran, chacun marqué data-bouton=i. Rend leurs noms (id ou texte).
function lister(sel) {
  const noms = [];
  const vus = [...document.querySelectorAll(sel)].filter((el) => {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[hidden], [inert]')) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) <= 0.05) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const b = el.getBoundingClientRect();
    const dessus = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return Boolean(dessus) && (dessus === el || el.contains(dessus));
  });
  window.scrollTo(0, 0);
  vus.forEach((el, i) => {
    el.dataset.bouton = String(i);
    const texte = (el.getAttribute('aria-label') || el.textContent || el.value || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 50);
    noms.push(el.id ? `#${el.id}${texte ? ` « ${texte} »` : ''}` : `« ${texte || el.tagName.toLowerCase()} »`);
  });
  return noms;
}

// Note tout ce qui change à l'écran ; ce qui bouge déjà tout seul (horloge, animations) avant le toucher est ignoré.
function guetter() {
  const w = window;
  w.__changes = [];
  w.__toucheA = 0;
  const visible = (n) => {
    const el = n && (n.nodeType === 1 ? n : n.parentElement);
    return Boolean(el && el.isConnected && el.getClientRects().length);
  };
  new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.type === 'attributes' && r.attributeName === 'data-bouton') continue;
      // Attribut remis à la même valeur (hidden = true sur un élément déjà caché…) : rien ne change à l'écran.
      if (r.type === 'attributes' && r.oldValue === r.target.getAttribute(r.attributeName)) continue;
      const cible = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      const montre = r.type === 'attributes' ? (['hidden', 'class', 'style', 'open', 'disabled', 'aria-busy'].includes(r.attributeName) || visible(cible))
        : (visible(cible) || [...r.removedNodes].some((x) => x.nodeType === 1 || (x.textContent || '').trim()));
      if (montre) w.__changes.push({ t: performance.now(), cible });
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true });
}

function bilan() {
  const w = window;
  const avant = new Set(w.__changes.filter((c) => c.t < w.__toucheA).map((c) => c.cible));
  return w.__changes.filter((c) => c.t >= w.__toucheA && !avant.has(c.cible)).length;
}

async function essayer(mod, browser, base, scene, taille, nom) {
  const { ctx, page } = await mod.ouvrir(browser, base, scene, taille);
  try {
    let evenement = '';
    page.on('popup', () => { evenement = 'fenêtre'; });
    page.on('filechooser', () => { evenement = 'fichier'; });
    page.on('download', () => { evenement = 'téléchargement'; });
    page.on('dialog', (d) => { evenement = 'dialogue'; d.dismiss().catch(() => {}); });
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) evenement = 'navigation'; });
    await page.evaluate(() => { window.__fonctionsBloquees = true; });
    const noms = await page.evaluate(lister, SEL);
    const i = noms.indexOf(nom);
    if (i < 0) return null; // l'écran a changé entre-temps : rien à juger
    const loc = page.locator(`[data-bouton="${i}"]`);
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
    const url = page.url();
    evenement = '';
    await page.evaluate(guetter);
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.__toucheA = performance.now(); });
    await loc.click({ timeout: 2000, noWaitAfter: true });
    await page.waitForTimeout(700);
    if (evenement || page.url() !== url) { if (process.env.DEBUG) console.log('\n', nom, '→', evenement || 'url'); return ''; }
    const n = await page.evaluate(bilan).catch(() => 1); // page partie ailleurs : il s'est passé quelque chose
    if (process.env.DEBUG) console.log('\n', nom, '→', n, await page.evaluate(() => window.__changes.filter((c) => c.t >= window.__toucheA).slice(0, 3).map((c) => (c.cible && (c.cible.id || c.cible.className || c.cible.tagName)))).catch(() => ''));
    return n ? '' : 'rien ne bouge à l\'écran quand on le touche';
  } catch (e) {
    return null;
  } finally {
    await ctx.close();
  }
}

// partie : 'famille' ou 'admin'. Rend la liste des problèmes { scene, bouton, probleme }.
async function balayer({ browser, base, partie, progression }) {
  const mod = require(`./${partie}`);
  const tailleDe = (scene) => (partie === 'famille' ? mod.TAILLES[0] : mod.TAILLES[(scene.tailles || ['pc'])[0]]);
  const scenes = mod.SCENES.filter((s) => !s.avant);
  // 1. Les boutons de chaque écran, dans l'ordre des scènes.
  const parScene = new Array(scenes.length);
  const rechargements = [];
  let faits = 0;
  const file1 = scenes.map((s, i) => i);
  async function lire() {
    for (let i = file1.shift(); i !== undefined; i = file1.shift()) {
      const { ctx, page, erreurs } = await mod.ouvrir(browser, base, scenes[i], tailleDe(scenes[i]));
      parScene[i] = await page.evaluate(lister, SEL).catch(() => []);
      // Rafraîchir la page (geste courant quand « ça ne marche pas ») : elle revient, sans erreur ni écran vide.
      const avant = erreurs.length;
      try {
        await page.reload();
        await page.waitForTimeout(2000);
        const texte = await page.evaluate(() => document.body.innerText.trim().length);
        if (!texte) rechargements.push({ scene: scenes[i].titre, probleme: 'écran vide après un rafraîchissement' });
        for (const e of erreurs.slice(avant)) rechargements.push({ scene: scenes[i].titre, probleme: `erreur après un rafraîchissement : ${e.slice(0, 140)}` });
      } catch (e) {
        rechargements.push({ scene: scenes[i].titre, probleme: `rafraîchissement impossible : ${e.message.split('\n')[0]}` });
      }
      await ctx.close();
      progression(`${partie} : boutons des écrans ${++faits}/${scenes.length}`);
    }
  }
  await Promise.all([lire(), lire(), lire(), lire()]);
  // 2. Chaque bouton une seule fois, sur le premier écran où il apparaît.
  const vus = new Set();
  const file2 = [];
  scenes.forEach((s, i) => { for (const nom of parScene[i] || []) if (!vus.has(nom)) { vus.add(nom); file2.push({ i, nom }); } });
  const n0 = file2.length;
  const problemes = [];
  faits = 0;
  async function toucher() {
    for (let job = file2.shift(); job; job = file2.shift()) {
      const pb = await essayer(mod, browser, base, scenes[job.i], tailleDe(scenes[job.i]), job.nom);
      if (pb) problemes.push({ scene: scenes[job.i].titre, bouton: job.nom, probleme: pb });
      progression(`${partie} : ${++faits}/${n0} boutons touchés`);
    }
  }
  await Promise.all([toucher(), toucher(), toucher(), toucher()]);
  return { total: n0, problemes, rechargements };
}

function rapport(parties, dossier) {
  const lignes = [];
  for (const { nom, version, total, problemes, rechargements = [] } of parties) {
    lignes.push(`${nom} (${version}) : ${total} boutons touchés, ${problemes.length} sans effet visible`);
    for (const p of problemes.sort((a, b) => a.scene.localeCompare(b.scene))) lignes.push(`  - ${p.scene} : ${p.bouton} : ${p.probleme}`);
    lignes.push(`${nom} : ${rechargements.length} écran(s) qui reviennent mal après un rafraîchissement`);
    for (const p of rechargements) lignes.push(`  - ${p.scene} : ${p.probleme}`);
  }
  const fichier = path.join(dossier, 'boutons.txt');
  fs.writeFileSync(fichier, lignes.join('\n') + '\n');
  return { fichier, texte: lignes.join('\n') };
}

module.exports = { balayer, rapport, essayer, lister, SEL };
