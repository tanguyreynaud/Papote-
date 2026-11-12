// Exercice de restauration (inspection 6, nuit du 3/11) : des familles réalistes vivent (commande payée, tablette
// envoyée et installée, proches, envois, rappels, appel), la base et les comptes sont sauvegardés avec la même
// mécanique que sauvegarder.bat (outils/admin/sauvegarde-lib.js, dossier papote-<date> : un document par ligne), tout
// est effacé, puis restauré à partir de ce dossier écrit sur le disque. Vérifié : chaque document identique, chaque compte revenu, et les liens entre eux
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
  const ecrite = await lib.ecrireSauvegarde({ db: s.db, auth, dossier, projet: 'demo-papote' });
  const fichier = ecrite.dossier;
  assert.strictEqual(ecrite.entete.base, 'europe');
  assert.strictEqual(ecrite.entete.documents.lignes, avant.documents.length);
  const ko = Math.round(ecrite.entete.documents.octets / 1024);
  assert.ok(avant.documents.length > 60, `${avant.documents.length} documents`);
  assert.ok(avant.comptes.length >= 6, `${avant.comptes.length} comptes (les comptes d'appel des tablettes sont simulés, pas dans Auth)`);
  console.log(`Exercice : ${avant.documents.length} documents, ${avant.comptes.length} comptes, ${ko} ko pour 3 familles.`);

  // Catastrophe : plus rien.
  await s.remettreAZero();
  assert.strictEqual((await lib.toutLire(s.db)).length, 0);
  assert.strictEqual((await auth.listUsers(1000)).users.length, 0);

  // Restauration depuis le dossier (relu du disque ligne à ligne, comme restaurer.bat --oui --comptes).
  const lu = await lib.lireSauvegarde(fichier);
  const mailsAvant = s.boite.length;
  const pushAvant = s.notifications.length;
  // Chaque déclencheur lancé par la restauration ne lit que le drapeau et s'arrête (A34).
  s.compteur.activer();
  s.journal.length = 0;
  const r = await lib.restaurer({ db: s.db, auth, sauvegarde: lu });
  await s.calme();
  s.compteur.arreter();
  const lances = s.compteur.bilan();
  assert.ok(Object.keys(lances).length >= 6, `déclencheurs lancés : ${Object.keys(lances).join(', ')}`);
  for (const [nom, c] of Object.entries(lances)) {
    // Une lecture au plus (le drapeau, parfois déjà en mémoire), aucune écriture.
    assert.ok(c.lectures <= c.appels && !c.ecritures && !c.suppressions, `${nom} pendant la restauration : ${JSON.stringify(c)}`);
  }
  const total = Object.values(lances).reduce((n, c) => n + c.appels, 0);
  assert.strictEqual(s.journal.filter((l) => /écriture d'une restauration, ignorée/.test(l)).length, total);
  // Les proches remis ne reçoivent pas « X a rejoint la famille », les appels remis ne font sonner personne.
  assert.strictEqual(s.boite.length - mailsAvant, 0, `e-mails envoyés pendant la restauration : ${s.boite.slice(mailsAvant).map((m) => m.sujet).join(' | ')}`);
  assert.strictEqual(s.notifications.length - pushAvant, 0, 'aucune notification pendant la restauration');
  const drapeau = (await s.db.doc('interne/restauration').get()).data();
  assert.strictEqual(drapeau.enCours, false, 'restauration finie');
  assert.ok(drapeau.debut && drapeau.fin && drapeau.fin.toMillis() >= drapeau.debut.toMillis(), 'fenêtre debut-fin gardée pour les événements en retard');
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
  // interne/restauration : le drapeau, gardé après la restauration (fenêtre debut-fin, vérifiée plus haut).
  for (const d of apres.documents) if (d.chemin !== 'interne/restauration' && !avant.documents.some((x) => x.chemin === d.chemin)) differences.push(`${d.chemin} : apparu après la restauration`);
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

  // Le script de vérification officiel, sur ce même dossier : il doit dire « VÉRIFIÉE ».
  const sortie = execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'outils', 'admin', 'verifier-sauvegarde.js'), fichier], { encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(__dirname, '..', 'node_modules') } });
  assert.match(sortie, /3 familles, \d+ proches et tablettes, \d+ envois/);
  assert.match(sortie, /Sauvegarde VÉRIFIÉE/);
  fs.rmSync(dossier, { recursive: true, force: true });
});

// Sauvegarde du dimanche en retard (A31) : le PC note chaque réussite dans interne/sauvegarde ; chaque jour à 9 h, la
// tâche regarde. Plus de 8 jours : UN e-mail à Papote (pas un par jour), et la ligne « À faire » de l'admin.
test('alerte : plus de 8 jours sans sauvegarde réussie, un seul e-mail à Papote et une ligne « À faire »', async () => {
  await s.remettreAZero();
  const donnees = () => s.appeler('gestionDonnees', {}, a.TANGUY);
  const alertes = () => s.boite.filter((m) => /^Sauvegarde : aucune réussie/.test(m.sujet));

  // Mise en ligne : pas de relevé, le premier contrôle sert de départ ; rien n'est envoyé.
  await s.tache('alerteSauvegarde');
  assert.ok((await s.db.doc('interne/sauvegarde').get()).get('premierControle'));
  assert.strictEqual((await donnees()).sauvegardeAFaire, null);

  // Une vraie sauvegarde réussie, écrite par l'outil du PC (même écriture que sauvegarder.js).
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'papote-alerte-'));
  const ecrite = await lib.ecrireSauvegarde({ db: s.db, dossier, projet: 'demo-papote' });
  await s.db.doc('interne/sauvegarde').set({ derniereReussie: s.Timestamp.fromMillis(Date.now()), nom: ecrite.nom, documents: ecrite.entete.documents.lignes, erreur: null }, { merge: true });

  // Jusqu'à 8 jours moins une heure (l'horloge réelle avance aussi pendant le test).
  for (let j = 1; j <= 8; j++) {
    s.avancer(j === 8 ? 23 / 24 : 1);
    await s.tache('alerteSauvegarde');
  }
  assert.strictEqual(alertes().length, 0, '8 jours : rien');
  assert.strictEqual((await donnees()).sauvegardeAFaire, null);

  // Le PC est resté éteint : jour 9, un e-mail ; jours 10 à 14, plus rien, mais la ligne « À faire » reste.
  s.avancer(1.2);
  await s.tache('alerteSauvegarde');
  for (let j = 0; j < 5; j++) { s.avancer(1); await s.tache('alerteSauvegarde'); }
  await s.calme();
  assert.strictEqual(alertes().length, 1, `e-mails : ${alertes().map((m) => m.sujet).join(' | ')}`);
  assert.strictEqual(alertes()[0].a, 'contact@mapapote.fr');
  assert.match(alertes()[0].sujet, /aucune réussie depuis 9 jours/);
  assert.match((await donnees()).sauvegardeAFaire, /^Sauvegarde du dimanche en retard : la dernière réussie date du/);

  // Une restauration de cette sauvegarde ne fait pas croire à une réussite récente : le relevé n'est pas réécrit.
  const avantRelevé = (await s.db.doc('interne/sauvegarde').get()).data();
  await lib.restaurer({ db: s.db, sauvegarde: await lib.lireSauvegarde(ecrite.dossier) });
  await s.calme();
  assert.deepStrictEqual((await s.db.doc('interne/sauvegarde').get()).data(), avantRelevé);

  // Le PC repart : nouvelle réussite, la ligne disparaît ; 9 jours plus tard, un nouvel e-mail (un seul).
  await s.db.doc('interne/sauvegarde').set({ derniereReussie: s.Timestamp.fromMillis(Date.now()) }, { merge: true });
  assert.strictEqual((await donnees()).sauvegardeAFaire, null);
  for (let j = 0; j < 12; j++) { s.avancer(1); await s.tache('alerteSauvegarde'); }
  await s.calme();
  assert.strictEqual(alertes().length, 2);
  assert.deepStrictEqual(s.erreurs, []);
  fs.rmSync(dossier, { recursive: true, force: true });
});

// commandeModifiee (Stripe, e-mails) pendant une restauration qui réécrit une commande existante (A34) : rien ne part.
test('restauration par-dessus une base vivante : commandeModifiee et les autres déclencheurs se taisent, puis tout repart', async () => {
  await s.remettreAZero();
  const julie = await s.compte('JulieR', 'julie.r@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement } = await a.commanderEtPayer({ email: 'paul.r@exemple.fr', nom: 'Paul Restau' });
  await a.preparerEtEnvoyer(abonnement, t);
  await a.afficherCode(t);
  const fid = await a.installer(julie, t, { nom: 'Mamie Restau' });
  await a.envoyer(julie, fid, 'photo');
  await s.calme();
  const sauvegarde = await lib.sauvegarder({ db: s.db, projet: 'demo-papote', base: 'europe' });
  const commande = sauvegarde.documents.find((d) => /^commandes\/[^/]+$/.test(d.chemin));
  assert.ok(commande, 'une commande dans la sauvegarde');

  // La vie continue : la commande change (adresse corrigée), un envoi est supprimé.
  await s.db.doc(commande.chemin).update({ nom: 'Paul Restau (corrigé)' });
  await s.calme();
  const mails = s.boite.length;
  const pushs = s.notifications.length;
  s.compteur.activer();
  s.journal.length = 0;
  await lib.restaurer({ db: s.db, sauvegarde: JSON.parse(JSON.stringify(sauvegarde)), effacer: true });
  await s.calme();
  s.compteur.arreter();
  const lances = s.compteur.bilan();
  assert.ok(lances.commandeModifiee && lances.commandeModifiee.appels >= 1, `commandeModifiee lancée : ${JSON.stringify(lances)}`);
  for (const [nom, c] of Object.entries(lances)) assert.ok(c.lectures <= c.appels && !c.ecritures, `${nom} : ${JSON.stringify(c)}`);
  assert.strictEqual(s.boite.length, mails, 'aucun e-mail');
  assert.strictEqual(s.notifications.length, pushs, 'aucune notification');
  assert.strictEqual((await s.lire(commande.chemin)).nom, commande.donnees.nom, 'la commande est revenue telle qu\'elle était');

  // Après la restauration, un vrai changement déclenche de nouveau normalement (plus rien d'ignoré).
  s.erreurs.length = 0;
  s.journal.length = 0;
  s.compteur.activer();
  await a.envoyer(julie, fid, 'message', 'Après la restauration');
  await s.calme();
  s.compteur.arreter();
  assert.ok(Object.keys(s.compteur.bilan()).includes('voixEnvoi'), JSON.stringify(s.compteur.bilan()));
  assert.deepStrictEqual(s.journal.filter((l) => /ignorée/.test(l)), []);
  assert.deepStrictEqual(s.erreurs, []);
});
