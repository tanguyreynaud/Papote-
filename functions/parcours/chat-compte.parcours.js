// Chat de support connecté au compte (chantier 2, Tanguy 18/11) : dans l'appli, la bulle envoie le jeton de
// connexion et la famille ouverte ; le chat reçoit la fiche de SA famille, en lecture seule. Sur le site, une
// commande se suit avec son code ET l'e-mail de la commande. Joué en vraie vie : commande payée, colis, tablette
// installée qui donne ses nouvelles comme Sync.java, vrais jetons de l'émulateur Auth, vraie fonction supportChat.
// Seule l'IA est simulée : on lit ce qu'elle aurait reçu.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// Fausse IA : garde chaque requête (consignes, fiche, conversation) et répond une phrase fixe.
const requetesIA = [];
const sdk = require.resolve('@anthropic-ai/sdk', { paths: [path.join(__dirname, '..')] });
require.cache[sdk] = {
  id: sdk, filename: sdk, loaded: true,
  exports: class FausseIA {
    constructor() { this.messages = { create: async (corps) => { requetesIA.push(corps); return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Réponse simulée.' }] }; } }; }
  },
};

const s = require('./simulation');
const a = require('./acteurs');
const { brancher } = require('./commun');

brancher();
test.beforeEach(() => { requetesIA.length = 0; });

// Vrai jeton de connexion de l'émulateur Auth, comme auth.currentUser.getIdToken() dans l'appli.
async function jeton(uid) {
  const admin = require('firebase-admin');
  const ct = await admin.auth().createCustomToken(uid);
  const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=simulation`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: ct, returnSecureToken: true }),
  });
  const { idToken } = await r.json();
  assert.ok(idToken, 'jeton de l\'émulateur');
  return idToken;
}

let ipSuivante = 1;
// La bulle de l'appli (vitrine/chat-support.js, poser) : { messages, page, famille } et Authorization: Bearer.
async function demander(question, { idToken, famille, page = 'appli', messages } = {}) {
  const avant = requetesIA.length;
  const r = await s.requete('supportChat', {
    depuis: `198.18.0.${ipSuivante++ % 250 + 1}`,
    entetes: idToken ? { authorization: `Bearer ${idToken}` } : {},
    corps: { messages: messages || [{ role: 'user', content: question }], page, ...(famille ? { famille } : {}) },
  });
  assert.strictEqual(r.statut, 200, r.texte);
  assert.strictEqual(r.json.reponse, 'Réponse simulée.', 'la personne a sa réponse');
  assert.strictEqual(requetesIA.length, avant + 1, 'une seule question posée à l\'IA');
  const systeme = requetesIA[requetesIA.length - 1].system.map((b) => b.text);
  return { systeme, fiche: systeme.find((t) => /^# Fiche du compte/.test(t)) || null, suivi: systeme.find((t) => /^# Suivi de commande/.test(t)) || null };
}

// La tablette donne ses nouvelles (android/Sync.java : heartbeat, reportBattery, reportSim, version).
async function nouvellesDeLaTablette(t, { batterie = 34, branchee = false, sim = true } = {}) {
  const maintenant = s.Timestamp.now();
  await s.db.doc(`families/${t.fid}/members/${t.tabletUid}`).update({
    lastOnline: maintenant, lastSeen: s.Timestamp.fromMillis(Date.now() - 20 * 60e3), lastActive: s.Timestamp.fromMillis(Date.now() - 3 * 3600e3),
    battery: { level: batterie, charging: branchee, unpluggedAt: branchee ? null : s.Timestamp.fromMillis(Date.now() - 2 * 3600e3), at: maintenant },
    wifi: sim ? null : { ssid: 'Livebox-MAMIE' },
    sim: { iccid: '8933150319000000001', operateur: 'Bouygues Telecom', reseau: '4G', signal: 3, dataMoisMo: 812, vuLe: maintenant },
    appVersion: '2.99.130',
  });
}

// Ce qui ne doit JAMAIS partir vers l'IA : coordonnées, adresse, nom de l'acheteur, numéro de la carte SIM.
function rienDePersonnel(texte, ...interdits) {
  for (const x of ['paul.acheteur@exemple.fr', 'julie.proche@exemple.fr', 'Paul Martin', 'Tabac de la Place', 'place de la Mairie', '8933150319000000001', 'Livebox-MAMIE', ...interdits]) {
    assert.ok(!texte.includes(x), `« ${x} » ne doit pas partir vers l'IA`);
  }
}

async function familleInstallee() {
  const paul = await s.compte('Paul', 'paul.acheteur@exemple.fr');
  const julie = await s.compte('Julie', 'julie.proche@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement } = await a.commanderEtPayer({ email: paul.email });
  await a.preparerEtEnvoyer(abonnement, t, 'MR778899');
  await a.afficherCode(t);
  const fid = await a.installer(paul, t, { nom: 'Mamie Emma' });
  await a.rejoindre(julie, fid);
  await s.calme();
  return { paul, julie, t, fid, abonnement };
}

test('appli : le responsable demande, le chat voit SA tablette, son abonnement et son colis, puis voit le changement', async () => {
  const { paul, t, fid } = await familleInstallee();
  await nouvellesDeLaTablette(t);
  const idToken = await jeton(paul.uid);

  const { fiche, systeme } = await demander('La tablette de maman ne répond plus, que faire ?', { idToken, famille: fid });
  assert.ok(fiche, 'fiche du compte reçue');
  assert.match(fiche, /propriétaire du compte/);
  assert.match(fiche, /« Mamie Emma »/);
  assert.match(fiche, /Tablette : en ligne \(dernier signe de vie à l’instant\)/);
  assert.match(fiche, /sur la carte SIM \(4G, signal 3 sur 4\)/);
  assert.match(fiche, /batterie 34 %, débranchée depuis 2 h/);
  assert.match(fiche, /quelqu’un vu devant l’écran il y a 20 min/);
  assert.match(fiche, /écran touché il y a 3 h/);
  assert.match(fiche, /version 2\.99\.130/);
  assert.match(fiche, /Abonnement : actif, (premier|prochain) prélèvement le \p{L}+ \d+ \p{L}+/u);
  assert.match(fiche, /tablette reçue \(colis retiré\) le/);
  assert.match(fiche, /2 proches dans l’appli/);
  assert.match(fiche, /Tu ne peux toujours rien modifier/);
  rienDePersonnel(systeme.join('\n'));
  // La fiche vient APRÈS le bloc mis en cache (guide + site) : elle ne casse pas le cache.
  const iCache = requetesIA[0].system.findIndex((b) => b.cache_control);
  assert.ok(requetesIA[0].system.findIndex((b) => /^# Fiche du compte/.test(b.text)) > iCache);

  // Vraie vie : la tablette ne donne plus de nouvelles depuis 3 h (son dernier signe de vie recule ; avancer l'horloge
  // simulée périmerait le jeton de l'émulateur, que la vraie appli renouvelle d'elle-même).
  await s.db.doc(`families/${fid}/members/${t.tabletUid}`).update({ lastOnline: s.Timestamp.fromMillis(Date.now() - 3 * 3600e3) });
  const ensuite = await demander('Et maintenant ?', { idToken: await jeton(paul.uid), famille: fid });
  assert.match(ensuite.fiche, /Tablette : hors ligne depuis 3 h/, 'relue à chaque question, jamais une vieille fiche');

  // Impayé : la date de mise en pause n'est donnée qu'au responsable.
  await s.db.doc(`families/${fid}`).update({ 'abonnement.statut': 'impaye', 'abonnement.graceJusqua': s.Timestamp.fromMillis(Date.now() + 9 * s.JOUR) });
  const impaye = await demander('Pourquoi Papote dit que le paiement a échoué ?', { idToken: await jeton(paul.uid), famille: fid });
  assert.match(impaye.fiche, /Abonnement : paiement en retard, la tablette se mettra en pause le \p{L}+ \d+ \p{L}+ si rien n’est réglé/u);
});

test('appli : un proche non responsable voit l\'état de la tablette, sans les détails du paiement', async () => {
  const { julie, t, fid } = await familleInstallee();
  await nouvellesDeLaTablette(t, { branchee: true, sim: false });
  await s.db.doc(`families/${fid}`).update({ 'abonnement.statut': 'impaye', 'abonnement.graceJusqua': s.Timestamp.fromMillis(Date.now() + 9 * s.JOUR) });
  const { fiche, systeme } = await demander('La tablette est en pause ?', { idToken: await jeton(julie.uid), famille: fid });
  assert.match(fiche, /proche \(membre de la famille, pas responsable\)/);
  assert.match(fiche, /sur le Wi-Fi/);
  assert.match(fiche, /batterie 34 %, branchée/);
  assert.match(fiche, /Abonnement : paiement en retard\./);
  assert.doesNotMatch(fiche, /se mettra en pause le|prélèvement le/, 'pas de date de paiement pour un simple proche');
  assert.match(fiche, /visibles que d’un responsable/);
  rienDePersonnel(systeme.join('\n'));
});

test('appli : pas de fiche pour une autre famille, la tablette, un membre en attente, un faux jeton ou sans jeton', async () => {
  const { paul, t, fid } = await familleInstallee();
  await nouvellesDeLaTablette(t);
  // Une autre famille, avec son propre compte.
  const marc = await s.compte('Marc', 'marc.autre@exemple.fr');
  const t2 = await a.tablettePreparee();
  const { abonnement: id2 } = await a.commanderEtPayer({ email: marc.email, nom: 'Marc Durand' });
  await a.preparerEtEnvoyer(id2, t2, 'MR111222');
  await a.afficherCode(t2);
  const fid2 = await a.installer(marc, t2, { nom: 'Papi Louis' });

  // Marc connecté, qui envoie la famille de Paul : rien.
  const intrus = await demander('Où en est ma tablette ?', { idToken: await jeton(marc.uid), famille: fid });
  assert.strictEqual(intrus.fiche, null, 'jamais la fiche d\'une autre famille');
  rienDePersonnel(intrus.systeme.join('\n'), 'MR778899');
  // Sa propre famille : sa fiche à lui, sans rien de celle de Paul.
  const sienne = await demander('Où en est ma tablette ?', { idToken: await jeton(marc.uid), famille: fid2 });
  assert.match(sienne.fiche, /« Papi Louis »/);
  assert.doesNotMatch(sienne.fiche, /Mamie Emma|MR778899/);

  // Le compte de la tablette elle-même : rien (la tablette n'a pas de bulle).
  await require('firebase-admin').auth().createUser({ uid: t.tabletUid });
  assert.strictEqual((await demander('test', { idToken: await jeton(t.tabletUid), famille: fid })).fiche, null);

  // Une demande pour rejoindre pas encore acceptée : rien.
  const zoe = await s.compte('Zoe', 'zoe.attente@exemple.fr');
  await a.rejoindre(zoe, fid, { attente: true });
  assert.strictEqual((await demander('test', { idToken: await jeton(zoe.uid), famille: fid })).fiche, null);

  // Faux jeton, jeton d'un compte supprimé, pas de jeton, jeton sans famille : le chat répond quand même, sans fiche.
  assert.strictEqual((await demander('test', { idToken: 'eyJhbGciOiJIUzI1NiJ9.faux.faux-faux-faux', famille: fid })).fiche, null);
  const vieux = await jeton(paul.uid);
  assert.ok((await demander('test', { idToken: vieux, famille: fid })).fiche, 'le jeton de Paul marche');
  assert.strictEqual((await demander('test', { famille: fid })).fiche, null);
  assert.strictEqual((await demander('test', { idToken: vieux })).fiche, null);
  // Paul quitte la famille : son jeton, encore valide, n'ouvre plus rien.
  await s.db.doc(`families/${fid}/members/${paul.uid}`).delete();
  assert.strictEqual((await demander('test', { idToken: vieux, famille: fid })).fiche, null);
  assert.deepStrictEqual(s.erreurs, []);
});

test('site : suivi de commande avec le code ET l\'e-mail, jamais avec un seul des deux', async () => {
  const paul = await s.compte('Paul', 'paul.acheteur@exemple.fr');
  const t = await a.tablettePreparee();
  const { abonnement } = await a.commanderEtPayer({ email: paul.email });
  const code = (await s.lire(`commandes/${abonnement}`)).code;
  const affiche = `${code.slice(0, 4)}-${code.slice(4)}`;

  // Payée, pas encore envoyée.
  let r = await demander(`Où en est ma commande ${affiche} ? Mon e-mail : Paul.Acheteur@exemple.fr`, { page: 'site' });
  assert.match(r.suivi, /payée, tablette en préparation, pas encore envoyée/);
  assert.strictEqual(r.fiche, null);
  rienDePersonnel(r.systeme.join('\n').replace(/Paul\.Acheteur@exemple\.fr/g, ''));

  // Le colis part ; la personne donne le code dans un message et l'e-mail dans le suivant.
  await a.preparerEtEnvoyer(abonnement, t, 'MR445566');
  r = await demander('', {
    page: 'site',
    messages: [
      { role: 'user', content: `Bonjour, ma commande ${code.toLowerCase().slice(0, 4)}-${code.toLowerCase().slice(4)} n'est pas arrivée` },
      { role: 'assistant', content: 'Pouvez-vous me donner l’adresse e-mail de la commande ?' },
      { role: 'user', content: 'paul.acheteur@exemple.fr' },
    ],
  });
  assert.match(r.suivi, /colis envoyé le .*numeroExpedition=MR445566/);

  // Mauvais e-mail : aucune commande, sans dire lequel des deux ne va pas.
  r = await demander(`Commande ${affiche}, e-mail pirate@exemple.fr`, { page: 'site' });
  assert.match(r.suivi, /aucune commande ne correspond aux deux ensemble/);
  assert.doesNotMatch(r.suivi, /préparation|envoyé|MR445566/);
  // Le code seul, ou l'e-mail seul : aucune recherche.
  // Le code seul : aucune recherche, le chat demande les deux ensemble.
  const seul = await demander(`Ma commande ${affiche} ?`, { page: 'site' });
  assert.match(seul.suivi, /demande-lui en une phrase le code de commande .* ET l’adresse e-mail/);
  assert.doesNotMatch(seul.suivi, /préparation|envoyé|MR445566/);
  // Dans l'appli, pas cette consigne (la fiche du compte suffit).
  assert.strictEqual((await demander('Où est ma commande ?', { page: 'appli' })).suivi, null);
  assert.doesNotMatch((await demander('Ma commande, e-mail paul.acheteur@exemple.fr ?', { page: 'site' })).suivi, /Commande :/);
  // Deux mots ordinaires ne passent pas pour un code.
  assert.doesNotMatch((await demander('Je viens avec deux questions, paul.acheteur@exemple.fr', { page: 'site' })).suivi, /Commande :/);

  // Deviner des codes depuis une même adresse : 20 recherches, puis plus rien (le chat répond toujours).
  const { QUOTAS } = require('../support')._test;
  const depuis = '198.19.0.7';
  let trouves = 0;
  for (let i = 0; i < QUOTAS.suivis + 3; i++) {
    const avant = requetesIA.length;
    const rep = await s.requete('supportChat', { depuis, corps: { page: 'site', messages: [{ role: 'user', content: `Commande ${affiche} e-mail paul.acheteur@exemple.fr` }] } });
    if (rep.json && rep.json.contact) break; // quota de questions atteint
    if (requetesIA[avant].system.some((b) => /^# Suivi de commande \(lu/.test(b.text))) trouves += 1;
  }
  assert.strictEqual(trouves, QUOTAS.suivis, 'recherches plafonnées par adresse');
});
