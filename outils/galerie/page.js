// Fabrique la page de la galerie : un seul fichier HTML, les captures dedans (on peut l'envoyer tel quel).
'use strict';

const fs = require('fs');
const path = require('path');

const NOMS = { tablette: 'Tablette', famille: 'App famille', vitrine: 'Site vitrine' };
const LETTRES = { tablette: 'T', famille: 'F', vitrine: 'S' };

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function html(parties, dossierImages) {
  const img = (f) => `data:image/jpeg;base64,${fs.readFileSync(path.join(dossierImages, f)).toString('base64')}`;
  const quand = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long', timeStyle: 'short' });
  let corps = '';
  let sommaire = '';
  for (const partie of parties) {
    // Une scène = un numéro, avec ses captures (paysage, portrait…) côte à côte.
    const scenes = [];
    for (const e of partie.ecrans) {
      let s = scenes[scenes.length - 1];
      if (!s || s.scene !== e.scene) { s = { ...e, captures: [] }; scenes.push(s); }
      s.captures.push(e);
      if (e.erreurs.length) s.erreurs = [...new Set([...(s.erreurs || []), ...e.erreurs])];
    }
    const L = LETTRES[partie.nom];
    sommaire += `<a class="chip" href="#${partie.nom}">${NOMS[partie.nom]} <span>${scenes.length}</span></a>`;
    corps += `<section class="partie" id="${partie.nom}" data-partie="${partie.nom}">
<h2>${NOMS[partie.nom]}</h2><p class="source">Source : ${esc(partie.version)}</p>`;
    let groupe = null;
    scenes.forEach((s, i) => {
      if (s.groupe !== groupe) {
        if (groupe !== null) corps += '</div>';
        groupe = s.groupe;
        corps += `<h3>${esc(groupe)}</h3><div class="grille">`;
      }
      const num = `${L}${i + 1}`;
      corps += `<article class="ecran" id="${num}">
<header><span class="num">${num}</span><h4>${esc(s.titre)}</h4></header>
${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}
<div class="captures">${s.captures.map((c) => `<figure class="${c.taille}"><button class="zoom" data-num="${num}" data-titre="${esc(s.titre)} · ${c.taille}"><img loading="lazy" src="${img(c.fichier)}" alt="${num} ${esc(s.titre)}, ${c.taille}"></button><figcaption>${c.taille}</figcaption></figure>`).join('')}</div>
${s.erreurs?.length ? `<p class="erreur">Erreur de la page : ${esc(s.erreurs.join(' · '))}</p>` : ''}
</article>`;
    });
    if (groupe !== null) corps += '</div>';
    corps += '</section>';
  }

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Galerie des écrans Papote</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Bricolage+Grotesque:wght@600;700&display=swap">
<style>
:root { --fond:#fdfaf5; --carte:#ffffff; --texte:#1f2937; --doux:#6b7280; --ligne:#e7e1d6; --indigo:#4f46e5; --indigo-doux:#eef2ff; --erreur:#b91c1c; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { color-scheme:dark; --fond:#14141c; --carte:#1d1d28; --texte:#ececf1; --doux:#a1a1b5; --ligne:#2e2e3d; --indigo:#a5b4fc; --indigo-doux:#25254a; --erreur:#fca5a5; } }
:root[data-theme="dark"] { color-scheme:dark; --fond:#14141c; --carte:#1d1d28; --texte:#ececf1; --doux:#a1a1b5; --ligne:#2e2e3d; --indigo:#a5b4fc; --indigo-doux:#25254a; --erreur:#fca5a5; }
* { box-sizing:border-box; }
body { margin:0; background:var(--fond); color:var(--texte); font:16px/1.45 'Atkinson Hyperlegible', system-ui, sans-serif; }
h1, h2, h3, h4 { font-family:'Bricolage Grotesque', system-ui, sans-serif; margin:0; }
.haut { position:sticky; top:env(safe-area-inset-top, 0px); z-index:5; background:var(--fond); border-bottom:1px solid var(--ligne); padding-block:12px; padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); display:flex; flex-wrap:wrap; gap:10px 16px; align-items:center; }
.haut h1 { font-size:22px; margin-right:auto; }
.chips { display:flex; gap:8px; flex-wrap:wrap; }
.chip, .bascule button { border:1px solid var(--ligne); background:var(--carte); color:var(--texte); border-radius:999px; padding:6px 12px; font:inherit; font-size:14px; text-decoration:none; cursor:pointer; }
.chip span { color:var(--doux); }
.bascule { display:flex; gap:6px; }
.bascule button[aria-pressed="true"] { background:var(--indigo); border-color:var(--indigo); color:var(--fond); }
main { max-width:1400px; margin:0 auto; padding-block:8px 48px; padding-left:max(16px, env(safe-area-inset-left, 0px)); padding-right:max(16px, env(safe-area-inset-right, 0px)); }
body::before { content:""; position:fixed; inset:0 0 auto; height:env(safe-area-inset-top, 0px); z-index:10; background:var(--fond); }
.intro { color:var(--doux); margin:12px 0 0; max-width:70ch; }
.partie h2 { font-size:28px; margin:32px 0 2px; }
.source { color:var(--doux); font-size:14px; margin:0 0 8px; }
h3 { font-size:18px; margin:24px 0 10px; color:var(--doux); font-weight:600; }
.grille { display:grid; grid-template-columns:repeat(auto-fill, minmax(min(100%, 420px), 1fr)); gap:16px; }
.ecran { background:var(--carte); border:1px solid var(--ligne); border-radius:12px; padding:12px; scroll-margin-top:80px; }
.ecran:target { outline:3px solid var(--indigo); }
.ecran header { display:flex; gap:10px; align-items:baseline; }
.num { font:700 15px 'Bricolage Grotesque', sans-serif; background:var(--indigo-doux); color:var(--indigo); border-radius:6px; padding:2px 8px; flex:none; }
h4 { font-size:16px; }
.note { margin:4px 0 0; color:var(--doux); font-size:14px; }
.erreur { margin:8px 0 0; color:var(--erreur); font-size:13px; }
.captures { display:flex; gap:10px; align-items:flex-start; margin-top:10px; }
figure { margin:0; min-width:0; }
figure.paysage { flex:1; } figure.portrait { flex:1; } figure.telephone { flex:1; max-width:220px; } figure.ordinateur { flex:2; }
figcaption { font-size:12px; color:var(--doux); text-align:center; margin-top:2px; }
.zoom { display:block; width:100%; padding:0; border:1px solid var(--ligne); border-radius:6px; overflow:hidden; background:#000; cursor:zoom-in; }
.zoom img { display:block; width:100%; height:auto; }
body.seul-paysage figure.portrait, body.seul-portrait figure.paysage { display:none; }
body.seul-paysage figure.paysage, body.seul-portrait figure.portrait { flex:1; max-width:none; }
.grand { position:fixed; inset:0; z-index:10; background:rgba(0,0,0,.88); display:flex; flex-direction:column; align-items:center; justify-content:center; padding:16px; gap:10px; }
.grand[hidden] { display:none; }
.grand img { max-width:100%; max-height:calc(100vh - 90px); object-fit:contain; border-radius:6px; }
.grand p { color:#fff; margin:0; font-size:16px; text-align:center; }
.grand button { position:absolute; top:12px; right:12px; background:#fff; color:#111; border:0; border-radius:999px; padding:8px 14px; font:inherit; cursor:pointer; }
</style>
</head>
<body>
<div class="haut">
  <h1>Galerie des écrans</h1>
  <nav class="chips">${sommaire}</nav>
</div>
<main>
<p class="intro">Faite le ${esc(quand)}, avec de fausses données (aucune vraie famille). Pour donner un avis, citez le numéro : « T12 : le bouton est trop petit ». Touchez une capture pour l'agrandir.</p>
${corps}
</main>
<div class="grand" id="grand" hidden><button type="button" id="fermer">✕ Fermer</button><img alt=""><p></p></div>
<script>
const grand = document.getElementById('grand');
document.addEventListener('click', (e) => {
  const z = e.target.closest('.zoom');
  if (z) { grand.querySelector('img').src = z.querySelector('img').src; grand.querySelector('p').textContent = z.dataset.num + ' · ' + z.dataset.titre; grand.hidden = false; return; }
  if (!grand.hidden && (e.target === grand || e.target.id === 'fermer' || e.target.tagName === 'IMG')) grand.hidden = true;
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') grand.hidden = true; });
document.querySelectorAll('.bascule button').forEach((b) => b.addEventListener('click', () => {
  document.body.className = b.dataset.vue;
  document.querySelectorAll('.bascule button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
}));
</script>
</body>
</html>`;
}

module.exports = { html };
