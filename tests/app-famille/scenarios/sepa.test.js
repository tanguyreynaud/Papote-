// Encart doré « Passer au prélèvement » (Tanguy, 10/11) : responsables d'une famille qui paie par carte, 15 jours après
// le premier prélèvement mensuel. « Plus tard » (7 jours), double appui, appui long, serveur en panne ou muet, retour de
// la page Stripe, autres proches, famille déjà en SEPA ou en retard de paiement, petite hauteur et thème sombre.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

const { s } = banc;

banc.brancher();

const famille = (fid) => g.lire(`families/${fid}`);
const encart = (t) => t.page.locator('#sepa-encart');

// Famille installée, payée par carte (ou SEPA), premier mois prélevé : { fid, tab }.
async function famillePayee(t, { carte = true } = {}) {
  const r = await g.familleInstallee(t, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const abo = s.stripe.etat.abonnements.get(r.tab.commande);
  if (carte) s.stripe.etat.clients.get(abo.customer).moyen = { id: 'pm_carte_test', type: 'card', card: { last4: '4242' } };
  s.avancer(31);
  s.stripe.finirEssai(r.tab.commande);
  await s.calme();
  assert.strictEqual((await famille(r.fid)).paiement.moyen, carte ? 'carte' : 'sepa');
  return r;
}

// Le navigateur garde l'heure vraie (l'horloge simulée n'avance que côté serveur) : le premier prélèvement est
// placé « il y a N jours » à l'heure du téléphone.
const JOUR = 24 * 3600 * 1000;
async function premierIlYa(t, fid, jours) {
  const maintenant = await t.page.evaluate(() => Date.now());
  await s.db.doc(`families/${fid}`).update({ 'paiement.premierLe': s.Timestamp.fromMillis(maintenant - jours * JOUR) });
}

async function recharger(t) {
  await t.page.reload();
  await g.attendreVue(t, 'view-home');
}

test('Payé par carte : rien avant 15 jours, puis l\'encart doré ; « Plus tard » le cache 7 jours, même après rechargement', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await famillePayee(julie);
  await recharger(julie);
  assert.strictEqual(await encart(julie).isVisible(), false, 'pas le jour du premier prélèvement');
  await premierIlYa(julie, fid, 14);
  await recharger(julie);
  assert.strictEqual(await encart(julie).isVisible(), false, 'pas avant 15 jours');

  await premierIlYa(julie, fid, 15);
  await recharger(julie);
  await encart(julie).waitFor({ state: 'visible' });
  assert.match(await encart(julie).innerText(), /Plus jamais de souci de carte[\s\S]*la tablette de Mamie Emma risque alors une pause[\s\S]*Même montant, même date/);
  // Deux boutons de même taille, couleur or (jamais orange : teinte entre 40° et 60°).
  const [oui, tard] = await Promise.all(['#sepa-oui', '#sepa-plus-tard'].map((sel) => julie.page.locator(sel).boundingBox()));
  assert.strictEqual(Math.round(oui.height), Math.round(tard.height));
  const teinte = await julie.page.evaluate(() => {
    const [r, gr, b] = getComputedStyle(document.getElementById('sepa-encart')).borderTopColor.match(/\d+/g).map(Number);
    const max = Math.max(r, gr, b), min = Math.min(r, gr, b);
    return (60 * ((gr - b) / (max - min)) + 360) % 360;
  });
  assert.ok(teinte >= 40 && teinte <= 60, `teinte ${teinte}`);

  await julie.page.click('#sepa-plus-tard');
  await g.toast(julie, 'reproposerons');
  assert.strictEqual(await encart(julie).isVisible(), false);
  await recharger(julie);
  assert.strictEqual(await encart(julie).isVisible(), false, 'toujours caché après rechargement');
  // 7 jours plus tard (à l'heure du téléphone) : l'encart revient.
  await julie.page.evaluate((f) => {
    const v = JSON.parse(localStorage.getItem('papote.sepaPlusTard'));
    if (!(v[f] > Date.now() + 6.9 * 24 * 3600e3)) throw new Error(`masqué jusqu'à ${v[f]}`);
    v[f] = Date.now() - 1;
    localStorage.setItem('papote.sepaPlusTard', JSON.stringify(v));
  }, fid);
  await recharger(julie);
  await encart(julie).waitFor({ state: 'visible' });
  assert.strictEqual(g.nbAppels('passerAuSepa'), 0);
});

test('« Passer au prélèvement » : double appui et appui long, une seule page Stripe ; au retour, merci et plus d\'encart', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await famillePayee(julie);
  await premierIlYa(julie, fid, 15);
  await recharger(julie);
  await encart(julie).waitFor({ state: 'visible' });

  // Appui long : au plus une page.
  const [r1] = await Promise.all([
    julie.page.waitForRequest((r) => r.url().startsWith('https://checkout.stripe.test/')),
    g.appuiLong(julie, '#sepa-oui'),
  ]);
  assert.ok(r1);
  assert.strictEqual(g.nbAppels('passerAuSepa'), 1);
  await julie.page.goto(banc.origine);
  await g.attendreVue(julie, 'view-home');

  // Double appui : une seule page demandée, la roue tourne en attendant.
  const [requete] = await Promise.all([
    julie.page.waitForRequest((r) => r.url().startsWith('https://checkout.stripe.test/')),
    g.doubleAppui(julie, '#sepa-oui'),
  ]);
  assert.strictEqual(g.nbAppels('passerAuSepa'), 2, 'un appel pour l\'appui long, un pour le double appui');
  const session = requete.url().split('/').pop();

  // Julie signe le mandat sur la page Stripe, puis revient dans l'app.
  s.stripe.signerMandatSepa(session);
  await s.calme();
  assert.strictEqual((await famille(fid)).paiement.moyen, 'sepa');
  await julie.page.goto(`${banc.origine}/?sepa=ok`);
  assert.match(await g.texteFenetre(julie), /prochains mois seront prélevés sur votre compte/);
  await g.repondre(julie, 'OK');
  await g.attendreVue(julie, 'view-home');
  assert.strictEqual(await encart(julie).isVisible(), false);
  assert.doesNotMatch(julie.page.url(), /sepa=ok/, 'rien de rejoué au rechargement');
  await recharger(julie);
  assert.strictEqual(await encart(julie).isVisible(), false);
});

test('Serveur en panne puis muet : un message clair dans l\'encart, le bouton revient, un appel par appui', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await famillePayee(julie);
  await premierIlYa(julie, fid, 15);
  await recharger(julie);
  await encart(julie).waitFor({ state: 'visible' });

  banc.pannes.set('passerAuSepa', { status: 'UNAVAILABLE' });
  await julie.page.click('#sepa-oui');
  await julie.page.locator('#sepa-erreur', { hasText: /Réessayez/ }).waitFor();
  assert.strictEqual(g.nbAppels('passerAuSepa'), 1);
  banc.pannes.delete('passerAuSepa');

  const muet = await g.serveurMuet(julie, 'passerAuSepa');
  await julie.page.click('#sepa-oui');
  await g.attendreRetourVisible(julie, '#sepa-oui');
  assert.strictEqual(await julie.page.locator('#sepa-erreur').isVisible(), false, 'l\'ancienne erreur s\'efface');
  await julie.page.click('#sepa-oui', { force: true }).catch(() => {});
  const [requete] = await Promise.all([
    julie.page.waitForRequest((r) => r.url().startsWith('https://checkout.stripe.test/')),
    muet.lacher(),
  ]);
  assert.ok(requete);
  assert.strictEqual(g.nbAppels('passerAuSepa'), 2, 'le 2e appui pendant l\'attente n\'appelle rien');
  banc.tolerer(julie, /503|Service Unavailable|UNAVAILABLE/);
});

test('Autres proches, famille en SEPA, retard de paiement : jamais d\'encart ; petite hauteur et thème sombre lisibles', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await famillePayee(julie);
  const paul = await banc.telephone('Paul');
  await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });
  await premierIlYa(julie, fid, 15);
  await recharger(julie);
  await recharger(paul);
  await encart(julie).waitFor({ state: 'visible' });
  assert.strictEqual(await encart(paul).isVisible(), false, 'seulement les responsables');

  // Clavier ouvert (petite hauteur) : les deux boutons restent dans la largeur de l'écran.
  await g.clavier(julie, true);
  const box = await julie.page.locator('#sepa-plus-tard').boundingBox();
  assert.ok(box.x + box.width <= 390, 'pas de débordement à droite');
  await g.clavier(julie, false);

  // Thème sombre : texte or clair sur fond sombre, contraste AA (≥ 4,5).
  await julie.page.emulateMedia({ colorScheme: 'dark' });
  const contraste = await julie.page.evaluate(() => {
    const lum = (c) => {
      const v = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((x) => { const y = x / 255; return y <= 0.03928 ? y / 12.92 : ((y + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    };
    const st = getComputedStyle(document.getElementById('sepa-texte'));
    const fond = getComputedStyle(document.getElementById('sepa-encart')).backgroundColor;
    const [a, b] = [lum(st.color), lum(fond)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  });
  assert.ok(contraste >= 4.5, `contraste ${contraste}`);
  await julie.page.emulateMedia({ colorScheme: 'light' });

  // Retard de paiement : l'encart laisse la place au bandeau « Le dernier paiement a échoué ».
  await s.db.doc(`families/${fid}`).update({ 'abonnement.statut': 'impaye', 'abonnement.graceJusqua': s.Timestamp.fromMillis(Date.now() + 7 * s.JOUR) });
  await julie.page.locator('#abo-banner', { hasText: 'Le dernier paiement a échoué' }).waitFor();
  assert.strictEqual(await encart(julie).isVisible(), false);
  await s.db.doc(`families/${fid}`).update({ 'abonnement.statut': 'actif' });
  await encart(julie).waitFor({ state: 'visible' });
  // Passée au SEPA autrement (portail Stripe) : l'encart disparaît dès que le serveur le note.
  await s.db.doc(`families/${fid}`).update({ 'paiement.moyen': 'sepa' });
  await encart(julie).waitFor({ state: 'hidden' });
});

test('Payé en SEPA dès la commande : jamais d\'encart', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await famillePayee(julie, { carte: false });
  await premierIlYa(julie, fid, 40);
  await recharger(julie);
  await julie.page.waitForTimeout(500);
  assert.strictEqual(await encart(julie).isVisible(), false);
});
