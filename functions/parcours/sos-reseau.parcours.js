// SOS et perte de réseau, côté serveur (Tanguy, 03/11). Le SMS du SOS part de la tablette elle-même (carte SIM,
// android/SmsAlert.java) : ici, ce que fait le serveur. SOS décroché au 1er ou au 2e essai, « Refuser » sur l'app
// Android (deux fois, ou avec un faux jeton) ; tablette débranchée puis rebranchée, service de notifications en
// panne puis revenu, tâche des alertes lancée deux fois en même temps, abonnement fini.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher } = require('./commun');

brancher();

const alertes = () => s.notifications.filter((n) => n.type === 'alerte');
const alertesSos = () => alertes().filter((n) => /a appuyé sur SOS/.test(n.titre));
const journal = async () => (await s.appeler('gestionDonnees', {}, a.TANGUY)).alertes.map((x) => x.genre).sort();

// Famille offerte (jamais en pause) installée par Julie, Paul a rejoint, Marc attend l'accord : { fid, t, julie, paul, marc }.
async function famille() {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const marc = await s.compte('Marc', 'marc@exemple.fr');
  const t = await a.tablettePreparee();
  await a.afficherCode(t);
  const fid = await a.installer(julie, t);
  await s.appeler('gestionFamilleOfferte', { fid, offerte: true }, a.TANGUY);
  await a.rejoindre(paul, fid);
  await a.rejoindre(marc, fid, { attente: true });
  await s.calme();
  s.notifications.length = 0;
  s.boite.length = 0;
  return { fid, t, julie, paul, marc };
}

// ---------- SOS ----------

test('SOS décroché au 1er essai : tous les proches acceptés sonnent, les autres téléphones s\'arrêtent, aucune alerte', async () => {
  const { fid, t, julie, paul } = await famille();
  const cid = await a.appelerDepuisLaTablette(t, { sos: 1 });
  const sonne = s.notifications.find((n) => n.type === 'appel' && n.cid === cid);
  assert.deepStrictEqual(sonne.uids.sort(), [julie.uid, paul.uid].sort(), 'Marc, pas encore accepté, ne sonne pas');
  // Paul décroche (app famille), puis raccroche.
  await s.db.doc(`families/${fid}/calls/${cid}`).update({ answer: { type: 'answer', sdp: 'v=0' }, state: 'accepted' });
  await s.calme();
  assert.ok(s.notifications.some((n) => n.type === 'fin' && n.cid === cid), 'les autres téléphones arrêtent de sonner');
  await s.db.doc(`families/${fid}/calls/${cid}`).update({ state: 'ended', endedAt: s.FieldValue.serverTimestamp() });
  await s.calme();
  assert.deepStrictEqual(alertes(), [], 'aucune alerte');
  assert.ok(!s.notifications.some((n) => n.type === 'manque'), 'pas d\'« appel manqué » pour un SOS décroché');
  assert.deepStrictEqual(await journal(), ['sos']);
  assert.deepStrictEqual(s.boite, [], 'aucun e-mail : des téléphones ont sonné');
});

test('SOS sans réponse au 1er essai, décroché au 2e : pas d\'alerte « personne n\'a répondu »', async () => {
  const { fid, t } = await famille();
  const c1 = await a.appelerDepuisLaTablette(t, { sos: 1 });
  await s.db.doc(`families/${fid}/calls/${c1}`).update({ state: 'missed' });
  await s.calme();
  assert.deepStrictEqual(alertes(), [], '1er essai sans réponse : la tablette rappelle, rien à dire');
  const c2 = await a.appelerDepuisLaTablette(t, { sos: 2 });
  assert.ok(s.notifications.some((n) => n.type === 'appel' && n.cid === c2 && /^SOS/.test(n.nom)));
  await s.db.doc(`families/${fid}/calls/${c2}`).update({ answer: { type: 'answer', sdp: 'v=0' }, state: 'accepted' });
  await s.calme();
  await s.db.doc(`families/${fid}/calls/${c2}`).update({ state: 'ended' });
  await s.calme();
  assert.deepStrictEqual(alertesSos(), []);
  assert.deepStrictEqual(await journal(), ['sos'], 'un seul SOS compté, pas de « sans réponse »');
});

test('SOS refusé sur l\'app Android : un faux jeton est refusé, « Refuser » touché deux fois ne donne qu\'une alerte', async () => {
  const { fid, t, julie, paul } = await famille();
  const c1 = await a.appelerDepuisLaTablette(t, { sos: 1 });
  await s.db.doc(`families/${fid}/calls/${c1}`).update({ state: 'missed' });
  await s.calme();
  const c2 = await a.appelerDepuisLaTablette(t, { sos: 2 });
  const { jeton } = await s.lire(`families/${fid}/calls/${c2}/prive/refus`);
  assert.ok(jeton, 'jeton d\'appel envoyé avec la sonnerie');

  const faux = await s.requete('refuserAppel', { corps: { fid, cid: c2, jeton: 'pas-le-bon' } });
  assert.strictEqual(faux.statut, 403);
  assert.strictEqual((await s.lire(`families/${fid}/calls/${c2}`)).state, 'ringing', 'l\'appel sonne toujours');

  const deux = await Promise.all([
    s.requete('refuserAppel', { corps: { fid, cid: c2, jeton } }),
    s.requete('refuserAppel', { corps: { fid, cid: c2, jeton } }),
  ]);
  assert.deepStrictEqual(deux.map((r) => r.statut), [204, 204]);
  await s.calme();
  assert.strictEqual((await s.lire(`families/${fid}/calls/${c2}`)).state, 'declined');
  // Encore une fois, plus tard (notification restée à l'écran) : rien de neuf.
  assert.strictEqual((await s.requete('refuserAppel', { corps: { fid, cid: c2, jeton } })).statut, 204);
  await s.calme();
  assert.strictEqual(alertesSos().length, 1, 'une seule alerte « personne n\'a pu répondre »');
  assert.deepStrictEqual(alertesSos()[0].uids.sort(), [julie.uid, paul.uid].sort());
  assert.deepStrictEqual(await journal(), ['sos', 'sos-sans-reponse']);
});

// ---------- Perte de réseau et de courant ----------

test('tablette débranchée, rebranchée, débranchée de nouveau : une alerte par épisode, pas une toutes les 5 minutes', async () => {
  const { fid, t, julie } = await famille();
  const tablette = s.db.doc(`families/${fid}/members/${t.tabletUid}`);
  const MIN = 60e3;
  const debrancher = () => tablette.update({ lastOnline: new Date(Date.now()), battery: { charging: false, level: 80, unpluggedAt: new Date(Date.now() - 15 * MIN) } });
  await debrancher();
  await s.tache('alertesTablettes');
  assert.strictEqual(alertes().length, 1);
  assert.match(alertes()[0].titre, /est débranchée/);
  assert.deepStrictEqual(alertes()[0].uids, [julie.uid], 'aux responsables');
  s.avancer(5 * MIN / s.JOUR);
  await tablette.update({ lastOnline: new Date(Date.now()) });
  await s.tache('alertesTablettes');
  assert.strictEqual(alertes().length, 1, 'même épisode : pas de rappel');

  // Rebranchée : l'épisode se termine.
  await tablette.update({ lastOnline: new Date(Date.now()), battery: { charging: true, level: 81, unpluggedAt: null } });
  await s.tache('alertesTablettes');
  assert.strictEqual((await tablette.get()).get('alerteType'), null);
  assert.strictEqual(alertes().length, 1);
  // De nouveau débranchée le lendemain : nouvel épisode.
  s.avancer(1);
  await debrancher();
  await s.tache('alertesTablettes');
  assert.strictEqual(alertes().length, 2);
  assert.deepStrictEqual(await journal(), ['debranchee', 'debranchee']);
});

test('service de notifications en panne au moment d\'alerter : l\'alerte repart au tour suivant, une seule fois', async () => {
  const { fid, t } = await famille();
  const tablette = s.db.doc(`families/${fid}/members/${t.tabletUid}`);
  await tablette.update({ lastOnline: new Date(Date.now() - 3 * 3600e3) });
  s.reglages.pushEnPanne = 1;
  await s.tache('alertesTablettes');
  // Papote le voit dans les journaux (logger.error) : attendu ici.
  assert.ok(s.erreurs.length === 1 && /alerte non envoyée/.test(s.erreurs[0]), JSON.stringify(s.erreurs));
  s.erreurs.length = 0;
  assert.strictEqual((await tablette.get()).get('alerteType') || null, null, 'épisode pas noté comme prévenu');
  assert.deepStrictEqual(alertes(), []);

  await s.tache('alertesTablettes');
  assert.strictEqual(alertes().length, 1, 'le tour suivant prévient');
  assert.match(alertes()[0].titre, /ne répond plus/);
  await s.tache('alertesTablettes');
  assert.strictEqual(alertes().length, 1, 'puis plus rien pour cet épisode');
  assert.deepStrictEqual(await journal(), ['silence']);
});

test('tâche des alertes lancée deux fois en même temps (tour en retard) : une seule alerte « ne répond plus »', async () => {
  const { fid, t } = await famille();
  await s.db.doc(`families/${fid}/members/${t.tabletUid}`).update({ lastOnline: new Date(Date.now() - 3 * 3600e3) });
  await Promise.all([s.tache('alertesTablettes'), s.tache('alertesTablettes')]);
  await s.calme();
  assert.strictEqual(alertes().length, 1);
  assert.deepStrictEqual(await journal(), ['silence']);
});

test('abonnement fini : la tablette qui se tait (box coupée, rendue) ne déclenche plus d\'alerte', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(id, t);
  s.avancer(2);
  await a.afficherCode(t);
  const fid = await a.installer(paul, t);
  s.avancer(31);
  s.stripe.finirEssai(id);
  await s.calme();
  const { le } = await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  s.avancer((le - Date.now()) / s.JOUR + 0.1);
  s.stripe.arreterALaDate(id);
  await s.calme();
  assert.strictEqual((await s.lire(`families/${fid}`)).abonnement.statut, 'resilie');
  s.notifications.length = 0;
  await s.db.doc(`families/${fid}/members/${t.tabletUid}`).update({ lastOnline: new Date(Date.now() - 3 * 3600e3), lastSeen: new Date(Date.now() - 5 * s.JOUR) });
  await s.tache('alertesTablettes');
  await s.tache('alerteMatin');
  assert.deepStrictEqual(alertes(), [], 'ni « ne répond plus », ni « pas vue »');
});
