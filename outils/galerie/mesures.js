// Revue mesurée (24/11/2026) : chaque écran, en téléphone ET en ordinateur, est mesuré dans le navigateur au lieu d'être
// jugé à l'œil sur une capture. Sept mesures :
//   boutons     boutons d'un même groupe de hauteurs différentes
//   alignement  blocs empilés décalés de quelques pixels, ou voisins d'une même ligne ni en haut, ni au milieu, ni en bas
//   colles      deux blocs l'un sous l'autre sans espace (moins de 4 px)
//   gras        texte en gras sur 3 lignes ou plus (hors titres)
//   long        explication de 4 lignes ou plus
//   deux-lignes bouton dont le mot passe sur deux lignes
//   doublon     la même phrase affichée deux fois sur le même écran
//   coupe       bouton trop étroit pour son mot (27/11 : l'appli est aussi mesurée en 360 et 320 px)
// Un écart = une signature (mesure, élément, texte, taille d'écran) : le même défaut sur 40 écrans compte une fois, avec
// une capture de la première fois (sortie/mesures/). Les écarts regardés et acceptés sont dans mesures-acceptes.txt
// (« partie | mesure | taille | début de la signature | pourquoi ») ; tout autre écart fait échouer le balayage.
//   node galerie.js --mesures [vitrine admin famille] [--admin=<branche|dossier>]
'use strict';

const fs = require('fs');
const path = require('path');

// Par partie : ce qui n'est pas un « vrai bouton » (liens, lignes de liste, icônes…), et où un long texte est normal.
const REGLAGES = {
  vitrine: {
    pasBouton: '.ps-bouton, .ps-fermer, nav a:not(.bouton), footer a, .menu-bouton, summary',
    texteLibre: 'details, .ps-panneau, footer, .legal, #cgv, .temoignage, blockquote',
  },
  admin: {
    pasBouton: '.menu-points > button, nav a, nav button, summary, .onglets button, .pastille, th button, .lien',
    // Pages de référence de l'admin (parcours, dépenses, gestes, « Que faire si… », aide) : des notices, longues par nature.
    texteLibre: '.journal, pre, code, textarea, .aide-reponse, .courriel, iframe',
    longLibre: '[data-panneau="validation"], [data-panneau="aide"]',
  },
  famille: {
    pasBouton: '.link, .icon-btn, .rg-ligne, .nav-item, .setting-modify, .tile, .nudge, .panel-close, .viewer-close, .video-play, .viewer-rond, .aide-pastille',
    texteLibre: '.faq details[open], .logs, #view-support .faq, .bubble, .notif, .dialog-legal, [contenteditable], .legal',
  },
};

// Dans la page : rend [{ type, sig, detail, r: { x, y, w, h } }].
function mesurer({ pasBouton, texteLibre, longLibre, textesLongs }) {
  // Gras : 3 lignes ou plus. À 2 lignes, ce sont surtout des titres de ligne qui passent à la ligne sur téléphone
  // (regardés un par un le 24/11) ; à 3, c'est un pavé.
  const GRAS_MIN = 3;
  const out = [];
  const L = innerWidth;
  const vis = (e) => {
    if (!e.checkVisibility || !e.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return false;
    if (e.closest('[inert], [aria-hidden="true"]')) return false;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.right <= 0 || r.left >= L) return false;
    for (let p = e; p && p !== document.documentElement; p = p.parentElement) { // fenêtre ou menu replié (clip, hauteur nulle)
      const s = getComputedStyle(p);
      if (/hidden|clip/.test(s.overflowY) && p.getBoundingClientRect().height < 2) return false;
      if (s.clipPath && s.clipPath !== 'none' && /inset\((100|9\d)%/.test(s.clipPath)) return false;
    }
    return true;
  };
  const nom = (e) => (e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.classList.length ? '.' + [...e.classList].slice(0, 3).join('.') : ''));
  const chemin = (e) => (e.id || !e.parentElement || e.parentElement === document.body ? nom(e) : nom(e.parentElement) + ' > ' + nom(e));
  const txt = (e, n = 60) => (e.innerText || e.textContent || e.value || e.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const rect = (e) => { const r = e.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height }; };
  const union = (...es) => {
    const rs = es.map((e) => e.getBoundingClientRect());
    const x = Math.min(...rs.map((r) => r.left)); const y = Math.min(...rs.map((r) => r.top));
    return { x: x + scrollX, y: y + scrollY, w: Math.max(...rs.map((r) => r.right)) - x, h: Math.max(...rs.map((r) => r.bottom)) - y };
  };
  const chiffres = (t) => t.replace(/\d+/g, 'N');
  const fond = (s) => s.backgroundColor !== 'rgba(0, 0, 0, 0)' && !/, 0\)$/.test(s.backgroundColor) || s.backgroundImage !== 'none';
  const bord = (s) => parseFloat(s.borderTopWidth) > 0 && parseFloat(s.borderBottomWidth) > 0 && parseFloat(s.borderLeftWidth) > 0 && s.borderTopStyle !== 'none';
  // Nombre de lignes du texte porté directement par l'élément (rectangles réels du texte, pas la hauteur de la boîte).
  const lignes = (e, profond = false) => {
    const tops = [];
    const noeuds = [];
    if (profond) { const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) noeuds.push(n); } else noeuds.push(...[...e.childNodes].filter((n) => n.nodeType === 3));
    for (const n of noeuds) {
      if (!n.textContent.trim()) continue;
      if (n.parentElement !== e && !vis(n.parentElement)) continue;
      const r = document.createRange(); r.selectNodeContents(n);
      for (const c of r.getClientRects()) if (c.width > 1 && c.height > 1) tops.push(c.top + c.height / 2);
    }
    tops.sort((a, b) => a - b);
    let n = 0; let dernier = -1e9;
    for (const t of tops) if (t - dernier > 6) { n++; dernier = t; }
    return n;
  };
  const vraiBouton = (b) => {
    if (!b.matches('button, a, input[type=submit], input[type=button], [role=button]') || !vis(b)) return false;
    if (pasBouton && b.matches(pasBouton)) return false;
    const s = getComputedStyle(b);
    if (!(fond(s) || bord(s))) return false;
    const r = b.getBoundingClientRect();
    if (r.height < 20 || (b.tagName === 'A' && s.display === 'inline')) return false;
    // Une tuile ou une ligne à toucher (titre + détail, chiffre + légende, image) n'est pas un bouton : elle a le droit
    // de tenir sur plusieurs lignes et de suivre la hauteur de son contenu.
    return !b.querySelector('br, small, p, div, h2, h3, h4, img, picture, dl, ul') && [...b.children].filter((c) => (c.textContent || '').trim()).length < 2;
  };
  const boutons = [...document.querySelectorAll('button, a, input[type=submit], input[type=button], [role=button]')].filter(vraiBouton);

  // 1. Boutons d'un même groupe : même parent, hauteurs différentes.
  for (const p of new Set(boutons.map((b) => b.parentElement))) {
    const bs = [...p.children].filter((b) => boutons.includes(b)); if (bs.length < 2) continue;
    const hs = bs.map((b) => Math.round(b.getBoundingClientRect().height * 2) / 2);
    if (Math.max(...hs) - Math.min(...hs) > 1) out.push({ type: 'boutons', sig: chemin(p) + '|' + bs.map((b) => chiffres(txt(b, 24))).join('|'), detail: bs.map((b, i) => `« ${txt(b, 30)} » ${hs[i]} px`).join(' ; '), r: union(...bs) });
  }

  // 6. Bouton sur deux lignes.
  for (const b of boutons) {
    const n = lignes(b, true);
    if (n >= 2) out.push({ type: 'deux-lignes', sig: chemin(b) + '|' + chiffres(txt(b, 40)), detail: `bouton sur ${n} lignes : « ${txt(b)} »`, r: rect(b) });
  }

  // 11. Bouton dont le mot est coupé ou touche le bord (petits écrans surtout) : le texte dépasse de la place qu'il a.
  for (const b of boutons) {
    if (getComputedStyle(b).textOverflow === 'ellipsis' || [...b.querySelectorAll('*')].some((x) => getComputedStyle(x).textOverflow === 'ellipsis')) continue; // nom long coupé à la fin : voulu
    if (b.scrollWidth > b.clientWidth + 1) out.push({ type: 'coupe', sig: chemin(b) + '|' + chiffres(txt(b, 40)), detail: `bouton trop étroit pour son mot (${b.scrollWidth} px dans ${b.clientWidth} px) : « ${txt(b)} »`, r: rect(b) });
  }

  // 2. Alignement. a) blocs empilés dans le même parent dont le bord gauche diffère de 2 à 10 px ;
  //    b) voisins d'une même ligne qui ne partagent ni le haut, ni le milieu, ni le bas (à 1,5 px près).
  const boite = (e) => { const s = getComputedStyle(e); return (fond(s) || bord(s)) && e.getBoundingClientRect().height >= 20; };
  for (const p of document.querySelectorAll('main, section, form, div, dialog, article, fieldset, ul, li, header, footer, td')) {
    if (!vis(p) || p.children.length < 2 || p.children.length > 40) continue;
    const sp = getComputedStyle(p);
    const enfants = [...p.children].filter((e) => vis(e) && !['BR', 'SCRIPT', 'STYLE'].includes(e.tagName) && !/absolute|fixed/.test(getComputedStyle(e).position));
    if (enfants.length < 2) continue;
    const rs = enfants.map((e) => e.getBoundingClientRect());
    // a) empilés
    const centre = /center/.test(sp.textAlign) || /center/.test(sp.alignItems) || /center/.test(sp.justifyItems);
    if (!centre && !/grid|inline/.test(sp.display)) {
      for (let i = 0; i + 1 < enfants.length; i++) {
        const a = rs[i]; const b = rs[i + 1];
        if (b.top < a.bottom - 2) continue; // côte à côte
        const d = Math.abs(a.left - b.left);
        if (d < 2 || d > 10) continue;
        if (Math.abs((a.left + a.right) - (b.left + b.right)) < 2) continue; // centrés l'un sous l'autre
        const sa = getComputedStyle(enfants[i]); const sb = getComputedStyle(enfants[i + 1]);
        if (/inline/.test(sa.display) || /inline/.test(sb.display)) continue;
        if (!(boite(enfants[i]) && boite(enfants[i + 1]))) continue; // un texte en retrait dans une carte n'est pas un défaut
        out.push({ type: 'alignement', sig: 'gauche|' + chemin(enfants[i]) + '>' + nom(enfants[i + 1]), detail: `bords gauches décalés de ${Math.round(d * 10) / 10} px : « ${txt(enfants[i], 30)} » puis « ${txt(enfants[i + 1], 30)} »`, r: union(enfants[i], enfants[i + 1]) });
      }
    }
    // b) même ligne : seulement entre boîtes visibles (boutons, champs, pastilles), là où l'œil voit le décalage
    const estBoite = (e) => boutons.includes(e) || e.matches('input:not([type=checkbox]):not([type=radio]), select, textarea') || (boite(e) && e.getBoundingClientRect().height < 80);
    for (let i = 0; i + 1 < enfants.length; i++) {
      const a = rs[i]; const b = rs[i + 1];
      const recouvre = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (recouvre < Math.min(a.height, b.height) * 0.5 || b.left < a.right - 2) continue;
      if (!estBoite(enfants[i]) || !estBoite(enfants[i + 1])) continue;
      const haut = Math.abs(a.top - b.top); const bas = Math.abs(a.bottom - b.bottom); const milieu = Math.abs((a.top + a.bottom) - (b.top + b.bottom)) / 2;
      if (Math.min(haut, bas, milieu) <= 1.5) continue;
      out.push({ type: 'alignement', sig: 'ligne|' + chemin(enfants[i]) + '>' + nom(enfants[i + 1]), detail: `même ligne mais décalés (haut ${Math.round(haut)} px, milieu ${Math.round(milieu)} px, bas ${Math.round(bas)} px) : « ${txt(enfants[i], 30)} » et « ${txt(enfants[i + 1], 30)} »`, r: union(enfants[i], enfants[i + 1]) });
    }
  }

  // 3. Blocs collés : une boîte (bouton, champ, carte arrondie) et son voisin du dessous à moins de 4 px.
  const carte = (e) => { const s = getComputedStyle(e); return (fond(s) || bord(s)) && parseFloat(s.borderTopLeftRadius) >= 4 && e.getBoundingClientRect().height >= 24; };
  const estBloc = (e) => boutons.includes(e) || e.matches('input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea') || carte(e);
  for (const e of document.querySelectorAll('body *')) {
    if (!vis(e) || /absolute|fixed|sticky/.test(getComputedStyle(e).position)) continue;
    let s = e.nextElementSibling; while (s && (!vis(s) || /absolute|fixed/.test(getComputedStyle(s).position))) s = s.nextElementSibling;
    if (!s) continue;
    const be = estBloc(e); const bs = estBloc(s);
    if (!be && !bs) continue;
    const autre = be ? s : e;
    // Le voisin qui n'est pas une boîte doit être un texte : un conteneur (div, liste, formulaire) porte ses propres marges dedans.
    if (!(be && bs) && !autre.matches('p, h1, h2, h3, h4, label, span, small')) continue;
    if (!(be && bs) && !txt(autre)) continue;
    if (e.matches('label') && s.matches('input, select, textarea')) continue; // une étiquette posée sur son champ
    const a = e.getBoundingClientRect(); const b = s.getBoundingClientRect();
    if (b.top < a.bottom - 1 || b.top - a.bottom >= 4) continue; // côte à côte, ou assez d'air
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) < 8) continue; // pas l'un sous l'autre
    // Lignes d'une même liste (cartes à coins ronds collées exprès, séparées par un trait) : même classe, même forme.
    if (be && bs && e.className === s.className && e.tagName === s.tagName && !boutons.includes(e)) continue;
    out.push({ type: 'colles', sig: chemin(e) + '>' + nom(s), detail: `« ${txt(e, 34)} » puis « ${txt(s, 34)} » : ${Math.round((b.top - a.bottom) * 10) / 10} px d'écart`, r: union(e, s) });
  }

  // 4 et 5. Textes : gras sur plus d'une ligne (hors titres), explication de 4 lignes ou plus.
  const dejaVu = new Set();
  for (const e of document.querySelectorAll('p, span, strong, b, li, label, button, a, summary, div, td, dd, small, em')) {
    if (!vis(e) || ![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 12)) continue;
    if (texteLibre && e.closest(texteLibre)) continue;
    const s = getComputedStyle(e);
    const gras = parseInt(s.fontWeight, 10) >= 600;
    if (gras) {
      // Deux ou trois mots en gras au fil d'une phrase, qui tombent à cheval sur deux lignes : pas un pavé en gras.
      if (/^inline/.test(s.display) && parseInt(getComputedStyle(e.parentElement).fontWeight, 10) < 600 && [...e.parentElement.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 3)) continue;
      if (e.closest('h1, h2, h3, h4, [role=heading]') || parseFloat(s.fontSize) >= 20 || boutons.includes(e) || e.closest('button, a') && boutons.includes(e.closest('button, a'))) continue;
      const n = lignes(e);
      if (n >= GRAS_MIN) out.push({ type: 'gras', sig: chemin(e) + '|' + chiffres(txt(e, 40)), detail: `${n} lignes en gras : « ${txt(e)}… »`, r: rect(e) });
    } else if (!textesLongs && e.matches('p, span, li, div, td, dd, small, label') && !(longLibre && e.closest(longLibre))) {
      const bloc = e.matches('span, small, em') && e.parentElement.matches('p, li, div, label, dd, td') ? e.parentElement : e;
      if (dejaVu.has(bloc)) continue;
      // Une ligne de liste ou une tuile faite de plusieurs morceaux (titre, détail, bouton) n'est pas une explication.
      if ([...bloc.children].some((c) => !/^inline/.test(getComputedStyle(c).display) && vis(c))) continue;
      const n = lignes(bloc, true);
      if (n >= 4) { dejaVu.add(bloc); out.push({ type: 'long', sig: chemin(bloc) + '|' + chiffres(txt(bloc, 40)), detail: `${n} lignes : « ${txt(bloc)}… »`, r: rect(bloc) }); }
    }
  }

  // 7. Doublons : la même phrase (20 signes ou plus) portée par deux éléments visibles du même écran, hors tableaux et listes.
  const phrases = new Map();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const e = n.parentElement; const t = n.textContent.replace(/\s+/g, ' ').trim();
    if (t.length < 20 || !e || !vis(e) || e.closest('table, option, script, style, select, nav, footer, [role=listbox]')) continue;
    if (texteLibre && e.closest(texteLibre)) continue;
    if (!phrases.has(t)) phrases.set(t, []);
    phrases.get(t).push(e);
  }
  for (const [t, es] of phrases) {
    if (es.length < 2) continue;
    // Lignes sœurs d'une même liste (deux commandes avec la même mention) : pas un doublon de rédaction.
    const li = (e) => e.closest('li, tr, .ligne, .carte, .card, article');
    if (li(es[0]) && li(es[1]) && li(es[0]) !== li(es[1]) && li(es[0]).parentElement === li(es[1]).parentElement) continue;
    out.push({ type: 'doublon', sig: chiffres(t.slice(0, 60)), detail: `affiché ${es.length} fois : « ${t.slice(0, 70)} » (${chemin(es[0])} et ${chemin(es[1])})`, r: union(es[0], es[1]) });
  }
  // --- Ajouts du 27/11 (Tanguy : « comment une image complètement décalée n'a pas été repérée ? ») ---
  // Décentré : dans un bloc dont le texte est centré, un enfant seul sur sa ligne (icône, bouton, image) doit être au
  // milieu lui aussi. « text-align: center » ne centre pas l'enfant d'une colonne flex : c'était le défaut du guide.
  for (const e of document.querySelectorAll('body *')) {
    if (!vis(e) || e.children.length < 2 || e.closest('button, a, label, summary')) continue; // icône + texte d'un bouton : pas un bloc
    const se = getComputedStyle(e);
    if (se.textAlign !== 'center' || se.display === 'inline') continue;
    const re = e.getBoundingClientRect();
    const g = re.left + parseFloat(se.paddingLeft) + parseFloat(se.borderLeftWidth);
    const d = re.right - parseFloat(se.paddingRight) - parseFloat(se.borderRightWidth);
    const enfants = [...e.children].filter((c) => vis(c) && !/absolute|fixed/.test(getComputedStyle(c).position));
    for (const c of enfants) {
      const sc = getComputedStyle(c);
      if (sc.display === 'inline' || sc.textAlign !== 'center') continue;
      const rc = c.getBoundingClientRect();
      if (rc.width > (d - g) * 0.9 || rc.height < 8) continue;
      if (enfants.some((o) => o !== c && o.getBoundingClientRect().top < rc.bottom - 1 && o.getBoundingClientRect().bottom > rc.top + 1)) continue; // pas seul sur sa ligne
      const ecart = (rc.left - g) - (d - rc.right);
      if (Math.abs(ecart) > 6) out.push({ type: 'decentre', sig: chemin(c), detail: `dans un bloc centré, « ${txt(c, 30) || nom(c)} » est décalé de ${Math.round(Math.abs(ecart) / 2)} px vers la ${ecart < 0 ? 'gauche' : 'droite'}`, r: rect(c) });
    }
  }
  // Bouton seul dans une rangée prévue pour deux (l'autre est caché) : il reste collé d'un côté.
  for (const e of document.querySelectorAll('body *')) {
    if (!vis(e)) continue;
    const se = getComputedStyle(e);
    if (se.display !== 'grid' || se.gridTemplateColumns.trim().split(/\s+/).length !== 2) continue;
    const boutons = [...e.children].filter((c) => getComputedStyle(c).display !== 'none' && c.matches('button, a.primary, a.secondary'));
    const vus = boutons.filter((c) => vis(c));
    if (boutons.length === e.children.length && vus.length === 1 && vus[0].getBoundingClientRect().width < e.getBoundingClientRect().width * 0.7) {
      out.push({ type: 'bouton-seul', sig: chemin(vus[0]), detail: `« ${txt(vus[0], 30)} » est seul d'un côté d'une rangée à deux boutons`, r: rect(vus[0]) });
    }
  }
  // Élément standard du téléphone (liste, date, heure) : sa fenêtre est dessinée par le téléphone, hors style Papote,
  // et aucune capture ne la montre. Interdit : passer par une liste Papote (web/js/listes.js).
  for (const e of document.querySelectorAll('select, input[type=date], input[type=time], input[type=datetime-local], input[type=month], input[type=week], input[type=color]')) {
    if (e.classList.contains('liste-native') || !vis(e)) continue; // déjà habillé par listes.js : invisible, un bouton Papote à sa place
    out.push({ type: 'natif', sig: chemin(e), detail: `élément standard du téléphone : ${e.tagName === 'SELECT' ? 'liste' : e.type} ${nom(e)}`, r: rect(e) });
  }
  return out;
}

const PETITS = ['boutons', 'alignement', 'deux-lignes', 'coupe', 'decentre', 'bouton-seul', 'outil'];

function taillesDe(partie, mod) {
  if (partie === 'admin') return [mod.TAILLES.tel, mod.TAILLES.pc];
  // Appli : l'écran courant (390 px), puis deux petits écrans (360 px : petit Android ; 320 px : le plus étroit en service).
  // Sur les petits écrans, seules les mesures de forme comptent (PETITS) : un texte y prend forcément plus de lignes.
  if (partie === 'famille') return [mod.TAILLES ? mod.TAILLES[0] : { nom: 'telephone', width: 390, height: 780, mobile: true },
    { nom: 'petit-360', width: 360, height: 780, mobile: true, court: '360' }, { nom: 'petit-320', width: 320, height: 780, mobile: true, court: '320' }];
  return mod.TAILLES; // site : téléphone et ordinateur
}

async function balayer({ browser, base, partie, progression }) {
  const mod = require(`./${partie}`);
  const reg = REGLAGES[partie] || {};
  const dossier = path.join(__dirname, 'sortie', 'mesures');
  fs.mkdirSync(dossier, { recursive: true });
  const scenes = mod.SCENES.filter((s) => !s.avant);
  const travaux = [];
  scenes.forEach((scene, i) => { for (const taille of taillesDe(partie, mod)) travaux.push({ scene, taille, i }); });
  const total = travaux.length;
  const vus = new Map();
  const constats = [];
  let faits = 0;
  async function ouvrier() {
    for (let job = travaux.shift(); job; job = travaux.shift()) {
      const { scene, taille, i } = job;
      const court = taille.court || (taille.mobile ? 'tel' : 'pc');
      let o;
      try {
        o = partie === 'famille' ? await mod.ouvrir(browser, base, scene, taille, await videoDe(browser)) : await mod.ouvrir(browser, base, scene, taille);
      } catch (e) {
        constats.push({ type: 'outil', taille: court, sig: scene.titre, detail: 'écran impossible à ouvrir : ' + e.message.split('\n')[0], scene: scene.titre, ecrans: 1 });
        continue;
      }
      const { ctx, page } = o;
      try {
        // Fondus menés à leur fin : un bloc à moitié apparu ne se mesure pas.
        await page.evaluate(() => document.getAnimations().forEach((a) => { const t = a.effect && a.effect.getTiming(); if (t && t.iterations !== Infinity) { try { a.finish(); } catch (_) {} } })).catch(() => {});
        // Les textes de loi (CGV, mentions, confidentialité) sont longs par nature.
        const trouves = await page.evaluate(mesurer, { pasBouton: reg.pasBouton || '', texteLibre: reg.texteLibre || '', longLibre: reg.longLibre || '', textesLongs: scene.groupe === 'Textes' });
        for (const d of trouves) {
          if (taille.court && !PETITS.includes(d.type)) continue;
          const cle = `${d.type}§${court}§${d.sig}`;
          if (vus.has(cle)) { vus.get(cle).ecrans++; continue; }
          const c = { type: d.type, taille: court, sig: d.sig, detail: d.detail, scene: `${i + 1}. ${scene.groupe || ''} / ${scene.titre}`, ecrans: 1, img: null };
          vus.set(cle, c); constats.push(c);
          const img = `${partie}-${court}-${d.type}-${constats.length}.png`;
          try {
            await page.evaluate((r) => { // cadre rouge autour de l'écart
              const m = document.createElement('div'); m.id = 'mesure-cadre';
              m.style.cssText = `position:absolute;z-index:2147483647;pointer-events:none;border:2px solid #e11d48;border-radius:4px;left:${r.x - 4}px;top:${r.y - 4}px;width:${r.w + 4}px;height:${r.h + 4}px;box-sizing:content-box`;
              document.documentElement.appendChild(m);
            }, d.r);
            const hPage = await page.evaluate(() => document.documentElement.scrollHeight);
            const marge = 70;
            const y = Math.max(0, Math.min(d.r.y - marge, hPage - 10));
            const h = Math.max(60, Math.min(d.r.h + marge * 2, 900, hPage - y));
            const fixe = await page.evaluate((r) => { const e = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.x - scrollX + r.w / 2)), Math.min(innerHeight - 1, Math.max(0, r.y - scrollY + r.h / 2))); for (let p = e; p; p = p.parentElement) if (/fixed/.test(getComputedStyle(p).position) || p.tagName === 'DIALOG') return true; return false; }, d.r);
            if (fixe) await page.screenshot({ path: path.join(dossier, img) });
            else await page.screenshot({ path: path.join(dossier, img), fullPage: true, clip: { x: 0, y, width: taille.width, height: h } });
            c.img = img;
          } catch (_) { /* capture facultative */ }
          await page.evaluate(() => { const m = document.getElementById('mesure-cadre'); if (m) m.remove(); }).catch(() => {});
        }
      } catch (e) {
        constats.push({ type: 'outil', taille: court, sig: scene.titre, detail: 'mesure en erreur : ' + e.message.split('\n')[0], scene: scene.titre, ecrans: 1 });
      } finally {
        await ctx.close();
      }
      progression(`${partie} : ${++faits}/${total} écrans mesurés`);
    }
  }
  await Promise.all([ouvrier(), ouvrier(), ouvrier(), ouvrier()]);
  // Un écart déjà présent sur l'écran courant n'est pas redit pour chaque petit écran.
  const grand = new Set(constats.filter((c) => !/^\d+$/.test(c.taille)).map((c) => `${c.type}§${c.sig}`));
  return { total, constats: constats.filter((c) => !/^\d+$/.test(c.taille) || !grand.has(`${c.type}§${c.sig}`)) };
}

let video;
function videoDe(browser) { video = video || require('./commun').fausseVideo(browser); return video; }

function acceptes() {
  const f = path.join(__dirname, 'mesures-acceptes.txt');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(' | ').map((x) => x.trim())).map(([partie, type, taille, sig]) => ({ partie, type, taille, sig }));
}

const TITRES = { boutons: 'Boutons d’un même groupe de hauteurs différentes', alignement: 'Alignements', colles: 'Blocs collés sans espace', gras: 'Gras sur 3 lignes ou plus', long: 'Explications de 4 lignes ou plus', 'deux-lignes': 'Boutons sur deux lignes', coupe: 'Boutons trop étroits pour leur mot', doublon: 'Même phrase deux fois', outil: 'Écran non mesuré' };

function rapport(parties, dossier) {
  const ok = acceptes();
  const lignes = [];
  let soucis = 0;
  for (const { nom, version, total, constats } of parties) {
    const accepte = (c) => ok.some((a) => a.partie === nom && a.type === c.type && (a.taille === '*' || a.taille === c.taille) && c.sig.startsWith(a.sig));
    const neufs = constats.filter((c) => !accepte(c));
    soucis += neufs.length;
    lignes.push(`${nom} (${version}) : ${total} écrans mesurés, ${neufs.length} écart(s) à regarder, ${constats.length - neufs.length} déjà accepté(s)`);
    for (const type of Object.keys(TITRES)) {
      const l = neufs.filter((c) => c.type === type).sort((a, b) => a.scene.localeCompare(b.scene, 'fr', { numeric: true }));
      if (!l.length) continue;
      lignes.push(`  == ${TITRES[type]} : ${l.length}`);
      for (const c of l) lignes.push(`    [${c.taille}, ${c.ecrans} écran(s)] ${c.scene}\n        ${c.detail}${c.img ? `  (${c.img})` : ''}\n        signature : ${nom} | ${c.type} | ${c.taille} | ${c.sig}`);
    }
  }
  const texte = lignes.join('\n');
  const fichier = path.join(dossier, 'mesures.txt');
  fs.writeFileSync(fichier, `${texte}\n`);
  fs.writeFileSync(path.join(dossier, 'mesures.json'), JSON.stringify(parties.map(({ nom, constats }) => ({ nom, constats })), null, 1));
  return { fichier, texte, soucis };
}

module.exports = { balayer, rapport, mesurer };
