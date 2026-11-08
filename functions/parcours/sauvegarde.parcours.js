// Exercice de restauration (inspection 6, nuit du 3/11) : des familles réalistes vivent (commande payée, tablette
// envoyée et installée, proches, envois, rappels, appel), la base et les comptes sont sauvegardés avec la même
// mécanique que sauvegarder.bat (outils/admin/sauvegarde-lib.js), tout est effacé, puis restauré à partir du fichier
// JSON écrit sur le disque. Vérifié : chaque document identique, chaque compte revenu, et les liens entre eux
// (proche → compte, commande → famille, tablette en stock → famille). Puis le script verifier-sauvegarde.js tourne
// pour de vrai sur ce fichier. Les vraies sauvegardes (G: de Tanguy) ne sont pas accessibles d'ici.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const admin = require('firebase-admin');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher } = require('./commun');
const lib = require('../../outils/admin/sauvegarde-lib'); // trouve firebase-admin dans functions/node_modules

brancher();

async function familleVivante(i) {
  const julie = await s.compte(`Julie${i}`, `julie${i}@exemple.fr`);
  const paul = await s.compte(`Paul${i}`, `paul${i}@exemple.fr`);
  const t = await a.tablettePreparee();
  const { abonnement } = await a.commanderEtPayer({ email: paul.email, nom: `Paul Martin ${i}` });
  await a.preparerEtEnvoyer(abonnement, t);
  await a.afficherCode(t);
  const fid = await a.installer(julie, t, { nom: `Mamie ${['Emma', 'Rose', 'Jeanne'][i]}` });
  await a.rejoindre(paul, fid);
  await a.envoyer(julie, fid, 'photo');
  await a.envoyer(paul, fid, 'message', `Bonne nuit Mamie ${i}`);
  await a.envoyer(julie, fid, 'video');
  await s.db.collection(`families/${fid}/reminders`).add({ title: 'Doliprane', kind: 'medic', repeat: 'daily', time: '09:00', createdAt: s.FieldValue.serverTimestamp(), createdBy: julie.uid });
  await a.appelerDepuisLaTablette(t, { vers: julie });
  await s.calme();
  return { fid, t, julie, paul };
}

test('restauration : 3 familles vivantes sauvegardées, tout effacé, tout revient à l\'identique avec les liens', async () => {
  const familles = [];
  for (let i = 0; i < 3; i++) familles.push(await familleVivante(i));
  s.avancer(2);
  await s.tache('gestionAutomatique').catch(() => null);
  await s.calme();

  // Sauvegarde, comme sauvegarder.bat : base + comptes, écrite sur le disque.
  const auth = admin.auth();
  const avant = await lib.sauvegarder({ db: s.db, auth, projet: 'demo-papote', base: 'europe' });
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'papote-exercice-'));
  const fichier = path.join(dossier, 'papote-2026-11-04-03-00-00.json');
  fs.writeFileSync(fichier, JSON.stringify(avant));
  const ko = Math.round(fs.statSync(fichier).size / 1024);
  assert.ok(avant.documents.length > 60, `${avant.documents.length} documents`);
  assert.ok(avant.comptes.length >= 6, `${avant.comptes.length} comptes (les comptes d'appel des tablettes sont simulés, pas dans Auth)`);
  console.log(`Exercice : ${avant.documents.length} documents, ${avant.comptes.length} comptes, ${ko} ko pour 3 familles.`);

  // Catastrophe : plus rien.
  await s.remettreAZero();
  assert.strictEqual((await lib.toutLire(s.db)).length, 0);
  assert.strictEqual((await auth.listUsers(1000)).users.length, 0);

  // Restauration depuis le fichier (relu du disque, comme restaurer.bat --oui --comptes).
  const lu = JSON.parse(fs.readFileSync(fichier, 'utf8'));
  const mailsAvant = s.boite.length;
  const pushAvant = s.notifications.length;
  const r = await lib.restaurer({ db: s.db, auth, sauvegarde: lu });
  await s.calme();
  // Les proches remis ne reçoivent pas « X a rejoint la famille », les appels remis ne font sonner personne.
  assert.strictEqual(s.boite.length - mailsAvant, 0, `e-mails envoyés pendant la restauration : ${s.boite.slice(mailsAvant).map((m) => m.sujet).join(' | ')}`);
  assert.strictEqual(s.notifications.length - pushAvant, 0, 'aucune notification pendant la restauration');
  assert.ok(!(await s.db.doc('interne/restauration').get()).exists, 'drapeau retiré');
  assert.strictEqual(r.documents, avant.documents.length);
  assert.strictEqual(r.comptes, avant.comptes.length);

  const apres = await lib.sauvegarder({ db: s.db, auth, projet: 'demo-papote', base: 'europe' });
  const differences = [];
  const parChemin = new Map(apres.documents.map((d) => [d.chemin, d.donnees]));
  for (const d of avant.documents) {
    const r = parChemin.get(d.chemin);
    if (!r) { differences.push(`${d.chemin} : absent`); continue; }
    const cles = new Set([...Object.keys(d.donnees), ...Object.keys(r)]);
    const changees = [...cles].filter((k) => JSON.stringify(d.donnees[k]) !== JSON.stringify(r[k]));
    if (changees.length) differences.push(`${d.chemin} : ${changees.map((k) => `${k} ${JSON.stringify(d.donnees[k])} → ${JSON.stringify(r[k])}`).join(' ; ')}`);
  }
  for (const d of apres.documents) if (!avant.documents.some((x) => x.chemin === d.chemin)) differences.push(`${d.chemin} : apparu après la restauration`);
  if (differences.length) console.log(`Différences après restauration :\n  ${differences.join('\n  ')}`);
  assert.deepStrictEqual(differences, [], 'chaque document identique (types compris), rien d\'apparu');
  assert.deepStrictEqual(apres.comptes.map((c) => ({ ...c, creeLe: null })), avant.comptes.map((c) => ({ ...c, creeLe: null })), 'chaque compte revenu');

  // Les liens : chaque proche a son compte ; chaque commande sa famille ; chaque tablette envoyée sa famille ;
  // chaque envoi son auteur ; la famille voit toujours son abonnement actif.
  const comptes = new Set(apres.comptes.map((c) => c.uid));
  for (const f of familles) {
    const membres = await s.db.collection(`families/${f.fid}/members`).get();
    assert.ok(membres.size >= 3, 'Julie, Paul et la tablette');
    for (const m of membres.docs) assert.ok(comptes.has(m.id) || m.get('role') === 'tablette', `compte du membre ${m.id}`);
    const posts = await s.db.collection(`families/${f.fid}/posts`).get();
    const trouve = (type, uid) => posts.docs.some((p) => p.get('type') === type && p.get('authorUid') === uid);
    assert.ok(trouve('photo', f.julie.uid) && trouve('video', f.julie.uid) && trouve('message', f.paul.uid), 'chaque envoi retrouve son auteur');
    assert.ok(posts.docs.some((p) => p.get('text') === `Bonne nuit Mamie ${familles.indexOf(f)}`), 'le texte du message');
    const fam = await s.lire(`families/${f.fid}`);
    assert.strictEqual(fam.abonnement.statut, 'actif');
    const commandes = await s.db.collection('commandes').where('fid', '==', f.fid).get();
    assert.strictEqual(commandes.size, 1, 'la commande retrouve sa famille');
    const stock = await s.db.collection('stock').where('fid', '==', f.fid).get();
    assert.strictEqual(stock.size, 1, 'la tablette en stock retrouve sa famille');
    assert.strictEqual((await s.db.collection(`families/${f.fid}/reminders`).get()).size, 1);
  }
  // Et la vie continue : un proche envoie, le serveur réagit comme avant (notification voix/push, pas d'erreur).
  s.erreurs.length = 0;
  await a.envoyer(familles[0].paul, familles[0].fid, 'message', 'Après la restauration');
  assert.deepStrictEqual(s.erreurs, []);

  // Le script de vérification officiel, sur ce même fichier : il doit dire « VÉRIFIÉE ».
  const sortie = execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'outils', 'admin', 'verifier-sauvegarde.js'), fichier], { encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(__dirname, '..', 'node_modules') } });
  assert.match(sortie, /3 familles, \d+ proches et tablettes, \d+ envois/);
  assert.match(sortie, /Sauvegarde VÉRIFIÉE/);
  fs.rmSync(dossier, { recursive: true, force: true });
});
