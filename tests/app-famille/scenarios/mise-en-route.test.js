// Première mise en route par une famille (audit du 12/11/2026, décisions de Tanguy du 12/11), dans la vraie appli.
// Rapport : /mnt/project-files/audit/mise-en-route-12-11/rapport.md (M2, M5, M8).

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

const { s, acteurs } = banc;

// M5. Un proche qui vit à l'étranger, ou sans portable, entre dans l'appli en cochant la case ; un numéro étranger
// tapé sans la cocher est refusé avec la case indiquée. Rien n'est écrit dans le numéro de sa fiche.
test('M5 : proche à l\'étranger : la case « pas de numéro, ou à l\'étranger » le laisse entrer', async () => {
  const lea = await banc.telephone('Léa');
  await g.seConnecter(lea, 'lea@exemple.be');
  await g.attendreVue(lea, 'view-moi');
  await lea.page.fill('#moi-prenom', 'Léa');
  await lea.page.fill('#moi-tel', '+32470123456');
  await lea.page.click('#form-moi .genre-btn[data-genre="femme"]');
  await lea.page.setInputFiles('#moi-in', await g.photo({ largeur: 800, hauteur: 800, texte: 'Léa' }));
  await lea.page.locator('#moi-photo').waitFor({ state: 'visible' });
  await lea.page.selectOption('#moi-jour', '12');
  await lea.page.selectOption('#moi-mois', '5');
  await lea.page.selectOption('#moi-annee', '1995');
  await lea.page.click('#form-moi button[type=submit]');
  await lea.page.locator('#moi-error').waitFor({ state: 'visible' });
  assert.match(await lea.page.locator('#moi-error').innerText(), /Cochez « Je n'ai pas de numéro, ou je vis à l'étranger »/);
  assert.strictEqual(await g.vue(lea), 'view-moi');
  // La case : le numéro est vidé et grisé, l'erreur part, « Continuer » reste possible.
  await lea.page.click('label.moi-sans-tel');
  assert.ok(await lea.page.locator('#moi-tel').isDisabled());
  assert.strictEqual(await lea.page.locator('#moi-tel').inputValue(), '');
  assert.ok(await lea.page.locator('#moi-error').isHidden());
  assert.ok(await lea.page.locator('#form-moi button[type=submit]').isEnabled());
  await lea.page.click('#form-moi button[type=submit]');
  await lea.page.waitForFunction(() => document.querySelector('#view-moi').hidden, null, { timeout: 15_000 });
  assert.strictEqual(await lea.page.evaluate(() => localStorage.getItem('papote.telephone')), 'aucun');
  // Rouverte plus tard : « Vos informations » n'est pas redemandé.
  await lea.page.reload();
  await lea.page.waitForFunction(() => document.querySelector('#loading').hidden, null, { timeout: 20_000 });
  assert.notStrictEqual(await g.vue(lea), 'view-moi');
});

// M5 (suite). Sans la case, le portable reste obligatoire.
test('M5 : sans la case, « Continuer » reste grisé tant que le portable manque', async () => {
  const paul = await banc.telephone('Paul');
  await g.seConnecter(paul, 'paul@exemple.fr');
  await g.attendreVue(paul, 'view-moi');
  await paul.page.fill('#moi-prenom', 'Paul');
  await paul.page.click('#form-moi .genre-btn[data-genre="homme"]');
  await paul.page.setInputFiles('#moi-in', await g.photo({ largeur: 800, hauteur: 800, texte: 'Paul' }));
  await paul.page.locator('#moi-photo').waitFor({ state: 'visible' });
  await paul.page.selectOption('#moi-jour', '3');
  await paul.page.selectOption('#moi-mois', '2');
  await paul.page.selectOption('#moi-annee', '1980');
  assert.ok(await paul.page.locator('#form-moi button[type=submit]').isDisabled(), 'portable manquant');
  await paul.page.click('label.moi-sans-tel');
  assert.ok(await paul.page.locator('#form-moi button[type=submit]').isEnabled());
  await paul.page.click('label.moi-sans-tel');
  assert.ok(!(await paul.page.locator('#moi-tel').isDisabled()), 'décochée : le champ revient');
  assert.ok(await paul.page.locator('#form-moi button[type=submit]').isDisabled());
});

// M8. La tablette appelle par sa carte SIM : son numéro s'affiche sur le téléphone du proche. Une carte sur l'accueil
// propose de l'enregistrer ; « C'est déjà fait » la ferme sur ce téléphone, un nouveau numéro la fait revenir.
test('M8 : « Enregistrez le numéro de Mamie Emma » sur l\'accueil dès que la tablette a son numéro', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  assert.ok(await julie.page.locator('#contact-encart').isHidden(), 'pas de numéro : pas de carte');
  await s.db.doc(`families/${fid}/members/${tab.tabletUid}`).update({ telephone: '06 98 76 54 32' });
  await julie.page.locator('#contact-encart').waitFor({ state: 'visible' });
  assert.strictEqual(await julie.page.locator('#contact-titre').innerText(), 'Enregistrez le numéro de Mamie Emma');
  assert.match(await julie.page.locator('#contact-texte').innerText(), /06 98 76 54 32/);
  // Les deux boutons ont la même taille.
  const [b1, b2] = await Promise.all(['#contact-oui', '#contact-fait'].map((id) => julie.page.locator(id).boundingBox()));
  assert.ok(Math.abs(b1.height - b2.height) < 1 && Math.abs(b1.width - b2.width) < 2, `boutons de même taille (${b1.width}×${b1.height}, ${b2.width}×${b2.height})`);
  // « Enregistrer le numéro » : la fiche contact part tout de suite, la carte se ferme ensuite.
  const telechargement = julie.page.waitForEvent('download');
  await julie.page.click('#contact-oui');
  assert.strictEqual(await julie.page.locator('#contact-oui').innerText(), 'Un instant…', 'réaction visible tout de suite');
  const fichier = await telechargement;
  assert.match(fichier.suggestedFilename(), /Mamie Emma\.vcf/);
  await g.texteFenetre(julie).then((t) => assert.match(t, /Fiche contact de Mamie Emma prête/));
  await g.repondre(julie, 'OK').catch(() => null);
  await julie.page.locator('#contact-encart').waitFor({ state: 'hidden' });
  await julie.page.reload();
  await g.attendreVue(julie, 'view-home', 30_000);
  await julie.page.waitForTimeout(1500);
  assert.ok(await julie.page.locator('#contact-encart').isHidden(), 'fermée une fois pour toutes sur ce téléphone');
  // Nouvelle carte SIM, nouveau numéro : la carte revient ; « C'est déjà fait » la ferme.
  await s.db.doc(`families/${fid}/members/${tab.tabletUid}`).update({ telephone: '07 11 22 33 44' });
  await julie.page.locator('#contact-encart').waitFor({ state: 'visible' });
  await julie.page.click('#contact-fait');
  await g.toast(julie, 'C\'est noté.');
  assert.ok(await julie.page.locator('#contact-encart').isHidden());
});

// M2. Colis pas encore noté « déposé » : la tablette montre son QR et sa voix dit de scanner. Celui qui a payé, connecté
// avec une autre adresse que celle du paiement (aucune invitation ne l'attend), scanne depuis l'appli : il entre dans
// la famille de sa commande (jamais une deuxième) et en devient responsable, la tablette aussi y entre.
test('M2 : le QR scanné avec une autre adresse : arrivée dans la famille de la commande, sans nom à redonner', async () => {
  const tab = await acteurs.tablettePreparee();
  const { abonnement: id } = await acteurs.commanderEtPayer({ email: 'paul@exemple.fr' });
  const { fid } = await g.lire(`commandes/${id}`);
  await s.appeler('gestionStock', { action: 'modifier', id: tab.fiche, champs: { commande: id } }, acteurs.TANGUY);
  await acteurs.afficherCode(tab);
  assert.strictEqual((await g.lire(`pairings/${tab.code}`)).status, 'waiting');
  const paul = await banc.telephone('Paul');
  await g.inscrire(paul, 'paul.perso@exemple.fr', 'Paul', { suite: `?tablette=${tab.code}` });
  await g.attendreVue(paul, 'view-home', 30_000);
  assert.strictEqual(await paul.page.evaluate(() => localStorage.getItem('papote.fid')), fid);
  assert.strictEqual((await s.db.collection('families').get()).size, 1, 'une seule famille');
  assert.strictEqual((await g.lire(`pairings/${tab.code}`)).fid, fid);
  const fam = await g.lire(`families/${fid}`);
  const fiche = await g.lire(`families/${fid}/members/${fam.createdBy}`);
  assert.strictEqual(fiche && fiche.email, 'paul.perso@exemple.fr', 'Paul responsable de sa famille');
  assert.ok(await paul.page.locator('#nom-prepare').isVisible(), '« Comment appelez-vous la personne ? » proposé au responsable');
});
