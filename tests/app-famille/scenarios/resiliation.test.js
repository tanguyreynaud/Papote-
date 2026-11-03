// Résilier, garder, annuler la commande, reprendre : avec les gestes de tous les jours (double appui, appui long,
// bouton retour d'Android, page rechargée, clavier ouvert) et un réseau qui lâche à chaque étape.
// Règle de l'app : chaque bouton montre tout de suite qu'il est touché, puis un résultat clair ; rien ne part
// deux fois au serveur ; jamais de fenêtre grise du navigateur.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

const { s } = banc;

banc.brancher();

// Ce que le navigateur note quand on coupe le réseau ou que le serveur ne répond pas (attendu ici).
const RESEAU = /ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|ERR_FAILED|net::|Failed to fetch|FirebaseError|internal|unavailable|503|Could not reach|WebChannel|Backend/;

async function profil(t) {
  await t.page.click('.nav-item[data-tab="profile"]');
  await g.attendreVue(t, 'view-profile');
  await t.page.locator('#abo-card').waitFor({ state: 'visible' });
}

async function pageAbonnement(t) {
  await t.page.click('#btn-abo-page');
  await g.attendreVue(t, 'view-abonnement');
  await t.page.locator('#factures-chargement').waitFor({ state: 'hidden' });
}

const famille = (fid) => g.lire(`families/${fid}`);

// Après un rechargement : l'app s'ouvre sur un écran (pas de chargement sans fin), puis on va au Profil.
async function rechargerPuisProfil(t) {
  await t.page.reload();
  await t.page.waitForFunction(() => {
    const vues = [...document.querySelectorAll('main > section, #loading')].filter((e) => !e.hidden).map((e) => e.id);
    return vues.length === 1 && ['view-home', 'view-profile', 'view-abonnement'].includes(vues[0]);
  }, null, { timeout: 20_000 });
  await profil(t);
}
const avantDePartir = (t) => t.page.locator('.dialog-back:not(.closing) .dialog', { hasText: 'Avant de partir' });

// Famille installée depuis plus de 30 jours : « Résilier l'abonnement » est proposé.
async function apres30Jours(t) {
  const { fid, tab } = await g.familleInstallee(t, { email: 'julie@exemple.fr', prenom: 'Julie' });
  s.avancer(31);
  s.stripe.finirEssai(tab.commande);
  await s.calme();
  await t.page.reload();
  await g.attendreVue(t, 'view-home');
  await profil(t);
  await pageAbonnement(t);
  await t.page.locator('#btn-resilier').waitFor({ state: 'visible' });
  return { fid, tab };
}

test('Résilier : double appui, appui long et retour d\'Android n\'ouvrent qu\'une fenêtre ; « Résilier quand même » touché deux fois = une seule résiliation', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await apres30Jours(julie);

  // Double appui sur « Résilier l'abonnement » : une seule fenêtre « Avant de partir ».
  await g.doubleAppui(julie, '#btn-resilier');
  await avantDePartir(julie).waitFor();
  await julie.page.waitForTimeout(300);
  assert.strictEqual(await g.fenetresOuvertes(julie), 1, 'une seule fenêtre');
  // Retour d'Android : la fenêtre se ferme comme « Garder Papote », la page reste là.
  await julie.page.goBack();
  await julie.page.locator('.dialog-back').waitFor({ state: 'detached' });
  await g.attendreVue(julie, 'view-abonnement');
  await g.toast(julie, 'Merci de rester avec Papote');

  // Appui long : la fenêtre s'ouvre une fois au plus, jamais deux.
  await g.appuiLong(julie, '#btn-resilier');
  await julie.page.waitForTimeout(400);
  assert.ok(await g.fenetresOuvertes(julie) <= 1, 'pas deux fenêtres après un appui long');
  if (await g.fenetresOuvertes(julie)) await g.repondre(julie, 'Garder Papote');
  assert.strictEqual(g.nbAppels('resilierAbonnement'), 0, 'rien n\'est parti au serveur');
  assert.ok(!(await famille(fid)).abonnement.resiliationLe);

  // Clavier ouvert (petite hauteur) : la fenêtre tient dans l'écran, ses deux boutons se touchent.
  await g.clavier(julie, true);
  await julie.page.click('#btn-resilier');
  await avantDePartir(julie).waitFor();
  await julie.page.waitForTimeout(300);
  for (const libelle of ['Garder Papote', 'Résilier quand même']) {
    const b = avantDePartir(julie).locator('button', { hasText: libelle });
    await b.scrollIntoViewIfNeeded();
    const box = await b.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 510, `« ${libelle} » visible avec le clavier ouvert`);
  }
  await g.clavier(julie, false);

  // « Résilier quand même » touché deux fois : un seul appel, une seule confirmation.
  await g.doubleAppui(julie, '.dialog-back:not(.closing) .dialog button:has-text("Résilier quand même")');
  assert.match(await g.texteFenetre(julie), /Résiliation enregistrée\. Papote s'arrêtera le/);
  await julie.page.waitForTimeout(300);
  assert.strictEqual(await g.fenetresOuvertes(julie), 1, 'une seule confirmation');
  await g.repondre(julie, 'OK');
  await s.calme();
  assert.strictEqual(g.nbAppels('resilierAbonnement'), 1, 'résiliation demandée une seule fois');
  assert.ok((await famille(fid)).abonnement.resiliationLe, 'arrêt noté');
  assert.strictEqual(s.boite.filter((m) => m.a === 'julie@exemple.fr' && /résili|arrêt/i.test(`${m.sujet} ${m.texte}`)).length, 1, 'un seul e-mail');
  await julie.page.locator('#btn-resilier').waitFor({ state: 'hidden' });

  // Page rechargée : l'arrêt prévu est toujours dit, et « Garder mon abonnement » est là.
  await rechargerPuisProfil(julie);
  await julie.page.locator('#abo-status', { hasText: 'Arrêt prévu le' }).waitFor();

  // « Garder mon abonnement » touché deux fois : un seul appel, la roue tourne puis la confirmation.
  await g.doubleAppui(julie, '#btn-garder');
  assert.match(await g.texteFenetre(julie), /Résiliation annulée : votre abonnement continue/);
  await g.repondre(julie, 'OK');
  await s.calme();
  assert.strictEqual(g.nbAppels('annulerResiliation'), 1, 'reprise demandée une seule fois');
  assert.ok(!(await famille(fid)).abonnement.resiliationLe, 'résiliation annulée');
  await julie.page.locator('#btn-garder').waitFor({ state: 'hidden' });
  await g.jamaisMainPropre(julie);
});

test('Résilier sans réseau : message clair et rien d\'enregistré ; le réseau revient, ça passe une fois. Pareil pour « Garder »', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await apres30Jours(julie);

  await julie.context.setOffline(true);
  await julie.page.click('#btn-resilier');
  await g.repondre(julie, 'Résilier quand même');
  await julie.page.locator('#abo-page-error', { hasText: /Réessayez|réseau|connexion/ }).waitFor({ timeout: 20_000 });
  assert.strictEqual(await g.fenetresOuvertes(julie), 0, 'pas de confirmation trompeuse');
  assert.ok(!(await famille(fid)).abonnement.resiliationLe, 'rien d\'enregistré');
  // Le bouton est de nouveau utilisable (pas de roue sans fin).
  await julie.page.locator('#btn-resilier:not([data-retour])').waitFor({ state: 'visible' });

  await julie.context.setOffline(false);
  await julie.page.click('#btn-resilier');
  await g.repondre(julie, 'Résilier quand même');
  assert.match(await g.texteFenetre(julie), /Résiliation enregistrée/);
  await g.repondre(julie, 'OK');
  await julie.page.locator('#abo-page-error').waitFor({ state: 'hidden' });
  await s.calme();
  assert.ok((await famille(fid)).abonnement.resiliationLe, 'arrêt noté');
  assert.strictEqual(g.nbAppels('resilierAbonnement'), 1, 'un seul appel arrivé au serveur');

  // « Garder mon abonnement » sans réseau, puis avec.
  await julie.page.goBack();
  await g.attendreVue(julie, 'view-profile');
  await julie.page.locator('#btn-garder').waitFor({ state: 'visible' });
  await julie.context.setOffline(true);
  await julie.page.click('#btn-garder');
  await julie.page.locator('#abo-error', { hasText: /Réessayez|réseau|connexion/ }).waitFor({ timeout: 20_000 });
  await julie.page.locator('#btn-garder:not([data-retour])').waitFor({ state: 'visible' });
  assert.ok((await famille(fid)).abonnement.resiliationLe, 'toujours résilié');
  await julie.context.setOffline(false);
  await julie.page.click('#btn-garder');
  assert.match(await g.texteFenetre(julie), /Résiliation annulée/);
  await g.repondre(julie, 'OK');
  await julie.page.locator('#abo-error').waitFor({ state: 'hidden' });
  await s.calme();
  assert.ok(!(await famille(fid)).abonnement.resiliationLe);
  banc.tolerer(julie, RESEAU);
});

test('Serveur muet puis en panne : la roue tourne, un 2e appui ne relance rien ; « Garder » refusé par le serveur reste à refaire', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await apres30Jours(julie);

  // Le serveur reçoit la demande mais ne répond pas tout de suite.
  const muet = await g.serveurMuet(julie, 'resilierAbonnement');
  await julie.page.click('#btn-resilier');
  await g.repondre(julie, 'Résilier quand même');
  await g.attendreRetourVisible(julie, '#btn-resilier');
  // Appuis pendant l'attente : ni nouvelle fenêtre, ni nouvel appel.
  await g.doubleAppui(julie, '#btn-resilier');
  await julie.page.click('#btn-resilier', { force: true }).catch(() => {});
  await julie.page.waitForTimeout(400);
  assert.strictEqual(await g.fenetresOuvertes(julie), 0, 'pas de 2e « Avant de partir » pendant l\'attente');
  assert.strictEqual(muet.attente, 1, 'une seule demande en route');
  await muet.lacher();
  assert.match(await g.texteFenetre(julie), /Résiliation enregistrée/);
  await g.repondre(julie, 'OK');
  await s.calme();
  assert.strictEqual(g.nbAppels('resilierAbonnement'), 1);

  // Le serveur est en panne (503) : « Garder » le dit, rien ne change, et ça marche au retour.
  await julie.page.goBack();
  await g.attendreVue(julie, 'view-profile');
  banc.pannes.set('annulerResiliation', { status: 'UNAVAILABLE' });
  await julie.page.click('#btn-garder');
  await julie.page.locator('#abo-error', { hasText: 'Réessayez' }).waitFor({ timeout: 20_000 });
  assert.strictEqual(await g.fenetresOuvertes(julie), 0);
  assert.ok((await famille(fid)).abonnement.resiliationLe, 'toujours résilié');
  banc.pannes.delete('annulerResiliation');
  await julie.page.click('#btn-garder');
  assert.match(await g.texteFenetre(julie), /Résiliation annulée/);
  await g.repondre(julie, 'OK');
  await s.calme();
  assert.ok(!(await famille(fid)).abonnement.resiliationLe);
  banc.tolerer(julie, RESEAU);
});

test('Page rechargée pendant la résiliation : ce que le serveur a fait s\'affiche au retour, sans rien redemander', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await apres30Jours(julie);
  // La demande part au serveur ; la réponse arrive après le rechargement (perdue).
  let arrivee;
  const partie = new Promise((r) => { arrivee = r; });
  await julie.context.route(/\/resilierAbonnement$/, async (route) => {
    const reponse = await route.fetch().catch(() => null);
    arrivee();
    await new Promise((r) => setTimeout(r, 1500));
    if (reponse) await route.fulfill({ response: reponse }).catch(() => {});
  });
  await julie.page.click('#btn-resilier');
  await g.repondre(julie, 'Résilier quand même');
  await partie;
  await rechargerPuisProfil(julie);
  await s.calme();
  await julie.page.locator('#abo-status', { hasText: 'Arrêt prévu le' }).waitFor();
  await julie.page.locator('#btn-garder').waitFor({ state: 'visible' });
  assert.strictEqual(g.nbAppels('resilierAbonnement'), 1, 'rien n\'est redemandé au rechargement');
  assert.ok((await famille(fid)).abonnement.resiliationLe);
  banc.tolerer(julie, RESEAU);
});

test('Annuler la commande (30 jours) : retour d\'Android = rien d\'annulé ; pendant l\'attente le bouton travaille et ne relance rien ; une seule annulation', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await profil(julie);
  await pageAbonnement(julie);
  await julie.page.locator('#btn-retracter').waitFor({ state: 'visible' });

  // Retour d'Android sur la question : rien n'est annulé.
  await julie.page.click('#btn-retracter');
  assert.match(await g.texteFenetre(julie), /Annuler votre commande \?/);
  await julie.page.goBack();
  await julie.page.locator('.dialog-back').waitFor({ state: 'detached' });
  await g.attendreVue(julie, 'view-abonnement');
  assert.strictEqual(g.nbAppels('retracter'), 0);

  // Sans réseau : un message, rien n'est annulé.
  await julie.context.setOffline(true);
  await julie.page.click('#btn-retracter');
  await g.repondre(julie, 'Annuler ma commande');
  await julie.page.locator('#abo-page-error', { hasText: /Réessayez|réseau|connexion/ }).waitFor({ timeout: 20_000 });
  assert.strictEqual((await famille(fid)).abonnement.statut, 'actif');
  await julie.context.setOffline(false);

  // Serveur lent : le bouton montre qu'il travaille, et un 2e appui ne repose pas la question.
  const muet = await g.serveurMuet(julie, 'retracter');
  await julie.page.click('#btn-retracter');
  await g.doubleAppui(julie, '.dialog-back:not(.closing) .dialog button:has-text("Annuler ma commande")');
  await g.attendreRetourVisible(julie, '#btn-retracter');
  if (await julie.page.locator('#btn-retracter').isVisible()) await julie.page.click('#btn-retracter', { force: true }).catch(() => {});
  await julie.page.waitForTimeout(400);
  assert.strictEqual(await g.fenetresOuvertes(julie), 0, 'pas de 2e question pendant l\'attente');
  assert.strictEqual(muet.attente, 1, 'une seule demande en route');
  await muet.lacher();
  assert.match(await g.texteFenetre(julie), /Commande annulée/);
  await g.repondre(julie, 'OK');
  await s.calme();
  assert.strictEqual(g.nbAppels('retracter'), 1, 'une seule annulation');
  assert.ok(['resilie', 'aucun'].includes((await famille(fid)).abonnement.statut));
  await julie.page.locator('#btn-retracter').waitFor({ state: 'hidden' });
  await g.jamaisMainPropre(julie);
  banc.tolerer(julie, RESEAU);
});

test('Résilié, tablette pas rendue : « Garder la tablette et reprendre », retour d\'Android, double appui = une seule page de paiement', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await profil(julie);
  await pageAbonnement(julie);
  await julie.page.click('#btn-retracter');
  await g.repondre(julie, 'Annuler ma commande');
  await g.texteFenetre(julie);
  await g.repondre(julie, 'OK');
  await s.calme();
  await julie.page.goBack();
  await g.attendreVue(julie, 'view-profile');
  await julie.page.locator('#retour-box', { hasText: 'Tablette à nous rendre' }).waitFor();
  await julie.page.locator('#btn-reprendre').waitFor({ state: 'visible' });
  await g.jamaisMainPropre(julie);

  // Retour d'Android sur la question : rien ne part.
  await julie.page.click('#btn-reprendre');
  assert.match(await g.texteFenetre(julie), /Garder la tablette et reprendre l'abonnement/);
  await julie.page.goBack();
  await julie.page.locator('.dialog-back').waitFor({ state: 'detached' });
  await g.attendreVue(julie, 'view-profile');
  assert.strictEqual(g.nbAppels('creerPaiement'), 0);

  // Sans réseau : un message clair.
  await julie.context.setOffline(true);
  await julie.page.click('#btn-reprendre');
  await g.repondre(julie, 'Reprendre');
  await julie.page.locator('#abo-error', { hasText: /Réessayez|réseau|connexion/ }).waitFor({ timeout: 20_000 });
  await julie.context.setOffline(false);

  // « Reprendre » touché deux fois : une seule page de paiement demandée, la roue tourne en attendant.
  await julie.page.click('#btn-reprendre');
  const [requete] = await Promise.all([
    julie.page.waitForRequest((r) => r.url().startsWith('https://checkout.stripe.test/')),
    g.doubleAppui(julie, '.dialog-back:not(.closing) .dialog button:has-text("Reprendre")'),
  ]);
  assert.ok(requete);
  assert.strictEqual(g.nbAppels('creerPaiement'), 1, 'une seule page de paiement');
  assert.ok(fid);
  banc.tolerer(julie, RESEAU);
});
