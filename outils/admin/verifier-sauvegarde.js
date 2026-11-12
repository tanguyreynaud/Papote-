// Vérifie qu'une sauvegarde se relit vraiment : restauration à blanc dans l'émulateur Firestore (rien ne touche la
// vraie base), relecture, comparaison document par document avec la sauvegarde, puis contrôle des fichiers du
// stockage copiés (fichiers/index.json : chaque fichier présent et intact). À lancer une fois par mois :
//   .\verifier-sauvegarde.bat sauvegardes\papote-2026-11-08-03-00-00      (dossier, format 2)
//   .\verifier-sauvegarde.bat sauvegardes\papote-2026-11-01-03-00-00.json (ancien fichier, format 1)
// (verifier-sauvegarde.bat lance l'émulateur ; ce script tourne dedans et ne sait pas se lancer seul.)
// Les documents sont relus ligne à ligne et comparés par empreinte : une grosse base ne tient pas en mémoire.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const lib = require('./sauvegarde-lib');

const chemin = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!chemin || !fs.existsSync(chemin)) { console.error('Usage : verifier-sauvegarde.bat <dossier papote-date | fichier .json>'); process.exit(1); }
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('À lancer par verifier-sauvegarde.bat (émulateur).'); process.exit(1); }

const empreinte = (donnees) => crypto.createHash('sha1').update(JSON.stringify(donnees)).digest('base64');

(async () => {
  const sauvegarde = await lib.lireSauvegarde(chemin);
  const app = admin.initializeApp({ projectId: 'demo-papote' });
  const db = getFirestore(app, 'europe');
  console.log(`Sauvegarde du ${sauvegarde.le} (projet ${sauvegarde.projet}, base « ${sauvegarde.base} ») : ${sauvegarde.nbDocuments} documents, ${sauvegarde.comptes.length} comptes.`);
  const soucis = [];

  // Émulateur : la base d'origine n'a pas d'importance ici (--autre-base).
  const r = await lib.restaurer({ db, sauvegarde, autreBase: true, attenteDebut: 0, progression: (n) => process.stdout.write(`\r${n} documents restaurés dans l'émulateur`) });
  process.stdout.write('\n');
  const relus = new Map();
  await lib.parcourir(db, (d) => { relus.set(d.chemin, empreinte(d.donnees)); });
  const ignores = new Set(['interne/restauration', 'interne/sauvegarde']);
  let total = 0;
  let aRestaurer = 0;
  let differents = 0;
  const motifs = {
    familles: /^families\/[^/]+$/, proches: /^families\/[^/]+\/members\/[^/]+$/, envois: /^families\/[^/]+\/posts\/[^/]+$/,
    rappels: /^families\/[^/]+\/reminders\/[^/]+$/, stock: /^stock\/[^/]+$/, commandes: /^commandes\/[^/]+$/,
  };
  const compte = Object.fromEntries(Object.keys(motifs).map((k) => [k, 0]));
  const attendus = [];
  for await (const d of sauvegarde.documents) {
    total++;
    for (const [k, m] of Object.entries(motifs)) if (m.test(d.chemin)) compte[k]++;
    const donnees = d.donnees || {};
    attendus.push(...[donnees.storagePath, ...(donnees.photos || []).map((p) => p && p.storagePath)].filter((p) => typeof p === 'string'));
    if (ignores.has(d.chemin)) continue;
    aRestaurer++;
    if (relus.get(d.chemin) !== empreinte(d.donnees)) { differents++; if (differents <= 3) soucis.push(`Document différent après relecture : ${d.chemin}`); }
  }
  if (differents > 3) soucis.push(`… et ${differents - 3} autres documents différents`);
  if (total !== sauvegarde.nbDocuments) soucis.push(`${total} documents relus pour ${sauvegarde.nbDocuments} annoncés`);
  if (r.documents !== aRestaurer) soucis.push(`${r.documents} documents restaurés sur ${aRestaurer}`);

  console.log(`Relu : ${total} documents, tous identiques : ${differents === 0 ? 'oui' : 'NON'}.`);
  console.log(`  ${compte.familles} familles, ${compte.proches} proches et tablettes, ${compte.envois} envois (photos, vidéos, messages), ${compte.rappels} rappels, ${compte.stock} tablettes en stock, ${compte.commandes} commandes.`);
  console.log(`  ${sauvegarde.comptes.length} comptes (dont ${sauvegarde.comptes.filter((c) => c.customClaims && c.customClaims.admin).length} administrateur(s)).`);

  const dossierFichiers = sauvegarde.dossierFichiers;
  if (fs.existsSync(path.join(dossierFichiers, 'index.json'))) {
    const index = JSON.parse(fs.readFileSync(path.join(dossierFichiers, 'index.json'), 'utf8'));
    const v = await lib.verifierFichiers(dossierFichiers);
    const gestion = Object.keys(index).filter((c) => c.startsWith(lib.PREFIXE_GESTION)).length;
    console.log(`Fichiers du stockage : ${v.total} dans la copie (dont ${gestion} pièces de gestion/), ${v.manquants.length} manquant(s), ${v.abimes.length} abîmé(s).`);
    if (v.manquants.length) soucis.push(`Fichiers manquants : ${v.manquants.slice(0, 5).join(', ')}${v.manquants.length > 5 ? '…' : ''}`);
    if (v.abimes.length) soucis.push(`Fichiers abîmés : ${v.abimes.slice(0, 5).join(', ')}${v.abimes.length > 5 ? '…' : ''}`);
    if (sauvegarde.entete && sauvegarde.entete.gestion && gestion < sauvegarde.entete.gestion.fichiers) {
      soucis.push(`${gestion} pièces de gestion/ dans la copie pour ${sauvegarde.entete.gestion.fichiers} notées par la sauvegarde`);
    }
    // Photos copiées (--photos) : chaque envoi avec fichier de la base a bien sa copie.
    const avecPhotos = Object.keys(index).some((c) => !c.startsWith(lib.PREFIXE_GESTION));
    if (avecPhotos) {
      const sansCopie = attendus.filter((p) => !index[p]);
      if (sansCopie.length) soucis.push(`${sansCopie.length} envoi(s) de la base sans fichier dans la copie (ex. ${sansCopie[0]})`);
      else console.log(`  Les ${attendus.length} fichiers cités par la base sont dans la copie.`);
    } else {
      console.log('  Photos et vidéos : pas copiées (normal : protégées par la suppression douce du bucket, voir RESTAURER-UN-FICHIER.md).');
    }
  } else {
    console.log('Fichiers du stockage : pas de copie à côté de cette sauvegarde.');
  }

  const age = (Date.now() - new Date(sauvegarde.le).getTime()) / 86_400_000;
  if (age > 10) soucis.push(`Sauvegarde vieille de ${Math.round(age)} jours : la tâche hebdomadaire tourne-t-elle ? (journal.txt)`);

  if (soucis.length) { console.log('\nPROBLÈMES :'); soucis.forEach((x) => console.log(`  - ${x}`)); process.exit(1); }
  console.log('\nSauvegarde VÉRIFIÉE : elle se restaure à l\'identique.');
  process.exit(0);
})().catch((e) => { console.error('Vérification impossible :', e.message); process.exit(1); });
