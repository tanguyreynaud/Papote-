// Charge : N familles (100 par défaut) vivent une journée complète, le pire jour du mois (lundi 1er : toutes les tâches
// de tachesHoraires tombent ce jour-là, dont purge, clôture et récap). Une famille est créée par le vrai parcours
// (commande, paiement, envoi, installation, proches) ; les autres en sont des copies (identifiants changés), avec des
// états variés : impayés, suspendues, résiliées en attente de la tablette, pause hospitalisation, tablettes muettes
// ou débranchées, 2 à 6 proches avec jetons de notification, 40 envois d'historique (CHARGE_HISTORIQUE).
//
// Mesure, par fonction : appels, lectures, écritures, durée (émulateur : la durée en ligne est plus longue, chaque
// aller-retour vers Firestore y coûte ~10 à 30 ms), e-mails partis (Brevo gratuit : 300 par jour) et notifications.
//
// Lancement (long : ~5 min à 100 familles, hors CI) :
//   CHARGE_FAMILLES=100 npx firebase-tools@14 emulators:exec --only firestore,auth --project demo-papote \
//     --config parcours/firebase.json "node --test --test-timeout=3600000 parcours/charge.parcours.js"
// Sans CHARGE_FAMILLES, le scénario est sauté (npm run parcours reste rapide).
const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');

const N = Number(process.env.CHARGE_FAMILLES || 0);
// alertesTablettes tourne 288 fois par jour ; on en joue un tour par heure (24) et on extrapole.
const TOURS_ALERTES = Number(process.env.CHARGE_TOURS_ALERTES || 24);
const JOUR_PIRE = Date.parse('2027-01-31T23:00:00Z'); // lundi 1er février 2027, 0 h à Paris
const HEURE = 3600e3;
// Envois d'historique par famille (40 : ~2 semaines) ; moins pour 1 000 familles, la copie déclenche voixEnvoi et quotaEnvois.
const HISTORIQUE = Number(process.env.CHARGE_HISTORIQUE || 40);
// Heures jouées (toutes par défaut) ; pour 1 000 familles : CHARGE_HEURES=4,10 (pire heure des tâches, alerteMatin).
const HEURES = process.env.CHARGE_HEURES ? process.env.CHARGE_HEURES.split(',').map(Number) : [...Array(24).keys()];

const { _test: taches } = require('../taches');

test.before(async () => { if (N) await s.demarrer(); });
test.after(async () => { if (N) await s.arreter(); });

// Tous les documents sous un document (récursif).
async function sousArbre(ref, acc = []) {
  const snap = await ref.get();
  if (snap.exists) acc.push(snap);
  for (const col of await ref.listCollections()) {
    for (const d of await col.listDocuments()) await sousArbre(d, acc);
  }
  return acc;
}

// Écrivain en lot qui réessaie (l'émulateur répond parfois UNKNOWN sous la charge).
function ecrivainEnLot() {
  const w = s.db.bulkWriter();
  w.onWriteError((e) => e.failedAttempts < 10);
  return w;
}

// Copie profonde d'une valeur Firestore en remplaçant les identifiants de la famille modèle.
function copier(v, remplacer) {
  if (typeof v === 'string') return remplacer(v);
  if (Array.isArray(v)) return v.map((x) => copier(x, remplacer));
  if (v && typeof v === 'object') {
    if (v instanceof s.Timestamp || v instanceof Date || Buffer.isBuffer(v) || v.constructor.name === 'GeoPoint') return v;
    if (v.constructor.name === 'DocumentReference') return s.db.doc(remplacer(v.path));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [remplacer(k), copier(x, remplacer)]));
  }
  return v;
}

const ts = (ms) => s.Timestamp.fromMillis(ms);

test(`charge : ${N || '(sauté)'} familles, une journée complète (lundi 1er)`, { skip: !N }, async () => {
  const debutTotal = performance.now();
  // La veille du pire jour, 10 h.
  s.avancer((JOUR_PIRE - 14 * HEURE - Date.now()) / s.JOUR);

  // ---------- 1. La famille modèle, par le vrai parcours ----------
  const boiteAvant = s.boite.length;
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(abonnement, t);
  await a.afficherCode(t);
  const fid = await a.installer(julie, t);
  await a.rejoindre(paul, fid);
  await s.calme();
  const courrielsArrivee = s.boite.slice(boiteAvant).map((m) => m.sujet);
  const fiche = await s.lire(`stock/${t.fiche}`);
  const famille = await s.lire(`families/${fid}`);
  const docs = [
    ...await sousArbre(s.db.doc(`families/${fid}`)),
    await s.db.doc(`commandes/${abonnement}`).get(),
    await s.db.doc(`stock/${t.fiche}`).get(),
    await s.db.doc(`pairings/${t.code}`).get(),
    ...(fiche.simId ? [await s.db.doc(`sims/${fiche.simId}`).get()] : []),
    ...(await s.db.collection('clesTablettes').where('serie', '==', t.serie).get()).docs,
  ].filter((d) => d.exists);
  const ids = [fid, abonnement, t.fiche, t.code, t.serie, julie.uid, paul.uid, julie.email, paul.email, fiche.simId, famille.code]
    .filter((x) => typeof x === 'string' && x.length >= 4);
  const motif = new RegExp(ids.sort((x, y) => y.length - x.length).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  if (process.env.CHARGE_DEBUG) console.log('Modèle', JSON.stringify({ famille, commande: await s.lire(`commandes/${abonnement}`), docs: docs.map((d) => d.ref.path) }, null, 1));

  // ---------- 2. Les N-1 copies, états variés ----------
  const debutCopie = performance.now();
  const ecrivain = ecrivainEnLot();
  const maintenant = Date.now();
  const familles = [{ fid, tablette: t.tabletUid, appels: t.callsUid, proches: [julie.uid, paul.uid], silencieuse: false }];
  for (let k = 1; k < N; k++) {
    const suffixe = `k${k}`;
    const remplacer = (x) => x.replace(motif, (m) => (m.includes('@') ? m.replace('@', `+${suffixe}@`) : `${m}${suffixe}`));
    const copies = new Map(docs.map((d) => [remplacer(d.ref.path), copier(d.data(), remplacer)]));
    const f = { fid: `${fid}${suffixe}`, tablette: remplacer(t.tabletUid), appels: remplacer(t.callsUid), proches: [remplacer(julie.uid), remplacer(paul.uid)] };
    // 2 à 6 proches en tout, chacun avec un jeton de notification (navigateur ou app Android).
    for (let p = 0; p < k % 5; p++) {
      const uid = `proche-${suffixe}-${p}`;
      f.proches.push(uid);
      ecrivain.set(s.db.doc(`families/${f.fid}/members/${uid}`), {
        name: `Proche${p}`, role: 'famille', uid, email: `proche${p}+${suffixe}@exemple.fr`, status: 'active', canCall: true,
        joinedAt: ts(maintenant - 20 * s.JOUR), recoitAppels: true,
      });
    }
    // Historique : 40 envois (photos, messages, vidéos) des semaines passées.
    for (let p = 0; p < HISTORIQUE; p++) {
      const type = ['photo', 'message', 'photo', 'video'][p % 4];
      ecrivain.set(s.db.doc(`families/${f.fid}/posts/h${p}`), {
        type, authorUid: f.proches[p % f.proches.length], authorName: 'Julie', createdAt: ts(maintenant - (p + 1) * 9 * HEURE),
        text: type === 'message' ? 'Coucou Mamie' : '', seenAt: ts(maintenant - p * 9 * HEURE), hearts: p % 3, hasMedia: type !== 'message',
        ...(type === 'message' ? {} : { storagePath: `families/${f.fid}/media/h${p}.${type === 'video' ? 'mp4' : 'jpg'}` }),
      });
    }
    // États : 3 % impayés (délai de grâce en cours), 2 % suspendues, 2 % résiliées (tablette attendue), 2 % en pause
    // hospitalisation ; 5 % de tablettes muettes, 3 % débranchées.
    const fam = copies.get(`families/${f.fid}`);
    const commande = copies.get(`commandes/${abonnement}${suffixe}`);
    if (k % 33 === 1) Object.assign(fam.abonnement, { statut: 'impaye', graceJusqua: ts(JOUR_PIRE + 5 * s.JOUR) });
    if (k % 50 === 2) Object.assign(fam.abonnement, { statut: 'suspendu', suspenduLe: ts(maintenant - 3 * s.JOUR) });
    if (k % 50 === 3) {
      Object.assign(fam.abonnement, { statut: 'resilie' });
      commande.restitution = { statut: 'attendue', avant: ts(JOUR_PIRE + 20 * s.JOUR) };
    }
    if (k % 50 === 4) commande.pause = { jusqua: ts(JOUR_PIRE + 10 * s.JOUR) };
    for (const [chemin, data] of copies) ecrivain.set(s.db.doc(chemin), data);
    f.silencieuse = k % 20 === 5;
    f.debranchee = k % 33 === 6;
    familles.push(f);
  }
  // Jetons de notification des proches de la famille modèle aussi.
  for (const f of familles) {
    for (const uid of f.proches) ecrivain.set(s.db.doc(`families/${f.fid}/members/${uid}/private/push`), { tokens: [`jeton-${uid}`] });
  }
  // Paniers abandonnés et contacts de la liste d'attente (relances, purge).
  for (let k = 0; k < Math.ceil(N / 5); k++) {
    ecrivain.set(s.db.doc(`paniers/p${k}`), { email: `panier${k}@exemple.fr`, marketing: true, creeLe: ts(maintenant - (k % 9) * s.JOUR - 2 * HEURE), requete: 'formule=sim', nom: 'X', formule: 'sim', relances: 0 });
    ecrivain.set(s.db.doc(`contacts/c${k}`), { email: `contact${k}@exemple.fr`, listeAttente: true, consentement: true, creeLe: ts(maintenant - 40 * s.JOUR) });
  }
  await ecrivain.close();
  await s.calme(600_000);
  const dureeCopie = performance.now() - debutCopie;
  s.erreurs.length = 0;

  // ---------- 3. La journée ----------
  s.avancer((JOUR_PIRE - Date.now()) / s.JOUR);
  const boiteJour = s.boite.length;
  const notifsJour = s.notifications.length;
  const durees = {};
  const chrono = async (nom, f) => {
    const t0 = performance.now();
    try { return await f(); } finally { (durees[nom] = durees[nom] || []).push(performance.now() - t0); }
  };
  // Battement des tablettes (sauf les muettes) avant chaque tour d'alertes joué : 1 écriture par tablette.
  const battre = async () => {
    const w = ecrivainEnLot();
    for (const f of familles) {
      if (f.silencieuse) continue;
      w.update(s.db.doc(`families/${f.fid}/members/${f.tablette}`), {
        lastOnline: ts(Date.now() - 5 * 60e3), lastActive: ts(Date.now() - 2 * HEURE),
        battery: f.debranchee ? { level: 60, charging: false, unpluggedAt: ts(Date.now() - 30 * 60e3) } : { level: 90, charging: true, unpluggedAt: null },
      });
    }
    await w.close();
  };
  // Tour à blanc, non compté : écritures de première fois (numéro de tablette recopié…).
  await battre();
  await s.tache('alertesTablettes');
  await s.tache('alerteMatin');
  await s.calme(600_000);
  s.erreurs.length = 0;
  s.compteur.activer();
  for (const [rang, h] of HEURES.entries()) {
    const debutHeure = JOUR_PIRE + h * HEURE;
    s.avancer((debutHeure + 30e3 - Date.now()) / s.JOUR);
    // Tâches de l'heure (même choix que tachesHoraires), lancées ensemble.
    const noms = taches.aLancer(debutHeure);
    await Promise.all(noms.map((nom) => chrono(nom, () => s.tache(nom).catch((e) => s.erreurs.push(`tâche ${nom} : ${e.message}`)))));
    await s.calme(600_000);
    if (rang < TOURS_ALERTES) {
      await battre();
      await s.calme(600_000);
      await chrono('alertesTablettes', () => s.tache('alertesTablettes'));
      await s.calme(600_000);
    }
    // La vie des familles entre 9 h et 20 h : 3 envois et 1 appel de la tablette par famille et par jour.
    if (h >= 9 && h <= 20) {
      for (const [i, f] of familles.entries()) {
        const auteur = { uid: f.proches[0], prenom: 'Julie' };
        if ((i + h) % 4 === 0) { // chaque famille, 3 heures sur 12
          await s.db.collection(`families/${f.fid}/posts`).add({
            type: h % 2 ? 'photo' : 'message', authorUid: auteur.uid, authorName: 'Julie', createdAt: s.FieldValue.serverTimestamp(),
            text: 'Bisous', seenAt: null, hearts: 0, ...(h % 2 ? { storagePath: `families/${f.fid}/media/j${h}.jpg`, hasMedia: true } : {}),
          });
        }
        if (h === 9 + (i % 4)) {
          const appel = s.db.collection(`families/${f.fid}/calls`).doc();
          await appel.set({ callerUid: f.appels, callerName: 'Mamie', calleeUid: f.proches[0], calleeName: 'Julie', state: 'ringing', createdAt: s.FieldValue.serverTimestamp() });
          await new Promise((r) => setTimeout(r, 20));
          await appel.update({ state: 'missed' });
        }
      }
      await s.calme(600_000);
    }
  }
  s.compteur.arreter();
  const bilan = s.compteur.bilan();
  const courrielsJour = s.boite.slice(boiteJour);
  const notifications = s.notifications.length - notifsJour;

  // ---------- 4. Rapport ----------
  const nf = (x) => Math.round(x).toLocaleString('fr-FR');
  const parTache = (nom) => (durees[nom] || []).reduce((x, y) => x + y, 0) / Math.max(1, (durees[nom] || []).length);
  const lignes = Object.entries(bilan).sort((x, y) => y[1].lectures - x[1].lectures).map(([nom, c]) => {
    const parJour = nom === 'alertesTablettes' ? 288 / Math.min(TOURS_ALERTES, HEURES.length) : 1;
    return `| ${nom} | ${c.appels} | ${(c.lectures / c.appels).toFixed(1)} | ${(c.ecritures / c.appels).toFixed(1)} | ${nf(c.lectures * parJour)} | ${nf((c.ecritures + c.suppressions) * parJour)} | ${durees[nom] ? `${nf(parTache(nom))} ms (max ${nf(Math.max(...durees[nom]))})` : ''} |`;
  });
  const total = Object.entries(bilan).reduce((acc, [nom, c]) => {
    const parJour = nom === 'alertesTablettes' ? 288 / Math.min(TOURS_ALERTES, HEURES.length) : 1;
    acc.lectures += c.lectures * parJour;
    acc.ecritures += (c.ecritures + c.suppressions) * parJour;
    acc.appels += c.appels * parJour;
    return acc;
  }, { lectures: 0, ecritures: 0, appels: 0 });
  const sujets = new Map();
  courrielsJour.forEach((m) => sujets.set(m.sujet.replace(/[0-9]+/g, '#').slice(0, 60), (sujets.get(m.sujet.replace(/[0-9]+/g, '#').slice(0, 60)) || 0) + 1));
  const sortie = [
    `## Charge : ${N} familles, lundi 1er février 2027 (pire jour : toutes les tâches), émulateur`, '',
    `Copie des ${N - 1} familles : ${nf(dureeCopie / 1000)} s ; scénario complet : ${nf((performance.now() - debutTotal) / 1000)} s.`,
    `alertesTablettes : ${Math.min(TOURS_ALERTES, HEURES.length)} tours joués sur 288, colonnes « par jour » extrapolées (× ${288 / Math.min(TOURS_ALERTES, HEURES.length)}).${HEURES.length < 24 ? ` Heures jouées : ${HEURES.join(', ')} h (les autres tâches et la vie des familles ne sont pas toutes jouées : colonnes « par jour » partielles).` : ''}`, '',
    '| Fonction | Appels joués | Lectures/appel | Écritures/appel | Lectures/jour | Écritures/jour | Durée (émulateur) |',
    '|---|---|---|---|---|---|---|', ...lignes, '',
    `**Serveur, par jour : ${nf(total.appels)} appels de fonctions, ${nf(total.lectures)} lectures, ${nf(total.ecritures)} écritures/suppressions.**`,
    `Mois (×30) : ${nf(total.lectures * 30)} lectures, ${nf(total.ecritures * 30)} écritures → ${(((total.lectures * 0.06) + (total.ecritures * 0.18)) * 30 / 100_000).toFixed(2)} $ (eur3, base « europe » sans quota gratuit).`, '',
    `E-mails partis ce jour-là : ${courrielsJour.length} (Brevo gratuit : 300/jour). E-mails d'arrivée d'une famille (parcours complet) : ${courrielsArrivee.length} (${[...new Set(courrielsArrivee)].join(' ; ')}).`,
    ...[...sujets].map(([sj, k]) => `- ${k} × ${sj}`),
    `Notifications push : ${notifications}.`,
  ];
  console.log(`\n${sortie.join('\n')}\n`);
  assert.deepStrictEqual(s.erreurs, [], 'aucune erreur serveur');
});
