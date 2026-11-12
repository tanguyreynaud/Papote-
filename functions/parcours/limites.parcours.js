// Limites contre les abus (limites.js, A12, Tanguy 12/11) : voix Google coupée au 10e message du jour du même
// proche, 50 messages par jour et par famille, rappels 10 créés par jour et 30 en cours. Le refus lui-même (après
// 50 messages ou 10 rappels) est une règle Firestore : testé dans tests/regles/ et dans l'appli (tests/app-famille/).

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher } = require('./commun');

brancher();

async function famille() {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  await a.afficherCode(t);
  const fid = await a.installer(julie, t);
  await a.rejoindre(paul, fid);
  await s.calme();
  s.voixFaites.length = 0;
  s.reglages.voixEcrite = true;
  return { julie, paul, fid };
}

// Message écrit depuis l'appli, daté de « maintenant » (horloge de la simulation, qui peut avoir avancé).
async function message(proche, fid, texte, { attendre = true } = {}) {
  const ref = await s.db.collection(`families/${fid}/posts`).add({
    type: 'message', text: texte, authorUid: proche.uid, authorName: proche.prenom,
    createdAt: s.Timestamp.fromMillis(Date.now()), seenAt: null, hearts: 0, image: null,
  });
  if (attendre) await s.calme();
  return ref;
}
const aSaVoix = (ref) => s.voixFaites.includes(ref.path);
const compteur = (fid) => s.lire(`families/${fid}/compteurs/jour`);

async function rappel(fid, titre, plus = {}) {
  const ref = await s.db.collection(`families/${fid}/reminders`).add({
    title: titre, kind: 'medicament', time: '09:00', repeat: 'daily', date: null, days: [], createdBy: 'Julie',
    createdAt: s.Timestamp.fromMillis(Date.now()), lastAck: null, ...plus,
  });
  await s.calme();
  return ref;
}

test('voix Google coupée à partir du 10e message du jour du même proche, pas pour les autres ni pour les photos', async () => {
  const { julie, paul, fid } = await famille();
  const refs = [];
  for (let i = 1; i <= 10; i++) refs.push(await message(julie, fid, `Coucou numéro ${i}`));
  for (const r of refs.slice(0, 9)) assert.ok(aSaVoix(r), r.path);
  const dixieme = refs[9];
  assert.strictEqual(aSaVoix(dixieme), false);
  assert.strictEqual((await s.lire(dixieme.path)).voixCoupee, true);
  assert.strictEqual((await s.lire(dixieme.path)).voix, undefined);

  // La tablette marque « vu » et envoie un bisou : toujours pas de voix, et le compteur ne bouge pas.
  await dixieme.update({ seenAt: s.FieldValue.serverTimestamp(), hearts: 1 });
  await s.calme();
  assert.strictEqual(aSaVoix(dixieme), false);
  // Les messages qui ont leur voix ne sont pas recomptés quand la tablette les marque « vu ».
  await refs[0].update({ seenAt: s.FieldValue.serverTimestamp() });
  await s.calme();
  let c = await compteur(fid);
  assert.strictEqual(c.messages, 10);
  assert.strictEqual(c.parAuteur[julie.uid], 10);

  // Paul garde sa voix ; la légende d'une photo de Julie aussi (photos et vidéos ne comptent pas).
  const dePaul = await message(paul, fid, 'Bonne journée Mamie');
  assert.ok(aSaVoix(dePaul));
  const photo = await a.envoyer(julie, fid, 'photo', 'À la plage');
  assert.ok(s.voixFaites.includes(`families/${fid}/posts/${photo}`));
  c = await compteur(fid);
  assert.strictEqual(c.messages, 11);
  assert.strictEqual(c.bloqueJusqua, undefined);

  // Le lendemain, Julie retrouve sa voix.
  s.avancer(1);
  const demain = await message(julie, fid, 'Bonjour !');
  assert.ok(aSaVoix(demain));
  c = await compteur(fid);
  assert.strictEqual(c.messages, 1);
  assert.deepStrictEqual(c.parAuteur, { [julie.uid]: 1 });
});

test('50 messages par famille : drapeau jusqu’à minuit (Paris), ceux qui passent quand même n’ont pas de voix', async () => {
  const { fid } = await famille();
  const proches = [];
  for (let i = 0; i < 6; i++) proches.push(await s.compte(`Proche${i}`, `proche${i}@exemple.fr`));
  for (let i = 0; i < 49; i++) await message(proches[i % 6], fid, `Message ${i}`, { attendre: i % 10 === 9 });
  await s.calme();
  let c = await compteur(fid);
  assert.strictEqual(c.messages, 49);
  assert.strictEqual(c.bloqueJusqua, undefined);
  // Le 50e passe, avec sa voix (son auteur en est à moins de 10), et ferme la journée.
  const cinquantieme = await message(proches[1], fid, 'Le cinquantième');
  assert.ok(aSaVoix(cinquantieme));
  c = await compteur(fid);
  assert.strictEqual(c.messages, 50);
  const minuit = c.bloqueJusqua.toMillis();
  assert.ok(minuit > Date.now() && minuit <= Date.now() + 24 * 3600000);
  assert.strictEqual(new Date(minuit).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris' }), '00:00:00');

  // Deux messages lancés en même temps juste avant le drapeau (double appui, deux téléphones) : comptés, sans voix.
  const [x, y] = await Promise.all([message(proches[2], fid, 'Trop tard', { attendre: false }), message(proches[3], fid, 'Trop tard', { attendre: false })]);
  await s.calme();
  assert.strictEqual(aSaVoix(x) || aSaVoix(y), false);
  assert.strictEqual((await compteur(fid)).messages, 52);

  // Le lendemain : compteurs et drapeau effacés.
  s.avancer(1);
  const demain = await message(proches[2], fid, 'Nouveau jour');
  assert.ok(aSaVoix(demain));
  c = await compteur(fid);
  assert.strictEqual(c.messages, 1);
  assert.strictEqual(c.bloqueJusqua, undefined);
});

test('une copie d’anciens messages (restauration par Papote) n’est pas comptée ; une réponse de la tablette non plus', async () => {
  const { julie, fid } = await famille();
  const vieux = await s.db.collection(`families/${fid}/posts`).add({
    type: 'message', text: 'Message de la semaine dernière', authorUid: julie.uid, authorName: 'Julie',
    createdAt: s.Timestamp.fromMillis(Date.now() - 7 * 24 * 3600000), seenAt: null, hearts: 0,
  });
  await s.db.collection(`families/${fid}/posts`).add({
    type: 'reply', text: 'Merci', authorUid: 'tablette', authorName: 'Mamie', createdAt: s.Timestamp.fromMillis(Date.now()), seenAt: null, hearts: 0,
  });
  await s.calme();
  assert.ok(aSaVoix(vieux));
  assert.strictEqual(await compteur(fid), undefined);
});

test('rappels : 10 créés par jour, le 11e passé quand même est effacé ; les « c’est fait » ne comptent pas', async () => {
  const { fid } = await famille();
  const refs = [];
  for (let i = 1; i <= 9; i++) refs.push(await rappel(fid, `Médicament ${i}`));
  let c = await compteur(fid);
  assert.strictEqual(c.rappels, 9);
  assert.strictEqual(c.rappelsBloquesJusqua, undefined);
  refs.push(await rappel(fid, 'Médicament 10'));
  c = await compteur(fid);
  assert.strictEqual(c.rappels, 10);
  assert.ok(c.rappelsBloquesJusqua.toMillis() > Date.now());
  for (const r of refs) assert.ok(aSaVoix(r), r.path);

  // La tablette note « c'est fait » et « vu » : ni compté, ni relu.
  const voixAvant = s.voixFaites.length;
  await refs[0].update({ lastAck: '2026-11-12 09:01', lastSeen: '2026-11-12 09:00' });
  await s.calme();
  assert.strictEqual(s.voixFaites.length, voixAvant);
  assert.strictEqual((await compteur(fid)).rappels, 10);

  const rev = (await s.lire(`families/${fid}`)).rev || 0;
  const onzieme = await rappel(fid, 'Onzième');
  assert.strictEqual(await s.lire(onzieme.path), undefined);
  assert.strictEqual(aSaVoix(onzieme), false);
  assert.ok((await s.lire(`families/${fid}`)).rev > rev, 'la tablette relit l’agenda');
  // Les messages ne sont pas touchés par les rappels.
  assert.strictEqual(c.bloqueJusqua, undefined);
});

test('rappels : 30 en cours au plus (le 31e est effacé), les rappels terminés ne comptent pas', async () => {
  const { fid } = await famille();
  // 10 par jour sur 3 jours : 30 rappels en cours, dont un « une fois » aujourd'hui.
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 10; i++) await rappel(fid, `Rappel ${j}-${i}`, j === 0 && i === 0 ? { repeat: 'once', date: '2099-01-01' } : {});
    s.avancer(1);
  }
  assert.strictEqual((await s.db.collection(`families/${fid}/reminders`).get()).size, 30);
  const trenteEtUnieme = await rappel(fid, 'Un de trop');
  assert.strictEqual(await s.lire(trenteEtUnieme.path), undefined);
  assert.strictEqual((await s.db.collection(`families/${fid}/reminders`).get()).size, 30);

  // Un rappel terminé (date de fin passée) ne compte plus : le suivant est gardé.
  const premier = (await s.db.collection(`families/${fid}/reminders`).where('repeat', '==', 'daily').limit(1).get()).docs[0];
  await premier.ref.update({ finLe: '2000-01-01' });
  await s.calme();
  const garde = await rappel(fid, 'Celui-ci passe');
  assert.ok(await s.lire(garde.path));
  assert.ok(aSaVoix(garde));
});

test('rappel modifié : nouvelle voix 20 fois par jour, ensuite la voix d’Android ; le lendemain la voix revient', async () => {
  const { fid } = await famille();
  const r = await rappel(fid, 'Médicament');
  for (let i = 1; i <= 20; i++) {
    await r.update({ title: `Médicament ${i}` });
    await s.calme();
  }
  assert.strictEqual((await s.lire(r.path)).voix.texte, 'Médicament 20');
  await r.update({ title: 'Médicament 21' });
  await s.calme();
  let d = await s.lire(r.path);
  assert.strictEqual(d.voixCoupee, true);
  assert.strictEqual(d.voix, undefined, 'l’ancienne voix dirait l’ancien texte');
  // « C'est fait » de la tablette : toujours pas de voix.
  await r.update({ lastAck: '2026-11-12 09:00' });
  await s.calme();
  assert.strictEqual((await s.lire(r.path)).voix, undefined);

  s.avancer(1);
  await r.update({ title: 'Médicament du soir' });
  await s.calme();
  d = await s.lire(r.path);
  assert.strictEqual(d.voix.texte, 'Médicament du soir');
  assert.strictEqual(d.voixCoupee, undefined);
});

test('coût : une transaction par message créé, aucune lecture quand la tablette marque « vu » ou « c’est fait »', async () => {
  const { julie, fid } = await famille();
  const r = await rappel(fid, 'Médicament');
  const m = await message(julie, fid, 'Coucou');
  s.compteur.activer();
  await m.update({ seenAt: s.FieldValue.serverTimestamp() });
  await r.update({ lastAck: '2026-11-12 09:00' });
  await s.calme();
  let b = s.compteur.bilan();
  assert.strictEqual(b.voixEnvoi.lectures, 0, JSON.stringify(b.voixEnvoi));
  assert.strictEqual(b.voixRappel.lectures, 0, JSON.stringify(b.voixRappel));
  s.compteur.activer();
  await message(julie, fid, 'Encore un');
  s.compteur.arreter();
  b = s.compteur.bilan();
  // Compteur et drapeau de restauration (2 lectures, une transaction) ; la fiche de l'auteur (genre de la voix) est
  // lue par la vraie voix, pas par la simulation.
  assert.ok(b.voixEnvoi.lectures <= 2, JSON.stringify(b.voixEnvoi));
});
