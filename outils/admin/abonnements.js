// Abonnements des familles : liste, famille offerte, retrait de l'accès gratuit.
//
//   node abonnements.js                 : liste les familles et leur abonnement
//   node abonnements.js offert <famille> : statut « offert », jamais suspendue (famille de Tanguy)
//   node abonnements.js aucun <famille>  : la famille devra s'abonner (tablette en pause)
//   node abonnements.js rendue <e-mail>  : la tablette incluse de ce client est revenue (pas de pénalité)
// <famille> : nom exact (sans tenir compte des majuscules) ou identifiant Firestore.
// Les paiements eux-mêmes sont gérés par les fonctions serveur (functions/), pas ici.
// Clé d'administration : %USERPROFILE%\.papote\cle-admin-firebase.json (jamais dans le dépôt).
const fs = require('fs');
const os = require('os');
const path = require('path');
const admin = require('firebase-admin');

const keyPath = process.env.PAPOTE_CLE_ADMIN
  || path.join(os.homedir(), '.papote', 'cle-admin-firebase.json');
const [action, ...reste] = process.argv.slice(2);
const cible = reste.join(' ').trim();

if (action && (!['offert', 'aucun', 'rendue'].includes(action) || !cible)) {
  console.error('Usage : abonnements.bat [offert|aucun "nom de la famille"] [rendue adresse@mail]');
  process.exit(1);
}
if (!fs.existsSync(keyPath)) {
  console.error(`Clé introuvable : ${keyPath}`);
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });
const db = admin.firestore();
const { FieldValue } = admin.firestore;

function texteStatut(abo) {
  if (!abo || !abo.statut) return 'ancienne famille (active, sans abonnement)';
  const fin = abo.finPeriode ? ` jusqu'au ${abo.finPeriode.toDate().toLocaleDateString('fr-FR')}` : '';
  return `${abo.statut}${abo.formule ? ` (${abo.formule}, tablette ${abo.tablette})` : ''}${fin}`;
}

async function tabletteRendue(email) {
  const commandes = await db.collection('commandes')
    .where('email', '==', email.toLowerCase()).where('restitution.statut', 'in', ['attendue', 'echec']).get();
  if (commandes.empty) {
    console.error(`Aucune tablette attendue pour ${email}.`);
    process.exit(1);
  }
  for (const c of commandes.docs) {
    await c.ref.set({ restitution: { statut: 'rendue', majLe: FieldValue.serverTimestamp() } }, { merge: true });
  }
  console.log(`Tablette de ${email} marquée comme rendue.`);
}

async function listeRestitutions() {
  const attendues = await db.collection('commandes').where('restitution.statut', 'in', ['attendue', 'echec']).get();
  if (attendues.empty) return;
  console.log('\nTablettes incluses à récupérer :');
  for (const c of attendues.docs) {
    const r = c.get('restitution');
    const avant = r.avant ? r.avant.toDate().toLocaleDateString('fr-FR') : '?';
    console.log(`  ${c.get('email')}  avant le ${avant}${r.statut === 'echec' ? `  (prélèvement refusé : ${r.erreur})` : ''}`);
  }
}

(async () => {
  if (action === 'rendue') {
    await tabletteRendue(cible);
    return;
  }
  const familles = await db.collection('families').get();
  if (!action) {
    for (const f of familles.docs) {
      console.log(`${f.get('name')}  [${f.id}]  ${texteStatut(f.get('abonnement'))}`);
    }
    await listeRestitutions();
    return;
  }
  const trouvees = familles.docs.filter((f) => f.id === cible
    || String(f.get('name') || '').toLowerCase() === cible.toLowerCase());
  if (trouvees.length !== 1) {
    console.error(trouvees.length ? `Plusieurs familles s'appellent « ${cible} » : utilisez l'identifiant.`
      : `Aucune famille « ${cible} ».`);
    process.exit(1);
  }
  const f = trouvees[0];
  const abo = f.get('abonnement');
  if (action === 'aucun' && abo && ['actif', 'impaye'].includes(abo.statut)) {
    console.error('Cette famille paie un abonnement : résiliez-le dans Stripe plutôt.');
    process.exit(1);
  }
  await f.ref.update({
    abonnement: { ...(abo || {}), statut: action, graceJusqua: null, majLe: FieldValue.serverTimestamp() },
    rev: FieldValue.increment(1),
  });
  console.log(`${f.get('name')} : ${action}.`);
})().catch((e) => {
  console.error('Erreur :', e.message);
  process.exit(1);
});
