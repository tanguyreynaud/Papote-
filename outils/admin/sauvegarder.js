// Sauvegarde de la base Firestore de Papote (et de la liste des comptes, et des pièces de gestion du stockage), à
// garder hors du PC (clé USB, disque). Chaque dimanche par la tâche Windows, et avant toute manipulation risquée.
//
//   node sauvegarder.js                      : écrit sauvegardes\papote-<date>\ à côté de ce script
//   node sauvegarder.js --vers D:\sauvegardes : dans ce dossier
//   node sauvegarder.js --base europe        : force la base (sinon config/base, comme les autres outils)
//   node sauvegarder.js --photos             : copie aussi les photos et vidéos dans <dossier>\fichiers (seulement ce
//                                              qui est nouveau ou a changé). Par défaut, seul le dossier gestion/ du
//                                              stockage est copié (factures de vente, livres, pièces d'achat : quelques
//                                              Mo) ; les photos sont protégées par la suppression douce du bucket
//                                              (7 jours), voir RESTAURER-UN-FICHIER.md.
//   node sauvegarder.js --garder 4           : nombre de sauvegardes complètes gardées (4 par défaut ; 0 = tout garder)
//   node sauvegarder.js --auto               : lancé par la tâche planifiée (voir installer-sauvegarde-hebdo.bat)
//   node sauvegarder.js --copie E:\Papote     : écrit AUSSI une copie chiffrée (AES-256) dans ce dossier, hors du
//                                              compte Google (clé USB, disque, dossier d'un autre nuage) ; 12 copies
//                                              gardées. Phrase : PAPOTE_PHRASE_SAUVEGARDE ou
//                                              %USERPROFILE%\.papote\phrase-sauvegarde.txt (voir chiffrement.js).
//                                              Relire : dechiffrer-sauvegarde.bat E:\Papote\papote-<date>
//
// Format (12/11, audit N2 et A15-3) : un dossier par sauvegarde, un document par ligne (sauvegarde-lib.js,
// ecrireSauvegarde) : plus de limite de taille. Écrite d'abord en papote-<date>.en-cours, relue et contrôlée, puis
// renommée ; les anciennes ne sont effacées qu'après ce contrôle, et jamais la dernière sauvegarde « pleine ».
// Réussite : interne/sauvegarde (base) reçoit la date ; le serveur prévient Papote si elle a plus de 8 jours
// (functions/sauvegarde-alerte.js, e-mail et ligne « À faire »). Échec : la date et le message de l'échec y sont notés.
//
// Coût : une lecture Firestore par document et une par document pour chercher ses sous-collections ; le dossier
// gestion/ : une liste et un téléchargement par fichier nouveau. Taille : environ 24 Mo par famille pleine (aperçus
// des photos dans la base) ; 4 sauvegardes gardées.
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('firebase-admin');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { ouvrirBase } = require('./base');
const lib = require('./sauvegarde-lib');
const { phraseSecrete } = require('./chiffrement');
const BUCKET = process.env.BUCKET_STORAGE || 'papote-famille-eu';

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const keyPath = process.env.PAPOTE_CLE_ADMIN || path.join(os.homedir(), '.papote', 'cle-admin-firebase.json');
if (!fs.existsSync(keyPath)) {
  console.error(`Clé introuvable : ${keyPath}`);
  process.exit(1);
}
if (option('base', null)) process.env.PAPOTE_BASE = option('base', null);
const dossier = option('vers', path.join(__dirname, 'sauvegardes'));
const photos = process.argv.includes('--photos');
let db = null;

(async () => {
  const cle = require(keyPath);
  const app = admin.initializeApp({ credential: admin.credential.cert(cle) });
  db = await ouvrirBase(app);
  const base = db.databaseId || '(default)';
  const config = await getFirestore(app).doc('config/base').get().catch(() => null);
  console.log(`Base « ${base} » du projet ${cle.project_id} : lecture…`);
  const s = await lib.ecrireSauvegarde({
    db, auth: admin.auth(app), bucket: admin.storage(app).bucket(BUCKET), dossier, projet: cle.project_id, base,
    configBase: config && config.exists ? config.get('database') || null : null, photos,
    garder: Number(option('garder', 4)),
    progression: (n) => process.stdout.write(`\r${n} documents lus`),
    progressionFichiers: (n, total) => process.stdout.write(`\r${n} / ${total} fichiers copiés`),
  });
  process.stdout.write('\n');
  const e = s.entete;
  const mo = (o) => Math.round(o / 1024 / 1024);
  console.log(`Sauvegarde écrite et relue : ${s.dossier} (${e.documents.lignes} documents, ${e.comptes.lignes} comptes, ${mo(e.documents.octets)} Mo).`);
  console.log(`Stockage : ${e.gestion.fichiers} pièce(s) de gestion/ dans la copie (${e.gestion.nouveaux} nouvelle(s))${photos ? ', photos et vidéos comprises' : ''}, dans ${path.join(dossier, 'fichiers')}.`);
  if (s.effacees.length) console.log(`Anciennes sauvegardes effacées : ${s.effacees.join(', ')}.`);
  await db.doc('interne/sauvegarde').set({
    derniereReussie: Timestamp.now(), nom: s.nom, base, documents: e.documents.lignes, comptes: e.comptes.lignes,
    octets: e.documents.octets, fichiersGestion: e.gestion.fichiers, erreur: null,
  }, { merge: true });

  const copie = option('copie', null);
  if (copie) {
    // Pas de phrase, ou dossier absent (clé USB débranchée) : la sauvegarde principale est faite, on le dit
    // clairement et on sort en erreur pour que le journal le montre.
    const phrase = phraseSecrete();
    if (!phrase) throw new Error('copie chiffrée NON faite : phrase secrète introuvable (PAPOTE_PHRASE_SAUVEGARDE ou .papote\\phrase-sauvegarde.txt).');
    if (!fs.existsSync(copie)) throw new Error(`copie chiffrée NON faite : dossier ${copie} introuvable (clé USB branchée ?).`);
    const c = await lib.copierChiffre({ source: s.dossier, racine: copie, phrase, fichiers: path.join(dossier, 'fichiers') });
    await db.doc('interne/sauvegarde').set({ copieChiffree: Timestamp.now() }, { merge: true });
    console.log(`Copie chiffrée hors Google, relue : ${c.dossier} (${c.fichiers} pièce(s) nouvelle(s))${c.effacees.length ? ` ; anciennes effacées : ${c.effacees.join(', ')}` : ''}.`);
  }
  console.log('À garder hors du PC (clé USB, disque). Vérifier une fois par mois : verifier-sauvegarde.bat <dossier papote-date>.');
  process.exit(0);
})().catch(async (e) => {
  console.error('Sauvegarde impossible :', e.message);
  // Noté dans la base quand c'est possible (l'admin et l'alerte des 8 jours le montrent) ; la date de la dernière
  // réussie n'est pas touchée.
  if (db) {
    await db.doc('interne/sauvegarde').set({ dernierEchec: Timestamp.now(), erreur: String(e.message).slice(0, 300) }, { merge: true }).catch(() => null);
  }
  process.exit(1);
});
