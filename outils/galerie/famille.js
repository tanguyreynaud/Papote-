// Écrans de l'app famille (web/) sur un téléphone : Firebase est remplacé par faux-firebase.js,
// une base en mémoire remplie ici avec une fausse famille. Rien ne part sur internet.
'use strict';

const fs = require('fs');
const path = require('path');
const { fausseImage, fauxVisage, fauxQr, fausseVideo } = require('./commun');

const TAILLES = [{ nom: 'telephone', width: 390, height: 844 }];
const JOUR = '2026-10-26';
const ms = (hm, jour = JOUR) => ({ __ms: new Date(`${jour}T${hm}:00+01:00`).getTime() });
const ilYa = (jours, hm = '10:00') => ms(hm, new Date(new Date(`${JOUR}T12:00:00Z`).getTime() - jours * 86400000).toISOString().slice(0, 10));

const FID = 'famille-test';
const MOI = { uid: 'u-julie', email: 'julie@exemple.fr', displayName: 'Julie Martin' };
const TELS = { Julie: '0612345678', Thomas: '0687654321', Anne: '0756781234' };
const NOMBREUX = ['Lucas', 'Emma', 'Hugo', 'Léa', 'Nathan', 'Chloé', 'Louis', 'Manon', 'Gabriel', 'Camille', 'Jules', 'Inès', 'Arthur', 'Zoé', 'Paul', 'Jade', 'Marius'];

// Petites images (les vraies vignettes sont en JPEG, ici en SVG).
const petite = (n, portrait) => fausseImage(n, portrait ? 300 : 400, portrait ? 400 : 300);
const visage = (nom, n) => fauxVisage(nom, n);

function membre(uid, name, extra = {}) {
  // Numéro de téléphone obligatoire depuis le 29/10 (appels de la tablette par la carte SIM).
  return { uid, name, role: 'famille', status: 'active', email: `${name.toLowerCase()}@exemple.fr`, code: '', joinedAt: ilYa(20), telephone: TELS[name] || '0611223344', ...extra };
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
    veille: o.veille || { active: true, de: 21, a: 6, aMin: 30 }, meteoVille: { nom: 'Saint-Martin-de-Valamas', lat: 44.93, lon: 4.37 },
    volume: 80, faceTablette: visage('Jeanne', 4),
    ...(o.installation ? { installation: o.installation } : {}),
    ...(o.famille || {}),
  };
  const membres = [
    membre(MOI.uid, 'Julie', { email: MOI.email, face: visage('Julie', 0), genre: 'femme' }),
    membre('u-thomas', 'Thomas', { face: visage('Thomas', 1), genre: 'homme' }),
    membre('u-anne', 'Anne', { face: visage('Anne', 2), genre: 'femme' }),
    ...(o.sansTablette ? [] : [membre('u-tablette', 'Tablette', {
      role: 'tablette', email: '', telephone: o.sim ? '07 45 12 34 56' : '',
      lastOnline: o.tabletteHorsLigne ? ilYa(1, '08:00') : ms('10:28'), lastActive: o.inactive ? ilYa(1, '18:00') : ms('10:10'),
      appVersion: '2.99.92', battery: { level: o.batterie ?? 82, charging: !o.debranchee && o.batterie == null, unpluggedAt: o.debranchee ? ms('09:40') : null, at: ms('10:28') },
      // Tablette sur la carte SIM : pas de Wi-Fi, forfait de 1 Go (o.forfait = pourcentage utilisé, paliers 70/88/95).
      wifi: o.sim ? null : { ssid: 'Livebox-6A2F' }, canCall: true,
      ...(o.sim ? { sim: { numero: '07 45 12 34 56', operateur: 'Lycamobile', plafondMo: 1000, dataCycleMo: (o.forfait || 12) * 10, cycleDebut: '2026-10-05',
        niveau: o.forfait >= 95 ? 3 : o.forfait >= 88 ? 2 : o.forfait >= 70 ? 1 : 0 } } : {}),
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
    docs[`families/${FID}/reminders/r1`] = { kind: 'medicament', title: 'Prendre le cachet du midi', time: '12:00', repeat: 'daily', days: [], avanceMin: 15, createdBy: 'Julie', createdAt: ilYa(10) };
    docs[`families/${FID}/reminders/r2`] = { kind: 'rdv', title: 'Docteur Martin', time: '15:30', repeat: 'none', date: '2026-10-28', avanceMin: 60, createdBy: 'Thomas', createdAt: ilYa(3) };
    docs[`families/${FID}/birthdays/b1`] = { name: 'Léo', day: 2, month: 11, year: 2019, createdBy: 'Julie' };
  }
  Object.assign(docs, o.docs || {});
  return docs;
}

// Ce que l'app garde sur le téléphone après la première connexion (prénom, genre, visage…).
const TELEPHONE_CONNU = {
  'papote.fid': FID, 'papote.prenom': 'Julie', 'papote.genre': 'femme', 'papote.visage': visage('Julie', 0),
  'papote.anniversaire': JSON.stringify({ day: 14, month: 3, year: 1988 }), 'papote.guideVu': '1', 'papote.telephone': '0612345678',
};

function connecte(o = {}) {
  return { user: MOI, docs: famillePleine(o), local: { ...TELEPHONE_CONNU, ...(o.local || {}) }, session: o.session, fonctions: o.fonctions, envoiBloque: o.envoiBloque };
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
// Photos « de la galerie du téléphone » pour l'écran d'envoi (fabriquées au début de la capture).
const EXEMPLE = (i) => path.join(__dirname, 'sortie', `exemple-${i}.png`);
// Vidéos « de la galerie du téléphone » : en paysage, en portrait, et un fichier abîmé.
const VIDEO = (sens) => path.join(__dirname, 'sortie', `exemple-video-${sens}.webm`);
const abo = (abonnement, o = {}) => connecte({ abonnement, ...o });

// plein : capture de toute la page (qui défile) ; sinon seulement l'écran du téléphone.
// Toucher un bouton par son texte (menus ⋮, confirmations dans la page).
const bouton = (texte) => async (p) => { await p.getByRole('button', { name: texte, exact: false }).first().click(); await pause(p); };
const suite = (...etapes) => async (p) => { for (const e of etapes) await e(p); };
// Proche inscrit avant le 29/10, sans numéro de téléphone : « Vos informations » le demande au lancement.
const sansNumero = () => { const d = connecte({ local: { 'papote.telephone': '' } }); d.docs[`families/${FID}/members/${MOI.uid}`].telephone = ''; return d; };
const sousTablette = (o = {}) => connecte({ sim: true, ...o });
const FACTURES = [
  { le: ilYa(3).__ms, numero: 'PAP-0004', montant: 2500, statut: 'payee', pdf: 'https://exemple.invalid/f4.pdf' },
  { le: ilYa(33).__ms, numero: 'PAP-0002', montant: 2500, statut: 'payee', pdf: 'https://exemple.invalid/f2.pdf' },
  { le: ilYa(36).__ms, numero: 'PAP-0001', montant: 6000, statut: 'payee', pdf: 'https://exemple.invalid/f1.pdf' },
];
const abonnementPage = toucher(onglet('profile'), '#btn-abo-page');
// Appel en cours dans l'app (appel.js n'ouvre pas de vraie connexion ici) : l'écran #call est mis dans l'état voulu,
// comme l'app le ferait. etat : 'audio' | 'video' | 'sonne' | 'fin' ; texte : la ligne d'état.
const ecranAppel = (etat, texte = '', extra = {}) => async (p) => {
  await p.evaluate(({ etat, texte, extra }) => {
    const $ = (id) => document.getElementById(id);
    const c = $('call');
    c.classList.remove('audio', 'sonne');
    if (etat === 'audio') c.classList.add('audio');
    if (etat === 'sonne' || etat === 'fin') c.classList.add('sonne');
    $('call-name').textContent = 'Mamie Jeanne';
    // Comme setCallFace de l'app : la photo de la tablette si elle en a une, sinon l'initiale.
    $('call-face').textContent = 'M';
    $('call-timer').textContent = etat === 'audio' ? '2:14' : '';
    $('call-status').textContent = texte; $('call-status').hidden = !texte;
    $('call-hangup').hidden = etat === 'fin';
    if (etat === 'audio' && extra.sansVideo) { $('call-video').hidden = true; }
    if (etat === 'video') {
      for (const id of ['call-remote', 'call-remote-fond', 'call-local']) { const v = $(id); v.src = 'faux.webm'; v.loop = true; v.muted = true; v.play().catch(() => {}); }
    }
    if (extra.forfait) { $('call-forfait').textContent = extra.forfait; $('call-forfait').hidden = false; }
    c.hidden = false;
  }, { etat, texte, extra });
  await pause(p, 1200);
  // La lecture de la vidéo efface la ligne d'état (setCallStatus de l'app) : on la remet après.
  if (texte) await p.evaluate((t) => { const s = document.getElementById('call-status'); s.textContent = t; s.hidden = false; }, texte);
};
// Vidéo choisie (ou filmée) puis préparée par l'app : l'aperçu, la légende et « Envoyer ».
const videoChoisie = (sens) => async (p) => {
  await toucher(page('videos'), '#view-videos .fab')(p);
  await p.setInputFiles('#in-video-gallery', VIDEO(sens));
  await p.locator('#video-preview:not([hidden])').waitFor({ timeout: 15000 });
  await pause(p, 800);
};
const appelVisio = toucher('#tile-call', '.dialog button.primary, dialog button.primary');

const SCENES = [
  { groupe: 'Connexion', titre: 'Chargement', donnees: () => ({ user: null }), avant: true },
  { groupe: 'Connexion', titre: 'Se connecter', donnees: () => ({ user: null }) },
  { groupe: 'Connexion', titre: 'Lien de connexion envoyé', donnees: () => ({ user: null }), faire: async (p) => {
    await p.fill('input[type="email"]', 'julie@exemple.fr'); await toucher('#btn-email')(p);
  } },
  { groupe: 'Connexion', titre: 'Pas de connexion internet à l’ouverture', donnees: () => ({ user: null }), faire: async (p) => {
    await p.evaluate(() => window.papoteHorsLigne && window.papoteHorsLigne()); await pause(p, 800);
  } },
  { groupe: 'Connexion', titre: 'Vos informations (premier lancement, numéro vide)', plein: true, donnees: () => ({ user: MOI, docs: famillePleine(), local: { 'papote.fid': FID } }) },
  { groupe: 'Connexion', titre: 'Vos informations : numéro faux', plein: true, note: 'Sans numéro, « Continuer » reste grisé.', donnees: () => sansNumero(), faire: async (p) => {
    await p.fill('#moi-tel', '06 12'); await p.dispatchEvent('#moi-tel', 'input'); await p.locator('#form-moi button[type="submit"]').click(); await pause(p);
  } },
  { groupe: 'Connexion', titre: 'Vos informations : tout est rempli', plein: true, donnees: () => sansNumero(), faire: async (p) => {
    await p.fill('#moi-tel', '06 12 34 56 78'); await p.dispatchEvent('#moi-tel', 'input'); await pause(p);
  } },
  { groupe: 'Connexion', titre: 'Proche déjà inscrit sans numéro (au lancement)', plein: true, note: 'Depuis le 29/10, le numéro est demandé au prochain lancement.', donnees: () => sansNumero() },
  { groupe: 'Connexion', titre: 'Rejoindre ou installer', plein: true, donnees: () => sansFamille() },
  { groupe: 'Connexion', titre: 'Rejoindre avec le code famille : code faux', plein: true, donnees: () => sansFamille({ 'config/base': {} }), faire: async (p) => {
    await p.fill('#join-code', 'ZZZZ9999').catch(() => {}); await p.locator('#form-join button[type="submit"]').click().catch(() => {}); await pause(p, 1200);
  } },
  { groupe: 'Connexion', titre: 'Invitation reçue par e-mail', plein: true, donnees: () => sansFamille({
    [`families/${FID}`]: { name: 'Mamie Jeanne', createdBy: 'u-thomas' },
    [`families/${FID}/invitations/julie@exemple.fr`]: { email: MOI.email, fid: FID, familyName: 'Mamie Jeanne', invitedBy: 'Thomas', createdAt: ilYa(1) },
  }) },
  { groupe: 'Connexion', titre: 'En attente d’acceptation', plein: true, donnees: () => sansFamille({
    [`families/${FID}`]: { name: 'Mamie Jeanne', createdBy: 'u-thomas' },
    [`families/${FID}/members/${MOI.uid}`]: membre(MOI.uid, 'Julie', { email: MOI.email, status: 'pending' }),
  }) },
  { groupe: 'Connexion', titre: 'Premier lancement : petit guide (1/3)', donnees: () => connecte({ local: { 'papote.guideVu': '' } }) },
  { groupe: 'Connexion', titre: 'Premier lancement : petit guide (3/3)', donnees: () => connecte({ local: { 'papote.guideVu': '' } }), faire: async (p) => {
    await p.locator('.guide-next').click(); await p.locator('.guide-next').click(); await pause(p);
  } },

  { groupe: 'Installation de la tablette', titre: 'Scanner le code de la tablette', plein: true, donnees: () => sansFamille(), faire: toucher('#btn-join-pair') },
  { groupe: 'Installation de la tablette', titre: 'Nom de la personne', plein: true, donnees: () => sansFamille({ 'pairings/K7PM2Q': RESA }) },
  { groupe: 'Installation de la tablette', titre: 'Nom de la personne : vide', plein: true, donnees: () => sansFamille({ 'pairings/K7PM2Q': RESA }), faire: async (p) => {
    await p.click('#setup-nom button[type="submit"]'); await pause(p);
  } },
  { groupe: 'Installation de la tablette', titre: 'Photo pour la tablette', plein: true, donnees: () => installation('photo'), faire: nommer },
  { groupe: 'Installation de la tablette', titre: 'Réglage du son', plein: true, donnees: () => installation('son'), faire: nommer },
  { groupe: 'Installation de la tablette', titre: 'Options', plein: true, donnees: () => installation('options'), faire: nommer },
  { groupe: 'Installation de la tablette', titre: 'Annuler l’installation ?', donnees: () => installation('photo'), faire: async (p) => { await nommer(p); await toucher('#setup-cancel')(p); } },
  { groupe: 'Installation de la tablette', titre: 'Réglons la tablette (famille toute neuve)', note: 'Propriétaire, famille sans veille ni options : réglages proposés d’un coup.', donnees: () => connecte({ famille: { veille: null, options: null } }) },
  { groupe: 'Installation de la tablette', titre: 'Réglons la tablette : la nuit', donnees: () => connecte({ famille: { veille: null, options: null } }), faire: async (p) => { await p.locator('.intro-next').click(); await pause(p); } },
  { groupe: 'Installation de la tablette', titre: 'Réglons la tablette : le son', donnees: () => connecte({ famille: { veille: null, options: null } }), faire: async (p) => { for (let i = 0; i < 2; i++) await p.locator('.intro-next').click(); await pause(p); } },
  { groupe: 'Installation de la tablette', titre: 'Réglons la tablette : les options', plein: true, donnees: () => connecte({ famille: { veille: null, options: null } }), faire: async (p) => { for (let i = 0; i < 3; i++) await p.locator('.intro-next').click(); await pause(p); } },
  { groupe: 'Installation de la tablette', titre: 'Réglons la tablette : c’est prêt', donnees: () => connecte({ famille: { veille: null, options: null } }), faire: async (p) => { for (let i = 0; i < 4; i++) { await p.locator('.intro-next').click(); await pause(p, 500); } } },

  { groupe: 'Accueil', titre: 'Accueil', plein: true, donnees: () => connecte() },
  { groupe: 'Accueil', titre: 'Accueil en thème sombre', plein: true, donnees: () => connecte({ local: { 'papote.theme': 'dark' } }) },
  { groupe: 'Accueil', titre: 'Famille toute neuve (rien envoyé)', plein: true, donnees: () => connecte({ vide: true }) },
  { groupe: 'Accueil', titre: 'Quelqu’un demande à rejoindre', plein: true, donnees: () => connecte({ enAttente: true }) },
  { groupe: 'Accueil', titre: 'Tablette débranchée', plein: true, donnees: () => connecte({ debranchee: true }) },
  { groupe: 'Accueil', titre: 'Batterie faible', plein: true, donnees: () => connecte({ batterie: 9 }) },
  { groupe: 'Accueil', titre: 'Tablette qui ne répond plus (plus de 1 h 10)', plein: true, donnees: () => connecte({ tabletteHorsLigne: true }) },
  { groupe: 'Accueil', titre: 'Mamie n’a pas touché la tablette depuis hier', plein: true, donnees: () => connecte({ inactive: true }) },
  { groupe: 'Accueil', titre: 'État de la tablette (toucher la pastille)', donnees: () => connecte(), faire: toucher('#tablet-chip') },
  { groupe: 'Accueil', titre: 'Tablette sur la carte SIM', plein: true, donnees: () => sousTablette() },
  { groupe: 'Accueil', titre: 'Tablette sur la carte SIM : état et forfait', donnees: () => sousTablette({ forfait: 42 }), faire: toucher('#tablet-chip') },
  { groupe: 'Accueil', titre: 'Forfait SIM à 80 % (image réduite)', plein: true, donnees: () => sousTablette({ forfait: 80 }) },
  { groupe: 'Accueil', titre: 'Forfait SIM à 88 % (sans image, « Appeler par téléphone »)', plein: true, donnees: () => sousTablette({ forfait: 89 }) },
  { groupe: 'Accueil', titre: 'Forfait SIM à 95 % (vidéos en attente du Wi-Fi)', plein: true, donnees: () => sousTablette({ forfait: 96 }) },
  { groupe: 'Accueil', titre: 'Accueil d’un proche (pas propriétaire)', plein: true, donnees: () => connecte({ proprietaire: false }) },
  { groupe: 'Accueil', titre: 'Plusieurs familles', plein: true, donnees: () => connecte({ docs: {
    'families/autre': { name: 'Papi Henri', createdBy: 'u-thomas', abonnement: { statut: 'actif' } },
    [`families/autre/members/${MOI.uid}`]: membre(MOI.uid, 'Julie', { email: MOI.email }),
  } }) },
  { groupe: 'Accueil', titre: 'Plusieurs familles : changer de famille', donnees: () => connecte({ docs: {
    'families/autre': { name: 'Papi Henri', createdBy: 'u-thomas', abonnement: { statut: 'actif' } },
    [`families/autre/members/${MOI.uid}`]: membre(MOI.uid, 'Julie', { email: MOI.email }),
  } }), faire: toucher('#family-switch') },
  { groupe: 'Accueil', titre: 'Android : empêcher la mise en pause de Papote', plein: true, donnees: () => connecte({ session: { 'papote.pause': '1' } }) },
  { groupe: 'Accueil', titre: 'Retour arrière sur l’accueil : « Voulez-vous quitter Papote ? »', note: 'Dans l’app Android (qui sait fermer Papote).', donnees: () => connecte({ session: { 'papote.app': '1', 'papote.quitter': '1' } }), faire: async (p) => {
    await p.locator('#family-title').click(); await pause(p, 300); await p.goBack(); await pause(p, 900);
  } },
  { groupe: 'Accueil', titre: 'Paiement en retard', plein: true, donnees: () => abo({ statut: 'impaye', formule: 'sim', graceJusqua: ilYa(-6) }) },
  { groupe: 'Accueil', titre: 'Paiement en retard, sans date de grâce', plein: true, note: 'Cas limite : le bandeau doit rester une phrase complète sans la date.', donnees: () => abo({ statut: 'impaye', formule: 'sim' }) },
  { groupe: 'Accueil', titre: 'Papote en pause (proche, pas responsable)', plein: true, donnees: () => abo({ statut: 'suspendu', formule: 'sim', stripeCustomerId: 'cus_faux', stripeSubscriptionId: 'sub_faux' }, { proprietaire: false }) },
  { groupe: 'Accueil', titre: 'Installation finie sans commande reliée (48 h)', plein: true, donnees: () => abo({ statut: 'installation', toleranceJusqua: ilYa(-2) }) },
  { groupe: 'Accueil', titre: 'Abonnement activé, merci', donnees: () => abo({ statut: 'actif', formule: 'sim', stripeCustomerId: 'cus_faux', stripeSubscriptionId: 'sub_faux', finPeriode: ilYa(-30) }, { local: { 'papote.retourPaiement': '1' } }) },
  { groupe: 'Accueil', titre: 'Sans abonnement', plein: true, donnees: () => abo({ statut: 'aucun' }) },
  { groupe: 'Accueil', titre: 'Sans abonnement : déjà commandé', plein: true, donnees: () => abo({ statut: 'aucun' }), faire: toucher('#sans-abo-deja') },
  { groupe: 'Accueil', titre: 'Sans abonnement : prendre un abonnement', plein: true, donnees: () => abo({ statut: 'aucun' }), faire: toucher('#sans-abo-prendre') },
  { groupe: 'Accueil', titre: 'Sans abonnement : code de commande inconnu', plein: true, donnees: () => abo({ statut: 'aucun' }, { fonctions: { rattacherCommande: { erreur: 'inconnu', code: 'functions/not-found' } } }), faire: async (p) => {
    await toucher('#sans-abo-deja')(p); await p.locator('#sans-abo-panel-deja .order-code').fill('ABCD-EFGH'); await p.locator('#sans-abo-panel-deja button[type="submit"]').click(); await pause(p, 900);
  } },
  { groupe: 'Accueil', titre: 'Sans abonnement (proche, pas responsable)', plein: true, donnees: () => abo({ statut: 'aucun' }, { proprietaire: false }) },
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
    await p.setInputFiles('#in-photo-gallery', [EXEMPLE(1), EXEMPLE(2)]);
    await pause(p, 2000);
  } },
  { groupe: 'Photos et vidéos', titre: 'Envoyer : 5 photos au plus par envoi', donnees: () => connecte(), faire: async (p) => {
    await toucher(page('photos'), '#view-photos .fab')(p);
    await p.setInputFiles('#in-photo-gallery', [1, 2, 1, 2, 1, 2, 1].map(EXEMPLE));
    await pause(p, 2500);
  } },
  { groupe: 'Photos et vidéos', titre: 'Vidéos', plein: true, donnees: () => connecte(), faire: toucher(page('videos')) },
  { groupe: 'Photos et vidéos', titre: 'Vidéo ouverte en grand', donnees: () => connecte(), faire: toucher(page('videos'), '#videos .shot-frame, #videos button, #videos li') },
  { groupe: 'Photos et vidéos', titre: 'Envoyer une vidéo', donnees: () => connecte(), faire: toucher(page('videos'), '#view-videos .fab') },
  // Parcours d'envoi d'une vidéo : « Filmer » ouvre l'appareil photo du téléphone (pas capturable ici) ; la vidéo
  // filmée revient dans l'app comme une vidéo choisie dans la galerie, c'est ce qui est rejoué ici.
  { groupe: 'Photos et vidéos', titre: 'Vidéo : préparation en cours', donnees: () => connecte(), faire: async (p) => {
    await toucher(page('videos'), '#view-videos .fab')(p); await p.setInputFiles('#in-video-gallery', VIDEO('portrait')); await pause(p, 250);
  } },
  { groupe: 'Photos et vidéos', titre: 'Vidéo filmée en portrait : aperçu, légende, Envoyer', plein: true, donnees: () => connecte(), faire: videoChoisie('portrait') },
  { groupe: 'Photos et vidéos', titre: 'Vidéo filmée en paysage : aperçu, légende, Envoyer', plein: true, donnees: () => connecte(), faire: videoChoisie('paysage') },
  // Le plein écran du lecteur vidéo ne s'affiche pas dans un navigateur sans écran : il est imité ici (vidéo sur
  // tout l'écran, fond noir), ce qui montre le cadrage mais ne prouve pas que le bouton marche sur le téléphone.
  { groupe: 'Photos et vidéos', titre: 'Vidéo en portrait : aperçu en plein écran (imité)', note: 'Imité : le vrai plein écran du lecteur ne se capture pas. Bouton signalé bloqué par Tanguy le 29/10.', donnees: () => connecte(), faire: async (p) => {
    await videoChoisie('portrait')(p);
    await p.evaluate(() => { const v = document.getElementById('video-preview'); v.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;max-height:none;background:#000;object-fit:contain;z-index:99999;border-radius:0;margin:0'; });
    await pause(p, 600);
  } },
  { groupe: 'Photos et vidéos', titre: 'Vidéo : légende remplie (60 caractères au plus)', donnees: () => connecte(), faire: async (p) => {
    await videoChoisie('paysage')(p); await p.fill('#post-text', 'Léo fait du vélo sans les petites roues !'); await p.dispatchEvent('#post-text', 'input');
    await p.locator('#btn-send').scrollIntoViewIfNeeded(); await pause(p, 300);
  } },
  { groupe: 'Photos et vidéos', titre: 'Vidéo : envoi en cours', donnees: () => connecte({ envoiBloque: true }), faire: async (p) => {
    await videoChoisie('portrait')(p); await p.click('#btn-send'); await pause(p, 800);
  } },
  { groupe: 'Photos et vidéos', titre: 'Vidéo envoyée (« Envoyé »)', donnees: () => connecte(), faire: async (p) => {
    await videoChoisie('portrait')(p); await p.click('#btn-send'); await pause(p, 600);
  } },
  { groupe: 'Photos et vidéos', titre: 'Vidéo : pas de réseau, envoi mis en attente', donnees: () => connecte(), faire: async (p) => {
    await videoChoisie('portrait')(p); await p.context().setOffline(true); await p.click('#btn-send'); await pause(p, 1200);
  } },
  { groupe: 'Photos et vidéos', titre: 'Vidéo illisible', donnees: () => connecte(), faire: async (p) => {
    await toucher(page('videos'), '#view-videos .fab')(p); await p.setInputFiles('#in-video-gallery', VIDEO('abimee')); await pause(p, 2500);
  } },
  { groupe: 'Photos et vidéos', titre: 'Vidéo filmée, téléphone tenu en paysage', paysage: true, donnees: () => connecte(), faire: videoChoisie('paysage') },
  { groupe: 'Photos et vidéos', titre: 'Photos : envoi en cours', donnees: () => connecte({ envoiBloque: true }), faire: async (p) => {
    await toucher(page('photos'), '#view-photos .fab')(p); await p.setInputFiles('#in-photo-gallery', [EXEMPLE(1), EXEMPLE(2)]); await pause(p, 2000);
    await p.click('#btn-send'); await pause(p, 800);
  } },
  { groupe: 'Photos et vidéos', titre: 'Photos : pas de réseau, envoi mis en attente', donnees: () => connecte(), faire: async (p) => {
    await toucher(page('photos'), '#view-photos .fab')(p); await p.setInputFiles('#in-photo-gallery', [EXEMPLE(1)]); await pause(p, 1500);
    await p.context().setOffline(true); await p.click('#btn-send'); await pause(p, 1200);
  } },
  { groupe: 'Photos et vidéos', titre: 'Photo choisie, téléphone tenu en paysage', paysage: true, donnees: () => connecte(), faire: async (p) => {
    await toucher(page('photos'), '#view-photos .fab')(p); await p.setInputFiles('#in-photo-gallery', [EXEMPLE(2)]); await pause(p, 1500);
  } },

  { groupe: 'Messages et agenda', titre: 'Messages', donnees: () => connecte(), faire: toucher(page('messages')) },
  { groupe: 'Messages et agenda', titre: 'Messages : aucun', donnees: () => connecte({ vide: true }), faire: toucher(page('messages')) },
  { groupe: 'Messages et agenda', titre: 'Messages : en train d’écrire', donnees: () => connecte(), faire: async (p) => {
    await toucher(page('messages'))(p); await p.fill('#message-text', 'On arrive dimanche vers midi, on apporte le dessert !'); await p.dispatchEvent('#message-text', 'input'); await pause(p);
  } },
  { groupe: 'Messages et agenda', titre: 'Agenda', plein: true, donnees: () => connecte(), faire: toucher(page('agenda')) },
  { groupe: 'Messages et agenda', titre: 'Agenda : aucun rappel', plein: true, donnees: () => connecte({ vide: true }), faire: toucher(page('agenda')) },
  { groupe: 'Messages et agenda', titre: 'Nouveau rappel', donnees: () => connecte(), faire: toucher(page('agenda'), '#add-reminder') },
  { groupe: 'Messages et agenda', titre: 'Nouveau rappel : chaque semaine', plein: true, donnees: () => connecte(), faire: async (p) => {
    await toucher(page('agenda'), '#add-reminder')(p); await p.selectOption('#rem-repeat', 'weekly').catch(() => {}); await pause(p);
  } },
  { groupe: 'Messages et agenda', titre: 'Nouveau rappel : sans titre', plein: true, donnees: () => connecte(), faire: async (p) => {
    await toucher(page('agenda'), '#add-reminder', '#btn-reminder')(p);
  } },
  { groupe: 'Messages et agenda', titre: 'Modifier un rappel', donnees: () => connecte(), faire: toucher(page('agenda'), '#reminders .agenda-edit') },
  { groupe: 'Messages et agenda', titre: 'Nouvel anniversaire', donnees: () => connecte(), faire: toucher(page('agenda'), '#add-reminder', '#agenda-seg [data-seg="birthday"]') },
  { groupe: 'Messages et agenda', titre: 'Nouvel anniversaire : déjà dans l’agenda', plein: true, donnees: () => connecte(), faire: async (p) => {
    await toucher(page('agenda'), '#add-reminder', '#agenda-seg [data-seg="birthday"]')(p);
    await p.fill('#bday-name', 'Léo'); await p.dispatchEvent('#bday-name', 'input'); await p.selectOption('#bday-day', '2').catch(() => {}); await p.selectOption('#bday-month', '11').catch(() => {});
    await toucher('#btn-reminder')(p);
  } },

  { groupe: 'Appels', titre: 'Appeler ? (confirmation)', donnees: () => connecte(), faire: toucher('#tile-call') },
  { groupe: 'Appels', titre: 'Appel vidéo : ça sonne', donnees: () => connecte(), faire: async (p) => { await appelVisio(p); await pause(p, 1800); } },
  { groupe: 'Appels', titre: 'Appel vidéo : connexion', note: 'États suivants remplis à la main (pas de vraie connexion vidéo ici).', donnees: () => connecte(), faire: ecranAppel('sonne', 'Connexion…') },
  { groupe: 'Appels', titre: 'Visio en cours (fond flou autour de l’image)', donnees: () => connecte(), faire: ecranAppel('video') },
  { groupe: 'Appels', titre: 'Visio avec une tablette sur SIM : « Déjà 10 minutes »', donnees: () => sousTablette(), faire: ecranAppel('video', '', { forfait: 'Déjà 10 minutes de visio sur le forfait de Mamie Jeanne' }) },
  { groupe: 'Appels', titre: 'Visio : image réduite (forfait à 70 %)', donnees: () => sousTablette({ forfait: 72 }), faire: ecranAppel('video', 'Image réduite : le forfait internet de la tablette est utilisé à 70 %.') },
  { groupe: 'Appels', titre: 'Visio : image très réduite (forfait à 88 %)', donnees: () => sousTablette({ forfait: 89 }), faire: ecranAppel('video', 'Image très réduite : le forfait internet de la tablette est utilisé à 88 %.') },
  { groupe: 'Appels', titre: 'Appel sans image (forfait à 95 %)', donnees: () => sousTablette({ forfait: 96 }), faire: ecranAppel('audio', 'Appel sans image : le forfait internet de la tablette est presque épuisé.', { sansVideo: true }) },
  { groupe: 'Appels', titre: 'Fin : pas de réponse', donnees: () => connecte(), faire: ecranAppel('fin', 'Pas de réponse') },
  { groupe: 'Appels', titre: 'Fin : l’appel a été refusé', donnees: () => connecte(), faire: ecranAppel('fin', 'L’appel a été refusé') },
  { groupe: 'Appels', titre: 'Fin : la connexion vidéo a échoué', donnees: () => connecte(), faire: ecranAppel('fin', 'La connexion vidéo a échoué') },
  { groupe: 'Appels', titre: 'Fin : appel terminé', donnees: () => connecte(), faire: ecranAppel('fin', 'Appel terminé') },
  { groupe: 'Appels', titre: 'Mamie est déjà en communication', donnees: () => connecte(), faire: ecranAppel('fin', 'Mamie Jeanne est déjà en communication avec un proche. Réessayez un peu plus tard.') },
  { groupe: 'Appels', titre: 'Caméra ou micro refusé', donnees: () => connecte(), faire: ecranAppel('fin', 'La caméra ou le micro est refusé. Autorisez-les dans les réglages du navigateur, puis réessayez.') },
  { groupe: 'Appels', titre: 'Pas de réponse : lui laisser un message vidéo ?', donnees: () => connecte(), faire: async (p) => {
    await p.evaluate(() => import('./js/ui.js').then((m) => { m.askConfirm('Mamie Jeanne n’a pas répondu. Lui laisser un message vidéo ?', 'Filmer'); }));
    await pause(p);
  } },
  { groupe: 'Appels', titre: 'Mamie appelle', donnees: () => appelEntrant() },
  { groupe: 'Appels', titre: 'Mamie appelle : appel en cours (audio)', donnees: () => connecte(), faire: ecranAppel('audio') },
  { groupe: 'Appels', titre: 'Mamie appelle : passer en vidéo, « va vous voir »', donnees: () => connecte(), faire: ecranAppel('sonne', 'Mamie Jeanne va vous voir…') },
  { groupe: 'Appels', titre: 'Mamie appelle : un autre proche a déjà répondu', donnees: () => connecte(), faire: ecranAppel('fin', 'Un autre proche a déjà répondu.') },

  { groupe: 'Réglages', titre: 'Réglages (propriétaire)', plein: true, donnees: () => connecte(), faire: toucher(page('settings')) },
  { groupe: 'Réglages', titre: 'Réglages : tablette sur la carte SIM (son numéro)', plein: true, donnees: () => sousTablette(), faire: toucher(page('settings')) },
  { groupe: 'Réglages', titre: 'Réglages : famille de 20 proches', plein: true, donnees: () => connecte({ nombreux: true }), faire: toucher(page('settings')) },
  { groupe: 'Réglages', titre: 'Réglages : un proche mis en tête', plein: true, donnees: () => connecte({ enTete: true }), faire: toucher(page('settings')) },
  { groupe: 'Réglages', titre: 'Réglages : une demande pour rejoindre', plein: true, donnees: () => connecte({ enAttente: true }), faire: toucher(page('settings')) },
  { groupe: 'Réglages', titre: 'Réglages (proche)', plein: true, donnees: () => connecte({ proprietaire: false }), faire: toucher(page('settings')) },
  { groupe: 'Réglages', titre: 'Menu d’un membre (⋮)', donnees: () => connecte(), faire: toucher(page('settings'), '#view-settings .member-more') },
  { groupe: 'Réglages', titre: 'Mettre en tête ? (confirmation)', donnees: () => connecte(), faire: suite(toucher(page('settings'), '#view-settings .member-more'), bouton('Mettre en tête')) },
  { groupe: 'Réglages', titre: 'Rendre responsable ? (confirmation)', donnees: () => connecte(), faire: suite(toucher(page('settings'), '#view-settings .member-more'), bouton('Rendre responsable')) },
  { groupe: 'Réglages', titre: 'Retirer de la famille ? (confirmation)', donnees: () => connecte(), faire: suite(toucher(page('settings'), '#view-settings .member-more'), bouton('Retirer de la famille')) },
  { groupe: 'Réglages', titre: 'Modifier : nom de la tablette', donnees: () => connecte(), faire: toucher(page('settings'), modifier('family-name-card')) },
  { groupe: 'Réglages', titre: 'Modifier : photo de la tablette', donnees: () => connecte(), faire: toucher(page('settings'), '#tablet-face-card') },
  { groupe: 'Réglages', titre: 'Modifier : ville de la météo', donnees: () => connecte(), faire: toucher(page('settings'), modifier('meteo-card')) },
  { groupe: 'Réglages', titre: 'Ville de la météo : communes du code postal', donnees: () => connecte(), faire: async (p) => {
    await toucher(page('settings'), modifier('meteo-card'))(p); await p.locator('#meteo-cp').pressSequentially('07160'); await pause(p, 800);
  } },
  { groupe: 'Réglages', titre: 'Ville de la météo : aucune commune', donnees: () => connecte(), faire: async (p) => {
    await toucher(page('settings'), modifier('meteo-card'))(p); await p.locator('#meteo-cp').pressSequentially('99999'); await pause(p, 800);
  } },
  { groupe: 'Réglages', titre: 'Modifier : options de la tablette', plein: true, donnees: () => connecte(), faire: toucher(page('settings'), modifier('options-card')) },
  { groupe: 'Réglages', titre: 'Modifier : options, radio activée', plein: true, donnees: () => connecte(), faire: async (p) => {
    await toucher(page('settings'), modifier('options-card'))(p); await p.check('#opt-radio').catch(() => {}); await p.dispatchEvent('#opt-radio', 'change'); await pause(p);
  } },
  { groupe: 'Réglages', titre: 'Modifier : volumes (sonnerie, vidéos et messages)', donnees: () => connecte(), faire: toucher(page('settings'), modifier('volume-card')) },
  { groupe: 'Réglages', titre: 'Modifier : veille la nuit (21 h - 6 h 30)', donnees: () => connecte(), faire: toucher(page('settings'), modifier('sleep-card')) },
  { groupe: 'Réglages', titre: 'Modifier : veille coupée', donnees: () => connecte(), faire: async (p) => {
    await toucher(page('settings'), modifier('sleep-card'))(p); await p.locator('#sleep-on').uncheck({ force: true }).catch(() => {}); await p.dispatchEvent('#sleep-on', 'change'); await pause(p);
  } },
  { groupe: 'Réglages', titre: 'Wifi de la tablette', donnees: () => connecte(), faire: toucher(page('settings'), '#wifi-modify') },
  { groupe: 'Réglages', titre: 'Wifi : réseaux trouvés par la tablette', donnees: () => connecte(), faire: async (p) => {
    await toucher(page('settings'), '#wifi-modify')(p);
    // Réponse de la tablette à la commande wifiScan, comme elle l'écrirait.
    await p.evaluate(() => {
      const c = window.__base.chemins().find((x) => x.includes('/commands/') && window.__base.get(x).type === 'wifiScan');
      window.__base.set(c, { ...window.__base.get(c), state: 'done', reseaux: [
        { ssid: 'Livebox-6A2F', security: 'wpa2', signal: 4 }, { ssid: 'Freebox-Voisin', security: 'wpa2', signal: 2 },
        { ssid: 'SFR_WiFi_FON', security: 'open', signal: 1 }, { ssid: 'Bbox-31C0', security: 'wpa3', signal: 3 },
      ] });
    });
    await pause(p, 800);
  } },
  { groupe: 'Réglages', titre: 'Wifi : mot de passe d’un autre réseau', donnees: () => connecte(), faire: async (p) => {
    await toucher(page('settings'), '#wifi-modify')(p);
    // Réponse de la tablette à la commande wifiScan, comme elle l'écrirait.
    await p.evaluate(() => {
      const c = window.__base.chemins().find((x) => x.includes('/commands/') && window.__base.get(x).type === 'wifiScan');
      window.__base.set(c, { ...window.__base.get(c), state: 'done', reseaux: [
        { ssid: 'Livebox-6A2F', security: 'wpa2', signal: 4 }, { ssid: 'Freebox-Voisin', security: 'wpa2', signal: 2 },
        { ssid: 'SFR_WiFi_FON', security: 'open', signal: 1 }, { ssid: 'Bbox-31C0', security: 'wpa3', signal: 3 },
      ] });
    });
    await pause(p, 800); await toucher('#wifi-list >> text=Freebox-Voisin')(p);
  } },
  { groupe: 'Réglages', titre: 'Wifi : la tablette n’a pas pu chercher', donnees: () => connecte(), faire: async (p) => {
    await toucher(page('settings'), '#wifi-modify')(p);
    await p.evaluate(() => {
      const c = window.__base.chemins().find((x) => x.includes('/commands/') && window.__base.get(x).type === 'wifiScan');
      window.__base.set(c, { ...window.__base.get(c), state: 'failed' });
    });
    await pause(p, 800);
  } },
  { groupe: 'Réglages', titre: 'Dépanner : redémarrer la tablette ?', donnees: () => connecte(), faire: toucher(page('settings'), '[data-cmd="restart"]') },
  { groupe: 'Réglages', titre: 'Dépanner : obtenir l’état (en attente de la tablette)', plein: true, donnees: () => connecte(), faire: toucher(page('settings'), '[data-cmd="status"]') },
  { groupe: 'Réglages', titre: 'Inviter un proche', plein: true, donnees: () => connecte(), faire: toucher('#btn-invite') },
  { groupe: 'Réglages', titre: 'Inviter : invitations en attente', plein: true, donnees: () => connecte({ docs: {
    [`families/${FID}/invitations/paul@exemple.fr`]: { email: 'paul@exemple.fr', fid: FID, familyName: 'Mamie Jeanne', invitedBy: 'Julie', createdAt: ilYa(1) },
    [`families/${FID}/invitations/zoe@exemple.fr`]: { email: 'zoe@exemple.fr', fid: FID, familyName: 'Mamie Jeanne', invitedBy: 'Thomas', createdAt: ilYa(3) },
  } }), faire: toucher('#btn-invite') },
  { groupe: 'Réglages', titre: 'Inviter : invitation envoyée', donnees: () => connecte({ fonctions: { inviterParEmail: { envoye: true } } }), faire: async (p) => {
    await toucher('#btn-invite')(p); await p.fill('#invite-email', 'paul@exemple.fr'); await p.locator('#form-invite button[type="submit"]').click(); await pause(p, 500);
  } },
  { groupe: 'Réglages', titre: 'Inviter : famille complète (30 proches)', plein: true, donnees: () => {
    const d = connecte({ nombreux: true });
    for (let i = 0; i < 10; i++) d.docs[`families/${FID}/members/u-plus${i}`] = membre(`u-plus${i}`, `Proche ${i + 1}`);
    return d;
  }, faire: toucher('#btn-invite') },

  { groupe: 'Profil', titre: 'Profil : abonnement actif', plein: true, donnees: () => connecte(), faire: toucher(onglet('profile')) },
  { groupe: 'Profil', titre: 'Profil : tout compris 25 € (offre unique)', plein: true, donnees: () => abo({ statut: 'actif', formule: 'sim', tablette: 'pretee', finPeriode: ilYa(-12), stripeCustomerId: 'cus_faux', stripeSubscriptionId: 'sub_faux' }), faire: toucher(onglet('profile')) },
  { groupe: 'Profil', titre: 'Profil : commandé, tablette pas encore partie', plein: true, donnees: () => abo({ statut: 'actif', formule: 'sim', essaiJusqua: ilYa(-80), stripeCustomerId: 'cus_faux', stripeSubscriptionId: 'sub_faux' }, { fonctions: { finDeContrat: { retractation: { jusqua: null, montant: 6000 } } } }), faire: toucher(onglet('profile')) },
  { groupe: 'Profil', titre: 'Profil : commande offerte', plein: true, donnees: () => abo({ statut: 'offert' }), faire: toucher(onglet('profile')) },
  { groupe: 'Profil', titre: 'Profil : formule d’origine, sans abonnement', plein: true, donnees: () => abo(null), faire: toucher(onglet('profile')) },
  { groupe: 'Profil', titre: 'Profil : paiement en retard', plein: true, donnees: () => abo({ statut: 'impaye', formule: 'sim', graceJusqua: ilYa(-6), stripeCustomerId: 'cus_faux', stripeSubscriptionId: 'sub_faux' }), faire: toucher(onglet('profile')) },
  { groupe: 'Profil', titre: 'Profil : en pause', plein: true, donnees: () => abo({ statut: 'suspendu', formule: 'sim', stripeCustomerId: 'cus_faux', stripeSubscriptionId: 'sub_faux' }), faire: toucher(onglet('profile')) },
  { groupe: 'Profil', titre: 'Profil : résiliation programmée (garder l’abonnement)', plein: true, donnees: () => abo({ statut: 'actif', formule: 'sim', resiliationLe: ilYa(-18), stripeCustomerId: 'cus_faux', stripeSubscriptionId: 'sub_faux' }), faire: toucher(onglet('profile')) },
  { groupe: 'Profil', titre: 'Profil : résilié, tablette à renvoyer', plein: true, donnees: () => abo({ statut: 'resilie', formule: 'sim', finLe: ilYa(2), stripeCustomerId: 'cus_faux' }, { fonctions: { finDeContrat: { restitution: { statut: 'attendue', avant: ilYa(-12).__ms } } } }), faire: toucher(onglet('profile')) },
  { groupe: 'Profil', titre: 'Profil : résilié, QR code de retour Mondial Relay', plein: true, donnees: () => abo({ statut: 'resilie', formule: 'sim', finLe: ilYa(2), stripeCustomerId: 'cus_faux' }, { fonctions: { finDeContrat: { restitution: { statut: 'attendue', avant: ilYa(-12).__ms, qr: fauxQr() } } } }), faire: toucher(onglet('profile')) },
  { groupe: 'Profil', titre: 'Profil : annulé, remboursé à la réception', plein: true, donnees: () => abo({ statut: 'resilie', formule: 'sim', finLe: ilYa(1), stripeCustomerId: 'cus_faux' }, { fonctions: { finDeContrat: { restitution: { statut: 'attendue', avant: ilYa(-13).__ms, qr: fauxQr() }, remboursement: { statut: 'au-retour', montant: 6000 } } } }), faire: toucher(onglet('profile')) },
  { groupe: 'Profil', titre: 'Profil : tablette bien reçue, remboursée', plein: true, donnees: () => abo({ statut: 'resilie', formule: 'sim', finLe: ilYa(10), stripeCustomerId: 'cus_faux' }, { fonctions: { finDeContrat: { restitution: { statut: 'rendue' }, remboursement: { statut: 'fait', montant: 6000 } } } }), faire: toucher(onglet('profile')) },
  { groupe: 'Profil', titre: 'Profil : résilié, garder la tablette ? (reprendre)', donnees: () => abo({ statut: 'resilie', formule: 'sim', finLe: ilYa(2), stripeCustomerId: 'cus_faux' }, { fonctions: { finDeContrat: { restitution: { statut: 'attendue', avant: ilYa(-12).__ms } } } }), faire: toucher(onglet('profile'), '#btn-reprendre') },
  { groupe: 'Profil', titre: 'Profil d’un proche', plein: true, donnees: () => connecte({ proprietaire: false }), faire: toucher(onglet('profile')) },
  { groupe: 'Profil', titre: 'Modifier : mon numéro de téléphone', donnees: () => connecte(), faire: toucher(onglet('profile'), modifier('my-tel-card')) },
  { groupe: 'Profil', titre: 'Modifier : mon prénom', donnees: () => connecte(), faire: toucher(onglet('profile'), modifier('my-name-card')) },
  { groupe: 'Profil', titre: 'Abonnement et paiement : factures', plein: true, donnees: () => connecte({ fonctions: { facturesFamille: { factures: FACTURES } } }), faire: abonnementPage },
  { groupe: 'Profil', titre: 'Abonnement et paiement : facture à régler', plein: true, donnees: () => abo({ statut: 'impaye', formule: 'sim', graceJusqua: ilYa(-6), stripeCustomerId: 'cus_faux', stripeSubscriptionId: 'sub_faux' }, { fonctions: { facturesFamille: { factures: [{ le: ilYa(1).__ms, montant: 2500, statut: 'a-payer', page: 'https://exemple.invalid/payer' }, ...FACTURES] } } }), faire: abonnementPage },
  { groupe: 'Profil', titre: 'Abonnement et paiement : aucune facture', plein: true, donnees: () => connecte({ fonctions: { facturesFamille: { factures: [] } } }), faire: abonnementPage },
  { groupe: 'Profil', titre: 'Abonnement et paiement : factures illisibles', plein: true, donnees: () => connecte({ fonctions: { facturesFamille: { erreur: 'panne' } } }), faire: abonnementPage },
  { groupe: 'Profil', titre: 'Abonnement et paiement : annuler ma commande (14 jours)', plein: true, donnees: () => connecte({ fonctions: { facturesFamille: { factures: FACTURES.slice(2) }, finDeContrat: { retractation: { jusqua: ilYa(-9).__ms, montant: 6000 } } } }), faire: abonnementPage },
  { groupe: 'Profil', titre: 'Annuler ma commande ? (confirmation)', donnees: () => connecte({ fonctions: { facturesFamille: { factures: FACTURES.slice(2) }, finDeContrat: { retractation: { jusqua: ilYa(-9).__ms, montant: 6000 } } } }), faire: suite(abonnementPage, toucher('#btn-retracter')) },
  { groupe: 'Profil', titre: 'Résilier : avant de partir', donnees: () => connecte({ fonctions: { facturesFamille: { factures: FACTURES } } }), faire: suite(abonnementPage, toucher('#btn-resilier')) },
  { groupe: 'Profil', titre: 'Quitter la famille ? (proche)', donnees: () => connecte({ proprietaire: false }), faire: toucher(onglet('profile'), '#btn-leave') },
  { groupe: 'Profil', titre: 'Se déconnecter ?', donnees: () => connecte(), faire: async (p) => { await toucher(onglet('profile'))(p); await bouton('Se déconnecter')(p); } },
  // Depuis la barre du bas Accueil / Photos / Messages / Profil (27/10) : la cloche est en haut, le support dans le Profil.
  { groupe: 'Profil', titre: 'Notifications', plein: true, donnees: () => connecte(), faire: toucher(cloche) },
  { groupe: 'Profil', titre: 'Notifications : rien d’autre que les arrivées', plein: true, donnees: () => connecte({ vide: true }), faire: toucher(cloche) },
  { groupe: 'Profil', titre: 'Support', plein: true, donnees: () => connecte(), faire: toucher(onglet('profile'), '.aide-card, ' + onglet('support')) },
];

const SDK = fs.readFileSync(path.join(__dirname, 'faux-firebase.js'), 'utf8');

function poserDonnees(d) {
  try {
    localStorage.clear();
    for (const [k, v] of Object.entries(d.local || {})) if (v) localStorage.setItem(k, v);
    for (const [k, v] of Object.entries(d.session || {})) sessionStorage.setItem(k, v);
  } catch (e) { /* rien */ }
  window.__donnees = d;
}

async function capturer({ browser, base, dossierImages, progression }) {
  const video = await fausseVideo(browser);
  fs.mkdirSync(path.join(__dirname, 'sortie'), { recursive: true });
  fs.writeFileSync(VIDEO('paysage'), await fausseVideo(browser, 640, 360, 3000));
  fs.writeFileSync(VIDEO('portrait'), await fausseVideo(browser, 360, 640, 3000));
  fs.writeFileSync(VIDEO('abimee'), 'pas une vidéo');
  // Deux « photos de la galerie du téléphone » pour l'écran d'envoi.
  const p0 = await browser.newPage();
  for (const [i, portrait] of [[1, false], [2, true]]) {
    await p0.setViewportSize(portrait ? { width: 600, height: 800 } : { width: 800, height: 600 });
    await p0.setContent(`<body style="margin:0"><img src="${fausseImage(i, portrait ? 600 : 800, portrait ? 800 : 600)}">`);
    fs.mkdirSync(path.dirname(EXEMPLE(i)), { recursive: true });
    await p0.screenshot({ path: EXEMPLE(i) });
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
      const { scene, n } = job;
      // Téléphone tenu en paysage : largeur et hauteur échangées.
      const taille = scene.paysage ? { ...job.taille, width: job.taille.height, height: job.taille.width } : job.taille;
      const ctx = await browser.newContext({
        viewport: { width: taille.width, height: taille.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
        locale: 'fr-FR', timezoneId: 'Europe/Paris', serviceWorkers: 'block', permissions: ['camera', 'microphone'],
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
      });
      const page = await ctx.newPage();
      page.setDefaultTimeout(8000); // un bouton absent : erreur signalée vite, pas après 30 s
      const erreurs = [];
      page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
      await page.clock.install({ time: new Date(`${JOUR}T${scene.heure || '10:30'}:00+01:00`) });
      await page.addInitScript(poserDonnees, scene.donnees());
      await page.route('**/faux.webm', (r) => r.fulfill({ contentType: 'video/webm', body: video }));
      // Tous les modules Firebase deviennent le faux SDK (une seule copie, partagée).
      await page.route('https://www.gstatic.com/firebasejs/**', (r) => r.fulfill({
        contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' },
        body: r.request().url().endsWith('/faux-sdk.js') ? SDK : "export * from 'https://www.gstatic.com/firebasejs/faux-sdk.js';",
      }));
      // Polices Google : gardées pour que les écrans aient leur vraie police. Le reste d'internet est coupé.
      await page.route(/^https?:\/\/(?!127\.0\.0\.1|fonts\.googleapis\.com|fonts\.gstatic\.com|www\.gstatic\.com\/firebasejs)/, (r) => r.abort());
      // Recherche de commune par code postal (météo) : 3 fausses communes pour 07160, aucune sinon.
      await page.route('https://geo.api.gouv.fr/**', (r) => r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(r.request().url().includes('codePostal=07160') ? [
          { nom: 'Le Cheylard', centre: { coordinates: [4.42, 44.91] }, departement: { nom: 'Ardèche' } },
          { nom: 'Saint-Martin-de-Valamas', centre: { coordinates: [4.37, 44.93] }, departement: { nom: 'Ardèche' } },
          { nom: 'Mariac', centre: { coordinates: [4.38, 44.89] }, departement: { nom: 'Ardèche' } },
        ] : []) }));
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

module.exports = { capturer, SCENES, famillePleine, membre, poserDonnees, SDK, ilYa, ms, FID };
