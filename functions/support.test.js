const test = require('node:test');
const assert = require('node:assert');
const { nettoyer } = require('./support')._test;

test('garde une conversation correcte', () => {
  const m = [{ role: 'user', content: 'Bonjour' }, { role: 'assistant', content: 'Bonjour !' }, { role: 'user', content: ' Prix ? ' }];
  assert.deepStrictEqual(nettoyer(m)[2], { role: 'user', content: 'Prix ?' });
});

test('refuse ce qui ne finit pas par une question', () => {
  assert.strictEqual(nettoyer([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]), null);
  assert.strictEqual(nettoyer('x'), null);
  assert.strictEqual(nettoyer([]), null);
});

test('refuse deux messages du même côté et les rôles inconnus', () => {
  assert.strictEqual(nettoyer([{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }]), null);
  assert.deepStrictEqual(nettoyer([{ role: 'system', content: 'x' }, { role: 'user', content: 'a' }]), [{ role: 'user', content: 'a' }]);
});

test('coupe les messages trop longs et trop nombreux', () => {
  const long = [{ role: 'user', content: 'x'.repeat(5000) }];
  assert.strictEqual(nettoyer(long)[0].content.length, 1000);
  const beaucoup = [];
  for (let i = 0; i < 30; i++) beaucoup.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i });
  beaucoup.push({ role: 'user', content: 'fin' });
  // 31 messages : on garde les 12 derniers, puis on retire l'assistant de tête.
  const r = nettoyer(beaucoup);
  assert.strictEqual(r[0].role, 'user');
  assert.strictEqual(r[r.length - 1].content, 'fin');
});

const { coordonneesValides, lireReponse } = require('./support')._test;

test('accepte un téléphone ou un e-mail', () => {
  assert.deepStrictEqual(coordonneesValides('06 12 34 56 78'), { telephone: '06 12 34 56 78' });
  assert.deepStrictEqual(coordonneesValides('+33 6 12 34 56 78'), { telephone: '+33 6 12 34 56 78' });
  assert.deepStrictEqual(coordonneesValides(' a@b.fr '), { email: 'a@b.fr' });
  assert.strictEqual(coordonneesValides('1234'), null);
  assert.strictEqual(coordonneesValides('bonjour'), null);
});

test('repère la marque de passage de main', () => {
  assert.deepStrictEqual(lireReponse('Quelqu’un va vous recontacter.\n[CONTACT]'), { reponse: 'Quelqu’un va vous recontacter.', contact: true });
  assert.deepStrictEqual(lireReponse('20 € par mois.'), { reponse: '20 € par mois.', contact: false });
});

test('retire le gras markdown', () => {
  assert.strictEqual(lireReponse('Allez dans **Réglages**.').reponse, 'Allez dans Réglages.');
});

test('retire la phrase de refus collée à une vraie réponse', () => {
  assert.strictEqual(lireReponse('Renvoyez-la sous 30 jours. Je ne peux vous aider que pour Papote : avez-vous une question sur la tablette ou l\'appli ?').reponse, 'Renvoyez-la sous 30 jours.');
  const refus = 'Je ne peux vous aider que pour Papote. Avez-vous une question sur la tablette ou l\'appli ?';
  assert.strictEqual(lireReponse(refus).reponse, refus);
});

test('coordonnées à l\'ouverture du chat : tout est obligatoire, accord seulement si coché', () => {
  const { inscriptionValide } = require('./support')._test;
  assert.deepStrictEqual(inscriptionValide({ prenom: ' Léa ', nom: 'Martin', telephone: '06 12 34 56 78', email: 'Lea@X.fr' }),
    { prenom: 'Léa', nom: 'Martin', telephone: '06 12 34 56 78', email: 'lea@x.fr', marketing: false });
  assert.strictEqual(inscriptionValide({ prenom: 'Léa', nom: 'Martin', telephone: '0612345678', email: 'lea@x.fr', marketing: 'oui' }).marketing, false);
  assert.strictEqual(inscriptionValide({ prenom: 'Léa', nom: 'Martin', telephone: '0612345678', email: 'lea@x.fr', marketing: true }).marketing, true);
  assert.strictEqual(inscriptionValide({ prenom: 'Léa', telephone: '0612345678', email: 'lea@x.fr' }), null);
  assert.strictEqual(inscriptionValide({ prenom: 'Léa', nom: 'Martin', telephone: '0612', email: 'lea@x.fr' }), null);
  assert.strictEqual(inscriptionValide({ prenom: 'Léa', nom: 'Martin', telephone: '0612345678', email: 'lea' }), null);
});
