/*
 * Écran de la tablette Papote. Écrit en JavaScript ES5 pour le navigateur d'Android 4.4.
 * Les données arrivent de l'app Android par window.Papote.onStatus / onPosts / onReminders ;
 * les actions repartent par window.PapoteAndroid (markSeen, sendHeart, playVoice…).
 */
(function () {
  'use strict';

  var IDLE_MS = 90000;   // retour à l'accueil après 1 min 30 sans toucher l'écran
  var FRAME_MS = 12000;  // changement de photo sur l'accueil
  var SLIDE_MS = 10000;  // défilement tout seul du diaporama
  var CALM_MS = 4000;    // les flèches et « Accueil » s'effacent après 4 s sans toucher l'écran

  var JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  var MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
    'septembre', 'octobre', 'novembre', 'décembre'];

  var posts = [];
  var photos = [];       // photos seules : le cadre de l'accueil
  var slides = [];       // diaporama : les photos et les vidéos, dans l'ordre des envois
  var photoIndex = 0;
  var frameIndex = 0;
  var overlayQueue = [];
  var overlayPost = null;
  var shownInOverlay = {};
  var idleTimer = null;
  var hasData = false;

  function $(id) { return document.getElementById(id); }
  function android() { return window.PapoteAndroid; }

  // Erreurs de la page notées dans le journal de la tablette (envoyé à la famille).
  window.onerror = function (msg, src, line) {
    try { if (window.PapoteAndroid && window.PapoteAndroid.logError) window.PapoteAndroid.logError(msg + ' @' + src + ':' + line); } catch (e) { /* rien */ }
  };
  function show(el, visible) {
    if (visible) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
  }
  function isShown(id) { return !$(id).hasAttribute('hidden'); }
  function on(el, event, fn) { el.addEventListener(event, fn, false); }
  function pad(n) { return n < 10 ? '0' + n : String(n); }

  // ---------- Icônes (SVG : les emojis d'Android 4.4 sont incomplets) ----------

  var ICONS = {
    camera: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9zm3 5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>',
    letter: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1.4 2 7.6 5.6L19.6 7H4.4zM20 8.6l-8 5.9-8-5.9V17h16V8.6z"/></svg>',
    pill: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4.2 13.4 13.4 4.2a5 5 0 0 1 7.1 7.1l-9.2 9.2a5 5 0 0 1-7.1-7.1zm1.4 1.4a3 3 0 0 0 4.2 4.2l4.2-4.2-4.2-4.2-4.2 4.2z"/></svg>',
    doctor: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7V3z"/></svg>',
    pin: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a7 7 0 0 1 7 7c0 5-7 13-7 13S5 14 5 9a7 7 0 0 1 7-7zm0 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 4v16l13-8z"/></svg>',
    replay: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/></svg>',
    heart: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 21s-7.5-4.6-9.6-9C.9 8.8 2.6 5 6.3 4.6 8.6 4.4 10.4 5.6 12 7.6c1.6-2 3.4-3.2 5.7-3 3.7.4 5.4 4.2 3.9 7.4C19.5 16.4 12 21 12 21z"/></svg>'
  };

  function fillIcons() {
    var els = document.querySelectorAll('[data-icon]');
    for (var i = 0; i < els.length; i++) els[i].innerHTML = ICONS[els[i].getAttribute('data-icon')];
  }

  // ---------- Navigation ----------

  function showView(view) {
    var ids = ['view-home', 'view-photos', 'view-setup'];
    for (var i = 0; i < ids.length; i++) show($(ids[i]), ids[i] === view);
    if (view !== 'view-photos') stopSlideVideo();
    resetIdle();
  }

  function resetIdle() {
    clearTimeout(idleTimer);
    if (!isShown('view-home') && !isShown('view-setup')) {
      // Diaporama : retour à l'accueil après 5 minutes sans toucher l'écran.
      idleTimer = setTimeout(function () { showView('view-home'); },
        isShown('view-photos') ? 5 * 60000 : IDLE_MS);
    }
  }

  // ---------- Horloge, date, mode nuit ----------

  var dimmed = null;

  function tick() {
    var now = new Date();
    var time = now.getHours() + ':' + pad(now.getMinutes());
    $('clock').textContent = time;
    $('setup-clock').textContent = time;
    var day = JOURS[now.getDay()];
    $('date').textContent = day.charAt(0).toUpperCase() + day.slice(1) + ' ' + now.getDate() +
      (now.getDate() === 1 ? 'er' : '') + ' ' + MOIS[now.getMonth()];
    // Bandeau bas d'une photo reçue : « Il est 14h24, vendredi 23 octobre ».
    if ($('overlay-clock')) {
      $('overlay-clock').textContent = 'Il est ' + now.getHours() + 'h' + pad(now.getMinutes()) + ', ' + day + ' ' +
        now.getDate() + (now.getDate() === 1 ? 'er' : '') + ' ' + MOIS[now.getMonth()];
    }
    var hour = now.getHours();
    // Le moment de la journée, un repère de plus sous la date.
    if ($('moment')) {
      $('moment').textContent = hour >= 5 && hour < 12 ? 'Le matin'
        : hour >= 12 && hour < 18 ? "L'après-midi"
          : hour >= 18 && hour < 22 ? 'Le soir' : 'La nuit';
    }
    var evening = isEvening(hour);
    document.body.className = (evening ? 'night' : '') +
      (playing && playing.post.video && !playing.cadre ? ' video-playing' : '');
    // Le soir, l'écran garde son fond noir mais éclaire moins.
    if (evening !== dimmed) {
      dimmed = evening;
      if (android() && android().setDim) android().setDim(evening);
    }
  }

  function whenLabel(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    var now = new Date();
    var yesterday = new Date(now.getTime() - 86400000);
    var hm = d.getHours() + 'h' + pad(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return "aujourd'hui à " + hm;
    if (d.toDateString() === yesterday.toDateString()) return 'hier à ' + hm;
    return 'le ' + JOURS[d.getDay()] + ' ' + d.getDate() + ' ' + MOIS[d.getMonth()];
  }

  // « aujourd'hui », « hier » ou « mardi 6 octobre »
  function dayLabel(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    var now = new Date();
    if (d.toDateString() === now.toDateString()) return "aujourd'hui";
    if (d.toDateString() === new Date(now.getTime() - 86400000).toDateString()) return 'hier';
    // Plus court qu'une date : « il y a 3 jours », puis en semaines et en mois.
    var days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) -
      new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    if (days < 14) return 'il y a ' + days + ' jours';
    if (days < 60) return 'il y a ' + Math.floor(days / 7) + ' semaines';
    var months = Math.floor(days / 30);
    return months < 12 ? 'il y a ' + months + ' mois' : (months < 24 ? 'il y a 1 an' : 'il y a ' + Math.floor(months / 12) + ' ans');
  }

  // Taille du texte selon sa longueur : il tient toujours à l'écran sans faire défiler.
  // Abonnement suspendu, résilié ou absent (écrit par le serveur) : Papote est en pause.
  // Champ absent ou tablette hors ligne : rien ne change.
  var pauseScreen = null;
  function setPaused(statut) {
    var paused = statut === 'suspendu' || statut === 'resilie' || statut === 'aucun';
    window.papotePaused = paused; // lu par appels.js pour ne pas sonner
    if (!pauseScreen) {
      if (!paused) return;
      pauseScreen = document.createElement('div');
      pauseScreen.className = 'pause-screen';
      pauseScreen.innerHTML = '<div class="pause-box"><p class="pause-title">Papote est en pause</p>' +
        '<p class="pause-text">La famille a été prévenue.<br>Tout reviendra dès que ce sera réglé.</p></div>';
      document.body.appendChild(pauseScreen);
    }
    pauseScreen.style.display = paused ? 'flex' : 'none';
    if (paused) {
      overlayQueue = [];
      shownInOverlay = {}; // ils reviendront à la fin de la pause
      if (overlayPost) { overlayPost = null; show($('overlay'), false); }
      showView('view-home');
    }
  }

  // Taille du texte choisie par la famille (normale, grande, très grande).
  var textScale = 1;
  function setTextSize(size) {
    // Taille du texte toujours normale (demande de Tanguy) : le réglage de la famille est ignoré,
    // les écrans sont dessinés pour cette taille.
    textScale = 1;
    document.documentElement.style.setProperty('--ts', String(textScale));
  }

  function sizeClass(text) {
    // Plus le texte est agrandi, plus vite on passe à la taille au-dessous pour qu'il tienne.
    var n = (text || '').length * textScale * textScale;
    return n <= 50 ? 'size-l' : n <= 110 ? 'size-m' : n <= 180 ? 'size-s' : 'size-xs';
  }

  // ---------- Météo ----------

  function sun(cx, cy, r) {
    var rays = '';
    for (var i = 0; i < 8; i++) {
      var a = i * Math.PI / 4;
      rays += '<line x1="' + (cx + Math.cos(a) * (r + 4)) + '" y1="' + (cy + Math.sin(a) * (r + 4)) +
        '" x2="' + (cx + Math.cos(a) * (r + 9)) + '" y2="' + (cy + Math.sin(a) * (r + 9)) + '"/>';
    }
    return '<g stroke="#f59e0b" stroke-width="3.5" stroke-linecap="round">' + rays + '</g>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="#fbbf24"/>';
  }
  var CLOUD = '<path fill="#a9bdd4" stroke="#64748b" stroke-width="2.5" d="M20 58h40a12 12 0 0 0 0-24 18 18 0 0 0-34-4A13 13 0 0 0 20 58z"/>';
  var MOON = '<path fill="#fde68a" d="M44 10a24 24 0 1 0 22 33A20 20 0 0 1 44 10z"/>';
  var DROPS = '<g stroke="#3b82f6" stroke-width="4" stroke-linecap="round"><line x1="28" y1="64" x2="24" y2="74"/><line x1="42" y1="64" x2="38" y2="74"/><line x1="56" y1="64" x2="52" y2="74"/></g>';
  var SNOW = '<g fill="#93c5fd"><circle cx="26" cy="68" r="3.5"/><circle cx="40" cy="72" r="3.5"/><circle cx="54" cy="68" r="3.5"/></g>';
  var BOLT = '<path fill="#facc15" d="M42 56 32 72h9l-4 10 14-18h-9l4-8z"/>';
  var FOG = '<g stroke="#94a3b8" stroke-width="4" stroke-linecap="round"><line x1="12" y1="40" x2="68" y2="40"/><line x1="18" y1="52" x2="62" y2="52"/><line x1="12" y1="64" x2="68" y2="64"/></g>';

  var WEATHER = {
    0: ['clear', 'Grand soleil'], 1: ['partly', 'Plutôt ensoleillé'], 2: ['partly', 'Quelques nuages'],
    3: ['cloudy', 'Couvert'], 45: ['fog', 'Brouillard'], 48: ['fog', 'Brouillard givrant'],
    51: ['rain', 'Bruine'], 53: ['rain', 'Bruine'], 55: ['rain', 'Forte bruine'], 56: ['rain', 'Bruine verglaçante'],
    57: ['rain', 'Bruine verglaçante'], 61: ['rain', 'Petite pluie'], 63: ['rain', 'Pluie'], 65: ['rain', 'Forte pluie'],
    66: ['rain', 'Pluie verglaçante'], 67: ['rain', 'Pluie verglaçante'], 68: ['snow', 'Pluie et neige'], 71: ['snow', 'Un peu de neige'],
    73: ['snow', 'Neige'], 75: ['snow', 'Forte neige'], 77: ['snow', 'Neige'], 80: ['rain', 'Averses'],
    81: ['rain', 'Averses'], 82: ['storm', 'Fortes averses'], 85: ['snow', 'Averses de neige'],
    86: ['snow', 'Averses de neige'], 95: ['storm', 'Orage'], 96: ['storm', 'Orage'], 99: ['storm', 'Orage']
  };

  function weatherSvg(kind, isDay) {
    var body = {
      clear: isDay ? sun(40, 40, 15) : MOON,
      partly: (isDay ? sun(30, 28, 11) : '<g transform="translate(-8,-8) scale(.8)">' + MOON + '</g>') + CLOUD,
      cloudy: CLOUD, fog: FOG, rain: CLOUD + DROPS, snow: CLOUD + SNOW, storm: CLOUD + BOLT
    }[kind] || CLOUD;
    return '<svg viewBox="0 0 80 80">' + body + '</svg>';
  }

  var weatherReady = false;
  function onWeather(data) {
    try {
      var now = WEATHER[data.current.weather_code] || ['cloudy', ''];
      var isDay = data.current.is_day;
      var label = now[1];
      if (!isDay && data.current.weather_code === 0) label = 'Ciel dégagé';
      $('weather-icon').innerHTML = weatherSvg(now[0], isDay);
      $('weather-temp').textContent = Math.round(data.current.temperature_2m) + '°';
      var tomorrow = WEATHER[data.daily.weather_code[1]] || ['cloudy', ''];
      $('weather-label').innerHTML = '';
      $('weather-label').appendChild(document.createTextNode(label));
      var small = document.createElement('small');
      small.textContent = 'Demain : ' + tomorrow[1].toLowerCase() + ', ' + Math.round(data.daily.temperature_2m_max[1]) + '°';
      $('weather-label').appendChild(small);
      weatherReady = true;
      show($('weather'), options.meteo !== false);
    } catch (e) { /* données incomplètes : on garde l'affichage précédent */ }
  }

  // ---------- Accueil : cadre photo et compteurs ----------

  function renderFrame() {
    // Un rendez-vous dans moins d'une heure passe avant les photos.
    var rdv = upcomingRdv();
    showRdv(rdv);
    if (rdv) return;
    var has = photos.length > 0;
    // Au démarrage, avant que la tablette ait relu ses envois : rien (pas le QR « Envoyez une photo »
    // une seconde, juste avant que la photo arrive).
    if (!hasData) { show($('frame-img'), false); show($('frame-caption'), false); show($('frame-empty'), false); return; }
    show($('frame-img'), has);
    if (frameBack) show(frameBack, has);
    show($('frame-caption'), has);
    show($('frame-empty'), !has);
    if (!has) { renderInvite(); return; }
    frameIndex = frameIndex % Math.min(photos.length, 20);
    var p = photos[frameIndex];
    crossfadeFrame(p, function () { setCaption(p); });
  }

  // Changement de photo de l'accueil en fondu enchaîné : la nouvelle photo est chargée à part,
  // puis apparaît doucement par-dessus l'ancienne (avec un très léger zoom), la légende en fondu.
  var frameBack = null;
  var frameShown = '';
  function crossfadeFrame(p, done) {
    var front = $('frame-img');
    if (!frameBack) {
      frameBack = front.cloneNode(false);
      frameBack.id = 'frame-img-b';
      frameBack.removeAttribute('data-url');
      front.parentNode.insertBefore(frameBack, front.nextSibling);
    }
    if (frameShown === p.image) { done(); return; }
    var first = !frameShown;
    frameShown = p.image;
    var probe = new Image();
    probe.onload = probe.onerror = function () {
      if (frameShown !== p.image) return;
      // La couche du dessous reçoit la nouvelle photo, transparente, passe au-dessus et apparaît.
      var top = front.style.zIndex === '2' ? front : frameBack;
      var next = top === front ? frameBack : front;
      next.style.transition = 'none';
      next.style.opacity = first ? '1' : '0';
      next.style.transform = 'scale(1)';
      setPicture(next, p.image);
      next.style.zIndex = '2';
      top.style.zIndex = '1';
      var cap = $('frame-caption');
      cap.style.transition = 'opacity .5s';
      cap.style.opacity = '0';
      setTimeout(function () {
        next.style.transition = 'opacity 1.4s ease, transform 12s linear';
        next.style.opacity = '1';
        next.style.transform = 'scale(1.04)';
        done();
        cap.style.opacity = '1';
      }, first ? 0 : 60);
    };
    probe.src = p.image;
  }

  function setCaption(p) {
    signWithFace($('frame-caption'), p, p.authorName + ', ' + dayLabel(p.createdAt).replace(/ /g, ' '));
  }

  // Sans photo : un QR code pour que la famille rejoigne Papote depuis son téléphone.
  var familyCode = '';
  var inviteFor = null;
  function renderInvite() {
    var code = familyCode.replace(/-/g, '');
    if (!code || inviteFor === code || !android() || !android().qrCode) return;
    var qr = android().qrCode('https://app.mapapote.fr/?code=' + code);
    if (!qr) return;
    inviteFor = code;
    var el = $('frame-empty');
    el.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'invite';
    var img = document.createElement('img');
    img.className = 'invite-qr';
    img.setAttribute('src', qr);
    img.setAttribute('alt', '');
    var text = document.createElement('p');
    text.textContent = 'Famille : scannez ce code avec votre téléphone pour envoyer des photos';
    box.appendChild(img);
    box.appendChild(text);
    el.appendChild(box);
  }

  // Fond flouté : la photo est réduite à quelques pixels puis agrandie (le flou CSS
  // n'existe pas sur Android 4.4).
  function tinyCopy(url, done) {
    var img = new Image();
    img.onload = function () {
      try {
        var c = document.createElement('canvas');
        c.width = 24;
        c.height = Math.max(1, Math.round(24 * img.height / img.width));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        done('url("' + c.toDataURL('image/jpeg', 0.8) + '")');
      } catch (e) { done('none'); }
    };
    img.onerror = function () { done('none'); };
    img.src = url;
  }
  var backdropSrc = null;
  function setBackdrops() {
    var url = photos.length ? photos[0].image : '';
    if (url === backdropSrc) return;
    backdropSrc = url;
    var apply = function (bg) {
      var els = document.querySelectorAll('.ov-backdrop');
      for (var i = 0; i < els.length; i++) els[i].style.backgroundImage = bg;
    };
    if (!url) { apply('none'); return; }
    tinyCopy(url, apply);
  }

  // Photo posée en fond de l'image : le navigateur d'Android 4.4 ignore object-fit et
  // écraserait la photo ; background-size (cover / contain) garde ses proportions.
  var BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  function setPicture(img, url) {
    if (img.getAttribute('data-url') === url) return;
    img.setAttribute('data-url', url);
    img.setAttribute('src', BLANK);
    img.style.backgroundImage = 'url("' + url + '")';
  }

  function setBadge(id, n) {
    show($(id), n > 0);
    $(id).textContent = n > 9 ? '9+' : String(n);
  }

  function renderBadges() { /* plus de bouton Photos : la photo de droite ouvre les photos */ }

  // ---------- Photos ----------

  // index : celui de la photo du cadre de l'accueil (liste « photos », sans les vidéos).
  function openPhotos(index) {
    if (!slides.length) return;
    photoIndex = Math.max(0, slides.indexOf(photos[index]));
    renderPhoto();
    showView('view-photos');
    wakeArrows();
  }

  // Mode cadre photo : sans toucher l'écran, les flèches et « Accueil » s'effacent au bout de
  // 4 s (demande de Tanguy, 21/10) ; ils reviennent au premier toucher.
  var calmTimer = null;
  function wakeArrows() {
    $('view-photos').className = 'view photos';
    clearTimeout(calmTimer);
    calmTimer = setTimeout(function () { $('view-photos').className = 'view photos calm'; }, CALM_MS);
  }

  function renderPhoto() {
    var p = slides[photoIndex];
    if (!p) return;
    stopSlideVideo();
    // Fondu : deux calques qui alternent. L'ancienne photo reste telle quelle dessous
    // pendant que la nouvelle apparaît par-dessus.
    var opening = !isShown('view-photos');
    var cur = $(frontSlide), next = $(frontSlide === 'slide-a' ? 'slide-b' : 'slide-a');
    frontSlide = next.id;
    if (opening) cur.style.opacity = '0';
    cur.style.zIndex = '1';
    next.style.zIndex = '2';
    next.className = 'slide instant';
    next.style.opacity = '0';
    next.offsetWidth; // applique l'opacité 0 sans transition
    next.className = 'slide' + (p.image ? '' : ' slide-video');
    var token = ++fadeToken;
    if (p.image) {
      setPicture(next.querySelector('img'), p.image);
      tinyCopy(p.image, function (bg) {
        if (token !== fadeToken) return;
        next.querySelector('.photo-bg').style.backgroundImage = bg;
        next.style.opacity = '1';
      });
    } else {
      // Vidéo déjà reçue : elle se lance toute seule dans le diaporama, flèches et Accueil gardés.
      // Elle n'apparaît (en fondu) qu'à sa première image : pas d'écran noir pendant le chargement.
      setPicture(next.querySelector('img'), BLANK);
      next.querySelector('.photo-bg').style.backgroundImage = 'none';
      playSlideVideo(next, p, token);
    }
    preloadNext();
    signWithFace($('photo-who'), p, p.authorName + ', ' + dayLabel(p.createdAt));
    var partLabel = p.parts > 1 ? 'Photo ' + p.part + ' sur ' + p.parts : '';
    var caption = p.text && partLabel ? p.text + ' · ' + partLabel : (p.text || partLabel);
    $('photo-text').textContent = caption;
    show($('photo-text'), !!caption);
    // En boucle : les flèches marchent toujours (sauf s'il n'y a qu'une photo).
    if (slides.length < 2) { $('photo-prev').setAttribute('disabled', ''); $('photo-next').setAttribute('disabled', ''); }
    else { $('photo-prev').removeAttribute('disabled'); $('photo-next').removeAttribute('disabled'); }
    markSeen(p);
    restartSlides();
    // Arrivée à l'avant-dernière photo chargée : on en demande 5 de plus.
    if (photoIndex >= slides.length - 2 && android() && android().morePhotos && askedMoreAt !== slides.length) {
      askedMoreAt = slides.length;
      android().morePhotos();
    }
  }
  var askedMoreAt = -1;

  // Comme un cadre photo : sans toucher l'écran, on passe à la suivante toutes les 10 s,
  // et après la plus ancienne on revient à la plus récente.
  var slideTimer = null;
  var fadeToken = 0;
  var frontSlide = 'slide-a';
  function restartSlides() {
    clearTimeout(slideTimer);
    slideTimer = setTimeout(function () {
      if (!isShown('view-photos') || slides.length < 2) return;
      if (slides[photoIndex] && !slides[photoIndex].image) return; // la vidéo passe au suivant à sa fin
      photoIndex = (photoIndex + 1) % slides.length;
      renderPhoto();
    }, SLIDE_MS);
  }

  // ---------- Vidéos dans le diaporama ----------
  // Les vidéos déjà reçues reviennent dans le diaporama (pas dans le cadre de l'accueil) : jouées dans
  // la page, sous les flèches et le bouton Accueil, qui restent utilisables. À la fin, la suivante.
  // Fond : l'image de la vidéo floutée, comme pour les photos (pas un écran noir).
  function slideVideo(slide) {
    var v = slide.querySelector('video');
    if (!v) {
      v = document.createElement('video');
      v.className = 'slide-vid';
      v.setAttribute('playsinline', '');
      v.setAttribute('preload', 'auto');
      slide.insertBefore(v, slide.querySelector('img'));
    }
    return v;
  }

  function playSlideVideo(slide, p, token) {
    var v = slideVideo(slide);
    var bgDone = false;
    var next = function () {
      if (token !== fadeToken || !isShown('view-photos')) return;
      resetIdle();
      if (slides.length > 1) { photoIndex = (photoIndex + 1) % slides.length; renderPhoto(); }
      else { v.currentTime = 0; v.play().catch(function () { }); }
    };
    v.onended = next;
    var shown = false;
    var reveal = function () { if (!shown && token === fadeToken) { shown = true; slide.style.opacity = '1'; } };
    v.onplaying = reveal;
    setTimeout(reveal, 3000); // au pire, au bout de 3 s
    v.onerror = function () { reveal(); slideTimer = setTimeout(next, SLIDE_MS); }; // vidéo illisible : on passe
    v.onloadeddata = function () {
      if (bgDone || token !== fadeToken) return;
      bgDone = true;
      try {
        var c = document.createElement('canvas');
        c.width = 24;
        c.height = Math.max(1, Math.round(24 * v.videoHeight / (v.videoWidth || 1)));
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        slide.querySelector('.photo-bg').style.backgroundImage = 'url("' + c.toDataURL('image/jpeg', 0.8) + '")';
      } catch (e) { }
    };
    v.setAttribute('src', p.video);
    v.style.display = '';
    stopRadio();
    v.play().catch(function () { v.onerror(); });
  }

  // La photo suivante est décodée d'avance (et son fond flou préparé) : pas d'à-coup au passage.
  var preloaded = {};
  function preloadNext() {
    var n = slides[(photoIndex + 1) % slides.length];
    if (!n || !n.image || preloaded[n.image]) return;
    preloaded[n.image] = true;
    var img = new Image();
    img.src = n.image;
    tinyCopy(n.image, function () { });
  }

  // Une autre photo, l'accueil ou un appel : la vidéo du diaporama s'arrête.
  function stopSlideVideo() {
    var vs = document.querySelectorAll('#view-photos video.slide-vid');
    for (var i = 0; i < vs.length; i++) {
      vs[i].onended = vs[i].onerror = vs[i].onloadeddata = vs[i].onplaying = null;
      try { vs[i].pause(); } catch (e) { }
      vs[i].removeAttribute('src');
      vs[i].style.display = 'none';
    }
  }

  // La plus récente est à l'index 0 : « suivante » va vers les plus récentes.
  // Diaporama en boucle : après la plus ancienne, on revient à la plus récente, et inversement.
  function olderPhoto() { if (slides.length > 1) { photoIndex = (photoIndex + 1) % slides.length; renderPhoto(); } }
  function newerPhoto() { if (slides.length > 1) { photoIndex = (photoIndex - 1 + slides.length) % slides.length; renderPhoto(); } }

  // ---------- Vu ----------

  function markSeen(p) {
    if (p.seen) return;
    p.seen = true;
    if (android()) android().markSeen(p.id);
  }


  // ---------- Messages vocaux ----------

  var playing = null; // { post, onEnd }

  function formatDuration(s) {
    return Math.floor(s / 60) + ':' + pad(s % 60);
  }

  function playVoice(p, onEnd) {
    stopAudio();
    playing = { post: p, onEnd: onEnd };
    if (p.video) {
      var a = android();
      var ratio = parseFloat($('overlay').style.getPropertyValue('--photo-ratio')) || 0;
      if (a && a.playVideoAt && ratio) {
        if (ratio < 1) {
          // En hauteur : elle joue dans son cadre, le mot reste à côté.
          var r = $('overlay-img').getBoundingClientRect();
          playing.cadre = true; // la page reste visible
          a.playVideoAt(p.video, r.left, r.top, r.width, r.height, false);
        } else {
          // En largeur : toute la hauteur de l'écran, centrée (les côtés qui dépassent sont coupés).
          var hh = window.innerHeight, ww = hh * ratio;
          document.body.className += ' video-playing';
          a.playVideoAt(p.video, (window.innerWidth - ww) / 2, 0, ww, hh, true);
        }
      } else if (a && a.playVideo) {
        document.body.className += ' video-playing';
        a.playVideo(p.video);
      }
    } else if (android() && android().playVoice) {
      android().playVoice(p.audio);
    } else {
      $('player').setAttribute('src', p.audio);
      $('player').play();
    }
    markSeen(p);
  }

  function stopAudio() {
    if (!playing) return;
    if (playing.post.video) {
      if (android() && android().stopVideo) android().stopVideo();
      document.body.className = document.body.className.replace(' video-playing', '');
    } else if (android() && android().stopVoice) android().stopVoice();
    else $('player').pause();
    playing = null;
  }

  // Fin de lecture (appelé par Android quand le vocal est terminé).
  function voiceEnded() {
    document.body.className = document.body.className.replace(' video-playing', '');
    var p = playing;
    playing = null;
    if (p && p.onEnd) p.onEnd();
  }

  // ---------- Écran d'un nouvel envoi : photo, message, vocal ou vidéo ----------

  function queueUnseen() {
    if (window.papotePaused) return; // en pause : rien ne s'affiche ni n'est marqué « vu »
    // Chaque envoi attend son tour, du plus ancien au plus récent : une nouvelle photo ne
    // remplace jamais celle qui est affichée tant que Mamie ne l'a pas vue (OK ou visage vu).
    for (var i = posts.length - 1; i >= 0; i--) {
      var p = posts[i];
      // Une photo ou un vocal n'est montré que lorsqu'il est téléchargé.
      if (p.seen || shownInOverlay[p.id] || (p.type === 'photo' && !p.image) || (p.type === 'voice' && !p.audio) || (p.type === 'video' && !p.video)) continue;
      shownInOverlay[p.id] = true;
      overlayQueue.push(p);
    }
    if (!overlayPost && !inCall()) nextOverlay();
  }

  // ---------- Visage vu : « lu », lecture, puis fermeture au bout de 2 minutes ----------
  // La caméra (appels.js, window.papoteWatchPresence) regarde si quelqu'un est devant la tablette.
  // Dès que son visage est vu, l'envoi ou le rappel est marqué « lu » pour la famille (onSeen),
  // une vidéo ou un vocal se lance, puis l'écran se ferme tout seul 2 minutes plus tard s'il n'a
  // pas touché OK. Jamais vu : il reste affiché, pour qu'elle ne rate rien.
  // Renvoie false quand la tablette ne sait pas regarder (pas de caméra côté page).

  var SEEN_CLOSE_MS = 120000;
  var watchers = {};

  function watchSeen(slot, onSeen, close) {
    unwatchSeen(slot);
    if (typeof window.papoteWatchPresence !== 'function') { console.warn('Caméra : pas de détection de visage'); return false; }
    var w = { stop: null, timer: null };
    watchers[slot] = w;
    try {
      w.stop = window.papoteWatchPresence(function () {
        if (watchers[slot] !== w || w.timer) return;
        console.warn('Visage vu (' + slot + ')');
        // Elle est là : le carillon d'arrivée s'arrête.
        try { if (android() && android().carillonStop) android().carillonStop(); } catch (e) { }
        try { onSeen(); } catch (e) { console.warn('Visage vu : ' + e); }
        w.timer = setTimeout(function () {
          if (watchers[slot] !== w) return;
          unwatchSeen(slot);
          close();
        }, SEEN_CLOSE_MS);
      });
    } catch (e) {
      delete watchers[slot];
      return false;
    }
    return true;
  }

  function unwatchSeen(slot) {
    var w = watchers[slot];
    if (!w) return;
    delete watchers[slot];
    clearTimeout(w.timer);
    try { if (typeof w.stop === 'function') w.stop(); } catch (e) { }
  }

  // Un appel arrive : la photo ou le message affiché s'efface, sans être compté comme vu ;
  // il revient en tête de file à la fin de l'appel, avec ceux qui attendaient.
  function closeOverlayForCall() {
    if (!overlayPost) return;
    stopAudio();
    overlayQueue.unshift(overlayPost);
    unwatchSeen('overlay');
    overlayPost = null;
    show($('overlay'), false);
  }
  setInterval(function () {
    if (!overlayPost && overlayQueue.length && !inCall()) nextOverlay();
  }, 2000);

  function setOverlayActions(visible, withReplay) {
    show($('overlay-actions'), visible);
    show($('overlay-replay'), !!withReplay);
  }

  function nextOverlay() {
    unwatchSeen('overlay');
    stopSpeaking();
    overlayPost = overlayQueue.shift() || null;
    if (overlayPost) stopRadio();
    if (!overlayPost) {
      show($('overlay'), false);
      return;
    }
    var p = overlayPost;
    noteVoix(overlayText(p), p.voice, p.announce);
    // Visage vu : « lu », et une vidéo ou un vocal démarre tout seul.
    var watching = watchSeen('overlay', function () {
      if (overlayPost !== p) return;
      noteSeen();
      markSeen(p);
      // Après le carillon d'arrivée (sinon les deux sons se mélangent), et pour un envoi tout juste
      // arrivé, après sa voix (le serveur la crée une seconde ou deux après la photo).
      apresCarillon(function () {
        if (overlayPost !== p) return;
        if (p.audio || p.video) { listenOverlay(); return; }
        attendreVoix(p, function () {
          if (overlayPost === p) speakOnce(p.id, overlayText(p)); // lu une fois tout seul ; « Écouter » pour réécouter
        });
      });
    }, function () {
      // Rien : l'envoi reste affiché jusqu'à ce qu'elle touche OK (Tanguy, 26/10 : il passait au
      // suivant tout seul au bout de 2 minutes, avant qu'elle ait fini de regarder).
    });
    var mode = p.image ? 'photo' : p.type === 'voice' ? 'voice' : p.type === 'video' ? 'video' : 'message';
    var media = mode === 'voice' || mode === 'video';
    // Photo, vidéo et message : le grand mot signé à gauche, l'image à droite (classe papier).
    // Message : le mot seul sur toute la largeur, signé du prénom (pas de photo de profil : jugée moche).
    var papier = mode === 'photo' || mode === 'video' || mode === 'message';
    $('overlay').className = 'overlay ln mode-' + mode + (papier ? ' papier' : '') + (mode === 'message' ? ' seul' : '');
    // Photo en paysage : elle prend toute la largeur, le mot passe dessous en bandeau.
    if (mode === 'photo') {
      var probe = new Image();
      $('overlay').style.removeProperty('--photo-ratio');
      probe.onload = function () {
        if (overlayPost !== p || !probe.naturalHeight) return;
        // En hauteur : la place de la photo suit ses proportions (photo entière, sans fond flou).
        $('overlay').style.setProperty('--photo-ratio', String(probe.naturalWidth / probe.naturalHeight));
        if (probe.naturalWidth > probe.naturalHeight * 1.1) {
          $('overlay').className = 'overlay ln mode-photo papier wide';
        }
        // La carte change de largeur avec la photo : le texte est réajusté.
        $('overlay-text').style.fontSize = '';
        setTimeout(function () { ajusterTexte($('overlay-text')); }, 0);
      };
      probe.src = p.image;
    }
    // Message ou photo : en haut, qui l'envoie (visage, prénom, quand) ; dessous, son mot ou sa légende.
    // Vocal ou vidéo : le visage au-dessus de « Une vidéo de … ».
    var text = mode === 'message' ? p.text
      : mode === 'photo' ? (legende(p.text) || motParDefaut(p))
        : mode === 'voice' ? 'Un message vocal de ' + p.authorName
          : legende(p.text) || motParDefaut(p); // sans légende : un des mots par défaut, comme une photo
    fillHead(media ? null : p);
    // Photo : pas de petit mot seul en bout de ligne (« Je » / « t’embrasse »), il reste avec le suivant.
    // Ponctuation française (« ! », « ? », « : ») jamais seule en début de ligne.
    $('overlay-text').textContent = papier ? text.replace(/(^|\s)(\S{1,2})\s/g, '$1$2 ').replace(/\s+([!?:;»])/g, ' $1') : text;
    $('overlay-text').className = 'ln-text ' + (mode === 'photo' ? 'size-m' + (text.length > 40 ? ' long' : '')
      : mode === 'message' ? 'msg-' + (text.length <= 60 ? 'court' : text.length <= 110 ? 'moyen' : 'long') : sizeClass(text));
    show($('overlay-text'), !!text);
    $('overlay-text').style.fontSize = '';
    if (papier) setTimeout(function () { ajusterTexte($('overlay-text')); }, 0);
    showListenButtons();
    // Photo : signée sous la légende (« — Julie »), comme un mot écrit à la main.
    $('overlay-from').textContent = papier ? '— ' + (p.authorName || '') : '';
    // Message : quand il est arrivé, discret, à côté du prénom (« aujourd'hui à 15h40 »).
    if (mode === 'message' && p.createdAt) {
      var quand = document.createElement('span');
      quand.className = 'sign-quand';
      quand.textContent = sentLabel(p.createdAt);
      $('overlay-from').appendChild(quand);
    }
    show($('overlay-from'), papier);
    var face = faceOf(p);
    show($('overlay-face'), media && !!face);
    if (media && face) $('overlay-face').setAttribute('src', face);
    // Photo : à droite, sur toute la hauteur.
    show($('ln-media'), papier && mode !== 'message');
    show($('overlay-media-play'), mode === 'video');
    if (mode === 'video') videoPoster(p);
    if (mode === 'photo') {
      setPicture($('overlay-img'), p.image);
      $('overlay-img-bg').style.backgroundImage = 'none';
      tinyCopy(p.image, function (bg) { $('overlay-img-bg').style.backgroundImage = bg; });
    }
    show($('ln-playzone'), media);
    $('overlay-play').className = 'ln-play';
    $('overlay-play').querySelector('.label').textContent = mode === 'video' ? 'Regarder' : 'Écouter';
    $('overlay-replay').querySelector('.label').textContent = mode === 'video' ? 'Revoir' : 'Réécouter';
    // Vocal ou vidéo : d'abord seulement « Écouter » / « Regarder » ; le reste vient une fois fini.
    setOverlayActions(!media, false);
    show($('overlay'), true);
    // Sans caméra, on ne peut pas savoir s'il a été vu : un message compte comme lu à l'affichage,
    // une vidéo ou un vocal se lance tout de suite.
    if (!watching) {
      if (mode === 'message') markSeen(p);
      if (media) listenOverlay();
    }
  }

  // « aujourd'hui à 14h30 », « hier à 9h05 », « il y a 3 jours »
  function sentLabel(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    var day = dayLabel(ms);
    return day === "aujourd'hui" || day === 'hier' ? day + ' à ' + d.getHours() + 'h' + pad(d.getMinutes()) : day;
  }

  // Légende d'une photo : 60 caractères au plus (limite de l'app famille) ; les anciens envois plus
  // longs sont coupés au dernier mot, avec « … ».
  // Photo sans légende : un petit mot choisi parmi plusieurs (toujours le même pour un envoi donné).
  var MOTS = ['Je pense fort à toi', 'Un petit coucou !', 'Gros bisous !', 'Une pensée pour toi',
    'Je t’embrasse fort', 'Plein de bisous !', 'Bonne journée !'];
  function motParDefaut(p) {
    var id = (p && p.id) || '', h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 9973;
    return MOTS[h % MOTS.length];
  }

  function legende(t) {
    t = (t || '').trim();
    if (t.length <= 60) return t;
    var cut = t.slice(0, 59);
    var sp = cut.lastIndexOf(' ');
    return (sp > 40 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, '') + '…';
  }

  // Mot d'une photo : jamais un mot coupé en deux. Si le plus long mot (ou « Je t’embrasse », collés)
  // dépasse la carte, le texte rapetisse juste assez pour tenir.
  function ajusterTexte(el) {
    if (!el || el.hidden || !el.clientWidth) return;
    var taille = parseFloat(getComputedStyle(el).fontSize);
    var carte = el.parentNode;
    // Trop large (un mot) ou trop haut (message long) pour la carte : on rapetisse.
    for (var i = 0; i < 14 && (el.scrollWidth > el.clientWidth + 1 || carte.scrollHeight > carte.clientHeight + 1); i++) {
      taille *= 0.92;
      el.style.fontSize = taille + 'px';
    }
  }

  function fillHead(p) {
    var head = $('overlay-head');
    while (head.firstChild) head.removeChild(head.firstChild);
    if (!p) return;
    var face = faceOf(p);
    var avatar;
    if (face) {
      avatar = document.createElement('img');
      avatar.setAttribute('src', face);
      avatar.setAttribute('alt', '');
    } else {
      // Sans photo de profil : l'initiale dans un rond.
      avatar = document.createElement('span');
      avatar.textContent = (p.authorName || '?').charAt(0).toUpperCase();
    }
    avatar.className = 'head-face';
    head.appendChild(avatar);
    var who = document.createElement('div');
    who.className = 'head-who';
    var name = document.createElement('span');
    name.className = 'head-name';
    name.textContent = p.authorName || '';
    var when = document.createElement('span');
    when.className = 'head-when';
    when.textContent = sentLabel(p.createdAt);
    who.appendChild(name);
    who.appendChild(when);
    head.appendChild(who);
  }

  // Première image de la vidéo, à droite du mot (et en fond flou), avant qu'elle soit lancée.
  function videoPoster(p) {
    $('overlay').style.removeProperty('--photo-ratio');
    $('overlay-img').setAttribute('data-url', '');
    $('overlay-img').setAttribute('src', BLANK);
    $('overlay-img').style.backgroundImage = 'none';
    $('overlay-img-bg').style.backgroundImage = 'none';
    var v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.addEventListener('loadeddata', function () { try { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); } catch (e) { /* tant pis */ } });
    v.addEventListener('seeked', function () {
      if (overlayPost !== p || !v.videoWidth) return;
      try {
        var c = document.createElement('canvas');
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0);
        var url = c.toDataURL('image/jpeg', 0.85);
        // Même place que pour une photo : en hauteur selon ses proportions, en largeur plus large et zoomée.
        $('overlay').style.setProperty('--photo-ratio', String(v.videoWidth / v.videoHeight));
        if (v.videoWidth > v.videoHeight * 1.1) $('overlay').className = 'overlay ln mode-video papier wide';
        $('overlay-text').style.fontSize = '';
        setTimeout(function () { ajusterTexte($('overlay-text')); }, 0);
        setPicture($('overlay-img'), url);
        $('overlay-img-bg').style.backgroundImage = 'url("' + url + '")';
      } catch (e) { /* pas d'image : le fond reste uni */ }
      v.removeAttribute('src');
    });
    v.src = p.video;
  }

  function listenOverlay() {
    var p = overlayPost;
    if (!p || !(p.audio || p.video) || playing) return;
    $('overlay-play').className = 'ln-play playing';
    $('overlay-play').querySelector('.label').textContent = p.video ? 'Lecture…' : 'Écoute…';
    setOverlayActions(false);
    playVoice(p, function () {
      if (overlayPost !== p) return;
      show($('ln-playzone'), false);
      setOverlayActions(true, !p.video); // vidéo : pas de « Revoir », toucher l'image la relance
    });
  }

  function replayOverlay() {
    show($('ln-playzone'), true);
    listenOverlay();
  }

  // ---------- Données venant d'Android ----------

  // ---------- Chargement du démarrage ----------
  // Visible au moins un instant (pas de clignement), retiré dès qu'Android a parlé, 20 s au plus.

  var bootStart = Date.now();
  var bootDone = false;

  function hideBoot() {
    if (bootDone) return;
    bootDone = true;
    setTimeout(function () {
      var boot = $('boot');
      if (!boot) return;
      boot.className = 'boot gone';
      setTimeout(function () { if (boot.parentNode) boot.parentNode.removeChild(boot); }, 500);
    }, Math.max(0, 1200 - (Date.now() - bootStart)));
  }
  setTimeout(hideBoot, 20000);

  function onStatus(status) {
    hideBoot();
    // Première installation chez le client : nom, wifi, puis appairage (bienvenue.js).
    if (window.PapoteBienvenue) {
      // Pas encore de famille (ou remise sur Bienvenue) : pas d'écran « en pause » d'une famille d'avant.
      if (status.state === 'welcome') { setPaused(''); window.PapoteBienvenue.show(status); return; }
      window.PapoteBienvenue.hide();
    }
    if (status.state === 'setup') {
      $('setup-detail').textContent = status.message || '';
      if (!hasData) showView('view-setup');
    } else {
      if (isShown('view-setup')) showView('view-home');
    }
  }

  function onPosts(payload) {
    hideBoot();
    hasData = true;
    // On garde « vu » localement même si Firebase ne l'a pas encore enregistré.
    var seenBefore = {};
    for (var i = 0; i < posts.length; i++) if (posts[i].seen) seenBefore[posts[i].id] = true;
    posts = payload.posts || [];
    familyCode = payload.familyCode || '';
    setTextSize(payload.textSize);
    setPaused(payload.subscription);
    setOptions(payload.options);
    setVeille(payload.veille);
    photos = [];
    slides = [];
    for (var j = 0; j < posts.length; j++) {
      if (seenBefore[posts[j].id]) posts[j].seen = true;
      // La voix d'un envoi arrive souvent après lui : on la note dès qu'elle est là.
      noteVoix(overlayText(posts[j]), posts[j].voice, posts[j].announce);
      // Vidéo : dans le diaporama seulement, une fois vue (la première fois, elle arrive en grand).
      if (posts[j].video && !posts[j].image && posts[j].seen) { slides.push(posts[j]); continue; }
      if (!posts[j].image) continue;
      // Envoi de plusieurs photos : chacune a sa place dans la galerie, avec le même mot.
      var extra = posts[j].images || [];
      posts[j].part = 1;
      posts[j].parts = extra.length + 1;
      photos.push(posts[j]);
      slides.push(posts[j]);
      for (var k = 0; k < extra.length; k++) {
        var copy = {};
        for (var key in posts[j]) if (posts[j].hasOwnProperty(key)) copy[key] = posts[j][key];
        copy.image = extra[k];
        copy.part = k + 2;
        photos.push(copy);
        slides.push(copy);
      }
    }
    if (isShown('view-setup')) showView('view-home');
    setBackdrops();
    renderFrame();
    renderBadges();
    if (isShown('view-photos')) {
      if (slides.length) {
        // Pas de nouveau rendu si la même chose est affichée : une vidéo en cours continue.
        var current = slides[photoIndex];
        photoIndex = Math.min(photoIndex, slides.length - 1);
        if (!current || current.image || slides[photoIndex].id !== current.id) renderPhoto();
      } else {
        showView('view-home');
      }
    }
    queueUnseen();
  }

  // ---------- Rappels : en grand un peu avant, puis à l'heure ----------

  var reminders = [];
  var EARLY_MIN = 15;            // annonce « Dans 15 minutes » (sauf avanceMin réglé par la famille)
  var REMINDER_WINDOW_MIN = 60;  // un rappel manqué reste affiché pendant 1 heure
  var RESOUND_MIN = 5;           // le son est rejoué toutes les 5 minutes tant que ce n'est pas fait
  var alerting = null;           // { r, key, early, lastSound }
  var handled = {};              // rappels confirmés : id|date -> true
  var announced = {};            // annonces « bientôt » déjà vues : id|date -> true

  function dateKey(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function minutesOf(time) {
    var parts = (time || '00:00').split(':');
    return Number(parts[0]) * 60 + Number(parts[1]);
  }

  // Avance de l'annonce choisie par la famille (0 : rien avant l'heure), 4 h au plus.
  function earlyMin(r) {
    var m = typeof r.avanceMin === 'number' ? r.avanceMin : EARLY_MIN;
    return Math.max(0, Math.min(240, m));
  }

  function happensOn(r, d) {
    var key = dateKey(d);
    // Dates « AAAA-MM-JJ » : la comparaison de textes suit l'ordre des jours.
    if (r.finLe && key > r.finLe) return false;          // rappel terminé
    if (r.enPauseJusquau && key <= r.enPauseJusquau) return false; // en pause
    if (r.repeat === 'daily') return true;
    if (r.repeat === 'weekly') return r.days.indexOf(d.getDay()) >= 0;
    return r.date === key;
  }

  function isDone(r, key) {
    return handled[r.id + '|' + key] || (r.lastAck && r.lastAck.indexOf(key) === 0);
  }

  function kindIcon(kind) {
    return ICONS[kind === 'medicament' ? 'pill' : kind === 'rdv' ? 'doctor' : 'pin'];
  }

  // « 5 minutes », « 1 heure », « 1 h 30 » : l'attente avant un rappel annoncé en avance.
  function inLabel(min) {
    if (min < 60) return min + ' minute' + (min > 1 ? 's' : '');
    var h = Math.floor(min / 60), m = min % 60;
    return m ? h + ' h ' + pad(m) : h + ' heure' + (h > 1 ? 's' : '');
  }

  function timeLabel(time) {
    var m = minutesOf(time);
    return Math.floor(m / 60) + 'h' + pad(m % 60);
  }

  // ---------- Rendez-vous proche : affiché à la place de la photo ----------

  function upcomingRdv() {
    var now = new Date();
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var key = dateKey(now);
    var next = null;
    for (var i = 0; i < reminders.length; i++) {
      var r = reminders[i];
      if (r.kind !== 'rdv' || !happensOn(r, now) || isDone(r, key)) continue;
      var delta = minutesOf(r.time) - nowMin;
      if (delta >= 0 && delta <= 60 && (!next || delta < next.delta)) next = { r: r, delta: delta };
    }
    return next;
  }

  function showRdv(next) {
    var el = $('frame-rdv');
    if (!el) {
      el = document.createElement('div');
      el.id = 'frame-rdv';
      el.className = 'frame-rdv';
      el.innerHTML = '<span class="rdv-icon"></span><p class="rdv-when"></p>' +
        '<p class="rdv-title"></p><p class="rdv-in"></p>';
      $('home-frame').appendChild(el);
    }
    show(el, !!next);
    if (!next) return;
    el.querySelector('.rdv-icon').innerHTML = kindIcon('rdv');
    el.querySelector('.rdv-when').textContent = 'Rendez-vous à ' + timeLabel(next.r.time);
    el.querySelector('.rdv-title').textContent = next.r.title;
    el.querySelector('.rdv-in').textContent = next.delta === 0 ? "C'est maintenant"
      : 'Dans ' + next.delta + ' minute' + (next.delta > 1 ? 's' : '');
  }

  // ---------- Prochain rappel du jour, sous la météo de l'accueil ----------

  function showNextReminder(items, nowMin, key) {
    var el = $('home-next');
    if (!el) {
      el = document.createElement('div');
      el.id = 'home-next';
      el.className = 'home-next';
      el.innerHTML = '<span class="next-icon"></span><div><p class="next-when"></p><p class="next-title"></p></div>';
      $('weather').parentNode.appendChild(el);
    }
    var next = null;
    for (var i = 0; i < items.length; i++) {
      if (isDone(items[i], key) || minutesOf(items[i].time) < nowMin) continue;
      next = items[i];
      break;
    }
    show(el, !!next && options.rappelsAccueil !== false);
    if (!next) return;
    el.querySelector('.next-icon').innerHTML = kindIcon(next.kind);
    el.querySelector('.next-when').textContent = (next.kind === 'rdv' ? 'Rendez-vous à ' : 'Tout à l\'heure, à ') + timeLabel(next.time);
    el.querySelector('.next-title').textContent = next.title;
  }

  function checkReminders() {
    if (isShown('view-home')) renderFrame();
    var now = new Date();
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var key = dateKey(now);
    // Pendant un appel : pas de rappel par-dessus, ni de son. Il revient à la fin de l'appel.
    if (inCall()) {
      if (alerting && !alerting.hidden) {
        unwatchSeen('reminder');
        show($('reminder-alert'), false);
        alerting.hidden = true;
      }
      return;
    }
    if (alerting && alerting.hidden) {
      var waiting = alerting;
      alerting = null;
      if (!isDone(waiting.r, waiting.key)) openReminder(waiting.r, waiting.key, nowMin, waiting.early && nowMin < minutesOf(waiting.r.time));
      return;
    }
    var items = [];
    for (var i = 0; i < reminders.length; i++) if (happensOn(reminders[i], now)) items.push(reminders[i]);
    items.sort(function (a, b) { return minutesOf(a.time) - minutesOf(b.time); });
    showNextReminder(items, nowMin, key);

    if (alerting) {
      var late = nowMin - minutesOf(alerting.r.time);
      if (isDone(alerting.r, alerting.key) || late > REMINDER_WINDOW_MIN + callMinutesSince(alerting.key, minutesOf(alerting.r.time))) {
        closeReminder();
      } else if (alerting.early && late >= 0) {
        openReminder(alerting.r, key, nowMin, false); // l'annonce devient « C'est l'heure ! »
      } else if (alerting.early) {
        // Annonce longtemps à l'avance (avanceMin) : le « Dans… » suit l'heure.
        $('reminder-when').textContent = 'Dans ' + inLabel(-late);
      } else if (nowMin - alerting.lastSound >= RESOUND_MIN) {
        alerting.lastSound = nowMin;
        if (android()) android().alert();
      }
      return;
    }
    for (var j = 0; j < items.length; j++) {
      var r = items[j];
      var delta = minutesOf(r.time) - nowMin;
      if (isDone(r, key)) continue;
      if (delta <= 0 && -delta <= REMINDER_WINDOW_MIN + callMinutesSince(key, minutesOf(r.time))) { openReminder(r, key, nowMin, false); return; }
      if (delta > 0 && delta <= earlyMin(r) && !announced[r.id + '|' + key]) { openReminder(r, key, nowMin, true); return; }
    }
  }

  function openReminder(r, key, nowMin, early) {
    alerting = { r: r, key: key, early: early, lastSound: nowMin };
    var delta = minutesOf(r.time) - nowMin;
    $('reminder-when').textContent = early ? 'Dans ' + inLabel(delta) : "C'est l'heure !";
    $('reminder-icon').innerHTML = '<span class="icon">' + kindIcon(r.kind) + '</span>';
    $('reminder-title').textContent = r.title;
    $('reminder-title').className = 'ln-text ' + sizeClass(r.title);
    $('reminder-time').textContent = (r.kind === 'rdv' ? 'Rendez-vous à ' : 'À ') + timeLabel(r.time);
    $('reminder-done').textContent = early ? "J'ai compris" : r.kind === 'rdv' ? "J'ai bien noté" : "C'est fait";
    show($('reminder-alert'), true);
    stopRadio();
    noteVoix(r.title, r.voice);
    showListenButtons();
    if (android()) android().alert();
    // Visage vu : la famille voit « vu » ; sans « C'est fait », le rappel se ferme sans dire que c'est fait.
    watchSeen('reminder', function () {
      if (!alerting || alerting.r !== r) return;
      var now = new Date();
      if (android() && android().seenReminder) android().seenReminder(r.id, dateKey(now) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()));
      speakOnce('rappel|' + r.id + '|' + key + (alerting.early ? '|avant' : ''), r.title);
    }, function () {
      if (!alerting) return;
      var id = alerting.r.id + '|' + alerting.key;
      if (alerting.early) announced[id] = true; else handled[id] = true;
      closeReminder();
      setTimeout(checkReminders, 500);
    });
  }

  function closeReminder() {
    unwatchSeen('reminder');
    alerting = null;
    show($('reminder-alert'), false);
  }

  function confirmReminder() {
    if (!alerting) return;
    var id = alerting.r.id + '|' + alerting.key;
    if (alerting.early) {
      announced[id] = true;
    } else {
      var now = new Date();
      handled[id] = true;
      if (android()) android().ackReminder(alerting.r.id, dateKey(now) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()));
    }
    closeReminder();
    setTimeout(checkReminders, 500);
  }

  // ---------- Photos de profil ----------

  var faces = {};

  function faceOf(p) {
    return (p && p.authorUid && faces[p.authorUid]) || null;
  }

  // Le visage en rond devant le texte ; sans photo de profil, le texte seul.
  function signWithFace(el, p, text) {
    while (el.firstChild) el.removeChild(el.firstChild);
    var face = faceOf(p);
    if (face) {
      var img = document.createElement('img');
      img.className = 'sign-face';
      img.setAttribute('src', face);
      img.setAttribute('alt', '');
      el.appendChild(img);
    }
    var span = document.createElement('span');
    span.className = 'sign-text';
    span.textContent = text;
    el.appendChild(span);
  }

  // ---------- Anniversaires ----------
  // Le jour même : un bandeau sur l'accueil toute la journée, et une fois en plein écran.

  var birthdays = [];
  var bdayQueue = [];
  var bdayShown = {};

  function todaysBirthdays() {
    var now = new Date();
    var out = [];
    for (var i = 0; i < birthdays.length; i++) {
      var b = birthdays[i];
      if (b.day === now.getDate() && b.month === now.getMonth() + 1 && b.name) out.push(b);
    }
    return out;
  }

  // « de Léa », « d'Anne »
  function deName(name) {
    return (/^[aeiouyhàâäéèêëîïôöùûü]/i.test(name) ? "d'" : 'de ') + name;
  }

  function ageLabel(b) {
    if (!b.year) return '';
    var age = new Date().getFullYear() - b.year;
    return age > 0 ? age + (age > 1 ? ' ans' : ' an') + " aujourd'hui" : '';
  }

  function dayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function alreadyShown(b) {
    var key = 'bday-' + dayKey() + '-' + b.id;
    if (bdayShown[key]) return true;
    try { return window.localStorage.getItem(key) === '1'; } catch (e) { return false; }
  }

  function markShown(b) {
    var key = 'bday-' + dayKey() + '-' + b.id;
    bdayShown[key] = true;
    try { window.localStorage.setItem(key, '1'); } catch (e) { /* tant pis */ }
  }

  function renderBirthdayBanner() {
    var today = todaysBirthdays();
    var el = $('bday-banner');
    if (!today.length) { show(el, false); return; }
    var names = [];
    for (var i = 0; i < today.length; i++) names.push(deName(today[i].name));
    var age = today.length === 1 ? ageLabel(today[0]).replace(" aujourd'hui", '') : '';
    $('bday-banner-text').textContent = "Aujourd'hui, c'est l'anniversaire " + names.join(' et ') + ' !' +
      (age ? ' ' + age.charAt(0).toUpperCase() + age.slice(1) + '.' : '');
    show(el, true);
  }

  function checkBirthdays() {
    renderBirthdayBanner();
    if (isShown('bday-alert') || asleep) return;
    if (isShown('overlay') || isShown('reminder-alert') || isShown('call-ring') || isShown('call-view')) return;
    var today = todaysBirthdays();
    for (var i = 0; i < today.length; i++) {
      if (alreadyShown(today[i])) continue;
      var b = today[i];
      $('bday-text').textContent = "Aujourd'hui, c'est l'anniversaire " + deName(b.name) + ' !';
      $('bday-age').textContent = ageLabel(b);
      show($('bday-age'), !!ageLabel(b));
      $('bday-alert').setAttribute('data-id', b.id);
      bdayQueue = [b];
      show($('bday-alert'), true);
      return;
    }
  }

  function closeBirthday() {
    if (bdayQueue.length) markShown(bdayQueue[0]);
    bdayQueue = [];
    show($('bday-alert'), false);
    checkBirthdays();
  }

  // Plus d'internet depuis une minute (et pas de carte SIM qui prend le relais) : à la place de la
  // photo de l'accueil, une carte « Pas d'internet » avec un grand bouton pour régler le wifi.
  // Elle reste tant que la tablette n'est pas reconnectée. Tablette à carte SIM (sans wifi) : le
  // réseau mobile ne répond plus (pas de réseau, forfait épuisé) ; le texte le dit, sans bouton wifi.
  // C'est la seule indication : pas de phrase en plus sous l'heure.
  var offlineSince = 0;
  var wifiCard = null;
  var wifiAutoOpened = false;
  function checkConnection() {
    if (!android() || !android().wifiStatus) return;
    var st = {};
    try { st = JSON.parse(android().wifiStatus()); } catch (e) { return; }
    var now = Date.now();
    if (st.internet) offlineSince = 0;
    else if (!offlineSince) offlineSince = now;
    var showIt = offlineSince && now - offlineSince > 60000 && !st.mobile;
    // Tablette qui démarre sans internet ni données de la famille (par exemple une tablette de
    // remplacement arrivée chez le client) : l'écran du wifi s'ouvre tout de suite, une fois.
    if (!st.internet && !st.mobile && !hasData && !wifiAutoOpened && window.PapoteBienvenue) {
      wifiAutoOpened = true;
      window.PapoteBienvenue.openWifi();
    }
    if (!wifiCard) {
      if (!showIt) return;
      wifiCard = document.createElement('div');
      wifiCard.className = 'wifi-card';
      wifiCard.innerHTML = '<img class="wifi-card-art" src="bienvenue/wifi.svg" alt="">' +
        '<p class="wifi-card-title">Pas d’internet</p>' +
        '<p class="wifi-card-text"></p>' +
        '<button class="wifi-card-btn">Régler le wifi</button>';
      // Toucher la carte n'ouvre pas la galerie photo (le cadre en dessous) ; le bouton ouvre le wifi.
      on(wifiCard, 'click', function (e) {
        e.stopPropagation();
        if (e.target.tagName === 'BUTTON' && window.PapoteBienvenue) window.PapoteBienvenue.openWifi();
      });
      $('home-frame').appendChild(wifiCard);
    }
    if (showIt) {
      var simOnly = st.sim && !st.wifi;
      wifiCard.querySelector('.wifi-card-text').textContent = simOnly
        ? 'Le réseau mobile ne répond pas pour le moment. La tablette réessaie toute seule.'
        : 'La tablette n’est plus connectée au wifi.';
      show(wifiCard.querySelector('.wifi-card-btn'), !simOnly);
    }
    show(wifiCard, !!showIt);
  }

  // Débranchée depuis une minute : un bandeau sur l'accueil demande de rebrancher le chargeur.
  // (La famille est prévenue en même temps, par la fiche de la tablette.)
  var unpluggedSince = 0;
  var powerBanner = null;
  function checkPower() {
    if (!android() || !android().isCharging) return;
    var charging = true;
    try { charging = android().isCharging(); } catch (e) { return; }
    var now = Date.now();
    if (charging) unpluggedSince = 0;
    else if (!unpluggedSince) unpluggedSince = now;
    var showIt = unpluggedSince && now - unpluggedSince > 60000;
    if (!powerBanner) {
      if (!showIt) return;
      powerBanner = document.createElement('div');
      powerBanner.className = 'power-banner';
      powerBanner.innerHTML = '<svg class="power-plug" viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5" fill="none" stroke="currentColor" ' +
        'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '<span>La tablette n’est pas branchée : rebranchez son chargeur.</span>';
      $('view-home').appendChild(powerBanner);
    }
    show(powerBanner, !!showIt);
  }

  // ---------- Appeler la famille (appel audio, sans vidéo) ----------
  // Un gros bouton « Appeler » sur l'accueil. CALL_MODE 'famille' : tout le monde sonne, le premier
  // qui décroche a l'appel. 'personne' : on choisit qui appeler, avec sa photo.
  // L'appel lui-même : window.papoteCallFamily({ to, onState }) dans appels.js (fil des appels).

  var CALL_MODE = 'personne';
  var PER_PAGE = 4;   // 4 visages à la fois au plus
  var pickerPage = 0;
  var people = [];
  var callScreen = null;
  var outCall = null;

  function setPeople(list) { people = list || []; }

  function callApiReady() { return typeof window.papoteCallFamily === 'function'; }

  function initialOf(name) { return (name || '?').charAt(0).toUpperCase(); }

  function faceEl(uid, name, cls, url) {
    var face = url || (uid && faces[uid]);
    var e;
    if (face) {
      e = document.createElement('img');
      e.setAttribute('src', face);
      e.setAttribute('alt', '');
    } else {
      e = document.createElement('span');
      e.textContent = initialOf(name);
    }
    e.className = cls;
    return e;
  }

  function ensureCallScreen() {
    if (callScreen) return;
    callScreen = document.createElement('div');
    callScreen.className = 'call-out';
    callScreen.setAttribute('hidden', '');
    document.body.appendChild(callScreen);
  }

  // Tonalité « ça sonne » pendant que Mamie appelle (comme un téléphone en France :
  // 440 Hz, 1,5 s puis 3,5 s de silence), douce, jusqu'à la réponse ou la fin de l'appel.
  var ringbackCtx = null;
  var ringbackTimer = null;
  function startRingback() {
    if (ringbackTimer) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!ringbackCtx) ringbackCtx = new AC();
      if (ringbackCtx.resume) ringbackCtx.resume();
    } catch (e) { return; }
    var beep = function () {
      try {
        var ctx = ringbackCtx, t = ctx.currentTime;
        var osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.frequency.value = 440;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.06, t + 0.03);
        gain.gain.setValueAtTime(0.06, t + 1.47);
        gain.gain.linearRampToValueAtTime(0, t + 1.5);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 1.55);
      } catch (e) { }
    };
    beep();
    ringbackTimer = setInterval(beep, 5000);
  }
  function stopRingback() {
    clearInterval(ringbackTimer);
    ringbackTimer = null;
  }

  function closeCallScreen() {
    stopRingback();
    if (callScreen) { callScreen.setAttribute('hidden', ''); callScreen.innerHTML = ''; }
    outCall = null;
  }

  function el2(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  // Choix de la personne (mode 'personne') : les visages en grand.
  function showPicker() {
    ensureCallScreen();
    callScreen.innerHTML = '';
    stopRingback();
    callScreen.className = 'call-out picker';
    callScreen.removeAttribute('hidden');
    callScreen.appendChild(el2('h1', 'call-title', 'Qui voulez-vous appeler ?'));
    if (!people.length) callScreen.appendChild(el2('p', 'call-sub', 'Personne à appeler pour le moment.'));
    var pages = Math.max(1, Math.ceil(people.length / PER_PAGE));
    if (pickerPage >= pages) pickerPage = 0;
    var grid = el2('div', 'call-people');
    var list = people.slice(pickerPage * PER_PAGE, pickerPage * PER_PAGE + PER_PAGE);
    for (var i = 0; i < list.length; i++) {
      (function (p) {
        var b = el2('button', 'call-person');
        b.appendChild(faceEl(p.uid, p.name, 'call-person-face'));
        b.appendChild(el2('span', 'call-person-name', p.name));
        on(b, 'click', function () { startCall(p.uid, p.name); });
        grid.appendChild(b);
      })(list[i]);
    }
    callScreen.appendChild(grid);
    var row = el2('div', 'call-nav');
    if (pages > 1) {
      var prev = el2('button', 'call-page', '‹ Précédents');
      prev.disabled = pickerPage === 0;
      on(prev, 'click', function () { pickerPage--; showPicker(); });
      row.appendChild(prev);
    }
    var back = el2('button', 'call-back', 'Retour à l’accueil');
    on(back, 'click', function () { pickerPage = 0; closeCallScreen(); });
    row.appendChild(back);
    if (pages > 1) {
      var next = el2('button', 'call-page', 'Suivants ›');
      next.disabled = pickerPage >= pages - 1;
      on(next, 'click', function () { pickerPage++; showPicker(); });
      row.appendChild(next);
    }
    callScreen.appendChild(row);
    armPickerIdle();
  }

  // Liste « Qui voulez-vous appeler ? » : retour à l'accueil après 1 minute sans toucher l'écran.
  var PICKER_IDLE_MS = 60000;
  var pickerTimer = null;
  function pickerOpen() {
    return !!callScreen && !callScreen.hasAttribute('hidden') && /\bpicker\b/.test(callScreen.className);
  }
  function armPickerIdle() {
    clearTimeout(pickerTimer);
    if (!pickerOpen()) return;
    pickerTimer = setTimeout(function () {
      if (pickerOpen()) { pickerPage = 0; closeCallScreen(); }
    }, PICKER_IDLE_MS);
  }
  document.addEventListener('pointerdown', armPickerIdle, true);

  function onCallButton() {
    pickerPage = 0;
    if (CALL_MODE === 'personne') showPicker();
    else startCall(null, '');
  }

  // Écran d'appel : la personne (ou « la famille »), l'état, et le grand bouton rouge.
  function renderCall(state, title, sub, uid, name, faceUrl) {
    ensureCallScreen();
    callScreen.innerHTML = '';
    callScreen.removeAttribute('hidden');
    callScreen.className = 'call-out state-' + state;
    if (state === 'ringing') startRingback(); else stopRingback();
    var face = uid || name || faceUrl ? faceEl(uid, name, 'call-face', faceUrl) : el2('span', 'call-face family', '');
    if (!uid && !name && !faceUrl) face.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16 11a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm-8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1 1.2.8 2 1.9 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z"/></svg>';
    callScreen.appendChild(face);
    callScreen.appendChild(el2('h1', 'call-title', title));
    if (sub) callScreen.appendChild(el2('p', 'call-sub', sub));
    if (state === 'ringing' || state === 'connected' || state === 'starting') {
      var hang = el2('button', 'call-hangup', 'Raccrocher');
      on(hang, 'click', function () {
        if (outCall && outCall.hangup) { try { outCall.hangup(); } catch (e) { } }
        closeCallScreen();
      });
      callScreen.appendChild(hang);
    }
  }

  function startCall(uid, name) {
    stopRadio();
    if (!callApiReady()) {
      renderCall('failed', 'L’appel n’est pas encore disponible', 'Réessayez dans un moment.', uid, name);
      setTimeout(closeCallScreen, 4000);
      return;
    }
    var who = name || 'la famille';
    renderCall('starting', 'Appel vers ' + who + '…', '', uid, name);
    var finished = false;
    // Fin d'appel : message 4 s, puis l'accueil (appel terminé) ou la liste des personnes
    // (pas de réponse, occupé, échec) pour en appeler une autre.
    function finish(title, sub, backToList) {
      if (finished) return;
      finished = true;
      renderCall('ended', title, sub, uid, name);
      setTimeout(function () {
        outCall = null;
        if (backToList && CALL_MODE === 'personne') showPicker();
        else closeCallScreen();
      }, 4000);
    }
    try {
      outCall = window.papoteCallFamily({
        to: uid || null,
        toName: name || null,
        onState: function (state, info) {
          info = info || {};
          if (state === 'ringing') {
            renderCall('ringing', 'Ça sonne…', uid ? 'Chez ' + who : (info.names && info.names.length ? 'Chez ' + info.names.join(', ') : 'Chez toute la famille'), uid, name);
          } else if (state === 'connected') {
            renderCall('connected', 'En ligne avec ' + (info.name || who), 'Parlez normalement, la tablette vous entend.', uid || null, info.name || name, info.face);
          } else if (state === 'ended') {
            finish('Appel terminé', '');
          } else if (state === 'missed') {
            finish(uid ? who + ' n’a pas pu répondre' : 'Personne n’a répondu', 'Un message lui dit que vous avez appelé.', true);
          } else if (state === 'busy') {
            finish(uid ? who + ' est déjà en ligne' : 'Occupé', 'Réessayez dans un moment.', true);
          } else if (state === 'failed') {
            finish('L’appel n’a pas pu partir', 'Vérifiez qu’il y a internet, puis réessayez.', true);
          }
        }
      });
    } catch (e) {
      finish('L’appel n’a pas pu partir', 'Réessayez dans un moment.');
    }
  }

  function setupCallButton() {
    var b = el2('button', 'big-btn call-btn');
    b.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.6a1 1 0 0 1-.25 1z"/></svg>' +
      '<span>Appeler</span>';
    on(b, 'click', onCallButton);
    document.querySelector('#view-home .home-left').appendChild(b);
    setupSosButton();
  }

  // ---------- SOS famille ----------
  // Un seul appui : « J'appelle toute la famille… », et l'appel part de lui-même au bout de
  // 5 secondes ; « Annuler » rattrape un appui par erreur. Toute la famille sonne en même temps,
  // le premier qui décroche a l'appel. Personne ne répond : un 2e essai, puis la famille reçoit
  // « Mamie a appuyé sur SOS » (serveur). Bouton affiché seulement si la famille l'a activé (options.sos).
  var SOS_DELAY_S = 5;
  var sosTimer = null;

  function setupSosButton() {
    var b = el2('button', 'big-btn sos-btn');
    b.id = 'sos-btn';
    b.setAttribute('hidden', '');
    b.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54z"/></svg>' +
      '<span>SOS famille</span>';
    on(b, 'click', showSosCountdown);
    // En haut, au milieu : loin d'« Appeler », et pas sous les doigts qui attrapent la tablette par le bord.
    var left = document.querySelector('#view-home .home-left');
    left.insertBefore(b, left.firstChild);
  }

  function showSosButton() {
    var b = $('sos-btn');
    if (b) show(b, !!options.sos);
  }

  function showSosCountdown() {
    stopRadio();
    ensureCallScreen();
    callScreen.innerHTML = '';
    stopRingback();
    callScreen.className = 'call-out sos-countdown';
    callScreen.removeAttribute('hidden');
    var face = el2('span', 'call-face family', '');
    face.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16 11a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm-8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1 1.2.8 2 1.9 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z"/></svg>';
    callScreen.appendChild(face);
    callScreen.appendChild(el2('h1', 'call-title', 'J’appelle toute la famille…'));
    var sub = el2('p', 'call-sub', '');
    callScreen.appendChild(sub);
    var cancel = el2('button', 'sos-cancel', 'Annuler');
    on(cancel, 'click', function () { clearInterval(sosTimer); closeCallScreen(); });
    callScreen.appendChild(cancel);
    var left = SOS_DELAY_S;
    var show = function () { sub.textContent = 'L’appel part dans ' + left + (left > 1 ? ' secondes' : ' seconde'); };
    show();
    clearInterval(sosTimer);
    sosTimer = setInterval(function () {
      left--;
      if (left > 0) { show(); return; }
      clearInterval(sosTimer);
      if (/sos-countdown/.test(callScreen.className) && !callScreen.hasAttribute('hidden')) startSos(1);
    }, 1000);
  }

  function startSos(attempt) {
    if (!callApiReady()) {
      renderCall('failed', 'L’appel n’est pas encore disponible', 'Réessayez dans un moment.');
      setTimeout(closeCallScreen, 4000);
      return;
    }
    renderCall('starting', attempt === 1 ? 'Appel de toute la famille…' : 'On réessaie…', '');
    var finished = false;
    function finish(title, sub, ms) {
      if (finished) return;
      finished = true;
      renderCall('ended', title, sub);
      // Pas si un nouveau SOS a été lancé entre-temps : on fermerait son décompte.
      setTimeout(function () { if (/state-ended/.test(callScreen.className)) { outCall = null; closeCallScreen(); } }, ms || 4000);
    }
    try {
      outCall = window.papoteCallFamily({
        sos: attempt,
        onState: function (state, info) {
          info = info || {};
          if (state === 'ringing') {
            renderCall('ringing', attempt === 1 ? 'Ça sonne…' : 'Ça sonne encore…',
              info.names && info.names.length ? 'Chez ' + info.names.join(', ') : 'Chez toute la famille');
          } else if (state === 'connected') {
            renderCall('connected', 'En ligne avec ' + (info.name || 'la famille'), 'Parlez normalement, la tablette vous entend.', info.uid || null, info.name, info.face);
          } else if (state === 'ended') {
            finish('Appel terminé', '');
          } else if (state === 'missed' && attempt === 1) {
            finished = true;
            startSos(2);
          } else if (state === 'missed') {
            finish('La famille est prévenue', 'Quelqu’un va vous rappeler.', 8000);
          } else if (state === 'busy') {
            finish('Occupé', 'Réessayez dans un moment.');
          } else if (state === 'failed') {
            finish('L’appel n’a pas pu partir', 'Vérifiez qu’il y a internet, puis réessayez.');
          }
        }
      });
    } catch (e) {
      finish('L’appel n’a pas pu partir', 'Réessayez dans un moment.');
    }
  }

  // ---------- Options réglées par la famille : Écouter, Radio ----------
  // families/{fid}.options = { lecture, radio: { nom, url, volume }, sos, meteo, rappelsAccueil } (lu par Sync.java).

  var options = {};

  function setOptions(o) {
    options = o || {};
    showListenButtons();
    setupRadio();
    showSosButton();
    // Météo et prochain rappel de l'accueil : affichés sauf si la famille les a enlevés.
    if (weatherReady) show($('weather'), options.meteo !== false);
    checkReminders();
  }

  // « Écouter » : la tablette lit le message ou le rappel à voix haute.
  function listenButton(id, getText, container) {
    var b = $(id);
    if (!b) {
      b = document.createElement('button');
      b.id = id;
      b.className = 'ln-btn listen';
      b.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 10v4h4l5 5V5L7 10H3zm13.5 2A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg><span>Écouter</span>';
      on(b, 'click', function () {
        if (speech !== 'idle') { stopSpeaking(); return; }
        sayAloud(getText());
      });
      container.insertBefore(b, container.firstChild);
    }
    return b;
  }

  // « Écouter » montre ce qui se passe : « Un instant… » pendant que la voix se prépare, puis
  // « Arrêter » qui pulse pendant la lecture (Android prévient : onSpeech), et retour à « Écouter ».
  var speech = 'idle';   // idle | loading | speaking
  var speechTimer = null;
  function setSpeech(state) {
    speech = state;
    clearTimeout(speechTimer);
    // Sans nouvelles d'Android (moteur de voix bloqué), le bouton ne reste pas coincé.
    if (state !== 'idle') speechTimer = setTimeout(function () { setSpeech('idle'); }, state === 'loading' ? 10000 : 120000);
    var label = state === 'loading' ? 'Un instant…' : state === 'speaking' ? 'Arrêter' : 'Écouter';
    var list = document.querySelectorAll('.ln-btn.listen');
    for (var i = 0; i < list.length; i++) {
      list[i].className = 'ln-btn listen' + (state === 'idle' ? '' : ' ' + state);
      list[i].querySelector('span').textContent = label;
    }
  }
  // Phrase fixe (mot par défaut d'une photo) : jouée depuis son fichier MP3, voix Google « Kore »
  // enregistrée une fois (outils/voix/generer-voix-google.js). Tout le reste : la voix d'Android.
  // Voix Google d'un message ou d'un rappel (functions/voix.js), retrouvée par le texte affiché.
  var voixDuTexte = {};
  var annonceDuTexte = {}; // « Julie vous écrit : », jouée juste avant (fichier à part, gardé)
  // Le carillon d'arrivée (Android) est-il en train de sonner ? On attend qu'il finisse, 8 s au plus.
  function apresCarillon(fn, depuis) {
    depuis = depuis || Date.now();
    var a = android();
    var sonne = false;
    try { sonne = !!(a && a.carillonEnCours && a.carillonEnCours()); } catch (e) { }
    if (sonne && Date.now() - depuis < 8000) { setTimeout(function () { apresCarillon(fn, depuis); }, 250); return; }
    fn();
  }

  // Envoi de moins de 2 minutes sans sa voix : on l'attend jusqu'à 10 s (elle arrive avec onPosts).
  function attendreVoix(p, fn, depuis) {
    depuis = depuis || Date.now();
    var t = overlayText(p);
    var recent = p.createdAt && Date.now() - p.createdAt < 120000;
    if (!voixDuTexte[t] && recent && Date.now() - depuis < 10000) {
      setTimeout(function () { attendreVoix(p, fn, depuis); }, 400);
      return;
    }
    fn();
  }

  function noteVoix(text, url, annonce) {
    if (text && url) voixDuTexte[text] = url;
    if (text && annonce) annonceDuTexte[text] = annonce;
  }
  var motAudio = null;
  function sayAloud(text) {
    if (!text) return;
    // Photo sans mot : « Julie vous écrit : Gros bisous ! ». Le mot a sa voix enregistrée (dans la voix
    // du proche si le serveur l'a faite, sinon celle de la tablette), l'annonce vient du serveur.
    var sep = text.indexOf(' vous écrit : ');
    var i = MOTS.indexOf(sep >= 0 ? text.slice(sep + 14) : text);
    var url = voixDuTexte[text] || (i >= 0 ? 'voix/mots/mot-' + i + '.mp3' : null);
    if (url) {
      if (motAudio) motAudio.pause();
      var annonce = annonceDuTexte[text] || null;
      motAudio = new Audio(annonce || url);
      if (annonce) {
        var suite = motAudio;
        suite.onended = function () {
          if (motAudio !== suite) return;
          motAudio = new Audio(url);
          motAudio.onended = function () { setSpeech('idle'); };
          motAudio.onerror = function () { setSpeech('idle'); };
          motAudio.play();
        };
      }
      var parAndroid = function () { // son injoignable (hors ligne) : la voix d'Android lit le texte
        setSpeech('idle');
        if (android() && android().speak) { setSpeech('loading'); android().speak(text); }
      };
      if (!annonce) motAudio.onended = function () { setSpeech('idle'); };
      motAudio.onerror = parAndroid;
      setSpeech('speaking');
      var pr = motAudio.play();
      if (pr && pr.catch) pr.catch(parAndroid);
      return;
    }
    if (!android() || !android().speak) return;
    setSpeech('loading');
    android().speak(text);
  }
  function onSpeech(data) {
    var st = data && data.state;
    if (st === 'speaking') setSpeech('speaking');
    else if (st === 'done') setSpeech('idle');
  }

  function showListenButtons() {
    var o = listenButton('overlay-listen', function () { return overlayText(overlayPost); }, $('overlay-actions'));
    var mode = overlayPost ? (overlayPost.image ? 'photo' : overlayPost.type || 'message') : '';
    show(o, !!options.lecture && !!overlayText(overlayPost) && (mode === 'message' || mode === 'text' || mode === 'photo'));
    var r = listenButton('reminder-listen', function () {
      return alerting ? alerting.r.title : '';
    }, $('reminder-done').parentNode);
    show(r, !!options.lecture);
  }

  function overlayText(p) {
    if (!p) return '';
    // Photo sans légende : annoncée comme les autres, puis le mot par défaut affiché (voix enregistrée).
    var t = p.image ? (legende(p.text) || motParDefaut(p)) : p.text;
    if (!t) return '';
    return (p.authorName ? p.authorName + ' vous écrit : ' : '') + t;
  }

  // Lecture à voix haute toute seule, une seule fois par message ou rappel, quand la caméra voit
  // Mamie devant l'écran (si la famille n'a pas enlevé la lecture). Le bouton « Écouter » reste.
  var spoken = {};
  function speakOnce(id, text) {
    console.warn('Lecture auto : visage vu (' + (options.lecture ? 'lecture activée' : 'lecture désactivée') + (text ? '' : ', rien à lire') + ')');
    if (!options.lecture || !text || spoken[id]) return;
    spoken[id] = true;
    sayAloud(text);
  }

  function stopSpeaking() {
    if (motAudio) { motAudio.pause(); motAudio = null; }
    if (android() && android().stopSpeaking) android().stopSpeaking();
    setSpeech('idle');
  }

  // « Radio » : à côté d'« Appeler », la station choisie par la famille ; le bouton devient « Arrêter ».
  var radioBtn = null;
  var radioAudio = null;
  function setupRadio() {
    var r = options.radio;
    if (!radioBtn) {
      var call = document.querySelector('#view-home .call-btn');
      if (!call) return;
      var row = document.createElement('div');
      row.className = 'home-actions';
      call.parentNode.insertBefore(row, call);
      row.appendChild(call);
      radioBtn = document.createElement('button');
      radioBtn.className = 'big-btn radio-btn';
      on(radioBtn, 'click', toggleRadio);
      row.appendChild(radioBtn);
    }
    if (!r || !r.url) stopRadio();
    else if (radioAudio) radioAudio.volume = radioVolume(r);
    show(radioBtn, !!(r && r.url));
    renderRadioBtn();
  }

  function renderRadioBtn() {
    if (!radioBtn) return;
    var on2 = !!radioAudio;
    radioBtn.className = 'big-btn radio-btn' + (on2 ? ' playing' : '');
    radioBtn.innerHTML = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="' +
      (on2 ? 'M6 6h12v12H6z' : 'M4 9h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zm3 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm7 1v1h5v-1zm0 3v1h5v-1zM6 8l10-4 .5 1.2L8.5 8z') +
      '"/></svg><span>' + (on2 ? 'Arrêter' : 'Radio') + '</span>';
  }

  // Même niveau que le reste de la tablette (vocaux, vidéos), réglé par le volume de la famille
  // et le haut-parleur (décision de Tanguy). Les radios sont mixées plus fort qu'un vocal
  // enregistré au téléphone : on les baisse d'autant (environ -6 dB) pour que tout sonne pareil.
  var RADIO_GAIN = 0.5;
  function radioVolume() {
    return RADIO_GAIN;
  }

  function toggleRadio() {
    if (radioAudio) { stopRadio(); return; }
    var r = options.radio;
    if (!r || !r.url) return;
    radioAudio = new Audio(r.url);
    radioAudio.volume = radioVolume(r);
    radioAudio.onerror = function () { stopRadio(); };
    var play = radioAudio.play();
    if (play && play.catch) play.catch(function () { stopRadio(); });
    renderRadioBtn();
  }

  // Écran éteint (veille, bouton marche) : la radio s'arrête.
  document.addEventListener('visibilitychange', function () { if (document.hidden) stopRadio(); });

  // Appel reçu (sonnerie, puis appel) : la radio se tait, puis reprend une fois l'appel fini.
  var radioPausedForCall = false;
  function inCall() {
    var ids = ['call-ring', 'call-view'];
    for (var i = 0; i < ids.length; i++) if ($(ids[i]) && isShown(ids[i])) return true;
    // Appel lancé par Mamie (« Ça sonne… », « En ligne avec… »), pas le choix de la personne.
    return !!callScreen && !callScreen.hasAttribute('hidden') && /state-(starting|ringing|connected)/.test(callScreen.className);
  }

  // Périodes d'appel du jour, en minutes : un rappel qui tombe pendant un appel attend la fin,
  // et reste affiché d'autant plus longtemps (voir checkReminders).
  var callSpans = [];      // { day, from, to }
  var callSince = null;    // minute du début de l'appel en cours
  function nowMinutes() { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  function trackCallSpans() {
    var busy = inCall();
    if (busy && callSince === null) callSince = nowMinutes();
    if (!busy && callSince !== null) {
      callSpans.push({ day: dateKey(new Date()), from: callSince, to: nowMinutes() });
      callSince = null;
      setTimeout(checkReminders, 1500); // le rappel en attente s'affiche dès la fin de l'appel
    }
  }
  // Minutes d'appel tombées dans la fenêtre d'affichage d'un rappel (heure, puis 1 h + ces minutes).
  function callMinutesSince(day, start) {
    var extra = 0;
    var spans = callSpans.concat(callSince === null ? [] : [{ day: dateKey(new Date()), from: callSince, to: nowMinutes() }]);
    for (var i = 0; i < spans.length; i++) {
      var sp = spans[i];
      if (sp.day !== day) continue;
      var end = start + REMINDER_WINDOW_MIN + extra;
      extra += Math.max(0, Math.min(sp.to, end) - Math.max(sp.from, start));
    }
    return extra;
  }

  function checkCallForRadio() {
    trackCallSpans();
    if (inCall()) stopSlideVideo();
    if (inCall()) {
      if (radioAudio) { stopRadio(); radioPausedForCall = true; }
    } else if (radioPausedForCall) {
      radioPausedForCall = false;
      if (!radioAudio && !asleep && options.radio && options.radio.url) toggleRadio();
    }
  }
  setInterval(checkCallForRadio, 1000);

  function stopRadio() {
    if (radioAudio) {
      try { radioAudio.pause(); radioAudio.src = ''; } catch (e) { }
      radioAudio = null;
    }
    renderRadioBtn();
  }

  // ---------- Présence : « vue aujourd'hui » ----------
  // Toutes les 15 minutes en journée, la caméra regarde 30 secondes au plus si quelqu'un est devant.
  // Visage vu : la tablette le note (members/{uid}.lastSeen). Personne de vu ni de toucher le matin :
  // la famille reçoit une alerte à midi (côté serveur).
  var PRESENCE_EVERY_MS = 15 * 60000;
  var PRESENCE_LOOK_MS = 30000;
  var lastSeenSent = 0;

  function noteSeen() {
    var now = Date.now();
    if (now - lastSeenSent < 60000) return;
    lastSeenSent = now;
    if (android() && android().seen) android().seen();
  }

  // Un toucher sur l'écran (OK sur un message lu, Appeler…) compte aussi : elle est là.
  document.addEventListener('pointerdown', noteSeen, true);

  function lookForPresence() {
    if (asleep || typeof window.papoteWatchPresence !== 'function') return;
    if (callScreen && !callScreen.hasAttribute('hidden')) return;
    var stop = null;
    var done = false;
    function end() {
      if (done) return;
      done = true;
      try { if (typeof stop === 'function') stop(); } catch (e) { }
    }
    try {
      stop = window.papoteWatchPresence(function () { noteSeen(); end(); });
    } catch (e) { return; }
    setTimeout(end, PRESENCE_LOOK_MS);
  }

  function setupHomeExtras() {
    setInterval(lookForPresence, PRESENCE_EVERY_MS);
    setTimeout(lookForPresence, 60000);
    setupCallButton();
    setInterval(checkConnection, 30000);
    setTimeout(checkConnection, 20000);
    setInterval(checkPower, 15000);
    setTimeout(checkPower, 5000);
    var moment = document.createElement('p');
    moment.id = 'moment';
    moment.className = 'moment';
    $('date').parentNode.insertBefore(moment, $('date').nextSibling);
  }

  function setupFamilyExtras() {
    var banner = document.createElement('div');
    banner.id = 'bday-banner';
    banner.className = 'bday-banner';
    banner.setAttribute('hidden', '');
    banner.innerHTML = '<span class="bday-cake"></span><span id="bday-banner-text"></span>';
    $('weather').parentNode.appendChild(banner);

    var alert = document.createElement('div');
    alert.id = 'bday-alert';
    alert.className = 'overlay ln bday';
    alert.setAttribute('hidden', '');
    alert.innerHTML = '<div class="ln-main"><div class="ln-wood"><div class="ln-note">' +
      '<p id="bday-text" class="ln-text size-l"></p><p id="bday-age" class="ln-sign"></p>' +
      '</div></div></div><div class="ln-bar"><div class="ln-actions">' +
      '<button id="bday-ok" class="ln-btn ok">OK</button></div></div>';
    document.body.appendChild(alert);
    on($('bday-ok'), 'click', closeBirthday);

    var face = document.createElement('img');
    var head = document.createElement('div');
    head.id = 'overlay-head';
    head.className = 'ln-head';
    $('overlay-text').parentNode.insertBefore(head, $('overlay-text'));
    $('overlay-play').insertAdjacentHTML('afterbegin', '<span class="play-icon">' + ICONS.play + '</span>');
    $('overlay-media-play').innerHTML = ICONS.play;
    // Revoir : un rond avec une flèche (comme le haut-parleur), le texte ne tient pas à côté de OK en largeur.
    $('overlay-replay').insertAdjacentHTML('afterbegin', '<span class="icon">' + ICONS.replay + '</span>');

    face.id = 'overlay-face';
    face.className = 'overlay-face';
    face.setAttribute('alt', '');
    face.setAttribute('hidden', '');
    $('overlay-text').parentNode.insertBefore(face, $('overlay-text'));

    setInterval(checkBirthdays, 30000);
  }

  function onFamily(payload) {
    faces = payload.faces || {};
    setPeople(payload.people);
    // Les photos de profil arrivent parfois après l'envoi affiché : on le met à jour.
    if (overlayPost) fillHead(overlayPost);
    if (photos.length) renderFrame();
    birthdays = payload.birthdays || [];
    checkBirthdays();
  }

  function onReminders(payload) {
    reminders = payload.reminders || [];
    checkReminders();
  }

  var lastMinute = -1;
  setInterval(function () {
    var m = new Date().getMinutes();
    if (m === lastMinute) return;
    lastMinute = m;
    checkReminders();
  }, 1000);

  window.Papote = {
    onStatus: onStatus,
    onPosts: onPosts,
    onWeather: onWeather,
    onReminders: onReminders,
    onFamily: onFamily,
    onVoiceEnded: voiceEnded,
    onSpeech: onSpeech,
    onLeave: function () { if (window.papoteAppelsLeave) window.papoteAppelsLeave(); },
    // Famille supprimée ou installation annulée : le compte des appels oublie l'ancienne famille et
    // attendra le prochain jumelage (sa fiche a déjà disparu avec la famille).
    onFamilyLost: function () { if (window.papoteAppelsForget) window.papoteAppelsForget(); },
    closeOverlayForCall: closeOverlayForCall,
    goHome: function () { showView('view-home'); }
  };

  // ---------- La nuit, l'écran se met en veille ----------
  // Pendant la veille (23h-7h sauf réglage de la famille) : écran noir et luminosité au minimum. Un toucher le rallume 2 minutes ;
  // un rappel ou un appel le rallume tant qu'il est affiché. Un nouvel envoi attend le matin
  // (ou le prochain toucher) pour ne pas allumer l'écran en pleine nuit.

  // Heures de veille réglées par la famille (families/{fid}.veille) ; sans réglage, 23h-7h.
  var veille = { active: true, de: 23, a: 7 };

  function setVeille(v) {
    veille = v && typeof v.de === 'number' && typeof v.a === 'number'
      ? { active: v.active !== false, de: v.de, a: v.a }
      : { active: true, de: 23, a: 7 };
  }

  // Heure dans [de, a[, en passant minuit si besoin ; de === a : jamais.
  function inHours(hour, from, to) {
    if (from < to) return hour >= from && hour < to;
    if (from > to) return hour >= from || hour < to;
    return false;
  }

  function isNight(hour) { return veille.active && inHours(hour, veille.de, veille.a); }

  // Couleurs du soir : deux heures avant la veille jusqu'au réveil (21h-7h sans réglage).
  function isEvening(hour) {
    return veille.active ? inHours(hour, (veille.de + 22) % 24, veille.a) : inHours(hour, 21, 7);
  }
  var WAKE_MS = 120000;
  var wakeUntil = 0;
  var asleep = false;
  var sleepScreen = null;

  function somethingToShow() {
    var ids = ['reminder-alert', 'call-ring', 'call-view'];
    for (var i = 0; i < ids.length; i++) if ($(ids[i]) && isShown(ids[i])) return true;
    return document.body.className.indexOf('video-playing') >= 0;
  }

  function updateSleep() {
    var hour = new Date().getHours();
    var night = isNight(hour);
    var should = night && Date.now() > wakeUntil && !somethingToShow();
    if (should) stopRadio();
    if (should === asleep) return;
    asleep = should;
    sleepScreen.style.display = should ? 'block' : 'none';
    if (should) { showView('view-home'); stopRadio(); }
    if (android() && android().setSleep) android().setSleep(should);
  }

  function wakeScreen() {
    wakeUntil = Date.now() + WAKE_MS;
    updateSleep();
  }

  function setupSleep() {
    sleepScreen = document.createElement('div');
    sleepScreen.style.cssText = 'display:none;position:fixed;top:0;right:0;bottom:0;left:0;z-index:1000;background:#000';
    // Horloge douce la nuit : une grande heure très sombre, pour savoir l'heure au réveil.
    var nightClock = document.createElement('div');
    nightClock.className = 'night-clock';
    sleepScreen.appendChild(nightClock);
    function tickNight() {
      var d = new Date();
      nightClock.textContent = d.getHours() + ':' + pad(d.getMinutes());
    }
    tickNight();
    setInterval(tickNight, 20000);
    document.body.appendChild(sleepScreen);
    // Le toucher qui rallume l'écran ne déclenche rien d'autre.
    on(sleepScreen, 'touchstart', function (e) { e.preventDefault(); e.stopPropagation(); wakeScreen(); });
    on(document, 'touchstart', function () { if (!asleep) wakeUntil = Date.now() + WAKE_MS; });
    setInterval(updateSleep, 1000);
    updateSleep();
  }

  // ---------- Événements ----------

  function start() {
    fillIcons();
    setupSleep();
    setupFamilyExtras();
    setupHomeExtras();
    tick();
    tick();
    setInterval(tick, 1000);
    setInterval(function () {
      if (!photos.length || !isShown('view-home')) return;
      frameIndex = (frameIndex + 1) % Math.min(photos.length, 20);
      renderFrame();
    }, FRAME_MS);

    on(document, 'touchstart', resetIdle);
    on(document, 'mousedown', resetIdle);
    var homes = document.querySelectorAll('[data-home]');
    for (var i = 0; i < homes.length; i++) {
      on(homes[i], 'click', function () { stopAudio(); showView('view-home'); });
    }
    on($('home-frame'), 'click', function () { openPhotos(frameIndex); });
    on($('reminder-done'), 'click', confirmReminder);
    on($('overlay-play'), 'click', listenOverlay);
    // Vocal ou vidéo : toucher l'illustration lance aussi la lecture.
    on(document.querySelector('#overlay .ln-wood'), 'click', function () {
      if (overlayPost && (overlayPost.audio || overlayPost.video) && isShown('ln-playzone')) listenOverlay();
    });
    on($('overlay-replay'), 'click', replayOverlay);
    // Vidéo : toucher son image la lance aussi (ou la relance).
    on($('overlay-media-play'), 'click', function () {
      if (playing) return;
      if (isShown('ln-playzone')) listenOverlay(); else replayOverlay();
    });
    on($('player'), 'ended', voiceEnded);
    on($('photo-prev'), 'click', olderPhoto);
    on($('photo-next'), 'click', newerPhoto);
    on($('overlay-close'), 'click', function () {
      stopAudio();
      if (overlayPost) markSeen(overlayPost);
      nextOverlay();
    });

    // Veille : on signale à l'app que Mamie utilise la tablette (au plus une fois par minute).
    var lastTouch = 0;
    on(document, 'touchstart', function () {
      var now = Date.now();
      if (now - lastTouch < 60000) return;
      lastTouch = now;
      if (android() && android().touched) android().touched();
    });

    // Glisser le doigt sur la photo pour passer à la suivante.
    var startX = null;
    on($('photo-stage'), 'touchstart', function (e) { startX = e.touches[0].clientX; restartSlides(); });
    on($('view-photos'), 'touchstart', wakeArrows);
    on($('photo-stage'), 'touchend', function (e) {
      if (startX === null) return;
      var dx = e.changedTouches[0].clientX - startX;
      startX = null;
      if (Math.abs(dx) < 60) return;
      if (dx > 0) olderPhoto(); else newerPhoto();
    });

    showView('view-home');
    if (android()) android().ready();

    // Appels vidéo : seulement si le navigateur de la tablette sait faire de la vidéo (Android 5+).
    var probe = document.createElement('script');
    if ('noModule' in probe && window.RTCPeerConnection && navigator.mediaDevices) {
      var calls = document.createElement('script');
      calls.type = 'module';
      calls.src = 'appels.js';
      document.body.appendChild(calls);
    }
  }

  start();
})();
