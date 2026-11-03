// Vérifie qu'une sauvegarde se relit vraiment : restauration à blanc dans l'émulateur Firestore (rien ne touche la
// vraie base), relecture, comparaison document par document avec le fichier, puis contrôle des photos et vidéos
// copiées (fichiers/index.json : chaque fichier présent et intact). À lancer une fois par mois :
//   .\verifier-sauvegarde.bat sauvegardes\papote-2026-11-02-03-00-00.json
// (verifier-sauvegarde.bat lance l'émulateur ; ce script tourne dedans et ne sait pas se lancer seul.)
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const lib = require('./sauvegarde-lib');

const fichier = process.argv.slice(2).find((a) => a.endsWith('.json'));
if (!fichier || !fs.existsSync(fichier)) { console.error('Usage : verifier-sauvegarde.bat <sauvegarde.json>'); process.exit(1); }
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('À lancer par verifier-sauvegarde.bat (émulateur).'); process.exit(1); }

(async () => {
  const sauvegarde = JSON.parse(fs.readFileSync(fichier, 'utf8'));
  const app = admin.initializeApp({ projectId: 'demo-papote' });
  const db = getFirestore(app, 'europe');
  console.log(`Sauvegarde du ${sauvegarde.le} (projet ${sauvegarde.projet}, base « ${sauvegarde.base} ») : ${sauvegarde.documents.length} documents, ${sauvegarde.comptes.length} comptes.`);
  const soucis = [];

  const r = await lib.restaurer({ db, sauvegarde, progression: (n) => process.stdout.write(`\r${n} documents restaurés dans l'émulateur`) });
  process.stdout.write('\n');
  const relus = await lib.toutLire(db);
  if (r.documents !== sauvegarde.documents.length) soucis.push(`${r.documents} documents restaurés sur ${sauvegarde.documents.length}`);
  const parChemin = new Map(relus.map((d) => [d.chemin, JSON.stringify(d.donnees)]));
  let differents = 0;
  for (const d of sauvegarde.documents) {
    if (parChemin.get(d.chemin) !== JSON.stringify(d.donnees)) { differents++; if (differents <= 3) soucis.push(`Document différent après relecture : ${d.chemin}`); }
  }
  if (differents > 3) soucis.push(`… et ${differents - 3} autres documents différents`);

  const compte = (motif) => sauvegarde.documents.filter((d) => motif.test(d.chemin)).length;
  console.log(`Relu : ${relus.length} documents, tous identiques : ${differents === 0 ? 'oui' : 'NON'}.`);
  console.log(`  ${compte(/^families\/[^/]+$/)} familles, ${compte(/^families\/[^/]+\/members\/[^/]+$/)} proches et tablettes, ${compte(/^families\/[^/]+\/posts\/[^/]+$/)} envois (photos, vidéos, messages), ${compte(/^families\/[^/]+\/reminders\/[^/]+$/)} rappels, ${compte(/^stock\/[^/]+$/)} tablettes en stock, ${compte(/^commandes\/[^/]+$/)} commandes.`);
  console.log(`  ${sauvegarde.comptes.length} comptes (dont ${sauvegarde.comptes.filter((c) => c.customClaims && c.customClaims.admin).length} administrateur(s)).`);

  const dossierFichiers = path.join(path.dirname(fichier), 'fichiers');
  if (fs.existsSync(path.join(dossierFichiers, 'index.json'))) {
    const v = await lib.verifierFichiers(dossierFichiers);
    console.log(`Photos et vidéos : ${v.total} fichiers dans la copie, ${v.manquants.length} manquant(s), ${v.abimes.length} abîmé(s).`);
    if (v.manquants.length) soucis.push(`Fichiers manquants : ${v.manquants.slice(0, 5).join(', ')}${v.manquants.length > 5 ? '…' : ''}`);
    if (v.abimes.length) soucis.push(`Fichiers abîmés : ${v.abimes.slice(0, 5).join(', ')}${v.abimes.length > 5 ? '…' : ''}`);
    // Chaque envoi avec fichier de la base a bien sa copie.
    const attendus = sauvegarde.documents.flatMap((d) => [d.donnees && d.donnees.storagePath, ...((d.donnees && d.donnees.photos) || []).map((p) => p && p.storagePath)]).filter((p) => typeof p === 'string');
    const index = JSON.parse(fs.readFileSync(path.join(dossierFichiers, 'index.json'), 'utf8'));
    const sansCopie = attendus.filter((p) => !index[p]);
    if (sansCopie.length) soucis.push(`${sansCopie.length} envoi(s) de la base sans fichier dans la copie (ex. ${sansCopie[0]})`);
    else console.log(`  Les ${attendus.length} fichiers cités par la base sont dans la copie.`);
  } else {
    console.log('Photos et vidéos : pas de dossier fichiers à côté de la sauvegarde (sauvegarde faite avec --sans-photos ?).');
  }

  const age = (Date.now() - new Date(sauvegarde.le).getTime()) / 86_400_000;
  if (age > 10) soucis.push(`Sauvegarde vieille de ${Math.round(age)} jours : la tâche hebdomadaire tourne-t-elle ? (journal.txt)`);

  if (soucis.length) { console.log('\nPROBLÈMES :'); soucis.forEach((x) => console.log(`  - ${x}`)); process.exit(1); }
  console.log('\nSauvegarde VÉRIFIÉE : elle se restaure à l\'identique.');
  process.exit(0);
})().catch((e) => { console.error('Vérification impossible :', e.message); process.exit(1); });
