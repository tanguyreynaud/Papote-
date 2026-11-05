// Écrans de la tablette (android/app/src/main/assets) : la page est ouverte comme dans la WebView,
// avec une fausse app Android (window.PapoteAndroid) qui lui donne de fausses données.
'use strict';

const { fausseImage, fauxVisage, fauxQr, fausseVideo } = require('./commun');

// La tablette est bloquée en paysage (sensorLandscape dans AndroidManifest.xml) : pas de portrait.
const TAILLES = [{ nom: 'paysage', width: 1280, height: 800 }];

// Toutes les scènes se passent le lundi 26 octobre 2026 (heure de Paris), sauf indication.
const JOUR = '2026-10-26';

const PROCHES = [
  { uid: 'u-julie', name: 'Julie' },
  { uid: 'u-thomas', name: 'Thomas' },
  { uid: 'u-anne', name: 'Anne' },
  { uid: 'u-lucas', name: 'Lucas' },
  { uid: 'u-emma', name: 'Emma' },
];
const VISAGES = Object.fromEntries(PROCHES.map((p, i) => [p.uid, fauxVisage(p.name, i)]));
// Famille nombreuse : les 5 proches habituels puis 15 autres sans photo (initiales).
const BEAUCOUP = [...PROCHES, ...['Hugo', 'Léa', 'Nathan', 'Chloé', 'Louis', 'Manon', 'Gabriel', 'Camille', 'Jules', 'Inès', 'Arthur', 'Zoé', 'Paul', 'Jade', 'Marius'].map((n) => ({ uid: `u-${n.toLowerCase()}`, name: n }))];

const IMAGES = {
  paysage: (n) => fausseImage(n, 1600, 1200),
  portrait: (n) => fausseImage(n, 1200, 1600),
};

function heure(hm, jour = JOUR) { return new Date(`${jour}T${hm}:00+01:00`).getTime(); }

let nPost = 0;
function post(o) {
  nPost++;
  return {
    id: o.id || `p${nPost}`, type: o.type || (o.image ? 'photo' : 'message'), text: o.text || '',
    authorName: o.author || 'Julie', authorUid: o.uid || 'u-julie', createdAt: o.at || heure('09:12'),
    seen: o.seen !== false, hearts: 0, image: o.image || null, images: o.images || [], audio: o.audio || null,
    video: o.video || null, voice: null, announce: null, duration: o.duration || 0,
  };
}

// Une famille bien remplie : 8 photos déjà vues, en paysage et en portrait.
function photosVues() {
  const out = [];
  for (let i = 0; i < 8; i++) {
    out.push(post({
      id: `vue${i}`, image: (i % 3 === 1 ? IMAGES.portrait : IMAGES.paysage)(i), author: PROCHES[i % 4].name,
      uid: PROCHES[i % 4].uid, text: ['Les vacances à la mer', '', 'Le gâteau de Léo', 'Premier jour d’école'][i % 4],
      at: heure('09:00') - i * 86400000,
    }));
  }
  return out;
}

const OPTIONS = { lecture: true, sos: true, meteo: true, rappelsAccueil: true };
const METEO = {
  current: { weather_code: 1, is_day: 1, temperature_2m: 14.4 },
  daily: { weather_code: [1, 61], temperature_2m_max: [16, 12.6] },
};
const METEO_NUIT = { current: { weather_code: 0, is_day: 0, temperature_2m: 7.2 }, daily: METEO.daily };

function famille(posts, extra = {}) {
  return {
    familyName: 'Mamie Jeanne', familyCode: 'ABCD-1234', textSize: '', subscription: extra.subscription || 'actif',
    options: { ...OPTIONS, ...(extra.options || {}) }, veille: { active: true, de: 21 * 60, a: 6 * 60 + 30 }, posts, // en minutes (Sync.java convertit)
  };
}

// ---------- Ce que la scène peut faire sur la page ----------

function outils(page) {
  const ev = (fn, arg) => page.evaluate(fn, arg);
  return {
    page,
    statut: (s) => ev((s) => window.Papote.onStatus(s), s),
    famille: (payload, opts = {}) => ev(({ payload, people, faces, birthdays }) => {
      window.Papote.onFamily({ people, faces, birthdays });
      window.Papote.onPosts(payload);
    }, { payload, people: opts.people || PROCHES, faces: opts.faces || VISAGES, birthdays: opts.birthdays || [] }),
    meteo: (m = METEO) => ev((m) => window.Papote.onWeather(m), m),
    rappels: (list) => ev((reminders) => window.Papote.onReminders({ reminders }), list),
    faux: (etat) => ev((e) => Object.assign(window.__faux, e), etat),
    appel: (etat, info) => ev(([s, i]) => window.__appelEnCours && window.__appelEnCours.onState(s, i), [etat, info || {}]),
    cliquer: (sel) => page.click(sel),
    attendre: (ms) => page.waitForTimeout(ms),
    avancer: async (ms) => { await page.clock.runFor(ms); await page.waitForTimeout(1500); }, // laisse finir le fondu des photos
  };
}

/** Démarrage habituel : tablette reliée, famille, météo. */
async function accueil(t, posts, extra) {
  await t.statut({ state: 'ok' });
  await t.famille(famille(posts, extra), extra);
  await t.meteo(extra?.meteo);
  if (extra?.rappels) await t.rappels(extra.rappels);
  await t.attendre(1700); // le logo du démarrage s'efface
}

// ---------- Les scènes, dans l'ordre de la galerie ----------

const RAPPEL_MEDOC = { id: 'r1', kind: 'medicament', title: 'Prendre le cachet du midi', time: '12:00', repeat: 'daily', avanceMin: 15 };
const RAPPEL_RDV = { id: 'r2', kind: 'rdv', title: 'Docteur Martin', time: '11:00', date: JOUR, repeat: 'none', avanceMin: 0 };

// Les proches avec leur numéro de téléphone (members/{uid}.telephone) : la tablette à carte SIM les appelle par la ligne.
const AVEC_TEL = PROCHES.map((p, i) => ({ ...p, tel: ['0612345678', '0687654321', '0756781234', '0611223344', '0622334455'][i], responsable: i === 0 }));
const BDAY_LEO = [{ id: 'b1', name: 'Léo', day: 26, month: 10, year: 2019 }];
const RADIO = { radio: { nom: 'France Bleu', url: 'http://127.0.0.1/radio-fausse.webm' } };

// Mamie appelle Julie (choix de la personne), par internet ou par la carte SIM selon la scène.
async function appelerJulie(t, extra) {
  await accueil(t, photosVues(), extra); await t.cliquer('.call-btn.big-btn');
  await t.page.locator('.call-person').first().click(); await t.attendre(300);
}
// Tablette à carte SIM avec le rôle Téléphone : les proches ont un numéro, l'appel part par la ligne.
async function parTelephone(t) {
  await t.faux({ gsm: true, wifi: { wifi: '', internet: true, mobile: true, sim: true, via: 'mobile' } });
}
// Code postal tapé sur le pavé de la fenêtre « Choisir la ville ».
async function taper(t, chiffres) {
  for (const k of chiffres) await t.page.locator('.digit', { hasText: new RegExp(`^${k}$`) }).first().click();
  await t.attendre(800);
}
const gsm = (t, etat) => t.page.evaluate((e) => window.Papote.onGsm(e), etat);
async function sos(t, extra) { await accueil(t, photosVues(), extra); await t.cliquer('#sos-btn'); }
// Visio reçue (appels.js n'est pas chargé : l'écran est rempli à la main comme il le ferait).
async function sonnerieVisio(t, regarde) {
  await accueil(t, photosVues());
  await t.page.evaluate(({ face, regarde }) => {
    document.getElementById('ring-name').textContent = 'Julie';
    const img = document.getElementById('ring-caller'); img.src = face; img.hidden = false;
    if (regarde) {
      const v = document.getElementById('ring-face'); v.src = 'faux.webm'; v.loop = true; v.hidden = false; v.play().catch(() => {});
      document.getElementById('ring-hint').hidden = false;
    }
    document.getElementById('call-ring').hidden = false;
  }, { face: VISAGES['u-julie'], regarde });
  await t.attendre(600);
}
async function visio(t, etat) {
  await accueil(t, photosVues());
  await t.page.evaluate(({ face, etat }) => {
    const $ = (id) => document.getElementById(id);
    $('call-wait-name').textContent = 'Julie';
    $('call-wait-face').src = face; $('call-wait-face').hidden = false;
    $('call-view').hidden = false;
    if (etat === 'video' || etat === 'video-mamie') {
      for (const id of ['call-remote', 'call-local']) { const v = $(id); v.src = 'faux.webm'; v.loop = true; v.muted = true; v.play().catch(() => {}); }
      $('call-wait').hidden = true;
      $('call-out-hangup').hidden = etat !== 'video-mamie';
    } else {
      $('call-status').textContent = etat; $('call-wait').hidden = false;
    }
  }, { face: VISAGES['u-julie'], etat });
  await t.attendre(1200);
}

const SCENES = [
  // Démarrage et première installation
  { groupe: 'Démarrage et installation', titre: 'Logo du démarrage', note: 'Avant les premières nouvelles de l’app Android.',
    faire: async (t) => { await t.attendre(300); } },
  { groupe: 'Démarrage et installation', titre: 'Bienvenue (étape 1)', faire: async (t) => { await t.statut({ state: 'welcome', step: 'start' }); await t.attendre(1600); } },
  { groupe: 'Démarrage et installation', titre: 'Nom de la personne (ancienne étape)', note: 'Étape « name » encore dans bienvenue.js, si Android la demande.', faire: async (t) => {
    await t.statut({ state: 'welcome', step: 'name' }); await t.attendre(1600);
  } },
  { groupe: 'Démarrage et installation', titre: 'Choisir le wifi (étape 2)', faire: async (t) => {
    await t.faux({ wifi: { wifi: '', internet: false } });
    await t.statut({ state: 'welcome', step: 'wifi' }); await t.attendre(1600);
  } },
  { groupe: 'Démarrage et installation', titre: 'Liste des wifi', faire: async (t) => {
    await t.faux({ wifi: { wifi: '', internet: false } });
    await t.statut({ state: 'welcome', step: 'wifi' }); await t.attendre(1600);
    await t.page.getByText('Choisir un réseau').click(); await t.attendre(3500);
  } },
  { groupe: 'Démarrage et installation', titre: 'Mot de passe du wifi', faire: async (t) => {
    await t.faux({ wifi: { wifi: '', internet: false } });
    await t.statut({ state: 'welcome', step: 'wifi' }); await t.attendre(1600);
    await t.page.getByText('Choisir un réseau').click(); await t.attendre(3500);
    await t.page.locator('.network').first().click(); await t.attendre(600);
  } },
  { groupe: 'Démarrage et installation', titre: 'Wifi : connexion en cours', faire: async (t) => {
    await t.faux({ wifi: { wifi: '', internet: false } });
    await t.statut({ state: 'welcome', step: 'wifi' }); await t.attendre(1600);
    await t.page.getByText('Choisir un réseau').click(); await t.attendre(3500);
    await t.page.locator('.network').first().click(); await t.attendre(600);
    await t.page.locator('input').first().fill('motdepasse'); await t.page.getByText('Se connecter').click(); await t.attendre(800);
  } },
  { groupe: 'Démarrage et installation', titre: 'Wifi : mauvais mot de passe', note: 'Au bout de 30 s sans internet.', faire: async (t) => {
    await t.faux({ wifi: { wifi: '', internet: false, mobile: true } }); // mobile : l'écran du wifi « réparation » ne s'ouvre pas par-dessus
    await t.statut({ state: 'welcome', step: 'wifi' }); await t.attendre(1600);
    await t.page.getByText('Choisir un réseau').click(); await t.attendre(3500);
    await t.page.locator('.network').first().click(); await t.attendre(600);
    await t.page.locator('input').first().fill('motdepasse'); await t.page.getByText('Se connecter').click();
    await t.avancer(33000);
  } },
  { groupe: 'Démarrage et installation', titre: 'Wifi : c’est bon, la tablette a internet', faire: async (t) => {
    await t.faux({ wifi: { wifi: '', internet: false } });
    await t.statut({ state: 'welcome', step: 'wifi' }); await t.attendre(1600);
    await t.page.getByText('Choisir un réseau').click(); await t.attendre(3500);
    await t.page.locator('.network').first().click(); await t.attendre(600);
    await t.page.locator('input').first().fill('motdepasse'); await t.page.getByText('Se connecter').click();
    await t.faux({ wifi: { wifi: 'Livebox-6A2F', internet: true } }); await t.page.clock.runFor(1600); await t.attendre(300);
  } },
  { groupe: 'Démarrage et installation', titre: 'Wifi connecté', faire: async (t) => {
    await t.statut({ state: 'welcome', step: 'wifi' }); await t.attendre(1600);
  } },
  { groupe: 'Démarrage et installation', titre: 'La météo : choisir la ville', faire: async (t) => {
    await t.statut({ state: 'welcome', step: 'meteo' }); await t.attendre(1600);
  } },
  { groupe: 'Démarrage et installation', titre: 'La météo : code postal à taper', faire: async (t) => {
    await t.statut({ state: 'welcome', step: 'meteo' }); await t.attendre(1600);
    await t.page.getByText('Choisir la ville').click(); await t.attendre(600);
    await taper(t, '07');
  } },
  { groupe: 'Démarrage et installation', titre: 'La météo : villes du code postal', faire: async (t) => {
    await t.statut({ state: 'welcome', step: 'meteo' }); await t.attendre(1600);
    await t.page.getByText('Choisir la ville').click(); await t.attendre(600);
    await taper(t, '07160');
  } },
  { groupe: 'Démarrage et installation', titre: 'La météo : aucune ville pour ce code', faire: async (t) => {
    await t.statut({ state: 'welcome', step: 'meteo' }); await t.attendre(1600);
    await t.page.getByText('Choisir la ville').click(); await t.attendre(600);
    await taper(t, '99999');
  } },
  { groupe: 'Démarrage et installation', titre: 'La météo : ville choisie', faire: async (t) => {
    await t.statut({ state: 'welcome', step: 'meteo' }); await t.attendre(1600);
    await t.page.getByText('Choisir la ville').click(); await t.attendre(600);
    await taper(t, '07160'); await t.page.locator('.network').first().click(); await t.attendre(600);
  } },
  { groupe: 'Démarrage et installation', titre: 'QR code et code à taper (étape 3)', faire: async (t) => {
    await t.statut({ state: 'welcome', step: 'pair', code: 'K7PM2Q' }); await t.attendre(1600);
  } },
  { groupe: 'Démarrage et installation', titre: 'Code faux ou expiré', faire: async (t) => {
    await t.statut({ state: 'welcome', step: 'pair', code: 'K7PM2Q', error: 'Ce code a expiré. Un nouveau code est affiché.' }); await t.attendre(1600);
  } },
  { groupe: 'Démarrage et installation', titre: 'Un proche termine sur son téléphone', faire: async (t) => {
    await t.statut({ state: 'welcome', step: 'pair', code: 'K7PM2Q', claimedName: 'Julie', reprendre: true }); await t.attendre(1600);
  } },
  { groupe: 'Démarrage et installation', titre: 'Recommencer avec un autre téléphone', faire: async (t) => {
    await t.statut({ state: 'welcome', step: 'pair', code: 'K7PM2Q', restart: true }); await t.attendre(1600);
  } },
  { groupe: 'Démarrage et installation', titre: 'Recommencer : touchez encore', faire: async (t) => {
    await t.statut({ state: 'welcome', step: 'pair', code: 'K7PM2Q', restart: true }); await t.attendre(1600);
    await t.page.getByText('Recommencer avec un autre téléphone').click(); await t.attendre(400);
  } },
  { groupe: 'Démarrage et installation', titre: 'On prépare votre tablette', faire: async (t) => {
    await t.statut({ state: 'welcome', step: 'prepare', claimedName: 'Julie' }); await t.attendre(1600);
  } },
  { groupe: 'Démarrage et installation', titre: 'Tablette de remplacement : c’est bien vous ?', faire: async (t) => {
    await t.statut({ state: 'welcome', step: 'confirm', claimedName: 'Julie', familyName: 'Mamie Jeanne' }); await t.attendre(1600);
  } },
  { groupe: 'Démarrage et installation', titre: 'Placez la tablette (caméra)', note: 'Caméra simulée (mire de test) : pas de vrai visage à trouver.', faire: async (t) => {
    await t.statut({ state: 'welcome', step: 'confirm', claimedName: 'Julie', familyName: 'Mamie Jeanne' }); await t.attendre(1600);
    await t.page.getByText('Oui', { exact: true }).click(); await t.attendre(2500);
  } },
  { groupe: 'Démarrage et installation', titre: 'Tablette pas encore reliée', faire: async (t) => {
    await t.statut({ state: 'setup', message: 'Code tablette : K7PM2Q' }); await t.attendre(1600);
  } },

  // Accueil
  { groupe: 'Accueil', titre: 'Accueil sans aucune photo', note: 'Famille toute neuve.', faire: async (t) => { await accueil(t, []); } },
  { groupe: 'Accueil', titre: 'Accueil avec photos et météo', note: 'Un rappel est prévu à midi : le « prochain rappel » n’est plus affiché sur l’accueil (choix du 26/10), il arrive en grand 15 min avant.', faire: async (t) => {
    await accueil(t, photosVues(), { rappels: [RAPPEL_MEDOC] });
  } },
  { groupe: 'Accueil', titre: 'Accueil avec une photo en hauteur', faire: async (t) => {
    const p = photosVues(); [p[0], p[1]] = [p[1], p[0]];
    await accueil(t, p);
  } },
  { groupe: 'Accueil', titre: 'Accueil sans SOS, sans météo, sans rappel', note: 'Options enlevées par la famille.', faire: async (t) => {
    await accueil(t, photosVues(), { options: { sos: false, meteo: false, rappelsAccueil: false }, rappels: [RAPPEL_MEDOC] });
  } },
  { groupe: 'Accueil', titre: 'Météo : pluie', faire: async (t) => {
    await accueil(t, photosVues(), { meteo: { current: { weather_code: 63, is_day: 1, temperature_2m: 9.6 }, daily: { weather_code: [63, 3], temperature_2m_max: [11, 13] } } });
  } },
  { groupe: 'Accueil', titre: 'Météo : neige et moins 3 degrés', faire: async (t) => {
    await accueil(t, photosVues(), { meteo: { current: { weather_code: 73, is_day: 1, temperature_2m: -3.2 }, daily: { weather_code: [73, 71], temperature_2m_max: [0, 1] } } });
  } },
  { groupe: 'Accueil', titre: 'Accueil avec la radio (Wi-Fi)', faire: async (t) => { await accueil(t, photosVues(), { options: RADIO }); } },
  { groupe: 'Accueil', titre: 'Radio en cours', faire: async (t) => {
    await accueil(t, photosVues(), { options: RADIO }); await t.cliquer('.radio-btn'); await t.attendre(1200);
  } },
  { groupe: 'Accueil', titre: 'Radio cachée sur la carte SIM', note: 'Radio réglée par la famille, mais la tablette est sur la carte SIM (60 Mo par heure).', faire: async (t) => {
    await t.faux({ wifi: { wifi: '', internet: true, mobile: true, sim: true, via: 'mobile' } });
    await accueil(t, photosVues(), { options: RADIO });
  } },
  { groupe: 'Accueil', titre: 'Accueil le plus chargé : radio, anniversaire, SOS', faire: async (t) => {
    await accueil(t, photosVues(), { birthdays: BDAY_LEO, options: RADIO, rappels: [RAPPEL_MEDOC] });
    await t.cliquer('#bday-ok'); await t.attendre(400);
  } },
  { groupe: 'Accueil', titre: 'Rendez-vous dans moins d’une heure', faire: async (t) => {
    await accueil(t, photosVues(), { rappels: [RAPPEL_RDV] });
  } },
  { groupe: 'Accueil', titre: 'Anniversaire : bandeau de la journée', faire: async (t) => {
    await accueil(t, photosVues(), { birthdays: BDAY_LEO });
    await t.cliquer('#bday-ok'); await t.attendre(400);
  } },
  { groupe: 'Accueil', titre: 'Deux anniversaires le même jour : bandeau', faire: async (t) => {
    await accueil(t, photosVues(), { birthdays: [...BDAY_LEO, { id: 'b2', name: 'Emma', day: 26, month: 10, year: 2015 }] });
    await t.cliquer('#bday-ok'); await t.attendre(400); await t.cliquer('#bday-ok').catch(() => {}); await t.attendre(400);
  } },
  { groupe: 'Accueil', titre: 'Pas d’internet', faire: async (t) => {
    await accueil(t, photosVues());
    await t.faux({ wifi: { wifi: '', internet: false } });
    await t.avancer(100000); await t.attendre(400);
  } },
  { groupe: 'Accueil', titre: 'Pas d’internet : régler le wifi', faire: async (t) => {
    await accueil(t, photosVues());
    await t.faux({ wifi: { wifi: '', internet: false } });
    await t.avancer(100000); await t.cliquer('.wifi-card-btn'); await t.attendre(1600);
  } },
  { groupe: 'Accueil', titre: 'Pas de réseau (tablette à carte SIM)', faire: async (t) => {
    await accueil(t, photosVues());
    await t.faux({ wifi: { wifi: '', internet: false, sim: true } });
    await t.avancer(100000); await t.attendre(400);
  } },
  { groupe: 'Accueil', titre: 'Tablette débranchée', faire: async (t) => {
    await accueil(t, photosVues());
    await t.faux({ charging: false });
    await t.avancer(90000); await t.attendre(400);
  } },
  { groupe: 'Accueil', titre: 'Papote en pause (abonnement suspendu)', faire: async (t) => {
    await accueil(t, photosVues(), { subscription: 'suspendu' });
  } },
  { groupe: 'Accueil', titre: 'Papote en pause (abonnement résilié)', faire: async (t) => {
    await accueil(t, photosVues(), { subscription: 'resilie' });
  } },

  // Soir et nuit (veille par défaut 21h-6h30, couleurs du soir deux heures avant)
  { groupe: 'Soir et nuit', titre: 'Accueil le soir (20h30)', heure: '20:30', faire: async (t) => {
    await accueil(t, photosVues(), { meteo: METEO_NUIT });
  } },
  { groupe: 'Soir et nuit', titre: 'Accueil le soir avec la radio (20h30)', heure: '20:30', faire: async (t) => {
    await accueil(t, photosVues(), { meteo: METEO_NUIT, options: RADIO });
  } },
  { groupe: 'Soir et nuit', titre: 'Nouvelle photo le soir', heure: '20:30', faire: async (t) => {
    await accueil(t, [post({ image: IMAGES.paysage(3), text: 'Bonne nuit Mamie !', seen: false, at: heure('20:28') }), ...photosVues()], { meteo: METEO_NUIT });
    await t.attendre(800);
  } },
  { groupe: 'Soir et nuit', titre: 'Diaporama le soir (voile léger)', heure: '20:30', faire: async (t) => {
    await accueil(t, photosVues(), { meteo: METEO_NUIT }); await t.cliquer('#home-frame'); await t.attendre(900);
  } },
  { groupe: 'Soir et nuit', titre: 'Veille la nuit (23h30)', heure: '23:30', faire: async (t) => {
    await accueil(t, photosVues(), { meteo: METEO_NUIT }); await t.attendre(1200);
  } },
  { groupe: 'Soir et nuit', titre: 'La nuit, un toucher rallume l’écran 2 minutes', heure: '23:30', faire: async (t) => {
    await accueil(t, photosVues(), { meteo: METEO_NUIT }); await t.attendre(1200);
    await t.page.touchscreen.tap(640, 400); await t.attendre(1200);
  } },
  { groupe: 'Soir et nuit', titre: 'Un rappel la nuit rallume l’écran', heure: '22:00', faire: async (t) => {
    await accueil(t, photosVues(), { meteo: METEO_NUIT, rappels: [{ ...RAPPEL_MEDOC, title: 'Prendre le cachet du soir', time: '22:00', avanceMin: 0 }] });
    await t.attendre(1500);
  } },
  { groupe: 'Soir et nuit', titre: 'Un envoi la nuit attend le réveil', note: 'La photo arrive à 23h30 : l’écran reste noir.', heure: '23:30', faire: async (t) => {
    await accueil(t, [post({ image: IMAGES.paysage(2), text: 'Bonne nuit !', seen: false, at: heure('23:29') }), ...photosVues()], { meteo: METEO_NUIT });
    await t.attendre(1200);
  } },

  // Nouveaux envois
  { groupe: 'Nouvel envoi', titre: 'Message court', faire: async (t) => {
    await accueil(t, [post({ text: 'Coucou Mamie, on pense fort à toi !', seen: false, at: heure('10:05') }), ...photosVues()]);
  } },
  { groupe: 'Nouvel envoi', titre: 'Message moyen', faire: async (t) => {
    await accueil(t, [post({ author: 'Anne', uid: 'u-anne', seen: false, at: heure('09:50'), text: 'Bonjour Mamie, Léo a eu 18 à sa dictée, il est très fier de lui !' }), ...photosVues()]);
  } },
  { groupe: 'Nouvel envoi', titre: 'Message long', faire: async (t) => {
    await accueil(t, [post({ author: 'Thomas', uid: 'u-thomas', seen: false, at: heure('08:40'), text: 'Bonjour Mamie ! Nous sommes bien arrivés à Lyon hier soir. Les enfants ont dormi dans la voiture. On t’appelle dimanche pour te raconter tout ça. Gros bisous de nous quatre.' }), ...photosVues()]);
  } },
  { groupe: 'Nouvel envoi', titre: 'Message d’hier', faire: async (t) => {
    await accueil(t, [post({ text: 'Bonne soirée Mamie !', seen: false, at: heure('19:40', '2026-10-25') }), ...photosVues()]);
  } },
  { groupe: 'Nouvel envoi', titre: 'Photo en largeur avec un mot', faire: async (t) => {
    await accueil(t, [post({ image: IMAGES.paysage(0), text: 'Regarde la mer !', seen: false, at: heure('10:20') }), ...photosVues()]);
    await t.attendre(600);
  } },
  { groupe: 'Nouvel envoi', titre: 'Photo en hauteur sans légende', faire: async (t) => {
    await accueil(t, [post({ image: IMAGES.portrait(2), author: 'Anne', uid: 'u-anne', seen: false, at: heure('10:20') }), ...photosVues()]);
    await t.attendre(600);
  } },
  { groupe: 'Nouvel envoi', titre: 'Photo avec une longue légende', faire: async (t) => {
    await accueil(t, [post({ image: IMAGES.paysage(4), text: 'Léo a soufflé ses sept bougies avec ses copains du foot, il était tellement content', seen: false }), ...photosVues()]);
    await t.attendre(600);
  } },
  { groupe: 'Nouvel envoi', titre: 'Plusieurs photos d’un coup (la 1re)', faire: async (t) => {
    await accueil(t, [post({ image: IMAGES.paysage(1), images: [IMAGES.portrait(2), IMAGES.paysage(3)], text: 'Le week-end à la campagne', seen: false }), ...photosVues()]);
    await t.attendre(600);
  } },
  { groupe: 'Nouvel envoi', titre: 'Plusieurs photos d’un coup (la 2e, 6 s après)', faire: async (t) => {
    await accueil(t, [post({ image: IMAGES.paysage(1), images: [IMAGES.portrait(2), IMAGES.paysage(3)], text: 'Le week-end à la campagne', seen: false }), ...photosVues()]);
    await t.avancer(6200);
  } },
  { groupe: 'Nouvel envoi', titre: 'Vidéo', note: 'Avant de toucher « Regarder » (la lecture se fait par Android).', faire: async (t) => {
    await accueil(t, [post({ type: 'video', video: 'faux.webm', text: 'Léo fait du vélo', author: 'Lucas', uid: 'u-lucas', seen: false, duration: 24 }), ...photosVues()]);
    await t.attendre(600);
  } },
  { groupe: 'Nouvel envoi', titre: 'Vidéo sans légende', faire: async (t) => {
    await accueil(t, [post({ type: 'video', video: 'faux.webm', author: 'Emma', uid: 'u-emma', seen: false, duration: 12 }), ...photosVues()]);
    await t.attendre(600);
  } },
  { groupe: 'Nouvel envoi', titre: 'Deux envois en attente : le premier', note: 'Une photo puis un message : un seul carillon, ils passent l’un après l’autre.', faire: async (t) => {
    await accueil(t, [post({ text: 'Et un gros bisou !', seen: false, at: heure('10:21') }), post({ image: IMAGES.paysage(0), text: 'Regarde la mer !', seen: false, at: heure('10:20') }), ...photosVues()]);
    await t.attendre(600);
  } },
  { groupe: 'Nouvel envoi', titre: 'Deux envois en attente : OK, le suivant', faire: async (t) => {
    await accueil(t, [post({ text: 'Et un gros bisou !', seen: false, at: heure('10:21') }), post({ image: IMAGES.paysage(0), text: 'Regarde la mer !', seen: false, at: heure('10:20') }), ...photosVues()]);
    await t.attendre(600); await t.cliquer('#overlay-close'); await t.attendre(900);
  } },

  // Diaporama
  { groupe: 'Diaporama', titre: 'Diaporama : photo en largeur', faire: async (t) => {
    await accueil(t, photosVues()); await t.cliquer('#home-frame'); await t.attendre(900);
  } },
  { groupe: 'Diaporama', titre: 'Diaporama : photo en hauteur', faire: async (t) => {
    await accueil(t, photosVues()); await t.cliquer('#home-frame'); await t.attendre(900);
    await t.cliquer('#photo-prev'); await t.attendre(1600);
  } },
  { groupe: 'Diaporama', titre: 'Diaporama : photo avec une longue légende', faire: async (t) => {
    const p = photosVues(); p[0].text = 'Léo a soufflé ses sept bougies avec ses copains du foot, il était tellement content';
    await accueil(t, p); await t.cliquer('#home-frame'); await t.attendre(900);
  } },
  { groupe: 'Diaporama', titre: 'Diaporama : vidéo en largeur', note: 'Une vidéo déjà vue revient dans le diaporama, jouée en largeur sur tout l’écran.', faire: async (t) => {
    const p = photosVues();
    p.splice(1, 0, post({ id: 'vid-vue', type: 'video', video: 'faux.webm', text: 'Léo fait du vélo', author: 'Lucas', uid: 'u-lucas', seen: true, duration: 24, at: heure('08:00') }));
    await accueil(t, p); await t.cliquer('#home-frame'); await t.attendre(900);
    await t.cliquer('#photo-prev'); await t.attendre(2500);
  } },
  { groupe: 'Diaporama', titre: 'Diaporama au calme (flèches effacées)', faire: async (t) => {
    await accueil(t, photosVues()); await t.cliquer('#home-frame'); await t.avancer(5000);
  } },

  // Rappels et anniversaires
  { groupe: 'Rappels', titre: 'Rappel annoncé 15 minutes avant', heure: '11:45', faire: async (t) => {
    await accueil(t, photosVues(), { rappels: [RAPPEL_MEDOC] }); await t.attendre(600);
  } },
  { groupe: 'Rappels', titre: 'Rappel à l’heure', heure: '12:00', faire: async (t) => {
    await accueil(t, photosVues(), { rappels: [RAPPEL_MEDOC] }); await t.attendre(600);
  } },
  { groupe: 'Rappels', titre: 'Rendez-vous à l’heure', heure: '11:00', faire: async (t) => {
    await accueil(t, photosVues(), { rappels: [RAPPEL_RDV] }); await t.attendre(600);
  } },
  { groupe: 'Rappels', titre: 'Rappel avec un titre long', heure: '12:00', faire: async (t) => {
    await accueil(t, photosVues(), { rappels: [{ ...RAPPEL_MEDOC, title: 'Prendre le cachet du midi avec un grand verre d’eau, puis la crème pour le genou' }] }); await t.attendre(600);
  } },
  { groupe: 'Rappels', titre: 'Anniversaire en plein écran', faire: async (t) => {
    await accueil(t, photosVues(), { birthdays: BDAY_LEO }); await t.attendre(400);
  } },
  { groupe: 'Rappels', titre: 'Anniversaire d’un proche de l’app (photo, bouton Appeler)', faire: async (t) => {
    await accueil(t, photosVues(), { birthdays: [{ id: 'membre-u-julie', name: 'Julie', day: 26, month: 10, year: 1988 }] }); await t.attendre(400);
  } },
  { groupe: 'Rappels', titre: 'Anniversaire avec la photo ajoutée dans l’app', faire: async (t) => {
    await accueil(t, photosVues(), { birthdays: [{ id: 'b3', name: 'Léo', day: 26, month: 10, year: 2019, photo: fauxVisage('Léo', 3) }] }); await t.attendre(400);
  } },

  // Appels de Mamie par internet (tablette Wi-Fi, ou proche sans numéro)
  { groupe: 'Appeler par internet', titre: 'Qui voulez-vous appeler ?', faire: async (t) => {
    await accueil(t, photosVues()); await t.cliquer('.call-btn.big-btn'); await t.attendre(400);
  } },
  { groupe: 'Appeler par internet', titre: 'Qui appeler : famille de 20 proches (page 1, flèches)', faire: async (t) => {
    await accueil(t, photosVues(), { people: BEAUCOUP }); await t.cliquer('.call-btn.big-btn'); await t.attendre(400);
  } },
  { groupe: 'Appeler par internet', titre: 'Qui appeler : famille de 20 proches (dernière page)', faire: async (t) => {
    await accueil(t, photosVues(), { people: BEAUCOUP }); await t.cliquer('.call-btn.big-btn'); await t.attendre(400);
    for (let i = 0; i < 6; i++) await t.cliquer('.call-arrow.right').catch(() => {});
    await t.attendre(300);
  } },
  { groupe: 'Appeler par internet', titre: 'Qui appeler : une seule personne', faire: async (t) => {
    await accueil(t, photosVues(), { people: PROCHES.slice(0, 1) }); await t.cliquer('.call-btn.big-btn'); await t.attendre(400);
  } },
  { groupe: 'Appeler par internet', titre: 'Qui appeler : personne à appeler', faire: async (t) => {
    await accueil(t, photosVues(), { people: [] }); await t.cliquer('.call-btn.big-btn'); await t.attendre(400);
  } },
  { groupe: 'Appeler par internet', titre: 'Appel vers Julie : ça part', faire: async (t) => { await appelerJulie(t); } },
  { groupe: 'Appeler par internet', titre: 'Appel vers Julie : ça sonne', faire: async (t) => { await appelerJulie(t); await t.appel('ringing'); await t.attendre(400); } },
  { groupe: 'Appeler par internet', titre: 'Appel en cours avec Julie', faire: async (t) => { await appelerJulie(t); await t.appel('connected', { name: 'Julie' }); await t.attendre(400); } },
  { groupe: 'Appeler par internet', titre: 'Julie passe en vidéo (Mamie peut raccrocher)', faire: async (t) => { await appelerJulie(t); await t.appel('connected', { name: 'Julie' }); await visio(t, 'video-mamie'); } },
  { groupe: 'Appeler par internet', titre: 'Appel terminé', faire: async (t) => { await appelerJulie(t); await t.appel('connected', { name: 'Julie' }); await t.appel('ended'); await t.attendre(400); } },
  { groupe: 'Appeler par internet', titre: 'Julie n’a pas pu répondre', faire: async (t) => { await appelerJulie(t); await t.appel('missed'); await t.attendre(400); } },
  { groupe: 'Appeler par internet', titre: 'Julie est déjà en ligne', faire: async (t) => { await appelerJulie(t); await t.appel('busy'); await t.attendre(400); } },
  { groupe: 'Appeler par internet', titre: 'L’appel n’a pas pu partir', faire: async (t) => { await appelerJulie(t); await t.appel('failed'); await t.attendre(400); } },
  { groupe: 'Appeler par internet', titre: 'L’appel n’est pas encore disponible', note: 'Les appels ne sont pas encore chargés (démarrage sans internet).', faire: async (t) => {
    await accueil(t, photosVues()); await t.page.evaluate(() => { delete window.papoteCallFamily; });
    await t.cliquer('.call-btn.big-btn'); await t.page.locator('.call-person').first().click(); await t.attendre(400);
  } },

  // Appels de Mamie par la carte SIM (chantier téléphone, 29/10)
  { groupe: 'Appeler par téléphone (carte SIM)', titre: 'Appel vers Julie par téléphone : ça part', faire: async (t) => { await parTelephone(t); await appelerJulie(t, { people: AVEC_TEL }); } },
  { groupe: 'Appeler par téléphone (carte SIM)', titre: 'Par téléphone : ça sonne chez Julie', faire: async (t) => { await parTelephone(t); await appelerJulie(t, { people: AVEC_TEL }); await gsm(t, { etat: 'appel' }); await t.attendre(300); } },
  { groupe: 'Appeler par téléphone (carte SIM)', titre: 'Par téléphone : en ligne avec Julie', faire: async (t) => { await parTelephone(t); await appelerJulie(t, { people: AVEC_TEL }); await gsm(t, { etat: 'enLigne' }); await t.attendre(300); } },
  { groupe: 'Appeler par téléphone (carte SIM)', titre: 'Par téléphone : appel terminé', faire: async (t) => { await parTelephone(t); await appelerJulie(t, { people: AVEC_TEL }); await gsm(t, { etat: 'enLigne' }); await gsm(t, { etat: 'fin' }); await t.attendre(300); } },
  { groupe: 'Appeler par téléphone (carte SIM)', titre: 'Par téléphone : Julie n’a pas pu répondre', faire: async (t) => { await parTelephone(t); await appelerJulie(t, { people: AVEC_TEL }); await gsm(t, { etat: 'fin' }); await t.attendre(300); } },
  { groupe: 'Appeler par téléphone (carte SIM)', titre: 'Par téléphone : Julie est déjà en ligne', faire: async (t) => { await parTelephone(t); await appelerJulie(t, { people: AVEC_TEL }); await gsm(t, { etat: 'fin', cause: 'occupe' }); await t.attendre(300); } },
  { groupe: 'Appeler par téléphone (carte SIM)', titre: 'Par téléphone : l’appel n’a pas pu partir', faire: async (t) => { await t.faux({ gsmRefus: true }); await parTelephone(t); await appelerJulie(t, { people: AVEC_TEL }); } },
  { groupe: 'Appeler par téléphone (carte SIM)', titre: 'Julie appelle la tablette par téléphone', faire: async (t) => { await parTelephone(t); await accueil(t, photosVues(), { people: AVEC_TEL }); await gsm(t, { etat: 'sonne', uid: 'u-julie', name: 'Julie' }); await t.attendre(400); } },
  { groupe: 'Appeler par téléphone (carte SIM)', titre: 'Julie appelle par téléphone : en ligne', faire: async (t) => { await parTelephone(t); await accueil(t, photosVues(), { people: AVEC_TEL }); await gsm(t, { etat: 'sonne', uid: 'u-julie', name: 'Julie' }); await gsm(t, { etat: 'enLigne' }); await t.attendre(400); } },
  { groupe: 'Appeler par téléphone (carte SIM)', titre: 'Appel téléphone manqué : « Julie a appelé »', faire: async (t) => { await parTelephone(t); await accueil(t, photosVues(), { people: AVEC_TEL }); await gsm(t, { etat: 'sonne', uid: 'u-julie', name: 'Julie' }); await gsm(t, { etat: 'fin' }); await t.attendre(400); } },
  { groupe: 'Appeler par téléphone (carte SIM)', titre: 'Un proche appelle la nuit : l’écran se rallume', heure: '23:30', faire: async (t) => { await parTelephone(t); await accueil(t, photosVues(), { people: AVEC_TEL, meteo: METEO_NUIT }); await t.attendre(1200); await gsm(t, { etat: 'sonne', uid: 'u-thomas', name: 'Thomas' }); await t.attendre(1200); } },

  // SOS
  { groupe: 'SOS', titre: 'SOS : décompte avant l’appel', faire: async (t) => { await sos(t); await t.attendre(300); } },
  { groupe: 'SOS', titre: 'SOS : ça sonne chez toute la famille (internet)', faire: async (t) => {
    await sos(t); await t.avancer(6000);
    await t.appel('ringing', { names: ['Julie', 'Thomas', 'Anne'] }); await t.attendre(300);
  } },
  { groupe: 'SOS', titre: 'SOS : Thomas a décroché', faire: async (t) => {
    await sos(t); await t.avancer(6000);
    await t.appel('connected', { uid: 'u-thomas', name: 'Thomas' }); await t.attendre(300);
  } },
  { groupe: 'SOS', titre: 'SOS : personne n’a répondu, famille prévenue', faire: async (t) => {
    await sos(t); await t.avancer(6000);
    await t.appel('missed'); await t.appel('missed'); await t.attendre(300);
  } },
  { groupe: 'SOS', titre: 'SOS par téléphone : SMS envoyé, appel du responsable', faire: async (t) => {
    await parTelephone(t); await sos(t, { people: AVEC_TEL }); await t.avancer(6000); await t.attendre(300);
  } },
  { groupe: 'SOS', titre: 'SOS par téléphone : ça sonne chez Julie', faire: async (t) => {
    await parTelephone(t); await sos(t, { people: AVEC_TEL }); await t.avancer(6000); await gsm(t, { etat: 'appel' }); await t.attendre(300);
  } },
  { groupe: 'SOS', titre: 'SOS par téléphone : Julie ne répond pas, on appelle Thomas', faire: async (t) => {
    await parTelephone(t); await sos(t, { people: AVEC_TEL }); await t.avancer(6000); await gsm(t, { etat: 'fin' }); await gsm(t, { etat: 'appel' }); await t.attendre(300);
  } },
  { groupe: 'SOS', titre: 'SOS par téléphone : personne n’a décroché', note: 'Sans les appels par internet : « La famille est prévenue ».', faire: async (t) => {
    await parTelephone(t); await sos(t, { people: AVEC_TEL.slice(0, 2) }); await t.page.evaluate(() => { delete window.papoteCallFamily; });
    await t.avancer(6000); await gsm(t, { etat: 'fin' }); await gsm(t, { etat: 'fin' }); await t.attendre(300);
  } },

  // Visio reçue d'un proche (appels.js)
  { groupe: 'Visio reçue', titre: 'Julie appelle en visio', note: 'Écrans remplis à la main (le vrai vient d’appels.js, qui a besoin de Firebase).', faire: async (t) => { await sonnerieVisio(t, false); } },
  { groupe: 'Visio reçue', titre: 'Julie appelle : Mamie regarde l’écran pour décrocher', faire: async (t) => { await sonnerieVisio(t, true); } },
  { groupe: 'Visio reçue', titre: 'Visio : connexion…', faire: async (t) => { await visio(t, 'Connexion…'); } },
  { groupe: 'Visio reçue', titre: 'Visio en cours', note: 'Mire de test à la place des visages.', faire: async (t) => { await visio(t, 'video'); } },
  { groupe: 'Visio reçue', titre: 'Visio sans image (forfait SIM presque fini)', faire: async (t) => { await visio(t, 'Appel sans image'); } },
  { groupe: 'Visio reçue', titre: 'Visio : la caméra ne répond pas', faire: async (t) => { await visio(t, 'La caméra ne répond pas.'); } },
  { groupe: 'Visio reçue', titre: 'Visio : l’appel n’a pas pu se faire', faire: async (t) => { await visio(t, 'L’appel n’a pas pu se faire.'); } },
  { groupe: 'Visio reçue', titre: 'Visio terminée', faire: async (t) => { await visio(t, 'Appel terminé'); } },
];

// Fausse app Android, posée avant le chargement de la page.
function fausseAndroid(qr) {
  window.__faux = { wifi: { wifi: 'Livebox-6A2F', internet: true }, charging: true };
  const rien = () => {};
  window.PapoteAndroid = new Proxy({
    wifiStatus: () => JSON.stringify(window.__faux.wifi),
    wifiScan: () => JSON.stringify([
      { ssid: 'Livebox-6A2F', level: 4, secure: true }, { ssid: 'Freebox-Voisin', level: 2, secure: true },
      { ssid: 'SFR_WiFi_FON', level: 1, secure: false },
    ]),
    isCharging: () => window.__faux.charging,
    qrCode: () => qr,
    // Carte SIM avec le rôle Téléphone (AppelGsm.java) : l'appel « part » sans rien composer.
    phoneReady: () => !!window.__faux.gsm,
    phoneCall: () => !window.__faux.gsmRefus,
    phoneState: () => '{}',
    meteoSearch: (cp) => JSON.stringify(cp === '07160' ? [
      { nom: 'Le Cheylard', detail: '07160 · Ardèche', lat: 44.91, lon: 4.42 },
      { nom: 'Saint-Christol', detail: '07160 · Ardèche', lat: 44.87, lon: 4.42 },
      { nom: 'Mariac', detail: '07160 · Ardèche', lat: 44.89, lon: 4.39 },
    ] : []),
  }, { get: (o, k) => (k in o ? o[k] : (...a) => { (window.__android || (window.__android = [])).push(String(k)); return rien(...a); }) });
  // Appels : on garde la main pour faire passer l'appel par ses états (ça sonne, en ligne…).
  // La caméra « ne voit personne » : un envoi reste affiché comme quand Mamie n'est pas devant.
  window.papoteWatchPresence = () => rien;
  window.papoteCallFamily = (opts) => { (window.__android || (window.__android = [])).push('papoteCallFamily'); window.__appelEnCours = opts; return { hangup: rien }; };
}

// Ouvre l'écran d'une scène dans un nouveau navigateur : fausse app Android, internet coupé.
async function ouvrir(browser, base, scene, taille, video) {
  const ctx = await browser.newContext({
    viewport: { width: taille.width, height: taille.height }, locale: 'fr-FR', timezoneId: 'Europe/Paris',
    hasTouch: true, permissions: [],
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000); // un bouton absent : erreur signalée vite, pas après 30 s
  const erreurs = [];
  page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
  await page.clock.install({ time: new Date(`${JOUR}T${scene.heure || '10:30'}:00+01:00`) });
  await page.addInitScript(fausseAndroid, fauxQr());
  // Les appels vidéo (Firebase, caméra) ne sont pas chargés : la scène joue leur rôle.
  await page.route(/faux\.webm|radio-fausse\.webm/, (r) => r.fulfill({ contentType: 'video/webm', body: video || Buffer.alloc(0) }));
  await page.route('**/appels.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  try {
    await page.goto(`${base}/tablette.html`);
    await scene.faire(outils(page));
  } catch (e) {
    erreurs.push('Scène : ' + e.message.split('\n')[0]);
  }
  return { ctx, page, erreurs };
}

async function capturer({ browser, base, dossierImages, progression }) {
  const video = await fausseVideo(browser);
  const travaux = [];
  let n = 0;
  for (const scene of SCENES) for (const taille of TAILLES) travaux.push({ scene, taille, n: ++n });
  const resultats = [];
  let faits = 0;
  // Quatre écrans à la fois : chaque capture attend surtout des animations.
  async function ouvrier() {
    for (let job = travaux.shift(); job; job = travaux.shift()) {
      const { scene, taille, n } = job;
      const { ctx, page, erreurs } = await ouvrir(browser, base, scene, taille, video);
      const fichier = `tablette-${String(n).padStart(3, '0')}.jpg`;
      await page.screenshot({ path: `${dossierImages}/${fichier}`, type: 'jpeg', quality: 70 });
      resultats.push({ n, groupe: scene.groupe, titre: scene.titre, note: scene.note, taille: taille.nom, fichier, erreurs, scene: SCENES.indexOf(scene) });
      await ctx.close();
      progression(`tablette ${++faits}/${n0}`);
    }
  }
  const n0 = travaux.length;
  await Promise.all([ouvrier(), ouvrier(), ouvrier(), ouvrier()]);
  return resultats.sort((a, b) => a.n - b.n);
}

module.exports = { capturer, ouvrir, SCENES, TAILLES };
