// Appui long (Tanguy, 31/10 : « t'as testé de rester appuyé ? »). Un doigt peu sûr appuie fort et longtemps,
// ou garde le doigt posé en hésitant. Pour chaque bouton différent du site, de l'app famille, de la tablette
// et de l'admin (le premier écran où il apparaît), on rouvre l'écran, on bloque le serveur, on pose le doigt
// 1,2 s puis on le relève, et on vérifie :
//   - que l'action part une fois au plus (jamais en double : un bouton branché sur pointerdown ET sur click,
//     ou qui répète tant qu'on appuie) ;
//   - que rien ne reste sélectionné (le texte du bouton ou de la page qui bleuit, avec les poignées) ;
//   - que le menu contextuel du long appui (Android : « Ouvrir dans un nouvel onglet », « Enregistrer
//     l'image ») ne s'ouvre pas sur la tablette (rien ne doit jamais sortir de l'écran de Mamie) ;
//   - que l'écran répond encore à un toucher normal après (pas resté « enfoncé »).
// Même mécanique que double.js (serveur bloqué, comptage de ce qui part : faux-firebase.js, Android, réseau).
'use strict';

const fs = require('fs');
const path = require('path');
const { lister, SEL } = require('./boutons');

const APPUI_MS = 1200;

function partieDe(nom) {
  const mod = require(`./${nom}`);
  if (nom === 'admin') return { mod, scenes: mod.SCENES, tailleDe: (s) => mod.TAILLES[(s.tailles || ['pc'])[0]] };
  if (nom === 'famille') return { mod, scenes: mod.SCENES.filter((s) => !s.avant), tailleDe: () => mod.TAILLES[0] };
  return { mod, scenes: mod.SCENES, tailleDe: () => mod.TAILLES[0] };
}

// Ce qui est parti depuis la remise à zéro : { quoi: n } (une action = 1 attendu au plus).
function compter() {
  const w = window;
  const m = new Map();
  const plus = (k) => m.set(k, (m.get(k) || 0) + 1);
  for (const a of w.__appels || []) plus(`fonction ${a.nom}`);
  for (const e of w.__ecritures || []) {
    if (e.op === 'add' && /Candidates$/.test(e.chemin)) continue;
    if (e.op === 'add') plus(`ajout dans ${e.chemin}`);
    else if (e.op === 'transaction') plus('transaction');
    else if (e.op === 'commit') plus('lot d\'écritures');
    else if (e.op === 'upload') plus(`envoi du fichier ${e.chemin}`);
  }
  for (const x of w.__android || []) if (x !== 'fenetre') plus(`Android ${x}`);
  return [...m].filter(([, n]) => n >= 2).map(([quoi, n]) => ({ quoi, n }));
}

async function essayer(partie, browser, base, scene, taille, nom, tablette) {
  const { ctx, page } = await partie.mod.ouvrir(browser, base, scene, taille);
  const requetes = new Map();
  try {
    page.on('request', (r) => {
      if (r.method() === 'GET' || /fonts\.g|gstatic\.com/.test(r.url())) return;
      const k = `${r.method()} ${r.url().replace(/\?.*$/, '')}`;
      requetes.set(k, (requetes.get(k) || 0) + 1);
    });
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    await page.evaluate(() => { window.__fonctionsBloquees = true; window.__ecrituresBloquees = true; });
    const noms = await page.evaluate(lister, SEL);
    const i = noms.indexOf(nom);
    if (i < 0) return null;
    const loc = page.locator(`[data-bouton="${i}"]`);
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
    const box = await loc.boundingBox();
    if (!box) return null;
    await page.evaluate(() => {
      window.__appels = []; window.__ecritures = []; window.__android = [];
      window.__menus = 0;
      // Le navigateur ouvre le menu du long appui si la page ne l'empêche pas (preventDefault).
      document.addEventListener('contextmenu', (e) => { if (!e.defaultPrevented) window.__menus++; }, { capture: false });
    });
    requetes.clear();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    // Le doigt posé 1,2 s. Chrome Android envoie contextmenu après ~500 ms d'appui : on le rejoue ici.
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(500);
    await page.evaluate(([px, py]) => {
      const el = document.elementFromPoint(px, py);
      if (el) el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: px, clientY: py }));
    }, [x, y]).catch(() => {});
    await page.waitForTimeout(APPUI_MS - 500);
    await page.mouse.up();
    await page.waitForTimeout(700);
    const problemes = [];
    const doubles = await page.evaluate(compter).catch(() => null);
    if (!doubles) return { problemes }; // page partie ailleurs : rien n'est parti deux fois
    const r = await page.evaluate(() => ({
      selection: String((window.getSelection && window.getSelection().toString()) || '').trim().slice(0, 40),
      menus: window.__menus || 0,
    })).catch(() => ({ selection: '', menus: 0 }));
    for (const d of doubles) problemes.push(`${d.quoi} ×${d.n}`);
    for (const [quoi, n] of requetes) if (n >= 2) problemes.push(`requête ${quoi.replace(base, '')} ×${n}`);
    if (r.selection) problemes.push(`texte sélectionné : « ${r.selection} »`);
    if (tablette && r.menus) problemes.push('menu du long appui pas empêché (contextmenu)');
    return { problemes };
  } catch (e) {
    return null;
  } finally {
    await ctx.close();
  }
}

// partie : 'vitrine', 'famille', 'tablette' ou 'admin'. Rend { total, soucis: [{ scene, bouton, probleme }] }.
async function balayer({ browser, base, partie: nom, progression }) {
  const partie = partieDe(nom);
  const { scenes, tailleDe } = partie;
  const parScene = new Array(scenes.length);
  let faits = 0;
  const file1 = scenes.map((s, i) => i);
  async function lire() {
    for (let i = file1.shift(); i !== undefined; i = file1.shift()) {
      const { ctx, page } = await partie.mod.ouvrir(browser, base, scenes[i], tailleDe(scenes[i]));
      parScene[i] = await page.evaluate(lister, SEL).catch(() => []);
      await ctx.close();
      progression(`${nom} : boutons des écrans ${++faits}/${scenes.length}`);
    }
  }
  await Promise.all([lire(), lire(), lire(), lire()]);
  const vus = new Set();
  const file2 = [];
  scenes.forEach((s, i) => { for (const b of parScene[i] || []) if (!vus.has(b)) { vus.add(b); file2.push({ i, nom: b }); } });
  const n0 = file2.length;
  const soucis = [];
  faits = 0;
  async function toucher() {
    for (let job = file2.shift(); job; job = file2.shift()) {
      const r = await essayer(partie, browser, base, scenes[job.i], tailleDe(scenes[job.i]), job.nom, nom === 'tablette');
      for (const p of (r && r.problemes) || []) soucis.push({ scene: scenes[job.i].titre, bouton: job.nom, probleme: p });
      progression(`${nom} : ${++faits}/${n0} boutons appuyés longtemps`);
    }
  }
  await Promise.all([toucher(), toucher(), toucher(), toucher()]);
  return { total: n0, soucis };
}

function rapport(parties, dossier) {
  const lignes = [];
  const tri = (a, b) => a.scene.localeCompare(b.scene) || a.bouton.localeCompare(b.bouton);
  let total = 0;
  for (const { nom, version, total: n, soucis } of parties) {
    lignes.push(`${nom} (${version}) : ${n} boutons appuyés ${APPUI_MS / 1000} s, ${soucis.length} souci(s)`);
    for (const p of soucis.sort(tri)) lignes.push(`  - ${p.scene} : ${p.bouton} : ${p.probleme}`);
    total += soucis.length;
  }
  const fichier = path.join(dossier, 'appui-long.txt');
  fs.writeFileSync(fichier, lignes.join('\n') + '\n');
  return { fichier, texte: lignes.join('\n'), soucis: total };
}

module.exports = { balayer, rapport };
