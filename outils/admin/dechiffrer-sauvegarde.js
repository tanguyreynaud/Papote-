// Relit une copie chiffrée (écrite par sauvegarder.js --copie) et la remet en clair, prête pour
// verifier-sauvegarde.bat ou restaurer.bat. À faire sur un PC de confiance, puis effacer la version en clair.
//   node dechiffrer-sauvegarde.js E:\Papote\papote-2026-11-08-03-00-00   : dossier (format 2) → E:\Papote-clair\papote-…
//   node dechiffrer-sauvegarde.js E:\Papote\fichiers                     : pièces de gestion/ → E:\Papote-clair\fichiers
//   node dechiffrer-sauvegarde.js E:\Papote\papote-....json.enc          : ancien fichier (format 1) → .json à côté
//   un second argument choisit le dossier de destination (au lieu de <dossier>-clair).
// Phrase : PAPOTE_PHRASE_SAUVEGARDE, %USERPROFILE%\.papote\phrase-sauvegarde.txt, sinon demandée au clavier.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { dechiffrer, dechiffrerFichier, phraseSecrete } = require('./chiffrement');

const source = process.argv[2] && path.resolve(process.argv[2]);
if (!source || !fs.existsSync(source) || (!fs.statSync(source).isDirectory() && !source.endsWith('.enc'))) {
  console.error('Usage : dechiffrer-sauvegarde.bat <dossier de la copie chiffrée | fichier .json.enc> [destination]');
  process.exit(1);
}

(async () => {
  let phrase = phraseSecrete();
  if (!phrase) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    phrase = await new Promise((ok) => rl.question('Phrase secrète des sauvegardes : ', (r) => { rl.close(); ok(r.trim()); }));
  }
  if (!fs.statSync(source).isDirectory()) {
    const clair = dechiffrer(fs.readFileSync(source), phrase);
    const sortie = source.slice(0, -4);
    fs.writeFileSync(sortie, clair);
    const s = JSON.parse(clair.toString('utf8'));
    console.log(`Écrit : ${sortie} (${(s.documents || []).length} documents, ${(s.comptes || []).length} comptes, du ${s.le}).`);
    return;
  }
  const destination = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.join(`${path.dirname(source)}-clair`, path.basename(source));
  fs.mkdirSync(destination, { recursive: true });
  if (fs.existsSync(path.join(source, 'index.json'))) {
    // Pièces de gestion/ : un fichier chiffré par pièce, et l'index (md5) pour les contrôler et les remettre.
    const index = JSON.parse(fs.readFileSync(path.join(source, 'index.json'), 'utf8'));
    let n = 0;
    for (const chemin of Object.keys(index)) {
      const cible = path.join(destination, ...chemin.split('/'));
      fs.mkdirSync(path.dirname(cible), { recursive: true });
      await dechiffrerFichier(`${path.join(source, ...chemin.split('/'))}.enc`, cible, phrase);
      n++;
    }
    fs.copyFileSync(path.join(source, 'index.json'), path.join(destination, 'index.json'));
    const v = await require('./sauvegarde-lib').verifierFichiers(destination);
    console.log(`Écrit : ${destination} (${n} fichiers, ${v.manquants.length} manquant(s), ${v.abimes.length} abîmé(s)).`);
    if (v.manquants.length || v.abimes.length) process.exitCode = 1;
    return;
  }
  // Une sauvegarde : documents et comptes, puis l'entête ; le dossier en clair est contrôlé comme une sauvegarde.
  const lib = require('./sauvegarde-lib');
  for (const fichier of Object.values(lib.DONNEES)) {
    await dechiffrerFichier(path.join(source, `${fichier}.enc`), path.join(destination, fichier), phrase);
  }
  fs.copyFileSync(path.join(source, 'entete.json'), path.join(destination, 'entete.json'));
  const e = await lib.verifierDossier(destination);
  console.log(`Écrit et contrôlé : ${destination} (${e.documents.lignes} documents, ${e.comptes.lignes} comptes, du ${e.le}).`);
  console.log('Pour restaurer aussi les pièces de gestion/, déchiffrer le dossier « fichiers » de la copie à côté.');
})().catch((e) => { console.error('Impossible :', e.message); process.exit(1); });
