// Double clic (Tanguy, 30/10 : « un double clic n'appelle jamais 2 fois la même chose sur aucun bouton »).
// Pour chaque bouton différent du site vitrine, de l'app famille, de la tablette et de l'admin (le premier
// écran où il apparaît), on rouvre l'écran, on bloque le serveur (il ne répond jamais, comme sur un réseau
// lent), on touche le bouton deux fois de suite puis une troisième fois 150 ms plus tard, et on compte ce qui
// part : appels de fonctions serveur, ajouts de documents, transactions, envois de fichiers (faux-firebase.js),
// requêtes réseau POST (site), ordres passés à Android (tablette). La même action partie deux fois = bouton
// signalé. Une écriture répétée sur le même document (set/update) est notée à part : souvent sans conséquence
// (même valeur réécrite), à juger à la main.
'use strict';

const fs = require('fs');
const path = require('path');
const { lister, SEL } = require('./boutons');

// Module, taille et liste de scènes de chaque partie.
function partieDe(nom) {
  const mod = require(`./${nom}`);
  if (nom === 'admin') return { mod, scenes: mod.SCENES, tailleDe: (s) => mod.TAILLES[(s.tailles || ['pc'])[0]] };
  if (nom === 'famille') return { mod, scenes: mod.SCENES.filter((s) => !s.avant), tailleDe: () => mod.TAILLES[0] };
  return { mod, scenes: mod.SCENES, tailleDe: () => mod.TAILLES[0] }; // vitrine (téléphone), tablette (paysage)
}

// Ce qui est parti depuis la remise à zéro, regroupé : { graves: [{quoi, n}], repetees: [{quoi, n}] }.
function compter() {
  const w = window;
  const graves = new Map();
  const repetees = new Map();
  const plus = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const a of w.__appels || []) plus(graves, `fonction ${a.nom}`);
  for (const e of w.__ecritures || []) {
    // Les candidats réseau d'un appel vidéo (callerCandidates) : plusieurs par appel, ce n'est pas un 2e appel.
    if (e.op === 'add' && /Candidates$/.test(e.chemin)) continue;
    if (e.op === 'add') plus(graves, `ajout dans ${e.chemin}`);
    else if (e.op === 'transaction') plus(graves, 'transaction');
    else if (e.op === 'commit') plus(graves, 'lot d\'écritures');
    else if (e.op === 'upload') plus(graves, `envoi du fichier ${e.chemin}`);
    else plus(repetees, `${e.op} ${e.chemin}`);
  }
  // `fenetre` : la tablette dit à Android chaque seconde si une fenêtre est ouverte (pas une action du bouton).
  for (const m of w.__android || []) if (m !== 'fenetre') plus(graves, `Android ${m}`);
  const liste = (m) => [...m].filter(([, n]) => n >= 2).map(([quoi, n]) => ({ quoi, n }));
  return { graves: liste(graves), repetees: liste(repetees) };
}

async function essayer(partie, browser, base, scene, taille, nom) {
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
    if (i < 0) return null; // l'écran a changé entre-temps : rien à juger
    const loc = page.locator(`[data-bouton="${i}"]`);
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
    await page.evaluate(() => { window.__appels = []; window.__ecritures = []; window.__android = []; });
    requetes.clear();
    // Deux touchers coup sur coup, puis un troisième 150 ms après (le doigt qui insiste).
    await loc.click({ clickCount: 2, timeout: 2000, noWaitAfter: true });
    await page.waitForTimeout(150);
    await loc.click({ force: true, timeout: 500, noWaitAfter: true }).catch(() => {});
    await page.waitForTimeout(700);
    const r = await page.evaluate(compter).catch(() => ({ graves: [], repetees: [] })); // page partie ailleurs : rien n'est parti deux fois
    for (const [quoi, n] of requetes) if (n >= 2) r.graves.push({ quoi: `requête ${quoi.replace(base, '')}`, n });
    return r;
  } catch (e) {
    return null;
  } finally {
    await ctx.close();
  }
}

// partie : 'vitrine', 'famille', 'tablette' ou 'admin'. Rend { total, graves, repetees } (listes { scene, bouton, quoi, n }).
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
  const graves = [];
  const repetees = [];
  faits = 0;
  async function toucher() {
    for (let job = file2.shift(); job; job = file2.shift()) {
      const r = await essayer(partie, browser, base, scenes[job.i], tailleDe(scenes[job.i]), job.nom);
      for (const g of (r && r.graves) || []) graves.push({ scene: scenes[job.i].titre, bouton: job.nom, ...g });
      for (const g of (r && r.repetees) || []) repetees.push({ scene: scenes[job.i].titre, bouton: job.nom, ...g });
      progression(`${nom} : ${++faits}/${n0} boutons touchés deux fois`);
    }
  }
  await Promise.all([toucher(), toucher(), toucher(), toucher()]);
  return { total: n0, graves, repetees };
}

function rapport(parties, dossier) {
  const lignes = [];
  const tri = (a, b) => a.scene.localeCompare(b.scene) || a.bouton.localeCompare(b.bouton);
  for (const { nom, version, total, graves, repetees } of parties) {
    lignes.push(`${nom} (${version}) : ${total} boutons touchés deux fois, ${graves.length} action(s) partie(s) en double`);
    for (const p of graves.sort(tri)) lignes.push(`  - ${p.scene} : ${p.bouton} : ${p.quoi} ×${p.n}`);
    lignes.push(`${nom} : ${repetees.length} écriture(s) répétée(s) sur le même document (à juger : souvent la même valeur réécrite)`);
    for (const p of repetees.sort(tri)) lignes.push(`  - ${p.scene} : ${p.bouton} : ${p.quoi} ×${p.n}`);
  }
  const fichier = path.join(dossier, 'double-clic.txt');
  fs.writeFileSync(fichier, lignes.join('\n') + '\n');
  fs.writeFileSync(path.join(dossier, 'double-clic.json'), JSON.stringify(parties, null, 1));
  return { fichier, texte: lignes.join('\n') };
}

module.exports = { balayer, rapport };
