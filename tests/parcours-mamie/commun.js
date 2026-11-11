// Ce que partagent les scénarios du parcours de Mamie : le banc de l'app famille (émulateurs, vraies fonctions de
// main, vraie app dans un navigateur) + la vraie tablette (tablette-reelle.js).

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../app-famille/banc');
const g = require('../app-famille/gestes');
const tablette = require('./tablette-reelle');

const { s, acteurs } = banc;

/** À appeler une fois par fichier de scénarios. */
function brancher() {
  // Avant la vérification du banc : les tablettes s'éteignent, et une exception dans leur code Java compte.
  let erreursTablette = [];
  test.afterEach(async () => { erreursTablette = await tablette.eteindreTout(); });
  banc.brancher();
  test.afterEach(() => assert.deepStrictEqual(erreursTablette, [], 'erreurs dans l\'appli de la tablette'));
}

/**
 * Le client commande sur le site (Stripe simulé), Tanguy relie une tablette du stock à la commande et l'envoie.
 * Renvoie { tab, commande, mamie } : la tablette est allumée chez Mamie, sur son écran Bienvenue.
 */
async function commandeLivree({ email, etat = {}, heure = null } = {}) {
  const tab = await acteurs.tablettePreparee();
  const mamie = await tablette.allumer({ tab, etat, heure });
  const { abonnement } = await acteurs.commanderEtPayer({ email });
  await acteurs.preparerEtEnvoyer(abonnement, tab);
  tab.commande = abonnement;
  return { tab, commande: abonnement, mamie };
}

/** Pour comprendre un échec : ce que l'appli a dit à la page, son journal, ses réglages, l'écran. */
async function diagnostic(mamie) {
  const statuts = mamie.evenements.filter((e) => e.nom === 'onStatus').map((e) => JSON.stringify(e.data)).slice(-6);
  const envois = JSON.stringify(mamie.envois() || null).slice(0, 1500);
  const journal = await mamie.pont('journal').catch((e) => [String(e)]);
  const reglages = await mamie.pont('reglages').catch(() => ({}));
  ['password', 'callPassword', 'refreshToken'].forEach((k) => delete reglages[k]);
  const ecran = await mamie.page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 400)).catch(() => '?');
  const ponts = await mamie.page.evaluate(() => window.__appels.filter((a) => !/pouls|touched|speak|logError/.test(a.nom)).map((a) => `${a.nom}(${JSON.stringify(a.args).slice(1, 60)})`).slice(-25).join(' ')).catch(() => '?');
  const jumelages = (await g.liste('pairings').catch(() => [])).map((p) => JSON.stringify(p)).join('\n  ');
  return `Jumelages :\n  ${jumelages}\nStatuts : ${statuts.join(' | ')}\nEnvois donnés à la page : ${envois}\nPonts appelés par la page : ${ponts}\nJournal :\n  ${journal.slice(-25).join('\n  ')}\nRéglages : ${JSON.stringify(reglages)}\nÉcran : ${ecran}\nPage : ${mamie.console.filter((l) => !/Détection du visage|BLOCKED_BY_CLIENT/.test(l)).slice(-12).join(' / ')}`;
}

/** Attend qu'un élément de l'écran de Mamie soit visible ; sinon l'échec dit où en est la tablette. */
async function chezMamie(mamie, selecteur, delai = 40_000) {
  try {
    await mamie.page.locator(selecteur).first().waitFor({ state: 'visible', timeout: delai });
  } catch (e) {
    throw new Error(`Écran de Mamie : « ${selecteur} » attendu en vain.\n${await diagnostic(mamie)}`);
  }
}

/** Sur la tablette neuve : « Commencer », puis elle entre seule dans la famille de sa commande. Renvoie l'id de la famille. */
async function brancherChezMamie(mamie) {
  await mamie.page.locator('button', { hasText: 'Commencer' }).first().click();
  // Étape « Connexion à internet » (sautée d'elle-même avec une carte SIM) : « Continuer ».
  const continuer = mamie.page.locator('button', { hasText: 'Continuer' }).first();
  await continuer.waitFor({ timeout: 15_000 });
  await continuer.click();
  try {
    return await g.attendreBase(async () => (await mamie.pont('reglages')).fid, 'la tablette entre dans sa famille', 40_000);
  } catch (e) {
    throw new Error(`${e.message}\n${await diagnostic(mamie)}`);
  }
}

/**
 * Celui qui a payé ouvre l'appli par le lien de son e-mail, entre dans sa famille et donne le nom de la personne.
 * (Comme gestes.entrerFamillePreparee, mais la tablette est la vraie : personne ne joue son rôle.)
 */
async function entrerDansSaFamille(t, fid, { nom = 'Mamie Emma' } = {}) {
  const famille = await g.lire(`families/${fid}`);
  await g.ouvrir(t, `?code=${famille.code}`);
  await g.attendreVue(t, 'view-invited', 30_000);
  await t.page.locator('#invitations form', { hasText: 'Votre espace famille Papote' })
    .locator('button[type=submit]', { hasText: 'Entrer dans ma famille' }).click();
  await g.attendreVue(t, 'view-home', 30_000);
  await g.fermerAccueil(t);
  await g.visible(t, '#nom-prepare-input').waitFor({ timeout: 20_000 });
  await t.page.fill('#nom-prepare-input', nom);
  await t.page.click('#nom-prepare-btn');
  await g.toast(t, 'Nom enregistré');
  await t.page.locator('#nom-prepare').waitFor({ state: 'hidden' });
  await s.calme();
}

/** Envoie une photo depuis l'app (page Photos), avec sa légende. */
async function envoyerPhoto(t, { texte = 'Coucou', legende = '', fichiers = null } = {}) {
  if ((await g.vue(t)) !== 'view-photos') await g.ouvrirTuile(t, 'photos');
  await t.page.click('.fab[data-add="photo"]');
  await t.page.locator('#sheet-post').waitFor({ state: 'visible' });
  await t.page.setInputFiles('#in-photo-gallery', fichiers || await g.photo({ texte }));
  await g.visible(t, '#btn-send').waitFor();
  if (legende) await t.page.fill('#post-text', legende);
  await t.page.click('#btn-send');
  await g.toast(t, 'Envoyé');
  await t.page.locator('#sheet-post').waitFor({ state: 'hidden' });
  await s.calme();
}

/**
 * Raccourci pour les scénarios d'après l'arrivée : tout le chemin du colis est refait pour de vrai (commande,
 * envoi, « Commencer », le proche entre), puis la tablette est éteinte et rallumée : sa page des appels rejoint
 * alors la famille tout de suite (sinon elle met jusqu'à une minute, voir arrivee.test.js).
 */
async function familleChezMamie({ email = 'julie@exemple.fr', prenom = 'Julie', etat = {}, heure = null } = {}) {
  const julie = await banc.telephone(prenom);
  await g.inscrire(julie, email, prenom, { genre: 'femme' });
  const { mamie, commande, tab } = await commandeLivree({ email, etat, heure });
  const fid = await brancherChezMamie(mamie);
  await entrerDansSaFamille(julie, fid);
  await mamie.rallumer();
  await enDirect(mamie);
  const uid = (await g.liste(`families/${fid}/members`)).find((m) => m.email === email).id;
  return { julie, mamie, fid, tab, commande, uid };
}

/** La page des appels de la tablette écoute sa famille en direct (elle le dit à l'appli : realtime(true)). */
async function enDirect(mamie, delai = 40_000) {
  try {
    await mamie.page.waitForFunction(() => (window.__appels || []).some((a) => a.nom === 'realtime' && a.args[0] === true), null, { timeout: delai });
    // L'écran de démarrage (logo) est parti : Mamie voit son accueil.
    await mamie.page.waitForFunction(() => !document.getElementById('boot'), null, { timeout: 30_000 });
  } catch (e) {
    throw new Error(`La tablette n'écoute pas sa famille en direct.\n${await diagnostic(mamie)}`);
  }
}

/** Double appui du doigt de Mamie, au milieu d'un bouton (même s'il bouge : « Décrocher » bat comme un cœur). */
async function doubleAppui(mamie, selecteur) {
  const b = await mamie.page.locator(selecteur).first().boundingBox();
  if (!b) throw new Error(`Écran de Mamie : « ${selecteur} » introuvable pour le double appui.\n${await diagnostic(mamie)}`);
  const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
  const dessus = await mamie.page.evaluate(([px, py, sel]) => { const e = document.elementFromPoint(px, py); const but = document.querySelector(sel); return !!e && (e === but || but.contains(e)) ? '' : (e ? e.id || e.className || e.tagName : 'rien'); }, [x, y, selecteur]);
  if (dessus) throw new Error(`Écran de Mamie : « ${selecteur} » est recouvert par « ${dessus} ».`);
  await mamie.page.touchscreen.tap(x, y);
  await mamie.page.touchscreen.tap(x, y);
}

/** Le texte affiché en grand chez Mamie (nouvel envoi). */
const enGrand = (mamie) => mamie.texte('#overlay');

module.exports = { test, assert, banc, g, s, acteurs, tablette, brancher, diagnostic, chezMamie, commandeLivree, brancherChezMamie, entrerDansSaFamille, envoyerPhoto, familleChezMamie, enDirect, enGrand, doubleAppui };
