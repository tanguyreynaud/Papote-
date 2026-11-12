// E-mails perdus (courriels-perdus.js, audit des e-mails 11/11, point 2) : règles sans base de données.
const test = require('node:test');
const assert = require('node:assert');
const cp = require('./courriels-perdus');
const mail = require('./mail');

const req = ({ query = {}, headers = {} } = {}) => ({ query, get: (n) => headers[n.toLowerCase()] });

test('clé du webhook : ?cle=, X-Papote-Cle, Bearer ou Basic ; refusée sinon, et toujours sans secret configuré', () => {
  const s = 'secret-de-test';
  assert.ok(cp.cleValide(req({ query: { cle: s } }), s));
  assert.ok(cp.cleValide(req({ headers: { 'x-papote-cle': s } }), s));
  assert.ok(cp.cleValide(req({ headers: { authorization: `Bearer ${s}` } }), s));
  assert.ok(cp.cleValide(req({ headers: { authorization: `Basic ${Buffer.from(`brevo:${s}`).toString('base64')}` } }), s));
  assert.ok(!cp.cleValide(req(), s));
  assert.ok(!cp.cleValide(req({ query: { cle: 'autre' } }), s));
  assert.ok(!cp.cleValide(req({ query: { cle: `${s}x` } }), s));
  assert.ok(!cp.cleValide(req({ query: { cle: '' } }), ''), 'secret vide : tout est refusé');
});

test('événements Brevo : seuls les rejets avec une adresse, un seul ou une liste ; identifiant stable', () => {
  const e = { event: 'hard_bounce', email: 'a@b.fr', 'message-id': '<1@x>', ts_event: 1 };
  assert.strictEqual(cp.evenementsDe(e).length, 1);
  assert.strictEqual(cp.evenementsDe([e, { event: 'delivered', email: 'a@b.fr' }, { event: 'deferred', email: 'a@b.fr' },
    { event: 'blocked' }, null]).length, 1);
  for (const ev of ['hard_bounce', 'soft_bounce', 'blocked', 'invalid_email', 'spam', 'unsubscribed', 'error']) {
    assert.strictEqual(cp.evenementsDe({ event: ev, email: 'a@b.fr' }).length, 1, ev);
  }
  assert.deepStrictEqual(cp.evenementsDe('n\'importe quoi'), []);
  assert.strictEqual(cp.idEvenement(e), cp.idEvenement({ ...e, email: 'A@B.fr' }));
  assert.notStrictEqual(cp.idEvenement(e), cp.idEvenement({ ...e, event: 'spam' }));
  assert.match(cp.idEvenement(e), /^brevo-[0-9a-f]{32}$/);
});

test('contenu gardé pour le nouvel essai : pas les pièces jointes ni un e-mail trop gros', () => {
  const m = mail.colisParti({ nom: 'Paul', suivi: '1', lien: 'https://suivi' });
  assert.deepStrictEqual(Object.keys(cp.contenuGardable(m)).sort(), ['html', 'subject', 'text']);
  assert.strictEqual(cp.contenuGardable({ ...m, attachments: [{ filename: 'x.csv', content: 'a' }] }), null);
  assert.strictEqual(cp.contenuGardable({ ...m, html: 'x'.repeat(800 * 1024) }), null);
  assert.ok(cp.contenuGardable(mail.information({ objet: 'O', message: 'M', lienDesinscription: 'https://d' })).headers);
});

test('« À faire » : une ligne par adresse, seulement les lignes « a-faire »', () => {
  const lignes = cp.lignesAFaire([
    { statut: 'a-faire', origine: 'brevo', a: 'jean@x.fr', sujet: 'Colis', raison: 'boîte pleine', commande: 'sub_1', nom: 'Jean' },
    { statut: 'a-faire', origine: 'brevo', a: 'jean@x.fr', sujet: 'Commande', raison: 'adresse inexistante', commande: 'sub_1', nom: 'Jean' },
    { statut: 'a-reessayer', origine: 'smtp', a: 'lea@x.fr', sujet: 'Colis' },
    { statut: 'a-faire', origine: 'smtp', a: 'marc@x.fr', sujet: 'Mise en demeure', erreurReessai: 'SMTP 421', essais: 2 },
    { statut: 'traite', origine: 'brevo', a: 'eve@x.fr', sujet: 'X', raison: 'r' },
  ]);
  assert.deepStrictEqual(lignes, [
    'E-mail « Commande » et 1 autre non reçu par jean@x.fr (commande de Jean) : adresse inexistante. Vérifier l\'adresse avec le client',
    'E-mail « Mise en demeure » à marc@x.fr non parti après un second essai (SMTP 421) : le renvoyer ou prévenir le client',
  ]);
});

test('mail.envoyer : l\'échec d\'un e-mail important est noté puis l\'erreur remonte ; rien pour le confort ni les envois en nombre', async () => {
  const vrai = mail.expedier;
  const notes = [];
  mail.expedier = async () => { throw new Error('SMTP en panne'); };
  mail.surEchec((options, e) => { notes.push([options.contenu.subject, e.message]); });
  try {
    const options = { a: 'paul@x.fr', smtp: 'x:465:', expediteur: 'c@x.fr', motDePasse: 'x' };
    await assert.rejects(mail.envoyer({ ...options, contenu: mail.colisParti({ nom: 'Paul', suivi: '1', lien: 'https://s' }) }), /SMTP en panne/);
    await assert.rejects(mail.envoyer({ ...options, contenu: mail.rappelConfirme({ nom: 'Paul' }) }), /SMTP en panne/);
    await assert.rejects(mail.envoyer({ ...options, enNombre: true, contenu: mail.information({ objet: 'O', message: 'M', lienDesinscription: 'https://d' }) }), /SMTP en panne/);
    assert.deepStrictEqual(notes, [['Votre tablette Papote est en route', 'SMTP en panne']]);
    // Une note en panne ne change pas l'erreur reçue par l'appelant.
    mail.surEchec(() => { throw new Error('base en panne'); });
    await assert.rejects(mail.envoyer({ ...options, contenu: mail.colisParti({ nom: 'Paul', suivi: '1', lien: 'https://s' }) }), /SMTP en panne/);
  } finally {
    mail.expedier = vrai;
    mail.surEchec(null);
  }
});
