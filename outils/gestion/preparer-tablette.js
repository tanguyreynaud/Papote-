// Note une tablette préparée dans le stock de l'espace admin, d'après son n° de série Android.
//   node preparer-tablette.js --serie <ro.serialno> [--modele "M107"]
// Appelé par installation\installer-tablette.ps1 à la fin de l'installation. Prend la tablette dont la réception
// est ouverte dans l'admin (« Recevoir une tablette »), sinon celle du même n° de série, sinon la plus ancienne
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
let firestore;
try {
  firestore = require('firebase-admin/firestore');
} catch (e) {
  firestore = require(path.join(__dirname, '..', 'admin', 'node_modules', 'firebase-admin', 'lib', 'firestore'));
}
const { FieldValue, getFirestore } = firestore;
// Base : celle que désigne config/base dans la base d'origine après la bascule en Europe, sinon (default).
let db = admin.firestore();

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
  const base = (await db.doc('config/base').get()).get('database');
  if (typeof base === 'string' && base && base !== '(default)') db = getFirestore(admin.app(), base);
  const deja = await db.collection('stock').where('serieAndroid', '==', serie).limit(1).get();
  if (!deja.empty) {
    const d = deja.docs[0];
    const t = d.data();
    // Tablette revenue d'un client (ou remplacée) et réinstallée : de nouveau prête à partir.
    if (['revenue', 'en-retour'].includes(t.etat)) {
      await d.ref.update({
        etat: 'preparee', preparee: Date.now(), commande: null, fid: null, remplaceePour: FieldValue.delete(),
        historique: FieldValue.arrayUnion({ le: Date.now(), etat: 'preparee', par: 'installation' }),
        majLe: FieldValue.serverTimestamp(),
      });
      console.log(`Tablette ${t.ref || d.id} réinstallée : de nouveau « Préparée », prête à partir.`);
    } else {
      console.log(`Tablette déjà notée dans le stock : ${t.ref || d.id} (${t.etat}).`);
    }
    console.log(`>>> Écrivez ${t.ref} sur le carton.`);
    return;
  }
  const ref = await prochaineRef();
  const serieTapee = (d) => String(d.get('numero') || '').replace(/\s/g, '').toUpperCase() === serie.replace(/\s/g, '').toUpperCase();
  const enReception = (d) => !!d.get('reception') && !d.get('reception.fini');
  const libres = (await db.collection('stock').where('etat', '==', 'en-stock').get()).docs
    .filter((d) => !d.get('serieAndroid') && !d.get('commande'))
    .sort((a, b) => enReception(b) - enReception(a) || serieTapee(b) - serieTapee(a)
      || (a.get('acheteeLe')?.toMillis() || 0) - (b.get('acheteeLe')?.toMillis() || 0));
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
