// Écrans de l'app famille (web/) sur un téléphone : Firebase est remplacé par faux-firebase.js,
// une base en mémoire remplie ici avec une fausse famille. Rien ne part sur internet.
'use strict';

const fs = require('fs');
const path = require('path');
const { fausseImage, fauxVisage } = require('./commun');

const TAILLES = [{ nom: 'telephone', width: 390, height: 844 }];
const JOUR = '2026-10-26';
const ms = (hm, jour = JOUR) => ({ __ms: new Date(`${jour}T${hm}:00+01:00`).getTime() });
const ilYa = (jours, hm = '10:00') => ms(hm, new Date(new Date(`${JOUR}T12:00:00Z`).getTime() - jours * 86400000).toISOString().slice(0, 10));

const FID = 'famille-test';
const MOI = { uid: 'u-julie', email: 'julie@exemple.fr', displayName: 'Julie Martin' };
const NOMBREUX = ['Lucas', 'Emma', 'Hugo', 'Léa', 'Nathan', 'Chloé', 'Louis', 'Manon', 'Gabriel', 'Camille', 'Jules', 'Inès', 'Arthur', 'Zoé', 'Paul', 'Jade', 'Marius'];

// Petites images (les vraies vignettes sont en JPEG, ici en SVG).
const petite = (n, portrait) => fausseImage(n, portrait ? 300 : 400, portrait ? 400 : 300);
const visage = (nom, n) => fauxVisage(nom, n);

function membre(uid, name, extra = {}) {
  return { uid, name, role: 'famille', status: 'active', email: `${name.toLowerCase()}@exemple.fr`, code: '', joinedAt: ilYa(20), ...extra };
}

/** Une famille bien remplie, vue par Julie (propriétaire). Les options changent une partie. */
function famillePleine(o = {}) {
  const docs = {};
  docs['config/base'] = { database: '(default)' };
  docs[`families/${FID}`] = {
    name: 'Mamie Jeanne', code: 'ABCD2345', createdBy: o.proprietaire === false ? 'u-thomas' : MOI.uid, createdAt: ilYa(30),
    admins: [], rev: 12,
    abonnement: o.abonnement === undefined ? { statut: 'actif', formule: 'wifi', tablette: 'pretee', depuis: ilYa(25), finPeriode: ilYa(-5), stripeCustomerId: 'cus_faux', stripeSubscriptionId: 'sub_faux' } : o.abonnement,
    options: { lecture: true, sos: true, meteo: true, rappelsAccueil: true, radio: null },
    veille: { active: true, de: 23, a: 7 }, meteo: { nom: 'Saint-Martin-de-Valamas', lat: 44.93, lon: 4.37 },
    volume: 80, faceTablette: visage('Jeanne', 4),
    ...(o.installation ? { installation: o.installation } : {}),
    ...(o.famille || {}),
  };
  const membres = [
    membre(MOI.uid, 'Julie', { email: MOI.email, face: visage('Julie', 0), genre: 'femme' }),
    membre('u-thomas', 'Thomas', { face: visage('Thomas', 1), genre: 'homme' }),
    membre('u-anne', 'Anne', { face: visage('Anne', 2), genre: 'femme' }),
    ...(o.sansTablette ? [] : [membre('u-tablette', 'Tablette', {
      role: 'tablette', email: '', lastOnline: o.tabletteHorsLigne ? ilYa(1, '08:00') : ms('10:28'), lastActive: ms('10:10'),
      appVersion: '2.99.65', battery: { level: 82, charging: !o.debranchee, unpluggedAt: o.debranchee ? ms('09:40') : null, at: ms('10:28') },
      wifi: { ssid: 'Livebox-6A2F' }, canCall: true,
    })]),
    ...(o.enAttente ? [membre('u-lucas', 'Lucas', { status: 'pending', joinedAt: ms('10:12') })] : []),
    // Famille nombreuse : 17 proches de plus, sans photo (initiales), pour voir les longues listes.
    ...(o.nombreux ? NOMBREUX.map((nom, i) => membre(`u-${nom.toLowerCase()}`, nom, { joinedAt: ilYa(19 - i) })) : []),
  ];
  // Un proche « mis en tête » par le propriétaire : proposé d'abord dans « Qui appeler » sur la tablette.
  if (o.enTete) membres[2].enTete = ilYa(2);
  for (const m of membres) docs[`families/${FID}/members/${m.uid}`] = m;
  if (!o.vide) {
    const auteurs = [['u-julie', 'Julie'], ['u-thomas', 'Thomas'], ['u-anne', 'Anne']];
    for (let i = 0; i < 9; i++) {
      const [uid, nom] = auteurs[i % 3];
      docs[`families/${FID}/posts/photo${i}`] = {
        type: 'photo', text: ['Les vacances à la mer', '', 'Le gâteau de Léo'][i % 3], authorUid: uid, authorName: nom,
        createdAt: ilYa(i, '09:30'), seenAt: i ? ilYa(i, '11:00') : null, hearts: i % 2, image: null, hasMedia: true,
        thumb: petite(i, i % 3 === 1),
      };
    }
    docs[`families/${FID}/posts/video0`] = {
      type: 'video', text: 'Léo fait du vélo', authorUid: 'u-thomas', authorName: 'Thomas', createdAt: ilYa(2, '18:00'),
      seenAt: ilYa(2, '19:00'), hearts: 1, thumb: petite(3), hasMedia: true, duration: 24, chunks: 1, mime: 'video/webm',
    };
    const messages = [
      ['u-thomas', 'Thomas', 'message', 'Bonjour Mamie ! On arrive dimanche vers midi.', ilYa(1, '08:40')],
      ['u-tablette', 'Mamie Jeanne', 'reply', 'Merci, je vous attends !', ilYa(1, '09:15')],
      [MOI.uid, 'Julie', 'message', 'Coucou Mamie, on pense fort à toi !', ms('10:05')],
    ];
    messages.forEach(([uid, nom, type, text, at], i) => {
      docs[`families/${FID}/posts/msg${i}`] = { type, text, authorUid: uid, authorName: nom, createdAt: at, seenAt: type === 'reply' ? null : at, hearts: 0, image: null };
    });
    docs[`families/${FID}/reminders/r1`] = { kind: 'medicament', title: 'Prendre le cachet du midi', time: '12:00', repeat: 'daily', days: [], avanceMin: 15, createdBy: MOI.uid, createdAt: ilYa(10) };
    docs[`families/${FID}/reminders/r2`] = { kind: 'rdv', title: 'Docteur Martin', time: '15:30', repeat: 'none', date: '2026-10-28', avanceMin: 60, createdBy: 'u-thomas', createdAt: ilYa(3) };
    docs[`families/${FID}/birthdays/b1`] = { name: 'Léo', day: 2, month: 11, year: 2019, createdBy: MOI.uid };
  }
  Object.assign(docs, o.docs || {});
  return docs;
}

// Ce que l'app garde sur le téléphone après la première connexion (prénom, genre, visage…).
const TELEPHONE_CONNU = {
  'papote.fid': FID, 'papote.prenom': 'Julie', 'papote.genre': 'femme', 'papote.visage': visage('Julie', 0),
  'papote.anniversaire': JSON.stringify({ day: 14, month: 3, year: 1988 }), 'papote.guideVu': '1',
};

function connecte(o = {}) {
  return { user: MOI, docs: famillePleine(o), local: { ...TELEPHONE_CONNU, ...(o.local || {}) }, fonctions: o.fonctions };
}

// ---------- Les scènes ----------

// Petits gestes : toucher un bouton, une tuile, un onglet, puis laisser l'écran se poser.
const pause = (p, ms = 700) => p.waitForTimeout(ms);
const toucher = (...sels) => async (p) => { for (const sel of sels) { await p.locator(sel).first().click(); await pause(p); } };
const page = (nom) => `.tile[data-page="${nom}"]`;
const onglet = (nom) => `.nav-item[data-tab="${nom}"]`;
// Cloche des notifications en haut de l'accueil (ou l'ancien onglet, selon la version de l'app).
const cloche = '#btn-bell, .nav-item[data-tab="notifs"]';
const modifier = (carte) => `#${carte} .setting-modify`;
const RESA = { status: 'reserved', claimedBy: MOI.uid, claimedName: 'Julie', createdAt: ms('10:20') };
const sansFamille = (docs = {}) => ({ user: MOI, docs: { 'config/base': {}, ...docs }, local: { ...TELEPHONE_CONNU, 'papote.fid': '' } });
// Installation : on part de « Comment l'appelez-vous ? » ; le faux serveur crée la famille, arrêtée à l'étape voulue.
const installation = (etape) => {
  const d = sansFamille({ 'pairings/K7PM2Q': RESA });
  const docs = famillePleine({ installation: { etape, pairing: 'K7PM2Q' }, abonnement: { statut: 'installation' }, vide: true, sansTablette: etape === 'photo' });
  delete docs['config/base'];
  d.fonctions = { nommerFamille: { __ecrire: docs, __si: 'code', resultat: { fid: FID } } };
  return d;
};
const nommer = async (p) => { await p.fill('#setup-nom-input', 'Mamie Jeanne'); await p.click('#setup-nom button[type="submit"]'); await pause(p, 1500); };
const appelEntrant = (o = {}) => connecte({ ...o, docs: { [`families/${FID}/calls/c1`]: { callerUid: 'u-tablette', callerName: 'Mamie Jeanne', state: 'ringing', createdAt: ms('10:30'), endedAt: null } } });
const abo = (abonnement, o = {}) => connecte({ abonnement, ...o });

// plein : capture de toute la page (qui défile) ; sinon seulement l'écran du téléphone.
const SCENES = [
  { groupe: 'Connexion', titre: 'Chargement', donnees: () => ({ user: null }), avant: true },
  { groupe: 'Connexion', titre: 'Se connecter', donnees: () => ({ user: null }) },
  { groupe: 'Connexion', titre: 'Lien de connexion envoyé', donnees: () => ({ user: null }), faire: async (p) => {
    await p.fill('input[type="email"]', 'julie@exemple.fr'); await toucher('#btn-email')(p);
  } },
  { groupe: 'Connexion', titre: 'Vos informations (premier lancement)', plein: true, donnees: () => ({ user: MOI, docs: famillePleine(), local: { 'papote.fid': FID } }) },
  { groupe: 'Connexion', titre: 'Rejoindre ou installer', plein: true, donnees: () => sansFamille() },
  { groupe: 'Connexion', titre: 'Invitation reçue par e-mail', plein: true, donnees: () => sansFamille({
    [`families/${FID}`]: { name: 'Mamie Jeanne', createdBy: 'u-thomas' },
    [`families/${FID}/invitations/julie@exemple.fr`]: { email: MOI.email, fid: FID, familyName: 'Mamie Jeanne', invitedBy: 'Thomas', createdAt: ilYa(1) },
  }) },
  { groupe: 'Connexion', titre: 'En attente d’acceptation', plein: true, donnees: () => sansFamille({
    [`families/${FID}`]: { name: 'Mamie Jeanne', createdBy: 'u-thomas' },
    [`families/${FID}/members/${MOI.uid}`]: membre(MOI.uid, 'Julie', { email: MOI.email, status: 'pending' }),
  }) },

  { groupe: 'Installation de la tablette', titre: 'Scanner le code de la tablette', plein: true, donnees: () => sansFamille(), faire: toucher('#btn-join-pair') },
  { groupe: 'Installation de la tablette', titre: 'Nom de la personne', plein: true, donnees: () => sansFamille({ 'pairings/K7PM2Q': RESA }) },
  { groupe: 'Installation de la tablette', titre: 'Photo pour la tablette', plein: true, donnees: () => installation('photo'), faire: nommer },
  { groupe: 'Installation de la tablette', titre: 'Réglage du son', plein: true, donnees: () => installation('son'), faire: nommer },
  { groupe: 'Installation de la tablette', titre: 'Options', plein: true, donnees: () => installation('options'), faire: nommer },
  { groupe: 'Installation de la tablette', titre: 'Annuler l’installation ?', donnees: () => installation('photo'), faire: async (p) => { await nommer(p); await toucher('#setup-cancel')(p); } },

  { groupe: 'Accueil', titre: 'Accueil', plein: true, donnees: () => connecte() },
  { groupe: 'Accueil', titre: 'Accueil en thème sombre', plein: true, donnees: () => connecte({ local: { 'papote.theme': 'dark' } }) },
  { groupe: 'Accueil', titre: 'Famille toute neuve (rien envoyé)', plein: true, donnees: () => connecte({ vide: true }) },
  { groupe: 'Accueil', titre: 'Quelqu’un demande à rejoindre', plein: true, donnees: () => connecte({ enAttente: true }) },
  { groupe: 'Accueil', titre: 'Tablette débranchée', plein: true, donnees: () => connecte({ debranchee: true }) },
  { groupe: 'Accueil', titre: 'Tablette hors ligne', plein: true, donnees: () => connecte({ tabletteHorsLigne: true }) },
  { groupe: 'Accueil', titre: 'Accueil d’un proche (pas propriétaire)', plein: true, donnees: () => connecte({ proprietaire: false }) },
  { groupe: 'Accueil', titre: 'Plusieurs familles', plein: true, donnees: () => connecte({ docs: {
    'families/autre': { name: 'Papi Henri', createdBy: 'u-thomas', abonnement: { statut: 'actif' } },
    [`families/autre/members/${MOI.uid}`]: membre(MOI.uid, 'Julie', { email: MOI.email }),
  } }) },
  { groupe: 'Accueil', titre: 'Paiement en retard', plein: true, donnees: () => abo({ statut: 'impaye', formule: 'wifi', graceJusqua: ilYa(-6) }) },
  { groupe: 'Accueil', titre: 'Paiement en retard, sans date de grâce', plein: true, note: 'Cas limite : le bandeau doit rester une phrase complète sans la date.', donnees: () => abo({ statut: 'impaye', formule: 'wifi' }) },
  { groupe: 'Accueil', titre: 'Sans abonnement', plein: true, donnees: () => abo({ statut: 'aucun' }) },
  { groupe: 'Accueil', titre: 'Sans abonnement : prendre un abonnement', plein: true, donnees: () => abo({ statut: 'aucun' }), faire: toucher('#sans-abo-prendre') },
  { groupe: 'Accueil', titre: 'Pas d’internet', donnees: () => connecte(), faire: async (p) => {
    await p.context().setOffline(true); await p.evaluate(() => window.dispatchEvent(new Event('offline'))); await pause(p, 1500);
  } },

  { groupe: 'Photos et vidéos', titre: 'Photos', plein: true, donnees: () => connecte(), faire: toucher(page('photos')) },
  { groupe: 'Photos et vidéos', titre: 'Photos : aucune', plein: true, donnees: () => connecte({ vide: true }), faire: toucher(page('photos')) },
  { groupe: 'Photos et vidéos', titre: 'Photo ouverte en grand', donnees: () => connecte(), faire: toucher(page('photos'), '.shot-frame') },
  { groupe: 'Photos et vidéos', titre: 'Supprimer une photo ?', donnees: () => connecte(), faire: toucher(page('photos'), '.shot-frame', '#viewer-delete') },
  { groupe: 'Photos et vidéos', titre: 'Envoyer une photo', donnees: () => connecte(), faire: toucher(page('photos'), '#view-photos .fab') },
  { groupe: 'Photos et vidéos', titre: 'Envoyer une photo : photos choisies', donnees: () => connecte(), faire: async (p) => {
    await toucher(page('photos'), '#view-photos .fab')(p);
    await p.setInputFiles('#in-photo-gallery', [path.join(__dirname, 'sortie', 'exemple-1.png'), path.join(__dirname, 'sortie', 'exemple-2.png')]);
    await pause(p, 2000);
  } },
  { groupe: 'Photos et vidéos', titre: 'Vidéos', plein: true, donnees: () => connecte(), faire: toucher(page('videos')) },
  { groupe: 'Photos et vidéos', titre: 'Envoyer une vidéo', donnees: () => connecte(), faire: toucher(page('videos'), '#view-videos .fab') },

  { groupe: 'Messages et agenda', titre: 'Messages', donnees: () => connecte(), faire: toucher(page('messages')) },
  { groupe: 'Messages et agenda', titre: 'Messages : aucun', donnees: () => connecte({ vide: true }), faire: toucher(page('messages')) },
  { groupe: 'Messages et agenda', titre: 'Agenda', plein: true, donnees: () => connecte(), faire: toucher(page('agenda')) },
  { groupe: 'Messages et agenda', titre: 'Agenda : aucun rappel', plein: true, donnees: () => connecte({ vide: true }), faire: toucher(page('agenda')) },
  { groupe: 'Messages et agenda', titre: 'Nouveau rappel', donnees: () => connecte(), faire: toucher(page('agenda'), '#add-reminder') },
  { groupe: 'Messages et agenda', titre: 'Nouvel anniversaire', donnees: () => connecte(), faire: toucher(page('agenda'), '#add-reminder', '#agenda-seg [data-seg="birthday"]') },

  { groupe: 'Appels', titre: 'Appeler ? (confirmation)', donnees: () => connecte(), faire: toucher('#tile-call') },
  { groupe: 'Appels', titre: 'Appel vidéo : ça sonne', donnees: () => connecte(), faire: async (p) => {
    await toucher('#tile-call')(p); await p.locator('.dialog button.primary, dialog button.primary').first().click(); await pause(p, 2500);
  } },
  { groupe: 'Appels', titre: 'Mamie appelle', donnees: () => appelEntrant() },

  { groupe: 'Réglages', titre: 'Réglages (propriétaire)', plein: true, donnees: () => connecte(), faire: toucher(page('settings')) },
  { groupe: 'Réglages', titre: 'Réglages : famille de 20 proches', plein: true, donnees: () => connecte({ nombreux: true }), faire: toucher(page('settings')) },
  { groupe: 'Réglages', titre: 'Réglages : un proche mis en tête', plein: true, donnees: () => connecte({ enTete: true }), faire: toucher(page('settings')) },
  { groupe: 'Réglages', titre: 'Réglages (proche)', plein: true, donnees: () => connecte({ proprietaire: false }), faire: toucher(page('settings')) },
  { groupe: 'Réglages', titre: 'Menu d’un membre (⋮)', donnees: () => connecte(), faire: toucher(page('settings'), '#view-settings .member-more') },
  { groupe: 'Réglages', titre: 'Modifier : nom de la tablette', donnees: () => connecte(), faire: toucher(page('settings'), modifier('family-name-card')) },
  { groupe: 'Réglages', titre: 'Modifier : ville de la météo', donnees: () => connecte(), faire: toucher(page('settings'), modifier('meteo-card')) },
  { groupe: 'Réglages', titre: 'Modifier : options de la tablette', plein: true, donnees: () => connecte(), faire: toucher(page('settings'), modifier('options-card')) },
  { groupe: 'Réglages', titre: 'Modifier : volume', donnees: () => connecte(), faire: toucher(page('settings'), modifier('volume-card')) },
  { groupe: 'Réglages', titre: 'Modifier : veille la nuit', donnees: () => connecte(), faire: toucher(page('settings'), modifier('sleep-card')) },
  { groupe: 'Réglages', titre: 'Wifi de la tablette', donnees: () => connecte(), faire: toucher(page('settings'), '#wifi-modify') },
  { groupe: 'Réglages', titre: 'Inviter un proche', plein: true, donnees: () => connecte(), faire: toucher('#btn-invite') },

  { groupe: 'Profil', titre: 'Profil : abonnement actif', plein: true, donnees: () => connecte(), faire: toucher(onglet('profile')) },
  { groupe: 'Profil', titre: 'Profil : commande offerte', plein: true, donnees: () => abo({ statut: 'offert' }), faire: toucher(onglet('profile')) },
  { groupe: 'Profil', titre: 'Profil : paiement en retard', plein: true, donnees: () => abo({ statut: 'impaye', formule: 'wifi', graceJusqua: ilYa(-6) }), faire: toucher(onglet('profile')) },
  { groupe: 'Profil', titre: 'Profil : en pause', plein: true, donnees: () => abo({ statut: 'suspendu', formule: 'wifi' }), faire: toucher(onglet('profile')) },
  { groupe: 'Profil', titre: 'Profil : résilié', plein: true, donnees: () => abo({ statut: 'resilie', formule: 'wifi', finLe: ilYa(-20) }), faire: toucher(onglet('profile')) },
  { groupe: 'Profil', titre: 'Profil d’un proche', plein: true, donnees: () => connecte({ proprietaire: false }), faire: toucher(onglet('profile')) },
  { groupe: 'Profil', titre: 'Résilier : avant de partir', donnees: () => connecte(), faire: toucher(onglet('profile'), '#btn-resilier') },
  // Depuis la barre du bas Accueil / Photos / Messages / Profil (27/10) : la cloche est en haut, le support dans le Profil.
  { groupe: 'Profil', titre: 'Notifications', plein: true, donnees: () => connecte(), faire: toucher(cloche) },
  { groupe: 'Profil', titre: 'Notifications : aucune', plein: true, donnees: () => connecte({ vide: true }), faire: toucher(cloche) },
  { groupe: 'Profil', titre: 'Support', plein: true, donnees: () => connecte(), faire: toucher(onglet('profile'), '.aide-card, ' + onglet('support')) },
];

const SDK = fs.readFileSync(path.join(__dirname, 'faux-firebase.js'), 'utf8');

function poserDonnees(d) {
  try {
    localStorage.clear();
    for (const [k, v] of Object.entries(d.local || {})) if (v) localStorage.setItem(k, v);
  } catch (e) { /* rien */ }
  window.__donnees = d;
}

async function capturer({ browser, base, dossierImages, progression }) {
  // Deux « photos de la galerie du téléphone » pour l'écran d'envoi.
  const p0 = await browser.newPage();
  for (const [i, portrait] of [[1, false], [2, true]]) {
    await p0.setViewportSize(portrait ? { width: 600, height: 800 } : { width: 800, height: 600 });
    await p0.setContent(`<body style="margin:0"><img src="${fausseImage(i, portrait ? 600 : 800, portrait ? 800 : 600)}">`);
    await p0.screenshot({ path: path.join(dossierImages, '..', `exemple-${i}.png`) });
  }
  await p0.close();
  const travaux = [];
  let n = 0;
  for (const scene of SCENES) for (const taille of TAILLES) travaux.push({ scene, taille, n: ++n });
  const n0 = travaux.length;
  const resultats = [];
  let faits = 0;
  async function ouvrier() {
    for (let job = travaux.shift(); job; job = travaux.shift()) {
      const { scene, taille, n } = job;
      const ctx = await browser.newContext({
        viewport: { width: taille.width, height: taille.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
        locale: 'fr-FR', timezoneId: 'Europe/Paris', serviceWorkers: 'block', permissions: ['camera', 'microphone'],
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
      });
      const page = await ctx.newPage();
      const erreurs = [];
      page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
      await page.clock.install({ time: new Date(`${JOUR}T${scene.heure || '10:30'}:00+01:00`) });
      await page.addInitScript(poserDonnees, scene.donnees());
      // Tous les modules Firebase deviennent le faux SDK (une seule copie, partagée).
      await page.route('https://www.gstatic.com/firebasejs/**', (r) => r.fulfill({
        contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' },
        body: r.request().url().endsWith('/faux-sdk.js') ? SDK : "export * from 'https://www.gstatic.com/firebasejs/faux-sdk.js';",
      }));
      // Polices Google : gardées pour que les écrans aient leur vraie police. Le reste d'internet est coupé.
      await page.route(/^https?:\/\/(?!127\.0\.0\.1|fonts\.googleapis\.com|fonts\.gstatic\.com|www\.gstatic\.com\/firebasejs)/, (r) => r.abort());
      if (scene.avant) {
        await page.goto(`${base}/index.html`, { waitUntil: 'commit' });
        await page.waitForTimeout(50);
      } else {
        await page.goto(`${base}/index.html`);
        await page.waitForTimeout(1500);
        try {
          if (scene.faire) await scene.faire(page);
        } catch (e) {
          erreurs.push('Scène : ' + e.message.split('\n')[0]);
        }
      }
      const fichier = `famille-${String(n).padStart(3, '0')}.jpg`;
      // Page qui défile : le téléphone est « agrandi » à toute la hauteur (4 écrans au plus),
      // pour que la barre du bas reste en bas.
      if (scene.plein) {
        const h = await page.evaluate(() => document.documentElement.scrollHeight);
        if (h > taille.height) { await page.setViewportSize({ width: taille.width, height: Math.min(h, taille.height * 4) }); await pause(page, 400); }
      }
      await page.screenshot({ path: `${dossierImages}/${fichier}`, type: 'jpeg', quality: 62 });
      resultats.push({ n, groupe: scene.groupe, titre: scene.titre, note: scene.note, taille: taille.nom, fichier, erreurs, scene: SCENES.indexOf(scene) });
      await ctx.close();
      progression(`app famille ${++faits}/${n0}`);
    }
  }
  await Promise.all([ouvrier(), ouvrier(), ouvrier(), ouvrier()]);
  return resultats.sort((a, b) => a.n - b.n);
}

module.exports = { capturer, SCENES };
