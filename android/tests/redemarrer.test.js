// Redémarrer la tablette à la main (Tanguy, 18/11) : volume bas tenu 10 s, Android (MainActivity,
// Redemarrage.java) appelle Papote.demanderRedemarrage ; fenêtre « Redémarrer la tablette ? » Oui / Non.
// Oui : redémarrage (un seul, même au double toucher). Non ou 20 s sans réponse : fermeture, notée au
// journal par Android. Jamais pendant un appel ni un SOS.
// Lancement : node --test android/tests/
const test = require('node:test');
const assert = require('node:assert');
const { ouvrir, lot } = require('./banc');

const PROCHES = {
  faces: {}, birthdays: [],
  people: [{ uid: 'paul', name: 'Paul', tel: '0700000000', responsable: true }],
};

async function tablette(etat = {}) {
  const b = await ouvrir('2026-10-26T10:00:00', { telephone: true, ...etat });
  await b.android('onPosts', lot([]));
  await b.android('onFamily', PROCHES);
  await b.avancer(8000); // l'écran de démarrage s'efface
  await b.vider();
  return b;
}
const noms = async (b, nom) => (await b.appels(nom)).map((a) => a.args[0]);

test('Redémarrer : la fenêtre s\'ouvre, Oui redémarre une seule fois même au double toucher', async () => {
  const b = await tablette();
  try {
    await b.android('demanderRedemarrage', {});
    assert.ok(await b.visible('#redemarrer'), 'fenêtre visible');
    assert.strictEqual((await b.texte('#redemarrer-titre')).trim(), 'Redémarrer la tablette ?');
    assert.strictEqual((await b.appels('redemarrageAffiche')).length, 1, 'Android sait que la page l\'affiche');
    // Deux boutons de même taille.
    const tailles = await b.page.evaluate(() => ['oui', 'non'].map((k) => {
      const r = document.getElementById('redemarrer-' + k).getBoundingClientRect();
      return [Math.round(r.width), Math.round(r.height)];
    }));
    assert.deepStrictEqual(tailles[0], tailles[1], 'Oui et Non de même taille');
    await b.page.evaluate(() => { const o = document.getElementById('redemarrer-oui'); o.click(); o.click(); });
    assert.strictEqual((await b.appels('redemarrer')).length, 1, 'un seul redémarrage');
    assert.match(await b.texte('#redemarrer-titre'), /La tablette redémarre/);
    assert.ok(await b.page.evaluate(() => document.getElementById('redemarrer-non').disabled), 'Non coupé après Oui');
    await b.avancer(30000);
    assert.ok(await b.visible('#redemarrer'), 'reste affichée jusqu\'à l\'extinction');
    assert.deepStrictEqual(await noms(b, 'redemarrageNon'), [], 'pas de « Non » noté après Oui');
  } finally { await b.fermer(); }
});

test('Redémarrer : Non ferme la fenêtre sans redémarrer, et Android le note', async () => {
  const b = await tablette();
  try {
    await b.android('demanderRedemarrage', {});
    await b.toucher('#redemarrer-non');
    assert.ok(!(await b.visible('#redemarrer')), 'fenêtre fermée');
    assert.deepStrictEqual(await noms(b, 'redemarrageNon'), ['Non']);
    assert.strictEqual((await b.appels('redemarrer')).length, 0);
  } finally { await b.fermer(); }
});

test('Redémarrer : 20 s sans réponse, la fenêtre se ferme toute seule', async () => {
  const b = await tablette();
  try {
    await b.android('demanderRedemarrage', {});
    await b.avancer(19000);
    assert.ok(await b.visible('#redemarrer'), 'encore là à 19 s');
    await b.avancer(1500);
    assert.ok(!(await b.visible('#redemarrer')), 'fermée après 20 s');
    assert.deepStrictEqual(await noms(b, 'redemarrageNon'), ['sans réponse']);
    assert.strictEqual((await b.appels('redemarrer')).length, 0);
  } finally { await b.fermer(); }
});

test('Redémarrer : Android refuse (appel arrivé entre-temps) : message, puis la fenêtre se ferme', async () => {
  const b = await tablette({ redemarrageKo: true });
  try {
    await b.android('demanderRedemarrage', {});
    await b.toucher('#redemarrer-oui');
    assert.match(await b.texte('#redemarrer-titre'), /n’a pas marché/);
    await b.avancer(4500);
    assert.ok(!(await b.visible('#redemarrer')), 'fermée après le message');
  } finally { await b.fermer(); }
});

test('Redémarrer : pendant un SOS, aucune fenêtre ; Android sait qu\'un SOS est en cours', async () => {
  const b = await tablette();
  try {
    await b.toucher('#sos-btn');
    await b.avancer(1500);
    assert.strictEqual(await b.page.evaluate(() => window.__sosEnCours), true, 'SOS signalé à Android');
    await b.android('demanderRedemarrage', {});
    assert.ok(!(await b.visible('#redemarrer')), 'pas de fenêtre pendant le SOS');
    assert.deepStrictEqual(await noms(b, 'redemarrageNon'), ['appel ou SOS en cours']);
  } finally { await b.fermer(); }
});

test('Redémarrer : un appel téléphone arrive, la fenêtre ouverte se ferme', async () => {
  const b = await tablette();
  try {
    await b.android('demanderRedemarrage', {});
    await b.android('onGsm', { etat: 'sonne', sortant: false, numero: '0700000000', uid: 'paul', name: 'Paul' });
    await b.avancer(1500);
    assert.ok(!(await b.visible('#redemarrer')), 'fermée pour l\'appel');
    assert.deepStrictEqual(await noms(b, 'redemarrageNon'), ['appel ou SOS']);
  } finally { await b.fermer(); }
});

test('Redémarrer : la nuit, la fenêtre passe par-dessus l\'écran noir et le rallume', async () => {
  const b = await ouvrir('2026-10-26T02:00:00', { telephone: true });
  try {
    await b.android('onPosts', lot([]));
    await b.android('onFamily', PROCHES);
    await b.avancer(15000);
    await b.vider();
    await b.android('demanderRedemarrage', {});
    assert.ok(await b.visible('#redemarrer'));
    const dessus = await b.page.evaluate(() => {
      const r = document.getElementById('redemarrer-oui').getBoundingClientRect();
      const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return e && e.id;
    });
    assert.strictEqual(dessus, 'redemarrer-oui', 'Oui touchable par-dessus la nuit');
    assert.ok((await b.appels('setSleep')).some((a) => a.args[0] === false), 'écran rallumé');
  } finally { await b.fermer(); }
});
