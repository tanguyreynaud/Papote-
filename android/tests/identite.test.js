// Identité de la tablette : appui de 5 s sur l'heure (ou sur le logo de l'écran « Bienvenue »),
// cadre « T-003 · n° de série · famille · version » qui se ferme seul (Tanguy, 11/11).
// Lancement : node --test android/tests/
const test = require('node:test');
const assert = require('node:assert');
const { ouvrir, lot } = require('./banc');

const IDENTITE = { ref: 'T-003', serie: 'Tab60P15EEA026347', version: '2.99.130' };

async function sansErreur(b) {
  const erreurs = (await b.appels('erreurJS')).concat(await b.appels('logError'));
  assert.deepStrictEqual(erreurs, [], 'erreurs JavaScript');
}

// Doigt posé au centre de l'élément pendant ms (horloge de la page avancée), puis levé.
async function appuyer(b, sel, ms) {
  const r = await b.page.locator(sel).first().boundingBox();
  await b.page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await b.page.mouse.down();
  await b.avancer(ms);
  await b.page.mouse.up();
  await b.avancer(50);
}

test('identité : 5 s sur l\'heure ouvre le cadre (T-…, série, famille, version), fermé seul après 10 s', async () => {
  const b = await ouvrir('2026-10-26T10:00:00', { identite: IDENTITE });
  try {
    await b.android('onPosts', lot([], { familyName: 'Mamie Emma' }));
    await b.avancer(7000); // le logo de démarrage s'efface
    assert.ok(await b.visible('#clock'), 'accueil affiché');
    await appuyer(b, '#clock', 5200);
    assert.ok(await b.visible('#identite'), 'cadre ouvert');
    const t = await b.texte('#identite');
    assert.match(t, /T-003/);
    assert.match(t, /Tab60P15EEA026347/);
    assert.match(t, /Famille : Mamie Emma/);
    assert.match(t, /Papote 2\.99\.130/);
    // Rien d'autre ne s'est passé (pas de photo, pas d'appel, pas de son).
    assert.strictEqual((await b.appels('phoneCall')).length, 0);
    assert.strictEqual((await b.appels('speak')).length, 0);
    await b.avancer(10100);
    assert.ok(!(await b.visible('#identite')), 'fermé seul');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('identité : appui court, ou doigt qui glisse, n\'ouvre rien ; un toucher ferme le cadre', async () => {
  const b = await ouvrir('2026-10-26T10:00:00', { identite: IDENTITE });
  try {
    await b.android('onPosts', lot([]));
    await b.avancer(7000);
    await appuyer(b, '#clock', 1500);
    await b.avancer(6000);
    assert.ok(!(await b.visible('#identite')), 'appui de 1,5 s : rien');
    // Doigt qui glisse au bout de 2 s : annulé.
    const r = await b.page.locator('#clock').boundingBox();
    await b.page.mouse.move(r.x + 20, r.y + 20);
    await b.page.mouse.down();
    await b.avancer(2000);
    await b.page.mouse.move(r.x + 200, r.y + 20);
    await b.avancer(4000);
    await b.page.mouse.up();
    assert.ok(!(await b.visible('#identite')), 'doigt qui glisse : rien');
    // Deux longs appuis de suite : un seul cadre.
    await appuyer(b, '#clock', 5200);
    await appuyer(b, '#clock', 5200);
    assert.strictEqual(await b.page.locator('#identite').count(), 1, 'un seul cadre');
    await b.toucher('#identite');
    await b.avancer(100);
    assert.ok(!(await b.visible('#identite')), 'fermé d\'un toucher');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('identité : tablette en stock (écran « Bienvenue ») : 5 s sur le logo, « Pas encore reliée »', async () => {
  const b = await ouvrir('2026-10-26T10:00:00', { identite: IDENTITE });
  try {
    await b.page.evaluate(() => window.PapoteBienvenue.show({ step: 'pair', code: 'ABCDEFGH' }));
    await b.avancer(21000); // le logo de démarrage s'efface (au plus tard 20 s)
    await appuyer(b, '.welcome .welcome-logo', 5200);
    assert.ok(await b.visible('#identite'), 'cadre ouvert sur l\'écran Bienvenue');
    const t = await b.texte('#identite');
    assert.match(t, /T-003/);
    assert.match(t, /Pas encore reliée à une famille/);
    const dessus = await b.page.evaluate(() => {
      const r = document.getElementById('identite').getBoundingClientRect();
      const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!e.closest('#identite');
    });
    assert.ok(dessus, 'cadre au-dessus de l\'écran Bienvenue');
    await b.page.screenshot({ path: process.env.CAPTURE_IDENTITE || '/dev/null' }).catch(() => null);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('identité : tablette installée avant (pas de T-… reçu) : le n° de série reste affiché', async () => {
  const b = await ouvrir('2026-10-26T10:00:00', { identite: { serie: 'Tab60P15EEA026347', version: '2.99.130' } });
  try {
    await b.android('onPosts', lot([]));
    await b.avancer(7000);
    await appuyer(b, '#clock', 5200);
    const t = await b.texte('#identite');
    assert.match(t, /Numéro T- pas encore reçu/);
    assert.match(t, /Tab60P15EEA026347/);
    await sansErreur(b);
  } finally { await b.fermer(); }
});
