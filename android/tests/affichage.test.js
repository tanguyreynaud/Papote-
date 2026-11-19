// Durée d'affichage d'un envoi ou d'un rappel pas encore vu (Tanguy, 19/11) : affiché, caméra allumée, pendant
// la durée réglée par la famille (options.dureeAffichage, 1 à 5 minutes, 3 sans réglage), puis fermé même sans
// visage. Un rappel pas vu revient, 3 essais en tout (à l'heure, +15 min, +30 min). Voir banc.js.
// Lancement : node --test android/tests/affichage.test.js
const test = require('node:test');
const assert = require('node:assert');
const { ouvrir, envoi, lot } = require('./banc');

async function sansErreur(b) {
  const erreurs = (await b.appels('erreurJS')).concat(await b.appels('logError'));
  assert.deepStrictEqual(erreurs, [], 'erreurs JavaScript');
}

// Caméra demandée par un envoi ou un rappel affiché seulement (etat.cameraEnvoisSeule, voir banc.js) : les 30 s
// où l'accueil regarde « elle est là » de temps en temps ne sont pas comptées ici.
const camera = (b) => b.page.evaluate(() => window.__surveillances.size);
const ouvrirSansPresence = (heure, etat = {}) => ouvrir(heure, { cameraEnvoisSeule: true, ...etat });
const visage = (b) => b.page.evaluate(() => window.__visage());
const avecDuree = (posts, minutes) => lot(posts, { options: { lecture: true, sos: true, meteo: true, rappelsAccueil: true, dureeAffichage: minutes } });
const rappel = (champs) => ({ id: 'r1', title: 'Cachet du matin', kind: 'medicament', time: '10:30', repeat: 'daily', date: '', days: [], lastAck: '', avanceMin: 0, finLe: '', enPauseJusquau: '', voice: '', ...champs });

test('envoi pas vu : affiché 3 minutes caméra allumée, puis fermé sans « vu », caméra éteinte, le suivant arrive', async () => {
  const b = await ouvrirSansPresence();
  try {
    const a = envoi({ text: 'Bisous de Lyon' });
    const c = envoi({ text: 'Et une autre' });
    await b.android('onPosts', lot([c, a]));
    await b.avancer(500);
    assert.match(await b.texte('#overlay-text'), /Bisous de Lyon/);
    // La caméra regarde pendant toute la durée, sans pause (avant : 1 minute sur 5 après les 3 premières).
    for (let s = 10; s <= 170; s += 10) {
      await b.avancer(10000);
      assert.strictEqual(await camera(b), 1, `caméra allumée à ${s} s`);
    }
    assert.match(await b.texte('#overlay-text'), /Bisous de Lyon/, 'encore affiché à 2 min 50');
    await b.avancer(11000);
    assert.match(await b.texte('#overlay-text'), /Et une autre/, 'fermé à 3 min, au suivant');
    assert.deepStrictEqual(await b.appels('markSeen'), [], 'fermé sans être « vu » : la famille voit « pas encore vu »');
    assert.ok((await b.appels('carillonStop')).length >= 1, 'le carillon ne sonne plus pour un envoi fermé');
    await b.avancer(181000);
    assert.ok(!(await b.visible('#overlay')), 'le deuxième se ferme aussi');
    assert.strictEqual(await camera(b), 0, 'caméra éteinte une fois tout fermé');
    assert.deepStrictEqual(await b.appels('markSeen'), []);
    // Android redonne les mêmes envois (nouvelle synchronisation) : ils ne reviennent pas en grand.
    await b.android('onPosts', lot([c, a]));
    await b.avancer(5000);
    assert.ok(!(await b.visible('#overlay')), 'pas de réaffichage');
    assert.strictEqual(await camera(b), 0);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('envoi fermé sans être vu, puis page rechargée (mise à jour) : il ne revient pas ; un nouvel envoi s\'affiche', async () => {
  const b = await ouvrirSansPresence();
  try {
    const a = envoi({ text: 'Bisous de Lyon' });
    await b.android('onPosts', lot([a]));
    await b.avancer(181000);
    assert.ok(!(await b.visible('#overlay')));
    await b.page.reload();
    await b.avancer(100);
    await b.android('onPosts', lot([a]));
    await b.avancer(5000);
    assert.ok(!(await b.visible('#overlay')), 'pas une deuxième fois après le rechargement');
    const c = envoi({ text: 'Tout neuf' });
    await b.android('onPosts', lot([c, a]));
    await b.avancer(1000);
    assert.match(await b.texte('#overlay-text'), /Tout neuf/, 'un nouvel envoi s\'affiche normalement');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('durée réglée par la famille : 1 minute, 5 minutes ; un réglage hors bornes revient à 3 minutes', async () => {
  for (const [reglage, attendu] of [[1, 1], [5, 5], [2, 2], [30, 3], [0, 3], ['abc', 3], [undefined, 3]]) {
    const b = await ouvrirSansPresence();
    try {
      await b.android('onPosts', avecDuree([envoi({ text: 'Coucou' })], reglage));
      await b.avancer(500);
      await b.avancer(attendu * 60000 - 5000);
      assert.ok(await b.visible('#overlay'), `réglage ${reglage} : encore affiché 5 s avant ${attendu} min`);
      assert.strictEqual(await camera(b), 1);
      await b.avancer(6000);
      assert.ok(!(await b.visible('#overlay')), `réglage ${reglage} : fermé à ${attendu} min`);
      assert.strictEqual(await camera(b), 0);
      assert.deepStrictEqual(await b.appels('markSeen'), []);
      await sansErreur(b);
    } finally { await b.fermer(); }
  }
});

test('visage vu 10 secondes avant la fin : « vu », caméra éteinte, et l\'envoi reste encore 1 minute (pas fermé à 3 min)', async () => {
  const b = await ouvrirSansPresence();
  try {
    const a = envoi({ text: 'Bisous de Lyon' });
    await b.android('onPosts', lot([a]));
    await b.avancer(170000);
    await visage(b);
    await b.avancer(1000);
    assert.deepStrictEqual((await b.appels('markSeen')).map((x) => x.args[0]), [a.id]);
    assert.strictEqual(await camera(b), 0, 'visage vu : la caméra s\'éteint tout de suite');
    await b.avancer(54000);
    assert.ok(await b.visible('#overlay'), 'encore là à 3 min 45 : 55 s après le visage');
    // La légende est lue à voix haute au visage (une dizaine de secondes ici) : 1 minute après la fin de la lecture.
    await b.avancer(30000);
    assert.ok(!(await b.visible('#overlay')), 'fermé 1 minute après le visage et la fin de la lecture');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('visage vu au début : l\'envoi reste jusqu\'à la fin de la durée réglée (3 min), pas 1 minute seulement', async () => {
  const b = await ouvrirSansPresence();
  try {
    const a = envoi({ text: 'Bisous de Lyon' });
    await b.android('onPosts', lot([a]));
    await b.avancer(10000);
    await visage(b);
    await b.avancer(1000);
    assert.strictEqual(await camera(b), 0, 'caméra éteinte dès le visage');
    await b.avancer(162000);
    assert.ok(await b.visible('#overlay'), 'encore là à 2 min 53');
    await b.avancer(10000);
    assert.ok(!(await b.visible('#overlay')), 'fermé à la fin des 3 minutes');
    assert.deepStrictEqual((await b.appels('markSeen')).map((x) => x.args[0]), [a.id]);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('vue puis OK : fermé tout de suite', async () => {
  const b = await ouvrirSansPresence();
  try {
    await b.android('onPosts', lot([envoi({ text: 'Bisous de Lyon' })]));
    await b.avancer(10000);
    await visage(b);
    await b.avancer(5000);
    await b.toucher('#overlay-close');
    await b.avancer(500);
    assert.ok(!(await b.visible('#overlay')), 'OK ferme à tout moment');
    await b.avancer(4 * 60000);
    assert.ok(!(await b.visible('#overlay')));
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('vidéo vue à la fin de la durée : jouée en entier, l\'écran se ferme 1 minute après la fin de la vidéo', async () => {
  const b = await ouvrirSansPresence();
  try {
    const v = envoi({ type: 'video', image: null, video: 'https://appassets.androidplatform.net/photos/v.mp4', text: 'Le spectacle' });
    await b.android('onPosts', lot([v]));
    await b.avancer(170000);
    await visage(b);
    await b.avancer(10000);
    assert.strictEqual((await b.appels('playVideo')).concat(await b.appels('playVideoAt')).length, 1, 'vidéo lancée au visage');
    await b.avancer(4 * 60000);
    assert.ok(await b.visible('#overlay'), 'vidéo de 4 minutes en cours : l\'écran reste, bien après les 3 minutes');
    assert.deepStrictEqual(await b.appels('stopVideo'), [], 'vidéo pas coupée');
    await b.android('onVoiceEnded'); // Android : la vidéo est finie
    await b.avancer(55000);
    assert.ok(await b.visible('#overlay'), 'encore là 55 s après la fin de la vidéo');
    await b.avancer(9000);
    assert.ok(!(await b.visible('#overlay')), 'fermé 1 minute après la fin de la vidéo');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('un toucher sur l\'écran : la durée repart de zéro (pas de fermeture sous le doigt)', async () => {
  const b = await ouvrirSansPresence();
  try {
    await b.android('onPosts', lot([envoi({ text: 'Bisous de Lyon' })]));
    await b.avancer(170000);
    await b.page.evaluate(() => document.getElementById('overlay-text').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    await b.avancer(170000);
    assert.ok(await b.visible('#overlay'), 'encore affiché 2 min 50 après le toucher');
    assert.strictEqual(await camera(b), 1);
    await b.avancer(11000);
    assert.ok(!(await b.visible('#overlay')), 'fermé 3 minutes après le toucher');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('OK avant la fin : « vu » comme avant, et rien ne se ferme plus tard à sa place', async () => {
  const b = await ouvrirSansPresence();
  try {
    const a = envoi({ text: 'Un' });
    const c = envoi({ text: 'Deux' });
    await b.android('onPosts', lot([c, a]));
    await b.avancer(60000);
    await b.toucher('#overlay-close');
    await b.avancer(500);
    assert.deepStrictEqual((await b.appels('markSeen')).map((x) => x.args[0]), [a.id]);
    assert.match(await b.texte('#overlay-text'), /Deux/);
    // Le deuxième a sa durée entière à lui (3 min depuis son affichage, pas depuis celui du premier).
    await b.avancer(170000);
    assert.match(await b.texte('#overlay-text'), /Deux/, 'le deuxième a ses 3 minutes entières');
    await b.avancer(11000);
    assert.ok(!(await b.visible('#overlay')));
    assert.strictEqual((await b.appels('markSeen')).length, 1, 'le deuxième n\'est pas « vu »');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('vidéo pas vue : jamais lancée, fermée à la fin de la durée, sans « vu »', async () => {
  const b = await ouvrirSansPresence();
  try {
    const v = envoi({ type: 'video', image: null, video: 'https://appassets.androidplatform.net/photos/v.mp4', text: 'Le spectacle' });
    await b.android('onPosts', lot([v]));
    await b.avancer(1000);
    assert.ok(await b.visible('#overlay'));
    await b.avancer(181000);
    assert.ok(!(await b.visible('#overlay')), 'fermée à 3 min');
    assert.deepStrictEqual(await b.appels('markSeen'), []);
    assert.deepStrictEqual((await b.appels('playVideo')).concat(await b.appels('playVideoAt')), [], 'pas de vidéo jouée pour personne');
    assert.strictEqual(await camera(b), 0);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('vidéo lancée au doigt juste avant la fin : pas coupée, l\'écran attend la fin de la vidéo', async () => {
  const b = await ouvrirSansPresence();
  try {
    const v = envoi({ type: 'video', image: null, video: 'https://appassets.androidplatform.net/photos/v.mp4', text: 'Le spectacle' });
    await b.android('onPosts', lot([v]));
    await b.avancer(175000);
    await b.toucher('#overlay-play');
    await b.avancer(500);
    assert.strictEqual((await b.appels('playVideo')).concat(await b.appels('playVideoAt')).length, 1, 'vidéo lancée');
    await b.avancer(10 * 60000);
    assert.ok(await b.visible('#overlay'), 'vidéo en cours : l\'écran reste');
    assert.deepStrictEqual(await b.appels('stopVideo'), [], 'vidéo pas coupée');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('sans caméra : le message compte comme lu à l\'affichage, et se ferme quand même à la fin de la durée', async () => {
  const b = await ouvrirSansPresence();
  try {
    await b.page.evaluate(() => { window.papoteWatchPresence = undefined; });
    const m = envoi({ type: 'text', image: null, text: 'Je passe dimanche' });
    await b.android('onPosts', lot([m]));
    await b.avancer(1000);
    assert.deepStrictEqual((await b.appels('markSeen')).map((x) => x.args[0]), [m.id]);
    await b.avancer(170000);
    assert.ok(await b.visible('#overlay'));
    await b.avancer(11000);
    assert.ok(!(await b.visible('#overlay')), 'fermé à 3 min, même sans caméra');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('rappel jamais vu : 3 essais (à l\'heure, +15 min, +30 min), 3 minutes et un seul son chacun, puis plus rien', async () => {
  const b = await ouvrirSansPresence('2026-10-26T10:29:00');
  try {
    await b.android('onPosts', lot([]));
    await b.android('onReminders', { reminders: [rappel()] });
    await b.avancer(30000);
    assert.ok(!(await b.visible('#reminder-alert')), 'rien avant l\'heure');
    const ouvert = [];
    let etait = false;
    let cameraPendant = true;
    // De 10 h 29 min 30 à 12 h : on note chaque minute où le rappel apparaît, de 10 s en 10 s.
    for (let s = 30; s < 91 * 60; s += 10) {
      await b.avancer(10000);
      const la = await b.visible('#reminder-alert');
      if (la && !etait) ouvert.push(Math.floor((s + 10) / 60));
      if (la && (await camera(b)) !== 1) cameraPendant = false;
      if (!la && (await camera(b)) !== 0) cameraPendant = false;
      if (la) assert.match(await b.texte('#reminder-when'), /C'est l'heure/);
      etait = la;
    }
    // Minutes depuis 10 h 29 : 10 h 30, 10 h 45, 11 h 00.
    assert.deepStrictEqual(ouvert, [1, 16, 31], `essais aux minutes ${ouvert.join(', ')}`);
    assert.ok(cameraPendant, 'caméra allumée pendant chaque essai, éteinte entre deux');
    assert.strictEqual((await b.appels('alert')).length, 3, 'un son par essai (avant : toutes les 5 minutes pendant 1 heure)');
    assert.deepStrictEqual(await b.appels('ackReminder'), [], 'jamais « fait »');
    assert.deepStrictEqual(await b.appels('seenReminder'), [], 'jamais « vu » : la famille le voit');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('rappel : chaque essai dure la durée réglée (1 minute)', async () => {
  const b = await ouvrirSansPresence('2026-10-26T10:29:30');
  try {
    await b.android('onPosts', avecDuree([], 1));
    await b.android('onReminders', { reminders: [rappel()] });
    await b.avancer(40000);
    assert.ok(await b.visible('#reminder-alert'), 'affiché à l\'heure');
    await b.avancer(45000);
    assert.ok(await b.visible('#reminder-alert'), 'encore là 55 s après');
    await b.avancer(20000);
    assert.ok(!(await b.visible('#reminder-alert')), 'fermé après 1 minute');
    assert.strictEqual(await camera(b), 0);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('rappel vu au deuxième essai : « vu » pour la famille, fermé à la fin de la durée, pas de troisième essai', async () => {
  const b = await ouvrirSansPresence('2026-10-26T10:29:30');
  try {
    await b.android('onPosts', lot([]));
    await b.android('onReminders', { reminders: [rappel()] });
    await b.avancer(16 * 60000);
    assert.ok(await b.visible('#reminder-alert'), 'deuxième essai à 10 h 45');
    await visage(b);
    await b.avancer(1000);
    const vus = await b.appels('seenReminder');
    assert.strictEqual(vus.length, 1);
    assert.strictEqual(vus[0].args[0], 'r1');
    assert.strictEqual(await camera(b), 0, 'caméra éteinte dès le visage');
    await b.avancer(100000);
    assert.ok(await b.visible('#reminder-alert'), 'encore là à 2 min 45 de l\'essai');
    await b.avancer(55000);
    assert.ok(!(await b.visible('#reminder-alert')), 'fermé à la fin des 3 minutes (10 h 48)');
    await b.avancer(60 * 60000);
    assert.ok(!(await b.visible('#reminder-alert')), 'pas de troisième essai');
    assert.strictEqual((await b.appels('alert')).length, 2);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('rappel : « C\'est fait » au premier essai : la famille est prévenue, aucun autre essai', async () => {
  const b = await ouvrirSansPresence('2026-10-26T10:29:30');
  try {
    await b.android('onPosts', lot([]));
    await b.android('onReminders', { reminders: [rappel()] });
    await b.avancer(60000);
    await b.toucher('#reminder-done');
    await b.avancer(1000);
    assert.strictEqual((await b.appels('ackReminder')).length, 1);
    await b.avancer(60 * 60000);
    assert.ok(!(await b.visible('#reminder-alert')));
    assert.strictEqual((await b.appels('alert')).length, 1);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('annonce « Dans 15 minutes » pas vue : une seule fois, fermée après 3 minutes ; puis les essais à l\'heure', async () => {
  const b = await ouvrirSansPresence('2026-10-26T10:14:30');
  try {
    await b.android('onPosts', lot([]));
    await b.android('onReminders', { reminders: [rappel({ avanceMin: 15 })] });
    await b.avancer(40000);
    assert.ok(await b.visible('#reminder-alert'), 'annonce à 10 h 15');
    assert.match(await b.texte('#reminder-when'), /Dans 15 minutes/);
    await b.avancer(3 * 60000 + 5000);
    assert.ok(!(await b.visible('#reminder-alert')), 'annonce fermée après 3 minutes');
    await b.avancer(10 * 60000);
    assert.ok(!(await b.visible('#reminder-alert')), 'l\'annonce ne revient pas');
    assert.strictEqual((await b.appels('alert')).length, 1);
    await b.avancer(2 * 60000);
    assert.ok(await b.visible('#reminder-alert'), 'à l\'heure');
    assert.match(await b.texte('#reminder-when'), /C'est l'heure/);
    await b.avancer(60 * 60000);
    assert.strictEqual((await b.appels('alert')).length, 4, 'annonce + 3 essais');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('rappel pas vu puis page rechargée entre deux essais : le compte des essais est gardé (3 en tout)', async () => {
  const b = await ouvrirSansPresence('2026-10-26T10:29:30');
  const donnees = { reminders: [rappel()] };
  try {
    await b.android('onPosts', lot([]));
    await b.android('onReminders', donnees);
    await b.avancer(5 * 60000);
    assert.ok(!(await b.visible('#reminder-alert')), 'premier essai fini');
    await b.page.reload();
    await b.avancer(100);
    await b.android('onPosts', lot([]));
    await b.android('onReminders', donnees);
    await b.avancer(5 * 60000);
    assert.ok(!(await b.visible('#reminder-alert')), 'pas de nouvel essai juste après le rechargement (10 h 40)');
    await b.avancer(6 * 60000);
    assert.ok(await b.visible('#reminder-alert'), 'deuxième essai à 10 h 45');
    await b.avancer(60 * 60000);
    // Le compteur de sons repart de zéro avec la page : 2 essais après le rechargement, 3 en tout.
    assert.strictEqual((await b.appels('alert')).length, 2, 'deux essais après le rechargement');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('rappel coupé par un appel : il revient après l\'appel sans compter un essai de plus', async () => {
  const b = await ouvrirSansPresence('2026-10-26T10:29:30');
  try {
    await b.android('onPosts', lot([]));
    await b.android('onReminders', { reminders: [rappel()] });
    await b.avancer(60000);
    assert.ok(await b.visible('#reminder-alert'));
    await b.page.evaluate(() => { document.getElementById('call-ring').hidden = false; });
    await b.avancer(65000);
    assert.ok(!(await b.visible('#reminder-alert')), 'caché pendant l\'appel');
    assert.strictEqual(await camera(b), 0, 'la caméra est laissée à l\'appel');
    await b.page.evaluate(() => { document.getElementById('call-ring').hidden = true; });
    await b.avancer(35000);
    assert.ok(await b.visible('#reminder-alert'), 'revenu après l\'appel');
    await b.avancer(2 * 60000);
    assert.ok(await b.visible('#reminder-alert'), 'pour une durée entière (2 min 30 après l\'appel)');
    await b.avancer(60000);
    assert.ok(!(await b.visible('#reminder-alert')), 'puis fermé');
    await b.avancer(90 * 60000);
    const essais = await b.page.evaluate(() => JSON.parse(localStorage.getItem('papote.rappelsEssais')));
    assert.strictEqual(Object.values(essais)[0].n, 3, '3 essais comptés, la reprise après l\'appel n\'en est pas un');
    await sansErreur(b);
  } finally { await b.fermer(); }
});
