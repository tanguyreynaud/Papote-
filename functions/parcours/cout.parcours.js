// Coût Firebase simulé : dix familles vivent trois jours ; chaque lecture et écriture Firestore du serveur est
// comptée par fonction (simulation.js, compteur), puis extrapolée à 10 et 100 familles sur un mois, avec les
// cadences réelles des tâches planifiées (alertesTablettes toutes les 5 min, etc.) et le trafic des appareils
// (tablette : Sync.java ; appli famille : famille.js), lu dans le code. Le tableau sort sur la console : il sert au
// rapport d'inspection. Garde-fous : aucune fonction ne lit « toute la base » pour un seul envoi, aucune lecture
// n'est proportionnelle au carré du nombre de familles.
const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');

const FAMILLES = 10;
const JOURS = 3;

// Exécutions par jour de chaque tâche planifiée (functions/*.js : onSchedule).
const CADENCE = {
  alertesTablettes: 288, relancesPaniers: 24, finDeGrace: 24, gestionCourrier: 24, restitutions: 1, rappelsJumelage: 1,
  alerteMatin: 1, gestionAutomatique: 1, gestionRecap: 1 / 7, gestionCloture: 1 / 30, bilanSupport: 1 / 7,
};

// Prix Firestore (région Europe multi-régions eur3, base nommée « europe » : pas de quota gratuit, celui-ci ne vaut que
// pour la base (default)), en dollars pour 100 000 opérations.
const PRIX = { lectures: 0.06, ecritures: 0.18, suppressions: 0.02 };

// Trafic d'une tablette par jour, lu dans android/Sync.java (push prêt : un tour toutes les 30 min le jour, 60 min la
// nuit de 21 h à 6 h 30 ; à chaque tour : fiche famille + envois nouveaux (≥ 1 lecture) ; rappels et proches toutes
// les 6 h ; « en ligne » écrit à chaque tour ; batterie et journal ponctuels).
const TABLETTE_JOUR = { tours: 29 + 10, lecturesParTour: 2, lecturesRappelsProches: 4 * 2, ecrituresEnLigne: 39, ecrituresDiverses: 6 };
// Appli famille : cache local (persistentLocalCache) : une ouverture ne relit que ce qui a changé ; on compte 3 ouvertures
// par jour et par proche, 5 proches actifs, ~12 lectures par ouverture (famille, proches, envois du jour, agenda).
const APPLI_JOUR = { proches: 5, ouvertures: 3, lecturesParOuverture: 12, ecritures: 4 };

test.before(async () => { await s.demarrer(); });
test.after(async () => { await s.arreter(); });
test.beforeEach(async () => { await s.remettreAZero(); });

async function famille(i) {
  const paul = await s.compte(`Paul${i}`, `paul${i}@exemple.fr`);
  const julie = await s.compte(`Julie${i}`, `julie${i}@exemple.fr`);
  const t = await a.tablettePreparee();
  const { abonnement } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(abonnement, t);
  await a.afficherCode(t);
  const fid = await a.installer(julie, t);
  await a.rejoindre(paul, fid);
  await s.calme();
  return { fid, t, julie, paul, abonnement };
}

// Une journée d'une famille : la tablette se signale, la famille envoie, Mamie regarde, un appel manqué.
async function journeeFamille(f) {
  const tablette = s.db.doc(`families/${f.fid}/members/${f.t.tabletUid}`);
  // L'heure de la simulation (pas celle de l'émulateur) : les alertes comparent lastOnline à Date.now() simulé.
  const maintenant = () => s.Timestamp.fromMillis(Date.now());
  for (let i = 0; i < TABLETTE_JOUR.ecrituresEnLigne; i++) {
    await tablette.update({ lastOnline: maintenant(), version: 208 });
  }
  await tablette.update({ battery: { level: 87, charging: true, unpluggedAt: null }, lastActive: maintenant() });
  const photo = await a.envoyer(f.julie, f.fid, 'photo');
  await a.envoyer(f.paul, f.fid, 'photo');
  await a.envoyer(f.julie, f.fid, 'message', 'Bonne journée Mamie !');
  await s.db.doc(`families/${f.fid}/posts/${photo}`).update({ seenAt: s.FieldValue.serverTimestamp() });
  const appel = await a.appelerDepuisLaTablette(f.t, { vers: f.julie });
  await s.db.doc(`families/${f.fid}/calls/${appel}`).update({ state: 'missed' });
  await s.calme();
}

async function taches() {
  for (const t of Object.keys(CADENCE)) {
    try { await s.tache(t); } catch (e) { s.erreurs.push(`tâche ${t} : ${e.message}`); }
  }
  await s.calme();
}

const n = (x) => Math.round(x).toLocaleString('fr-FR');
const usd = (x) => `${(Math.round(x * 100) / 100).toFixed(2)} $`;

test(`coût du serveur : ${FAMILLES} familles pendant ${JOURS} jours, extrapolé à 10 et 100 familles sur un mois`, async () => {
  const familles = [];
  for (let i = 0; i < FAMILLES; i++) familles.push(await famille(i));
  await s.calme();
  // Jour 0, sans compter : les tâches font leurs écritures de première fois (numéro de tablette recopié…), pour
  // mesurer ensuite le régime de croisière.
  for (const f of familles) await journeeFamille(f);
  await taches();
  s.avancer(1);
  s.erreurs.length = 0;
  s.compteur.activer();
  for (let j = 0; j < JOURS; j++) {
    for (const f of familles) await journeeFamille(f);
    await taches();
    s.avancer(1);
  }
  s.compteur.arreter();
  assert.deepStrictEqual(s.erreurs, [], 'aucune erreur serveur');
  const bilan = s.compteur.bilan();

  // Par fonction et par jour : ce qui dépend du nombre de familles (déclencheurs, onCall) et ce qui n'en dépend pas
  // directement (tâches planifiées : leur nombre d'appels est fixé par la cadence, leurs lectures croissent avec les familles).
  const lignes = [];
  const parMois = { 10: { lectures: 0, ecritures: 0, suppressions: 0, appels: 0 }, 100: { lectures: 0, ecritures: 0, suppressions: 0, appels: 0 } };
  for (const [nom, c] of Object.entries(bilan).sort((x, y) => y[1].lectures - x[1].lectures)) {
    const parAppel = { lectures: c.lectures / c.appels, ecritures: c.ecritures / c.appels, suppressions: c.suppressions / c.appels };
    for (const N of [10, 100]) {
      let appelsMois;
      let facteurLecture;
      if (CADENCE[nom]) {
        appelsMois = CADENCE[nom] * 30;
        // Une tâche lit en proportion des familles : ses lectures par appel mesurées à 10 familles, × N/10 ; au moins ce qu'elle lit à vide.
        facteurLecture = N / FAMILLES;
      } else {
        appelsMois = (c.appels / JOURS / FAMILLES) * N * 30;
        facteurLecture = 1;
      }
      parMois[N].appels += appelsMois;
      parMois[N].lectures += appelsMois * parAppel.lectures * facteurLecture;
      parMois[N].ecritures += appelsMois * parAppel.ecritures * (CADENCE[nom] ? N / FAMILLES : 1);
      parMois[N].suppressions += appelsMois * parAppel.suppressions * (CADENCE[nom] ? N / FAMILLES : 1);
    }
    lignes.push(`| ${nom} | ${CADENCE[nom] ? `${CADENCE[nom]}/j (planifiée)` : `${(c.appels / JOURS / FAMILLES).toFixed(1)}/j/famille`} | ${parAppel.lectures.toFixed(1)} | ${parAppel.ecritures.toFixed(1)} | ${parAppel.suppressions.toFixed(1)} |`);
  }

  const sortie = [];
  sortie.push(`## Mesure : ${FAMILLES} familles, ${JOURS} jours, ${Object.keys(bilan).length} fonctions sollicitées`);
  sortie.push('', '| Fonction | Appels | Lectures/appel | Écritures/appel | Suppressions/appel |', '|---|---|---|---|---|', ...lignes, '');
  sortie.push('## Un mois, serveur + appareils', '');
  sortie.push('| | 10 familles | 100 familles |', '|---|---|---|');
  const total = {};
  for (const N of [10, 100]) {
    const serveur = parMois[N];
    const tablettes = {
      lectures: N * 30 * (TABLETTE_JOUR.tours * TABLETTE_JOUR.lecturesParTour + TABLETTE_JOUR.lecturesRappelsProches),
      ecritures: N * 30 * (TABLETTE_JOUR.ecrituresEnLigne + TABLETTE_JOUR.ecrituresDiverses),
    };
    const appli = {
      lectures: N * 30 * APPLI_JOUR.proches * APPLI_JOUR.ouvertures * APPLI_JOUR.lecturesParOuverture,
      ecritures: N * 30 * APPLI_JOUR.proches * APPLI_JOUR.ecritures,
    };
    const lectures = serveur.lectures + tablettes.lectures + appli.lectures;
    const ecritures = serveur.ecritures + tablettes.ecritures + appli.ecritures;
    const cout = (lectures * PRIX.lectures + ecritures * PRIX.ecritures + serveur.suppressions * PRIX.suppressions) / 100_000;
    total[N] = { serveur, tablettes, appli, lectures, ecritures, cout };
  }
  const ligne = (titre, f) => sortie.push(`| ${titre} | ${f(total[10])} | ${f(total[100])} |`);
  ligne('Appels de fonctions (serveur)', (t) => n(t.serveur.appels));
  ligne('Lectures serveur', (t) => n(t.serveur.lectures));
  ligne('Écritures serveur', (t) => n(t.serveur.ecritures));
  ligne('Lectures tablettes', (t) => n(t.tablettes.lectures));
  ligne('Écritures tablettes', (t) => n(t.tablettes.ecritures));
  ligne('Lectures appli famille', (t) => n(t.appli.lectures));
  ligne('Écritures appli famille', (t) => n(t.appli.ecritures));
  ligne('**Lectures en tout**', (t) => `**${n(t.lectures)}**`);
  ligne('**Écritures en tout**', (t) => `**${n(t.ecritures)}**`);
  ligne('Firestore (eur3, sans quota gratuit)', (t) => usd(t.cout));
  ligne('Par famille et par mois', (t) => usd(t.cout / (t === total[10] ? 10 : 100)));
  sortie.push('', 'Hors tableau : Cloud Functions (2 M d\'appels gratuits par mois, loin au-dessus), Cloud Scheduler (11 tâches planifiées :',
    '3 gratuites puis 0,10 $/tâche/mois ≈ 0,80 $/mois fixes), Storage (photos : 200 × ~300 ko × N familles), sortie réseau.');
  console.log(`\n${sortie.join('\n')}\n`);
  if (process.env.COUT_DETAIL) {
    for (const [nom, c] of Object.entries(bilan)) {
      if (!c.chemins) continue;
      const parChemin = new Map();
      c.chemins.forEach((ch) => parChemin.set(ch, (parChemin.get(ch) || 0) + 1));
      console.log(`${nom} écrit : ${[...parChemin].map(([ch, k]) => `${ch} ×${k}`).join(', ')}`);
    }
  }

  // Garde-fous.
  for (const [nom, c] of Object.entries(bilan)) {
    const parAppel = c.lectures / c.appels;
    // Une tâche fréquente (toutes les 5 min, toutes les heures) ne doit lire que l'essentiel ; une tâche quotidienne ou
    // plus rare peut lire toute la base ; un déclencheur ne lit que sa famille.
    const plafond = CADENCE[nom] >= 24 ? 4 * FAMILLES + 5 : CADENCE[nom] ? 12 * FAMILLES + 20 : 12;
    assert.ok(parAppel <= plafond, `${nom} lit ${parAppel.toFixed(1)} documents par appel (plafond ${plafond} pour ${FAMILLES} familles)`);
    // Et n'écrit pas à chaque passage quand rien n'a changé.
    if (CADENCE[nom] >= 24) assert.ok(c.ecritures / c.appels <= 1, `${nom} écrit ${(c.ecritures / c.appels).toFixed(1)} documents à chaque passage`);
  }
  // Les écritures de la tablette (en ligne, batterie) ne doivent pas déclencher de lecture serveur à chaque fois.
  const cp = bilan.compterProches;
  assert.ok(cp && cp.lectures / cp.appels < 1, `compterProches relit les proches à chaque signe de vie de la tablette (${cp && (cp.lectures / cp.appels).toFixed(2)} lecture/appel)`);
  assert.ok(total[100].cout < 20, `plus de 20 $ par mois pour 100 familles : ${usd(total[100].cout)}`);
});
