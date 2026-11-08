// Copie chiffrée des sauvegardes (sans émulateur) : node --test outils/admin/chiffrement.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chiffrer, dechiffrer, garderCopies, ENTETE } = require('./chiffrement');

const PHRASE = 'cheval agrafe batterie correct';

test('aller-retour identique, et rien de lisible dans le fichier chiffré', () => {
  const clair = Buffer.from(JSON.stringify({ documents: [{ chemin: 'families/f1/members/m', data: { telephone: '0612345678' } }] }));
  const enc = chiffrer(clair, PHRASE);
  assert.ok(enc.subarray(0, ENTETE.length).equals(ENTETE));
  assert.ok(!enc.includes(Buffer.from('0612345678')));
  assert.ok(dechiffrer(enc, PHRASE).equals(clair));
  // Deux chiffrements du même contenu diffèrent (sel et iv aléatoires).
  assert.ok(!chiffrer(clair, PHRASE).equals(enc));
});

test('mauvaise phrase, fichier modifié ou étranger : refus clair', () => {
  const enc = chiffrer(Buffer.from('bonjour'), PHRASE);
  assert.throws(() => dechiffrer(enc, 'une autre phrase longue'), /Phrase secrète incorrecte/);
  const abime = Buffer.from(enc); abime[abime.length - 1] ^= 1;
  assert.throws(() => dechiffrer(abime, PHRASE), /incorrecte, ou fichier abîmé/);
  assert.throws(() => dechiffrer(Buffer.from('{"documents":[]}'), PHRASE), /pas une copie chiffrée/);
  assert.throws(() => chiffrer(Buffer.from('x'), 'court'), /trop courte/);
});

test('rotation : garde les n dernières, mais jamais après une copie anormalement petite', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'copies-'));
  const ecrire = (jour, octets) => fs.writeFileSync(path.join(d, `papote-2026-11-${jour}-03-00-00.json.enc`), Buffer.alloc(octets));
  ecrire('01', 1000); ecrire('08', 1000); ecrire('15', 1000);
  assert.deepStrictEqual(garderCopies(d, 2), ['papote-2026-11-01-03-00-00.json.enc']);
  ecrire('22', 10); // sauvegarde vide : on ne touche à rien
  assert.deepStrictEqual(garderCopies(d, 2), []);
  assert.strictEqual(fs.readdirSync(d).length, 3);
  fs.writeFileSync(path.join(d, 'autre.txt'), 'x');
  ecrire('29', 1000);
  assert.deepStrictEqual(garderCopies(d, 2), ['papote-2026-11-08-03-00-00.json.enc', 'papote-2026-11-15-03-00-00.json.enc']);
  assert.ok(fs.existsSync(path.join(d, 'autre.txt')));
});
