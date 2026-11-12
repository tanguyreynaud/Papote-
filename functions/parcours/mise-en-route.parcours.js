// Première mise en route par une famille (audit du 12/11/2026, décisions de Tanguy du 12/11) : ce qui arrive quand le
// parcours « famille préparée » ne se passe pas dans l'ordre prévu. Joué avec les vraies fonctions (simulation.js).
// Rapport : /mnt/project-files/audit/mise-en-route-12-11/rapport.md (M0, M2).

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, mailsA, commande } = require('./commun');

brancher();

const familles = async () => (await s.db.collection('families').get()).docs;

// Scan du QR comme l'appli (famille.js, écran « Installer la tablette ») : code, puis le nom si aucune famille n'est rendue.
async function scanner(qui, t) {
  const r = await s.appeler('reserverTablette', { code: t.code, prenom: qui.prenom }, qui);
  if (r.etat === 'reserve' && !r.fid) await s.appeler('nommerFamille', { code: t.code, nom: 'Mamie Emma' }, qui);
  await s.calme();
  return r;
}

// Garde-fou : allumée chez Tanguy avant « Colis déposé », la tablette reste hors famille ; rallumée chez Mamie, son
// nouveau code la fait entrer seule, sans que personne ne scanne.
test('tablette allumée avant le dépôt du colis, puis chez Mamie : elle entre seule dans la famille de sa commande', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  const { fid } = await commande(id);
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { commande: id } }, a.TANGUY);
  await a.afficherCode(t);
  assert.strictEqual((await s.lire(`pairings/${t.code}`)).status, 'waiting', 'colis pas parti : pas de famille');
  await a.preparerEtEnvoyer(id, t);
  await a.afficherCode(t);
  assert.strictEqual(await a.entrerDansLaFamille(t), fid);
  assert.strictEqual((await familles()).length, 1);
});

// M2. La tablette montre son QR tant que le serveur n'a pas confirmé le jumelage (sans fin si le colis n'a pas été
// noté « déposé »), et sa voix dit de scanner. Celui qui a payé scanne : jamais de deuxième famille.
test('M2 : celui qui a payé scanne le QR encore affiché : la tablette entre dans SA famille, pas dans une deuxième', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  const { fid } = await commande(id);
  await a.entrerParInvitation(paul, fid);
  await s.appeler('nommerFamillePreparee', { fid, nom: 'Mamie Emma' }, paul);
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { commande: id } }, a.TANGUY);
  await a.afficherCode(t);
  assert.strictEqual((await s.lire(`pairings/${t.code}`)).status, 'waiting');
  s.boite.length = 0;
  const r = await scanner(paul, t);
  assert.deepStrictEqual(r, { etat: 'reserve', fid }, 'l\'appli ouvre directement la famille');
  assert.strictEqual((await familles()).length, 1, 'une seule famille');
  const p = await s.lire(`pairings/${t.code}`);
  assert.strictEqual(p.status, 'confirmed');
  assert.strictEqual(p.fid, fid, 'la tablette entre dans la famille de sa commande');
  assert.strictEqual(p.familyName, 'Mamie Emma');
  assert.ok((await commande(id)).tabletteRelieeLe, 'plus de rappel « votre tablette vous attend »');
  assert.strictEqual(await a.entrerDansLaFamille(t), fid);
  assert.deepStrictEqual(mailsA('contact@mapapote.fr'), [], 'rien à réparer pour Tanguy');
  assert.strictEqual((await s.lire(`families/${fid}`)).createdBy, paul.uid, 'Paul reste responsable');
});

// M2 (suite). Personne n'est encore entré dans la famille préparée (celui qui a payé n'a pas ouvert l'e-mail, ou
// s'est connecté avec une autre adresse) : celui qui a la tablette en main et scanne en devient le responsable.
test('M2 : famille préparée encore vide, un proche scanne : il en devient responsable, la tablette y entre', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const julie = await s.compte('Julie', 'julie.perso@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  const { fid } = await commande(id);
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { commande: id } }, a.TANGUY);
  await a.afficherCode(t);
  const r = await scanner(julie, t);
  assert.deepStrictEqual(r, { etat: 'reserve', fid });
  assert.strictEqual((await familles()).length, 1);
  const fam = await s.lire(`families/${fid}`);
  assert.strictEqual(fam.createdBy, julie.uid, 'responsable : personne d\'autre ne pouvait l\'accepter');
  const fiche = await s.lire(`families/${fid}/members/${julie.uid}`);
  assert.strictEqual(fiche.status, 'active');
  assert.strictEqual(fiche.name, 'Julie');
  assert.strictEqual((await s.lire(`invites/${fam.code}`)).createdBy, julie.uid);
  assert.ok(await s.lire(`families/${fid}/invitations/${paul.email}`), 'l\'invitation de celui qui a payé reste valable');
  assert.strictEqual((await s.lire(`pairings/${t.code}`)).fid, fid);
});

// M2 (suite). La famille a déjà son responsable : un autre proche qui scanne arrive en demande à accepter (comme avec le
// code famille), et la tablette entre quand même dans la bonne famille.
test('M2 : famille préparée qui a déjà son responsable, un autre proche scanne : demande à accepter, aucune famille en plus', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  const { fid } = await commande(id);
  await a.entrerParInvitation(paul, fid);
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { commande: id } }, a.TANGUY);
  await a.afficherCode(t);
  const r = await scanner(julie, t);
  assert.deepStrictEqual(r, { etat: 'reserve', fid });
  assert.strictEqual((await familles()).length, 1);
  assert.strictEqual((await s.lire(`families/${fid}/members/${julie.uid}`)).status, 'pending', 'Paul doit l\'accepter');
  assert.strictEqual((await s.lire(`families/${fid}`)).createdBy, paul.uid);
  assert.strictEqual((await s.lire(`pairings/${t.code}`)).fid, fid);
});

// M2 (suite). Invitée par e-mail avant d'avoir ouvert l'appli : elle entre directement, son invitation sert une fois.
test('M2 : un proche invité par e-mail scanne : il entre directement, son invitation est utilisée', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  const { fid } = await commande(id);
  await a.entrerParInvitation(paul, fid);
  await s.db.doc(`families/${fid}/invitations/${julie.email}`).set({ email: julie.email, fid, invitedBy: 'Paul' });
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { commande: id } }, a.TANGUY);
  await a.afficherCode(t);
  await scanner(julie, t);
  assert.strictEqual((await s.lire(`families/${fid}/members/${julie.uid}`)).status, 'active');
  assert.ok(!(await s.lire(`families/${fid}/invitations/${julie.email}`)), 'invitation utilisée');
});

// M2 (garde-fou). Tanguy essaie la tablette avec son compte administrateur pendant la préparation : il n'entre jamais
// dans la famille du client.
test('M2 : l\'administrateur qui scanne une tablette réservée n\'entre pas dans la famille du client', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  const { fid } = await commande(id);
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { commande: id } }, a.TANGUY);
  await a.afficherCode(t);
  await s.appeler('reserverTablette', { code: t.code, prenom: 'Tanguy' }, a.TANGUY).catch(() => null);
  await s.calme();
  assert.ok(!(await s.lire(`families/${fid}/members/${a.TANGUY.uid}`)), 'Tanguy hors de la famille');
  assert.notStrictEqual((await s.lire(`pairings/${t.code}`)).fid, fid);
});

// M0. Pas de box chez la personne, 4G qui n'arrive pas : la tablette ne peut prévenir personne. Le serveur voit le
// colis retiré (suivi Mondial Relay) sans tablette dans la famille : Tanguy est prévenu une fois, 2 jours après.
test('M0 : colis retiré il y a 2 jours, tablette toujours pas connectée : Tanguy est prévenu une seule fois', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(id, t);
  s.avancer(2);
  await s.db.doc(`commandes/${id}`).update({ 'preparation.recuLe': Date.now(), 'preparation.recuPar': 'suivi Mondial Relay' });
  s.boite.length = 0;
  s.avancer(1);
  await s.tache('rappelsJumelage');
  assert.deepStrictEqual(mailsA('contact@mapapote.fr').filter((m) => /pas encore connectée/.test(m)), [], 'pas avant 2 jours');
  s.avancer(1.1);
  await s.tache('rappelsJumelage');
  s.avancer(1);
  await s.tache('rappelsJumelage');
  assert.strictEqual(mailsA('contact@mapapote.fr').filter((m) => /pas encore connectée/.test(m)).length, 1);
  assert.strictEqual((await commande(id)).alerteConnexion, true);
});

test('M0 : tablette entrée seule dans sa famille : aucune alerte de connexion', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(id, t);
  await a.afficherCode(t);
  await a.entrerDansLaFamille(t);
  s.boite.length = 0;
  s.avancer(4);
  await s.tache('rappelsJumelage');
  assert.deepStrictEqual(mailsA('contact@mapapote.fr').filter((m) => /pas encore connectée/.test(m)), []);
  assert.strictEqual((await commande(id)).alerteConnexion, undefined);
});
