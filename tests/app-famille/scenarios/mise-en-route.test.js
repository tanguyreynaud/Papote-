// Première mise en route par une famille (audit du 12/11/2026, décisions de Tanguy du 12/11), dans la vraie appli.
// Rapport : /mnt/project-files/audit/mise-en-route-12-11/rapport.md (M1 = A40, M2 = A29, M4 = A43, M5, M8).

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

// A29 (Tanguy 12/11) : « il ne doit y avoir aucune trace de l'ancien parcours », seul Papote relie une tablette.
// Le lien ?tablette=CODE (QR de la tablette scanné) ne fait plus rien : pas d'écran d'installation, aucun appel au
// serveur, aucune famille créée, et le code gardé par une version d'avant est oublié. Avant (M2), ce lien faisait entrer
// celui qui scannait ; un lien piégé faisait entrer un inconnu (L2).
test('A29 : ?tablette= n\'a plus aucun effet : ni écran d\'installation, ni famille créée, ni tablette reliée', async () => {
  const tab = await acteurs.tablettePreparee();
  const { abonnement: id } = await acteurs.commanderEtPayer({ email: 'paul@exemple.fr' });
  const { fid } = await g.lire(`commandes/${id}`);
  // Colis pas encore noté « déposé » : la tablette montre son QR.
  await s.appeler('gestionStock', { action: 'modifier', id: tab.fiche, champs: { commande: id } }, acteurs.TANGUY);
  await acteurs.afficherCode(tab);
  assert.strictEqual((await g.lire(`pairings/${tab.code}`)).status, 'waiting');
  const paul = await banc.telephone('Paul');
  // Code gardé sur ce téléphone par une version d'avant : oublié à l'ouverture.
  await g.ouvrir(paul);
  await paul.page.evaluate(() => localStorage.setItem('papote.codeTablette', 'ABCD2345'));
  await g.ouvrir(paul, `?tablette=${tab.code}`);
  await g.attendreVue(paul, 'view-login');
  assert.strictEqual(await paul.page.locator('#login-tablette').count(), 0, 'plus de « Tablette repérée »');
  await g.inscrire(paul, 'paul.perso@exemple.fr', 'Paul');
  await g.attendreVue(paul, 'view-join', 30_000);
  await paul.page.waitForTimeout(1500);
  assert.strictEqual(await g.vue(paul), 'view-join', 'toujours « Vous êtes invité dans une famille »');
  for (const sel of ['#view-setup', '#view-pair', '#join-pair-card', '#btn-join-pair']) {
    assert.strictEqual(await paul.page.locator(sel).count(), 0, `${sel} retiré de l'appli`);
  }
  assert.doesNotMatch(await paul.page.evaluate(() => document.body.textContent), /Installer la tablette|installez la tablette|Scannez/i);
  assert.strictEqual(await paul.page.evaluate(() => localStorage.getItem('papote.codeTablette')), null);
  assert.strictEqual(await paul.page.evaluate(() => localStorage.getItem('papote.fid')), null);
  assert.deepStrictEqual(banc.appels.filter((a) => /Tablette|Famille$|Installation/.test(a.nom)).map((a) => a.nom), []);
  await s.calme();
  assert.strictEqual((await g.lire(`pairings/${tab.code}`)).status, 'waiting', 'tablette ni réservée ni reliée');
  const familles = await s.db.collection('families').get();
  assert.deepStrictEqual(familles.docs.map((d) => d.id), [fid], 'aucune famille créée');
  assert.strictEqual((await g.liste(`families/${fid}/members`)).length, 0, 'personne n\'est entré dans la famille de la commande');
});

// A40 (M1) : Paul a payé avec son adresse du travail et ouvre l'appli avec son adresse perso : aucune invitation ne
// l'attend. Il tape son numéro de commande (page « Merci », e-mail, facture) dans « Vous êtes invité dans une famille » :
// il entre tout de suite et devient responsable. Double appui : un seul appel au serveur.
test('A40 : numéro de commande dans « Code famille ou numéro de commande » : entrée directe, responsable', async () => {
  const { abonnement: id } = await acteurs.commanderEtPayer({ email: 'paul@travail.fr' });
  const { fid, code } = await g.lire(`commandes/${id}`);
  const paul = await banc.telephone('Paul');
  await g.inscrire(paul, 'paul.perso@exemple.fr', 'Paul');
  await g.attendreVue(paul, 'view-join', 30_000);
  assert.match(await paul.page.locator('#join-code-wrap').innerText(), /Code famille ou numéro de commande/);
  assert.match(await paul.page.locator('#join-help').innerText(), /numéro de commande/);
  await paul.page.fill('#join-code', code.toLowerCase());
  assert.strictEqual(await paul.page.inputValue('#join-code'), `${code.slice(0, 4)}-${code.slice(4)}`, 'tiret ajouté tout seul');
  await g.doubleAppui(paul, '#form-join button[type=submit]');
  await g.attendreVue(paul, 'view-home', 30_000);
  assert.strictEqual(g.nbAppels('entrerParCommande'), 1, 'double appui : un seul appel');
  assert.strictEqual(await paul.page.evaluate(() => localStorage.getItem('papote.fid')), fid);
  await s.calme();
  const fam = await g.lire(`families/${fid}`);
  const fiche = await g.lire(`families/${fid}/members/${fam.createdBy}`);
  assert.strictEqual(fiche && fiche.email, 'paul.perso@exemple.fr', 'Paul responsable de sa famille');
  assert.strictEqual(fiche.status, 'active');
  // Responsable : « Comment appelez-vous la personne ? » l'attend, rien ne passe devant (A43).
  await paul.page.locator('#nom-prepare').waitFor({ state: 'visible' });
  assert.strictEqual(await paul.page.locator('.guide-back').count(), 0);
  assert.strictEqual((await s.db.collection('families').get()).size, 1, 'jamais une deuxième famille');
});

test('A40 : code inconnu, puis trop d\'essais dans la journée : un message clair, on reste sur la page', async () => {
  const { abonnement: id } = await acteurs.commanderEtPayer({ email: 'paul@travail.fr' });
  const { code } = await g.lire(`commandes/${id}`);
  const eve = await banc.telephone('Ève');
  await g.inscrire(eve, 'eve@exemple.fr', 'Ève');
  await g.attendreVue(eve, 'view-join', 30_000);
  const essayer = async (saisie) => {
    const avant = g.nbAppels('entrerParCommande');
    await eve.page.fill('#join-code', saisie);
    // Ce que montre le bouton dès le toucher, même si la réponse arrive très vite.
    await eve.page.evaluate(() => {
      const b = document.querySelector('#form-join button[type=submit]');
      window.__textes = [];
      new MutationObserver(() => window.__textes.push(b.textContent)).observe(b, { childList: true, characterData: true, subtree: true });
    });
    await eve.page.click('#form-join button[type=submit]');
    await g.attendreBase(async () => g.nbAppels('entrerParCommande') > avant, 'appel au serveur');
    await eve.page.locator('#form-join button[type=submit]:not([disabled])', { hasText: 'Rejoindre' }).waitFor();
    assert.strictEqual((await eve.page.evaluate(() => window.__textes))[0], 'Un instant…', 'réaction visible tout de suite');
    return eve.page.locator('#join-error').innerText();
  };
  const faux = code === 'ZZZZ2222' ? 'ZZZZ3333' : 'ZZZZ2222';
  for (let i = 0; i < 5; i++) {
    assert.match(await essayer(faux), /aucune famille ni à aucune commande/);
  }
  // Même le bon code : la limite du jour est atteinte.
  assert.match(await essayer(code), /Trop d'essais pour aujourd'hui\. Réessayez demain/);
  assert.strictEqual(await g.vue(eve), 'view-join');
  assert.strictEqual(await eve.page.evaluate(() => localStorage.getItem('papote.fid')), null);
});

// A43 (M4) : pour le premier qui entre dans une famille préparée, dans l'ordre : le nom, puis « Réglons la tablette »
// (nuit 21 h – 6 h 30, son, SOS), puis le petit guide, qui ne parle plus de « Votre proche ».
test('A43 : famille préparée : le nom, puis « Réglons la tablette », puis le petit guide', async () => {
  const julie = await banc.telephone('Julie');
  await g.inscrire(julie, 'julie@exemple.fr', 'Julie');
  const tab = await g.tabletteAllumee({ commande: { email: 'julie@exemple.fr' } });
  const { fid } = await g.lire(`pairings/${tab.code}`);
  const famille = await g.lire(`families/${fid}`);
  assert.ok(famille.options, 'la famille préparée naît avec ses options');
  await g.ouvrir(julie, `?code=${famille.code}`);
  await g.attendreVue(julie, 'view-invited', 30_000);
  await julie.page.locator('#invitations form', { hasText: 'Votre espace famille Papote' }).locator('button[type=submit]').click();
  await g.attendreVue(julie, 'view-home', 30_000);
  // 1. Le nom, seul à l'écran.
  await julie.page.locator('#nom-prepare').waitFor({ state: 'visible' });
  await julie.page.waitForTimeout(1500);
  assert.strictEqual(await julie.page.locator('.guide-back').count(), 0, 'ni réglages ni guide avant le nom');
  assert.doesNotMatch(await julie.page.evaluate(() => document.body.innerText), /Votre proche la voit/);
  await julie.page.fill('#nom-prepare-input', 'Mamie Emma');
  await julie.page.click('#nom-prepare-btn');
  // 2. « Réglons la tablette ».
  const intro = julie.page.locator('.intro-back');
  await intro.waitFor({ timeout: 15_000 });
  assert.strictEqual(await julie.page.locator('.guide-back:not(.intro-back)').count(), 0, 'le guide attend');
  assert.match(await intro.locator('[data-step="0"]').innerText(), /Réglons la tablette[\s\S]*Mamie Emma/);
  await intro.locator('.intro-next').click(); // Commencer
  await intro.locator('[data-step="2"]').waitFor();
  assert.match(await intro.locator('[data-step="2"]').innerText(), /La nuit/);
  assert.ok(await intro.locator('#intro-veille').isChecked());
  assert.strictEqual(await intro.locator('#intro-de').inputValue(), '21:0');
  assert.strictEqual(await intro.locator('#intro-a').inputValue(), '6:30');
  await intro.locator('.intro-next').click();
  await intro.locator('[data-step="3"]').waitFor();
  assert.match(await intro.locator('[data-step="3"]').innerText(), /Le son/);
  await intro.locator('.intro-next').click();
  await intro.locator('[data-step="4"]').waitFor();
  assert.ok(await intro.locator('#intro-sos').isChecked(), 'SOS allumé, comme la famille préparée');
  await intro.locator('.intro-next').click(); // enregistre
  await intro.locator('[data-step="5"]').waitFor();
  await g.attendreBase(async () => (await g.lire(`families/${fid}`)).veille, 'nuit enregistrée');
  const reglee = await g.lire(`families/${fid}`);
  assert.deepStrictEqual(reglee.veille, { active: true, de: 21, a: 6, aMin: 30 });
  assert.strictEqual(reglee.options.sos, true);
  assert.strictEqual(reglee.options.meteo, true, 'les autres options de départ sont gardées');
  await intro.locator('.intro-prev').click(); // Terminer
  // 3. Le petit guide, avec le nom ; la tablette n'est pas encore arrivée.
  const guide = julie.page.locator('.guide-back:not(.intro-back)');
  await guide.waitFor();
  assert.strictEqual(await julie.page.locator('.intro-back').count(), 0);
  const texte = await guide.innerText();
  assert.match(texte, /Mamie Emma la verra sur sa tablette dès son arrivée/);
  assert.doesNotMatch(texte, /Votre proche/);
  for (let i = 0; i < 3; i++) await guide.locator('.guide-next').click();
  await guide.waitFor({ state: 'detached' });
  // Rouverte : ni réglages ni guide une deuxième fois.
  await julie.page.reload();
  await g.attendreVue(julie, 'view-home', 30_000);
  await julie.page.waitForTimeout(1500);
  assert.strictEqual(await julie.page.locator('.guide-back').count(), 0);
});

// A43 : dans la liste des membres, les responsables voient l'adresse e-mail de chaque proche (pour retirer un doublon),
// un simple proche non.
test('A43 : les e-mails des proches visibles des responsables seulement', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const paul = await banc.telephone('Paul');
  await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });
  await g.ouvrirTuile(julie, 'settings');
  await julie.page.locator('#members li', { hasText: 'Paul' }).locator('.member-email', { hasText: 'paul@exemple.fr' }).waitFor();
  await julie.page.locator('#members li', { hasText: 'Julie' }).locator('.member-email', { hasText: 'julie@exemple.fr' }).waitFor();
  assert.strictEqual(await julie.page.locator('#members .member-email').count(), 2, 'la tablette n\'a pas d\'adresse');
  await g.verifierLargeur(julie, 'liste des membres');
  await g.ouvrirTuile(paul, 'settings');
  await paul.page.locator('#members li', { hasText: 'Julie' }).waitFor();
  assert.strictEqual(await paul.page.locator('#members .member-email').count(), 0, 'un simple proche ne voit pas les adresses');
  assert.doesNotMatch(await paul.page.locator('#members').innerText(), /@/);
  // Paul devient responsable : il les voit aussitôt.
  await s.db.doc(`families/${fid}`).update({ admins: [paul.uid] });
  await paul.page.locator('#members .member-email', { hasText: 'julie@exemple.fr' }).waitFor();
});
