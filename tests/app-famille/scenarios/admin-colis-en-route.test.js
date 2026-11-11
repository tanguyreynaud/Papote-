// ROUGE AUJOURD'HUI (audit du 11/11/2026), à fusionner AVEC le correctif : depuis la « famille préparée » (05/11), la
// commande porte un « fid » dès le paiement. L'admin croit donc la tablette installée dès que le colis part : plus de
// liste « en route », plus de ligne « pas jumelée après 20 jours », plus de « Colis revenu (jamais retiré) ».
// Le serveur, lui, sait faire la différence (tabletteRelieeLe).

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');

const { s, acteurs: a } = banc;
const GSTATIC = 'https://www.gstatic.com/firebasejs/12.19.0/';

banc.brancher();

// ---------- Gestes ----------

/** L'admin ouverte et connectée (badge administrateur), à l'heure de la simulation. */
async function ouvrirAdmin(nom, { hash = '#accueil', largeur = 1280, hauteur = 900 } = {}) {
  await banc.admin.auth().createUser({ uid: a.TANGUY.uid, email: a.TANGUY.email, emailVerified: true, displayName: 'Tanguy' }).catch(() => {});
  const jeton = await banc.admin.auth().createCustomToken(a.TANGUY.uid, { admin: true });
  const t = await banc.telephone(nom, { largeur, hauteur });
  await t.context.route('**/version.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  // Les fenêtres ouvertes par l'admin (PDF de l'étiquette) ne servent pas ici.
  t.context.on('page', (autre) => { if (autre !== t.page) autre.close().catch(() => {}); });
  await t.page.clock.install({ time: new Date(Date.now()) });
  await t.page.goto(`${banc.origine}/admin.html${hash}`);
  await t.page.evaluate(async ({ jeton: j, G }) => {
    const { getApp } = await import(`${G}firebase-app.js`);
    const { getAuth, signInWithCustomToken } = await import(`${G}firebase-auth.js`);
    await signInWithCustomToken(getAuth(getApp('admin')), j);
  }, { jeton, G: GSTATIC });
  await t.page.locator('#dashboard').waitFor({ state: 'visible' });
  await aFaire(t);
  return t;
}

/** Le texte de « À faire », une fois les données arrivées. */
async function aFaire(t) {
  await t.page.waitForFunction(() => document.querySelector('#a-faire') && !document.querySelector('#a-faire .fantome-ligne'), null, { timeout: 20_000 });
  return (await t.page.locator('#a-faire').innerText()).replace(/\n+/g, ' | ');
}

/** Retour à l'accueil, données relues. */
async function accueil(t) {
  await t.page.goto(`${banc.origine}/admin.html#accueil`);
  await t.page.reload();
  await t.page.locator('#dashboard').waitFor({ state: 'visible' });
  return aFaire(t);
}

test('admin : un colis parti mais pas encore installé reste « en route » (pas « En service »), et après 20 jours « À faire » le dit', { todo: 'rouge tant que le correctif n\'est pas fait : retirer ce todo avec le correctif' }, async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const tablette = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email, nom: 'Paul Martin' });
  await a.preparerEtEnvoyer(id, tablette);
  s.avancer(1);
  const c = await s.lire(`commandes/${id}`);
  assert.ok(!c.tabletteRelieeLe, 'la tablette n\'est pas installée');

  const t = await ouvrirAdmin('ordinateur', { hash: `#commande/${id}` });
  const p = t.page;
  await p.locator('#dc-corps', { hasText: 'Paul Martin' }).waitFor();
  assert.doesNotMatch(await p.locator('#dc-corps').innerText(), /En service/,
    'la commande ne doit pas être « En service » tant que la tablette n\'est pas installée');

  // La liste des colis en route (suivi, « Le client a reçu le colis ») contient cette commande.
  await p.goto(`${banc.origine}/admin.html#commandes`);
  await aFaire(t);
  assert.match(await p.locator('#shipped').innerText(), /Paul Martin/, 'la commande partie est dans « Envoyées, pas encore jumelées »');

  // 21 jours plus tard, toujours pas installée : « À faire » doit le dire (aujourd'hui : seulement un e-mail).
  s.avancer(21);
  await p.clock.setSystemTime(new Date(Date.now()));
  assert.match(await accueil(t), /pas (encore )?(jumelée|installée)/);
});
