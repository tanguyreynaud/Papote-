// Copie chiffrée d'une sauvegarde, pour la garder HORS du compte Google de Tanguy (clé USB, disque, 2e compte,
// autre nuage) : si le compte Google est perdu ou piraté, la copie sur G:\Mon Drive part avec lui.
// AES-256-GCM, clé tirée de la phrase secrète par scrypt (N=2^15, r=8, p=1). Sans dépendance (node:crypto).
//
// Format 1 (.json.enc, tout en mémoire) : "PAPOTE-ENC1\n" | sel 16 o | iv 12 o | étiquette GCM 16 o | données chiffrées
// Format 2 (fichiers de la sauvegarde en dossier, au fil de l'eau, sans limite de taille) :
//   "PAPOTE-ENC2\n" | sel 16 o | iv 12 o | données chiffrées | étiquette GCM 16 o
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

// ---------- Format 2 : un fichier chiffré au fil de l'eau (aucune limite de taille, peu de mémoire) ----------
const ENTETE2 = Buffer.from('PAPOTE-ENC2\n');

async function ecrireFlux(flux, morceau) {
  if (morceau.length && !flux.write(morceau)) await require('node:events').once(flux, 'drain');
}
async function fermerFlux(flux) {
  await new Promise((ok, ko) => { flux.once('error', ko); flux.end(ok); });
}

async function chiffrerFichier(source, cible, phrase) {
  const sel = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cle(phrase, sel), iv);
  c.setAAD(ENTETE2);
  const sortie = fs.createWriteStream(cible);
  await ecrireFlux(sortie, Buffer.concat([ENTETE2, sel, iv]));
  for await (const morceau of fs.createReadStream(source)) await ecrireFlux(sortie, c.update(morceau));
  await ecrireFlux(sortie, c.final());
  await ecrireFlux(sortie, c.getAuthTag());
  await fermerFlux(sortie);
}

// Déchiffre vers cible (ou nulle part si cible est null : simple contrôle). Rend { octets, sha256 } du clair.
// Mauvaise phrase ou fichier abîmé : erreur, et le fichier cible (incomplet) est effacé.
async function dechiffrerFichier(source, cible, phrase) {
  const taille = fs.statSync(source).size;
  const debut = ENTETE2.length + 28;
  const fd = fs.openSync(source, 'r');
  const tete = Buffer.alloc(debut);
  const etiquette = Buffer.alloc(16);
  try {
    fs.readSync(fd, tete, 0, debut, 0);
    if (taille < debut + 16 || !tete.subarray(0, ENTETE2.length).equals(ENTETE2)) throw new Error('Ce fichier n\'est pas une copie chiffrée de Papote (format 2).');
    fs.readSync(fd, etiquette, 0, 16, taille - 16);
  } finally { fs.closeSync(fd); }
  const d = crypto.createDecipheriv('aes-256-gcm', cle(phrase, tete.subarray(ENTETE2.length, ENTETE2.length + 16)), tete.subarray(ENTETE2.length + 16));
  d.setAAD(ENTETE2);
  d.setAuthTag(etiquette);
  const hash = crypto.createHash('sha256');
  const sortie = cible ? fs.createWriteStream(cible) : null;
  let octets = 0;
  const garder = async (morceau) => { hash.update(morceau); octets += morceau.length; if (sortie) await ecrireFlux(sortie, morceau); };
  try {
    if (taille > debut + 16) {
      for await (const morceau of fs.createReadStream(source, { start: debut, end: taille - 17 })) await garder(d.update(morceau));
    }
    try { await garder(d.final()); } catch { throw new Error('Phrase secrète incorrecte, ou fichier abîmé.'); }
    if (sortie) await fermerFlux(sortie);
  } catch (e) {
    if (sortie) {
      const ferme = sortie.closed ? null : require('node:events').once(sortie, 'close');
      sortie.destroy();
      await ferme;
      fs.rmSync(cible, { force: true });
    }
    throw e;
  }
  return { octets, sha256: hash.digest('hex') };
}

module.exports = { chiffrer, dechiffrer, phraseSecrete, garderCopies, ENTETE, chiffrerFichier, dechiffrerFichier, ENTETE2 };
