// Première mise en route par une famille (audit du 12/11/2026, décisions de Tanguy du 12/11), dans la vraie appli.
// Rapport : /mnt/project-files/audit/mise-en-route-12-11/rapport.md (M1 = A40, M2 = A29, M4 = A43, M5, M8).
// A40 (entrée par le numéro de commande) est retiré depuis A53 (Tanguy 16/11) : il ne fait plus entrer.

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
  assert.match(await lea.page.locator('#moi-error').innerText(), /Cochez « Je n'ai pas de numéro, ou un numéro étranger »/);
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
test('M5 : sans la case, « Continuer » a l\'air grisé tant que le portable manque, et l\'appui dit ce qui manque', async () => {
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
  const grise = () => paul.page.locator('#form-moi button[type=submit]').evaluate((b) => b.classList.contains('incomplet'));
  assert.ok(await grise(), 'portable manquant');
  // Grisé mais touchable (audit 17/11, V11) : l'appui dit ce qui manque, rien ne part.
  await paul.page.click('#form-moi button[type=submit]');
  await paul.page.locator('#moi-error', { hasText: 'Indiquez votre numéro de portable.' }).waitFor();
  assert.strictEqual(await g.vue(paul), 'view-moi');
  await paul.page.click('label.moi-sans-tel');
  assert.ok(!(await grise()));
  await paul.page.click('label.moi-sans-tel');
  assert.ok(!(await paul.page.locator('#moi-tel').isDisabled()), 'décochée : le champ revient');
  assert.ok(await grise());
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
  // V13 (testeur, 17/11) : le numéro n'est jamais coupé en fin de ligne, même sur un petit écran.
  const taille = julie.page.viewportSize();
  for (const largeur of [320, 360, 390]) {
    await julie.page.setViewportSize({ width: largeur, height: taille.height });
    const lignes = await julie.page.locator('#contact-texte .numero').evaluate((e) => new Set([...e.getClientRects()].map((r) => Math.round(r.top))).size);
    assert.strictEqual(lignes, 1, `numéro sur une seule ligne à ${largeur} px`);
  }
  await julie.page.setViewportSize(taille);
  // Les deux boutons ont la même taille.
  const [b1, b2] = await Promise.all(['#contact-oui', '#contact-fait'].map((id) => julie.page.locator(id).boundingBox()));
  assert.ok(Math.abs(b1.height - b2.height) < 1 && Math.abs(b1.width - b2.width) < 2, `boutons de même taille (${b1.width}×${b1.height}, ${b2.width}×${b2.height})`);
  // « Enregistrer le numéro » : la fiche contact part tout de suite, la carte se ferme ensuite.
  const telechargement = julie.page.waitForEvent('download');
  await julie.page.click('#contact-oui');
  assert.strictEqual(await julie.page.locator('#contact-oui').innerText(), 'Un instant…', 'réaction visible tout de suite');
  const fichier = await telechargement;
  if (banc.WEBKIT) {
    // iPhone : la fiche s'ouvre directement (Safari affiche la fiche Apple), sans nom de fichier ; le WebKit de
    // Playwright, qui ne sait pas l'afficher, la reçoit en téléchargement sans nom. On vérifie donc son contenu.
    const contenu = require('node:fs').readFileSync(await fichier.path(), 'utf8');
    assert.match(contenu, /^BEGIN:VCARD/);
    assert.match(contenu, /FN:Mamie Emma \(Papote\)/);
    assert.match(contenu, /TEL;TYPE=CELL:\+33698765432/);
  } else {
    assert.match(fichier.suggestedFilename(), /Mamie Emma\.vcf/);
  }
  if (banc.WEBKIT) {
    // iPhone : la fiche Apple s'ouvre, aucune fenêtre de l'app.
    assert.strictEqual(await julie.page.locator('.dialog-back:not(.closing) .dialog').count(), 0, 'aucune fenêtre à fermer');
  } else {
    // Android (Tanguy, 27/11) : 3 étapes qui passent par la notification ou l'app Fichiers, plus de « Ouvrir en bas ».
    const txt = await g.texteFenetre(julie);
    assert.match(txt, /Enregistrer Mamie Emma/);
    assert.match(txt, /Ouvrez vos notifications/);
    assert.match(txt, /Touchez « Mamie Emma\.vcf »/);
    assert.match(txt, /Choisissez Contacts/);
    assert.doesNotMatch(txt, /en bas de l'écran/);
    await g.repondre(julie, 'Compris');
  }
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
  assert.strictEqual(await g.vue(paul), 'view-join', 'toujours « Rejoindre une famille »');
  assert.strictEqual(await paul.page.locator('#join-title').innerText(), 'Rejoindre une famille', 'pas « Vous êtes invité » : personne ne l\'a invité (V7)');
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

// A53 (Tanguy 16/11) : le numéro de commande ne fait plus entrer dans une famille (il est sur la facture et les
// e-mails, et rendait n'importe qui responsable). Tapé dans « Rejoindre une famille », un numéro de commande valide est
// refusé comme un code inconnu, sans appel au serveur ; un double appui ne fait qu'une tentative.
test('A53 : numéro de commande dans « Rejoindre une famille » : refusé, sans appel au serveur, une seule tentative', async () => {
  const { abonnement: id } = await acteurs.commanderEtPayer({ email: 'paul@travail.fr' });
  const { fid, code } = await g.lire(`commandes/${id}`);
  const paul = await banc.telephone('Paul');
  await g.inscrire(paul, 'paul.perso@exemple.fr', 'Paul');
  await g.attendreVue(paul, 'view-join', 30_000);
  assert.doesNotMatch(await paul.page.locator('#join-code-wrap').innerText(), /commande/i);
  assert.doesNotMatch(await paul.page.locator('#join-help').innerText(), /commande/i);
  await paul.page.fill('#join-code', code.toLowerCase());
  // Ce que montre le bouton dès le toucher, même si la réponse arrive très vite.
  await paul.page.evaluate(() => {
    const b = document.querySelector('#form-join button[type=submit]');
    window.__textes = [];
    new MutationObserver(() => window.__textes.push(b.textContent)).observe(b, { childList: true, characterData: true, subtree: true });
  });
  const appelsAvant = banc.appels.length;
  const refus = () => paul.console.filter((l) => /Code refusé/.test(l)).length;
  await g.doubleAppui(paul, '#form-join button[type=submit]');
  await paul.page.locator('#join-error').waitFor({ state: 'visible' });
  await paul.page.locator('#form-join button[type=submit]:not([disabled])', { hasText: 'Rejoindre' }).waitFor();
  assert.strictEqual(await paul.page.locator('#join-error').innerText(),
    'Ce code ne correspond à aucune famille. Vérifiez-le, ou demandez à la personne qui vous l’a envoyé de vous inviter.');
  assert.strictEqual((await paul.page.evaluate(() => window.__textes))[0], 'Un instant…', 'réaction visible tout de suite');
  await paul.page.waitForTimeout(500);
  assert.strictEqual(refus(), 1, 'double appui : une seule tentative');
  assert.deepStrictEqual(banc.appels.slice(appelsAvant).map((a) => a.nom), [], 'aucun appel au serveur');
  assert.strictEqual(await g.vue(paul), 'view-join');
  assert.strictEqual(await paul.page.evaluate(() => localStorage.getItem('papote.fid')), null);
  await s.calme();
  assert.strictEqual((await g.liste(`families/${fid}/members`)).length, 0, 'personne n\'est entré dans la famille de la commande');
});

// A43 (M4) : pour le premier qui entre dans une famille préparée, dans l'ordre : le nom, puis « Réglons la tablette »
// (nuit 23 h – 5 h par défaut, son, SOS). Une seule fenêtre au démarrage (testeur, V8 du 17/11) : pas de petit guide
// ensuite, et ses boutons ne bougent pas d'une étape à l'autre. Jamais « Votre proche » avec une majuscule (V7).
test('A43 : famille préparée : le nom, puis « Réglons la tablette », une seule fenêtre', async () => {
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
  // V7 : avant le nom, ni « Pour Votre proche » ni « la tablette de Votre proche ».
  assert.strictEqual(await julie.page.locator('#family-title').innerText(), 'Votre espace famille');
  assert.doesNotMatch(await julie.page.evaluate(() => document.body.innerText), /Votre proche/);
  // Un numéro de téléphone à la place du nom (Tanguy, 17/11) : refusé sous le champ, sans appel au serveur.
  for (const numero of ['06 12 34 56 78', '+33612345678', '0612']) {
    await julie.page.fill('#nom-prepare-input', numero);
    await julie.page.click('#nom-prepare-btn');
    await julie.page.locator('#nom-prepare-error', { hasText: 'ressemble à un numéro de téléphone' }).waitFor();
  }
  await julie.page.fill('#nom-prepare-input', 'Mamie 🙂');
  await julie.page.click('#nom-prepare-btn');
  await julie.page.locator('#nom-prepare-error', { hasText: 'émojis' }).waitFor();
  assert.strictEqual(g.nbAppels('nommerFamillePreparee'), 0, 'rien envoyé au serveur');
  const sousLeChamp = await julie.page.evaluate(() => document.getElementById('nom-prepare-error').getBoundingClientRect().top
    - document.getElementById('nom-prepare-input').getBoundingClientRect().bottom);
  assert.ok(sousLeChamp >= 0 && sousLeChamp < 40, `message juste sous le champ (${sousLeChamp} px)`);
  await julie.page.fill('#nom-prepare-input', 'Mamie Emma');
  assert.strictEqual(await julie.page.locator('#nom-prepare-error').isVisible(), false, 'le message part dès qu\'on corrige');
  await julie.page.click('#nom-prepare-btn');
  // 2. « Réglons la tablette ».
  const intro = julie.page.locator('.intro-back');
  await intro.waitFor({ timeout: 15_000 });
  assert.strictEqual(await julie.page.locator('.guide-back:not(.intro-back)').count(), 0, 'le guide attend');
  assert.match(await intro.locator('[data-step="0"]').innerText(), /Réglons la tablette[\s\S]*Une minute\. Tout reste modifiable dans Réglages\./);
  // V8 : le bas de la fenêtre et ses deux boutons (même taille) restent à la même place à chaque étape.
  const place = async () => {
    await julie.page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)).then(() => true));
    const [f, p, n] = await Promise.all(['form', '.intro-prev', '.intro-next'].map((sel) => intro.locator(sel).boundingBox()));
    // La fenêtre prend la hauteur de chaque page (Tanguy, 20/11) et grandit vers le haut : son bas, sa largeur et ses
    // deux boutons restent à la même place.
    return JSON.stringify([[Math.round(f.x), Math.round(f.y + f.height), Math.round(f.width)],
      ...[p, n].map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)])]);
  };
  const depart = await place();
  const [bp, bn] = JSON.parse(depart).slice(1);
  assert.deepStrictEqual(bp.slice(2), bn.slice(2), `deux boutons de même taille : ${depart}`);
  await intro.locator('.intro-next').click(); // Commencer
  await intro.locator('[data-step="2"]').waitFor();
  assert.strictEqual(await place(), depart, 'rien ne bouge sous le doigt (étape 2)');
  assert.match(await intro.locator('[data-step="2"]').innerText(), /La nuit/);
  assert.ok(await intro.locator('#intro-veille').isChecked());
  assert.strictEqual(await intro.locator('#intro-de').inputValue(), '23:0', 'coucher par défaut : 23 h (Tanguy, 17/11)');
  assert.strictEqual(await intro.locator('#intro-a').inputValue(), '5:0', 'réveil par défaut : 5 h');
  // Coucher le soir (19 h à 23 h 30), réveil le matin (5 h à 10 h), comme dans Réglages.
  const bornes = (sel) => intro.locator(`${sel} option`).evaluateAll((os) => [os[0].textContent, os[os.length - 1].textContent, os.length]);
  assert.deepStrictEqual(await bornes('#intro-de'), ['19 h', '23 h 30', 10]);
  assert.deepStrictEqual(await bornes('#intro-a'), ['5 h', '10 h', 11]);
  await intro.locator('.intro-next').click();
  await intro.locator('[data-step="3"]').waitFor();
  assert.match(await intro.locator('[data-step="3"]').innerText(), /Le son/);
  await intro.locator('.intro-next').click();
  await intro.locator('[data-step="4"]').waitFor();
  assert.strictEqual(await place(), depart, 'rien ne bouge sous le doigt (étape des options, la plus longue)');
  assert.ok(await intro.locator('#intro-sos').isChecked(), 'SOS allumé, comme la famille préparée');
  await intro.locator('.intro-next').click(); // enregistre
  await intro.locator('[data-step="5"]').waitFor();
  await g.attendreBase(async () => (await g.lire(`families/${fid}`)).veille, 'nuit enregistrée');
  const reglee = await g.lire(`families/${fid}`);
  assert.deepStrictEqual(reglee.veille, { active: true, de: 23, a: 5 });
  assert.strictEqual(reglee.options.sos, true);
  assert.strictEqual(reglee.options.meteo, true, 'les autres options de départ sont gardées');
  // V7 : la tablette n'est pas encore arrivée : pas « est réglée », les réglages l'attendent.
  assert.strictEqual(await place(), depart, 'rien ne bouge sous le doigt (dernière étape)');
  const fin = await intro.locator('[data-step="5"]').innerText();
  assert.match(fin, /C'est noté[\s\S]*a tablette de Mamie Emma prendra ces réglages dès son arrivée/);
  assert.doesNotMatch(fin, /est réglée|C'est prêt/);
  await intro.locator('.intro-prev').click(); // Terminer
  // 3. Pas de deuxième fenêtre : l'accueil, tout simplement.
  await intro.waitFor({ state: 'detached' });
  await julie.page.waitForTimeout(1000);
  assert.strictEqual(await julie.page.locator('.guide-back').count(), 0, 'pas de petit guide après les réglages');
  await julie.page.locator('#photo-nudge').waitFor({ state: 'visible' });
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
  await g.ouvrirFamille(julie);
  await julie.page.locator('#members li', { hasText: 'Paul' }).locator('.member-email', { hasText: 'paul@exemple.fr' }).waitFor();
  await julie.page.locator('#members li', { hasText: 'Julie' }).locator('.member-email', { hasText: 'julie@exemple.fr' }).waitFor();
  assert.strictEqual(await julie.page.locator('#members .member-email').count(), 2, 'la tablette n\'a pas d\'adresse');
  await g.verifierLargeur(julie, 'liste des membres');
  await g.ouvrirFamille(paul);
  await paul.page.locator('#members li', { hasText: 'Julie' }).waitFor();
  assert.strictEqual(await paul.page.locator('#members .member-email').count(), 0, 'un simple proche ne voit pas les adresses');
  assert.doesNotMatch(await paul.page.locator('#members').innerText(), /@/);
  // Paul devient responsable : il les voit aussitôt.
  await s.db.doc(`families/${fid}`).update({ admins: [paul.uid] });
  await paul.page.locator('#members .member-email', { hasText: 'julie@exemple.fr' }).waitFor();
});

// V7 et V8 (testeur, 17/11) : la tablette est arrivée pendant les réglages : « C'est prêt », « est réglée ». Un
// proche qui entre ensuite voit le petit guide, seule fenêtre, ses deux boutons de même taille et toujours à la même
// place.
test('V7, V8 : « C\'est prêt » seulement quand la tablette est là ; le petit guide d\'un proche ne bouge pas', async () => {
  const julie = await banc.telephone('Julie');
  await g.inscrire(julie, 'julie@exemple.fr', 'Julie');
  const tab = await g.tabletteAllumee({ commande: { email: 'julie@exemple.fr' } });
  const fid = await g.entrerFamillePreparee(julie, tab, { accueil: false });
  const intro = julie.page.locator('.intro-back');
  await intro.waitFor({ timeout: 10_000 });
  await acteurs.entrerDansLaFamille(tab);
  await julie.page.locator('#tablette-en-route').waitFor({ state: 'hidden' });
  for (let i = 0; i < 4; i++) await intro.locator('.intro-next').click();
  await intro.locator('[data-step="5"]').waitFor();
  assert.match(await intro.locator('[data-step="5"]').innerText(), /C'est prêt[\s\S]*Invitez la famille pour qu'elle envoie des photos\./);
  await intro.locator('.intro-prev').click(); // Terminer
  await intro.waitFor({ state: 'detached' });
  await julie.page.waitForTimeout(800);
  assert.strictEqual(await julie.page.locator('.guide-back').count(), 0, 'une seule fenêtre au démarrage');

  const { code } = await g.lire(`families/${fid}`);
  const paul = await banc.telephone('Paul');
  await g.inscrire(paul, 'paul@exemple.fr', 'Paul', { genre: 'homme', suite: `?code=${code}` });
  await g.attendreVue(paul, 'view-join');
  await paul.page.click('#form-join button[type=submit]');
  await g.attendreVue(paul, 'view-pending');
  await julie.page.locator('#pending-banner .join-card', { hasText: 'Paul' }).locator('.join-ok').click();
  await g.repondre(julie, 'Accepter'); // la question « Accepter … dans la famille ? » (23/11)
  await g.attendreVue(paul, 'view-home');
  const guide = paul.page.locator('.guide-back');
  await guide.waitFor();
  assert.strictEqual(await guide.count(), 1, 'une seule fenêtre');
  const place = async () => (await paul.page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)).then(() => true))) && JSON.stringify(await Promise.all(['.guide', '.guide-skip', '.guide-next'].map(async (sel) => {
    const b = await guide.locator(sel).boundingBox();
    return b && [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
  })));
  const depart = await place();
  const [, skip, suivant] = JSON.parse(depart);
  assert.deepStrictEqual(skip.slice(2), suivant.slice(2), `deux boutons de même taille : ${depart}`);
  await guide.locator('.guide-next').click();
  assert.strictEqual(await place(), depart, 'étape 2 : rien ne bouge');
  await guide.locator('.guide-next').click();
  // Dernière étape : « Passer » s'efface.
  assert.strictEqual(await guide.locator('.guide-skip').isVisible(), false);
  const fin = JSON.parse(await place());
  // Tanguy, 27/11 : « C'est parti » restait seul à droite. Il prend toute la largeur (de la gauche de « Passer » à la
  // droite de « Suivant »), à la même hauteur ; la fenêtre ne bouge pas.
  assert.deepStrictEqual(fin[0], JSON.parse(depart)[0], 'la fenêtre ne bouge pas');
  assert.deepStrictEqual([fin[2][0], fin[2][1], fin[2][0] + fin[2][2], fin[2][3]], [skip[0], suivant[1], suivant[0] + suivant[2], suivant[3]], '« C\'est parti » sur toute la largeur');
  // L'icône est au milieu de la fenêtre (elle était collée à gauche).
  const milieux = await guide.evaluate((b) => { const f = b.querySelector('.guide').getBoundingClientRect(); const i = b.querySelector('.guide-icon').getBoundingClientRect(); return [Math.round(f.left + f.width / 2), Math.round(i.left + i.width / 2)]; });
  assert.ok(Math.abs(milieux[0] - milieux[1]) <= 1, `icône au milieu : ${milieux}`);
  assert.strictEqual(await guide.locator('.guide-next').innerText(), "C'est parti");
  await guide.locator('.guide-next').click();
  await guide.waitFor({ state: 'detached' });
});
