// Note une tablette préparée dans le stock de l'espace admin, d'après son n° de série Android.
//   node preparer-tablette.js --serie <ro.serialno> [--modele "M107"] [--achat <id de la fiche choisie>]
// Code de sortie 3 : plusieurs achats possibles, une ligne « CHOIX<tab>id<tab>libellé » par achat ; l'installation
// demande lequel (la boîte qu'on a en main) puis relance avec --achat <id>.
// Appelé par installation\installer-tablette.ps1 à la fin de l'installation. Prend la tablette dont la réception
// est ouverte dans l'admin (« Recevoir une tablette »), sinon celle du même n° de série, sinon la plus ancienne
// tablette « en stock » pas encore préparée, puis une « commandée » (notée reçue au passage), ou en crée une, puis affiche
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

// Achat d'une fiche : la dépense qui l'a créée, sinon vendeur + date + prix (tablettes d'un même achat ensemble).
const cleAchat = (d) => d.get('depense') || [d.get('fournisseur'), d.get('acheteeLe')?.toMillis?.() || '', d.get('prixAchat') ?? ''].join('|');
const depenses = new Map();
async function libelleAchat(d) {
  const id = d.get('depense');
  if (id && !depenses.has(id)) depenses.set(id, (await db.doc(`depenses/${id}`).get()).data() || {});
  const dep = (id && depenses.get(id)) || {};
  const prix = d.get('prixAchat');
  return [d.get('modele') || 'Tablette', dep.fournisseur || d.get('fournisseur') || 'vendeur ?',
    dep.numero ? `commande n° ${dep.numero}` : null,
    d.get('acheteeLe') ? `achetée le ${d.get('acheteeLe').toDate().toLocaleDateString('fr-FR')}` : null,
    prix != null ? `${(prix / 100).toFixed(2).replace('.', ',')} €` : null].filter(Boolean).join(' · ');
}
const memeModele = (a, b) => {
  const n = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return !n(a) || !n(b) || n(a).includes(n(b)) || n(b).includes(n(a));
};

// Quelle fiche d'achat est cette tablette ? Celle ouverte dans « Recevoir une tablette », sinon celle dont le n° de
// série a été tapé, sinon (même modèle) : un seul achat possible → sa plus ancienne fiche ; plusieurs achats →
// --achat <id> s'il est donné, sinon la liste « CHOIX » est affichée et rien n'est noté (renvoie undefined) :
// on ne devine jamais, pour savoir quelle tablette renvoyer à quel vendeur.
// Renvoie la fiche, null s'il n'y a aucun achat libre, undefined si la question est posée.
async function choisir(libres, serieTapee, enReception) {
  const sure = libres.find(enReception) || libres.find(serieTapee);
  if (sure) return sure;
  if (argument('achat')) {
    const d = libres.find((x) => x.id === argument('achat'));
    if (!d) throw new Error('cet achat n\'est plus libre, relancez l\'installation.');
    return d;
  }
  const possibles = libres.filter((d) => memeModele(d.get('modele'), modele));
  const parAchat = new Map();
  for (const d of (possibles.length ? possibles : libres)) if (!parAchat.has(cleAchat(d))) parAchat.set(cleAchat(d), d);
  if (parAchat.size <= 1) return [...parAchat.values()][0] || null;
  const restantes = (d) => libres.filter((x) => cleAchat(x) === cleAchat(d)).length;
  for (const d of parAchat.values()) console.log(`CHOIX\t${d.id}\t${await libelleAchat(d)} (${restantes(d)} pas encore installée${restantes(d) > 1 ? 's' : ''})`);
  process.exitCode = 3;
  return undefined;
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
  const serieTapee = (d) => String(d.get('numero') || '').replace(/\s/g, '').toUpperCase() === serie.replace(/\s/g, '').toUpperCase();
  const enReception = (d) => !!d.get('reception') && !d.get('reception.fini');
  // Une tablette achetée mais pas encore notée « reçue » (« Commandée ») compte aussi : l'installer prouve
  // qu'elle est arrivée. Celles déjà « En stock » passent d'abord.
  const commandee = (d) => d.get('etat') === 'commandee';
  const acheteeLe = (d) => d.get('acheteeLe')?.toMillis?.() || 0;
  const libres = (await db.collection('stock').where('etat', 'in', ['en-stock', 'commandee']).get()).docs
    .filter((d) => !d.get('serieAndroid') && !d.get('commande'))
    .sort((a, b) => commandee(a) - commandee(b) || acheteeLe(a) - acheteeLe(b));
  const choisie = await choisir(libres, serieTapee, enReception);
  if (choisie === undefined) return; // Plusieurs achats possibles : la liste est affichée, l'installation demande lequel.
  const ref = await prochaineRef();
  const maintenant = Date.now();
  const historique = FieldValue.arrayUnion({ le: maintenant, etat: 'preparee', par: 'installation' });
  if (choisie) {
    const d = choisie;
    await d.ref.update({
      ref, serieAndroid: serie, etat: 'preparee', preparee: maintenant,
      historique: commandee(d)
        ? FieldValue.arrayUnion({ le: maintenant - 1, etat: 'en-stock', par: 'installation', motif: 'reçue' }, { le: maintenant, etat: 'preparee', par: 'installation' })
        : historique,
      // Le n° de série lu par l'installation sert de n° de série s'il n'a pas été tapé à la réception.
      ...(d.get('numero') ? {} : { numero: serie }),
      ...(modele && !d.get('modele') ? { modele } : {}), majLe: FieldValue.serverTimestamp(),
    });
    console.log(`Tablette ${ref} : ${await libelleAchat(d)}.`);
  } else {
    await db.collection('stock').add({
      ref, serieAndroid: serie, numero: serie, modele: modele || null, etat: 'preparee', commande: null,
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
