// Carte SIM bloquée par un code (tablette 2bfc17b : sim = { bloquee, service: 'code …', vuLe }) : la page de la tablette
// de l'admin le dit en mots simples, là où elle dit « hors service », avec la même mise en forme ; et ça part tout seul
// quand la carte est débloquée (fiche lue en direct).

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');

const { s, acteurs: a } = banc;
const GSTATIC = 'https://www.gstatic.com/firebasejs/12.19.0/';
const FID = 'famille-sim-bloquee';
const UID = 'tablette-sim-bloquee';

banc.brancher();

async function ouvrirAdmin(nom, hash) {
  await banc.admin.auth().createUser({ uid: a.TANGUY.uid, email: a.TANGUY.email, emailVerified: true, displayName: 'Tanguy' }).catch(() => {});
  const jeton = await banc.admin.auth().createCustomToken(a.TANGUY.uid, { admin: true });
  const t = await banc.telephone(nom, { largeur: 1280, hauteur: 900 });
  await t.context.route('**/version.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await t.page.goto(`${banc.origine}/admin.html${hash}`);
  await t.page.evaluate(async ({ jeton: j, G }) => {
    const { getApp } = await import(`${G}firebase-app.js`);
    const { getAuth, signInWithCustomToken } = await import(`${G}firebase-auth.js`);
    await signInWithCustomToken(getAuth(getApp('admin')), j);
  }, { jeton, G: GSTATIC });
  await t.page.locator('#dashboard').waitFor({ state: 'visible' });
  return t;
}

const sim = (bloquee) => ({ bloquee, service: `code ${bloquee}`, vuLe: s.Timestamp.now() });

test('admin, page de la tablette : « Carte SIM bloquée : code PIN demandé », puis PUK, verrouillée, et rien une fois débloquée', async () => {
  await s.db.doc(`families/${FID}`).set({ name: 'Mamie Rose', code: 'FAMI2345', createdBy: 'julie', abonnement: { statut: 'offert' } });
  const fiche = s.db.doc(`families/${FID}/members/${UID}`);
  await fiche.set({ name: 'Tablette', role: 'tablette', joinedAt: s.Timestamp.now(), lastOnline: s.Timestamp.now(), appVersion: '2.99.120', sim: sim('pin') });
  const stock = await s.db.collection('stock').add({ ref: 'T-003', numero: 'SERIE0003', modele: 'Blackview Tab 60 Pro', etat: 'chez-client', fid: FID, tabletUid: UID, creeLe: s.Timestamp.now() });

  const t = await ouvrirAdmin('ordinateur', `#tablette/${stock.id}`);
  const releves = t.page.locator('#dt-releves');
  const alerte = releves.locator('.reseau-mobile p.error');
  await alerte.filter({ hasText: 'Carte SIM bloquée : code PIN demandé' }).waitFor();
  assert.match(await releves.innerText(), /Carte SIM : bloquée \(code PIN demandé\)/);
  assert.match(await releves.innerText(), /bloquée : code PIN demandé/, 'la case Carte SIM du relevé le dit aussi');
  assert.doesNotMatch(await releves.innerText(), /Aucune antenne listée|pas de carte SIM/);
  // Même mise en forme que « hors service » (p.error de l'alerte réseau), aucune classe nouvelle.
  assert.strictEqual(await alerte.getAttribute('class'), 'error');

  await fiche.update({ sim: sim('puk') });
  await alerte.filter({ hasText: 'Carte SIM bloquée : code PUK demandé' }).waitFor();
  await fiche.update({ sim: sim('verrouillee') });
  await alerte.filter({ hasText: 'Carte SIM bloquée : verrouillée' }).waitFor();

  // Comparaison : une carte hors service garde son texte habituel, dans la même classe.
  await fiche.update({ sim: { service: 'hors service', antennes: [], operateur: 'SFR', vuLe: s.Timestamp.now() } });
  await alerte.filter({ hasText: 'Tablette sans réseau mobile' }).waitFor();
  assert.doesNotMatch(await releves.innerText(), /bloquée/);

  // Débloquée et en service : plus rien de rouge.
  await fiche.update({ sim: { service: 'ok', operateur: 'SFR', reseau: '4G', signal: 3, antennes: [{ reseau: '20810', nom: 'SFR', type: '4G', bande: 3, dbm: -90, utilisee: true }], vuLe: s.Timestamp.now() } });
  await releves.locator('.reseau-mobile', { hasText: 'Carte SIM : en service' }).waitFor();
  assert.strictEqual(await alerte.count(), 0);
});
