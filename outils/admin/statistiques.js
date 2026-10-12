// Statistiques du site : visites et commandes des 30 derniers jours (ou du nombre de jours donné).
//
//   node statistiques.js [jours]
//
// Compteurs écrits par la fonction « compter » (sans cookie) et par le paiement Stripe :
// accueil, commande (page ouverte), relais (point choisi), paiement (clic sur Payer), paye.
// Clé d'administration : %USERPROFILE%\.papote\cle-admin-firebase.json (jamais dans le dépôt).
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('firebase-admin');

const keyPath = process.env.PAPOTE_CLE_ADMIN
  || path.join(os.homedir(), '.papote', 'cle-admin-firebase.json');
const jours = Math.max(1, Number(process.argv[2]) || 30);
if (!fs.existsSync(keyPath)) {
  console.error(`Clé introuvable : ${keyPath}`);
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });

const COLONNES = [['accueil', 'Accueil'], ['commande', 'Page commande'], ['relais', 'Relais choisi'],
  ['paiement', 'Clic Payer'], ['paye', 'Payé']];
const pourcent = (a, b) => (b ? `${Math.round((100 * a) / b)} %` : '-');

(async () => {
  const debut = new Date(Date.now() - (jours - 1) * 86400000)
    .toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  const snap = await admin.firestore().collection('statistiques')
    .where(admin.firestore.FieldPath.documentId(), '>=', debut).get();
  const total = Object.fromEntries(COLONNES.map(([c]) => [c, 0]));
  const lignes = snap.docs.map((d) => {
    const v = d.data();
    COLONNES.forEach(([c]) => { total[c] += v[c] || 0; });
    return [d.id, ...COLONNES.map(([c]) => v[c] || 0)];
  });
  console.log(`Statistiques des ${jours} derniers jours\n`);
  console.log(['Jour      ', ...COLONNES.map(([, t]) => t)].join(' | '));
  lignes.forEach((l) => console.log(l.map((x, i) => String(x).padEnd(i ? COLONNES[i - 1][1].length : 10)).join(' | ')));
  console.log(['TOTAL     ', ...COLONNES.map(([c, t]) => String(total[c]).padEnd(t.length))].join(' | '));
  console.log(`\nVisiteurs de la page commande qui ont payé : ${pourcent(total.paye, total.commande)}`);
  console.log(`Ceux qui ont choisi un relais puis payé   : ${pourcent(total.paye, total.relais)}`);
  console.log(`Ceux qui ont cliqué Payer puis payé       : ${pourcent(total.paye, total.paiement)}`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
