// Entrer dans sa famille avec son numéro de commande (A40, audit de mise en route du 12/11, M1 ; Tanguy 12/11) et
// celui qui a payé, arrivé plus tard par son invitation, toujours responsable (B1). Joué avec les vraies fonctions.
// « Le premier qui rejoint devient responsable, celui qui a commandé est toujours responsable. »

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, commande } = require('./commun');
const { regles } = require('../entrer-par-commande');

brancher();

const avecTiret = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;
const membres = async (fid) => (await s.db.collection(`families/${fid}/members`).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

// M1 : Paul a payé avec son adresse du travail et ouvre l'appli avec son adresse perso : aucune invitation ne l'attend.
test('A40 : celui qui a payé, connecté avec une autre adresse, entre avec son numéro de commande et devient responsable', async () => {
  const { abonnement: id } = await a.commanderEtPayer({ email: 'paul@travail.fr' });
  const { fid, code } = await commande(id);
  const paul = await s.compte('Paul', 'paul.perso@exemple.fr');
  const r = await s.appeler('entrerParCommande', { code: avecTiret(code).toLowerCase(), prenom: 'Paul' }, paul);
  assert.deepStrictEqual(r, { fid, nom: '', responsable: true });
  await s.calme();
  const fam = await s.lire(`families/${fid}`);
  assert.strictEqual(fam.createdBy, paul.uid, 'famille sans responsable : il en devient le propriétaire');
  assert.strictEqual((await s.lire(`invites/${fam.code}`)).createdBy, paul.uid);
  const fiche = await s.lire(`families/${fid}/members/${paul.uid}`);
  assert.strictEqual(fiche.status, 'active');
  assert.strictEqual(fiche.role, 'famille');
  assert.strictEqual(fiche.email, 'paul.perso@exemple.fr');
  assert.strictEqual(fiche.name, 'Paul');
  // Il peut donner le nom de la personne, comme celui qui entre par son invitation.
  await s.appeler('nommerFamillePreparee', { fid, nom: 'Mamie Emma' }, paul);
  assert.strictEqual((await s.lire(`families/${fid}`)).name, 'Mamie Emma');
  // Deuxième fois (double appui, autre téléphone) : rien ne change, toujours une seule fiche.
  const encore = await s.appeler('entrerParCommande', { code, prenom: 'Paul' }, paul);
  assert.deepStrictEqual(encore, { fid, nom: 'Mamie Emma', responsable: true });
  assert.strictEqual((await membres(fid)).length, 1);
  assert.strictEqual((await s.db.collection('families').get()).size, 1, 'jamais une deuxième famille');
});

test('A40 : la famille a déjà un responsable (le premier entré) : celui qui a commandé est ajouté aux responsables', async () => {
  const { abonnement: id } = await a.commanderEtPayer({ email: 'paul@travail.fr' });
  const { fid, code } = await commande(id);
  // Julie, à qui Paul a passé le code famille de l'e-mail, est entrée la première : responsable.
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  await a.rejoindre(julie, fid, { attente: true });
  await s.calme();
  assert.strictEqual((await s.lire(`families/${fid}`)).createdBy, julie.uid);
  const paul = await s.compte('Paul', 'paul.perso@exemple.fr');
  await s.appeler('entrerParCommande', { code, prenom: 'Paul' }, paul);
  await s.calme();
  const fam = await s.lire(`families/${fid}`);
  assert.strictEqual(fam.createdBy, julie.uid, 'le propriétaire ne change pas');
  assert.deepStrictEqual(fam.admins, [paul.uid], 'Paul est responsable');
  assert.strictEqual((await s.lire(`families/${fid}/members/${paul.uid}`)).status, 'active', 'entré sans attendre qu\'on l\'accepte');
});

test('A40 : mauvais code refusé ; 5 essais par jour et par compte, même avec le bon code ensuite ; le lendemain, ça repart', async () => {
  const { abonnement: id } = await a.commanderEtPayer({ email: 'paul@travail.fr' });
  const { fid, code } = await commande(id);
  const eve = await s.compte('Ève', 'eve@exemple.fr');
  const faux = code === 'ABCDEFGH' ? 'ABCDEFGJ' : 'ABCDEFGH';
  for (let i = 0; i < regles.ESSAIS_PAR_JOUR; i++) {
    await assert.rejects(s.appeler('entrerParCommande', { code: faux, prenom: 'Ève' }, eve), /aucune commande/);
  }
  await assert.rejects(s.appeler('entrerParCommande', { code, prenom: 'Ève' }, eve), (e) => e.code === 'resource-exhausted' && /Trop d'essais/.test(e.message));
  assert.strictEqual(await s.lire(`families/${fid}/members/${eve.uid}`), undefined, 'personne n\'est entré');
  const compteur = await s.lire(`limites/entrerParCommande-${eve.uid}`);
  assert.strictEqual(compteur.essais, regles.ESSAIS_PAR_JOUR);
  // Un autre compte n'est pas gêné par le compteur d'Ève.
  const paul = await s.compte('Paul', 'paul.perso@exemple.fr');
  await s.appeler('entrerParCommande', { code, prenom: 'Paul' }, paul);
  s.avancer(1);
  const r = await s.appeler('entrerParCommande', { code, prenom: 'Ève' }, eve);
  assert.strictEqual(r.fid, fid);
  assert.strictEqual((await s.lire(`limites/entrerParCommande-${eve.uid}`)).essais, 1, 'un seul document par compte, remis à zéro chaque jour');
});

test('A40 : commande d\'avant la famille préparée, commande annulée, compte non vérifié : refusés', async () => {
  const { abonnement: avant } = await a.commanderEtPayer({ email: 'paul@travail.fr' });
  await a.commandeDAvant(avant);
  const paul = await s.compte('Paul', 'paul.perso@exemple.fr');
  await assert.rejects(s.appeler('entrerParCommande', { code: (await commande(avant)).code, prenom: 'Paul' }, paul), /aucune commande/);
  const { abonnement: annulee } = await a.commanderEtPayer({ email: 'paul@travail.fr' });
  await s.db.doc(`commandes/${annulee}`).update({ expedition: 'annulee' });
  await assert.rejects(s.appeler('entrerParCommande', { code: (await commande(annulee)).code, prenom: 'Paul' }, paul), /aucune commande/);
  await assert.rejects(s.appeler('entrerParCommande', { code: 'ABCD-EFGH', prenom: 'Paul' }, null), /Connectez-vous/);
  await assert.rejects(s.appeler('entrerParCommande', { code: 'ABCD-EFGH', prenom: '' }, paul), /prénom/);
});

// B1 (index.js nouveauMembre) : la famille a déjà un responsable (Julie, entrée la première avec le code famille) ;
// Paul, qui a payé, arrive plus tard par l'invitation posée à l'adresse de sa commande : il devient responsable.
test('B1 : celui qui a payé, arrivé plus tard par son invitation, devient responsable', async () => {
  const { abonnement: id } = await a.commanderEtPayer({ email: 'paul@exemple.fr' });
  const { fid } = await commande(id);
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  await a.rejoindre(julie, fid, { attente: true });
  await s.calme();
  assert.strictEqual((await s.lire(`families/${fid}`)).createdBy, julie.uid, 'la première entrée est responsable');
  assert.ok(await s.lire(`families/${fid}/invitations/paul@exemple.fr`), 'l\'invitation de Paul l\'attend toujours');
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  await a.entrerParInvitation(paul, fid);
  await s.calme();
  const fam = await s.lire(`families/${fid}`);
  assert.strictEqual(fam.createdBy, julie.uid);
  assert.deepStrictEqual(fam.admins, [paul.uid], 'celui qui a commandé est toujours responsable');
});
