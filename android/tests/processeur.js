// Processeur de la page au repos (audit ressources du 19/11) : la page tourne « en vrai temps » dans Chromium,
// processeur ralenti 6 fois (ordre de grandeur de la tablette), et on lit le temps passé par le fil principal
// (scripts, styles, mise en page, dessin) pendant DUREE secondes, écran par écran.
// Lancer : node android/tests/processeur.js   (comparaison avant / après, pas une mesure de la vraie tablette).
const { ouvrir, lot, envoi } = require('./banc');

const DUREE = Number(process.env.DUREE || 40);
const RAPPEL = { id: 'r1', title: 'Cachet du matin', kind: 'medicament', time: '10:01', repeat: 'daily', date: '', days: [], lastAck: '', avanceMin: 0, finLe: '', enPauseJusquau: '', voice: '' };

const ECRANS = {
  'accueil de jour (3 photos vues)': async (b) => {
    await b.android('onPosts', lot([envoi({ seen: true }), envoi({ seen: true }), envoi({ seen: true })]));
  },
  'nuit (veille)': async (b) => {
    await b.android('onPosts', lot([envoi({ seen: true })], { veille: { active: true, de: 9 * 60, a: 11 * 60 } }));
  },
  'envoi affiché, pas encore vu': async (b) => {
    await b.android('onPosts', lot([envoi({ seen: true })]));
    await b.avancer(3000);
    await b.android('onPosts', lot([envoi({ seen: true }), envoi({ text: 'Gros bisous de nous tous !' })]));
  },
  'rappel affiché': async (b) => {
    await b.android('onPosts', lot([envoi({ seen: true })]));
    await b.android('onReminders', { reminders: [RAPPEL] });
    await b.avancer(70_000);
  },
};

async function mesurer(nom, preparer) {
  const b = await ouvrir('2026-11-20T10:00:00');
  try {
    await preparer(b);
    await b.avancer(15_000);
    const cdp = await b.page.context().newCDPSession(b.page);
    await cdp.send('Performance.enable');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await b.page.clock.resume();
    const lire = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    await new Promise((r) => setTimeout(r, 3000));
    const a = await lire();
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, DUREE * 1000));
    const z = await lire();
    const s = (Date.now() - t0) / 1000;
    const etat = await b.page.evaluate(() => ({
      animations: document.getAnimations().filter((x) => x.playState === 'running').length,
      envoi: !!document.querySelector('.overlay:not([hidden])'), nuit: document.body.classList.contains('night'),
    }));
    const pc = (k) => (100 * (z[k] - a[k]) / s).toFixed(1).padStart(5);
    console.log(`${nom.padEnd(34)} fil principal ${pc('TaskDuration')} %  dont scripts ${pc('ScriptDuration')} %, styles ${pc('RecalcStyleDuration')} %, mise en page ${pc('LayoutDuration')} %  | nœuds ${z.Nodes}, mémoire JS ${(z.JSHeapUsedSize / 1e6).toFixed(1)} Mo | animations en cours ${etat.animations}${etat.envoi ? ', envoi à l\'écran' : ''}${etat.nuit ? ', nuit' : ''}`);
  } finally { await b.fermer(); }
}

(async () => {
  for (const [nom, preparer] of Object.entries(ECRANS)) await mesurer(nom, preparer);
})();
