const test = require('node:test');
const assert = require('node:assert');
const { lireDemande, photoValide, conversationPropre, etatTablette, resumeTablette, idDeclaration, mailEquipe, mailAuteur, MOTIFS } = require('./declaration')._test;

// Petit JPEG valable (en-tête FF D8 FF, puis remplissage).
const jpeg = (n = 500) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]).toString('base64');
const base = { cle: 'abcdefghijkl1234', reponses: [{ question: 'Comment ?', reponse: 'Chute' }] };

test('motif inconnu ou absent : refusé', () => {
  assert.match(lireDemande({ ...base, motif: 'rembourser' }).erreur, /Choisissez/);
  assert.match(lireDemande({ ...base }).erreur, /Choisissez/);
  assert.match(lireDemande({ ...base, motif: '__proto__' }).erreur, /Choisissez/);
});

test('clé de formulaire obligatoire (un double appui ne crée pas deux demandes)', () => {
  assert.match(lireDemande({ ...base, motif: 'panne', cle: '' }).erreur, /incomplète/);
  assert.match(lireDemande({ ...base, motif: 'panne', cle: 'a/b' }).erreur, /incomplète/);
});

test('photo obligatoire pour écran, casse et colis ; facultative pour une panne, un chargeur', () => {
  for (const m of ['ecran', 'casse', 'colis']) assert.match(lireDemande({ ...base, motif: m }).erreur, /au moins une photo/, m);
  for (const m of ['panne', 'chargeur', 'vol', 'donnees', 'autre']) assert.ok(!lireDemande({ ...base, motif: m }).erreur, m);
  const ok = lireDemande({ ...base, motif: 'ecran', photos: [jpeg()] });
  assert.ok(!ok.erreur);
  assert.strictEqual(ok.photos.length, 1);
  assert.ok(Buffer.isBuffer(ok.photos[0]));
});

test('3 photos au plus, JPEG seulement, 2 Mo au plus', () => {
  assert.match(lireDemande({ ...base, motif: 'casse', photos: [jpeg(), jpeg(), jpeg(), jpeg()] }).erreur, /3 photos/);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500)]).toString('base64');
  assert.match(lireDemande({ ...base, motif: 'casse', photos: [png] }).erreur, /ne passe pas/);
  assert.match(lireDemande({ ...base, motif: 'casse', photos: [jpeg(3 * 1024 * 1024)] }).erreur, /ne passe pas/);
  assert.match(lireDemande({ ...base, motif: 'casse', photos: [42] }).erreur, /ne passe pas/);
  assert.ok(photoValide(`data:image/jpeg;base64,${jpeg()}`));
});

test('il faut au moins une réponse ou un message', () => {
  assert.match(lireDemande({ motif: 'panne', cle: base.cle, reponses: [] }).erreur, /quelques mots/);
  assert.ok(!lireDemande({ motif: 'panne', cle: base.cle, message: 'Écran noir' }).erreur);
});

test('réponses et message nettoyés, bornés', () => {
  const d = lireDemande({ motif: 'autre', cle: base.cle, reponses: [{ question: '  Q  ', reponse: 'x'.repeat(2000) }, { question: 'vide', reponse: '' }, null], message: 'a\n\n\n\nb' });
  assert.strictEqual(d.reponses.length, 1);
  assert.strictEqual(d.reponses[0].question, 'Q');
  assert.strictEqual(d.reponses[0].reponse.length, 600);
  assert.strictEqual(d.message, 'a\n\nb');
});

test('conversation : seulement user/assistant, 12 tours au plus', () => {
  const tours = [{ role: 'system', content: 'x' }, ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }))];
  const c = conversationPropre(tours);
  assert.strictEqual(c.length, 12);
  assert.ok(c.every((m) => m.role === 'user' || m.role === 'assistant'));
  assert.deepStrictEqual(conversationPropre('x'), []);
});

test('même personne + même clé = même déclaration ; autre personne = autre', () => {
  assert.strictEqual(idDeclaration('u1', 'cle-123456789'), idDeclaration('u1', 'cle-123456789'));
  assert.notStrictEqual(idDeclaration('u1', 'cle-123456789'), idDeclaration('u2', 'cle-123456789'));
  assert.match(idDeclaration('u1', 'c'), /^[a-f0-9]{24}$/);
});

test('état de la tablette : en ligne, batterie, carte SIM, version', () => {
  const maintenant = Date.UTC(2026, 10, 18, 10);
  const t = etatTablette({ lastOnline: maintenant - 5 * 60e3, battery: { level: 41.6, charging: false }, sim: { reseau: 'Bouygues', signal: 3, dataMoisMo: 820 }, appVersion: '2.99.130' }, 'T-003', maintenant);
  assert.deepStrictEqual({ ...t, vueLe: undefined }, { ref: 'T-003', enLigneLe: maintenant - 5 * 60e3, horsLigne: false, batterie: 42, enCharge: false, reseau: 'carte SIM, Bouygues, signal 3/4', dataMoisMo: 820, version: '2.99.130', vueLe: undefined });
  assert.match(resumeTablette(t, maintenant), /T-003 · en ligne \(il y a 5 min\) · batterie 42 %, débranchée · carte SIM, Bouygues/);
  const hors = etatTablette({ lastOnline: maintenant - 3 * 3600e3 }, null, maintenant);
  assert.strictEqual(hors.horsLigne, true);
  assert.strictEqual(hors.reseau, 'Wi-Fi');
  assert.match(resumeTablette(hors, maintenant), /hors ligne, dernier signe il y a 3 h/);
  assert.strictEqual(etatTablette(null), null);
  assert.strictEqual(resumeTablette(null), 'aucune tablette dans la famille');
});

const declaration = {
  motif: 'ecran', fid: 'f1', famille: 'Famille <Dupont>', reponses: [{ question: 'Comment ?', reponse: 'Chute' }], message: 'Fissure en haut',
  conversation: [{ role: 'user', content: 'écran cassé' }], photos: [{ chemin: 'x' }, { chemin: 'y' }],
  auteur: { nom: 'Julie Martin', prenom: 'Julie', email: 'julie@exemple.fr', telephone: '0600000000', role: 'responsable' },
  tablette: { ref: 'T-009', enLigneLe: Date.now(), horsLigne: false, batterie: 80, enCharge: true, reseau: 'Wi-Fi' }, abonnement: 'actif',
};

test('e-mail à l\'équipe : tout pour décider, réponse directe à la personne, rien d\'injecté', () => {
  const m = mailEquipe(declaration, Date.now());
  assert.match(m.subject, /Écran fissuré/);
  assert.strictEqual(m.replyTo, 'julie@exemple.fr');
  assert.match(m.html, /T-009/);
  assert.match(m.html, /Fissure en haut/);
  assert.match(m.html, /2, jointes/);
  assert.match(m.html, /Famille &lt;Dupont&gt;/);
  assert.doesNotMatch(m.html, /<Dupont>/);
});

test('accusé de réception : délai de 48 h, jamais de prénom de l\'équipe', () => {
  const m = mailAuteur(declaration);
  assert.match(m.text, /48 h/);
  assert.match(m.text, /vos 2 photos/);
  assert.doesNotMatch(m.html + m.text, /Tanguy/);
});

test('chaque motif a un libellé', () => {
  for (const [k, v] of Object.entries(MOTIFS)) assert.ok(v.libelle, k);
});

test('repère « déclaration envoyée » de la bulle reconnu par le serveur, pour chaque motif', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { etatMain } = require('./support')._test;
  const source = fs.readFileSync(path.join(__dirname, '..', 'vitrine', 'chat-declaration.js'), 'utf8');
  const fenetre = {};
  new Function('window', 'document', source)(fenetre, {});
  const repere = source.match(/content: ('\(Déclaration « ' \+ m\.libelle[^;]*?envoyée\)')/);
  assert.ok(repere, 'repère trouvé dans la bulle');
  const fabriquer = new Function('m', `return ${repere[1]};`);
  for (const m of fenetre.PapoteDeclaration._motifs) {
    assert.strictEqual(etatMain([{ role: 'user', content: 'Écran cassé' }, { role: 'user', content: fabriquer(m) }]), 'envoyee', m.libelle);
  }
});
