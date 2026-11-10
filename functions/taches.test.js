// Tâches planifiées regroupées (taches.js) : chaque tâche tourne exactement quand elle tournait avec sa propre
// fonction planifiée, une tâche en erreur n'arrête pas les autres, alertesTablettes n'a pas changé.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { logger } = require('firebase-functions/v2');
const taches = require('./taches');
const { aLancer, heureParis } = taches._test;

// Les anciennes « schedule » de chaque fonction (avant le regroupement), toutes en Europe/Paris.
const ANCIEN = {
  relancesPaniers: 'every 60 minutes',
  finDeGrace: 'every 1 hours',
  gestionCourrier: 'every 60 minutes',
  gestionAutomatique: 'every day 04:00',
  restitutions: 'every day 09:00',
  rappelsJumelage: 'every day 10:00',
  alerteMatin: require('./alertes').HORAIRE_PAS_VUE,
  alerteForfait: 'every 60 minutes', // nouvelle (5/11) : forfait SIM à 80 et 95 %
  relancesSepa: 'every day 11:00', // nouvelle (10/11) : « passer au prélèvement »
  gestionCopieVentes: 'every day 06:00', // nouvelle (10/11) : copie des PDF des factures de vente
  gestionRecap: 'every monday 08:00',
  bilanSupport: 'every monday 09:00',
  purgeMensuelle: '1 of month 04:00',
  gestionCloture: '0 5 1 * *',
};

// Date et heure à Paris d'un instant, lues sans passer par taches.js.
function paris(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    weekday: 'long', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { jour: Number(p.day), heure: Number(p.hour), minute: Number(p.minute), semaine: p.weekday.toLowerCase() };
}

// L'ancienne règle : la tâche tournait-elle à cet instant (heure pile) ?
function tournaitAvant(schedule, ms) {
  const p = paris(ms);
  let m;
  if (/^every (60 minutes|1 hours)$/.test(schedule)) return p.minute === 0;
  if ((m = /^every day (\d\d):(\d\d)$/.exec(schedule))) return p.heure === +m[1] && p.minute === +m[2];
  if ((m = /^every (\w+day) (\d\d):(\d\d)$/.exec(schedule))) return p.semaine === m[1] && p.heure === +m[2] && p.minute === +m[3];
  if ((m = /^1 of month (\d\d):(\d\d)$/.exec(schedule))) return p.jour === 1 && p.heure === +m[1] && p.minute === +m[2];
  if ((m = /^(\d+) (\d+) 1 \* \*$/.exec(schedule))) return p.jour === 1 && p.heure === +m[2] && p.minute === +m[1];
  throw new Error(`schedule inconnue : ${schedule}`);
}
const avant = (ms) => Object.keys(ANCIEN).filter((nom) => tournaitAvant(ANCIEN[nom], ms)).sort();
const maintenant = (ms) => aLancer(ms).sort();

test('le planning couvre exactement les 11 anciennes tâches, l\'alerte de forfait, les e-mails SEPA et la copie des factures', () => {
  assert.deepStrictEqual(Object.keys(taches.PLANNING).sort(), Object.keys(ANCIEN).sort());
});

test('chaque heure pile de 2026 et 2027 (changements d\'heure compris) : les mêmes tâches qu\'avant', () => {
  const debut = Date.parse('2025-12-31T23:00:00Z');
  const fin = Date.parse('2028-01-01T00:00:00Z');
  const compte = {};
  for (let t = debut; t < fin; t += 3600e3) {
    assert.deepStrictEqual(maintenant(t), avant(t), new Date(t).toISOString());
    for (const nom of aLancer(t)) compte[nom] = (compte[nom] || 0) + 1;
  }
  // Deux ans : 730 jours, 104 lundis (2026 : 52, 2027 : 52), 24 premiers du mois.
  for (const nom of ['gestionAutomatique', 'restitutions', 'rappelsJumelage', 'alerteMatin', 'relancesSepa', 'gestionCopieVentes']) assert.strictEqual(compte[nom], 730, nom);
  for (const nom of ['gestionRecap', 'bilanSupport']) assert.strictEqual(compte[nom], 104, nom);
  for (const nom of ['purgeMensuelle', 'gestionCloture']) assert.strictEqual(compte[nom], 24, nom);
});

test('table de dates à Paris, dont les changements d\'heure', () => {
  const H = ['relancesPaniers', 'finDeGrace', 'gestionCourrier', 'alerteForfait'];
  const cas = [
    // [instant UTC, heure de Paris, tâches en plus des horaires]
    ['2026-03-29T00:00:00Z', 'dim. 29/03 1 h (avant le passage à l\'heure d\'été)', []],
    ['2026-03-29T01:00:00Z', 'dim. 29/03 3 h (2 h n\'existe pas)', []],
    ['2026-03-29T02:00:00Z', 'dim. 29/03 4 h (heure d\'été)', ['gestionAutomatique']],
    ['2026-03-29T08:00:00Z', 'dim. 29/03 10 h (heure d\'été)', ['rappelsJumelage', 'alerteMatin']],
    ['2026-03-30T06:00:00Z', 'lun. 30/03 8 h', ['gestionRecap']],
    ['2026-03-30T07:00:00Z', 'lun. 30/03 9 h', ['restitutions', 'bilanSupport']],
    ['2026-10-25T00:00:00Z', 'dim. 25/10 2 h (heure d\'été)', []],
    ['2026-10-25T01:00:00Z', 'dim. 25/10 2 h (heure d\'hiver, deuxième fois)', []],
    ['2026-10-25T03:00:00Z', 'dim. 25/10 4 h (heure d\'hiver)', ['gestionAutomatique']],
    ['2026-10-25T09:00:00Z', 'dim. 25/10 10 h (heure d\'hiver)', ['rappelsJumelage', 'alerteMatin']],
    ['2026-11-01T03:00:00Z', 'dim. 1/11 4 h', ['gestionAutomatique', 'purgeMensuelle']],
    ['2026-11-01T04:00:00Z', 'dim. 1/11 5 h', ['gestionCloture']],
    ['2026-11-02T07:00:00Z', 'lun. 2/11 8 h', ['gestionRecap']],
    ['2026-11-02T08:00:00Z', 'lun. 2/11 9 h', ['restitutions', 'bilanSupport']],
    ['2026-11-02T09:00:00Z', 'lun. 2/11 10 h', ['rappelsJumelage', 'alerteMatin']],
    ['2026-11-04T08:00:00Z', 'mer. 4/11 9 h', ['restitutions']],
    ['2026-11-04T22:00:00Z', 'mer. 4/11 23 h', []],
    ['2027-02-01T03:00:00Z', 'lun. 1/02 4 h', ['gestionAutomatique', 'purgeMensuelle']],
    ['2027-02-01T04:00:00Z', 'lun. 1/02 5 h', ['gestionCloture']],
    ['2027-02-01T07:00:00Z', 'lun. 1/02 8 h', ['gestionRecap']],
    ['2027-03-01T03:00:00Z', 'lun. 1/03 4 h', ['gestionAutomatique', 'purgeMensuelle']],
    ['2027-03-28T02:00:00Z', 'dim. 28/03 4 h (heure d\'été)', ['gestionAutomatique']],
    ['2027-03-29T06:00:00Z', 'lun. 29/03 8 h (heure d\'été)', ['gestionRecap']],
  ];
  for (const [iso, libelle, plus] of cas) {
    const t = Date.parse(iso);
    assert.deepStrictEqual(maintenant(t), [...H, ...plus].sort(), libelle);
    assert.deepStrictEqual(maintenant(t), avant(t), `${libelle} : comme avant`);
  }
});

test('un départ quelques secondes en retard (ou en avance) compte pour l\'heure pile', () => {
  const quatreHeures = Date.parse('2026-11-01T03:00:00Z');
  assert.deepStrictEqual(heureParis(quatreHeures + 45e3), { heure: 4, lundi: false, jour: 1 });
  assert.deepStrictEqual(heureParis(quatreHeures - 10e3), { heure: 4, lundi: false, jour: 1 });
  assert.ok(aLancer(quatreHeures + 5 * 60e3).includes('purgeMensuelle'));
});

function stubs(erreurs = {}) {
  const lancees = [];
  const t = {};
  for (const nom of Object.keys(taches.PLANNING)) {
    t[nom] = async () => {
      lancees.push(nom);
      await new Promise((r) => setImmediate(r));
      if (erreurs[nom]) throw new Error(erreurs[nom]);
      return nom;
    };
  }
  return { t, lancees };
}

test('tachesHoraires : toutes les heures pile à Paris, lance les tâches dues', async () => {
  const { t, lancees } = stubs();
  const f = taches.planifier(t);
  assert.strictEqual(f.__endpoint.scheduleTrigger.schedule, '0 * * * *');
  assert.strictEqual(f.__endpoint.scheduleTrigger.timeZone, 'Europe/Paris');
  assert.strictEqual(f.__endpoint.timeoutSeconds, 1800);
  // Lundi 1er février 2027, 4 h à Paris.
  const bilan = await f.run({ scheduleTime: '2027-02-01T03:00:00.000Z' });
  assert.deepStrictEqual(lancees.sort(), ['alerteForfait', 'finDeGrace', 'gestionAutomatique', 'gestionCourrier', 'purgeMensuelle', 'relancesPaniers']);
  assert.deepStrictEqual(Object.values(bilan), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
});

test('une tâche en erreur n\'arrête pas les autres et reste visible (logger.error)', async (ctx) => {
  const journal = [];
  ctx.mock.method(logger, 'error', (...args) => journal.push(args));
  const { t, lancees } = stubs({ restitutions: 'Stripe indisponible', relancesPaniers: 'SMTP refusé' });
  delete t.bilanSupport; // tâche absente : erreur, les autres tournent quand même
  const f = taches.planifier(t);
  // Lundi 2 novembre 2026, 9 h à Paris.
  const bilan = await f.run({ scheduleTime: '2026-11-02T08:00:00.000Z' });
  assert.deepStrictEqual(lancees.sort(), ['alerteForfait', 'finDeGrace', 'gestionCourrier', 'relancesPaniers', 'restitutions']);
  assert.deepStrictEqual(bilan, {
    relancesPaniers: 'erreur', finDeGrace: 'ok', gestionCourrier: 'ok', alerteForfait: 'ok', restitutions: 'erreur', bilanSupport: 'erreur',
  });
  assert.deepStrictEqual(journal.map((j) => j[0]).sort(), [
    'Tâche planifiée bilanSupport en erreur', 'Tâche planifiée relancesPaniers en erreur', 'Tâche planifiée restitutions en erreur',
  ]);
  assert.strictEqual(journal.find((j) => j[0].includes('restitutions'))[1].message, 'Stripe indisponible');
});

test('une tâche lente ne retarde pas le départ des autres', async () => {
  const parties = [];
  let liberer;
  const t = {
    relancesPaniers: async () => { parties.push('relancesPaniers'); await new Promise((r) => { liberer = r; }); },
    finDeGrace: async () => { parties.push('finDeGrace'); },
    gestionCourrier: async () => { parties.push('gestionCourrier'); },
    alerteForfait: async () => { parties.push('alerteForfait'); },
  };
  const course = taches._test.lancer(t, Date.parse('2026-11-04T22:00:00Z'));
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(parties.sort(), ['alerteForfait', 'finDeGrace', 'gestionCourrier', 'relancesPaniers']);
  liberer();
  assert.deepStrictEqual(await course, { relancesPaniers: 'ok', finDeGrace: 'ok', gestionCourrier: 'ok', alerteForfait: 'ok' });
});

test('index.js : deux fonctions planifiées seulement, alertesTablettes inchangée, toutes les tâches branchées', () => {
  const fonctions = require('./index');
  const planifiees = Object.keys(fonctions).filter((k) => fonctions[k] && fonctions[k].__endpoint && fonctions[k].__endpoint.scheduleTrigger);
  assert.deepStrictEqual(planifiees.sort(), ['alertesTablettes', 'tachesHoraires']);
  const alertes = fonctions.alertesTablettes.__endpoint;
  assert.strictEqual(alertes.scheduleTrigger.schedule, 'every 5 minutes');
  assert.strictEqual(alertes.scheduleTrigger.timeZone, 'Europe/Paris');
  assert.strictEqual(fonctions.alertesTablettes, require('./alertes').alertesTablettes);
  for (const nom of Object.keys(ANCIEN)) {
    assert.strictEqual(fonctions[nom], undefined, `${nom} n'est plus une fonction déployée`);
    assert.strictEqual(typeof fonctions.tachesHoraires.taches[nom], 'function', `${nom} branchée`);
  }
  const secrets = fonctions.tachesHoraires.__endpoint.secretEnvironmentVariables.map((s) => s.key).sort();
  assert.deepStrictEqual(secrets, ['ANTHROPIC_API_KEY', 'FACTURES_MOT_DE_PASSE', 'MAIL_MOT_DE_PASSE', 'SENDCLOUD_API', 'STRIPE_SECRET']);
  // Aucun autre onSchedule dans le code (au-delà de 3, Cloud Scheduler est payant).
  const appels = fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .flatMap((f) => (fs.readFileSync(path.join(__dirname, f), 'utf8').match(/onSchedule\(/g) || []).map(() => f));
  assert.deepStrictEqual(appels.sort(), ['alertes.js', 'taches.js']);
});
