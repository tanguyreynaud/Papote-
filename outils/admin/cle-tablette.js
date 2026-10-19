// Clés App Check des tablettes (voir functions/appcheck.js). La clé reste sur la tablette ; seule son
// empreinte SHA-256 est gardée dans clesTablettes/{empreinte} = { serie, creeLe }.
//
//   node cle-tablette.js --serie SERIE      : crée une clé, l'enregistre et l'affiche (ligne CLE=...)
//                                            (appelé par installation\installer-tablette.ps1)
//   node cle-tablette.js --retirer SERIE    : supprime les clés de cette tablette (perdue, volée, rendue)
//   node cle-tablette.js --liste            : tablettes qui ont une clé
// Clé d'administration : %USERPROFILE%\.papote\cle-admin-firebase.json (jamais dans le dépôt).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { ouvrirBase } = require('./base');

function option(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
}

const keyPath = process.env.PAPOTE_CLE_ADMIN
  || path.join(os.homedir(), '.papote', 'cle-admin-firebase.json');
if (!fs.existsSync(keyPath)) {
  console.error(`Clé introuvable : ${keyPath}`);
  process.exit(1);
}
const app = admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });

(async () => {
  const db = await ouvrirBase(app);
  const cles = db.collection('clesTablettes');
  const serie = option('serie');
  const retirer = option('retirer');

  if (serie) {
    const cle = crypto.randomBytes(32).toString('base64url');
    const empreinte = crypto.createHash('sha256').update(cle).digest('hex');
    await cles.doc(empreinte).set({ serie, creeLe: admin.firestore.Timestamp.now() });
    console.error(`Clé App Check créée pour la tablette ${serie}.`);
    console.log(`CLE=${cle}`);
  } else if (retirer) {
    const snap = await cles.where('serie', '==', retirer).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
    console.log(`${snap.size} clé(s) retirée(s) pour la tablette ${retirer}.`);
  } else if (process.argv.includes('--liste')) {
    const snap = await cles.orderBy('creeLe').get();
    for (const d of snap.docs) {
      const vue = d.get('vueLe');
      console.log(`${d.get('serie')}  créée le ${d.get('creeLe').toDate().toLocaleDateString('fr-FR')}`
        + (vue ? `, vue le ${vue.toDate().toLocaleDateString('fr-FR')}` : ', jamais utilisée'));
    }
    if (!snap.size) console.log('Aucune tablette n\'a de clé.');
  } else {
    console.error('Usage : cle-tablette.bat --serie SERIE | --retirer SERIE | --liste');
    process.exit(1);
  }
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
