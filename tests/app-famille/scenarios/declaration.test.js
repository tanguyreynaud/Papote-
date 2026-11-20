// Déclaration guidée dans la bulle d'aide (chantier 3 du chat, Tanguy 18/11) : quand l'assistant passe la main dans
// l'appli, la bulle propose une petite demande (motif, questions, 1 à 3 photos) au lieu de « laissez votre téléphone
// et votre e-mail ». Vraie bulle (vitrine/chat-support.js et chat-declaration.js de main), vraie fonction
// declarationChat (functions/declaration.js de main) ; seule la réponse de l'IA est jouée ici (pas d'Anthropic).
// Vraie vie : réponses relues après fermeture de la bulle, photos réduites (4000 px → 1600 px), réseau coupé puis
// « Réessayer », double appui, réponse perdue après l'enregistrement : toujours UNE déclaration et UN e-mail ;
// tout arrive dans l'admin (Clients > Déclarations) avec l'état de la tablette, les photos s'y ouvrent, « Marquer
// traitée » en double clic = un seul appel.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const banc = require('../banc');
const g = require('../gestes');

const { s, acteurs: a } = banc;
const GSTATIC = 'https://www.gstatic.com/firebasejs/12.19.0/';
const FONCTIONS = process.env.PAPOTE_FONCTIONS || path.join(__dirname, '..', '.fonctions', 'functions');
const VITRINE = process.env.PAPOTE_VITRINE || path.join(FONCTIONS, '..', 'vitrine');
const API = 'https://europe-west1-papote-famille.cloudfunctions.net/';
const EQUIPE = 'contact@mapapote.fr';

// Tant que main n'a pas la déclaration, rien à essayer (dit dans le compte rendu, jamais en silence).
const PRET = fs.existsSync(path.join(VITRINE, 'chat-declaration.js')) && fs.existsSync(path.join(FONCTIONS, 'declaration.js'));
const SANS = PRET ? false : 'main n\'a pas encore functions/declaration.js et vitrine/chat-declaration.js (PAPOTE_FONCTIONS / PAPOTE_VITRINE pour les essayer avant)';
if (SANS) console.log(`# NON COUVERT : ${SANS}`);

banc.brancher();

// Stockage simulé des fonctions (simulation.js) : il note les chemins ; ici il garde aussi le contenu, pour que
// l'admin puisse rouvrir les photos (gestionDeclarations, action « photo »).
const contenus = new Map();
{
  const seauSimule = banc.admin.storage().bucket();
  const seau = {
    ...seauSimule,
    file: (nom) => ({
      ...seauSimule.file(nom),
      save: async (octets, options) => { contenus.set(nom, Buffer.from(octets)); return seauSimule.file(nom).save(octets, options); },
      download: async () => {
        if (!contenus.has(nom)) throw new Error(`absent : ${nom}`);
        return [contenus.get(nom)];
      },
    }),
  };
  Object.defineProperty(banc.admin, 'storage', { value: () => ({ bucket: () => seau }), configurable: true });
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'POST, OPTIONS' };

/**
 * La bulle servie par « mapapote.fr » dans l'app, l'IA jouée (elle passe la main), declarationChat branchée sur la
 * vraie fonction. reglage.perdre = n : les n prochaines réponses de declarationChat sont perdues APRÈS le passage au
 * serveur (réseau qui lâche au retour). Renvoie { envois } : les corps reçus par declarationChat.
 */
async function bulle(t, reglage = {}) {
  const envois = [];
  const code = (f) => fs.readFileSync(path.join(VITRINE, f), 'utf8');
  await t.context.route('https://mapapote.fr/chat-support.js', (r) => r.fulfill({
    status: 200, headers: { 'content-type': 'text/javascript' },
    // Le banc sert l'app sur localhost : la bulle doit s'y croire dans l'appli.
    body: code('chat-support.js').replace("'app.mapapote.fr']", "'app.mapapote.fr', 'localhost']"),
  }));
  await t.context.route('https://mapapote.fr/chat-declaration.js', (r) => r.fulfill({ status: 200, headers: { 'content-type': 'text/javascript' }, body: code('chat-declaration.js') }));
  await t.context.route(`${API}supportChat`, (r) => (r.request().method() === 'OPTIONS'
    ? r.fulfill({ status: 204, headers: CORS })
    : r.fulfill({
      status: 200, headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify({ reponse: 'Je suis désolé pour la tablette. Remplissez la petite demande juste en dessous : l\'équipe s\'en occupe.', contact: true }),
    })));
  await t.context.route(`${API}declarationChat`, async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    // Réseau du téléphone coupé (reglage.coupe) : la requête n'arrive nulle part.
    if (reglage.coupe) return r.abort('internetdisconnected');
    const corps = JSON.parse(r.request().postData());
    envois.push(corps);
    const rep = await s.requete('declarationChat', { corps, entetes: { authorization: r.request().headers().authorization || '' } });
    if (reglage.perdre > 0) {
      reglage.perdre -= 1;
      return r.abort('connectionreset');
    }
    return r.fulfill({ status: rep.statut, headers: { ...CORS, 'content-type': 'application/json' }, body: rep.texte });
  });
  return { envois };
}

// La bulle est branchée avant la première ouverture de l'app (le script est demandé au chargement de la page).
async function familleAvecTablette(email, reglage = {}) {
  reglage.coupe = false;
  const julie = await banc.telephone('Julie');
  const { envois } = await bulle(julie, reglage);
  const { fid } = await g.familleInstallee(julie, { email, prenom: 'Julie' });
  const tablette = (await g.liste(`families/${fid}/members`)).find((m) => m.role === 'tablette');
  // Ce que la tablette envoie avec son signal « en ligne » : batterie, carte SIM, version.
  await s.db.doc(`families/${fid}/members/${tablette.id}`).set({
    lastOnline: s.Timestamp.fromMillis(Date.now() - 4 * 60e3), battery: { level: 37, charging: false },
    sim: { reseau: 'Bouygues Telecom', signal: 3, dataMoisMo: 612 }, appVersion: '2.99.130',
  }, { merge: true });
  return { julie, fid, tablette, envois };
}

async function ouvrirChat(t, question) {
  await g.ouvrirProfil(t);
  await g.attendreVue(t, 'view-profile');
  await t.page.click('#view-profile .aide-card');
  await g.attendreVue(t, 'view-support');
  // « Besoin d'aide ? » ouvre l'assistant tout de suite (Tanguy, 20/11 : plus de bulle flottante).
  await t.page.locator('.ps-panneau textarea').waitFor({ state: 'visible' });
  await t.page.locator('.ps-panneau textarea').fill(question);
  await t.page.locator('.ps-panneau textarea').press('Enter');
  await t.page.locator('.ps-decl').waitFor({ state: 'visible' });
}

const carte = (t) => t.page.locator('.ps-decl');
const toucher = (t, texte) => carte(t).getByRole('button', { name: texte, exact: true }).click();
const erreur = (t) => carte(t).locator('.ps-erreur').innerText();

async function ajouterPhotos(t, fichiers) {
  const [choix] = await Promise.all([t.page.waitForEvent('filechooser'), carte(t).locator('.ps-d-ajout').click()]);
  assert.ok(choix.isMultiple(), 'plusieurs photos d\'un coup');
  await choix.setFiles(fichiers);
}

const vignettes = (t) => carte(t).locator('.ps-d-vignette img');
const declarations = async () => (await s.db.collection('declarations').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const mailsEquipe = () => s.boite.filter((m) => m.a === EQUIPE && /^Déclaration/.test(m.sujet));

/** Largeur et hauteur d'une photo envoyée (base64 JPEG), lues par un navigateur. */
async function taille(base64) {
  const page = await g.pageAtelier();
  return page.evaluate(async (b) => {
    const blob = await (await fetch(`data:image/jpeg;base64,${b}`)).blob();
    const i = await createImageBitmap(blob);
    return [i.width, i.height];
  }, base64);
}

test('écran fissuré : questions, photos réduites, bulle refermée puis rouverte, réseau coupé, double appui = une seule demande', { skip: SANS }, async () => {
  const reglage = {};
  const { julie, fid, envois } = await familleAvecTablette('julie.casse@exemple.fr', reglage);
  await ouvrirChat(julie, 'L\'écran de la tablette est fissuré');
  assert.strictEqual(await julie.page.locator('.ps-rappel').count(), 0, 'plus de « laissez votre téléphone » dans l\'appli');

  await toucher(julie, 'Écran fissuré ou cassé');
  await toucher(julie, 'Envoyer la demande');
  assert.match(await erreur(julie), /Répondez à « Que s’est-il passé/);
  await toucher(julie, 'Une chute');
  await toucher(julie, 'Oui, mais l’écran répond mal');
  assert.strictEqual(await carte(julie).getByRole('button', { name: 'Une chute', exact: true }).getAttribute('aria-pressed'), 'true');
  await toucher(julie, 'Envoyer la demande');
  assert.match(await erreur(julie), /au moins une photo/);

  // Deux photos d'un coup (une très grande), une retirée, une autre ajoutée.
  await ajouterPhotos(julie, [await g.photo({ largeur: 4000, hauteur: 3000, texte: 'Fissure' }), await g.photo({ texte: 'Dos' })]);
  await g.attendreBase(async () => (await vignettes(julie).count()) === 2, 'deux vignettes');
  // Ordre du choix gardé (la petite est prête avant la grande) : la 2e retirée est bien « Dos ».
  await carte(julie).getByRole('button', { name: 'Retirer la photo 2' }).click();
  assert.strictEqual(await vignettes(julie).count(), 1);
  await ajouterPhotos(julie, [await g.photo({ texte: 'Coin' })]);
  await g.attendreBase(async () => (await vignettes(julie).count()) === 2, 'photo ajoutée');
  await carte(julie).locator('textarea').fill('Tombée du buffet ce matin.');
  // Image du formulaire rempli, pour la relecture (captures/).
  fs.mkdirSync(path.join(__dirname, '..', 'captures'), { recursive: true });
  await carte(julie).screenshot({ path: path.join(__dirname, '..', 'captures', `declaration-formulaire-${banc.MOTEUR}.png`) });

  // Bulle fermée puis rouverte : tout est encore là.
  await julie.page.locator('.ps-panneau .ps-tete button').click();
  await julie.page.click('#support-assistant');
  await carte(julie).waitFor({ state: 'visible' });
  assert.strictEqual(await vignettes(julie).count(), 2, 'photos gardées');
  assert.strictEqual(await carte(julie).locator('textarea').inputValue(), 'Tombée du buffet ce matin.');
  assert.strictEqual(await carte(julie).getByRole('button', { name: 'Une chute', exact: true }).getAttribute('aria-pressed'), 'true');

  // Réseau coupé : un mot clair, « Réessayer », rien d'enregistré.
  await g.reseau(julie, true);
  reglage.coupe = true;
  await toucher(julie, 'Envoyer la demande');
  await carte(julie).getByRole('button', { name: 'Réessayer' }).waitFor();
  assert.match(await erreur(julie), /connexion internet/);
  assert.strictEqual((await declarations()).length, 0);

  // Réseau revenu : double appui sur « Réessayer » → une seule demande.
  banc.tolerer(julie, /declarationChat/);
  await g.reseau(julie, false);
  reglage.coupe = false;
  await g.doubleAppui(julie, '.ps-decl .ps-d-envoyer');
  await julie.page.locator('.ps-msg', { hasText: 'C’est envoyé' }).waitFor();
  assert.match(await julie.page.locator('.ps-msg', { hasText: 'C’est envoyé' }).innerText(), /avec vos 2 photos.*48 h/s);
  await s.calme();
  assert.strictEqual(envois.length, 1, 'un seul envoi au serveur');
  const [d] = await declarations();
  assert.strictEqual((await declarations()).length, 1);
  assert.strictEqual(d.motif, 'ecran');
  assert.strictEqual(d.fid, fid);
  assert.deepStrictEqual(d.reponses.map((r) => r.reponse), ['Une chute', 'Oui, mais l’écran répond mal']);
  assert.strictEqual(d.message, 'Tombée du buffet ce matin.');
  assert.strictEqual(d.auteur.email, 'julie.casse@exemple.fr');
  assert.strictEqual(d.tablette.batterie, 37);
  assert.strictEqual(d.tablette.enCharge, false);
  assert.strictEqual(d.tablette.version, '2.99.130');
  assert.match(d.tablette.reseau, /Bouygues Telecom, signal 3\/4/);
  assert.strictEqual(d.photos.length, 2);
  for (const p of d.photos) assert.ok(s.fichiersGardes.includes(p.chemin), `photo rangée : ${p.chemin}`);
  assert.ok(d.photos.every((p) => p.chemin.startsWith(`families/${fid}/declarations/${d.id}/`)));
  assert.ok(d.conversation.some((m) => /fissuré/.test(m.content)), 'la conversation arrive avec');

  // Photos réduites avant l'envoi : 4000 x 3000 → 1600 x 1200.
  assert.deepStrictEqual(await taille(envois[0].photos[0]), [1600, 1200]);
  assert.ok(envois[0].photos.every((p) => p.length < 700_000), 'chaque photo pèse moins de 500 Ko');

  // Un e-mail à l'équipe (photos jointes, réponse directe à Julie), un accusé à Julie.
  assert.strictEqual(mailsEquipe().length, 1);
  assert.deepStrictEqual(mailsEquipe()[0].pieces, ['photo-1.jpg', 'photo-2.jpg']);
  assert.ok(s.boite.some((m) => m.a === 'julie.casse@exemple.fr' && /Bien reçu/.test(m.sujet)));
  assert.ok(!s.boite.some((m) => /Tanguy/.test(`${m.sujet} ${m.texte}`)), 'jamais le prénom de l\'équipe');

  // Fermer le chat : la conversation repart de zéro.
  await julie.page.getByRole('button', { name: 'Fermer le chat' }).click();
  await julie.page.click('#support-assistant');
  assert.strictEqual(await julie.page.locator('.ps-decl').count(), 0);
});

test('réponse perdue après l\'enregistrement : « Réessayer » ne crée ni 2e demande ni 2e e-mail ; chargeur : le conseil d\'abord ; panne sans photo', { skip: SANS }, async () => {
  const { julie, envois } = await familleAvecTablette('julie.panne@exemple.fr', { perdre: 1 });
  await ouvrirChat(julie, 'La tablette ne charge plus');

  // Chargeur, « Pas encore » essayé un autre : le conseil s'affiche (n'importe quel USB-C).
  await toucher(julie, 'Chargeur perdu ou abîmé');
  await toucher(julie, 'Il ne charge plus');
  await toucher(julie, 'Pas encore');
  assert.match(await carte(julie).locator('.ps-d-conseil:visible').innerText(), /n’importe quel chargeur et câble USB-C/);
  // Finalement c'est une panne : on change de motif, les réponses repartent de zéro.
  await toucher(julie, 'Ce n’est pas ça ? Changer');
  await toucher(julie, 'Panne, malgré les essais');
  await toucher(julie, 'Écran noir');
  await toucher(julie, 'Redémarrer depuis l’appli');
  await toucher(julie, 'Un autre chargeur');
  await toucher(julie, 'Envoyer la demande');

  // Le serveur a enregistré, mais la réponse n'est pas arrivée.
  await carte(julie).getByRole('button', { name: 'Réessayer' }).waitFor();
  await s.calme();
  assert.strictEqual((await declarations()).length, 1);
  banc.tolerer(julie, /ERR_CONNECTION_RESET.*declarationChat/);
  await toucher(julie, 'Réessayer');
  await julie.page.locator('.ps-msg', { hasText: 'C’est envoyé' }).waitFor();
  await s.calme();
  assert.strictEqual(envois.length, 2);
  assert.strictEqual(envois[0].cle, envois[1].cle, 'même clé au nouvel essai');
  const ds = await declarations();
  assert.strictEqual(ds.length, 1, 'une seule demande');
  assert.strictEqual(ds[0].motif, 'panne');
  assert.deepStrictEqual(ds[0].reponses.map((r) => r.reponse), ['Écran noir', 'Redémarrer depuis l’appli, Un autre chargeur']);
  assert.strictEqual(ds[0].photos.length, 0);
  assert.strictEqual(mailsEquipe().length, 1, 'un seul e-mail à l\'équipe');
});

test('sans connexion à l\'appli, le serveur refuse ; un autre compte ne peut pas déclarer pour une famille qui n\'est pas la sienne', { skip: SANS }, async () => {
  const { julie, fid } = await familleAvecTablette('julie.refus@exemple.fr');
  const sansJeton = await s.requete('declarationChat', { corps: { famille: fid, cle: 'abcdefghijkl1234', motif: 'panne', message: 'x' } });
  assert.strictEqual(sansJeton.statut, 401);
  const intrus = await s.compte('Intrus', 'intrus@exemple.fr');
  const jeton = await jetonDe(intrus.uid);
  const autre = await s.requete('declarationChat', { corps: { famille: fid, cle: 'abcdefghijkl1234', motif: 'panne', message: 'x' }, entetes: { authorization: `Bearer ${jeton}` } });
  assert.strictEqual(autre.statut, 401);
  assert.strictEqual((await declarations()).length, 0);
  await julie.context.close();
});

/** Jeton de connexion d'un compte, donné par l'émulateur Auth. */
async function jetonDe(uid) {
  const personnalise = await banc.admin.auth().createCustomToken(uid);
  const au = banc.hote('FIREBASE_AUTH_EMULATOR_HOST');
  const r = await fetch(`http://${au.h}:${au.p}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=cle-de-test`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: personnalise, returnSecureToken: true }),
  });
  return (await r.json()).idToken;
}

test('admin : la déclaration arrive complète (tablette, réponses, photos qui s\'ouvrent) ; « Marquer traitée » en double clic = un appel', { skip: SANS }, async () => {
  const { julie } = await familleAvecTablette('julie.admin@exemple.fr');
  await ouvrirChat(julie, 'Le colis est arrivé abîmé');
  await toucher(julie, 'Colis abîmé ou incomplet');
  await toucher(julie, 'Le carton est abîmé');
  await toucher(julie, 'Il manque quelque chose');
  await carte(julie).locator('input[type=text]').fill('le câble');
  await ajouterPhotos(julie, [await g.photo({ texte: 'Carton' })]);
  await g.attendreBase(async () => (await vignettes(julie).count()) === 1, 'vignette');
  await toucher(julie, 'Envoyer la demande');
  await julie.page.locator('.ps-msg', { hasText: 'C’est envoyé' }).waitFor();
  await s.calme();

  // L'admin, connectée avec le badge.
  await banc.admin.auth().createUser({ uid: a.TANGUY.uid, email: a.TANGUY.email, emailVerified: true, displayName: 'Admin' }).catch(() => {});
  const jeton = await banc.admin.auth().createCustomToken(a.TANGUY.uid, { admin: true });
  const adm = await banc.telephone('admin', { largeur: 1280, hauteur: 900 });
  await adm.context.route('**/version.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  const ouvertes = [];
  adm.context.on('page', (p) => { if (p !== adm.page) { ouvertes.push(p.url()); p.close().catch(() => {}); } });
  await adm.page.goto(`${banc.origine}/admin.html#clients/declarations`);
  await adm.page.evaluate(async ({ jeton: j, G }) => {
    const { getApp } = await import(`${G}firebase-app.js`);
    const { getAuth, signInWithCustomToken } = await import(`${G}firebase-auth.js`);
    await signInWithCustomToken(getAuth(getApp('admin')), j);
  }, { jeton, G: GSTATIC });
  const fiche = adm.page.locator('#declarations .decl').first();
  await fiche.waitFor({ state: 'visible', timeout: 20_000 });
  assert.strictEqual(await adm.page.locator('#declarations-n').innerText(), '1', 'pastille : une à traiter');
  const texte = await fiche.innerText();
  for (const attendu of ['Colis abîmé ou incomplet', 'à traiter', 'julie.admin@exemple.fr', 'batterie 37 %, débranchée', 'Bouygues Telecom', 'version 2.99.130',
    'Le carton est abîmé, Il manque quelque chose', 'le câble']) {
    assert.ok(texte.includes(attendu), `la fiche dit « ${attendu} »`);
  }
  // La photo s'affiche et s'ouvre en grand.
  await fiche.locator('.decl-photo img').waitFor({ state: 'visible' });
  await fiche.locator('.decl-photo').click();
  await g.attendreBase(async () => ouvertes.length === 1, 'photo ouverte dans un onglet');

  // Double clic sur « Marquer traitée » : un seul appel, rangée dans « Déjà traitées ».
  const avant = banc.appels.filter((x) => x.nom === 'gestionDeclarations' && x.data.action === 'traiter').length;
  await fiche.getByRole('button', { name: 'Marquer traitée' }).dblclick();
  await adm.page.locator('.decl-anciennes summary', { hasText: 'Déjà traitées (1)' }).waitFor();
  assert.strictEqual(banc.appels.filter((x) => x.nom === 'gestionDeclarations' && x.data.action === 'traiter').length - avant, 1);
  assert.strictEqual((await declarations())[0].statut, 'traitee');
  assert.ok(await adm.page.locator('#declarations-n').isHidden(), 'plus rien à traiter');

  // Un proche sans badge ne lit pas les déclarations.
  await assert.rejects(() => s.appeler('gestionDeclarations', { action: 'lister' }, { uid: 'u-x', email: 'x@exemple.fr' }), /Réservé/);
});
