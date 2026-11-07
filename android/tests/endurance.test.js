// Endurance : des journées entières de la vie de la tablette sans rechargement de la page (audit du 05/11).
// Les minuteries, les écoutes Firebase, les connexions WebRTC, les flux caméra et le DOM doivent rester
// bornés jour après jour (une pente régulière = une fuite). Mesure longue : ENDURANCE_JOURS=30.
// Lancement : node --test android/tests/endurance.test.js
const test = require('node:test');
const assert = require('node:assert');
const { ouvrirEndurance, journee, mesurer, erreurs } = require('./endurance');

const JOURS = Number(process.env.ENDURANCE_JOURS || 6);

test(`${JOURS} jours sans redémarrage : minuteries, écoutes, appels et mémoire restent bornés`, { timeout: JOURS * 120000 + 60000 }, async () => {
  const { b, etat } = await ouvrirEndurance();
  etat.sansRechargement = true;
  const mesures = [];
  try {
    mesures.push(await mesurer(b));
    for (let jour = 1; jour <= JOURS; jour++) {
      await journee(b, etat, jour);
      const ev = await b.page.evaluate(() => {
        const n = {};
        window.__appels.forEach((a) => { if (['ring', 'inCall', 'sendSms', 'phoneCall', 'setSleep', 'setDim', 'ackReminder', 'markSeen', 'playVideo'].includes(a.nom)) n[a.nom] = (n[a.nom] || 0) + 1; });
        n.visios = window.__fs.liste('families/F1/calls/').map((c) => window.__fs.lire(c).state).join(',');
        return n;
      });
      await b.vider();
      // Les appels finis restent dans la base imitée du banc (offres WebRTC, ~10 Ko par jour) : on les retire
      // pour ne mesurer que la page.
      await b.page.evaluate(() => { for (const k of [...window.__fs.docs.keys()]) if (k.startsWith('families/F1/calls/')) window.__fs.docs.delete(k); });
      const m = await mesurer(b);
      mesures.push(m);
      const { detailIntervalles, detailDelais, ...court } = m;
      console.log(`J${jour} ${JSON.stringify(court)} gestes ${JSON.stringify(ev)}`);
    }
    const dernier = mesures[mesures.length - 1];
    console.log('localStorage :', await b.page.evaluate(() => JSON.stringify(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k).length]))));
    console.log('intervalles vivants :', JSON.stringify(dernier.detailIntervalles, null, 1));
    console.log('délais en attente :', JSON.stringify(dernier.detailDelais, null, 1));
    if (process.env.ENDURANCE_CSV) require('node:fs').writeFileSync(process.env.ENDURANCE_CSV, JSON.stringify(mesures, null, 1));
    assert.deepStrictEqual(await erreurs(b), [], 'erreurs JavaScript');
    // Pente à partir de J4 : le 1er jour remplit les caches normaux (60 envois, visages, détecteur) et J3
    // ajoute une fois pour toutes les deux vidéos du diaporama (~150 nœuds chacune), plat ensuite
    // (relevé de Gestion sur d806686, 07/11). Seuil inchangé. Moins de 5 jours : depuis J1, comme avant.
    const debut = mesures.length > 5 ? 4 : 1;
    const a = mesures[debut], z = dernier, n = mesures.length - 1 - debut || 1;
    const pente = (k) => (z[k] - a[k]) / n;
    const detail = `pente/jour : intervalles ${pente('intervalles')}, délais ${pente('delais')}, écoutes Firestore ${pente('ecoutesFirestore')}, ` +
      `WebRTC ${pente('pcOuvertes')}, flux ${pente('fluxActifs')}, nœuds ${pente('noeuds')}, écouteurs ${pente('ecouteurs')}, ` +
      `vidéos ${pente('videos')}, tas ${(pente('tas') / 1024).toFixed(0)} Ko`;
    console.log(detail);
    assert.ok(z.intervalles <= a.intervalles, `des setInterval s'accumulent (${detail})`);
    assert.ok(z.delais <= a.delais + 3, `des setTimeout s'accumulent (${detail})`);
    assert.ok(z.ecoutesFirestore <= a.ecoutesFirestore, `des écoutes Firestore ne sont jamais coupées (${detail})`);
    assert.strictEqual(z.pcOuvertes, 0, `connexions WebRTC restées ouvertes (${detail})`);
    assert.strictEqual(z.fluxActifs, 0, `caméra ou micro resté allumé hors appel (${detail})`);
    assert.strictEqual(z.blobs, 0, 'adresses blob: jamais rendues');
    assert.ok(z.ecouteurs - a.ecouteurs <= 2 * n, `les écouteurs d'événements s'accumulent (${detail})`);
    assert.ok(z.noeuds - a.noeuds <= 50 * n, `le DOM grossit (${detail})`);
    assert.ok(z.tas - a.tas <= 256 * 1024 * n, `le tas JavaScript grossit de plus de 256 Ko par jour (${detail})`);
  } finally { await b.fermer(); }
});

// ---------- Essais courts, un par fuite ou dépense trouvée par l'audit du 05/11 ----------
const { ouvrir, lot, envoi, ORIGIN } = require('./banc');

async function compterMutations(b, ms) {
  await b.page.evaluate(() => {
    window.__mut = {};
    window.__obs = new MutationObserver((l) => l.forEach((m) => {
      const t = m.target.nodeType === 3 ? m.target.parentNode : m.target;
      const k = m.type + ':' + ((t && (t.id || t.className)) || '?');
      window.__mut[k] = (window.__mut[k] || 0) + 1;
    }));
    window.__obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await b.avancer(ms);
  return b.page.evaluate(() => { window.__obs.disconnect(); return window.__mut; });
}
const total = (m) => Object.values(m).reduce((a, c) => a + c, 0);

async function accueil(heure) {
  const b = await ouvrir(heure);
  await b.android('onPosts', lot([envoi({ seen: true }), envoi({ seen: true }), envoi({ seen: true })]));
  await b.android('onFamily', { faces: {}, birthdays: [], people: [{ uid: 'julie', name: 'Julie' }] });
  await b.android('onReminders', { reminders: [] });
  await b.avancer(15000);
  return b;
}

test('la nuit, sous l\'écran noir : plus de photo qui défile ni de bouton refait chaque seconde', async () => {
  const b = await accueil('2026-10-26T02:00:00');
  try {
    const m = await compterMutations(b, 10 * 60000);
    console.log('nuit, mutations en 10 min :', total(m), JSON.stringify(m));
    // Avant : plus de 5 000 changements en 10 min (heure réécrite 5 fois par seconde, bouton radio refait
    // chaque seconde, photo de l'accueil en fondu et zoom sans fin). Restent les petites mises à jour à la minute.
    assert.ok(total(m) <= 200, `la page travaille sous l'écran noir : ${total(m)} changements en 10 min (${JSON.stringify(m)})`);
  } finally { await b.fermer(); }
});

test('le jour, au repos : l\'heure et la date ne sont réécrites qu\'au changement de minute', async () => {
  const b = await accueil('2026-10-26T10:00:00');
  try {
    const m = await compterMutations(b, 10 * 60000);
    const textes = Object.keys(m).filter((k) => /^childList:(clock|setup-clock|date|overlay-clock|moment)$/.test(k)).reduce((a, k) => a + m[k], 0);
    console.log('jour, textes de l\'horloge réécrits en 10 min :', textes);
    assert.ok(textes <= 5 * 11, `l'horloge est réécrite chaque seconde : ${textes} fois en 10 min`);
  } finally { await b.fermer(); }
});

test('envoi affiché, Mamie absente 3 h : la caméra ne reste pas allumée, mais la voit dès son retour', async () => {
  const b = await ouvrir('2026-10-26T10:00:00');
  try {
    await b.android('onPosts', lot([envoi({ text: 'Coucou' })]));
    await b.avancer(5000);
    assert.ok(await b.visible('#overlay'), 'envoi affiché');
    let allumee = 0;
    for (let min = 0; min < 180; min++) {
      await b.avancer(60000);
      if (await b.page.evaluate(() => window.__surveillances.size > 0)) allumee++;
    }
    console.log(`caméra allumée ${allumee} min sur 180`);
    assert.ok(allumee <= 180 * 0.3, `caméra allumée ${allumee} min sur 180 pour un envoi pas encore vu`);
    // Mamie revient : elle est vue au plus 5 minutes après.
    let vue = false;
    for (let min = 0; min < 5 && !vue; min++) {
      await b.page.evaluate(() => window.__visage());
      vue = (await b.appels('markSeen')).length > 0;
      if (!vue) await b.avancer(60000);
    }
    assert.ok(vue, 'Mamie de retour : l\'envoi est vu');
  } finally { await b.fermer(); }
});

test('diaporama avec vidéos pendant des heures : pas d\'écouteur ajouté à chaque vidéo', async () => {
  const b = await ouvrir('2026-10-26T10:00:00');
  try {
    const posts = [
      envoi({ seen: true, type: 'video', image: null, video: `${ORIGIN}/photos/v1.mp4` }),
      envoi({ seen: true }),
      envoi({ seen: true, type: 'video', image: null, video: `${ORIGIN}/photos/v2.mp4` }),
    ];
    await b.android('onPosts', lot(posts));
    await b.avancer(2000);
    const ecouteurs = async () => {
      const cdp = await b.page.context().newCDPSession(b.page);
      await cdp.send('Performance.enable');
      await cdp.send('HeapProfiler.collectGarbage');
      const { metrics } = await cdp.send('Performance.getMetrics');
      await cdp.detach();
      return metrics.find((x) => x.name === 'JSEventListeners').value;
    };
    let avant = 0;
    for (let tour = 0; tour < 10; tour++) {
      if (tour === 2) avant = await ecouteurs(); // après deux tours : les écouteurs posés une fois pour toutes
      await b.toucher('#home-frame');
      for (let i = 0; i < 6; i++) { await b.toucher('#photo-next').catch(() => {}); await b.avancer(500); }
      await b.avancer(6 * 60000); // retour seul à l'accueil
    }
    const apres = await ecouteurs();
    console.log(`écouteurs : ${avant} → ${apres}`);
    assert.ok(apres - avant <= 3, `écouteurs ajoutés à chaque vidéo du diaporama : ${avant} → ${apres}`);
  } finally { await b.fermer(); }
});
