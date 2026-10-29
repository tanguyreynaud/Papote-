// Essai de qualité de l'appel vidéo sur SIM, pour UNE famille (sa tablette) : families/{fid}.forfaitSim.visio.
//
//   node visio-sim.js T-003                : affiche le réglage en cours
//   node visio-sim.js T-003 300 100        : image reçue 300 kbit/s, Mamie envoyée 100 kbit/s (normal : 500 / 120)
//   node visio-sim.js T-003 normal         : retire l'essai, réglage normal
//
// T-003 = numéro de la tablette (fiche stock/{id}.ref, reliée à sa famille), ou directement l'identifiant de la famille.
// Le marqueur « rev » est avancé en même temps : la tablette est réveillée par le push et applique
// le réglage dans la minute (journal « Visio sur SIM : … »). Jamais appliqué sur le Wi-Fi.
// Clé d'administration : %USERPROFILE%\.papote\cle-admin-firebase.json (jamais dans le dépôt).
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const { ouvrirBase } = require('./base');

const keyPath = process.env.PAPOTE_CLE_ADMIN
  || path.join(os.homedir(), '.papote', 'cle-admin-firebase.json');
const [cible, a, b] = process.argv.slice(2);
if (!cible) {
  console.error('Usage : node visio-sim.js <tablette ou famille> [reception envoi | normal]');
  process.exit(1);
}
if (!fs.existsSync(keyPath)) {
  console.error(`Clé introuvable : ${keyPath}`);
  process.exit(1);
}
const app = admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });

(async () => {
  const db = await ouvrirBase(app);
  let fid = cible;
  let famille = await db.doc(`families/${fid}`).get();
  if (!famille.exists) {
    // Le numéro T-… est sur la fiche de stock (stock/{id}.ref), reliée à la famille au jumelage (fid).
    const t = (await db.collection('stock').where('ref', '==', cible.toUpperCase()).get()).docs.filter((d) => d.get('fid'));
    if (!t.length) { console.error(`Ni famille ni tablette reliée à une famille « ${cible} »`); process.exit(1); }
    if (t.length > 1) { console.error(`${t.length} fiches de stock portent ${cible} : donner l'identifiant de la famille`); process.exit(1); }
    fid = t[0].get('fid');
    famille = await db.doc(`families/${fid}`).get();
  }
  const visio = (famille.get('forfaitSim') || {}).visio;
  const etat = () => (visio ? `essai : reçu ${visio.reception} kbit/s, envoyé ${visio.envoi} kbit/s` : 'réglage normal (reçu 500, envoyé 120)');
  console.log(`${famille.get('name') || fid} (${fid}), base ${db.databaseId} : ${etat()}`);
  if (!a) process.exit(0);

  let nouveau;
  if (a === 'normal' || a === 'off') nouveau = FieldValue.delete();
  else {
    const reception = Number(a), envoi = Number(b);
    if (!(reception >= 100 && reception <= 1500) || !(envoi >= 40 && envoi <= 700)) {
      console.error('Réception entre 100 et 1500 kbit/s, envoi entre 40 et 700 kbit/s (par exemple 300 100).');
      process.exit(1);
    }
    nouveau = { reception, envoi };
  }
  await db.doc(`families/${fid}`).set({ forfaitSim: { visio: nouveau }, rev: FieldValue.increment(1) }, { merge: true });
  console.log(nouveau.reception ? `Essai réglé : reçu ${nouveau.reception} kbit/s, envoyé ${nouveau.envoi} kbit/s.` : 'Essai retiré : réglage normal.');
  console.log('La tablette l\'applique à son prochain tour (push : dans la minute) ; vérifier le journal « Visio sur SIM ».');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
