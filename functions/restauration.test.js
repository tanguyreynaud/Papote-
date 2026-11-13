// Restauration en cours (A34) : TOUS les déclencheurs Firestore se taisent, sans exception (base.js, declencheurs).
// Chaque fonction déployée qui écoute la base est lancée avec un événement piégé : la moindre lecture de l'événement
// (event.data, event.params…) fait échouer le test. Et la règle de la fenêtre debut-fin du drapeau.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Timestamp } = require('firebase-admin/firestore');
const base = require('./base');

// Tous les fichiers qui exportent des fonctions déployées.
const fonctions = require('./index');
const declencheurs = Object.entries(fonctions).filter(([, f]) => f && f.__endpoint && f.__endpoint.eventTrigger
  && /firestore/.test(f.__endpoint.eventTrigger.eventType));

test('liste des déclencheurs Firestore : tous connus (un nouveau doit être ajouté ici, et il passe par base.declencheurs)', () => {
  assert.deepStrictEqual(declencheurs.map(([n]) => n).sort(), [
    'appelsManques', 'appelsSonnerie', 'commandeModifiee', 'compterProches', 'gestionJumelage', 'jetonUnique', 'jumelageAutomatique',
    'membreAccepte', 'nouveauMembre', 'nouvelleFamille', 'quotaEnvois', 'reveilAppel', 'reveilFamille', 'reveilOrdre',
    'reveilPing', 'reveilVersion', 'simInstallation', 'tabletteVoleeSuite', 'telephoneAppels', 'voixEnvoi', 'voixRappel',
  ]);
  // Aucun fichier ne prend les déclencheurs directement chez firebase-functions (sauf base.js qui les enveloppe).
  const directs = fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js') && f !== 'base.js')
    .filter((f) => /require\('firebase-functions\/v2\/firestore'\)/.test(fs.readFileSync(path.join(__dirname, f), 'utf8')));
  assert.deepStrictEqual(directs, []);
});

test('pendant une restauration, chaque déclencheur s\'arrête avant de lire son événement', async (ctx) => {
  ctx.mock.method(base, 'restaurationEnCours', async () => true);
  for (const [nom, f] of declencheurs) {
    const piege = new Proxy({}, { get: (_, cle) => { if (cle === 'then') return undefined; throw new Error(`${nom} a lu event.${String(cle)}`); } });
    assert.strictEqual(await f.run(piege), null, nom);
  }
});

test('hors restauration, l\'événement est bien passé au déclencheur', async (ctx) => {
  ctx.mock.method(base, 'restaurationEnCours', async () => false);
  const lus = [];
  const [, f] = declencheurs.find(([n]) => n === 'compterProches');
  const evenement = new Proxy({}, { get: (_, cle) => { lus.push(cle); return undefined; } });
  await f.run(evenement).catch(() => null);
  assert.ok(lus.includes('data'), 'compterProches a lu son événement');
});

test('restaurationEnCours : en cours (jusque pas dépassé), fenêtre debut-fin pour les événements en retard, sinon non', async (ctx) => {
  const T = Date.parse('2026-11-12T15:00:00Z');
  ctx.mock.method(Date, 'now', () => T);
  let drapeau = null;
  const fausse = { doc: () => ({ get: async () => ({ exists: !!drapeau, data: () => drapeau }) }) };
  // db() de base.js lit l'instance ; on la remplace le temps du test.
  const firestore = require('firebase-admin/firestore');
  ctx.mock.method(firestore, 'getFirestore', () => fausse);
  ctx.mock.method(firestore, 'initializeFirestore', () => fausse);
  delete require.cache[require.resolve('./base')];
  const b = require('./base');
  const ev = (ms) => ({ time: new Date(ms).toISOString() });
  // Chaque changement du drapeau : mémoire vidée (sinon gardé 60 s, voir le test suivant).
  const poser = (d) => { drapeau = d; b.oublierDrapeau(); };
  const ts = (ms) => Timestamp.fromMillis(ms);

  assert.strictEqual(await b.restaurationEnCours(ev(T)), false, 'pas de drapeau');
  poser({ enCours: true, debut: ts(T - 60e3), jusque: ts(T + 3600e3) });
  assert.strictEqual(await b.restaurationEnCours(ev(T - 1000)), true, 'écriture de la restauration');
  assert.strictEqual(await b.restaurationEnCours(ev(T - 120e3)), false, 'écriture d\'avant la restauration (livrée tard)');
  assert.strictEqual(await b.restaurationEnCours(), true, 'sans heure d\'événement : maintenant');
  poser({ enCours: true, debut: ts(T - 3 * 3600e3), jusque: ts(T - 1) });
  assert.strictEqual(await b.restaurationEnCours(ev(T)), false, 'restauration plantée : 2 h au plus');
  poser({ enCours: false, debut: ts(T - 600e3), fin: ts(T - 60e3) });
  assert.strictEqual(await b.restaurationEnCours(ev(T - 300e3)), true, 'événement de la restauration livré après la fin');
  assert.strictEqual(await b.restaurationEnCours(ev(T - 30e3)), false, 'écriture d\'après la fin');
  assert.strictEqual(await b.restaurationEnCours(ev(T)), false);
  delete require.cache[require.resolve('./base')];
});

test('mémoire du drapeau : « pas de restauration » gardé 60 s (une lecture par minute), « en cours » relu à chaque fois', async (ctx) => {
  let maintenant = Date.parse('2026-11-12T15:00:00Z');
  ctx.mock.method(Date, 'now', () => maintenant);
  let drapeau = null;
  let lectures = 0;
  const fausse = { doc: () => ({ get: async () => { lectures++; return { exists: !!drapeau, data: () => drapeau }; } }) };
  const firestore = require('firebase-admin/firestore');
  ctx.mock.method(firestore, 'getFirestore', () => fausse);
  ctx.mock.method(firestore, 'initializeFirestore', () => fausse);
  delete require.cache[require.resolve('./base')];
  const b = require('./base');
  for (let i = 0; i < 50; i++) assert.strictEqual(await b.restaurationEnCours(), false);
  assert.strictEqual(lectures, 1, '50 déclencheurs, une lecture');
  // La restauration commence : pendant 60 s la mémoire dit encore non (restaurer attend 70 s avant d'écrire)…
  drapeau = { enCours: true, debut: Timestamp.fromMillis(maintenant), jusque: Timestamp.fromMillis(maintenant + 7200e3) };
  maintenant += 59e3;
  assert.strictEqual(await b.restaurationEnCours(), false);
  // … puis elle est relue : en cours, et relue à chaque fois.
  maintenant += 11e3;
  assert.strictEqual(await b.restaurationEnCours(), true);
  assert.strictEqual(await b.restaurationEnCours(), true);
  assert.strictEqual(lectures, 3);
  // Fin : vue tout de suite.
  drapeau = { enCours: false, debut: drapeau.debut, fin: Timestamp.fromMillis(maintenant) };
  maintenant += 1000;
  assert.strictEqual(await b.restaurationEnCours({ time: new Date(maintenant).toISOString() }), false);
  assert.strictEqual(await b.restaurationEnCours({ time: new Date(maintenant - 5000).toISOString() }), true, 'événement de la restauration livré en retard');
  assert.strictEqual(lectures, 4);
  delete require.cache[require.resolve('./base')];
});
