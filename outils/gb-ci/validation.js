// Captures pour l'espace « Validation » de l'admin (admin.html#validation) : chaque partie de la galerie est
// rangée dans outils/galerie/validation/<partie>.json, avec ses captures dans validation/i/, nommées par leur
// empreinte. Le dossier n'est pas vidé d'une galerie à l'autre : « galerie.bat admin » ne remplace que l'admin.
// publier-validation.mjs assemble le tout (index.json) et le met en ligne sur le site papote-validation.
//
// Chaque écran a un identifiant stable (partie, parcours, titre) : la validation de Tanguy le suit même quand les
// numéros changent. L'empreinte de ses captures dit si l'écran a changé depuis qu'il l'a validé.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DOSSIER = path.join(__dirname, 'validation');
const LETTRES = { tablette: 'T', famille: 'F', vitrine: 'S', admin: 'A', emails: 'E' };

const empreinte = (donnees, n = 16) => crypto.createHash('sha1').update(donnees).digest('hex').slice(0, n);

function ecrire(parties, dossierImages, dossier = DOSSIER) {
  fs.mkdirSync(path.join(dossier, 'i'), { recursive: true });
  for (const partie of parties) {
    // Une scène = un numéro, ses captures (paysage, portrait, clavier ouvert…) ensemble, comme dans page.js.
    const scenes = [];
    for (const e of partie.ecrans) {
      let s = scenes[scenes.length - 1];
      if (!s || s.scene !== e.scene) { s = { e, captures: [], erreurs: [] }; scenes.push(s); }
      s.captures.push(e);
      for (const x of e.erreurs || []) if (!s.erreurs.includes(x)) s.erreurs.push(x);
    }
    const vus = {};
    const ecrans = scenes.map((s, i) => {
      const { groupe, titre, note, fonction } = s.e;
      const cle = `${partie.nom}|${groupe || ''}|${titre}`;
      vus[cle] = (vus[cle] || 0) + 1;
      const captures = s.captures.map((c) => {
        const octets = fs.readFileSync(path.join(dossierImages, c.fichier));
        const nom = `${empreinte(octets)}.jpg`;
        const cible = path.join(dossier, 'i', nom);
        if (!fs.existsSync(cible)) fs.writeFileSync(cible, octets);
        return { f: `i/${nom}`, taille: c.taille };
      });
      return {
        id: `x${empreinte(vus[cle] > 1 ? `${cle}|${vus[cle]}` : cle, 12)}`,
        num: `${LETTRES[partie.nom]}${i + 1}`,
        groupe: groupe || '',
        titre,
        note: note || '',
        fonction: fonction || undefined,
        erreurs: s.erreurs,
        captures,
        h: empreinte(captures.map((c) => c.f).join(','), 12),
      };
    });
    const fiche = { partie: partie.nom, source: partie.version, le: Date.now(), ecrans };
    fs.writeFileSync(path.join(dossier, `${partie.nom}.json`), JSON.stringify(fiche));
  }
}

// Assemble les parties présentes en un seul index.json (une lecture pour l'admin) et retire les captures
// qu'aucune partie n'utilise plus. Renvoie le résumé affiché à la fin.
function assembler(dossier = DOSSIER) {
  const ordre = ['tablette', 'famille', 'vitrine', 'admin', 'emails'];
  const parties = ordre
    .filter((p) => fs.existsSync(path.join(dossier, `${p}.json`)))
    .map((p) => JSON.parse(fs.readFileSync(path.join(dossier, `${p}.json`), 'utf8')));
  const utilisees = new Set(parties.flatMap((p) => p.ecrans.flatMap((e) => e.captures.map((c) => c.f))));
  let retirees = 0;
  for (const f of fs.existsSync(path.join(dossier, 'i')) ? fs.readdirSync(path.join(dossier, 'i')) : []) {
    if (!utilisees.has(`i/${f}`)) { fs.unlinkSync(path.join(dossier, 'i', f)); retirees++; }
  }
  fs.writeFileSync(path.join(dossier, 'index.json'), JSON.stringify({ le: Date.now(), parties }));
  fs.writeFileSync(path.join(dossier, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  fs.writeFileSync(path.join(dossier, 'index.html'),
    '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Papote</title>' +
    '<p style="font-family:sans-serif">Captures de l\'espace Validation : à voir dans l\'admin Papote.</p>');
  return { parties: parties.map((p) => `${p.partie} ${p.ecrans.length}`), captures: utilisees.size, retirees };
}

module.exports = { ecrire, assembler, DOSSIER };
