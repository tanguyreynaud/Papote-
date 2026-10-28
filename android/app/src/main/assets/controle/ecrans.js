// Passage des écrans sur la vraie tablette (installation\passage-ecrans.ps1) : ControleActivity ouvre
// tablette.html?controle=N avec ce script en tête de page. Il remplace l'app Android par une fausse
// (fausse famille « Mamie Jeanne », comme la galerie outils/galerie/tablette.js, mêmes scènes et mêmes
// titres), joue la scène N puis prévient le PC, qui fait la capture d'écran.
// Aucun pont vers l'app, internet coupé par ControleActivity : rien ne part vers Firebase ni la famille.
(function () {
  'use strict';
  var N = parseInt(new URLSearchParams(location.search).get('controle'), 10) || 1;
  var erreurs = [];
  window.addEventListener('error', function (e) { erreurs.push(String(e.message)); });
  window.addEventListener('unhandledrejection', function (e) { erreurs.push(String(e.reason && e.reason.message || e.reason)); });

  // Stockage du navigateur à part : la vraie page de la tablette partage le même (anniversaires vus).
  var memoire = {};
  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: {
      getItem: function (k) { return k in memoire ? memoire[k] : null; },
      setItem: function (k, v) { memoire[k] = String(v); },
      removeItem: function (k) { delete memoire[k]; },
      clear: function () { memoire = {}; }
    } });
  } catch (e) { /* tant pis : seules les clés « bday-…-b1 » de la fausse famille y passent */ }

  // ---------- Fausses images (mêmes dessins que outils/galerie/commun.js) ----------

  function svg64(s) { return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(s))); }
  var PAYSAGES = [
    ['#7dd3fc', '#e0f2fe', '#65a30d', '#3f6212', '#fde047'],
    ['#fca5a5', '#fde68a', '#0e7490', '#155e75', '#fff7ed'],
    ['#a5b4fc', '#e0e7ff', '#a16207', '#713f12', '#fef9c3'],
    ['#86efac', '#f0fdf4', '#1d4ed8', '#1e3a8a', '#fef08a'],
    ['#f9a8d4', '#fdf2f8', '#7c3aed', '#4c1d95', '#fffbeb']
  ];
  function fausseImage(n, w, h) {
    var c = PAYSAGES[n % PAYSAGES.length];
    return svg64('<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
      '<defs><linearGradient id="c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + c[0] + '"/><stop offset="1" stop-color="' + c[1] + '"/></linearGradient></defs>' +
      '<rect width="' + w + '" height="' + h + '" fill="url(#c)"/>' +
      '<circle cx="' + w * 0.72 + '" cy="' + h * 0.3 + '" r="' + Math.min(w, h) * 0.09 + '" fill="' + c[4] + '"/>' +
      '<path d="M0 ' + h * 0.7 + ' Q ' + w * 0.25 + ' ' + h * 0.52 + ' ' + w * 0.5 + ' ' + h * 0.68 + ' T ' + w + ' ' + h * 0.62 + ' V ' + h + ' H 0 Z" fill="' + c[2] + '"/>' +
      '<path d="M0 ' + h * 0.84 + ' Q ' + w * 0.35 + ' ' + h * 0.7 + ' ' + w * 0.7 + ' ' + h * 0.86 + ' T ' + w + ' ' + h * 0.8 + ' V ' + h + ' H 0 Z" fill="' + c[3] + '"/>' +
      '<text x="' + w * 0.06 + '" y="' + h * 0.14 + '" font-family="sans-serif" font-size="' + Math.min(w, h) * 0.07 + '" fill="#0f172a" opacity=".45">Photo ' + (n + 1) + ' · ' + (w > h ? 'paysage' : 'portrait') + '</text></svg>');
  }
  var TEINTES = ['#4f46e5', '#0891b2', '#be185d', '#15803d', '#7c3aed', '#b45309'];
  function fauxVisage(nom, n) {
    var t = TEINTES[n % TEINTES.length];
    return svg64('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="400" height="400" fill="' + t + '"/>' +
      '<circle cx="200" cy="160" r="80" fill="#fff" opacity=".85"/><path d="M60 400c10-90 70-140 140-140s130 50 140 140z" fill="#fff" opacity=".85"/>' +
      '<text x="200" y="185" text-anchor="middle" font-family="sans-serif" font-weight="700" font-size="80" fill="' + t + '">' + nom.charAt(0) + '</text></svg>');
  }
  function fauxQr() {
    var x = 7, cases = '';
    function rnd() { x = (x * 16807) % 2147483647; return x / 2147483647; }
    for (var i = 0; i < 29; i++) for (var j = 0; j < 29; j++) {
      var coin = (i < 8 && j < 8) || (i < 8 && j > 20) || (i > 20 && j < 8);
      if (!coin && rnd() > 0.5) cases += '<rect x="' + j + '" y="' + i + '" width="1" height="1"/>';
    }
    function oeil(a, b) { return '<rect x="' + a + '" y="' + b + '" width="7" height="7"/><rect x="' + (a + 1) + '" y="' + (b + 1) + '" width="5" height="5" fill="#fff"/><rect x="' + (a + 2) + '" y="' + (b + 2) + '" width="3" height="3"/>'; }
    return svg64('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 33 33" width="330" height="330"><rect x="-2" y="-2" width="33" height="33" fill="#fff"/><g fill="#000">' + cases + oeil(0, 0) + oeil(22, 0) + oeil(0, 22) + '</g></svg>');
  }

  // ---------- La fausse famille (comme outils/galerie/tablette.js) ----------

  var JOUR = '2026-10-26';
  function heure(hm, jour) { return new Date((jour || JOUR) + 'T' + hm + ':00+01:00').getTime(); }
  var PROCHES = [
    { uid: 'u-julie', name: 'Julie' }, { uid: 'u-thomas', name: 'Thomas' }, { uid: 'u-anne', name: 'Anne' },
    { uid: 'u-lucas', name: 'Lucas' }, { uid: 'u-emma', name: 'Emma' }
  ];
  var VISAGES = {};
  PROCHES.forEach(function (p, i) { VISAGES[p.uid] = fauxVisage(p.name, i); });
  var IMAGES = {
    paysage: function (n) { return fausseImage(n, 1600, 1200); },
    portrait: function (n) { return fausseImage(n, 1200, 1600); }
  };
  var nPost = 0;
  function post(o) {
    nPost++;
    return {
      id: o.id || 'p' + nPost, type: o.type || (o.image ? 'photo' : 'message'), text: o.text || '',
      authorName: o.author || 'Julie', authorUid: o.uid || 'u-julie', createdAt: o.at || heure('09:12'),
      seen: o.seen !== false, hearts: 0, image: o.image || null, images: o.images || [], audio: o.audio || null,
      video: o.video || null, voice: null, announce: null, duration: o.duration || 0
    };
  }
  function photosVues() {
    var out = [];
    for (var i = 0; i < 8; i++) {
      out.push(post({
        id: 'vue' + i, image: (i % 3 === 1 ? IMAGES.portrait : IMAGES.paysage)(i), author: PROCHES[i % 4].name,
        uid: PROCHES[i % 4].uid, text: ['Les vacances à la mer', '', 'Le gâteau de Léo', 'Premier jour d’école'][i % 4],
        at: heure('09:00') - i * 86400000
      }));
    }
    return out;
  }
  var OPTIONS = { lecture: true, sos: true, meteo: true, rappelsAccueil: true };
  var METEO = { current: { weather_code: 1, is_day: 1, temperature_2m: 14.4 }, daily: { weather_code: [1, 61], temperature_2m_max: [16, 12.6] } };
  var METEO_NUIT = { current: { weather_code: 0, is_day: 0, temperature_2m: 7.2 }, daily: METEO.daily };
  function famille(posts, extra) {
    extra = extra || {};
    return {
      familyName: 'Mamie Jeanne', familyCode: 'ABCD-1234', textSize: '', subscription: extra.subscription || 'actif',
      options: Object.assign({}, OPTIONS, extra.options || {}), veille: { active: true, de: 21 * 60, a: 6 * 60 + 30 }, posts: posts
    };
  }

  // ---------- Fausse app Android ----------

  var faux = { wifi: { wifi: 'Livebox-6A2F', internet: true }, charging: true };
  var rien = function () {};
  var qr = fauxQr();
  window.PapoteAndroid = new Proxy({
    wifiStatus: function () { return JSON.stringify(faux.wifi); },
    wifiScan: function () {
      return JSON.stringify([{ ssid: 'Livebox-6A2F', level: 4, secure: true }, { ssid: 'Freebox-Voisin', level: 2, secure: true },
        { ssid: 'SFR_WiFi_FON', level: 1, secure: false }]);
    },
    isCharging: function () { return faux.charging; },
    qrCode: function () { return qr; },
    logError: function (m) { erreurs.push(String(m)); }
  }, { get: function (o, k) { return k in o ? o[k] : rien; } });
  var appelEnCours = null;
  window.papoteWatchPresence = function () { return rien; };
  window.papoteCallFamily = function (opts) { appelEnCours = opts; return { hangup: rien }; };

  // ---------- L'heure de la scène (26 octobre 2026, 10h30 sauf indication) ----------

  var VraieDate = Date;
  var decalage = 0;
  function FausseDate() {
    var a = Array.prototype.slice.call(arguments);
    if (!(this instanceof FausseDate)) return new VraieDate(VraieDate.now() + decalage).toString();
    if (!a.length) return new VraieDate(VraieDate.now() + decalage);
    return new (Function.prototype.bind.apply(VraieDate, [null].concat(a)))();
  }
  FausseDate.prototype = VraieDate.prototype;
  FausseDate.now = function () { return VraieDate.now() + decalage; };
  FausseDate.UTC = VraieDate.UTC;
  FausseDate.parse = VraieDate.parse;
  window.Date = FausseDate;
  function regler(hm) { decalage = new VraieDate(JOUR + 'T' + hm + ':00+01:00').getTime() - VraieDate.now(); }

  // ---------- Ce qu'une scène peut faire ----------

  function attendre(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function trouver(sel, texte) {
    var debut = VraieDate.now();
    return new Promise(function (oui, non) {
      (function chercher() {
        var el = Array.prototype.filter.call(document.querySelectorAll(sel), function (e) {
          return e.offsetParent !== null && (!texte || e.textContent.indexOf(texte) >= 0);
        })[0];
        if (el) return oui(el);
        if (VraieDate.now() - debut > 5000) return non(new Error('introuvable : ' + sel + (texte ? ' « ' + texte + ' »' : '')));
        setTimeout(chercher, 100);
      })();
    });
  }
  var t = {
    statut: function (s) { window.Papote.onStatus(s); return attendre(0); },
    famille: function (payload, opts) {
      opts = opts || {};
      window.Papote.onFamily({ people: opts.people || PROCHES, faces: opts.faces || VISAGES, birthdays: opts.birthdays || [] });
      window.Papote.onPosts(payload);
      return attendre(0);
    },
    meteo: function (m) { window.Papote.onWeather(m || METEO); return attendre(0); },
    rappels: function (list) { window.Papote.onReminders({ reminders: list }); return attendre(0); },
    faux: function (e) { Object.assign(faux, e); return attendre(0); },
    appel: function (etat, info) { if (appelEnCours) appelEnCours.onState(etat, info || {}); return attendre(0); },
    cliquer: function (sel, texte) { return trouver(sel, texte).then(function (el) { el.click(); }); },
    attendre: attendre,
    // Pas d'horloge accélérée ici : on attend vraiment (puis la fin du fondu des photos).
    avancer: function (ms) { return attendre(ms + 1500); }
  };
  function accueil(posts, extra) {
    extra = extra || {};
    return t.statut({ state: 'ok' })
      .then(function () { return t.famille(famille(posts, extra), extra); })
      .then(function () { return t.meteo(extra.meteo); })
      .then(function () { if (extra.rappels) return t.rappels(extra.rappels); })
      .then(function () { return attendre(1700); }); // le logo du démarrage s'efface
  }
  function suite() {
    var etapes = Array.prototype.slice.call(arguments);
    return function () { return etapes.reduce(function (p, f) { return p.then(f); }, Promise.resolve()); };
  }

  var RAPPEL_MEDOC = { id: 'r1', kind: 'medicament', title: 'Prendre le cachet du midi', time: '12:00', repeat: 'daily', avanceMin: 15 };
  var RAPPEL_RDV = { id: 'r2', kind: 'rdv', title: 'Docteur Martin', time: '11:00', date: JOUR, repeat: 'none', avanceMin: 0 };
  // Photo d'anniversaire ajoutée dans l'app (data URL carrée), dessinée ici : un portrait simple.
  function photoAnniv() {
    var c = document.createElement('canvas'); c.width = c.height = 320;
    var x = c.getContext('2d');
    var g = x.createLinearGradient(0, 0, 0, 320); g.addColorStop(0, '#fbcfe8'); g.addColorStop(1, '#f9a8d4');
    x.fillStyle = g; x.fillRect(0, 0, 320, 320);
    x.fillStyle = '#fde7d4'; x.beginPath(); x.arc(160, 130, 62, 0, 7); x.fill();
    x.fillStyle = '#7c3aed'; x.beginPath(); x.arc(160, 330, 120, Math.PI, 0); x.fill();
    return c.toDataURL('image/jpeg', .85);
  }
  var BDAY = [{ id: 'b1', name: 'Léo', day: 26, month: 10, year: 2019 }];
  function sansWifi() { return t.faux({ wifi: { wifi: '', internet: false } }); }
  function appelerJulie() {
    return accueil(photosVues()).then(function () { return t.cliquer('.call-btn.big-btn'); })
      .then(function () { return t.cliquer('.call-person'); });
  }
  function sos() {
    return accueil(photosVues()).then(function () { return t.cliquer('#sos-btn'); });
  }

  // Mêmes scènes, même ordre et mêmes titres que outils/galerie/tablette.js (T1, T2… identiques).
  var SCENES = [
    ['Démarrage et installation', 'Logo du démarrage', function () { return attendre(300); }],
    ['Démarrage et installation', 'Bienvenue (étape 1)', function () { return t.statut({ state: 'welcome', step: 'start' }).then(function () { return attendre(1600); }); }],
    ['Démarrage et installation', 'Choisir le wifi (étape 2)', suite(sansWifi, function () { return t.statut({ state: 'welcome', step: 'wifi' }); }, function () { return attendre(1600); })],
    ['Démarrage et installation', 'Liste des wifi', suite(sansWifi, function () { return t.statut({ state: 'welcome', step: 'wifi' }); }, function () { return attendre(1600); },
      function () { return t.cliquer('button, a, [role=button], .btn', 'Choisir un réseau'); }, function () { return attendre(3500); })],
    ['Démarrage et installation', 'Mot de passe du wifi', suite(sansWifi, function () { return t.statut({ state: 'welcome', step: 'wifi' }); }, function () { return attendre(1600); },
      function () { return t.cliquer('button, a, [role=button], .btn', 'Choisir un réseau'); }, function () { return attendre(3500); },
      function () { return t.cliquer('.network'); }, function () { return attendre(600); })],
    ['Démarrage et installation', 'Wifi connecté', function () { return t.statut({ state: 'welcome', step: 'wifi' }).then(function () { return attendre(1600); }); }],
    ['Démarrage et installation', 'QR code et code à taper (étape 3)', function () { return t.statut({ state: 'welcome', step: 'pair', code: 'K7PM2Q' }).then(function () { return attendre(1600); }); }],
    ['Démarrage et installation', 'Code faux ou expiré', function () { return t.statut({ state: 'welcome', step: 'pair', code: 'K7PM2Q', error: 'Ce code a expiré. Un nouveau code est affiché.' }).then(function () { return attendre(1600); }); }],
    ['Démarrage et installation', 'Un proche termine sur son téléphone', function () { return t.statut({ state: 'welcome', step: 'pair', code: 'K7PM2Q', claimedName: 'Julie', reprendre: true }).then(function () { return attendre(1600); }); }],
    ['Démarrage et installation', 'On prépare votre tablette', function () { return t.statut({ state: 'welcome', step: 'prepare', claimedName: 'Julie' }).then(function () { return attendre(1600); }); }],
    ['Démarrage et installation', 'Tablette de remplacement : c’est bien vous ?', function () { return t.statut({ state: 'welcome', step: 'confirm', claimedName: 'Julie', familyName: 'Mamie Jeanne' }).then(function () { return attendre(1600); }); }],
    ['Démarrage et installation', 'Tablette pas encore reliée', function () { return t.statut({ state: 'setup', message: 'Code tablette : K7PM-2Q' }).then(function () { return attendre(1600); }); }],

    ['Accueil', 'Accueil sans aucune photo', function () { return accueil([]); }],
    ['Accueil', 'Accueil avec photos, météo et prochain rappel', function () { return accueil(photosVues(), { rappels: [RAPPEL_MEDOC] }); }],
    ['Accueil', 'Accueil avec une photo en hauteur', function () { var p = photosVues(); var x = p[0]; p[0] = p[1]; p[1] = x; return accueil(p); }],
    ['Accueil', 'Accueil sans SOS, sans météo, sans rappel', function () { return accueil(photosVues(), { options: { sos: false, meteo: false, rappelsAccueil: false }, rappels: [RAPPEL_MEDOC] }); }],
    ['Accueil', 'Rendez-vous dans moins d’une heure', function () { return accueil(photosVues(), { rappels: [RAPPEL_RDV] }); }],
    ['Accueil', 'Anniversaire : bandeau de la journée', function () {
      return accueil(photosVues(), { birthdays: BDAY }).then(function () { return t.cliquer('#bday-ok'); }).then(function () { return attendre(400); });
    }],
    ['Accueil', 'Pas d’internet', function () { return accueil(photosVues()).then(sansWifi).then(function () { return t.avancer(100000); }).then(function () { return attendre(400); }); }],
    ['Accueil', 'Pas de réseau (tablette à carte SIM)', function () {
      return accueil(photosVues()).then(function () { return t.faux({ wifi: { wifi: '', internet: false, sim: true } }); })
        .then(function () { return t.avancer(100000); }).then(function () { return attendre(400); });
    }],
    ['Accueil', 'Tablette débranchée', function () {
      return accueil(photosVues()).then(function () { return t.faux({ charging: false }); })
        .then(function () { return t.avancer(90000); }).then(function () { return attendre(400); });
    }],
    ['Accueil', 'Papote en pause (abonnement suspendu)', function () { return accueil(photosVues(), { subscription: 'suspendu' }); }],

    ['Soir et nuit', 'Accueil le soir (20h30)', function () { return accueil(photosVues(), { meteo: METEO_NUIT }); }, '20:30'],
    ['Soir et nuit', 'Veille la nuit (23h30)', function () { return accueil(photosVues(), { meteo: METEO_NUIT }).then(function () { return attendre(1200); }); }, '23:30'],
    ['Soir et nuit', 'Nouvelle photo le soir', function () {
      return accueil([post({ image: IMAGES.paysage(3), text: 'Bonne nuit Mamie !', seen: false, at: heure('20:28') })].concat(photosVues()), { meteo: METEO_NUIT })
        .then(function () { return attendre(800); });
    }, '20:30'],

    ['Nouvel envoi', 'Message court', function () { return accueil([post({ text: 'Coucou Mamie, on pense fort à toi !', seen: false, at: heure('10:05') })].concat(photosVues())); }],
    ['Nouvel envoi', 'Message long', function () {
      return accueil([post({ author: 'Thomas', uid: 'u-thomas', seen: false, at: heure('08:40'), text: 'Bonjour Mamie ! Nous sommes bien arrivés à Lyon hier soir. Les enfants ont dormi dans la voiture. On t’appelle dimanche pour te raconter tout ça. Gros bisous de nous quatre.' })].concat(photosVues()));
    }],
    ['Nouvel envoi', 'Photo en largeur avec un mot', function () {
      return accueil([post({ image: IMAGES.paysage(0), text: 'Regarde la mer !', seen: false, at: heure('10:20') })].concat(photosVues())).then(function () { return attendre(600); });
    }],
    ['Nouvel envoi', 'Photo en hauteur sans légende', function () {
      return accueil([post({ image: IMAGES.portrait(2), author: 'Anne', uid: 'u-anne', seen: false, at: heure('10:20') })].concat(photosVues())).then(function () { return attendre(600); });
    }],
    ['Nouvel envoi', 'Photo avec une longue légende', function () {
      return accueil([post({ image: IMAGES.paysage(4), text: 'Léo a soufflé ses sept bougies avec ses copains du foot, il était tellement content', seen: false })].concat(photosVues())).then(function () { return attendre(600); });
    }],
    ['Nouvel envoi', 'Plusieurs photos d’un coup', function () {
      return accueil([post({ image: IMAGES.paysage(1), images: [IMAGES.portrait(2), IMAGES.paysage(3)], text: 'Le week-end à la campagne', seen: false })].concat(photosVues())).then(function () { return attendre(600); });
    }],
    ['Nouvel envoi', 'Vidéo', function () {
      return accueil([post({ type: 'video', video: 'controle/video-essai.mp4', text: 'Léo fait du vélo', author: 'Lucas', uid: 'u-lucas', seen: false, duration: 24 })].concat(photosVues())).then(function () { return attendre(600); });
    }],

    ['Diaporama', 'Diaporama : photo en largeur', function () { return accueil(photosVues()).then(function () { return t.cliquer('#home-frame'); }).then(function () { return attendre(900); }); }],
    ['Diaporama', 'Diaporama : photo en hauteur', function () {
      return accueil(photosVues()).then(function () { return t.cliquer('#home-frame'); }).then(function () { return attendre(900); })
        .then(function () { return t.cliquer('#photo-prev'); }).then(function () { return attendre(1600); });
    }],

    ['Rappels', 'Rappel annoncé 15 minutes avant', function () { return accueil(photosVues(), { rappels: [RAPPEL_MEDOC] }).then(function () { return attendre(600); }); }, '11:45'],
    ['Rappels', 'Rappel à l’heure', function () { return accueil(photosVues(), { rappels: [RAPPEL_MEDOC] }).then(function () { return attendre(600); }); }, '12:00'],
    ['Rappels', 'Anniversaire en plein écran', function () { return accueil(photosVues(), { birthdays: BDAY }).then(function () { return attendre(400); }); }],

    ['Appels', 'Qui voulez-vous appeler ?', function () { return accueil(photosVues()).then(function () { return t.cliquer('.call-btn.big-btn'); }).then(function () { return attendre(400); }); }],
    ['Appels', 'Qui appeler : une seule personne', function () {
      return accueil(photosVues(), { people: PROCHES.slice(0, 1) }).then(function () { return t.cliquer('.call-btn.big-btn'); }).then(function () { return attendre(400); });
    }],
    ['Appels', 'Appel vers Julie : ça sonne', function () { return appelerJulie().then(function () { return t.appel('ringing'); }).then(function () { return attendre(400); }); }],
    ['Appels', 'Appel en cours avec Julie', function () { return appelerJulie().then(function () { return t.appel('connected', { name: 'Julie' }); }).then(function () { return attendre(400); }); }],
    ['Appels', 'Julie n’a pas pu répondre', function () { return appelerJulie().then(function () { return t.appel('missed'); }).then(function () { return attendre(400); }); }],
    ['Appels', 'Appel entrant', function () {
      return accueil(photosVues()).then(function () {
        document.getElementById('ring-name').textContent = 'Julie';
        var img = document.getElementById('ring-caller'); img.src = VISAGES['u-julie']; img.hidden = false;
        document.getElementById('call-ring').hidden = false;
        return attendre(400);
      });
    }],
    ['Appels', 'SOS : décompte avant l’appel', function () { return sos().then(function () { return attendre(300); }); }],
    ['Appels', 'SOS : ça sonne chez toute la famille', function () {
      return sos().then(function () { return t.avancer(6000); })
        .then(function () { return t.appel('ringing', { names: ['Julie', 'Thomas', 'Anne'] }); }).then(function () { return attendre(300); });
    }],
    ['Appels', 'SOS : personne n’a répondu, famille prévenue', function () {
      return sos().then(function () { return t.avancer(6000); })
        .then(function () { return t.appel('missed'); }).then(function () { return t.appel('missed'); }).then(function () { return attendre(300); });
    }],
    ['Rappels', 'Anniversaire d’un proche de l’app (bouton Appeler)', function () { return accueil(photosVues(), { birthdays: [{ id: 'membre-u-julie', name: 'Julie', day: 26, month: 10, year: 1988, photo: photoAnniv() }] }).then(function () { return attendre(400); }); }],
    ['Accueil', 'Accueil le plus chargé : radio, anniversaire, SOS', function () { return accueil(photosVues(), { birthdays: [{ id: 'b1', name: 'Léo', day: 26, month: 10, year: 2019 }], options: { radio: { nom: 'France Bleu', url: 'https://exemple.invalid/radio' } } }).then(function () { return t.cliquer('#bday-ok'); }).then(function () { return attendre(400); }); }],
    ['Soir et nuit', 'Accueil le soir avec la radio (20h30)', function () { return accueil(photosVues(), { meteo: METEO_NUIT, options: { radio: { nom: 'France Bleu', url: 'https://exemple.invalid/radio' } } }); }, '20:30']
  ];

  function pret(texte) {
    try { window.ControleJs.resultat('ecran', texte); } catch (e) { /* hors tablette */ }
  }

  var scene = SCENES[N - 1];
  if (!scene) { pret('fin/' + SCENES.length); return; }
  regler(scene[3] || '10:30');
  window.__controleScene = { n: N, total: SCENES.length, groupe: scene[0], titre: scene[1] };
  window.addEventListener('load', function () {
    var debut = VraieDate.now();
    (function lancer() {
      if (!window.Papote) {
        if (VraieDate.now() - debut > 5000) { erreurs.push('window.Papote absent'); return fini(); }
        return setTimeout(lancer, 50);
      }
      Promise.resolve().then(scene[2]).catch(function (e) { erreurs.push('Scène : ' + e.message); }).then(fini);
    })();
  });
  function fini() {
    setTimeout(function () {
      pret([N + '/' + SCENES.length, scene[0], scene[1], erreurs.join(' | ').replace(/[\t\n]/g, ' ')].join('\t'));
    }, 300);
  }
})();
