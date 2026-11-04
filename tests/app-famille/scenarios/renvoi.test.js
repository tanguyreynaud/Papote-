// Renvoyer la tablette depuis l'app (Profil) : QR code Mondial Relay sans impression, adresse demandée quand la
// commande n'en a pas, retour avant la date d'arrêt, tablette reçue et remboursée. Avec les gestes de tous les jours
// (double appui, retour d'Android, page rechargée, clavier ouvert) et le réseau coupé en plein milieu.
// La remise « en main propre » n'est jamais proposée à la famille : vérifié à chaque étape.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

const { s, acteurs } = banc;

banc.brancher();

const RESEAU = /ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|ERR_FAILED|net::|Failed to fetch|FirebaseError|internal|unavailable|Could not reach|WebChannel|Backend|invalid-argument|failed-precondition|status of 400/;

// L'image du QR code est rangée dans Storage (simulé) : une petite image à la place.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

async function preparer(t) {
  await s.db.doc('gestion/reglages').set({ expediteur: { nom: 'Papote', adresse: '1 rue de test', cp: '07000', ville: 'Privas' } }, { merge: true });
  await t.context.route('https://firebasestorage.googleapis.com/**', (r) => (/etiquette|\.png/i.test(decodeURIComponent(r.request().url()))
    ? r.fulfill({ contentType: 'image/png', body: PNG }) : r.fallback()));
}

async function profil(t) {
  await t.page.click('.nav-item[data-tab="profile"]');
  await g.attendreVue(t, 'view-profile');
  await t.page.locator('#abo-card').waitFor({ state: 'visible' });
}

async function rechargerPuisProfil(t) {
  await t.page.reload();
  await t.page.waitForFunction(() => {
    const vues = [...document.querySelectorAll('main > section, #loading')].filter((e) => !e.hidden).map((e) => e.id);
    return vues.length === 1 && ['view-home', 'view-profile', 'view-abonnement'].includes(vues[0]);
  }, null, { timeout: 20_000 });
  await profil(t);
}

// « Annuler ma commande » dans les 30 jours : la tablette est à nous rendre.
async function annulerCommande(t) {
  await profil(t);
  await t.page.click('#btn-abo-page');
  await g.attendreVue(t, 'view-abonnement');
  await t.page.click('#btn-retracter');
  await g.repondre(t, 'Annuler ma commande');
  assert.match(await g.texteFenetre(t), /Commande annulée/);
  await g.repondre(t, 'OK');
  await s.calme();
  await t.page.goBack();
  await g.attendreVue(t, 'view-profile');
  await t.page.locator('#retour-box', { hasText: 'Tablette à nous rendre' }).waitFor();
}

test('Commande sans adresse : « Je renvoie la tablette » demande l\'adresse, erreur claire, clavier ouvert, double appui = un seul QR code', async () => {
  const julie = await banc.telephone('Julie');
  const { tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await preparer(julie);
  // Tablette remise sans livraison (aucune adresse sur la commande) : Mondial Relay reste possible, avec l'adresse.
  await s.db.doc(`commandes/${tab.commande}`).update({ livraison: s.FieldValue.delete() });
  await annulerCommande(julie);
  await g.jamaisMainPropre(julie);
  await julie.page.locator('#btn-renvoyer', { hasText: 'Je renvoie la tablette' }).waitFor();
  assert.strictEqual(await julie.page.locator('#retour-adresse').isVisible(), false);

  // Premier appui : les champs d'adresse s'ouvrent, rien ne part au serveur.
  await julie.page.click('#btn-renvoyer');
  await julie.page.locator('#retour-adresse').waitFor({ state: 'visible' });
  await julie.page.locator('#btn-renvoyer', { hasText: 'Créer le QR code' }).waitFor();
  assert.strictEqual(await julie.page.evaluate(() => document.activeElement.id), 'retour-rue', 'le curseur est dans « Numéro et rue »');
  assert.strictEqual(g.nbAppels('renvoyerTablette'), 0);
  await g.jamaisMainPropre(julie);

  // Clavier ouvert : le champ touché reste visible, le bouton s'atteint.
  await g.clavier(julie, true);
  for (const [champ, valeur] of [['#retour-rue', '3 place Bellecour'], ['#retour-cp', '123'], ['#retour-ville', 'Lyon']]) {
    await julie.page.click(champ);
    await julie.page.fill(champ, valeur);
    const box = await julie.page.locator(champ).boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= 510, `${champ} visible avec le clavier ouvert`);
  }
  await g.verifierLargeur(julie, 'adresse de retour');
  // Le clavier se referme (la barre du bas revient), puis le doigt touche le bouton.
  await julie.page.locator('#retour-ville').blur();
  await g.clavier(julie, false);
  // Code postal faux : le serveur le dit en clair, les champs restent remplis.
  await julie.page.tap('#btn-renvoyer');
  await julie.page.locator('#abo-error').waitFor({ state: 'visible' });
  assert.strictEqual(await julie.page.locator('#abo-error').innerText(), 'Le code postal a 5 chiffres.');
  assert.strictEqual(await julie.page.inputValue('#retour-rue'), '3 place Bellecour');
  await julie.page.locator('#btn-renvoyer:not([disabled])', { hasText: 'Créer le QR code' }).waitFor();

  // Bon code postal, bouton touché deux fois : « Un instant… », puis un seul QR code.
  await julie.page.fill('#retour-cp', '69002');
  await g.doubleAppui(julie, '#btn-renvoyer');
  await julie.page.locator('#retour-qr-box').waitFor({ state: 'visible' });
  await julie.page.locator('#abo-error').waitFor({ state: 'hidden' });
  assert.strictEqual(await julie.page.locator('#retour-adresse').isVisible(), false, 'champs refermés');
  assert.strictEqual(await julie.page.locator('#btn-renvoyer').isVisible(), false);
  assert.strictEqual(s.sendcloud.colis.size, 1, 'un seul QR code');
  assert.strictEqual(g.nbAppels('renvoyerTablette'), 2, 'une demande refusée (code postal), une acceptée');
  const colis = [...s.sendcloud.colis.values()][0];
  assert.strictEqual(colis.de.postal_code, '69002');
  assert.ok(colis.offre.endsWith('retour-qr'), 'Mondial Relay, sans impression');

  // Page rechargée : le même QR code, rien de recréé.
  await rechargerPuisProfil(julie);
  await julie.page.locator('#retour-qr-box').waitFor({ state: 'visible' });
  assert.strictEqual(s.sendcloud.colis.size, 1);
  await g.jamaisMainPropre(julie);
  banc.tolerer(julie, RESEAU);
});

test('Arrêt programmé : renvoyer la tablette tout de suite ; réseau coupé, serveur muet puis page rechargée ; un seul QR code', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await preparer(julie);
  s.avancer(31);
  s.stripe.finirEssai(tab.commande);
  await s.calme();
  await julie.page.reload();
  await g.attendreVue(julie, 'view-home');
  await profil(julie);
  await julie.page.click('#btn-abo-page');
  await g.attendreVue(julie, 'view-abonnement');
  await julie.page.click('#btn-resilier');
  await g.repondre(julie, 'Résilier quand même');
  await g.texteFenetre(julie);
  await g.repondre(julie, 'OK');
  await s.calme();
  await julie.page.goBack();
  await g.attendreVue(julie, 'view-profile');
  await julie.page.locator('#retour-box', { hasText: 'Vous pouvez nous renvoyer la tablette dès maintenant' }).waitFor();
  await julie.page.locator('#btn-garder').waitFor({ state: 'visible' });
  await g.jamaisMainPropre(julie);

  // Sans réseau : un message clair, le bouton revient.
  await julie.context.setOffline(true);
  await julie.page.click('#btn-renvoyer');
  await julie.page.locator('#abo-error', { hasText: 'Réessayez' }).waitFor({ timeout: 20_000 });
  await julie.page.locator('#btn-renvoyer:not([disabled])', { hasText: 'Je renvoie la tablette' }).waitFor();
  assert.strictEqual(s.sendcloud.colis.size, 0);
  await julie.context.setOffline(false);

  // Serveur muet : « Un instant… », un 2e appui n'envoie rien ; la page est rechargée avant la réponse.
  const muet = await g.serveurMuet(julie, 'renvoyerTablette');
  await julie.page.click('#btn-renvoyer');
  await julie.page.locator('#btn-renvoyer[disabled]', { hasText: 'Un instant' }).waitFor();
  await julie.page.click('#btn-renvoyer', { force: true });
  await julie.page.waitForTimeout(300);
  assert.strictEqual(muet.attente, 1, 'une seule demande en route');
  await muet.couper();
  await rechargerPuisProfil(julie);
  await julie.page.locator('#btn-renvoyer:not([disabled])', { hasText: 'Je renvoie la tablette' }).waitFor();
  assert.strictEqual(s.sendcloud.colis.size, 0, 'rien n\'est arrivé au serveur');

  // Le réseau est revenu : le QR code, et « Garder » disparaît (la tablette est en retour).
  await julie.page.click('#btn-renvoyer');
  await julie.page.locator('#retour-qr-box').waitFor({ state: 'visible' });
  await s.calme();
  assert.strictEqual(s.sendcloud.colis.size, 1, 'un seul QR code');
  await julie.page.locator('#btn-garder').waitFor({ state: 'hidden' });
  await julie.page.locator('#retour-box', { hasText: 'Tablette à nous rendre' }).waitFor();
  assert.strictEqual((await g.lire(`commandes/${tab.commande}`)).restitution.statut, 'attendue');
  // Retour d'Android : l'accueil, puis le Profil montre toujours le QR code.
  await julie.page.goBack();
  await g.attendreVue(julie, 'view-home');
  await profil(julie);
  await julie.page.locator('#retour-qr-box').waitFor({ state: 'visible' });
  await g.jamaisMainPropre(julie);
  assert.ok(fid);
  banc.tolerer(julie, RESEAU);
});

test('Tablette reçue par Papote : « Tablette bien reçue, merci » et le remboursement, plus aucun bouton de retour', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await preparer(julie);
  await annulerCommande(julie);
  await julie.page.locator('#retour-info', { hasText: '60 € remboursés dès réception de la tablette' }).waitFor();
  await julie.page.click('#btn-renvoyer');
  await julie.page.locator('#retour-qr-box').waitFor({ state: 'visible' });

  // Papote reçoit le colis complet.
  await s.appeler('tabletteRendue', { commande: tab.commande }, acteurs.TANGUY);
  await s.calme();
  assert.strictEqual((await g.lire(`commandes/${tab.commande}`)).remboursement.statut, 'fait');
  await rechargerPuisProfil(julie);
  await julie.page.locator('#retour-box', { hasText: 'Tablette bien reçue, merci' }).waitFor();
  await julie.page.locator('#retour-info', { hasText: '60 € remboursés.' }).waitFor();
  for (const id of ['#btn-renvoyer', '#btn-reprendre', '#btn-garder', '#retour-qr-box', '#retour-adresse']) {
    assert.strictEqual(await julie.page.locator(id).isVisible(), false, `${id} caché`);
  }
  await g.jamaisMainPropre(julie);
  assert.ok(fid);
});
