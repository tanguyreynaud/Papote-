// Carte SIM bloquée par un code (tablette 2bfc17b : sim = { bloquee, service: 'code …', vuLe }) : la page de la tablette
// de l'admin le dit en mots simples, là où elle dit « hors service », avec la même mise en forme ; et ça part tout seul
// quand la carte est débloquée (fiche lue en direct).
// Aussi, réveil de la tablette (verrou n°4, tablette SecoursPush : sim.push, sim.pushDirectMin) : « Notifications : push »,
// « écoute directe (N min) », « bridé : … » sur la page de la tablette, et une ligne rouge dans « À faire » quand c'est
// bridé ou plus de 24 h d'écoute directe ; rien pour une tablette d'avant (pas de sim.push).

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

const simOk = (plus) => ({ service: 'ok', operateur: 'SFR', reseau: '4G', signal: 3, vuLe: s.Timestamp.now(), ...plus });

/** Le texte de « À faire », une fois les données arrivées. */
async function aFaire(t) {
  await t.page.waitForFunction(() => document.querySelector('#a-faire') && !document.querySelector('#a-faire .fantome-ligne'), null, { timeout: 20_000 });
  return (await t.page.locator('#a-faire').innerText()).replace(/\n+/g, ' | ');
}

test('admin, réveil de la tablette : push, écoute directe, bridé, tablette d\'avant ; « À faire » en rouge si bridé ou plus de 24 h', async () => {
  const cas = {
    push: { ref: 'T-101', sim: simOk({ push: 'push', pushDirectMin: 0 }) },
    direct: { ref: 'T-102', sim: simOk({ push: 'direct', pushDirectMin: 90 }) },
    bride: { ref: 'T-103', sim: simOk({ push: 'bride', pushDirectMin: 1440 }) },
    ancienne: { ref: 'T-104', sim: simOk({}) },
    longue: { ref: 'T-105', sim: simOk({ push: 'direct', pushDirectMin: 1500 }) },
  };
  const ids = {};
  for (const [k, c] of Object.entries(cas)) {
    const fid = `famille-push-${k}`;
    await s.db.doc(`families/${fid}`).set({ name: `Famille ${k}`, code: `PUSH${k.slice(0, 4).toUpperCase()}`, createdBy: 'julie', abonnement: { statut: 'offert' } });
    await s.db.doc(`families/${fid}/members/tab-${k}`).set({ name: 'Tablette', role: 'tablette', joinedAt: s.Timestamp.now(), lastOnline: s.Timestamp.now(), appVersion: '2.99.130', sim: c.sim });
    ids[k] = (await s.db.collection('stock').add({ ref: c.ref, numero: `SERIE${c.ref}`, modele: 'Blackview Tab 60 Pro', etat: 'chez-client', fid, tabletUid: `tab-${k}`, creeLe: s.Timestamp.now() })).id;
  }

  const t = await ouvrirAdmin('ordinateur', '#accueil');
  // Les fiches des tablettes arrivent après le reste (refreshSim) : « À faire » se redessine alors.
  await t.page.locator('#a-faire a', { hasText: 'Tablette T-105' }).waitFor({ timeout: 20_000 });
  const texte = await aFaire(t);
  assert.match(texte, /Tablette T-103, notifications \| Bridé, messages relevés toutes les 5 min \(push en panne depuis plus de 24 h\)/);
  assert.match(texte, /Tablette T-105, notifications \| Écoute directe \(1500 min\) \(push en panne depuis plus de 24 h\)/);
  assert.doesNotMatch(texte, /T-101|T-102|T-104/, 'push, écoute directe de moins de 24 h et tablette d\'avant : pas d\'alerte');
  // La ligne est rouge (ko : lien « urgent » de « À faire ») et ouvre la page de la tablette.
  const ligne = t.page.locator('#a-faire a', { hasText: 'Tablette T-103, notifications' });
  assert.strictEqual(await ligne.getAttribute('href'), `#tablette/${encodeURIComponent(ids.bride)}`);
  assert.strictEqual(await ligne.getAttribute('class'), 'urgent');

  const ligneDe = async (k) => {
    await t.page.goto(`${banc.origine}/admin.html#tablette/${ids[k]}`);
    const releves = t.page.locator('#dt-releves');
    await releves.locator('.stats').waitFor();
    return releves;
  };
  let r = await ligneDe('push');
  await r.locator('.push-mode', { hasText: 'Notifications : push' }).waitFor();
  assert.strictEqual(await r.locator('.push-mode.error').count(), 0);
  r = await ligneDe('direct');
  await r.locator('.push-mode', { hasText: 'Notifications : écoute directe (90 min)' }).waitFor();
  assert.strictEqual(await r.locator('.push-mode.error').count(), 0);
  r = await ligneDe('bride');
  await r.locator('.push-mode.error', { hasText: 'Notifications : bridé : messages relevés toutes les 5 min' }).waitFor();
  r = await ligneDe('ancienne');
  assert.strictEqual(await r.locator('.push-mode').count(), 0, 'tablette d\'avant : aucune ligne Notifications');
  assert.doesNotMatch(await r.innerText(), /Notifications/);

  // Fiche lue en direct : le push revient, la ligne rouge part.
  r = await ligneDe('bride');
  await s.db.doc('families/famille-push-bride/members/tab-bride').update({ sim: simOk({ push: 'push', pushDirectMin: 1440 }) });
  await r.locator('.push-mode', { hasText: 'Notifications : push' }).waitFor();
  assert.strictEqual(await r.locator('.push-mode.error').count(), 0);
});
