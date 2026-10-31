// La tablette sur la durée (inspection n° 4, 30/10/2026) : trois jours simulés, heure par heure, avec les gestes
// de la vraie vie (envois du matin, Mamie qui regarde, rappel, appel téléphone manqué, nuit de veille, page
// rechargée par le chien de garde ou par une mise à jour). Vérifié : aucune erreur JavaScript, la veille se met et
// se lève aux bonnes heures, rien n'est annoncé deux fois après un rechargement (ce qui est noté dans la
// mémoire de la page survit, comme après une mise à jour de l'appli), et la mémoire ne gonfle pas (fuite).
// Lancement : node --test android/tests/duree.test.js
const test = require('node:test');
const assert = require('node:assert');
const { ouvrir, lot, envoi } = require('./banc');

const PROCHES = {
  faces: {}, birthdays: [],
  people: [
    { uid: 'julie', name: 'Julie', tel: '0612345678', responsable: true },
    { uid: 'paul', name: 'Paul', tel: '0700000000' },
  ],
};
const RAPPELS = { reminders: [{ id: 'r1', title: 'Cachet du matin', kind: 'medicament', time: '09:00', repeat: 'daily', date: '', days: [], lastAck: '', avanceMin: 0, finLe: '', enPauseJusquau: '', voice: '' }] };
const H = 3600 * 1000;

async function erreurs(b) {
  return (await b.appels('erreurJS')).concat(await b.appels('logError')).map((a) => a.args.join(' '));
}

// Mesures de la page après un passage du ramasse-miettes : tas JavaScript, nœuds du DOM, écouteurs.
async function mesurer(b) {
  const cdp = await b.page.context().newCDPSession(b.page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  await cdp.detach();
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { tas: m.JSHeapUsedSize, noeuds: m.Nodes, ecouteurs: m.JSEventListeners };
}

async function demarrer(b, posts) {
  await b.android('onPosts', lot(posts));
  await b.android('onFamily', PROCHES);
  await b.android('onReminders', RAPPELS);
  await b.avancer(500);
}

test('trois jours de la vie d\'une tablette : rien ne casse, la veille suit la nuit, la mémoire ne gonfle pas', async () => {
  const b = await ouvrir('2026-10-26T07:00:00', { telephone: true });
  const posts = [];
  const mesures = [];
  try {
    await demarrer(b, posts);
    for (let jour = 0; jour < 3; jour++) {
      for (let heure = 7; heure < 7 + 24; heure++) {
        const h = heure % 24;
        if (h === 8) {
          // Trois envois du matin : la page les montre un à un, Mamie est vue (visage) : « vu ».
          for (let i = 0; i < 3; i++) posts.unshift(envoi({ type: i === 2 ? 'message' : 'photo', text: i === 2 ? 'Bonne journée Mamie !' : '' }));
          await b.android('onPosts', lot(posts.slice(0, 60)));
          // Chaque envoi est montré à son tour (le suivant 2 min après que Mamie a été vue) : elle regarde les trois.
          for (let i = 0; i < 3; i++) {
            await b.avancer(3000);
            await b.page.evaluate(() => window.__visage());
            await b.avancer(3 * 60000);
          }
        }
        if (h === 9) {
          // Le rappel de 9 h : affiché, Mamie touche « C'est fait ».
          await b.avancer(60000);
          assert.ok(await b.visible('#reminder-alert'), `jour ${jour + 1} : rappel de 9 h affiché`);
          await b.toucher('#reminder-done');
        }
        if (h === 11) {
          // Julie appelle par téléphone, Mamie ne décroche pas : l'écran revient tout seul.
          await b.android('onGsm', { etat: 'sonne', sortant: false, numero: '0612345678', uid: 'julie', name: 'Julie' });
          await b.avancer(50000);
          await b.android('onGsm', { etat: 'fin', sortant: false, cause: 'manque', uid: 'julie', name: 'Julie' });
          await b.avancer(10000);
        }
        if (h === 16) {
          // Mamie touche l'écran, ouvre le diaporama, il revient tout seul.
          await b.toucher('#home-frame');
          await b.avancer(2 * 60000);
        }
        if (h === 3 && jour === 1) {
          // Le chien de garde (ou une mise à jour) recharge la page en pleine nuit du 2e jour : Android redonne tout.
          // (Une seule fois : la mémoire du 1er et du 3e jour se compare après une journée entière sans rechargement.)
          await b.page.reload();
          await b.avancer(100);
          await demarrer(b, posts.slice(0, 60).map((p) => ({ ...p, seen: true })));
        }
        // Le reste de l'heure d'un bond (fastForward : chaque minuterie tire une fois, pas 3 600 fois) : la page voit l'heure passer.
        await b.page.clock.fastForward(H);
        await b.avancer(2000);
        // Après le bond d'une heure, il est h + 1 : la veille (23 h → 7 h, réglage de la famille) doit suivre.
        const apres = (h + 1) % 24;
        const nuit = apres >= 23 || apres < 7;
        const sommeil = await b.appels('setSleep');
        if (sommeil.length) {
          const dernier = sommeil[sommeil.length - 1].args[0];
          assert.strictEqual(dernier, nuit, `jour ${jour + 1}, ${apres} h : veille ${nuit ? 'attendue' : 'levée'}`);
        }
        const e = await erreurs(b);
        assert.deepStrictEqual(e, [], `jour ${jour + 1}, ${h} h : erreurs JavaScript`);
      }
      console.log(`jour ${jour + 1} fini`);
      const ouverts = [];
      for (const sel of ['.call-out', '#reminder-alert', '#overlay']) if (await b.visible(sel)) ouverts.push(`${sel} « ${(await b.texte(sel)).trim().replace(/\s+/g, ' ').slice(0, 120)} »`);
      assert.deepStrictEqual(ouverts, [], `jour ${jour + 1} : l'accueil est revenu`);
      await b.vider(); // les appels notés par le banc ne doivent pas peser dans la mesure
      mesures.push(await mesurer(b));
    }
    const [j1, , j3] = mesures;
    const croissance = (a, c) => (c - a) / a;
    const detail = mesures.map((m, i) => `J${i + 1} : tas ${(m.tas / 1e6).toFixed(1)} Mo, ${m.noeuds} nœuds, ${m.ecouteurs} écouteurs`).join(' ; ');
    console.log(`mémoire : ${detail}`);
    assert.ok(croissance(j1.noeuds, j3.noeuds) < 0.25, `le DOM grossit de jour en jour (${detail})`);
    assert.ok(croissance(j1.ecouteurs, j3.ecouteurs) < 0.25, `les écouteurs s'accumulent (${detail})`);
    assert.ok(croissance(j1.tas, j3.tas) < 0.5, `le tas JavaScript grossit (${detail})`);
  } finally { await b.fermer(); }
});

test('mise à jour de l\'appli : la page repart avec sa mémoire, rien n\'est annoncé deux fois, la famille est là', async () => {
  const b = await ouvrir('2026-10-26T08:55:00', { telephone: true });
  try {
    await demarrer(b, [envoi({ seen: true })]);
    await b.avancer(6 * 60000); // 9 h 01 : le rappel sonne
    assert.ok(await b.visible('#reminder-alert'), 'rappel de 9 h');
    await b.toucher('#reminder-done');
    await b.avancer(1000);
    assert.strictEqual((await b.appels('ackReminder')).length, 1);
    // Mise à jour : Android remplace l'appli, la page repart de zéro mais garde sa mémoire (localStorage) et Android
    // redonne la famille, les envois (déjà vus) et les rappels, dont le « fait » n'est pas encore relu du serveur.
    await b.page.reload();
    await b.avancer(100);
    await demarrer(b, [envoi({ seen: true })]);
    await b.avancer(60000);
    assert.ok(!(await b.visible('#reminder-alert')), 'le rappel déjà fait ne revient pas après la mise à jour');
    assert.ok(!(await b.visible('#overlay')), 'l\'envoi déjà vu ne revient pas en grand');
    assert.match(await b.texte('body'), /Julie/, 'les envois de la famille sont toujours là');
    assert.ok(await b.visible('#home-frame'), 'l\'accueil est affiché');
    assert.deepStrictEqual(await erreurs(b), []);
  } finally { await b.fermer(); }
});
