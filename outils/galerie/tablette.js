// Écrans de la tablette (android/app/src/main/assets) : la page est ouverte comme dans la WebView,
// avec une fausse app Android (window.PapoteAndroid) qui lui donne de fausses données.
'use strict';

const { fausseImage, fauxVisage, fauxQr } = require('./commun');

const TAILLES = [
  { nom: 'paysage', width: 1280, height: 800 },
  { nom: 'portrait', width: 800, height: 1280 },
];

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
    options: { ...OPTIONS, ...(extra.options || {}) }, veille: { active: true, de: 23, a: 7 }, posts,
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

const SCENES = [
  // Démarrage et première installation
  { groupe: 'Démarrage et installation', titre: 'Logo du démarrage', note: 'Avant les premières nouvelles de l’app Android.',
    faire: async (t) => { await t.attendre(300); } },
  { groupe: 'Démarrage et installation', titre: 'Bienvenue (étape 1)', faire: async (t) => { await t.statut({ state: 'welcome', step: 'start' }); await t.attendre(1600); } },
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
  { groupe: 'Démarrage et installation', titre: 'Wifi connecté', faire: async (t) => {
    await t.statut({ state: 'welcome', step: 'wifi' }); await t.attendre(1600);
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
  { groupe: 'Démarrage et installation', titre: 'On prépare votre tablette', faire: async (t) => {
    await t.statut({ state: 'welcome', step: 'prepare', claimedName: 'Julie' }); await t.attendre(1600);
  } },
  { groupe: 'Démarrage et installation', titre: 'Tablette de remplacement : c’est bien vous ?', faire: async (t) => {
    await t.statut({ state: 'welcome', step: 'confirm', claimedName: 'Julie', familyName: 'Mamie Jeanne' }); await t.attendre(1600);
  } },
  { groupe: 'Démarrage et installation', titre: 'Tablette pas encore reliée', faire: async (t) => {
    await t.statut({ state: 'setup', message: 'Code tablette : K7PM2Q' }); await t.attendre(1600);
  } },

  // Accueil
  { groupe: 'Accueil', titre: 'Accueil sans aucune photo', note: 'Famille toute neuve.', faire: async (t) => { await accueil(t, []); } },
  { groupe: 'Accueil', titre: 'Accueil avec photos, météo et prochain rappel', faire: async (t) => {
    await accueil(t, photosVues(), { rappels: [RAPPEL_MEDOC] });
  } },
  { groupe: 'Accueil', titre: 'Accueil avec une photo en hauteur', faire: async (t) => {
    const p = photosVues(); [p[0], p[1]] = [p[1], p[0]];
    await accueil(t, p);
  } },
  { groupe: 'Accueil', titre: 'Accueil sans SOS, sans météo, sans rappel', note: 'Options enlevées par la famille.', faire: async (t) => {
    await accueil(t, photosVues(), { options: { sos: false, meteo: false, rappelsAccueil: false }, rappels: [RAPPEL_MEDOC] });
  } },
  { groupe: 'Accueil', titre: 'Rendez-vous dans moins d’une heure', faire: async (t) => {
    await accueil(t, photosVues(), { rappels: [RAPPEL_RDV] });
  } },
  { groupe: 'Accueil', titre: 'Anniversaire : bandeau de la journée', faire: async (t) => {
    await accueil(t, photosVues(), { birthdays: [{ id: 'b1', name: 'Léo', day: 26, month: 10, year: 2019 }] });
    await t.cliquer('#bday-ok'); await t.attendre(400);
  } },
  { groupe: 'Accueil', titre: 'Pas d’internet', faire: async (t) => {
    await accueil(t, photosVues());
    await t.faux({ wifi: { wifi: '', internet: false } });
    await t.avancer(100000); await t.attendre(400);
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
  { groupe: 'Soir et nuit', titre: 'Accueil le soir (21h30)', heure: '21:30', faire: async (t) => {
    await accueil(t, photosVues(), { meteo: METEO_NUIT });
  } },
  { groupe: 'Soir et nuit', titre: 'Veille la nuit (23h30)', heure: '23:30', faire: async (t) => {
    await accueil(t, photosVues(), { meteo: METEO_NUIT }); await t.attendre(1200);
  } },
  { groupe: 'Soir et nuit', titre: 'Nouvelle photo le soir', heure: '21:30', faire: async (t) => {
    await accueil(t, [post({ image: IMAGES.paysage(3), text: 'Bonne nuit Mamie !', seen: false, at: heure('21:28') }), ...photosVues()], { meteo: METEO_NUIT });
    await t.attendre(800);
  } },

  // Nouveaux envois
  { groupe: 'Nouvel envoi', titre: 'Message court', faire: async (t) => {
    await accueil(t, [post({ text: 'Coucou Mamie, on pense fort à toi !', seen: false, at: heure('10:05') }), ...photosVues()]);
  } },
  { groupe: 'Nouvel envoi', titre: 'Message long', faire: async (t) => {
    await accueil(t, [post({ author: 'Thomas', uid: 'u-thomas', seen: false, at: heure('08:40'), text: 'Bonjour Mamie ! Nous sommes bien arrivés à Lyon hier soir. Les enfants ont dormi dans la voiture. On t’appelle dimanche pour te raconter tout ça. Gros bisous de nous quatre.' }), ...photosVues()]);
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
  { groupe: 'Nouvel envoi', titre: 'Plusieurs photos d’un coup', faire: async (t) => {
    await accueil(t, [post({ image: IMAGES.paysage(1), images: [IMAGES.portrait(2), IMAGES.paysage(3)], text: 'Le week-end à la campagne', seen: false }), ...photosVues()]);
    await t.attendre(600);
  } },
  { groupe: 'Nouvel envoi', titre: 'Vidéo', note: 'Avant de toucher « Regarder » (la lecture se fait par Android).', faire: async (t) => {
    await accueil(t, [post({ type: 'video', video: 'faux.webm', text: 'Léo fait du vélo', author: 'Lucas', uid: 'u-lucas', seen: false, duration: 24 }), ...photosVues()]);
    await t.attendre(600);
  } },

  // Diaporama
  { groupe: 'Diaporama', titre: 'Diaporama : photo en largeur', faire: async (t) => {
    await accueil(t, photosVues()); await t.cliquer('#home-frame'); await t.attendre(900);
  } },
  { groupe: 'Diaporama', titre: 'Diaporama : photo en hauteur', faire: async (t) => {
    await accueil(t, photosVues()); await t.cliquer('#home-frame'); await t.attendre(900);
    await t.cliquer('#photo-prev'); await t.attendre(1600);
  } },

  // Rappels
  { groupe: 'Rappels', titre: 'Rappel annoncé 15 minutes avant', heure: '11:45', faire: async (t) => {
    await accueil(t, photosVues(), { rappels: [RAPPEL_MEDOC] }); await t.attendre(600);
  } },
  { groupe: 'Rappels', titre: 'Rappel à l’heure', heure: '12:00', faire: async (t) => {
    await accueil(t, photosVues(), { rappels: [RAPPEL_MEDOC] }); await t.attendre(600);
  } },
  { groupe: 'Rappels', titre: 'Anniversaire en plein écran', faire: async (t) => {
    await accueil(t, photosVues(), { birthdays: [{ id: 'b1', name: 'Léo', day: 26, month: 10, year: 2019 }] }); await t.attendre(400);
  } },

  // Appels
  { groupe: 'Appels', titre: 'Qui voulez-vous appeler ?', faire: async (t) => {
    await accueil(t, photosVues()); await t.cliquer('.call-btn.big-btn'); await t.attendre(400);
  } },
  { groupe: 'Appels', titre: 'Qui appeler : une seule personne', faire: async (t) => {
    await accueil(t, photosVues(), { people: PROCHES.slice(0, 1) }); await t.cliquer('.call-btn.big-btn'); await t.attendre(400);
  } },
  { groupe: 'Appels', titre: 'Appel vers Julie : ça sonne', faire: async (t) => {
    await accueil(t, photosVues()); await t.cliquer('.call-btn.big-btn');
    await t.page.locator('.call-person').first().click(); await t.appel('ringing'); await t.attendre(400);
  } },
  { groupe: 'Appels', titre: 'Appel en cours avec Julie', faire: async (t) => {
    await accueil(t, photosVues()); await t.cliquer('.call-btn.big-btn');
    await t.page.locator('.call-person').first().click(); await t.appel('connected', { name: 'Julie' }); await t.attendre(400);
  } },
  { groupe: 'Appels', titre: 'Julie n’a pas pu répondre', faire: async (t) => {
    await accueil(t, photosVues()); await t.cliquer('.call-btn.big-btn');
    await t.page.locator('.call-person').first().click(); await t.appel('missed'); await t.attendre(400);
  } },
  { groupe: 'Appels', titre: 'Appel entrant', note: 'Écran rempli à la main (le vrai vient d’appels.js).', faire: async (t) => {
    await accueil(t, photosVues());
    await t.page.evaluate((face) => {
      document.getElementById('ring-name').textContent = 'Julie';
      const img = document.getElementById('ring-caller'); img.src = face; img.hidden = false;
      document.getElementById('call-ring').hidden = false;
    }, VISAGES['u-julie']);
    await t.attendre(400);
  } },
  { groupe: 'Appels', titre: 'SOS : décompte avant l’appel', faire: async (t) => {
    await accueil(t, photosVues()); await t.cliquer('#sos-btn'); await t.attendre(300);
  } },
  { groupe: 'Appels', titre: 'SOS : ça sonne chez toute la famille', faire: async (t) => {
    await accueil(t, photosVues()); await t.cliquer('#sos-btn'); await t.avancer(6000);
    await t.appel('ringing', { names: ['Julie', 'Thomas', 'Anne'] }); await t.attendre(300);
  } },
  { groupe: 'Appels', titre: 'SOS : personne n’a répondu, famille prévenue', faire: async (t) => {
    await accueil(t, photosVues()); await t.cliquer('#sos-btn'); await t.avancer(6000);
    await t.appel('missed'); await t.appel('missed'); await t.attendre(300);
  } },
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
  }, { get: (o, k) => (k in o ? o[k] : rien) });
  // Appels : on garde la main pour faire passer l'appel par ses états (ça sonne, en ligne…).
  // La caméra « ne voit personne » : un envoi reste affiché comme quand Mamie n'est pas devant.
  window.papoteWatchPresence = () => rien;
  window.papoteCallFamily = (opts) => { window.__appelEnCours = opts; return { hangup: rien }; };
}

// Une petite vidéo de 2 secondes (un soleil qui bouge), fabriquée par le navigateur lui-même.
async function fausseVideo(browser) {
  const page = await browser.newPage();
  const b64 = await page.evaluate(() => new Promise((resolve) => {
    const c = document.createElement('canvas'); c.width = 640; c.height = 360;
    const g = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(25), { mimeType: 'video/webm' });
    const morceaux = [];
    rec.ondataavailable = (e) => morceaux.push(e.data);
    rec.onstop = () => { const r = new FileReader(); r.onload = () => resolve(r.result.split(',')[1]); r.readAsDataURL(new Blob(morceaux)); };
    let i = 0;
    const dessin = setInterval(() => {
      g.fillStyle = '#7dd3fc'; g.fillRect(0, 0, 640, 360);
      g.fillStyle = '#65a30d'; g.fillRect(0, 250, 640, 110);
      g.fillStyle = '#fde047'; g.beginPath(); g.arc(80 + i * 8, 100, 40, 0, 7); g.fill();
      g.fillStyle = '#0f172a'; g.font = '28px sans-serif'; g.fillText('Vidéo', 20, 340); i++;
    }, 40);
    rec.start();
    setTimeout(() => { clearInterval(dessin); rec.stop(); }, 2000);
  }));
  await page.close();
  return Buffer.from(b64, 'base64');
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
      const ctx = await browser.newContext({
        viewport: { width: taille.width, height: taille.height }, locale: 'fr-FR', timezoneId: 'Europe/Paris',
        hasTouch: true, permissions: [],
      });
      const page = await ctx.newPage();
      const erreurs = [];
      page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
      await page.clock.install({ time: new Date(`${JOUR}T${scene.heure || '10:30'}:00+01:00`) });
      await page.addInitScript(fausseAndroid, fauxQr());
      // Les appels vidéo (Firebase, caméra) ne sont pas chargés : la scène joue leur rôle.
      await page.route('**/faux.webm', (r) => r.fulfill({ contentType: 'video/webm', body: video }));
      await page.route('**/appels.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
      await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
      await page.goto(`${base}/tablette.html`);
      try {
        await scene.faire(outils(page));
      } catch (e) {
        erreurs.push('Scène : ' + e.message.split('\n')[0]);
      }
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

module.exports = { capturer, SCENES };
