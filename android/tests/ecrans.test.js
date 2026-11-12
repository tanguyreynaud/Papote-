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
    // Sans réglages de la famille, la veille par défaut attend 10 s (les heures de la famille arrivent
    // en général avant : pas d'écran noir pour rien au démarrage).
    await b.avancer(1500);
    assert.deepStrictEqual(await b.appels('setSleep'), [], 'pas de veille avant les réglages de la famille');
    await b.avancer(10000);
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

test('tablette verrouillée : le SOS de l\'écran verrouillé lance le décompte, « Annuler » rend l\'écran verrouillé', async () => {
  const b = await ouvrir();
  try {
    await b.android('onPosts', lot([envoi({ seen: true })], { perdue: true }));
    await b.avancer(1000);
    assert.ok(await b.visible('.perdue-sos'), 'bouton SOS sur l\'écran verrouillé');
    await b.toucher('.perdue-sos');
    await b.avancer(500);
    assert.ok(await b.visible('.sos-countdown'), 'décompte du SOS');
    assert.ok(!(await b.visible('.perdue-screen')), 'écran verrouillé écarté pendant le SOS');
    assert.strictEqual(await b.page.evaluate(() => window.papoteSosEnCours), true);
    await b.toucher('.sos-cancel');
    await b.avancer(500);
    assert.ok(await b.visible('.perdue-screen'), 'écran verrouillé revenu');
    assert.notStrictEqual(await b.page.evaluate(() => window.papoteSosEnCours), true);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('tablette verrouillée à distance (perdue) : écran « verrouillée », aucun toucher ne passe, pas d\'appel ; déverrouillage', async () => {
  const b = await ouvrir();
  try {
    await b.android('onPosts', lot([envoi()], { perdue: true }));
    await b.avancer(1000);
    assert.ok(await b.visible('.perdue-screen'));
    assert.match(await b.texte('.perdue-screen'), /Cette tablette est verrouillée[\s\S]*contact@mapapote.fr/);
    assert.ok(!(await b.visible('#overlay')), 'aucun envoi affiché');
    assert.strictEqual(await b.page.evaluate(() => window.papotePaused), true, 'les appels ne sonnent pas');
    // Le toucher atterrit sur l'écran de verrouillage, jamais sur ce qu'il y a dessous.
    const dessous = await b.page.evaluate(() => document.elementFromPoint(640, 400).closest('.perdue-screen') !== null);
    assert.ok(dessous, 'tout l\'écran est couvert');
    // Un vrai doigt sur le bouton SOS (sous l'écran de verrouillage) : rien ne part.
    const sos = await b.page.locator('#sos-btn').boundingBox();
    await b.page.mouse.click(sos.x + sos.width / 2, sos.y + sos.height / 2);
    await b.avancer(6000);
    assert.ok(!(await b.visible('.call-out')), 'le SOS ne part pas');
    // Déverrouillage : tout revient.
    await b.android('onPosts', lot([envoi({ id: 'apres' })], { perdue: false }));
    await b.avancer(1000);
    assert.ok(!(await b.visible('.perdue-screen')));
    assert.strictEqual(await b.page.evaluate(() => window.papotePaused), false);
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
    // Audit promesses (05/11) : rien ne garantit un rappel, on ne le promet pas à Mamie.
    assert.doesNotMatch(await b.texte('.call-out'), /va vous rappeler/);
    await b.avancer(9000);
    assert.ok(!(await b.visible('.call-out')), 'retour à l\'accueil');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS, « La famille est prévenue » avec deux visages : côte à côte sur toute la hauteur (pas de quart vide)', async () => {
  const b = await ouvrir();
  try {
    const PIX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    await b.page.evaluate(() => {
      window.__sos = [];
      window.papoteCallFamily = (o) => { window.__sos.push(o); return { hangup() {} }; };
    });
    await b.android('onPosts', lot([]));
    await b.android('onFamily', { faces: { julie: PIX, paul: PIX }, birthdays: [], people: [{ uid: 'julie', name: 'Julie' }, { uid: 'paul', name: 'Paul' }] });
    await b.toucher('#sos-btn');
    await b.avancer(5200);
    await b.page.evaluate(() => window.__sos[0].onState('missed'));
    await b.page.evaluate(() => window.__sos[1].onState('missed'));
    assert.match(await b.texte('.call-out'), /La famille est prévenue/);
    const boites = await b.page.evaluate(() => [...document.querySelectorAll('.call-out .sos-face')].map((e) => e.getBoundingClientRect().height));
    const cadre = await b.page.evaluate(() => document.querySelector('.call-out .call-face.faces').clientHeight); // sans le cadre indigo
    assert.strictEqual(boites.length, 2);
    assert.ok(boites.every((h) => Math.abs(h - cadre) < 2), `deux visages pleine hauteur : ${boites.join(', ')} / ${cadre}`);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

// Seul Papote relie une tablette (décision de Tanguy, 12/11) : en attendant sa famille, la tablette ne demande
// ni de scanner ni de taper un code, et ne lit rien à voix haute.
test('attente de la famille : « On prépare votre tablette… », rien à scanner, aucun code, aucune voix', async () => {
  const b = await ouvrir();
  try {
    for (const statut of [
      { step: 'pair', code: 'ABCDEFGH' }, // code de jumelage écrit sur le serveur (interne)
      { step: 'pair', code: 'ABCDEFGH', claimedName: 'Julie', restart: true }, // ancien état : même écran
      { step: 'prepare', etape: 'son' }, // famille rejointe, réglages pas finis
    ]) {
      await b.vider();
      await b.android('onStatus', { state: 'welcome', ...statut });
      await b.avancer(500);
      assert.ok(await b.visible('.welcome'), `${statut.step} : écran d'attente`);
      const t = await b.texte('.welcome');
      assert.match(t, /On prépare votre tablette…/);
      assert.match(t, /La tablette retrouve sa famille/);
      assert.doesNotMatch(t, /scann|QR|code|app\.mapapote|téléphone|Recommencer|ABCD/i, `${statut.step} : rien à faire pour la famille`);
      assert.strictEqual(await b.page.locator('.welcome img:not(.welcome-logo)').count(), 0, 'aucun QR code');
      const voix = (await b.appels()).filter((a) => ['audio', 'speak', 'speakGuide'].includes(a.nom));
      assert.deepStrictEqual(voix, [], 'rien de lu à voix haute');
      await b.page.evaluate(() => window.PapoteBienvenue.hide());
    }
    // Pas encore d'internet pour écrire le code : on le dit doucement, avec le wifi à portée de main.
    await b.android('onStatus', { state: 'welcome', step: 'pair', sansInternet: true });
    await b.avancer(500);
    const t = await b.texte('.welcome');
    assert.match(t, /On prépare votre tablette…/);
    assert.match(t, /attend internet/);
    assert.doesNotMatch(t, /scann|code|Impossible/i);
    await b.page.getByText('Choisir un wifi').click();
    assert.deepStrictEqual((await b.appels('welcomeBack')).map((a) => a.args[0]), [false]);
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('accueil sans photo : à droite le QR code de la famille (app.mapapote.fr/?code=…) pour qu\'un proche la rejoigne', async () => {
  const b = await ouvrir();
  try {
    await b.page.evaluate(() => {
      const qr = window.PapoteAndroid.qrCode;
      window.PapoteAndroid.qrCode = (url) => { window.__qr = url; return qr(url); };
    });
    await b.android('onPosts', lot([]));
    await b.avancer(500);
    assert.ok(await b.visible('#frame-empty .invite-qr'), 'QR code affiché');
    assert.strictEqual(await b.page.evaluate(() => window.__qr), 'https://app.mapapote.fr/?code=ABCD2345', 'lien d\'invitation de la famille');
    assert.match(await b.texte('#frame-empty'), /rejoindre la famille/);
    // Le panneau de droite de l'accueil.
    const droite = await b.page.evaluate(() => {
      const r = document.querySelector('#frame-empty .invite-qr').getBoundingClientRect();
      return r.left + r.width / 2 > window.innerWidth / 2;
    });
    assert.ok(droite, 'à droite de l\'écran');
    // Une photo arrive : le QR code laisse sa place.
    await b.android('onPosts', lot([envoi({ seen: true })]));
    await b.avancer(2000);
    assert.ok(!(await b.visible('#frame-empty')), 'plus de QR code avec une photo');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('SOS : pas de bouton tant qu\'aucun proche n\'est dans la famille, il apparaît dès qu\'un proche arrive', async () => {
  const b = await ouvrir();
  try {
    await b.android('onPosts', lot([]));
    // La famille n'a encore personne (seule la tablette, et une demande en attente, que Sync.java ne donne pas).
    await b.android('onFamily', { faces: {}, birthdays: [], people: [] });
    await b.avancer(500);
    assert.ok(!(await b.visible('#sos-btn')), 'pas de SOS sans proche');
    // Même pendant une pause de l'abonnement.
    await b.android('onPosts', lot([], { subscription: 'suspendu' }));
    await b.avancer(500);
    assert.ok(!(await b.visible('.pause-sos')), 'pas de SOS sur l\'écran de pause sans proche');
    await b.android('onPosts', lot([]));
    await b.avancer(500);
    // Julie entre dans l'appli.
    await b.android('onFamily', { faces: {}, birthdays: [], people: [{ uid: 'julie', name: 'Julie' }] });
    await b.avancer(500);
    assert.ok(await b.visible('#sos-btn'), 'SOS dès le premier proche');
    // Sans l'option de la famille, toujours pas de bouton, même avec des proches.
    await b.android('onPosts', lot([], { options: { lecture: true, sos: false } }));
    assert.ok(!(await b.visible('#sos-btn')));
    // Le dernier proche quitte la famille : le bouton repart.
    await b.android('onPosts', lot([]));
    assert.ok(await b.visible('#sos-btn'));
    await b.android('onFamily', { faces: {}, birthdays: [], people: [] });
    assert.ok(!(await b.visible('#sos-btn')), 'plus de proche : plus de SOS');
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
    assert.ok(await b.visible('.net-banner'));
    await b.etat({ reseau: { wifi: 'Box', internet: true, mobile: false, sim: false } });
    await b.avancer(4000);
    assert.ok(!(await b.visible('.net-banner')), 'disparue en quelques secondes au retour du réseau');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('démarrage sans internet avec des envois : la carte « Pas d\'internet » vient en moins de 20 s', async () => {
  const b = await ouvrir('2026-10-26T10:00:00', { reseau: { wifi: '', internet: false, mobile: false, sim: true } });
  try {
    await b.android('onPosts', lot([envoi({ seen: true })]));
    await b.avancer(17000);
    assert.ok(await b.visible('.net-banner'), 'carte affichée sans attendre une minute');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('redémarrage sans aucun réseau (heure inconnue) : une seule carte calme à gauche, les photos à droite', async () => {
  const b = await ouvrir('2025-04-11T10:00:00', { reseau: { wifi: '', internet: false, mobile: false, sim: true } });
  try {
    await b.android('onPosts', lot([envoi({ seen: true })]));
    await b.avancer(6000);
    assert.ok(await b.visible('.sans-reseau'), 'carte « Pas de réseau »');
    assert.ok(!(await b.visible('.home-time')), 'pas d\'heure');
    assert.ok(await b.visible('#frame-img'), 'la photo reste');
    await b.etat({ reseau: { wifi: 'Box', internet: true, mobile: false, sim: true } });
    await b.avancer(4000);
    assert.ok(!(await b.visible('.sans-reseau')), 'repartie au retour du réseau');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('horloge pas encore à l\'heure (date d\'usine) : jamais « il y a -568 jours »', async () => {
  const b = await ouvrir('2025-04-11T10:00:00');
  try {
    await b.android('onPosts', lot([envoi({ seen: true, createdAt: Date.parse('2026-10-31T09:00:00+01:00') })]));
    await b.avancer(2000);
    const legende = await b.texte('#frame-caption');
    assert.ok(!/-\d/.test(legende), 'pas de durée négative : ' + legende);
    assert.match(legende, /Julie/);
    // Ni heure ni date fausses à l'accueil tant que l'horloge n'est pas à l'heure.
    assert.strictEqual((await b.texte('#clock')).trim(), '');
    assert.match(await b.texte('#date'), /attend le réseau/);
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

const affichee = (b) => b.page.evaluate(() => document.querySelector('#overlay-img').getAttribute('data-url') || document.querySelector('#overlay-img').getAttribute('src'));

test('envoi de 3 photos : elles passent l\'une après l\'autre en grand, toutes les 10 s, en boucle', async () => {
  const b = await ouvrir();
  try {
    const e = envoi({ text: 'Trois photos' });
    e.images = [`${e.image}?2`, `${e.image}?3`];
    await b.android('onPosts', lot([e]));
    await b.avancer(500);
    const vues = [await affichee(b)];
    assert.strictEqual(await b.texte('#overlay-close'), 'Suivante', 'des photos restent à voir');
    await b.avancer(6000);
    assert.strictEqual(await affichee(b), e.image, 'pas avant 10 s (6 s, c\'était trop vite)');
    await b.avancer(4000); vues.push(await affichee(b));
    await b.avancer(10000); vues.push(await affichee(b));
    assert.strictEqual(await b.texte('#overlay-close'), 'OK', 'toutes vues : OK');
    await b.avancer(10000); vues.push(await affichee(b));
    assert.deepStrictEqual(vues, [e.image, e.images[0], e.images[1], e.image], 'les 3 photos, en boucle');
    await b.toucher('#overlay-close');
    await b.avancer(6500);
    assert.ok(!(await b.visible('#overlay')), 'OK ferme');
    // Diaporama : chaque photo garde la légende du proche (pas « Photo 1 sur 3 »).
    await b.toucher('#home-frame');
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(await b.texte('#photo-text'), 'Trois photos');
      await b.toucher('#photo-next');
    }
    await sansErreur(b);
  } finally { await b.fermer(); }
});

// Tanguy (11/11) : OK touché sur la 1re photo fermait tout, les 2 autres jamais vues.
test('envoi de 3 photos : « Suivante » montre la suivante, double toucher compris ; OK ne ferme qu\'une fois toutes vues', async () => {
  const b = await ouvrir();
  try {
    const e = envoi({ text: 'Trois photos' });
    e.images = [`${e.image}?2`, `${e.image}?3`];
    await b.android('onPosts', lot([e]));
    await b.avancer(500);
    // Double toucher tout de suite : une seule photo passée, pas deux.
    await b.page.evaluate(() => { const o = document.querySelector('#overlay-close'); o.click(); o.click(); });
    await b.avancer(300);
    assert.strictEqual(await affichee(b), e.images[0], '2e photo, pas la 3e');
    assert.ok(await b.visible('#overlay'), 'pas fermé');
    // Le défilement repart de zéro après « Suivante » : 9 s plus tard, toujours la 2e.
    await b.avancer(9000);
    assert.strictEqual(await affichee(b), e.images[0]);
    await b.toucher('#overlay-close');
    await b.avancer(300);
    assert.strictEqual(await affichee(b), e.images[1], '3e photo');
    assert.strictEqual(await b.texte('#overlay-close'), 'OK');
    assert.ok(await b.visible('#overlay'), 'toujours ouvert sur la dernière');
    assert.deepStrictEqual((await b.appels('markSeen')).map((a) => a.args[0]).filter((id) => id === e.id), [], 'pas compté vu avant OK… sauf par la caméra');
    // Double toucher sur la dernière « Suivante » : le second toucher ne ferme pas aussitôt.
    await b.avancer(1200);
    await b.toucher('#overlay-close');
    await b.avancer(6500);
    assert.ok(!(await b.visible('#overlay')), 'OK ferme une fois toutes vues');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

// Audit « mauvais jours » (5/11) : Mamie ne lit jamais un mot d'argent ou de problème à régler, et après un arrêt
// (déménagement, fin voulue) l'écran ne promet pas que « tout reviendra ». Le bouton SOS reste sur l'écran (F-a).
test('pause : jamais « réglé » sous les yeux de Mamie ; après un arrêt, pas de « tout reviendra » ; SOS présent', async () => {
  const b = await ouvrir();
  try {
    for (const statut of ['suspendu', 'resilie', 'aucun']) {
      await b.android('onPosts', lot([], { subscription: statut }));
      await b.avancer(500);
      assert.ok(await b.visible('.pause-screen'), statut);
      const texte = await b.texte('.pause-screen .pause-box p:not(.pause-sos)');
      const tout = await b.texte('.pause-screen');
      assert.doesNotMatch(tout, /régl|paiement|abonnement|pay/i, `${statut} : « ${tout} »`);
      if (statut === 'resilie') assert.doesNotMatch(tout, /reviendr/i, `résilié : « ${tout} »`);
      assert.ok(texte.length > 0);
      assert.ok(await b.visible('.pause-sos'), `${statut} : bouton SOS`);
    }
    await sansErreur(b);
  } finally { await b.fermer(); }
});

// Emojis (Tanguy, 07/11) : affichés en entier dans le message (famille ZWJ comprise), rien de coupé ni caché.
test('message avec emojis 👍❤️🎉👨‍👩‍👧 : affiché en entier, sans caractère coupé', async () => {
  const b = await ouvrir();
  try {
    const texte = 'Bravo Mamie 👍❤️🎉 toute la famille 👨‍👩‍👧';
    await b.android('onPosts', lot([envoi({ type: 'message', image: null, text: texte })]));
    await b.avancer(3000);
    assert.ok(await b.visible('#overlay'), 'message affiché');
    const affiche = await b.page.evaluate(() => document.getElementById('overlay-text').textContent);
    assert.ok(affiche.includes('👍❤️🎉'), `emojis présents : « ${affiche} »`);
    assert.ok(affiche.includes('👨‍👩‍👧'), `famille entière (pas coupée au liant) : « ${affiche} »`);
    assert.doesNotMatch(affiche, /�|…/, 'ni caractère de remplacement ni texte coupé');
    // Rien ne déborde du cadre du message (pas de texte caché).
    const deborde = await b.page.evaluate(() => { const e = document.getElementById('overlay-text'); return e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1; });
    assert.ok(!deborde, 'le message tient dans son cadre');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

// M0 (audit premier jour 05/11, mise en route 12/11) : sans box, la carte SIM trouve internet 30 s à 2 min
// après « Commencer ». Décision de Tanguy (12/11) : d'abord « Je cherche internet… », puis, si rien ne vient,
// l'erreur dite clairement et le wifi à donner.
test('installation sans box : « Je cherche internet… », puis la carte SIM arrive et l\'écran passe tout seul', async () => {
  // Démarrage à froid : la 4G n'est pas encore là quand on touche « Commencer ».
  const b = await ouvrir('2026-10-26T10:00:00', { reseau: { wifi: '', internet: false, mobile: false, sim: true } });
  try {
    await b.android('onStatus', { state: 'welcome', step: 'wifi' });
    await b.avancer(500);
    assert.ok(await b.visible('.welcome'), 'écran affiché');
    assert.match(await b.texte('.welcome-title'), /Je cherche internet…/);
    assert.doesNotMatch(await b.texte('.welcome'), /Choisissez le wifi|pas trouvé/, 'pas encore d\'erreur');
    assert.deepStrictEqual(await b.appels('wifiDone'), [], 'pas encore d\'internet : on attend');
    await b.avancer(40000);
    assert.match(await b.texte('.welcome-title'), /Je cherche internet…/, 'toujours en recherche après 40 s');
    await b.etat({ reseau: { wifi: '', internet: true, mobile: true, sim: true, via: 'mobile' } });
    await b.avancer(3500);
    assert.strictEqual((await b.appels('wifiDone')).length, 1, 'la 4G est là : étape suivante sans rien toucher');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('installation sans internet : au bout de 90 s, l\'erreur claire et le wifi à donner ; la 4G arrivée plus tard passe quand même', async () => {
  const b = await ouvrir('2026-10-26T10:00:00', { reseau: { wifi: '', internet: false, mobile: false, sim: true } });
  try {
    await b.android('onStatus', { state: 'welcome', step: 'wifi' });
    await b.avancer(500);
    assert.match(await b.texte('.welcome-title'), /Je cherche internet…/);
    await b.avancer(91000);
    assert.match(await b.texte('.welcome-error'), /La tablette n’a pas trouvé internet/);
    assert.match(await b.texte('.welcome'), /Choisissez le wifi de votre box/);
    assert.ok(await b.page.getByText('Choisir un réseau').isVisible(), 'le wifi peut être donné');
    // Le proche ouvre la liste des réseaux : la 4G qui arrive ne la ferme pas sous ses doigts.
    await b.page.getByText('Choisir un réseau').click();
    await b.etat({ reseau: { wifi: '', internet: true, mobile: true, sim: true, via: 'mobile' } });
    await b.avancer(6500);
    assert.deepStrictEqual(await b.appels('wifiDone'), [], 'liste ouverte : on ne passe pas');
    await b.page.getByText('Fermer').click();
    await b.avancer(3500);
    assert.strictEqual((await b.appels('wifiDone')).length, 1, 'liste fermée, 4G là : étape suivante');
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('installation avec une box qui répond pendant la recherche : « Connectée à … » et Continuer', async () => {
  const b = await ouvrir('2026-10-26T10:00:00', { reseau: { wifi: '', internet: false, mobile: false, sim: true } });
  try {
    await b.android('onStatus', { state: 'welcome', step: 'wifi' });
    await b.avancer(500);
    await b.etat({ reseau: { wifi: 'Livebox', internet: true, mobile: false, sim: true, via: 'wifi' } });
    await b.avancer(3500);
    assert.match(await b.texte('.welcome'), /Connectée à « Livebox »/);
    assert.ok(await b.page.getByText('Continuer').isVisible());
    await sansErreur(b);
  } finally { await b.fermer(); }
});

test('installation sans carte SIM ni internet : le choix du wifi tout de suite', async () => {
  const b = await ouvrir('2026-10-26T10:00:00', { reseau: { wifi: '', internet: false, mobile: false, sim: false } });
  try {
    await b.android('onStatus', { state: 'welcome', step: 'wifi' });
    await b.avancer(500);
    assert.match(await b.texte('.welcome-title'), /Connexion à internet/);
    assert.match(await b.texte('.welcome'), /Choisissez le wifi de votre box/);
    await sansErreur(b);
  } finally { await b.fermer(); }
});
