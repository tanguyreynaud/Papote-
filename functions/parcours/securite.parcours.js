// Accès aux fonctions de l'appli famille : seuls les responsables encore membres touchent à l'abonnement,
// et les e-mails ou relevés qu'un compte peut déclencher sont plafonnés.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, mailsA } = require('./commun');

brancher();

async function familleInstallee(proche) {
  const t = await a.tablettePreparee();
  await a.afficherCode(t);
  return a.installer(proche, t);
}

test('un responsable parti de la famille ne touche plus à son abonnement', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const fid = await familleInstallee(julie);
  await a.rejoindre(paul, fid);
  await s.db.doc(`families/${fid}`).update({ admins: [paul.uid] });

  // Paul quitte la famille lui-même : il reste dans admins, mais n'est plus membre.
  await s.db.doc(`families/${fid}/members/${paul.uid}`).delete();
  await s.calme();
  for (const nom of ['creerPaiement', 'portailClient', 'resilierAbonnement', 'retracter', 'finDeContrat', 'rattacherCommande']) {
    await assert.rejects(s.appeler(nom, { fid, formule: 'wifi', tablette: 'incluse' }, paul), /responsables/, nom);
  }
  await assert.rejects(s.appeler('inviterParEmail', { fid, email: 'x@exemple.fr' }, paul), /membres/);

  // Julie, toujours membre, peut prendre l'abonnement.
  const { url } = await s.appeler('creerPaiement', { fid, formule: 'wifi', tablette: 'incluse' }, julie);
  assert.ok(url);
});

test('un compte n\'envoie pas plus de 20 invitations par jour, même avec plusieurs familles', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const fid1 = await familleInstallee(julie);
  const fid2 = await familleInstallee(julie);
  for (let i = 0; i < 20; i++) {
    await s.appeler('inviterParEmail', { fid: i % 2 ? fid2 : fid1, email: `proche${i}@exemple.fr` }, julie);
  }
  await assert.rejects(s.appeler('inviterParEmail', { fid: fid2, email: 'proche20@exemple.fr' }, julie), /Trop d'invitations/);
  assert.strictEqual(mailsA('proche20@exemple.fr').length, 0);
  s.avancer(1);
  await s.appeler('inviterParEmail', { fid: fid2, email: 'proche20@exemple.fr' }, julie);
});

test('relevé des appels ratés : 50 par compte et par jour, au-delà dans les journaux seulement', async () => {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  for (let i = 0; i < 55; i++) await s.appeler('incidentAppel', { raison: 'test', detail: String(i) }, julie);
  const releves = await s.db.collection('incidentsAppels').where('uid', '==', julie.uid).get();
  assert.strictEqual(releves.size, 50);
});

// Inspection 5 (3/11) : quelqu'un qui ouvre des pages de paiement sans jamais payer bloquerait tout le stock
// 32 minutes à chaque fois (une tablette mise de côté par page). Au-delà de 5 pages en une heure depuis la même
// adresse internet, ou de 2 pour le même e-mail, la commande renvoie à la page de commande avec « ?trop=1 ».
test('pages de paiement ouvertes à la chaîne : 5 par adresse et 2 par e-mail en une heure, le stock n\'est pas bloqué', async () => {
  // Assez de tablettes pour que chaque page en mette une de côté (sans stock, une commande d'essai passerait sans réserver).
  for (let i = 0; i < 12; i++) await a.tablettePreparee();
  const stock = require('../stock');
  const essai = (depuis, email, autre = {}) => s.requete('commander', {
    query: { formule: 'sim', tablette: 'incluse', ...a.RELAIS, ...(email ? { email } : {}), essai: '', ...autre }, depuis,
  });
  const deA = '203.0.113.7';
  for (let i = 0; i < stock.ESSAIS_HEURE_IP; i++) {
    const r = await essai(deA);
    assert.strictEqual(r.statut, 303);
    assert.match(r.redirection, /checkout\.stripe\.test/, `page ${i + 1} ouverte`);
  }
  const refus = await essai(deA);
  assert.strictEqual(refus.statut, 303);
  assert.match(refus.redirection, /commande\.html\?trop=1$/, 'la 6e page est refusée');
  // Une autre adresse passe encore ; le même e-mail, deux fois seulement.
  const deB = '198.51.100.9';
  // Le même e-mail qui refait la même demande retrouve la même page (testé à part, ci-dessous) : ce n'est pas un
  // essai de plus. Deux pages restées ouvertes pour un e-mail (anciennes réservations sans page notée) : la 3e est refusée.
  assert.match((await essai(deB, 'curieux@exemple.fr')).redirection, /checkout\.stripe\.test/);
  for (let i = 0; i < 2; i++) {
    await s.db.collection('reservations').add({ email: 'curieux@exemple.fr', bloque: false, creeLe: new Date(Date.now()), expireLe: new Date(Date.now() - 1) });
  }
  assert.match((await essai(deB, 'Curieux@exemple.fr', { rdest: 'Autre Nom' })).redirection, /commande\.html\?trop=1$/, 'le 3e essai du même e-mail est refusé');
  assert.match((await essai(deB, 'autre@exemple.fr')).redirection, /checkout\.stripe\.test/, 'un autre e-mail passe');
  // Une heure plus tard, l'adresse peut recommencer.
  s.avancer(1 / 24 + 0.01);
  assert.match((await essai(deA)).redirection, /checkout\.stripe\.test/, 'une heure après, à nouveau possible');
  // Les réservations finies depuis plus d'un jour sont effacées par le ménage quotidien.
  s.avancer(2);
  const avant = (await s.db.collection('reservations').get()).size;
  assert.ok(avant >= 3, `réservations gardées : ${avant}`);
  await stock.nettoyerReservations(s.db);
  assert.strictEqual((await s.db.collection('reservations').get()).size, 0, 'toutes effacées après un jour');
});

// Audit de la commande (11/11, Tanguy : « oui la 1 ») : une seule page de paiement ouverte par e-mail. Le client
// qui revient de Stripe et retouche « Payer » retrouve la même page ; s'il a changé de relais, l'ancienne page est
// fermée et sa tablette rendue. Avant : chaque « Payer » mettait une tablette de plus de côté, le client se
// voyait « complet » à cause de sa propre réservation, et le 3e « Payer » de l'heure le bloquait une heure.
test('même e-mail : « Payer » retouché rouvre la même page Stripe ; relais changé, l\'ancienne page est fermée ; jamais deux tablettes de côté', async () => {
  await a.tablettePreparee(); // une seule tablette à vendre
  const payer = (autre = {}) => s.requete('commander', {
    query: { formule: 'sim', tablette: 'incluse', ...a.RELAIS, email: 'Marie@exemple.fr', accord: '0', ...autre }, depuis: '192.0.2.44',
  });
  const reservees = async () => (await s.db.collection('reservations').get()).docs.filter((d) => d.get('bloque') !== false && d.get('expireLe').toMillis() > Date.now()).length;
  const premiere = (await payer()).redirection;
  assert.match(premiere, /checkout\.stripe\.test\/cs_/);
  assert.strictEqual((await s.requete('stockDisponible')).json.disponible, false, 'la seule tablette est de côté');
  // Quatre allers-retours de plus (bien au-delà de l'ancienne limite de 2) : toujours la même page, la même tablette.
  for (let i = 0; i < 4; i++) assert.strictEqual((await payer()).redirection, premiere, `retour n° ${i + 1} : même page`);
  assert.strictEqual(await reservees(), 1);
  assert.strictEqual(s.stripe.etat.sessions.size, 1, 'une seule page de paiement créée chez Stripe');
  // Autre point relais : nouvelle page avec le nouveau relais, l'ancienne ne peut plus être payée.
  const deuxieme = (await payer({ relais: 'FR-067890', rnom: 'Pressing du Centre' })).redirection;
  assert.match(deuxieme, /checkout\.stripe\.test\/cs_/, `la tablette rendue est reprise par le même client : ${deuxieme}`);
  assert.notStrictEqual(deuxieme, premiere);
  await s.calme();
  assert.strictEqual(s.stripe.etat.sessions.get(premiere.split('/').pop()).status, 'expired', 'ancienne page fermée chez Stripe');
  const nouvelle = s.stripe.etat.sessions.get(deuxieme.split('/').pop());
  assert.strictEqual(nouvelle.metadata.relais_nom, 'Pressing du Centre');
  assert.ok(nouvelle.metadata.reservation, 'la nouvelle page tient la tablette');
  assert.strictEqual(await reservees(), 1, 'toujours une seule tablette de côté');
  // Encore deux changements : pas de « trop d'essais » pour un client qui hésite.
  assert.match((await payer({ rdest: 'Marie Durand' })).redirection, /checkout\.stripe\.test\/cs_/);
  const derniere = (await payer({ rdest: 'Marie Dupont' })).redirection;
  assert.match(derniere, /checkout\.stripe\.test\/cs_/);
  await s.calme();
  assert.strictEqual(await reservees(), 1);
  // Un autre client ne peut pas prendre la tablette pendant ce temps.
  const autre = await s.requete('commander', { query: { formule: 'sim', tablette: 'incluse', ...a.RELAIS, email: 'paul@exemple.fr' }, depuis: '192.0.2.45' });
  assert.strictEqual(s.stripe.etat.sessions.get(autre.redirection.split('/').pop()).metadata.reservation, undefined, 'clé de test : essai accepté, sans tablette');
  // La page n'est plus rouverte quand il lui reste moins d'une minute : une nouvelle est créée.
  s.avancer(29.5 / (24 * 60));
  const apres = (await payer({ rdest: 'Marie Dupont' })).redirection;
  assert.notStrictEqual(apres, derniere, 'page presque expirée : pas rouverte');
  assert.match(apres, /checkout\.stripe\.test\/cs_/);
});

test('refus de commander : chaque renvoi vers la page de commande dit son motif', async () => {
  await a.tablettePreparee();
  const { relais, ...sansRelais } = a.RELAIS;
  const r1 = await s.requete('commander', { query: { formule: 'sim', tablette: 'incluse', ...sansRelais } });
  assert.match(r1.redirection, /commande\.html\?formule=sim&tablette=incluse&refus=relais$/);
  const r2 = await s.requete('commander', { query: { formule: 'sim', tablette: 'incluse', ...a.RELAIS, plat: '48.0501', plon: '5.694' } });
  assert.match(r2.redirection, /commande\.html\?refus=4g$/);
  // Stripe en panne à l'ouverture du paiement : retour sur la page de commande, la tablette est rendue.
  const creer = s.stripe.api.checkout.sessions.create;
  s.stripe.api.checkout.sessions.create = async () => { throw new Error('Stripe indisponible'); };
  try {
    const r3 = await s.requete('commander', { query: { formule: 'sim', tablette: 'incluse', ...a.RELAIS, email: 'panne@exemple.fr' } });
    assert.strictEqual(r3.statut, 303);
    assert.match(r3.redirection, /commande\.html\?erreur=1$/);
  } finally { s.stripe.api.checkout.sessions.create = creer; }
  // La panne est bien écrite dans le journal (erreur attendue de ce scénario).
  assert.ok(s.erreurs.some((e) => /commander/.test(e)), 'panne notée dans le journal');
  s.erreurs.length = 0;
  assert.strictEqual((await s.requete('stockDisponible')).json.disponible, true, 'tablette rendue après la panne');
});

// Audit 8 (N1, 11/11) : le visiteur écrit ce qu'il veut au début de X-Forwarded-For ; seule l'adresse ajoutée par
// Google compte. Et jamais plus de 3 tablettes mises de côté en même temps : au-delà, la page de paiement s'ouvre
// quand même mais ne bloque plus de stock.
test('en-tête X-Forwarded-For inventé : la limite par adresse tient ; 3 tablettes au plus mises de côté, le site reste « disponible »', async () => {
  for (let i = 0; i < 8; i++) await a.tablettePreparee();
  const stock = require('../stock');
  const ouvert = (r) => r.statut === 303 && /checkout\.stripe\.test/.test(r.redirection || '');
  const payer = (entetes, depuis) => s.requete('commander', { query: { formule: 'sim', tablette: 'incluse', ...a.RELAIS, accord: '1', essai: '' }, entetes, depuis });
  const res = [];
  for (let i = 0; i < 8; i++) res.push(ouvert(await payer({ 'x-forwarded-for': `10.0.${i}.7` })));
  assert.deepStrictEqual(res, [true, true, true, true, true, false, false, false], 'même vraie adresse : 5 puis refus');
  const bloquees = async () => (await s.db.collection('reservations').get()).docs.filter((d) => d.get('bloque') !== false).length;
  assert.strictEqual(await bloquees(), stock.RESERVATIONS_MAX);
  // D'autres vraies adresses : la page s'ouvre, sans rien mettre de côté de plus.
  for (const depuis of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) assert.ok(ouvert(await payer({}, depuis)));
  assert.strictEqual(await bloquees(), stock.RESERVATIONS_MAX);
  assert.strictEqual((await s.requete('stockDisponible')).json.disponible, true, 'le site vend toujours');
});

test('chat du site : rappels et inscriptions plafonnés par adresse et pour tout le monde chaque jour', async () => {
  const { QUOTAS, QUOTAS_JOUR } = require('../support')._test;
  const ip = (i) => `198.51.${Math.floor(i / 250)}.${(i % 250) + 1}`;
  const messages = [{ role: 'user', content: 'Bonjour, je voudrais être rappelé.' }];
  const rappel = (i, entetes = {}) => s.requete('supportChat', { depuis: ip(i), entetes, corps: { messages, contact: { nom: 'Test', telephone: '06 12 34 56 78', email: `t${i}@exemple.fr` } } });
  const inscription = (i) => s.requete('supportChat', { depuis: ip(i), corps: { inscription: { prenom: 'Léa', nom: `Test${i}`, telephone: '06 12 34 56 78', email: `l${i}@exemple.fr` } } });
  // Même adresse réelle, en-tête inventé à chaque essai : la limite par adresse tient.
  const memes = [];
  for (let k = 0; k < QUOTAS.rappels + 2; k++) memes.push((await rappel(0, { 'x-forwarded-for': `10.0.0.${k}` })).statut);
  assert.deepStrictEqual(memes, [...Array(QUOTAS.rappels).fill(200), 429, 429]);
  // Une adresse différente à chaque essai : le plafond du jour arrête les rappels (un e-mail chacun).
  const statuts = [];
  for (let i = 1; statuts.length < QUOTAS_JOUR.rappels - QUOTAS.rappels + 2; i++) statuts.push((await rappel(i)).statut);
  assert.deepStrictEqual(statuts.slice(-3), [200, 429, 429]);
  assert.strictEqual((await s.db.collection('supportDemandes').get()).size, QUOTAS_JOUR.rappels);
  const ins = [];
  for (let i = 0; i < QUOTAS_JOUR.inscriptions + 2; i++) ins.push((await inscription(1000 + i)).statut);
  assert.deepStrictEqual(ins.slice(-3), [200, 429, 429]);
  assert.strictEqual(ins.filter((x) => x === 200).length, QUOTAS_JOUR.inscriptions);
  // Le lendemain, tout repart.
  s.avancer(1);
  assert.strictEqual((await rappel(5000)).statut, 200);
  assert.strictEqual((await inscription(5001)).statut, 200);
});

test('facture de tablettes reçue par e-mail : tablettes « commandées », pas vendables avant leur arrivée', async () => {
  const { regles: g } = require('../gestion');
  assert.strictEqual((await s.requete('stockDisponible')).json.disponible, false);
  await g.rangerFacture({ facture: true, fournisseur: 'Tablettes Pro SARL', categorie: 'tablette', libelle: '10 tablettes', montant: 120000, tva: 20000,
    numero: 'F-FAUX-1', date: Date.now(), accessoires: [], confirmation: false, tablettes: { quantite: 10, modele: 'Blackview Tab 60 Pro', prixAchat: 12000, numeros: [] } },
  { filename: 'facture.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.4') }, 'e-mail de inconnu@exemple.com');
  const fiches = (await s.db.collection('stock').get()).docs;
  assert.deepStrictEqual([...new Set(fiches.map((d) => d.get('etat')))], ['commandee']);
  assert.strictEqual(fiches.length, 10);
  // (Page de paiement du site : fermée par ce même compte du stock ; ouverte ici seulement par la clé Stripe de test.)
  assert.strictEqual((await s.requete('stockDisponible')).json.disponible, false, 'rien à vendre tant que rien n\'est arrivé');
  // Tanguy ouvre le parcours de réception d'une tablette arrivée : elle passe « En stock » et se vend.
  await s.appeler('gestionParcours', { type: 'reception', id: fiches[0].id, reception: { etape: 1 } }, a.TANGUY);
  const apres = (await s.db.doc(`stock/${fiches[0].id}`).get()).data();
  assert.strictEqual(apres.etat, 'en-stock');
  assert.strictEqual((await s.requete('stockDisponible')).json.disponible, true);
});

test('boîte des factures inondée : 60 e-mails lus par jour au plus, la suite le lendemain', async () => {
  const { regles: g } = require('../gestion');
  Object.assign(process.env, { FACTURES_IMAP: 'imap.simulation:993:factures@mapapote.fr', FACTURES_ADRESSE: 'factures@mapapote.fr' });
  const mails = Array.from({ length: 100 }, (_, i) => ({ uid: i + 1, messageId: `<m${i}@exemple>` }));
  const telecharges = [];
  class FausseBoite {
    async connect() {}
    async list() { return []; }
    async getMailboxLock() { return { release() {} }; }
    async search() { return mails.map((m) => m.uid); }
    async fetchOne(uid) { return { envelope: { messageId: mails[uid - 1].messageId } }; }
    async download(uid) { telecharges.push(uid); return { content: `uid ${uid}` }; }
    async messageFlagsAdd() {}
    async logout() {}
    close() {}
  }
  const resoudre = (m) => require.resolve(m, { paths: [require('node:path').join(__dirname, '..')] });
  const avant = { imap: require.cache[resoudre('imapflow')], parseur: require.cache[resoudre('mailparser')] };
  require.cache[resoudre('imapflow')] = { exports: { ImapFlow: FausseBoite } };
  require.cache[resoudre('mailparser')] = { exports: { simpleParser: async (c) => ({ from: { text: 'inconnu@exemple.com' }, subject: String(c), attachments: [], text: '' }) } };
  try {
    for (let h = 0; h < 5; h++) await s.tache('gestionCourrier');
    assert.strictEqual(telecharges.length, 60, '3 relevés de 20, puis plus rien ce jour-là');
    const bilan = (await s.db.doc('gestion/courrier').get()).data();
    assert.ok(bilan.ignorees.some((x) => /Plus de 60 e-mails lus aujourd'hui/.test(x)));
    s.avancer(1);
    await s.tache('gestionCourrier');
    assert.strictEqual(telecharges.length, 80, 'le lendemain, la lecture reprend');
  } finally {
    for (const [k, m] of [['imap', 'imapflow'], ['parseur', 'mailparser']]) {
      if (avant[k]) require.cache[resoudre(m)] = avant[k]; else delete require.cache[resoudre(m)];
    }
  }
});
