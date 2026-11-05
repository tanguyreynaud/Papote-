// Copie chiffrée d'une sauvegarde, pour la garder HORS du compte Google de Tanguy (clé USB, disque, 2e compte,
// autre nuage) : si le compte Google est perdu ou piraté, la copie sur G:\Mon Drive part avec lui.
// AES-256-GCM, clé tirée de la phrase secrète par scrypt (N=2^15, r=8, p=1). Sans dépendance (node:crypto).
//
// Format (.enc) : "PAPOTE-ENC1\n" | sel 16 o | iv 12 o | étiquette GCM 16 o | données chiffrées
// La phrase secrète : variable PAPOTE_PHRASE_SAUVEGARDE, ou fichier %USERPROFILE%\.papote\phrase-sauvegarde.txt.
// ELLE DOIT AUSSI ÊTRE ÉCRITE AILLEURS QUE SUR LE PC (papier au coffre, gestionnaire de mots de passe) :
// sans elle, la copie est illisible, pour un voleur comme pour Tanguy.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENTETE = Buffer.from('PAPOTE-ENC1\n');
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function cle(phrase, sel) {
  if (typeof phrase !== 'string' || phrase.length < 12) throw new Error('Phrase secrète trop courte (12 caractères au moins).');
  return crypto.scryptSync(phrase.normalize('NFC'), sel, 32, SCRYPT);
}

function chiffrer(donnees, phrase) {
  const sel = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cle(phrase, sel), iv);
  c.setAAD(ENTETE);
  const corps = Buffer.concat([c.update(donnees), c.final()]);
  return Buffer.concat([ENTETE, sel, iv, c.getAuthTag(), corps]);
}

function dechiffrer(paquet, phrase) {
  if (!Buffer.isBuffer(paquet) || paquet.length < ENTETE.length + 44 || !paquet.subarray(0, ENTETE.length).equals(ENTETE)) {
    throw new Error('Ce fichier n\'est pas une copie chiffrée de Papote.');
  }
  let i = ENTETE.length;
  const sel = paquet.subarray(i, i += 16);
  const iv = paquet.subarray(i, i += 12);
  const etiquette = paquet.subarray(i, i += 16);
  const d = crypto.createDecipheriv('aes-256-gcm', cle(phrase, sel), iv);
  d.setAAD(ENTETE);
  d.setAuthTag(etiquette);
  try {
    return Buffer.concat([d.update(paquet.subarray(i)), d.final()]);
  } catch (e) {
    throw new Error('Phrase secrète incorrecte, ou fichier abîmé.');
  }
}

function phraseSecrete() {
  if (process.env.PAPOTE_PHRASE_SAUVEGARDE) return process.env.PAPOTE_PHRASE_SAUVEGARDE;
  const f = path.join(os.homedir(), '.papote', 'phrase-sauvegarde.txt');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  return null;
}

// Garde les n dernières copies chiffrées ; n'efface jamais rien si la nouvelle copie est beaucoup plus petite que
// la précédente (base vidée, sauvegarde ratée : on ne remplace pas la dernière bonne par une vide, audit A15-3).
function garderCopies(dossier, n = 12) {
  const fichiers = fs.readdirSync(dossier).filter((f) => /^papote-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json\.enc$/.test(f)).sort();
  if (!n || fichiers.length <= n) return [];
  const taille = (f) => fs.statSync(path.join(dossier, f)).size;
  const derniere = fichiers[fichiers.length - 1];
  const avant = fichiers[fichiers.length - 2];
  if (avant && taille(derniere) < taille(avant) / 2) return [];
  const aEffacer = fichiers.slice(0, fichiers.length - n);
  for (const f of aEffacer) fs.unlinkSync(path.join(dossier, f));
  return aEffacer;
}

module.exports = { chiffrer, dechiffrer, phraseSecrete, garderCopies, ENTETE };
