const test = require('node:test');
const assert = require('node:assert');
const mail = require('./mail');

test('espaces insécables avant la ponctuation, jamais dans les balises', () => {
  const m = mail.tabletteRecue({ nom: 'Paul', rembourse: 6000 });
  assert.match(m.html, /Merci&nbsp;!/);
  assert.match(m.html, /60&nbsp;€/);
  assert.match(m.html, /style="margin:0 0 16px"/);
  assert.doesNotMatch(m.text, /&nbsp;/);
});

test('désinscription sous le bouton, et e-mails internes sans « Une question ? »', () => {
  const r = mail.relancePanier({ etape: 1, nom: 'Paul', lien: 'https://x/c', desinscription: 'https://x/d' });
  assert.ok(r.html.indexOf('Reprendre ma commande') < r.html.indexOf('Se désinscrire'));
  assert.match(r.text, /Se désinscrire/);
  const n = mail.nouvelleCommande({ nom: 'Paul', email: 'p@x.fr', code: 'AB' });
  assert.doesNotMatch(n.html, /Une question/);
  assert.match(mail.commandeAnnulee({ nom: 'Paul' }).html, /Une question/);
  assert.strictEqual((mail.sepaRefuse({ nom: 'Paul' }).text.match(/Une question/g) || []).length, 1);
});

test('tablette remise en main propre : rien qui invite à changer d\'avis', () => {
  const m = mail.tabletteRemise({ nom: 'Marie', code: 'ABCD-1234' });
  assert.ok(m.html.includes('remise en main propre'));
  assert.ok(!m.text.includes('changer d\'avis'));
  assert.ok(!m.text.includes('60 €'));
});
