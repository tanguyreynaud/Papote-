// iPhone simulé (Tanguy, 3/11 : « je n'ai pas d'iPhone ») : chaque écran du site, de l'app famille et de l'admin est
// rouvert dans WebKit, le moteur de Safari, aux tailles d'un iPhone SE (375 × 667) et d'un iPhone 15 (393 × 852).
// Signale : les erreurs de la page (JavaScript que Safari ne comprend pas), la page plus large que l'écran et les
// textes écrasés (commun.miseEnPage). Pas de capture.
// Limite honnête : c'est le moteur de Safari sur Linux, pas un vrai iPhone (pas d'iOS, pas de clavier ni de barre
// Safari réelle, pas de caméra). Il attrape les erreurs de code et de mise en page propres à Safari, pas tout.
'use strict';

const fs = require('fs');
const path = require('path');
const { miseEnPage } = require('./commun');

const IPHONES = [
  { nom: 'iPhone SE', width: 375, height: 667, mobile: true },
  { nom: 'iPhone 15', width: 393, height: 852, mobile: true },
];
// Écrans qui choisissent un fichier préparé par la galerie (photo, vidéo) : pas rejoués ici.
const AVEC_FICHIER = /setInputFiles|videoChoisie|photoChoisie|EXEMPLE|VIDEO\(/;

function scenesDe(nom) {
  const mod = require(`./${nom}`);
  let scenes = mod.SCENES;
  if (nom === 'famille') scenes = scenes.filter((s) => !s.avant && !(s.faire && AVEC_FICHIER.test(String(s.faire))));
  return { mod, scenes };
}

// partie : 'vitrine', 'famille' ou 'admin'. Rend { total, soucis: [{ scene, iphone, quoi }] }.
async function balayer({ browser, base, partie: nom, progression }) {
  const { mod, scenes } = scenesDe(nom);
  const travaux = [];
  for (const scene of scenes) for (const iphone of IPHONES) travaux.push({ scene, iphone });
  const total = travaux.length;
  const soucis = [];
  let faits = 0;
  async function ouvrier() {
    for (let t = travaux.shift(); t; t = travaux.shift()) {
      let ctx;
      try {
        const o = await mod.ouvrir(browser, base, t.scene, t.iphone);
        ctx = o.ctx;
        const erreurs = [...o.erreurs, ...await miseEnPage(o.page)];
        for (const quoi of erreurs) soucis.push({ scene: t.scene.titre, iphone: t.iphone.nom, quoi });
      } catch (e) {
        soucis.push({ scene: t.scene.titre, iphone: t.iphone.nom, quoi: 'Ouverture : ' + String(e.message || e).split('\n')[0] });
      } finally {
        if (ctx) await ctx.close().catch(() => {});
      }
      progression(`${nom} sur iPhone ${++faits}/${total}`);
    }
  }
  await Promise.all([ouvrier(), ouvrier(), ouvrier()]);
  return { total, soucis };
}

function rapport(parties, dossier) {
  const lignes = [];
  let n = 0;
  for (const { nom, version, total, soucis } of parties) {
    n += soucis.length;
    lignes.push(`${nom} (${version}) : ${total} écrans ouverts dans WebKit (iPhone SE et iPhone 15), ${soucis.length} souci(s)`);
    for (const s of soucis) lignes.push(`  - ${s.scene} (${s.iphone}) : ${s.quoi}`);
  }
  lignes.push('', 'WebKit simulé sur Linux : ce n\'est pas un vrai iPhone (pas d\'iOS, de clavier ni de caméra réels).');
  const fichier = path.join(dossier, 'iphone.txt');
  fs.writeFileSync(fichier, lignes.join('\n') + '\n');
  return { fichier, texte: lignes.join('\n'), soucis: n };
}

module.exports = { balayer, rapport, IPHONES };
