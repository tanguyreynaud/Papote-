// Note une tablette préparée dans le stock de l'espace admin, d'après son n° de série Android.
//   node preparer-tablette.js --serie <ro.serialno> [--modele "M107"]
// Appelé par installation\installer-tablette.ps1 à la fin de l'installation. Prend la plus ancienne
// tablette « en stock » pas encore préparée (entrée par une facture), ou en crée une, puis affiche
// son petit numéro (T-012) à écrire sur le carton. Au jumelage chez le client, la tablette est reconnue
// par ce n° de série et sa commande est reliée à la famille (functions/gestion.js, gestionJumelage).
// Clé d'administration : %USERPROFILE%\.papote\cle-admin-firebase.json (jamais dans le dépôt).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function argument(nom) {
  const i = process.argv.indexOf(`--${nom}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1].trim() : '';
}

const serie = argument('serie');
const modele = argument('modele');
const cle = process.env.PAPOTE_CLE_ADMIN || path.join(os.homedir(), '.papote', 'cle-admin-firebase.json');
if (!serie) {
  console.error('Usage : node preparer-tablette.js --serie <n° de série Android> [--modele <modèle>]');
  process.exit(1);
}
if (!fs.existsSync(cle)) {
  console.error(`Clé introuvable : ${cle}. La tablette n'est pas notée dans le stock.`);
  process.exit(1);
}

let admin;
try {
  admin = require('firebase-admin');
} catch (e) {
  admin = require(path.join(__dirname, '..', 'admin', 'node_modules', 'firebase-admin'));
}
admin.initializeApp({ credential: admin.credential.cert(require(cle)) });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

async function prochaineRef() {
  const ref = db.doc('gestion/compteurs');
  const n = await db.runTransaction(async (tx) => {
    const v = ((await tx.get(ref)).get('tablettes') || 0) + 1;
    tx.set(ref, { tablettes: v }, { merge: true });
    return v;
  });
  return `T-${String(n).padStart(3, '0')}`;
}

(async () => {
  const deja = await db.collection('stock').where('serieAndroid', '==', serie).limit(1).get();
  if (!deja.empty) {
    const t = deja.docs[0].data();
    console.log(`Tablette déjà notée dans le stock : ${t.ref || deja.docs[0].id} (${t.etat}).`);
    console.log(`>>> Écrivez ${t.ref} sur le carton.`);
    return;
  }
  const ref = await prochaineRef();
  const libres = (await db.collection('stock').where('etat', '==', 'en-stock').get()).docs
    .filter((d) => !d.get('serieAndroid') && !d.get('commande'))
    .sort((a, b) => (a.get('acheteeLe')?.toMillis() || 0) - (b.get('acheteeLe')?.toMillis() || 0));
  const historique = FieldValue.arrayUnion({ le: Date.now(), etat: 'preparee', par: 'installation' });
  if (libres.length) {
    const d = libres[0];
    await d.ref.update({
      ref, serieAndroid: serie, etat: 'preparee', preparee: Date.now(), historique,
      ...(modele && !d.get('modele') ? { modele } : {}), majLe: FieldValue.serverTimestamp(),
    });
    console.log(`Tablette ${ref} : fiche de l'achat ${d.get('fournisseur') || ''} du ${d.get('acheteeLe')?.toDate().toLocaleDateString('fr-FR') || '?'}.`);
  } else {
    await db.collection('stock').add({
      ref, serieAndroid: serie, numero: null, modele: modele || null, etat: 'preparee', commande: null,
      prixAchat: null, acheteeLe: null, preparee: Date.now(),
      notes: 'Créée à l\'installation : aucun achat en stock à rattacher (ajoutez la facture).',
      historique: [{ le: Date.now(), etat: 'preparee', par: 'installation' }],
      creeLe: FieldValue.serverTimestamp(),
    });
    console.log(`Tablette ${ref} ajoutée au stock (aucun achat « en stock » à rattacher : ajoutez sa facture).`);
  }
  console.log(`>>> Écrivez ${ref} sur le carton.`);
})().catch((e) => {
  console.error(`La tablette n'a pas pu être notée dans le stock : ${e.message}`);
  process.exit(1);
});
