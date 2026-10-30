// Les gestes humains au-delà du double clic et du clavier (Tanguy, 30/10) : chaque écran de l'appli famille (et du
// site) est rejoué dans des conditions qu'un proche impose sans y penser : téléphone tourné en paysage, zoom du
// navigateur à 130 %, texte agrandi de 30 % (réglage d'accessibilité), mode sombre du téléphone, noms très longs avec
// emoji, bouton retour du téléphone sur une fenêtre ouverte, retour arrière après le paiement.
// Ce qu'on juge : rien ne déborde (pas de défilement horizontal, aucun bouton hors écran, aucun texte coupé), tout
// texte reste lisible (contraste), le bouton retour ferme la fenêtre sans quitter l'appli, le retour après paiement ne
// rejoue pas le paiement.
'use strict';

const fs = require('fs');
const path = require('path');

const NOM_LONG = 'Marie-Joséphine de la Tour du Pin-Chambly 👵🏼❤️🌸 Grand-maman chérie';
const PRENOM_LONG = 'Jean-Christophe-Alexandre 🧑🏽‍🦱✨';

// Les noms de la fausse famille deviennent très longs (famille, proches, anniversaires, compte).
function allonger(d) {
  const copie = JSON.parse(JSON.stringify(d));
  for (const [chemin, doc] of Object.entries(copie.docs || {})) {
    if (!doc || typeof doc !== 'object') continue;
    if (/^families\/[^/]+$/.test(chemin) && typeof doc.name === 'string') doc.name = NOM_LONG;
    else if (/\/members\//.test(chemin) && typeof doc.name === 'string') doc.name = PRENOM_LONG;
    else if (/\/birthdays\//.test(chemin) && typeof doc.name === 'string') doc.name = PRENOM_LONG;
    if (typeof doc.author === 'string') doc.author = PRENOM_LONG;
    if (typeof doc.callerName === 'string') doc.callerName = PRENOM_LONG;
  }
  if (copie.user && copie.user.displayName) copie.user.displayName = PRENOM_LONG;
  return copie;
}

// Dans la page : ce qui déborde ou se lit mal. Rend une liste de phrases.
function juger(seuilContraste) {
  const pb = [];
  const W = window.innerWidth;
  const visible = (el) => {
    if (el.closest('[hidden], [inert]')) return false;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) <= 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4;
  };
  const nom = (el) => (el.id ? `#${el.id} ` : '') + `« ${(el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40)} »`;
  if (document.documentElement.scrollWidth > W + 2) pb.push(`défilement horizontal (${document.documentElement.scrollWidth} px pour ${W})`);
  // rgb(r, g, b[, a]) ou, pour un color-mix() calculé, color(srgb r g b[ / a]) avec des valeurs de 0 à 1.
  const canaux = (c) => {
    const m = (c.match(/[\d.]+/g) || ['0', '0', '0']).map(Number);
    return c.startsWith('color(') ? m.map((x, i) => (i < 3 ? x * 255 : x)) : m;
  };
  const lum = (c) => {
    const [r, g, b] = canaux(c).slice(0, 3).map((x) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const alpha = (c) => { const m = canaux(c); return m.length >= 4 ? m[3] : (c === 'transparent' ? 0 : 1); };
  // Un bouton dans une rangée qui défile (messages rapides) a le droit d'être plus loin que le bord.
  const defile = (el) => {
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const ox = getComputedStyle(e).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && e.scrollWidth > e.clientWidth + 3) return true;
    }
    return false;
  };
  const fond = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const st = getComputedStyle(e);
      if (alpha(st.backgroundColor) >= 0.9) return st.backgroundColor;
      if (st.backgroundImage && st.backgroundImage !== 'none') return null; // image ou dégradé : on ne juge pas
    }
    return getComputedStyle(document.body).backgroundColor;
  };
  const contraste = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
  const cibles = [...document.querySelectorAll('button, [role=button], a.primary, a.secondary, h1, h2, h3, label, p, li, .nav-item, input, select')].filter(visible);
  const vusContraste = new Set();
  for (const el of cibles) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    const bouton = el.matches('button, [role=button], a.primary, a.secondary, .nav-item');
    if (bouton && (r.right > W + 2 || r.left < -2) && !defile(el)) pb.push(`bouton hors de l'écran : ${nom(el)}`);
    if (bouton && el.scrollWidth > el.clientWidth + 3 && st.overflow !== 'visible' && st.textOverflow !== 'ellipsis') pb.push(`texte coupé : ${nom(el)}`);
    if (!bouton && r.right > W + 2 && el.textContent.trim()) pb.push(`texte qui dépasse de l'écran : ${nom(el)}`);
    // Lisibilité : couleur du texte contre le fond réel (sauf fond en image).
    const texte = (el.textContent || '').trim();
    if (texte && !el.querySelector('img, svg, video') && alpha(st.color) > 0.5) {
      const bg = fond(el);
      if (bg && !vusContraste.has(texte + bg)) {
        vusContraste.add(texte + bg);
        const c = contraste(st.color, bg);
        if (c < seuilContraste) pb.push(`texte peu lisible (contraste ${c.toFixed(1)}) : ${nom(el)}`);
      }
    }
  }
  return [...new Set(pb)].slice(0, 12);
}

const COUCHE = '.dialog-back:not(.closing), dialog[open], [id^="sheet-"]:not([hidden]), .sheet:not([hidden])';

async function texteAgrandi(page, facteur) {
  await page.evaluate((f) => {
    const tous = [...document.querySelectorAll('body *')];
    const tailles = tous.map((el) => parseFloat(getComputedStyle(el).fontSize));
    tous.forEach((el, i) => { if (tailles[i]) el.style.fontSize = `${tailles[i] * f}px`; });
  }, facteur);
  await page.waitForTimeout(300);
}

// Variantes jouées sur chaque scène : { nom, taille(t), donnees(d), avant(page), apres(page) }.
const VARIANTES = [
  { nom: 'normal' },
  { nom: 'paysage', taille: (t) => ({ ...t, width: Math.max(t.width, t.height), height: Math.min(t.width, t.height) }) },
  // Zoom du navigateur à 130 % : la page voit un écran 1,3 fois plus petit (390 px → 300 px), tout le reste pareil.
  { nom: 'zoom 130 %', taille: (t) => ({ ...t, width: Math.round(t.width / 1.3), height: Math.round(t.height / 1.3) }) },
  { nom: 'texte +30 %', apres: (p) => texteAgrandi(p, 1.3) },
  { nom: 'mode sombre', apres: async (p) => { await p.emulateMedia({ colorScheme: 'dark' }); await p.waitForTimeout(300); } },
  { nom: 'noms très longs', donnees: allonger },
];

async function balayer({ browser, base, partie, progression }) {
  const mod = require(`./${partie}`);
  const scenes = mod.SCENES.filter((s) => !s.avant);
  const taille0 = mod.TAILLES[0];
  const resultats = []; // { scene, variante, problemes }
  const retours = []; // { scene, resultat }
  let faits = 0;
  // GESTES_VARIANTES="zoom 130 %,paysage" : seulement ces variantes (pour rejouer vite une partie du balayage).
  const choisies = process.env.GESTES_VARIANTES ? VARIANTES.filter((v) => process.env.GESTES_VARIANTES.split(',').includes(v.nom)) : VARIANTES;
  for (const scene of scenes) {
    for (const v of choisies) {
      if (v.donnees && partie !== 'famille') continue;
      const sc = v.donnees ? { ...scene, donnees: () => v.donnees(scene.donnees()) } : scene;
      const taille = v.taille ? v.taille(taille0) : taille0;
      let ouvert;
      try {
        ouvert = await mod.ouvrir(browser, base, sc, taille);
      } catch (e) {
        resultats.push({ scene: scene.titre, variante: v.nom, problemes: [`écran impossible à ouvrir : ${e.message.split('\n')[0]}`] });
        continue;
      }
      const { ctx, page } = ouvert;
      try {
        if (v.apres) await v.apres(page);
        const problemes = await page.evaluate(juger, v.nom === 'mode sombre' ? 3 : 2.5).catch((e) => [`jugement impossible : ${e.message.split('\n')[0]}`]);
        resultats.push({ scene: scene.titre, variante: v.nom, problemes });
        // Bouton retour du téléphone : une fenêtre ouverte doit se fermer, et l'appli rester là.
        if (v.nom === 'normal' && await page.locator(COUCHE).count()) {
          const avant = page.url();
          // Appli famille : comme dans l'app Android, une entrée « sortie » sous l'accueil (posée au premier toucher).
          if (partie === 'famille') await page.evaluate(() => { if (!history.state) { history.replaceState({ sortie: true }, ''); history.pushState(null, ''); } }).catch(() => {});
          await page.goBack({ waitUntil: 'commit', timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(600);
          const encore = await page.locator(COUCHE).count().catch(() => 0);
          const url = page.url();
          const texte = await page.evaluate(() => document.body.innerText.trim().length).catch(() => 0);
          const resultat = url.split('#')[0].split('?')[0] !== avant.split('#')[0].split('?')[0] || texte < 10 ? 'sort de l\'appli' : encore ? 'la fenêtre reste ouverte' : 'ferme la fenêtre';
          retours.push({ scene: scene.titre, resultat });
        }
      } finally {
        await ctx.close();
      }
    }
    progression(`${partie} : ${++faits}/${scenes.length} écrans × ${choisies.length} variantes`);
  }
  // Retour arrière après le paiement : l'adresse de retour (?paiement=…) est effacée, un retour ne rejoue rien.
  let paiement = null;
  if (partie === 'famille') {
    const scene = scenes.find((s) => /abonnement actif/i.test(s.titre)) || scenes[1];
    const { ctx, page } = await mod.ouvrir(browser, base, scene, taille0);
    try {
      await page.goto(`${base}/index.html?paiement=ok&session=cs_test_123`);
      await page.waitForTimeout(1500);
      const url = page.url();
      paiement = /paiement=/.test(url) ? `l'adresse garde ?paiement=ok : un retour arrière ou un rafraîchissement rejouerait le message (${url.replace(base, '')})` : 'adresse nettoyée après le retour de paiement : rien à rejouer';
    } finally {
      await ctx.close();
    }
  }
  return { total: scenes.length, variantes: choisies.map((v) => v.nom), resultats, retours, paiement };
}

function rapport(parties, dossier) {
  const lignes = [];
  for (const { nom, version, total, resultats, retours, paiement } of parties) {
    const faux = resultats.filter((r) => r.problemes.length);
    lignes.push(`${nom} (${version}) : ${total} écrans × ${[...new Set(resultats.map((r) => r.variante))].length} variantes, ${faux.length} écran-variante(s) avec un souci`);
    const parVariante = new Map();
    for (const r of faux) parVariante.set(r.variante, (parVariante.get(r.variante) || 0) + 1);
    for (const [v, n] of parVariante) lignes.push(`  ${v} : ${n} écran(s)`);
    for (const r of faux) {
      lignes.push(`  - ${r.variante} · ${r.scene}`);
      for (const p of r.problemes) lignes.push(`      ${p}`);
    }
    if (retours.length) {
      const groupes = new Map();
      for (const r of retours) groupes.set(r.resultat, [...(groupes.get(r.resultat) || []), r.scene]);
      lignes.push(`${nom} : bouton retour sur ${retours.length} écran(s) avec une fenêtre ouverte`);
      for (const [res, scenes] of groupes) lignes.push(`  ${res} : ${scenes.length}${res === 'ferme la fenêtre' ? '' : ` → ${scenes.join(' ; ')}`}`);
    }
    if (paiement) lignes.push(`${nom} : retour après paiement : ${paiement}`);
  }
  const fichier = path.join(dossier, 'gestes.txt');
  fs.writeFileSync(fichier, lignes.join('\n') + '\n');
  return { fichier, texte: lignes.join('\n') };
}

module.exports = { balayer, rapport, VARIANTES, allonger, juger };
