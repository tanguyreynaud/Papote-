// Audit 8, R2 (Tanguy 12/11) : le code d'une tablette de remplacement sert une fois et expire au bout de 7 jours.
// L'admin le prépare (famille, ⋮ « Préparer une tablette de remplacement »), voit jusqu'à quand il est valable, s'il a
// servi, et peut en faire un nouveau (double clic : un seul code). Fonctions : gestionCodeRemplacement
// (PAPOTE_FONCTIONS=<dossier functions> tant que main ne l'a pas).

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

const { s, acteurs: a } = banc;
const GSTATIC = 'https://www.gstatic.com/firebasejs/12.19.0/';
const FID = 'famille-remplacement';

banc.brancher();

async function ouvrirAdmin(nom, hash) {
  await banc.admin.auth().createUser({ uid: a.TANGUY.uid, email: a.TANGUY.email, emailVerified: true, displayName: 'Tanguy' }).catch(() => {});
  const jeton = await banc.admin.auth().createCustomToken(a.TANGUY.uid, { admin: true });
  const t = await banc.telephone(nom, { largeur: 1280, hauteur: 900 });
  await t.context.route('**/version.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await t.page.clock.install({ time: new Date(Date.now()) });
  await t.page.goto(`${banc.origine}/admin.html${hash}`);
  await t.page.evaluate(async ({ jeton: j, G }) => {
    const { getApp } = await import(`${G}firebase-app.js`);
    const { getAuth, signInWithCustomToken } = await import(`${G}firebase-auth.js`);
    await signInWithCustomToken(getAuth(getApp('admin')), j);
  }, { jeton, G: GSTATIC });
  await t.page.locator('#dashboard').waitFor({ state: 'visible' });
  return t;
}

const fenetre = (t) => t.page.locator('dialog.dialogue-papote[open]:not(.attente-papote)');
async function oui(t, libelle) {
  await fenetre(t).locator('button', { hasText: libelle }).click();
  await fenetre(t).waitFor({ state: 'detached' });
}
async function menuRemplacement(t) {
  await t.page.locator('[aria-label^="Actions pour la famille"]').first().click();
  await t.page.locator('.menu-points-liste:not([hidden]) button', { hasText: 'Préparer une tablette de remplacement' }).click();
}
const carte = (t) => t.page.locator('.replace-out:not([hidden])');
const codesDeLaFamille = async () => (await s.db.collection('invites').where('fid', '==', FID).where('kind', '==', 'tablette').get()).docs;

test('admin : code de remplacement valable 7 jours, une seule tablette, double clic sur « Nouveau code » = un code', async () => {
  await s.db.doc(`families/${FID}`).set({ name: 'Mamie Rose', code: 'FAMI2345', createdBy: 'julie', abonnement: { statut: 'offert' } });
  await s.db.doc(`families/${FID}/members/tab-ancienne`).set({ name: 'Tablette', role: 'tablette', joinedAt: s.Timestamp.fromMillis(Date.now() - 90 * 24 * 3600e3) });

  const t = await ouvrirAdmin('ordinateur', `#clients/familles/${FID}`);
  await t.page.locator('[aria-label^="Actions pour la famille"]').first().waitFor();
  await menuRemplacement(t);
  assert.match(await fenetre(t).innerText(), /une seule tablette, pendant 7 jours/);
  await oui(t, 'Préparer');
  await carte(t).locator('.code-remplacement').waitFor();
  const texte = await carte(t).innerText();
  const code = (texte.match(/-Code ([A-Z0-9]{4}-[A-Z0-9]{4})/) || [])[1];
  assert.ok(code, texte);
  assert.match(texte, /Pour une seule tablette, jusqu'au/);
  let codes = await codesDeLaFamille();
  assert.strictEqual(codes.length, 1);
  assert.strictEqual(codes[0].id, code.replace('-', ''));
  const expire = codes[0].get('expire').toMillis();
  assert.ok(Math.abs(expire - Date.now() - 7 * 24 * 3600e3) < 120_000);
  // La date d'échéance affichée est celle du serveur.
  const jour = new Date(expire).toLocaleString('fr-FR', { day: 'numeric', month: 'long' });
  assert.ok(texte.includes(jour), `${texte} / ${jour}`);

  // Rouvert plus tard : le même code, toujours valable, est affiché (sans en créer un autre).
  await t.page.reload();
  await t.page.locator('[aria-label^="Actions pour la famille"]').first().waitFor();
  await menuRemplacement(t);
  await carte(t).locator('.code-remplacement', { hasText: code }).waitFor();
  assert.strictEqual((await codesDeLaFamille()).length, 1);

  // « Nouveau code » : confirmation (l'ancien ne marchera plus), puis double clic sur le bouton de la fenêtre
  // et sur « Nouveau code » : un seul nouveau code.
  s.avancer(2 / (24 * 60));
  await t.page.clock.setSystemTime(new Date(Date.now()));
  await carte(t).locator('button', { hasText: 'Nouveau code' }).dblclick();
  assert.match(await fenetre(t).innerText(), new RegExp(`${code} ne marchera plus`));
  await fenetre(t).locator('button', { hasText: 'Nouveau code' }).dblclick();
  await carte(t).locator('.code-remplacement').filter({ hasNotText: code }).waitFor();
  codes = await codesDeLaFamille();
  assert.strictEqual(codes.length, 1, 'l\'ancien code libre est effacé, un seul nouveau');
  assert.notStrictEqual(codes[0].id, code.replace('-', ''));
  const nouveau = codes[0].id;
  // Dans la minute, un nouveau clic rend le même code.
  await carte(t).locator('button', { hasText: 'Nouveau code' }).click();
  await oui(t, 'Nouveau code');
  await carte(t).locator('.code-remplacement', { hasText: `${nouveau.slice(0, 4)}-${nouveau.slice(4)}` }).waitFor();
  assert.strictEqual((await codesDeLaFamille()).length, 1);

  // La tablette le prend (Sync.java, règles) : l'admin voit qu'il a servi.
  await s.db.doc(`invites/${nouveau}`).update({ usedBy: 'tab-neuve', callsUid: 'tab-neuve-appels', usedAt: s.Timestamp.fromMillis(Date.now()) });
  await t.page.reload();
  await t.page.locator('[aria-label^="Actions pour la famille"]').first().waitFor();
  await menuRemplacement(t);
  await carte(t).locator('.code-remplacement', { hasText: /a servi le .* Il ne servira plus/ }).waitFor();

  // Sans servir, il expire au bout de 7 jours : l'admin le voit.
  await s.db.doc(`invites/${nouveau}`).update({ usedBy: s.FieldValue.delete(), callsUid: s.FieldValue.delete(), usedAt: s.FieldValue.delete() });
  s.avancer(8);
  await t.page.reload();
  await t.page.locator('[aria-label^="Actions pour la famille"]').first().waitFor();
  await menuRemplacement(t);
  await carte(t).locator('.code-remplacement', { hasText: /a expiré le .* sans servir/ }).waitFor();
  assert.strictEqual(g.nbAppels('gestionCodeRemplacement') > 0, true);
});
