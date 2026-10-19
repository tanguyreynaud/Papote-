// Tablettes de toutes les familles : version de Papote et dernière activité. Lecture seule.
//
//   node tablettes.js [version minimale, 2.74 par défaut]
//
// Signale à part les tablettes sous la version minimale (sous 2.74 : caméra qui peut s'allumer seule).
// Clé d'administration : %USERPROFILE%\.papote\cle-admin-firebase.json (jamais dans le dépôt).
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('firebase-admin');
const { ouvrirBase } = require('./base');

const keyPath = process.env.PAPOTE_CLE_ADMIN
  || path.join(os.homedir(), '.papote', 'cle-admin-firebase.json');
const minimale = process.argv[2] || '2.74';
if (!fs.existsSync(keyPath)) {
  console.error(`Clé introuvable : ${keyPath}`);
  process.exit(1);
}
const app = admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });

// « 2.73 » < « 2.74 » ; une version inconnue compte comme ancienne.
const comparer = (a, b) => {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
};
const date = (v) => (v && v.toDate ? v.toDate().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) : '-');
const ms = (v) => (v && v.toMillis ? v.toMillis() : 0);

(async () => {
  const db = await ouvrirBase(app);
  const snap = await db.collectionGroup('members').where('role', '==', 'tablette').get();
  const familles = new Map();
  const lignes = await Promise.all(snap.docs.map(async (d) => {
    const fid = d.ref.parent.parent.id;
    if (!familles.has(fid)) familles.set(fid, db.doc(`families/${fid}`).get().then((f) => f.get('name') || fid));
    const m = d.data();
    const derniere = ms(m.lastSeen) > ms(m.lastOnline) ? m.lastSeen : m.lastOnline;
    return { famille: await familles.get(fid), fid, nom: m.name || d.id, version: m.appVersion || '?',
      vue: date(m.lastSeen), enLigne: date(m.lastOnline), derniere: ms(derniere) };
  }));
  lignes.sort((a, b) => b.derniere - a.derniere);
  console.log(`${lignes.length} tablette(s), base ${db.databaseId}\n`);
  for (const l of lignes) {
    console.log(`${l.famille} (${l.fid}) · ${l.nom} · version ${l.version} · en ligne ${l.enLigne} · vue ${l.vue}`);
  }
  const vieilles = lignes.filter((l) => comparer(l.version, minimale) < 0);
  console.log(`\nSous la version ${minimale} : ${vieilles.length}`);
  for (const l of vieilles) console.log(`  ${l.famille} · ${l.nom} · version ${l.version} · en ligne ${l.enLigne}`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
