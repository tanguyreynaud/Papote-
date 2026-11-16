// Désinscription des e-mails d'information (A4, Tanguy 12/11/2026) : seulement sur les e-mails d'information
// (rappels de commande, « Être prévenu », ouverture des commandes, nouvelles), lien et en-tête sur mapapote.fr.
// La simulation refuse en plus, dans chaque scénario de chaque fichier, tout e-mail de service qui porterait une
// désinscription (simulation.js, mail.expedier).

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, mailsA } = require('./commun');

brancher();

const HEURE = 1 / 24;
const contact = async (email) => (await s.db.collection('contacts').where('email', '==', email).get()).docs[0];
const lienDe = (m) => {
  const l = /<(https:\/\/mapapote\.fr\/desinscription\?c=([0-9a-f]{32})&j=([0-9a-f]{32}))>/.exec(m.entetes['List-Unsubscribe'] || '');
  assert.ok(l, `en-tête de désinscription sur « ${m.sujet} »`);
  return { lien: l[1], c: l[2], j: l[3] };
};

test('« Être prévenu » : lien et en-tête sur mapapote.fr, la page du site, puis un seul clic qui compte', async () => {
  const r = await s.requete('listeAttente', { corps: { email: 'curieux@exemple.fr', prenom: 'Odile', accord: true } });
  assert.strictEqual(r.statut, 204);
  await s.calme();
  const m = s.boite.find((x) => x.a === 'curieux@exemple.fr');
  assert.ok(m, '« C\'est noté » envoyé');
  const { lien, c, j } = lienDe(m);
  assert.strictEqual(m.entetes['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.ok(m.texte.trim().endsWith(`Se désinscrire des e-mails d'information : ${lien}`), 'lien tout en bas');
  assert.doesNotMatch(m.texte, /cloudfunctions\.net/);

  // Le lien ouvert (ou un antivirus qui l'ouvre) : rien ne change, renvoi vers la page du site.
  const ouvert = await s.requete('desinscription', { query: { c, j } });
  assert.strictEqual(ouvert.statut, 303);
  assert.strictEqual(ouvert.redirection, `https://mapapote.fr/desinscription.html?c=${c}&j=${j}`);
  assert.strictEqual((await contact('curieux@exemple.fr')).get('consentement'), true, 'pas désinscrit en ouvrant le lien');

  // Le bouton de la page : JSON. Deux fois (double clic, ou la messagerie ensuite) : une seule désinscription.
  const clic = await s.requete('desinscription', { corps: { c, j }, entetes: { accept: 'application/json' } });
  assert.deepStrictEqual([clic.statut, clic.json], [200, { ok: true }]);
  const le = (await contact('curieux@exemple.fr')).get('desinscritLe');
  assert.ok(le);
  s.avancer(HEURE);
  const encore = await s.requete('desinscription', { corps: { c, j }, entetes: { accept: 'application/json' } });
  assert.deepStrictEqual([encore.statut, encore.json], [200, { ok: true }]);
  const k = await contact('curieux@exemple.fr');
  assert.strictEqual(k.get('desinscritLe'), le, 'la première date reste');
  assert.strictEqual(k.get('consentement'), false);

  // Plus d'e-mail d'ouverture des commandes pour elle.
  const avant = s.boite.length;
  await s.appeler('lancementListeAttente', {}, a.TANGUY);
  assert.strictEqual(s.boite.length, avant);
});

test('« Se désabonner » de la messagerie (un clic, RFC 8058) et faux liens', async () => {
  await s.requete('listeAttente', { corps: { email: 'presse@exemple.fr', accord: true } });
  await s.calme();
  const { c, j } = lienDe(s.boite.find((x) => x.a === 'presse@exemple.fr'));
  // Mauvais jeton, jeton absent : 404, rien ne change.
  const faux = await s.requete('desinscription', { query: { c, j: 'f'.repeat(32) }, corps: { }, entetes: { accept: 'application/json' } });
  assert.deepStrictEqual([faux.statut, faux.json], [404, { ok: false, erreur: 'lien-inconnu' }]);
  assert.strictEqual((await s.requete('desinscription', { query: { c }, corps: 'List-Unsubscribe=One-Click', entetes: { 'content-type': 'application/x-www-form-urlencoded' } })).statut, 404);
  assert.strictEqual((await contact('presse@exemple.fr')).get('consentement'), true);
  // Comme Gmail : POST sur l'adresse de l'en-tête, corps « List-Unsubscribe=One-Click ».
  const un = await s.requete('desinscription', { query: { c, j }, corps: 'List-Unsubscribe=One-Click', entetes: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.strictEqual(un.statut, 200);
  assert.strictEqual((await contact('presse@exemple.fr')).get('consentement'), false);
  assert.ok((await contact('presse@exemple.fr')).get('desinscritLe'));
  // Lien de test (e-mail d'essai de l'admin) : rien n'est fait.
  const t = await s.requete('desinscription', { query: { test: '1' } });
  assert.strictEqual(t.redirection, 'https://mapapote.fr/desinscription.html?test=1');
  assert.deepStrictEqual((await s.requete('desinscription', { corps: { test: '1' }, entetes: { accept: 'application/json' } })).json, { ok: true, test: true });
});

test('rappel de panier : désinscription ; la commande payée ensuite n\'en porte aucune, ni ses relances d\'impayé', async () => {
  const email = 'hesite@exemple.fr';
  await a.commanderSurLeSite({ email });
  s.avancer(2 * HEURE);
  await s.tache('relancesPaniers');
  const rappel = s.boite.find((x) => x.a === email);
  assert.strictEqual(rappel && rappel.sujet, 'Votre commande Papote vous attend');
  lienDe(rappel);
  // Elle commande et paie : tout ce qui suit est du service.
  const avant = s.boite.length;
  const { abonnement } = await a.commanderEtPayer({ email, nom: 'Hélène Martin' });
  assert.ok(abonnement);
  const service = s.boite.slice(avant).filter((x) => x.a === email);
  assert.ok(service.length >= 1, `e-mails de service : ${mailsA(email).join(' | ')}`);
  for (const m of service) {
    assert.deepStrictEqual(m.entetes, {}, `« ${m.sujet} » sans en-tête de désinscription`);
    assert.doesNotMatch(m.texte, /désinscri/i, `« ${m.sujet} » sans lien de désinscription`);
  }
});
