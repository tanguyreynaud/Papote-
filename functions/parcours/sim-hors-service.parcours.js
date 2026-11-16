// Carte SIM sans réseau depuis plus de 2 h (Tanguy, 13/11 ; sim-hors-service.js) : Tanguy seul est prévenu, une fois
// par panne (e-mail + ligne « À faire »), puis un mot quand le réseau revient. Deux cas : sim.service « hors service »,
// ou aucune antenne du réseau qui porte la carte. Les rapports de la tablette (toutes les 30 min) sont écrits sur sa
// fiche comme Sync.java (sim remplacée en entier, vuLe = heure de la tablette).

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, mailsA } = require('./commun');
const base = require('../base');

brancher();

const PAPOTE = 'contact@mapapote.fr';
const MIN = 60_000;
const BOUYGUES = '20820';
const ORANGE = '20801';
const antenne = (reseau, utilisee = false) => ({ reseau, nom: reseau === BOUYGUES ? 'Bouygues' : 'Orange F', type: '4G', bande: 20, dbm: -95, utilisee });

async function familleAvecTablette() {
  const julie = await s.compte('Julie', 'julie@exemple.fr');
  const t = await a.tablettePreparee();
  await a.afficherCode(t);
  const fid = await a.installer(julie, t, { nom: 'Mamie Jeanne' });
  const fiche = `families/${fid}/members/${t.tabletUid}`;
  const T0 = Date.now();
  // Un rapport de la tablette, minutes après T0 (sim : null = pas de carte SIM).
  const rapport = async (minutes, sim) => {
    const complet = sim === null ? null : { iccid: '8933', operateur: 'Lyca Mobile', reseau: '4G', signal: 2, simReseau: '20825', ...sim, vuLe: s.Timestamp.fromMillis(T0 + minutes * MIN) };
    if (complet) Object.keys(complet).forEach((k) => complet[k] === undefined && delete complet[k]);
    await s.db.doc(fiche).update({
      sim: complet,
      lastOnline: s.FieldValue.serverTimestamp(),
    });
    await s.calme();
  };
  return { julie, t, fid, fiche, rapport, emails: () => mailsA(PAPOTE).filter((m) => /Carte SIM/.test(m)) };
}

const ligneAFaire = async () => (await s.appeler('gestionDonnees', {}, a.TANGUY)).simAFaire;

test('hors service 1 h 59 : rien ; 2 h : une alerte ; ensuite plus rien ; retour : « revenue » ; nouvelle panne réalertée', async () => {
  const { julie, t, fiche, rapport, emails } = await familleAvecTablette();
  const famille = () => s.boite.filter((m) => m.a === julie.email && /SIM|réseau/i.test(m.sujet));
  await rapport(0, { service: 'ok' });
  await rapport(30, { service: 'hors service' });
  assert.ok((await s.lire(fiche)).simHorsService.depuis, 'début de la panne noté sur la fiche');
  for (const m of [60, 90, 120, 149]) await rapport(m, { service: 'hors service' }); // 1 h 59
  assert.deepStrictEqual(emails(), [], '1 h 59 : rien');
  assert.deepStrictEqual(await ligneAFaire(), []);

  await rapport(150, { service: 'hors service' }); // 2 h pile
  assert.deepStrictEqual(emails(), [`Carte SIM hors service depuis 2 h : tablette ${t.ref} de Mamie Jeanne`]);
  const mail = s.boite.find((m) => m.a === PAPOTE && /Carte SIM hors service/.test(m.sujet));
  assert.match(mail.texte, /est hors service depuis le/);
  assert.match(mail.texte, /redémarré seule/);
  const lignes = await ligneAFaire();
  assert.strictEqual(lignes.length, 1);
  assert.match(lignes[0], new RegExp(`Carte SIM hors service depuis le .* : tablette ${t.ref} de Mamie Jeanne \\(Lyca Mobile\\)`));

  for (const m of [180, 210, 240, 400]) await rapport(m, { service: 'hors service' });
  assert.strictEqual(emails().length, 1, 'une seule alerte par panne');

  await rapport(430, { service: 'ok' });
  assert.strictEqual(emails().length, 2);
  assert.strictEqual(emails()[1], `Carte SIM revenue : tablette ${t.ref} de Mamie Jeanne`);
  assert.match(s.boite.filter((m) => m.a === PAPOTE).at(-1).texte, /après 6 h 40/);
  assert.deepStrictEqual(await ligneAFaire(), [], 'ligne « À faire » levée');
  assert.strictEqual((await s.lire(fiche)).simHorsService, undefined);

  // Nouvelle panne : nouveau compte, nouvelle alerte.
  await rapport(460, { service: 'urgences' });
  await rapport(570, { service: 'urgences' });
  assert.strictEqual(emails().length, 2);
  await rapport(580, { service: 'urgences' });
  assert.strictEqual(emails().length, 3, 'nouvelle panne réalertée');
  assert.strictEqual((await ligneAFaire()).length, 1);
  assert.deepStrictEqual(famille(), [], 'la famille ne reçoit rien');
  assert.ok(!s.notifications.some((n) => /SIM|réseau/i.test(`${n.titre || ''} ${n.texte || ''}`)), 'aucune notification aux téléphones');
});

test('rapports espacés de plus de 2 h (tablette muette entre-temps) : le compte repart, pas d\'alerte sur un trou', async () => {
  const { rapport, emails } = await familleAvecTablette();
  await rapport(0, { service: 'hors service' });
  await rapport(200, { service: 'hors service' }); // 3 h 20 sans nouvelles : la panne continue n'est pas prouvée
  assert.deepStrictEqual(emails(), []);
  await rapport(230, { service: 'hors service' });
  await rapport(320, { service: 'hors service' });
  assert.strictEqual(emails().length, 1, '2 h de rapports suivis depuis le trou');
});

test('tablette sans carte SIM, mode avion, état illisible : jamais d\'alerte', async () => {
  const { fiche, rapport, emails } = await familleAvecTablette();
  for (let m = 0; m <= 300; m += 30) await rapport(m, null);
  for (let m = 330; m <= 600; m += 30) await rapport(m, { service: 'eteint' });
  for (let m = 630; m <= 900; m += 30) await rapport(m, { service: '' });
  assert.deepStrictEqual(emails(), []);
  assert.strictEqual((await s.lire(fiche)).simHorsService, undefined);
  // Carte retirée pendant une panne signalée : la ligne est levée, sans e-mail « revenue ».
  for (let m = 930; m <= 1080; m += 30) await rapport(m, { service: 'hors service' });
  assert.strictEqual(emails().length, 1);
  await rapport(1110, null);
  assert.strictEqual(emails().length, 1, 'pas de « revenue » pour une carte retirée');
  assert.deepStrictEqual(await ligneAFaire(), []);
});

test('restauration en cours : les rapports hors service ne déclenchent rien', async () => {
  const { fiche, rapport, emails } = await familleAvecTablette();
  await s.db.doc('interne/restauration').set({
    enCours: true, debut: s.Timestamp.fromMillis(Date.now() - MIN), jusque: s.Timestamp.fromMillis(Date.now() + 3600_000),
  });
  base.oublierDrapeau();
  try {
    for (let m = 0; m <= 240; m += 30) await rapport(m, { service: 'hors service' });
    assert.deepStrictEqual(emails(), []);
    assert.strictEqual((await s.lire(fiche)).simHorsService, undefined, 'rien d\'écrit pendant la restauration');
  } finally {
    await s.db.doc('interne/restauration').delete();
    base.oublierDrapeau();
    s.journal.length = 0;
  }
});

test('aucune antenne du réseau qui porte la carte pendant 2 h : alerte « sans antenne » ; une antenne du réseau revient : « revenue »', async () => {
  const { t, fiche, rapport, emails } = await familleAvecTablette();
  // Vieille tablette sans antennes, puis réseau hôte pas encore connu : le cas « antennes » ne joue pas.
  await rapport(0, { service: 'ok' });
  await rapport(30, { service: 'ok', antennes: [antenne(ORANGE)] });
  assert.strictEqual((await s.lire(fiche)).simReseauHote, undefined, 'aucune antenne utilisée : réseau hôte inconnu');
  // En service sur Bouygues : le serveur retient le réseau hôte (la tablette ne l'envoie pas).
  await rapport(60, { service: 'ok', antennes: [antenne(BOUYGUES, true), antenne(ORANGE)] });
  assert.strictEqual((await s.lire(fiche)).simReseauHote, BOUYGUES);
  // Chez Mamie : seulement de l'Orange, la carte reste « urgences ».
  for (const m of [90, 120, 150, 180, 209]) await rapport(m, { service: 'urgences', antennes: [antenne(ORANGE), antenne(ORANGE)] });
  assert.deepStrictEqual(emails(), [], '1 h 59 : rien');
  await rapport(210, { service: 'urgences', antennes: [antenne(ORANGE)] });
  assert.deepStrictEqual(emails(), [`Carte SIM sans antenne de son réseau depuis 2 h : tablette ${t.ref} de Mamie Jeanne`]);
  const mail = s.boite.filter((m) => m.a === PAPOTE).at(-1);
  assert.match(mail.texte, /aucune antenne de son réseau \(20820\)/);
  assert.match(mail.texte, /Changer de carte SIM/);
  assert.match((await ligneAFaire())[0], /Carte SIM sans antenne de son réseau depuis le .*Aucune antenne 20820/);
  await rapport(240, { service: 'urgences', antennes: [antenne(ORANGE)] });
  assert.strictEqual(emails().length, 1);
  // Une antenne Bouygues revient (la carte s'y accroche) : le mot de fin.
  await rapport(270, { service: 'ok', antennes: [antenne(BOUYGUES, true), antenne(ORANGE)] });
  assert.deepStrictEqual(emails().slice(1), [`Carte SIM revenue : tablette ${t.ref} de Mamie Jeanne`]);
  assert.match(s.boite.filter((m) => m.a === PAPOTE).at(-1).texte, /de nouveau une antenne de son réseau/);
  assert.deepStrictEqual(await ligneAFaire(), []);
});

test('antennes absentes du rapport (vieille tablette) ou liste vide : pas de cas « antennes », même réseau hôte connu', async () => {
  const { fiche, rapport, emails } = await familleAvecTablette();
  await rapport(0, { service: 'ok', antennes: [antenne(BOUYGUES, true)] });
  assert.strictEqual((await s.lire(fiche)).simReseauHote, BOUYGUES);
  for (let m = 30; m <= 300; m += 30) await rapport(m, { service: 'ok', antennes: m % 60 ? [] : undefined });
  assert.deepStrictEqual(emails(), []);
  assert.strictEqual((await s.lire(fiche)).simHorsService, undefined);
});

test('carte bloquée (PIN) : alerte dès le premier rapport, une seule ; débloquée : un mot ; jamais la famille', async () => {
  const { julie, t, fiche, rapport, emails } = await familleAvecTablette();
  const bloquee = (code) => ({ bloquee: code, service: `code ${code}`, iccid: undefined, operateur: undefined, reseau: undefined, signal: undefined, simReseau: undefined });
  await rapport(0, { service: 'ok' });
  await rapport(30, bloquee('pin'));
  assert.deepStrictEqual(emails(), [`Carte SIM bloquée (code PIN demandé) : tablette ${t.ref} de Mamie Jeanne`]);
  assert.match(s.boite.filter((m) => m.a === PAPOTE).at(-1).texte, /saisir le code PIN/);
  assert.match((await ligneAFaire())[0], new RegExp(`^Carte SIM bloquée depuis le .* : tablette ${t.ref} de Mamie Jeanne\\. Code PIN demandé`));
  for (let m = 60; m <= 300; m += 30) await rapport(m, bloquee('pin'));
  assert.strictEqual(emails().length, 1, 'une alerte par blocage, pas d\'alerte 2 h en plus');
  assert.strictEqual((await s.lire(fiche)).simHorsService, undefined);
  // PIN saisi : la carte est lue, en service.
  await rapport(330, { service: 'ok' });
  assert.deepStrictEqual(emails().slice(1), [`Carte SIM débloquée : tablette ${t.ref} de Mamie Jeanne`]);
  assert.match(s.boite.filter((m) => m.a === PAPOTE).at(-1).texte, /après 5 h/);
  assert.deepStrictEqual(await ligneAFaire(), []);
  assert.strictEqual((await s.lire(fiche)).simBloquee, undefined);
  assert.deepStrictEqual(s.boite.filter((m) => m.a === julie.email && /SIM/.test(m.sujet)), [], 'la famille ne reçoit rien');
});

test('hors service signalé puis carte bloquée (PUK) : l\'alerte « bloquée » prime, sans « revenue » ni 2e alerte 2 h', async () => {
  const { t, fiche, rapport, emails } = await familleAvecTablette();
  const bloquee = (code) => ({ bloquee: code, service: `code ${code}`, iccid: undefined, operateur: undefined, reseau: undefined, signal: undefined, simReseau: undefined });
  for (let m = 0; m <= 120; m += 30) await rapport(m, { service: 'hors service' });
  assert.deepStrictEqual(emails(), [`Carte SIM hors service depuis 2 h : tablette ${t.ref} de Mamie Jeanne`]);
  await rapport(150, bloquee('puk'));
  assert.deepStrictEqual(emails().slice(1), [`Carte SIM bloquée (code PUK demandé) : tablette ${t.ref} de Mamie Jeanne`]);
  assert.match(s.boite.filter((m) => m.a === PAPOTE).at(-1).texte, /demander le code PUK|Le demander à l'opérateur/i);
  const lignes = await ligneAFaire();
  assert.strictEqual(lignes.length, 1, 'une seule ligne : le blocage remplace la panne');
  assert.match(lignes[0], /^Carte SIM bloquée .*Code PUK demandé/);
  assert.strictEqual((await s.lire(fiche)).simHorsService, undefined);
  for (let m = 180; m <= 400; m += 30) await rapport(m, bloquee('puk'));
  assert.strictEqual(emails().length, 2);
  // Débloquée mais toujours hors service : le mot de fin, puis le compte des 2 h repart de zéro.
  await rapport(430, { service: 'hors service' });
  assert.deepStrictEqual(emails().slice(2), [`Carte SIM débloquée : tablette ${t.ref} de Mamie Jeanne`]);
  assert.ok((await s.lire(fiche)).simHorsService.depuis, 'nouvelle panne comptée');
  for (let m = 460; m <= 549; m += 30) await rapport(m, { service: 'hors service' });
  assert.strictEqual(emails().length, 3, '1 h 59 après le déblocage : rien');
  await rapport(550, { service: 'hors service' });
  assert.strictEqual(emails().length, 4, '2 h après : l\'alerte « hors service »');
});

test('carte verrouillée puis retirée : alerte « verrouillée », puis ligne levée sans e-mail', async () => {
  const { rapport, emails } = await familleAvecTablette();
  await rapport(0, { bloquee: 'verrouillee', service: 'code verrouillee' });
  assert.strictEqual(emails().length, 1);
  assert.match(emails()[0], /Carte SIM bloquée \(verrouillée par l'opérateur\)/);
  await rapport(30, null);
  assert.strictEqual(emails().length, 1);
  assert.deepStrictEqual(await ligneAFaire(), []);
});
