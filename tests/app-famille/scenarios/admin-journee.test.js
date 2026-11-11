// Une journée de Tanguy dans l'admin (web/admin.html), par les vrais clics, avec les vraies fonctions serveur :
// le matin une commande à envoyer (« À faire », « Préparer l'envoi » étape par étape, colis déposé), l'après-midi
// une tablette qui revient (« Matériel reçu », remise en stock), et l'envoi refait sur un téléphone.
// Audit du 11/11/2026 : l'admin n'avait aucun test de bout en bout (seulement la galerie, sur un faux serveur).

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');

const { s, acteurs: a } = banc;
const GSTATIC = 'https://www.gstatic.com/firebasejs/12.19.0/';

banc.brancher();

// ---------- Faux Sendcloud : l'étiquette d'ENVOI (la simulation de functions/parcours ne connaît que les retours) ----------

const envois = []; // colis d'envoi payés chez Sendcloud pendant le scénario
const fetchSimulation = global.fetch;
global.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.startsWith('https://panel.sendcloud.sc/') && !s.sendcloud.panne) {
    const chemin = new URL(u).pathname.replace(/^\/api\/v[23]/, '');
    const corps = options.body ? JSON.parse(options.body) : null;
    const json = (c) => new Response(JSON.stringify(c), { status: 200, headers: { 'content-type': 'application/json' } });
    if (chemin === '/shipping-options' && !(corps.functionalities && corps.functionalities.returns)) {
      return json({ data: [{
        code: 'mondial_relay:point-relais', carrier: { code: 'mondial_relay' },
        functionalities: { last_mile: corps.to_service_point ? 'service_point' : 'home_delivery' },
        weight: { min: { value: '0', unit: 'kg' }, max: { value: '30', unit: 'kg' } },
      }] });
    }
    if (chemin === '/shipments/announce') {
      const id = s.sendcloud.prochain++;
      s.sendcloud.colis.set(id, { id, aller: true, statut: 1000, annule: false });
      envois.push({ id, corps });
      return json({ data: { parcels: [{ id, tracking_number: `MR00000${id}`, tracking_url: `https://suivi/MR00000${id}`, label_file: Buffer.from('%PDF faux').toString('base64') }] } });
    }
  }
  return fetchSimulation(url, options);
};
test.beforeEach(() => { envois.length = 0; });

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

const parcours = (t) => t.page.locator('dialog.parcours[open]');
const titreEtape = (t) => t.page.locator('.pc-corps h3').innerText();
const fenetre = (t) => t.page.locator('dialog.dialogue-papote[open]:not(.attente-papote)');
const nbAppels = (nom) => banc.appels.filter((x) => x.nom === nom && !(x.data && x.data.action === 'reveil')).length;

/** Coche toutes les cases de l'étape. */
async function cocher(t) {
  for (const c of await t.page.locator('.pc-case input[type=checkbox]').all()) if (!(await c.isChecked())) await c.click();
}

/** « C'est fait » : attend l'étape suivante, la fin du parcours ou le message d'erreur. Rend le message d'erreur. */
async function suivant(t, { double = false } = {}) {
  const avant = await t.page.locator('.pc-numero').innerText();
  const bouton = t.page.locator('.pc-suivant');
  if (double) await bouton.dblclick(); else await bouton.click();
  await t.page.waitForFunction((n) => {
    const d = document.querySelector('dialog.parcours');
    if (!d || !d.open) return true;
    if (!d.querySelector('.pc-erreur').hidden) return true;
    const e = d.querySelector('.pc-numero');
    return e && e.textContent !== n;
  }, avant, { timeout: 20_000 });
  const erreur = t.page.locator('.pc-erreur');
  return (await parcours(t).count()) && await erreur.isVisible() ? erreur.innerText() : '';
}

/** Remplit l'étape affichée de « Préparer l'envoi » comme Tanguy (tablette, carte SIM, cases…). */
async function remplirEtape(t, { tablette, lue = tablette.ref }) {
  const p = t.page;
  const titre = await titreEtape(t);
  if (/Choisir la tablette/.test(titre)) {
    const choix = p.locator('.pc-contenu select').first();
    await choix.selectOption({ label: await choix.locator('option', { hasText: tablette.ref }).innerText() });
    const sim = p.locator('.pc-contenu select').nth(1);
    if (await sim.isVisible()) await sim.selectOption({ index: 1 });
  }
  if (/Activer la carte SIM/.test(titre)) {
    await p.locator('.pc-champ input').nth(0).fill('07 45 00 00 11');
    await p.locator('.pc-champ input').nth(2).fill('2,99');
  }
  if (/Enceinte/.test(titre)) await p.locator('input[name=enceinte][value=non]').click();
  if (/Fermer le colis/.test(titre)) await p.locator('.pc-contenu input').fill(lue);
  if (/étiquette/i.test(titre) && await p.getByRole('button', { name: 'Créer l\'étiquette' }).isVisible()) {
    // Double appui : une seule étiquette payée.
    await p.getByRole('button', { name: 'Créer l\'étiquette' }).dblclick();
    await p.locator('.pc-lien').waitFor({ state: 'visible' });
  }
  await cocher(t);
  return titre;
}

async function commandePrete() {
  await s.db.doc('gestion/reglages').set({ expediteur: { nom: 'Papote', adresse: '1 rue de test', cp: '07000', ville: 'Privas' } }, { merge: true });
  const tablette = await a.tablettePreparee();
  await s.appeler('gestionSim', { action: 'ajouter', champs: { statut: 'stock', operateur: 'Sosh', iccid: '8933010000000000011' } }, a.TANGUY);
  const { abonnement: id } = await a.commanderEtPayer({ email: 'claire@exemple.fr', nom: 'Claire Dupont', carte: true });
  return { tablette, id };
}

// ---------- Le matin ----------

test('admin, le matin : « À faire » ouvre la commande, « Préparer l\'envoi » en 9 étapes, mauvais numéro T-… refusé, colis déposé une seule fois', async () => {
  const { tablette, id } = await commandePrete();
  const t = await ouvrirAdmin('ordinateur');
  const p = t.page;

  // « À faire » : une seule commande, la ligne ouvre directement sa page, avec le bouton « Préparer l'envoi ».
  assert.match(await aFaire(t), /1 tablette à envoyer/);
  await p.locator('#a-faire a', { hasText: 'tablette à envoyer' }).click();
  await p.waitForURL(new RegExp(`#commande/${id}$`));
  await p.getByRole('button', { name: 'Préparer l\'envoi' }).first().click();
  await parcours(t).waitFor();

  // Chaque étape : « C'est fait » reste éteint tant que tout n'est pas rempli et coché.
  const vues = [];
  for (let i = 0; i < 8; i++) {
    const titre = await titreEtape(t);
    if (!/Envoi ou main propre/.test(titre)) assert.ok(await p.locator('.pc-suivant').isDisabled(), `étape « ${titre} » : bouton éteint avant les gestes`);
    // Tanguy se trompe de tablette en lisant le numéro collé dessus.
    vues.push(await remplirEtape(t, { tablette, lue: 'T-999' }));
    assert.ok(await p.locator('.pc-suivant').isEnabled(), `étape « ${titre} » : bouton allumé après les gestes`);
    assert.strictEqual(await suivant(t), '', `étape « ${titre} »`);
  }
  assert.deepStrictEqual(vues, ['Envoi ou main propre ?', 'Choisir la tablette', 'Activer la carte SIM', 'La tablette dans le carton',
    'Enceinte ?', 'Fermer le colis', 'Le numéro au feutre', 'L\'étiquette']);
  assert.strictEqual(envois.length, 1, 'double appui sur « Créer l\'étiquette » : une seule étiquette payée');
  assert.strictEqual(nbAppels('gestionEtiquette'), 1);

  // « Colis déposé » avec le mauvais numéro : refusé, rien n'est parti, le message le dit.
  assert.strictEqual(await titreEtape(t), 'Déposer au relais');
  await cocher(t);
  assert.match(await suivant(t), /pas celle de cette commande/);
  banc.tolerer(t, /pas celle de cette commande/); // le refus attendu est aussi écrit dans la console
  assert.strictEqual((await s.lire(`commandes/${id}`)).expedition, 'a-preparer');
  assert.strictEqual(s.boite.filter((m) => /en route/i.test(m.sujet)).length, 0, 'pas d\'e-mail « en route » avant le vrai dépôt');
  // Il revient corriger le numéro (3 étapes en arrière), puis redescend : tout ce qui est fait reste fait.
  for (let i = 0; i < 3; i++) await p.locator('.pc-retour').click();
  assert.strictEqual(await titreEtape(t), 'Fermer le colis');
  await p.locator('.pc-contenu input').fill(tablette.ref);
  for (let i = 0; i < 3; i++) { await cocher(t); assert.strictEqual(await suivant(t), ''); }
  assert.strictEqual(envois.length, 1, 'l\'étiquette déjà faite est gardée');

  // Double appui sur « Colis déposé » : un seul envoi noté, un seul e-mail au client.
  await cocher(t);
  await suivant(t, { double: true });
  await parcours(t).waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
  assert.strictEqual(await parcours(t).count(), 0, 'le parcours se ferme');
  await s.calme();
  assert.strictEqual(nbAppels('tabletteEnvoyee'), 2, 'un refus (mauvais numéro) puis un seul envoi malgré le double appui');
  const c = await s.lire(`commandes/${id}`);
  assert.strictEqual(c.expedition, 'envoyee');
  assert.strictEqual(c.suivi, 'MR000001');
  const fiche = await s.lire(`stock/${tablette.fiche}`);
  assert.strictEqual(fiche.etat, 'envoyee');
  assert.strictEqual(fiche.commande, id);
  const sim = await s.lire(`sims/${fiche.simId}`);
  assert.strictEqual(sim.statut, 'active');
  assert.strictEqual(sim.prix, 299);
  assert.strictEqual(s.boite.filter((m) => m.a === 'claire@exemple.fr' && /en route/i.test(m.sujet)).length, 1, 'un seul e-mail « en route »');

  // L'accueil n'a plus rien à envoyer.
  assert.doesNotMatch(await accueil(t), /à envoyer/);
});

// ---------- L'après-midi ----------

test('admin, l\'après-midi : abonnement fini, la tablette revient complète (« Matériel reçu »), puis « Vérifiée, remettre en stock »', async () => {
  await s.db.doc('gestion/reglages').set({ expediteur: { nom: 'Papote', adresse: '1 rue de test', cp: '07000', ville: 'Privas' } }, { merge: true });
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const tablette = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email, nom: 'Paul Martin' });
  await a.preparerEtEnvoyer(id, tablette);
  s.avancer(2);
  await a.afficherCode(tablette);
  const fid = await a.installer(paul, tablette);
  s.avancer(31);
  s.stripe.finirEssai(id);
  await s.calme();
  const { le } = await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  s.avancer((le - Date.now()) / s.JOUR + 0.1);
  s.stripe.arreterALaDate(id);
  await s.calme();
  assert.strictEqual((await s.lire(`commandes/${id}`)).restitution.statut, 'attendue');
  const prelevementsAvant = s.stripe.etat.paiements.size;

  const t = await ouvrirAdmin('ordinateur');
  const p = t.page;
  // « À faire » : la ligne ouvre la tablette, son bouton mène à la commande où se coche le retour.
  assert.match(await aFaire(t), /Tablette T-\d+ à récupérer chez Paul Martin/);
  await p.locator('#a-faire a', { hasText: 'à récupérer' }).click();
  await p.getByRole('button', { name: /Tablette revenue/ }).click();
  await p.waitForURL(new RegExp(`#commande/${id}$`));
  await p.getByRole('button', { name: 'Matériel reçu' }).click();
  const zone = p.locator('.zone-remplacement:not([hidden])');
  assert.match(await zone.innerText(), /la tablette \(130 €\)/);
  assert.match(await zone.innerText(), /le chargeur et son câble \(10 €\)/);
  assert.doesNotMatch(await zone.innerText(), /enceinte/i, 'pas d\'enceinte dans ce colis : pas proposée');
  // Double appui sur « Enregistrer le retour » : une seule question, un seul retour.
  await p.getByRole('button', { name: 'Enregistrer le retour' }).dblclick();
  assert.strictEqual(await fenetre(t).count(), 1);
  assert.match(await fenetre(t).innerText(), /Tout le matériel est bien revenu/);
  await fenetre(t).locator('button.primary').click();
  await p.locator('#dc-corps .annonce').waitFor();
  assert.match(await p.locator('#dc-corps .annonce').innerText(), /Retour enregistré/);
  await s.calme();
  assert.strictEqual(nbAppels('tabletteRendue'), 1);
  assert.strictEqual((await s.lire(`commandes/${id}`)).restitution.statut, 'rendue');
  assert.strictEqual(s.stripe.etat.paiements.size, prelevementsAvant, 'rien n\'est prélevé : tout est revenu');
  assert.strictEqual((await s.lire(`stock/${tablette.fiche}`)).etat, 'revenue');

  // La tablette est à vérifier, puis repart dans le stock libre.
  assert.match(await accueil(t), /revenue, à vérifier avant de remettre en stock/);
  await p.locator('#a-faire a', { hasText: 'revenue' }).click();
  await p.getByRole('button', { name: /Vérifiée, remettre en stock/ }).click();
  await fenetre(t).locator('button.primary').click();
  await p.waitForFunction(() => !document.querySelector('dialog.attente-papote[open]'));
  await s.calme();
  const fiche = await s.lire(`stock/${tablette.fiche}`);
  assert.strictEqual(fiche.etat, 'en-stock');
  assert.strictEqual(fiche.commande, null);
  assert.strictEqual(fiche.fid, null);
  const reste = await accueil(t);
  assert.doesNotMatch(reste, /à récupérer|à vérifier/);
});

// ---------- Sur le téléphone ----------

test('admin sur téléphone (390 px) : chaque étape de « Préparer l\'envoi » tient dans l\'écran, bouton atteignable, jusqu\'au colis déposé', async () => {
  const { tablette, id } = await commandePrete();
  const t = await ouvrirAdmin('telephone', { largeur: 390, hauteur: 844, hash: `#commande/${id}` });
  const p = t.page;
  await p.getByRole('button', { name: 'Préparer l\'envoi' }).first().click();
  await parcours(t).waitFor();
  for (let i = 0; i < 9; i++) {
    const titre = await remplirEtape(t, { tablette });
    const m = await p.evaluate(() => {
      const b = document.querySelector('dialog.parcours .pc-suivant').getBoundingClientRect();
      return { large: document.documentElement.scrollWidth > document.documentElement.clientWidth, bas: b.bottom, haut: b.top, ecran: window.innerHeight };
    });
    assert.strictEqual(m.large, false, `étape « ${titre} » : pas plus large que le téléphone`);
    assert.ok(m.haut >= 0 && m.bas <= m.ecran, `étape « ${titre} » : le bouton du bas est à l'écran`);
    assert.strictEqual(await suivant(t), '', `étape « ${titre} »`);
    if (/Déposer/.test(titre)) break;
  }
  await s.calme();
  assert.strictEqual((await s.lire(`commandes/${id}`)).expedition, 'envoyee');
  assert.strictEqual((await s.lire(`stock/${tablette.fiche}`)).etat, 'envoyee');
});
