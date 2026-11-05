// Relit une copie chiffrée (.json.enc, écrite par sauvegarder.js --copie) et écrit le .json en clair à côté,
// prêt pour verifier-sauvegarde.bat ou restaurer.bat. À faire sur un PC de confiance, puis effacer le .json en clair.
//   node dechiffrer-sauvegarde.js E:\Papote\papote-2026-11-08-03-00-00.json.enc
// Phrase : PAPOTE_PHRASE_SAUVEGARDE, %USERPROFILE%\.papote\phrase-sauvegarde.txt, sinon demandée au clavier.
const fs = require('node:fs');
const readline = require('node:readline');
const { dechiffrer, phraseSecrete } = require('./chiffrement');

const fichier = process.argv[2];
if (!fichier || !fichier.endsWith('.enc') || !fs.existsSync(fichier)) {
  console.error('Usage : dechiffrer-sauvegarde.bat <fichier.json.enc>');
  process.exit(1);
}
(async () => {
  let phrase = phraseSecrete();
  if (!phrase) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    phrase = await new Promise((ok) => rl.question('Phrase secrète des sauvegardes : ', (r) => { rl.close(); ok(r.trim()); }));
  }
  const clair = dechiffrer(fs.readFileSync(fichier), phrase);
  const sortie = fichier.slice(0, -4);
  fs.writeFileSync(sortie, clair);
  const s = JSON.parse(clair.toString('utf8'));
  console.log(`Écrit : ${sortie} (${(s.documents || []).length} documents, ${(s.comptes || []).length} comptes, du ${s.le}).`);
})().catch((e) => { console.error('Impossible :', e.message); process.exit(1); });
