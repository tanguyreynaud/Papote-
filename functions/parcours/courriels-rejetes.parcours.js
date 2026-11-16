// E-mails perdus (audit des e-mails du 11/11, point 2 ; A3, Tanguy 12/11 : « très important ») : courriels-perdus.js.
// Brevo signale un rejet (webhook protégé par une clé) : noté sur la commande et en « À faire ». Un e-mail important
// qui ne part pas : un seul nouvel essai à la tâche horaire suivante, puis « À faire ». Rien pour les e-mails de confort.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, commande, mailsA } = require('./commun');

brancher();

const CLE = 'cle-brevo-simulation';
const HEURE = 1 / 24;
const brevo = (corps, { query = { cle: CLE }, entetes } = {}) => s.requete('brevoWebhook', { corps, query, entetes });
const perdus = async () => (await s.db.collection('courrielsPerdus').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const donnees = () => s.appeler('gestionDonnees', {}, a.TANGUY);
const recap = async () => {
  const avant = s.boite.length;
  await s.tache('gestionRecap');
  const m = s.boite.slice(avant).find((x) => x.a === 'contact@mapapote.fr');
  assert.ok(m, 'récap envoyé');
  return m.texte;
};
// Les erreurs attendues (logger.error de l'appelant ou du second essai) sont vérifiées puis retirées.
function erreursAttendues(motif) {
  assert.ok(s.erreurs.length > 0 && s.erreurs.every((e) => motif.test(e)), `erreurs inattendues : ${s.erreurs.join(' | ')}`);
  s.erreurs.length = 0;
}

test('webhook Brevo : refusé sans la clé, avec une fausse clé, et rien n\'est noté', async () => {
  const rejet = { event: 'hard_bounce', email: 'paul@exemple.fr', subject: 'Test', 'message-id': '<1@brevo>' };
  for (const r of [
    await brevo(rejet, { query: {} }),
    await brevo(rejet, { query: { cle: 'pas-la-bonne' } }),
    await brevo(rejet, { query: {}, entetes: { authorization: 'Bearer pas-la-bonne' } }),
  ]) assert.strictEqual(r.statut, 401);
  assert.deepStrictEqual(await perdus(), []);
  // La bonne clé, en GET : refusé aussi (Brevo envoie en POST).
  assert.strictEqual((await brevo(undefined)).statut, 405);
});

test('rejet définitif signalé par Brevo : noté sur la bonne commande, ligne « À faire », une seule fois', async () => {
  const autre = await a.commanderEtPayer({ email: 'lea@exemple.fr', nom: 'Léa Durand' });
  const { abonnement: id } = await a.commanderEtPayer({ email: 'paul.martin@exemple.fr', nom: 'Paul Martin' });
  const rejet = {
    event: 'hard_bounce', email: 'Paul.Martin@exemple.fr', subject: 'Merci pour votre commande Papote',
    'message-id': '<abc@smtp-relay.mailin.fr>', ts_event: 1762950000, reason: '550 5.1.1 user unknown',
  };
  const r = await brevo(rejet);
  assert.strictEqual(r.statut, 200, r.texte);
  await s.calme();
  const c = await commande(id);
  assert.match(c.mailErreur, /« Merci pour votre commande Papote » non reçu par paul\.martin@exemple\.fr \(adresse inexistante/);
  assert.ok(!(await commande(autre.abonnement)).mailErreur, 'l\'autre commande n\'est pas touchée');

  // Brevo renvoie le même événement : toujours une seule ligne.
  assert.strictEqual((await brevo(rejet)).statut, 200);
  const notes = await perdus();
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].commande, id);
  assert.strictEqual(notes[0].statut, 'a-faire');

  // L'admin reçoit la ligne et l'erreur de la commande ; le récap du lundi la donne aussi.
  const d = await donnees();
  assert.deepStrictEqual(d.courrielsAFaire.length, 1);
  assert.match(d.courrielsAFaire[0], /non reçu par paul\.martin@exemple\.fr \(commande de Paul Martin\).*Vérifier l'adresse/);
  assert.match(d.commandes.find((x) => x.id === id).mailErreur, /non reçu/);
  assert.match(await recap(), /E-mail « Merci pour votre commande Papote » non reçu par paul\.martin@exemple\.fr/);

  // « Réglé » dans l'admin : la ligne quitte « À faire ».
  await s.appeler('gestionCourrielTraite', { id: notes[0].id }, a.TANGUY);
  assert.deepStrictEqual((await donnees()).courrielsAFaire, []);
  await assert.rejects(s.appeler('gestionCourrielTraite', { id: notes[0].id }, { uid: 'x', email: 'x@exemple.fr' }), /administrateur/);
});

test('Brevo : envoi groupé, clé en en-tête, adresse sans commande ; adresse corrigée sur la commande', async () => {
  const { abonnement: id } = await a.commanderEtPayer({ email: 'jean@exemple.fr', nom: 'Jean Petit' });
  const r = await brevo([
    { event: 'delivered', email: 'jean@exemple.fr', subject: 'Arrivé' },
    { event: 'soft_bounce', email: 'jean@exemple.fr', subject: 'Votre tablette Papote est en route', 'message-id': '<2@b>', reason: 'mailbox full' },
    { event: 'blocked', email: 'proche@exemple.fr', subject: 'Rejoignez la famille', 'message-id': '<3@b>' },
    { event: 'spam', email: 'jean@exemple.fr', subject: 'Votre tablette Papote est en route', 'message-id': '<2@b>' },
  ], { query: {}, entetes: { authorization: `Bearer ${CLE}` } });
  assert.strictEqual(r.statut, 200, r.texte);
  assert.strictEqual(r.json.notes, 3, '« delivered » ignoré');
  await s.calme();
  const lignes = (await donnees()).courrielsAFaire;
  assert.strictEqual(lignes.length, 2, 'une ligne par adresse');
  assert.ok(lignes.some((l) => /proche@exemple\.fr : bloqué par Brevo/.test(l) && !/commande de/.test(l)));
  assert.ok(lignes.some((l) => /jean@exemple\.fr \(commande de Jean Petit\)/.test(l) && /et 1 autre/.test(l)));
  assert.match((await commande(id)).mailErreur, /non reçu par jean@exemple\.fr/);

  // Faute de frappe corrigée sur la commande : la ligne de l'ancienne adresse et mailErreur disparaissent.
  await s.db.doc(`commandes/${id}`).update({ email: 'jean.petit@exemple.fr' });
  await s.calme();
  assert.ok(!(await commande(id)).mailErreur);
  const restent = (await donnees()).courrielsAFaire;
  assert.strictEqual(restent.length, 1);
  assert.match(restent[0], /proche@exemple\.fr/);
});

test('« colis parti » non envoyé (Brevo en panne) : renvoyé une seule fois à la tâche horaire suivante', async () => {
  const paul = 'paul@exemple.fr';
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: paul });
  s.reglages.mailsEnPanne = 1;
  await a.preparerEtEnvoyer(id, t);
  erreursAttendues(/e-mail d'envoi non parti/);
  assert.ok(!mailsA(paul).includes('Votre tablette Papote est en route'));
  const [note] = await perdus();
  assert.strictEqual(note.statut, 'a-reessayer');
  assert.strictEqual(note.sujet, 'Votre tablette Papote est en route');
  assert.strictEqual(note.commande, id);
  assert.ok((await commande(id)).mailErreur, 'erreur visible sur la commande');

  // La même heure : pas encore (tâche horaire SUIVANTE).
  await s.tache('courrielsAReessayer');
  assert.ok(!mailsA(paul).includes('Votre tablette Papote est en route'));

  s.avancer(HEURE);
  await s.tache('courrielsAReessayer');
  await s.calme();
  assert.deepStrictEqual(mailsA(paul).filter((x) => x === 'Votre tablette Papote est en route').length, 1);
  assert.deepStrictEqual(await perdus(), [], 'rien ne reste à faire');
  assert.ok(!(await commande(id)).mailErreur, 'erreur effacée de la commande');

  // Les heures suivantes : plus rien.
  s.avancer(HEURE);
  await s.tache('courrielsAReessayer');
  assert.strictEqual(mailsA(paul).filter((x) => x === 'Votre tablette Papote est en route').length, 1);
});

test('mise en demeure non partie deux fois : un seul nouvel essai, puis ligne « À faire », plus jamais d\'essai', async () => {
  const { abonnement: id } = await a.commanderEtPayer({ email: 'marc@exemple.fr', nom: 'Marc Blanc' });
  // L'envoi lui-même passe par mail.envoyer comme tous les e-mails importants (ici : celui de la mise en demeure).
  const mail = require('../mail');
  s.reglages.mailsEnPanne = 1;
  await assert.rejects(mail.envoyer({ smtp: 'x:465:x', expediteur: 'contact@mapapote.fr', motDePasse: 'x', a: 'marc@exemple.fr',
    contenu: mail.miseEnDemeure({ nom: 'Marc Blanc', montant: 14000 }) }), /SMTP injoignable/);
  await s.calme();
  const [note] = await perdus();
  assert.strictEqual(note.statut, 'a-reessayer');
  assert.match((await commande(id)).mailErreur, /non parti .* nouvel essai à l'heure suivante/);

  s.avancer(HEURE);
  s.reglages.mailsEnPanne = 1;
  const avant = s.boite.length;
  await s.tache('courrielsAReessayer');
  await s.calme();
  erreursAttendues(/non parti au second essai/);
  const [apres] = await perdus();
  assert.strictEqual(apres.statut, 'a-faire');
  assert.strictEqual(apres.contenu, undefined, 'contenu effacé');
  assert.match((await commande(id)).mailErreur, /même au second essai/);
  const lignes = (await donnees()).courrielsAFaire;
  assert.strictEqual(lignes.length, 1);
  assert.match(lignes[0], /à marc@exemple\.fr \(commande de Marc Blanc\) non parti après un second essai/);

  // Pas d'essai en boucle.
  for (let i = 0; i < 3; i++) {
    s.avancer(HEURE);
    await s.tache('courrielsAReessayer');
  }
  assert.strictEqual(s.boite.length, avant);
  assert.strictEqual((await perdus()).length, 1);
});

test('e-mail de confort non parti (« C\'est noté » de la liste d\'attente) : rien n\'est noté ni réessayé', async () => {
  s.reglages.mailsEnPanne = 1;
  const r = await s.requete('listeAttente', { corps: { email: 'curieux@exemple.fr', accord: true } });
  assert.strictEqual(r.statut, 204);
  // L'envoi part après la réponse au site.
  for (let i = 0; i < 50 && !s.erreurs.length; i++) await new Promise((ok) => setTimeout(ok, 20));
  erreursAttendues(/confirmation non envoyée/);
  await s.calme();
  assert.deepStrictEqual(await perdus(), []);
  s.avancer(HEURE);
  await s.tache('courrielsAReessayer');
  assert.deepStrictEqual(mailsA('curieux@exemple.fr'), []);
});
