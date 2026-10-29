// Essais des écrans de la tablette, sans tablette (voir banc.js).
// Lancement : node --test android/tests/   (Playwright et Chromium nécessaires)
const test = require('node:test');
const assert = require('node:assert');
const { ouvrir, envoi, lot } = require('./banc');

// Chaque essai vérifie aussi qu'aucune erreur JavaScript n'est passée.
async function sansErreur(b) {
  const erreurs = (await b.appels('erreurJS')).concat(await b.appels('logError'));
  assert.deepStrictEqual(erreurs, [], 'erreurs JavaScript');
}

// La page reçoit les envois du plus récent au plus ancien (Sync.publishPosts).
const recentsDabord = (liste) => liste.slice().sort((a, c) => c.createdAt - a.createdAt);

test('file des envois : 5 au plus, du plus ancien au plus récent, OK passe au suivant', async () => {
  const b = await ouvrir();
  try {
    const envois = [];
    for (let i = 0; i < 7; i++) envois.push(envoi({ text: `Photo ${i + 1}` }));
    await b.android('onPosts', lot(recentsDabord(envois)));
    await b.avancer(500);
    // Les 2 plus anciennes ne s'affichent pas en grand (elles restent dans le diaporama).
    assert.match(await b.texte('#overlay-text'), /Photo 3/);
    for (let i = 3; i <= 7; i++) {
      assert.ok(await b.visible('#overlay'), `photo ${i} affichée`);
      assert.match(await b.texte('#overlay-text'), new RegExp(`Photo ${i}`));
      await b.toucher('#overlay-close');
      await b.avancer(300);
    }
    assert.ok(!(await b.visible('#overlay')), 'plus rien à montrer');
    const vus = (await b.appels('markSeen')).map((a) => a.args[0]);
    assert.deepStrictEqual(vus, envois.slice(2).map((e) => e.id));
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('visage vu : « vu », lecture dans la voix du proche, puis fermeture 2 minutes après', async () => {
  const b = await ouvrir();
  try {
    const a = envoi({ text: 'Bisous de Lyon', voice: 'https://appassets.androidplatform.net/photos/a_voix.mp3', announce: 'https://appassets.androidplatform.net/photos/a_annonce.mp3' });
    const c = envoi({ text: 'Et une autre' });
    await b.android('onPosts', lot(recentsDabord([a, c])));
    await b.avancer(500);
    assert.deepStrictEqual(await b.appels('markSeen'), [], 'pas « vu » avant que Mamie regarde');
    await b.page.evaluate(() => window.__visage());
    await b.avancer(1000);
    assert.deepStrictEqual((await b.appels('markSeen')).map((x) => x.args[0]), [a.id]);
    assert.ok((await b.appels('seen')).length >= 1, 'présence notée pour la famille');
    const sons = (await b.appels('audio')).map((x) => x.args[0]);
    assert.deepStrictEqual(sons, [a.announce, a.voice], 'annonce « Julie vous écrit » puis le message');
    assert.deepStrictEqual(await b.appels('speak'), [], 'pas la voix de secours');
    await b.avancer(114000);
    assert.match(await b.texte('#overlay-text'), /Bisous de Lyon/, 'encore affiché avant 2 min');
    await b.avancer(6000);
    assert.match(await b.texte('#overlay-text'), /Et une autre/, 'fermé tout seul, au suivant');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('photo toute neuve : la lecture attend la voix du serveur au lieu de la voix de secours', async () => {
  const b = await ouvrir();
  try {
    const maintenant = await b.page.evaluate(() => Date.now());
    const p = envoi({ text: 'Regarde le chat', createdAt: maintenant - 5000 });
    await b.android('onPosts', lot([p]));
    await b.avancer(300);
    await b.page.evaluate(() => window.__visage());
    await b.avancer(3000);
    assert.deepStrictEqual(await b.appels('audio'), [], 'rien lu tant que la voix n\'est pas là');
    await b.android('onPosts', lot([{ ...p, voice: 'https://appassets.androidplatform.net/photos/p_voix.mp3' }]));
    await b.avancer(1000);
    assert.deepStrictEqual((await b.appels('audio')).map((x) => x.args[0]), ['https://appassets.androidplatform.net/photos/p_voix.mp3']);
    assert.deepStrictEqual(await b.appels('speak'), []);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('la nuit, un envoi attend : ni caméra, ni lecture, ni « vu » ; un toucher le montre', async () => {
  const b = await ouvrir('2026-10-26T23:30:00');
  try {
    await b.avancer(1500);
    assert.deepStrictEqual((await b.appels('setSleep')).map((x) => x.args[0]), [true], 'écran en veille');
    await b.android('onPosts', lot([envoi({ text: 'Bonne nuit' })]));
    await b.avancer(1500);
    assert.strictEqual(await b.page.evaluate(() => window.__surveillances.size), 0, 'caméra éteinte la nuit');
    await b.page.evaluate(() => window.__visage());
    await b.avancer(1000);
    assert.deepStrictEqual(await b.appels('markSeen'), []);
    assert.deepStrictEqual(await b.appels('audio'), []);
    // Mamie touche l'écran : il se rallume et l'envoi s'affiche.
    await b.page.evaluate(() => {
      const voile = [...document.body.children].find((e) => e.style.zIndex === '1000');
      voile.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
    });
    await b.avancer(2500);
    assert.ok(await b.visible('#overlay'), 'affiché après le toucher');
    assert.match(await b.texte('#overlay-text'), /Bonne nuit/);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('rappel : annonce 15 minutes avant, puis « C\'est l\'heure », « C\'est fait » prévient la famille', async () => {
  const b = await ouvrir('2026-10-26T10:10:00');
  try {
    await b.android('onPosts', lot([]));
    await b.android('onReminders', { reminders: [{ id: 'r1', title: 'Cachet du matin', kind: 'medicament', time: '10:30', repeat: 'daily', date: '', days: [], lastAck: '', avanceMin: 15, finLe: '', enPauseJusquau: '', voice: '' }] });
    await b.avancer(1000);
    assert.ok(!(await b.visible('#reminder-alert')), 'rien à 10h10');
    await b.avancer(5 * 60000);
    assert.ok(await b.visible('#reminder-alert'), 'annonce à 10h15');
    assert.match(await b.texte('#reminder-when'), /Dans 15 minutes/);
    await b.toucher('#reminder-done');
    await b.avancer(1000);
    assert.ok(!(await b.visible('#reminder-alert')));
    assert.deepStrictEqual(await b.appels('ackReminder'), [], 'l\'annonce n\'est pas « fait »');
    await b.avancer(15 * 60000);
    assert.ok(await b.visible('#reminder-alert'), 'à l\'heure');
    assert.match(await b.texte('#reminder-when'), /C'est l'heure/);
    await b.toucher('#reminder-done');
    await b.avancer(1000);
    const acks = await b.appels('ackReminder');
    assert.strictEqual(acks.length, 1);
    assert.strictEqual(acks[0].args[0], 'r1');
    assert.match(acks[0].args[1], /^2026-10-26 10:3\d$/);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('rappel pendant un appel : il attend la fin de l\'appel', async () => {
  const b = await ouvrir('2026-10-26T10:29:30');
  try {
    await b.android('onPosts', lot([]));
    await b.page.evaluate(() => { document.getElementById('call-ring').hidden = false; });
    await b.android('onReminders', { reminders: [{ id: 'r2', title: 'Kiné', kind: 'rdv', time: '10:30', repeat: 'daily', date: '', days: [], lastAck: '', avanceMin: 0, finLe: '', enPauseJusquau: '', voice: '' }] });
    await b.avancer(2 * 60000);
    assert.ok(!(await b.visible('#reminder-alert')), 'pas par-dessus l\'appel');
    await b.page.evaluate(() => { document.getElementById('call-ring').hidden = true; });
    await b.avancer(65000);
    assert.ok(await b.visible('#reminder-alert'), 'affiché après l\'appel');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('appel entrant pendant une photo : elle revient après l\'appel, sans être comptée comme vue', async () => {
  const b = await ouvrir();
  try {
    await b.android('onPosts', lot([envoi({ text: 'Au parc' })]));
    await b.avancer(500);
    await b.page.evaluate(() => { window.Papote.closeOverlayForCall(); document.getElementById('call-ring').hidden = false; });
    await b.avancer(3000);
    assert.ok(!(await b.visible('#overlay')));
    await b.page.evaluate(() => { document.getElementById('call-ring').hidden = true; });
    await b.avancer(3000);
    assert.ok(await b.visible('#overlay'));
    assert.match(await b.texte('#overlay-text'), /Au parc/);
    assert.deepStrictEqual(await b.appels('markSeen'), []);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('abonnement en pause : écran « Papote est en pause », aucun envoi affiché', async () => {
  const b = await ouvrir();
  try {
    await b.android('onPosts', lot([envoi()], { subscription: 'suspendu' }));
    await b.avancer(1000);
    assert.ok(await b.visible('.pause-screen'));
    assert.ok(!(await b.visible('#overlay')));
    await b.android('onPosts', lot([envoi({ id: 'apres' })], { subscription: 'actif' }));
    await b.avancer(1000);
    assert.ok(!(await b.visible('.pause-screen')));
    assert.ok(await b.visible('#overlay'));
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS : décompte de 5 s, deux essais, puis « La famille est prévenue »', async () => {
  const b = await ouvrir();
  try {
    await b.page.evaluate(() => {
      window.__sos = [];
      window.papoteCallFamily = (o) => { window.__sos.push(o); return { hangup() {} }; };
    });
    await b.android('onPosts', lot([]));
    assert.ok(await b.visible('#sos-btn'), 'bouton SOS (option activée)');
    await b.toucher('#sos-btn');
    assert.match(await b.texte('.call-out'), /L’appel part dans 5 secondes/);
    await b.avancer(5200);
    assert.deepStrictEqual(await b.page.evaluate(() => window.__sos.map((o) => o.sos)), [1]);
    await b.page.evaluate(() => window.__sos[0].onState('missed'));
    assert.deepStrictEqual(await b.page.evaluate(() => window.__sos.map((o) => o.sos)), [1, 2], 'deuxième essai');
    await b.page.evaluate(() => window.__sos[1].onState('missed'));
    assert.match(await b.texte('.call-out'), /La famille est prévenue/);
    await b.avancer(9000);
    assert.ok(!(await b.visible('.call-out')), 'retour à l\'accueil');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS : « Annuler » arrête tout, et sans l\'option il n\'y a pas de bouton', async () => {
  const b = await ouvrir();
  try {
    await b.page.evaluate(() => { window.__sos = []; window.papoteCallFamily = (o) => { window.__sos.push(o); return { hangup() {} }; }; });
    await b.android('onPosts', lot([]));
    await b.toucher('#sos-btn');
    await b.avancer(2000);
    await b.toucher('.sos-cancel');
    await b.avancer(6000);
    assert.deepStrictEqual(await b.page.evaluate(() => window.__sos.length), 0);
    await b.android('onPosts', lot([], { options: { lecture: true, sos: false } }));
    assert.ok(!(await b.visible('#sos-btn')));
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('radio : bouton seulement sur le Wi-Fi ; elle s\'arrête si la tablette passe sur la carte SIM', async () => {
  const b = await ouvrir();
  try {
    // Le flux n'existe pas pendant les essais : un lecteur audio imité, qui note s'il a été arrêté.
    await b.page.evaluate(() => {
      window.Audio = function (src) { this.src = src; this.paused = false; window.__radio = this; };
      window.Audio.prototype.play = function () { return Promise.resolve(); };
      window.Audio.prototype.pause = function () { this.paused = true; };
    });
    const radio = { lecture: true, sos: false, radio: { nom: 'France Bleu', url: 'https://radio.exemple/flux.mp3' } };
    await b.android('onPosts', lot([], { options: radio }));
    assert.ok(await b.visible('.radio-btn'));
    // Lancée sur le Wi-Fi, puis le Wi-Fi tombe et la carte SIM prend le relais : radio coupée, bouton caché.
    await b.toucher('.radio-btn');
    assert.ok(/Arrêter/.test(await b.texte('.radio-btn')));
    await b.etat({ reseau: { wifi: '', internet: true, mobile: true, sim: true, via: 'mobile' } });
    await b.avancer(31000);
    assert.ok(!(await b.visible('.radio-btn')));
    assert.ok(await b.page.evaluate(() => window.__radio && window.__radio.paused));
    // Le Wi-Fi revient : le bouton aussi, à l'arrêt.
    await b.etat({ reseau: { wifi: 'Box', internet: true, mobile: true, sim: true, via: 'wifi' } });
    await b.avancer(31000);
    assert.ok(await b.visible('.radio-btn'));
    assert.ok(/Radio/.test(await b.texte('.radio-btn')));
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('anniversaire : en grand une fois, puis le bandeau de l\'accueil', async () => {
  const b = await ouvrir();
  try {
    await b.android('onPosts', lot([]));
    await b.android('onFamily', { faces: {}, people: [], birthdays: [{ id: 'b1', name: 'Léa', day: 26, month: 10, year: 2016 }] });
    await b.avancer(500);
    assert.ok(await b.visible('#bday-alert'));
    assert.match(await b.texte('#bday-text'), /anniversaire de Léa/);
    assert.match(await b.texte('#bday-age'), /10 ans/);
    await b.toucher('#bday-ok');
    await b.avancer(31000);
    assert.ok(!(await b.visible('#bday-alert')), 'pas deux fois');
    assert.ok(await b.visible('#bday-banner'));
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('plus d\'internet depuis une minute : la carte « Pas d\'internet » remplace la photo', async () => {
  const b = await ouvrir();
  try {
    await b.android('onPosts', lot([]));
    await b.etat({ reseau: { wifi: '', internet: false, mobile: false, sim: false } });
    await b.avancer(100000);
    assert.ok(await b.visible('.wifi-card'));
    await b.etat({ reseau: { wifi: 'Box', internet: true, mobile: false, sim: false } });
    await b.avancer(31000);
    assert.ok(!(await b.visible('.wifi-card')));
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('démarrage sans internet : l\'écran du wifi s\'ouvre, puis se ferme seul quand internet revient', async () => {
  const b = await ouvrir('2026-10-26T10:00:00', { reseau: { wifi: '', internet: false, mobile: false, sim: false } });
  try {
    await b.avancer(21000);
    assert.ok(await b.visible('.welcome'), 'écran du wifi ouvert');
    await b.etat({ reseau: { wifi: 'Box', internet: true, mobile: false, sim: false } });
    await b.avancer(31000);
    assert.ok(!(await b.visible('.welcome')), 'refermé : la box est revenue');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('tablette débranchée depuis une minute : bandeau « rebranchez son chargeur »', async () => {
  const b = await ouvrir('2026-10-26T10:00:00', { secteur: false });
  try {
    await b.android('onPosts', lot([]));
    await b.avancer(80000);
    assert.ok(await b.visible('.power-banner'));
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('diaporama : la photo de l\'accueil l\'ouvre, défilement toutes les 10 s, retour seul à l\'accueil', async () => {
  const b = await ouvrir();
  try {
    const vues = [envoi({ seen: true, text: 'Un' }), envoi({ seen: true, text: 'Deux' }), envoi({ seen: true, text: 'Trois' })];
    await b.android('onPosts', lot(recentsDabord(vues)));
    await b.avancer(500);
    await b.toucher('#home-frame');
    assert.ok(await b.visible('#view-photos'));
    const avant = await b.texte('#photo-text');
    await b.avancer(10500);
    assert.notStrictEqual(await b.texte('#photo-text'), avant, 'photo suivante');
    await b.avancer(5 * 60000);
    assert.ok(await b.visible('#view-home'), 'retour à l\'accueil');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('appels indisponibles au démarrage (pas d\'internet) : la page se recharge une fois quand internet revient', async () => {
  const b = await ouvrir('2026-10-26T10:00:00', { appelsKo: true, reseau: { wifi: 'Box', internet: false, mobile: false, sim: false } });
  try {
    await b.avancer(5000);
    await b.page.evaluate(() => { window.__marque = 1; });
    await b.etat({ reseau: { wifi: 'Box', internet: true, mobile: false, sim: false } });
    const rechargement = b.page.waitForEvent('load');
    await b.avancer(40000).catch(() => {}); // la page se recharge pendant l'attente
    await rechargement;
    await b.avancer(500);
    assert.strictEqual(await b.page.evaluate(() => window.__marque), undefined, 'page rechargée');
    // Toujours impossible après le rechargement (ici, internet reste bloqué) : pas de rechargements en boucle.
    await b.avancer(2000);
    await b.page.evaluate(() => { window.__marque = 2; });
    await b.etat({ reseau: { wifi: 'Box', internet: true, mobile: false, sim: false } });
    await b.avancer(5 * 60000);
    assert.strictEqual(await b.page.evaluate(() => window.__marque), 2, 'pas de nouveau rechargement avant 30 min');
  } finally { await b.fermer(); }
});

test('rappel fermé puis page rechargée : il ne revient pas (le lastAck n\'est pas encore relu)', async () => {
  const b = await ouvrir('2026-10-26T10:30:00');
  const rappel = { reminders: [{ id: 'r9', title: 'Cachet', kind: 'medicament', time: '10:20', repeat: 'daily', date: '', days: [], lastAck: '', avanceMin: 0, finLe: '', enPauseJusquau: '', voice: '' }] };
  try {
    await b.android('onPosts', lot([]));
    await b.android('onReminders', rappel);
    await b.avancer(31000);
    assert.ok(await b.visible('#reminder-alert'));
    await b.toucher('#reminder-done');
    await b.avancer(1000);
    await b.page.reload();
    await b.avancer(100);
    await b.android('onPosts', lot([]));
    await b.android('onReminders', rappel); // Android renvoie les rappels connus, sans le « fait » pas encore relu
    await b.avancer(31000);
    assert.ok(!(await b.visible('#reminder-alert')), 'pas une deuxième fois');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('carillon d\'un nouvel envoi : pas par-dessus une fenêtre ouverte, normal sur l\'accueil, « Appeler » et le diaporama', async () => {
  const b = await ouvrir('2026-10-26T10:10:00');
  try {
    const fenetre = async () => { await b.avancer(1100); return b.page.evaluate(() => window.__fenetre); };
    await b.android('onPosts', lot([envoi({ seen: true, text: 'Vue' })]));
    assert.strictEqual(await fenetre(), false, 'accueil');
    // Deux nouvelles photos : la première s'affiche, Android est prévenu qu'une fenêtre est ouverte.
    const deux = [envoi({ text: 'Photo 1' }), envoi({ text: 'Photo 2' })];
    await b.android('onPosts', lot(recentsDabord(deux)));
    await b.avancer(500);
    assert.ok(await b.visible('#overlay'));
    assert.strictEqual(await fenetre(), true, 'nouvel envoi affiché');
    await b.toucher('#overlay-close');
    await b.avancer(300);
    assert.strictEqual(await fenetre(), true, 'la photo suivante prend la place');
    await b.toucher('#overlay-close');
    assert.strictEqual(await fenetre(), false, 'retour à l\'accueil');
    // Rappel à l'heure : fenêtre ouverte.
    await b.android('onReminders', { reminders: [{ id: 'r1', title: 'Cachet', kind: 'medicament', time: '10:20', repeat: 'daily', date: '', days: [], lastAck: '', avanceMin: 0, finLe: '', enPauseJusquau: '', voice: '' }] });
    await b.avancer(15 * 60000);
    assert.ok(await b.visible('#reminder-alert'));
    assert.strictEqual(await fenetre(), true, 'rappel');
    await b.toucher('#reminder-done');
    assert.strictEqual(await fenetre(), false, 'rappel fermé');
    // « Appeler » (choix de la personne) : lié à l'accueil, le carillon reste normal.
    await b.android('onFamily', { faces: {}, birthdays: [], people: [{ uid: 'julie', name: 'Julie' }] });
    await b.toucher('#view-home .call-btn');
    assert.match(await b.texte('.call-out'), /Qui voulez-vous appeler/);
    assert.strictEqual(await fenetre(), false, '« Appeler »');
    await b.toucher('.call-back');
    // SOS (décompte) : fenêtre ouverte ; « Annuler » : accueil.
    await b.page.evaluate(() => { window.papoteCallFamily = () => ({ hangup() {} }); });
    await b.toucher('#sos-btn');
    assert.strictEqual(await fenetre(), true, 'SOS');
    await b.toucher('.sos-cancel');
    assert.strictEqual(await fenetre(), false, 'SOS annulé');
    await b.toucher('#home-frame');
    assert.ok(await b.visible('#view-photos'));
    assert.strictEqual(await fenetre(), false, 'diaporama');
    await sansErreur(b);
  } finally { await b.fermer(); }
});
