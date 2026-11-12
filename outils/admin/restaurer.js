// Restauration d'une sauvegarde (sauvegarder.js) dans la base Firestore : chaque document est réécrit tel qu'il
// était. Ce qui a été créé depuis la sauvegarde est gardé, sauf avec --effacer (remise exacte à l'état sauvegardé).
//
//   node restaurer.js sauvegardes\papote-2026-11-08-03-00-00                : montre ce qui serait fait
//   node restaurer.js sauvegardes\papote-...  --oui                         : restaure (écrase les documents)
//   node restaurer.js sauvegardes\papote-...  --oui --effacer               : et efface ce qui n'est pas dedans
//   node restaurer.js ... --comptes                                         : restaure aussi les comptes absents
//   node restaurer.js ... --photos                                          : remet aussi les fichiers du stockage
//                                                                             (dossier fichiers à côté : gestion/,
//                                                                             et photos si copiées avec --photos)
//   node restaurer.js ... --autre-base                                      : accepte une base différente de celle
//                                                                             d'où vient la sauvegarde
// La sauvegarde est un dossier papote-<date> (format 2) ou un ancien fichier papote-<date>.json (format 1).
// Mauvaise base (audit A15-2) : la sauvegarde note la base d'où elle vient ; si la base visée (config/base ou
// --base) est une autre, la restauration est REFUSÉE, sauf --autre-base (par exemple vers une base neuve « europe2 »).
// --effacer (A34) : la liste de ce qui serait effacé est affichée, puis il faut TAPER le nom de la base visée pour
// confirmer (Entrée seule, autre chose ou fin de saisie = annulé : rien n'est fait). Sans clavier (tâche planifiée,
// script) : --confirmer-base <nom> à la place, qui doit être exactement la base visée.
// Pendant toute la restauration, les déclencheurs du serveur (e-mails, Stripe, notifications, voix) se taisent
// (drapeau interne/restauration, functions/base.js).
// Options : --base europe. --comptes : les comptes Google et anonymes reviennent tels quels ; ceux des tablettes
// (« appels ») reviennent AVEC leur mot de passe si la sauvegarde le contient (chiffré : phrase secrète demandée si
// elle n'est pas dans PAPOTE_PHRASE_SAUVEGARDE ou .papote\phrase-sauvegarde.txt) et si les paramètres de hachage sont
// connus (dans la sauvegarde, ou %USERPROFILE%\.papote\hachage-mots-de-passe.json).
// Clé d'administration : %USERPROFILE%\.papote\cle-admin-firebase.json (jamais dans le dépôt).
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('firebase-admin');
const { ouvrirBase } = require('./base');
const readline = require('readline');
const lib = require('./sauvegarde-lib');
const { restaurer, restaurerFichiers, lireSauvegarde } = lib;
const { phraseSecrete } = require('./chiffrement');
const BUCKET = process.env.BUCKET_STORAGE || 'papote-famille-eu';

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const valeurs = new Set(['--base', '--confirmer-base'].map((o) => process.argv.indexOf(o) + 1).filter((i) => i > 0));
const chemin = process.argv.slice(2).find((a, i) => !a.startsWith('--') && !valeurs.has(i + 2));
const keyPath = process.env.PAPOTE_CLE_ADMIN || path.join(os.homedir(), '.papote', 'cle-admin-firebase.json');
if (!chemin || !fs.existsSync(chemin)) {
  console.error('Usage : restaurer.bat <dossier papote-date | ancien fichier .json> [--oui] [--effacer] [--comptes] [--photos] [--base europe] [--autre-base] [--confirmer-base europe]');
  process.exit(1);
}
if (!fs.existsSync(keyPath)) {
  console.error(`Clé introuvable : ${keyPath}`);
  process.exit(1);
}
if (option('base', null)) process.env.PAPOTE_BASE = option('base', null);
const oui = process.argv.includes('--oui');
const effacer = process.argv.includes('--effacer');
const comptes = process.argv.includes('--comptes');
const photos = process.argv.includes('--photos');
const autreBase = process.argv.includes('--autre-base');

// Une ligne tapée au clavier (ou reçue sur l'entrée) ; fin de saisie = ''. Rien n'est choisi à la place de Tanguy.
function demander(question) {
  return new Promise((ok) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    let reponse = null;
    process.stdout.write(question);
    rl.once('line', (l) => { reponse = l; rl.close(); });
    rl.once('close', () => ok((reponse || '').trim()));
  });
}

(async () => {
  const sauvegarde = await lireSauvegarde(chemin);
  const cle = require(keyPath);
  console.log(`Sauvegarde du ${sauvegarde.le} (projet ${sauvegarde.projet}, base « ${sauvegarde.base} ») : ${sauvegarde.nbDocuments} documents, ${sauvegarde.comptes.length} comptes.`);
  if (sauvegarde.projet && sauvegarde.projet !== cle.project_id) {
    console.error(`Elle vient du projet ${sauvegarde.projet}, la clé est celle de ${cle.project_id} : arrêt.`);
    process.exit(1);
  }
  const app = admin.initializeApp({ credential: admin.credential.cert(cle) });
  const db = await ouvrirBase(app);
  const cible = db.databaseId || '(default)';
  if (sauvegarde.base !== cible) {
    console.log(`ATTENTION : elle vient de la base « ${sauvegarde.base || 'inconnue'} » et irait dans « ${cible} ».`);
    if (!autreBase) {
      console.error('Restauration refusée. Vérifier config/base ou --base ; pour le faire exprès, ajouter --autre-base.');
      process.exit(1);
    }
  }
  let familles = 0;
  for await (const d of sauvegarde.documents) if (/^families\/[^/]+$/.test(d.chemin)) familles++;
  console.log(`Vers la base « ${cible} » : ${familles} familles, ${effacer ? 'AVEC effacement de tout ce qui n\'est pas dans la sauvegarde' : 'sans effacement du reste'}, ${comptes ? 'avec' : 'sans'} les comptes.`);
  if (effacer) {
    const aEffacer = await lib.cheminsAEffacer(db, sauvegarde);
    const familles = aEffacer.filter((c) => /^families\/[^/]+$/.test(c)).length;
    const commandes = aEffacer.filter((c) => /^commandes\/[^/]+$/.test(c)).length;
    console.log('');
    console.log('==================== ATTENTION : --effacer ====================');
    console.log(`${aEffacer.length} document(s) de la base « ${cible} » ne sont pas dans la sauvegarde et seront EFFACÉS`);
    console.log(`(dont ${familles} famille(s) et ${commandes} commande(s)) : tout ce qui a été créé depuis le ${sauvegarde.le}.`);
    aEffacer.slice(0, 10).forEach((c) => console.log(`  - ${c}`));
    if (aEffacer.length > 10) console.log(`  … et ${aEffacer.length - 10} autre(s).`);
    console.log('Ils ne reviendront qu\'avec une autre sauvegarde. Les tablettes de ces familles quitteront leur famille.');
    console.log('===============================================================');
  }
  if (!oui) {
    console.log('Rien n\'a été fait. Relancer avec --oui pour restaurer.');
    process.exit(0);
  }
  if (effacer) {
    const donnee = option('confirmer-base', null);
    const tape = donnee !== null ? donnee : await demander(`Pour confirmer, tapez le nom de la base (${cible}) puis Entrée ; Entrée seule pour annuler : `);
    if (tape !== cible) {
      console.error(`${tape ? `« ${tape} » n'est pas « ${cible} »` : 'Rien de tapé'} : restauration ANNULÉE, rien n'a été changé.`);
      process.exit(1);
    }
  }
  let phrase = null;
  if (comptes && sauvegarde.fichierMotsDePasse) {
    phrase = phraseSecrete() || await demander('Phrase secrète des sauvegardes (mots de passe des tablettes) : ');
  }
  const hachage = lib.lireHachage(path.join(os.homedir(), '.papote', 'hachage-mots-de-passe.json'));
  console.log('Pause d\'une minute avant la première écriture (les fonctions du serveur voient la restauration commencer)…');
  const r = await restaurer({
    db, auth: comptes ? admin.auth(app) : null, sauvegarde, effacer, autreBase, phrase, hachage,
    progression: (n) => process.stdout.write(`\r${n} documents écrits`),
  });
  process.stdout.write('\n');
  console.log(`Restauré : ${r.documents} documents${effacer ? `, ${r.effaces} effacé(s)` : ''}, ${r.comptes} comptes remis${r.dejaLa ? ` (${r.dejaLa} déjà là, laissés tels quels)` : ''}${r.avecMotDePasse ? ` (dont ${r.avecMotDePasse} avec leur mot de passe)` : ''}.`);
  if (r.sansMotDePasse) console.log(`ATTENTION : ${r.sansMotDePasse} compte(s) de tablette remis SANS mot de passe (pas dans la sauvegarde, ou paramètres de hachage absents) : leurs appels vidéo ne marcheront plus avant une réinstallation.`);
  if (photos) {
    const f = await restaurerFichiers({
      bucket: admin.storage(app).bucket(BUCKET), dossier: sauvegarde.dossierFichiers,
      progression: (n, total) => process.stdout.write(`\r${n} / ${total} fichiers remis`),
    });
    if (f.total) process.stdout.write('\n');
    console.log(`Fichiers du stockage : ${f.remis} fichier(s) remis dans ${BUCKET}.`);
  }
  process.exit(0);
})().catch((e) => {
  console.error('Restauration impossible :', e.message);
  process.exit(1);
});
