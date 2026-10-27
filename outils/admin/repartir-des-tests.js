// Ménage avant la mise en vente : efface tout ce que les essais ont créé, pour refaire le parcours complet
// (réception → installation → commande → envoi → réception → mise en service) sur une base propre.
//
//   repartir-des-tests.bat                        : montre ce qui serait effacé ou remis à zéro
//   repartir-des-tests.bat --oui                  : le fait (IRRÉVERSIBLE)
//   --a-recevoir T-003                            : cette tablette revient « Commandée, pas encore reçue »
//   --garder <fid>,<fid>                          : familles à ne pas effacer
//   --effacer-tablettes T-001,T-002               : fiches de stock effacées (leurs achats restent en compta)
//   --relier T-003                                : la tablette reprend la fiche de son achat « Commandée »
//                                                   (prix, date, dépense) ; la fiche de l'achat disparaît
//
// Avant tout changement, une sauvegarde JSON de tout ce qui est effacé ou modifié (documents et
// sous-collections, sans les fichiers photo et vidéo) est écrite dans %USERPROFILE%\.papote\.
//
// Effacé : commandes, familles (avec leurs messages, photos, vidéos, membres…), codes famille (invites),
// jumelages (pairings), réservations et paniers du site.
// Stripe (mode TEST seulement, clé demandée au clavier ou variable STRIPE_SECRET, jamais écrite) : les
// abonnements des commandes sont arrêtés et leurs clients effacés, AVANT la base (le webhook pourrait
// sinon recréer une commande). Entrée sans clé : Stripe n'est pas touché.
// Gardé : achats, dépenses, stock (délié de ses commandes et familles), cartes SIM, accessoires, réglages,
// clés des tablettes, comptes de connexion.
// Clé d'administration : %USERPROFILE%\.papote\cle-admin-firebase.json (jamais dans le dépôt).
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const { ouvrirBase } = require('./base');

function option(nom) {
  const i = process.argv.indexOf(`--${nom}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1].trim() : '';
}

const cle = process.env.PAPOTE_CLE_ADMIN || path.join(os.homedir(), '.papote', 'cle-admin-firebase.json');
const confirme = process.argv.includes('--oui');
const aRecevoir = option('a-recevoir').split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);
const garder = new Set(option('garder').split(',').map((f) => f.trim()).filter(Boolean));
const aEffacer = option('effacer-tablettes').split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);
const aRelier = option('relier').trim().toUpperCase();
const BUCKET = process.env.BUCKET_STORAGE || 'papote-famille-eu';
// Une tablette chez un client de test redevient prête à partir.
const ETATS_CLIENT = ['envoyee', 'chez-client', 'en-retour'];

if (!fs.existsSync(cle)) {
  console.error(`Clé introuvable : ${cle}`);
  process.exit(1);
}
const app = admin.initializeApp({ credential: admin.credential.cert(require(cle)) });

function demander(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((ok) => rl.question(question, (r) => { rl.close(); ok(r.trim()); }));
}

function stripeTest() {
  let Stripe;
  try {
    Stripe = require('stripe');
  } catch (e) {
    Stripe = require(path.join(__dirname, '..', 'stripe', 'node_modules', 'stripe'));
  }
  return Stripe;
}

// Document et toutes ses sous-collections, pour la sauvegarde.
async function copie(ref) {
  const snap = await ref.get();
  const sous = {};
  for (const c of await ref.listCollections()) {
    sous[c.id] = {};
    for (const d of (await c.get()).docs) sous[c.id][d.id] = await copie(d.ref);
  }
  return { donnees: snap.exists ? snap.data() : null, ...(Object.keys(sous).length ? { sous } : {}) };
}

// Fiche créée par l'installation faute d'achat (sans prix, sans date, sans dépense) : un doublon de la fiche
// de l'achat, qui disparaît plutôt que de revenir « Commandée ».
const sansAchat = (t) => t.prixAchat == null && !t.acheteeLe && !t.depense;

async function main() {
  const db = await ouvrirBase(app);
  const [commandes, familles, invites, pairings, reservations, paniers, stock] = await Promise.all(
    ['commandes', 'families', 'invites', 'pairings', 'reservations', 'paniers', 'stock'].map((c) => db.collection(c).get()));
  const famillesAEffacer = familles.docs.filter((d) => !garder.has(d.id));
  const commandesAEffacer = commandes.docs.filter((d) => !garder.has(d.get('fid')));

  console.log(`Base : ${db.databaseId || '(default)'}\n`);
  console.log(`Commandes à effacer : ${commandesAEffacer.length}`);
  for (const d of commandesAEffacer) console.log(`  ${d.get('code') || d.id} · ${d.get('nom') || d.get('email') || '?'} · ${d.get('expedition') || '?'}`);
  console.log(`Familles à effacer : ${famillesAEffacer.length}${garder.size ? ` (gardées : ${[...garder].join(', ')})` : ''}`);
  for (const d of famillesAEffacer) {
    const [membres, posts] = await Promise.all([d.ref.collection('members').get(), d.ref.collection('posts').get()]);
    const proches = membres.docs.filter((m) => m.get('role') === 'famille').map((m) => m.get('name') || '?');
    console.log(`  ${d.get('name') || '?'} (${d.id}) · abonnement ${d.get('abonnement.statut') || 'aucun'} · ${posts.size} photo(s)/vidéo(s)/message(s) · proches : ${proches.join(', ') || 'aucun'}`);
  }
  console.log(`Codes famille : ${invites.size} · jumelages : ${pairings.size} · réservations : ${reservations.size} · paniers : ${paniers.size}`);

  // Stock : déliée des commandes et familles effacées ; tablettes --a-recevoir revenues « Commandée ».
  const effacees = new Set(famillesAEffacer.map((d) => d.id));
  const cmdEffacees = new Set(commandesAEffacer.map((d) => d.id));
  const changements = [];
  for (const d of stock.docs) {
    const t = d.data();
    const nom = t.ref || t.numero || d.id;
    if (t.ref && aRecevoir.includes(t.ref.toUpperCase())) {
      if (sansAchat(t)) changements.push({ d, texte: `${nom} : fiche créée à l'installation sans achat, effacée (la fiche de l'achat reste « Commandée »)`, effacer: true });
      else {
        changements.push({ d, texte: `${nom} : revient « Commandée, pas encore reçue » (sans T-0…, sans n° de série)`, maj: {
          etat: 'commandee', ref: FieldValue.delete(), serieAndroid: FieldValue.delete(), preparee: FieldValue.delete(),
          reception: FieldValue.delete(), commande: null, fid: null, tabletUid: null, callsUid: null, alerteJumelage: null,
          jumeleeLe: FieldValue.delete(), ...(t.numero && t.numero === t.serieAndroid ? { numero: null } : {}),
          historique: FieldValue.arrayUnion({ le: Date.now(), etat: 'commandee', par: 'remise à zéro des tests' }),
        } });
      }
      continue;
    }
    if (t.ref && aEffacer.includes(t.ref.toUpperCase())) continue;
    const liee = (t.commande && cmdEffacees.has(t.commande)) || (t.fid && effacees.has(t.fid));
    if (!liee) continue;
    const retour = ETATS_CLIENT.includes(t.etat);
    changements.push({ d, texte: `${nom} : déliée de sa commande et de sa famille${retour ? `, « ${t.etat} » → « preparee »` : ''}`, maj: {
      commande: null, fid: null, tabletUid: null, callsUid: null, alerteJumelage: null, jumeleeLe: FieldValue.delete(),
      ...(retour ? { etat: 'preparee', historique: FieldValue.arrayUnion({ le: Date.now(), etat: 'preparee', par: 'remise à zéro des tests' }) } : {}),
    } });
  }
  const parRef = (r) => stock.docs.find((d) => String(d.get('ref') || '').toUpperCase() === r);
  for (const r of aEffacer) {
    const d = parRef(r);
    if (d) changements.push({ d, texte: `${r} (${d.get('modele') || '?'}, ${d.get('etat')}) : fiche effacée${d.get('depense') ? ' (son achat reste en compta)' : ''}`, effacer: true });
  }
  if (aRelier) {
    const d = parRef(aRelier);
    const t = d && d.data();
    // Fiche de l'achat : sans T-0…, pas encore reçue ni installée.
    const achats = stock.docs.filter((x) => x.id !== (d && d.id) && !x.get('ref') && !x.get('serieAndroid')
      && ['commandee', 'en-stock'].includes(x.get('etat')) && (x.get('depense') || x.get('prixAchat') != null));
    if (!d) console.log(`  ATTENTION : ${aRelier} introuvable dans le stock.`);
    else if (t.depense || t.prixAchat != null) console.log(`  ${aRelier} a déjà son achat : rien à relier.`);
    else if (achats.length !== 1) console.log(`  ATTENTION : ${achats.length} fiches d'achat possibles pour ${aRelier}, rien n'est relié.`);
    else {
      const a = achats[0].data();
      changements.push({ d, texte: `${aRelier} : reliée à l'achat ${a.fournisseur || ''} du ${a.acheteeLe ? a.acheteeLe.toDate().toLocaleDateString('fr-FR') : '?'} (${a.prixAchat != null ? `${(a.prixAchat / 100).toFixed(2).replace('.', ',')} €` : 'prix ?'})`, maj: {
        prixAchat: a.prixAchat ?? null, acheteeLe: a.acheteeLe || null, depense: a.depense || null, fournisseur: a.fournisseur || t.fournisseur || null,
        ...(t.modele ? {} : { modele: a.modele || null }), notes: null,
        historique: FieldValue.arrayUnion({ le: Date.now(), etat: t.etat, par: 'remise à zéro des tests', achat: a.depense || null }),
      } });
      changements.push({ d: achats[0], texte: `  fiche de l'achat « ${a.etat === 'commandee' ? 'Commandée, pas encore reçue' : a.etat} » : effacée (c'est ${aRelier})`, effacer: true });
    }
  }
  const introuvables = [...aRecevoir, ...aEffacer].filter((r) => !stock.docs.some((d) => String(d.get('ref') || '').toUpperCase() === r));
  console.log(`Stock : ${changements.length} fiche(s) changée(s)`);
  for (const c of changements) console.log(`  ${c.texte}`);
  if (introuvables.length) console.log(`  ATTENTION : ${introuvables.join(', ')} introuvable(s) dans le stock.`);

  const abonnements = commandesAEffacer.map((d) => d.id).filter((id) => id.startsWith('sub_'));
  console.log(`Stripe : ${abonnements.length} abonnement(s) de test à arrêter, avec leurs clients.`);

  if (!confirme) {
    console.log('\nRien n\'a été changé. Relancer avec --oui pour le faire (IRRÉVERSIBLE).');
    return;
  }

  // 0. Sauvegarde de tout ce qui va être effacé ou modifié.
  const sauvegarde = { le: new Date().toISOString(), base: db.databaseId || '(default)', commandes: {}, familles: {}, autres: {}, stock: {} };
  for (const d of commandesAEffacer) sauvegarde.commandes[d.id] = await copie(d.ref);
  for (const d of famillesAEffacer) sauvegarde.familles[d.id] = await copie(d.ref);
  for (const [nom, snap] of [['invites', invites], ['pairings', pairings], ['reservations', reservations], ['paniers', paniers]]) {
    sauvegarde.autres[nom] = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
  }
  for (const c of changements) sauvegarde.stock[c.d.id] = c.d.data();
  const fichier = path.join(os.homedir(), '.papote', `sauvegarde-avant-remise-a-zero-${Date.now()}.json`);
  fs.writeFileSync(fichier, JSON.stringify(sauvegarde, null, 1));
  console.log(`\nSauvegarde écrite : ${fichier}`);

  // 1. Stripe d'abord : le webhook de résiliation peut réécrire commandes/{id}, effacée juste après.
  if (abonnements.length) {
    const secret = process.env.STRIPE_SECRET || await demander('Clé secrète Stripe de TEST (sk_test_…, Entrée pour ne pas toucher Stripe) : ');
    if (!secret) console.log('Stripe : pas touché.');
    else if (!secret.startsWith('sk_test_')) {
      console.error('Arrêt : seule une clé de TEST (sk_test_…) est acceptée. Rien n\'a été changé.');
      process.exit(1);
    } else {
      const stripe = stripeTest()(secret);
      const clients = new Set();
      for (const id of abonnements) {
        try {
          const abo = await stripe.subscriptions.retrieve(id);
          clients.add(abo.customer);
          if (abo.status !== 'canceled') await stripe.subscriptions.cancel(id);
          console.log(`  ${id} : arrêté`);
        } catch (e) {
          console.log(`  ${id} : ${e.message}`);
        }
      }
      for (const c of clients) await stripe.customers.del(c).then(() => console.log(`  client ${c} : effacé`)).catch((e) => console.log(`  client ${c} : ${e.message}`));
      console.log('Attente de 20 s (le webhook Stripe finit de passer)…');
      await new Promise((ok) => setTimeout(ok, 20000));
    }
  }

  // 2. Familles : fichiers puis fiche et sous-collections (comme « Supprimer la famille » de l'admin).
  const bucket = admin.storage().bucket(BUCKET);
  for (const d of famillesAEffacer) {
    await bucket.deleteFiles({ prefix: `families/${d.id}/`, force: true });
    await db.recursiveDelete(d.ref);
    console.log(`  famille ${d.get('name') || d.id} : effacée`);
  }
  // 3. Le reste (relu : le webhook a pu réécrire une commande pendant l'attente).
  const encore = (await db.collection('commandes').get()).docs.filter((d) => !garder.has(d.get('fid')));
  for (const d of encore) await db.recursiveDelete(d.ref);
  console.log(`  commandes : ${encore.length} effacée(s)`);
  for (const [nom, snap] of [['codes famille', invites], ['jumelages', pairings], ['réservations', reservations], ['paniers', paniers]]) {
    const docs = nom === 'codes famille' || nom === 'jumelages' ? snap.docs.filter((d) => !garder.has(d.get('fid'))) : snap.docs;
    for (const d of docs) await d.ref.delete();
    console.log(`  ${nom} : ${docs.length} effacé(s)`);
  }
  // Une fiche peut être déliée ET reliée à son achat : ses changements sont réunis en une écriture.
  const parFiche = new Map();
  for (const c of changements) {
    const x = parFiche.get(c.d.id) || { d: c.d, maj: {}, effacer: false };
    if (c.effacer) x.effacer = true;
    else Object.assign(x.maj, c.maj);
    parFiche.set(c.d.id, x);
  }
  for (const x of parFiche.values()) {
    if (x.effacer) await x.d.ref.delete();
    else await x.d.ref.update({ ...x.maj, majLe: FieldValue.serverTimestamp() });
  }
  console.log(`  stock : ${changements.length} fiche(s) mise(s) à jour`);
  console.log('\nTerminé. Les tablettes reviennent d\'elles-mêmes sur leur code (famille effacée).');
}

main().catch((e) => {
  console.error(`Erreur : ${e.message}`);
  process.exit(1);
});
