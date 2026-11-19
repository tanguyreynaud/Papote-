// Copie chiffrée des sauvegardes (sans émulateur) : node --test outils/admin/chiffrement.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chiffrer, dechiffrer, garderCopies, ENTETE, chiffrerFichier, dechiffrerFichier } = require('./chiffrement');

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

// Course vue en CI : mauvaise phrase pendant qu'une écriture du fichier en clair est encore en cours sur le disque.
// destroy() la fait finir en ERR_STREAM_DESTROYED, que Node émet en « error » avant « close » : le message
// « Cannot call write after a stream was destroyed » remplaçait « Phrase secrète incorrecte », et le fichier
// à moitié écrit restait. Ici l'ordre est forcé, sans aucune attente : la lecture de la source ne se ferme
// qu'une fois une écriture partie, et cette écriture ne se termine qu'après destroy().
test('mauvaise phrase pendant une écriture en cours : toujours « Phrase secrète incorrecte », rien ne reste', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'papote-course-'));
  const source = path.join(dossier, 'documents.jsonl');
  fs.writeFileSync(source, Buffer.alloc(2000, 7));
  await chiffrerFichier(source, `${source}.enc`, PHRASE);
  const cible = path.join(dossier, 'clair.jsonl');
  const { write, writev, close } = fs;
  const destroy = fs.WriteStream.prototype.destroy;
  let detruit = false;
  const retenues = [];
  let partie; const ecriturePartie = new Promise((ok) => { partie = ok; });
  // Une écriture seule, ou plusieurs (mises en attente pendant l'ouverture du fichier) : terminées après destroy().
  const retenir = (orig) => (...args) => {
    const cb = args.pop();
    orig(...args, (...r) => (detruit ? cb(...r) : retenues.push(() => cb(...r))));
    partie();
  };
  fs.write = retenir(write);
  fs.writev = retenir(writev);
  fs.close = (fd, cb) => { ecriturePartie.then(() => close(fd, cb)); };
  fs.WriteStream.prototype.destroy = function (...a) {
    detruit = true;
    const r = destroy.apply(this, a);
    retenues.splice(0).forEach((f) => f());
    return r;
  };
  try {
    await assert.rejects(() => dechiffrerFichier(`${source}.enc`, cible, 'une autre phrase longue'), /Phrase secrète incorrecte/);
  } finally {
    Object.assign(fs, { write, writev, close });
    fs.WriteStream.prototype.destroy = destroy;
  }
  assert.ok(!fs.existsSync(cible), 'aucun fichier à moitié écrit');
  fs.rmSync(dossier, { recursive: true, force: true });
});
