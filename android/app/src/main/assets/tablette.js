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
  var CALM_MS = 4000;    // les flèches s'effacent après 4 s sans toucher l'écran

  var JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  var MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
    'septembre', 'octobre', 'novembre', 'décembre'];

  var posts = [];
  var photos = [];
  var photoIndex = 0;
  var frameIndex = 0;
  var overlayQueue = [];
  var overlayPost = null;
  var shownInOverlay = {};
  var idleTimer = null;
  var hasData = false;

  function $(id) { return document.getElementById(id); }
  function android() { return window.PapoteAndroid; }
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
    resetIdle();
  }

  function resetIdle() {
    clearTimeout(idleTimer);
    if (!isShown('view-home') && !isShown('view-setup')) {
      idleTimer = setTimeout(function () { showView('view-home'); }, IDLE_MS);
    }
  }

  // ---------- Horloge, date, mode nuit ----------

  function tick() {
    var now = new Date();
    var time = now.getHours() + ':' + pad(now.getMinutes());
    $('clock').textContent = time;
    $('setup-clock').textContent = time;
    var day = JOURS[now.getDay()];
    $('date').textContent = day.charAt(0).toUpperCase() + day.slice(1) + ' ' + now.getDate() +
      (now.getDate() === 1 ? 'er' : '') + ' ' + MOIS[now.getMonth()];
    var hour = now.getHours();
    // Le moment de la journée, un repère de plus sous la date.
    if ($('moment')) {
      $('moment').textContent = hour >= 5 && hour < 12 ? 'Le matin'
        : hour >= 12 && hour < 18 ? "L'après-midi"
          : hour >= 18 && hour < 22 ? 'Le soir' : 'La nuit';
    }
    document.body.className = ((hour >= 21 || hour < 7) ? 'night' : '') +
      (playing && playing.post.video ? ' video-playing' : '');
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
    return JOURS[d.getDay()] + ' ' + d.getDate() + ' ' + MOIS[d.getMonth()];
  }

  // Taille du texte selon sa longueur : il tient toujours à l'écran sans faire défiler.
  function sizeClass(text) {
    var n = (text || '').length;
    return n <= 50 ? 'size-l' : n <= 110 ? 'size-m' : 'size-s';
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
    66: ['rain', 'Pluie verglaçante'], 67: ['rain', 'Pluie verglaçante'], 71: ['snow', 'Un peu de neige'],
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
      show($('weather'), true);
    } catch (e) { /* données incomplètes : on garde l'affichage précédent */ }
  }

  // ---------- Accueil : cadre photo et compteurs ----------

  function renderFrame() {
    // Un rendez-vous dans moins d'une heure passe avant les photos.
    var rdv = upcomingRdv();
    showRdv(rdv);
    if (rdv) return;
    var has = photos.length > 0;
    show($('frame-img'), has);
    show($('frame-caption'), has);
    show($('frame-empty'), !has);
    if (!has) { renderInvite(); return; }
    frameIndex = frameIndex % Math.min(photos.length, 20);
    var p = photos[frameIndex];
    setPicture($('frame-img'), p.image);
    signWithFace($('frame-caption'), p, p.authorName + ', ' + dayLabel(p.createdAt));
  }

  // Sans photo : un QR code pour que la famille rejoigne Papote depuis son téléphone.
  var familyCode = '';
  var inviteFor = null;
  function renderInvite() {
    var code = familyCode.replace(/-/g, '');
    if (!code || inviteFor === code || !android() || !android().qrCode) return;
    var qr = android().qrCode('https://papote-famille.web.app/?code=' + code);
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

  function openPhotos(index) {
    if (!photos.length) return;
    photoIndex = Math.max(0, Math.min(index, photos.length - 1));
    renderPhoto();
    showView('view-photos');
    wakeArrows();
  }

  // Mode cadre photo : sans toucher l'écran, les flèches s'effacent ; elles reviennent au toucher.
  var calmTimer = null;
  function wakeArrows() {
    $('view-photos').className = 'view photos';
    clearTimeout(calmTimer);
    calmTimer = setTimeout(function () { $('view-photos').className = 'view photos calm'; }, CALM_MS);
  }

  function renderPhoto() {
    var p = photos[photoIndex];
    if (!p) return;
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
    next.className = 'slide';
    setPicture(next.querySelector('img'), p.image);
    var token = ++fadeToken;
    tinyCopy(p.image, function (bg) {
      if (token !== fadeToken) return;
      next.querySelector('.photo-bg').style.backgroundImage = bg;
      next.style.opacity = '1';
    });
    signWithFace($('photo-who'), p, p.authorName + ', ' + dayLabel(p.createdAt));
    $('photo-text').textContent = p.text || '';
    show($('photo-text'), !!p.text);
    if (photoIndex >= photos.length - 1) $('photo-prev').setAttribute('disabled', ''); else $('photo-prev').removeAttribute('disabled');
    if (photoIndex === 0) $('photo-next').setAttribute('disabled', ''); else $('photo-next').removeAttribute('disabled');
    markSeen(p);
    restartSlides();
  }

  // Comme un cadre photo : sans toucher l'écran, on passe à la suivante toutes les 10 s,
  // et après la plus ancienne on revient à la plus récente.
  var slideTimer = null;
  var fadeToken = 0;
  var frontSlide = 'slide-a';
  function restartSlides() {
    clearTimeout(slideTimer);
    slideTimer = setTimeout(function () {
      if (!isShown('view-photos') || photos.length < 2) return;
      photoIndex = (photoIndex + 1) % photos.length;
      renderPhoto();
    }, SLIDE_MS);
  }

  // La plus récente est à l'index 0 : « suivante » va vers les plus récentes.
  function olderPhoto() { if (photoIndex < photos.length - 1) { photoIndex++; renderPhoto(); } }
  function newerPhoto() { if (photoIndex > 0) { photoIndex--; renderPhoto(); } }

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
      document.body.className += ' video-playing';
      if (android() && android().playVideo) android().playVideo(p.video);
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
    var newestPhoto = null;
    for (var i = posts.length - 1; i >= 0; i--) {
      var p = posts[i];
      // Une photo ou un vocal n'est montré que lorsqu'il est téléchargé.
      if (p.seen || shownInOverlay[p.id] || (p.type === 'photo' && !p.image) || (p.type === 'voice' && !p.audio) || (p.type === 'video' && !p.video)) continue;
      shownInOverlay[p.id] = true;
      if (p.image) newestPhoto = p; else overlayQueue.push(p);
    }
    // Une nouvelle photo remplace tout de suite ce qui est affiché, et reste en grand
    // jusqu'à ce que Mamie réponde (OK), qu'une autre photo arrive ou qu'on l'appelle.
    if (newestPhoto) {
      if (overlayPost) markSeen(overlayPost);
      overlayQueue.unshift(newestPhoto);
      stopAudio();
      nextOverlay();
      return;
    }
    if (!overlayPost) nextOverlay();
  }

  // Un appel arrive : on ferme la photo ou le message affiché.
  function closeOverlayForCall() {
    if (!overlayPost) return;
    markSeen(overlayPost);
    stopAudio();
    overlayQueue = [];
    nextOverlay();
  }

  function setOverlayActions(visible, withReplay) {
    show($('overlay-actions'), visible);
    show($('overlay-replay'), !!withReplay);
  }

  function nextOverlay() {
    overlayPost = overlayQueue.shift() || null;
    if (!overlayPost) {
      show($('overlay'), false);
      return;
    }
    var p = overlayPost;
    var mode = p.image ? 'photo' : p.type === 'voice' ? 'voice' : p.type === 'video' ? 'video' : 'message';
    var media = mode === 'voice' || mode === 'video';
    $('overlay').className = 'overlay ln mode-' + mode;
    // Photo en paysage : elle prend toute la largeur, le mot passe dessous en bandeau.
    if (mode === 'photo') {
      var probe = new Image();
      probe.onload = function () {
        if (overlayPost === p && probe.naturalWidth > probe.naturalHeight * 1.1) {
          $('overlay').className = 'overlay ln mode-photo wide';
        }
      };
      probe.src = p.image;
    }
    // Comme un mot écrit à la main : le texte, puis la signature.
    var text = mode === 'message' ? p.text
      : mode === 'photo' ? (p.text || 'Une nouvelle photo pour vous !')
        : mode === 'voice' ? 'Un message vocal de ' + p.authorName
          : 'Une vidéo de ' + p.authorName + (p.text ? ' : ' + p.text : '');
    $('overlay-text').textContent = text;
    $('overlay-text').className = 'ln-text ' + (mode === 'photo' ? 'size-m' : sizeClass(text));
    show($('overlay-from'), !media);
    signWithFace($('overlay-from'), p, '— ' + p.authorName);
    // Vocal ou vidéo : le visage au-dessus de « Un message vocal de … ».
    var face = faceOf(p);
    show($('overlay-face'), media && !!face);
    if (media && face) $('overlay-face').setAttribute('src', face);
    // Photo : à droite, sur toute la hauteur.
    show($('ln-media'), mode === 'photo');
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
    if (mode === 'message') markSeen(p);
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
      setOverlayActions(true, true);
    });
  }

  function replayOverlay() {
    show($('ln-playzone'), true);
    listenOverlay();
  }

  // ---------- Données venant d'Android ----------

  function onStatus(status) {
    if (status.state === 'setup') {
      $('setup-detail').textContent = status.message || '';
      if (!hasData) showView('view-setup');
    } else {
      show($('offline'), status.state === 'offline' && hasData);
      if (isShown('view-setup')) showView('view-home');
    }
  }

  function onPosts(payload) {
    hasData = true;
    // On garde « vu » localement même si Firebase ne l'a pas encore enregistré.
    var seenBefore = {};
    for (var i = 0; i < posts.length; i++) if (posts[i].seen) seenBefore[posts[i].id] = true;
    posts = payload.posts || [];
    familyCode = payload.familyCode || '';
    photos = [];
    for (var j = 0; j < posts.length; j++) {
      if (seenBefore[posts[j].id]) posts[j].seen = true;
      if (posts[j].image) photos.push(posts[j]);
    }
    if (isShown('view-setup')) showView('view-home');
    setBackdrops();
    renderFrame();
    renderBadges();
    if (isShown('view-photos')) {
      if (photos.length) {
        photoIndex = Math.min(photoIndex, photos.length - 1);
        renderPhoto();
      } else {
        showView('view-home');
      }
    }
    queueUnseen();
  }

  // ---------- Rappels : en grand un peu avant, puis à l'heure ----------

  var reminders = [];
  var EARLY_MIN = 15;            // annonce « Dans 15 minutes »
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

  function happensOn(r, d) {
    if (r.repeat === 'daily') return true;
    if (r.repeat === 'weekly') return r.days.indexOf(d.getDay()) >= 0;
    return r.date === dateKey(d);
  }

  function isDone(r, key) {
    return handled[r.id + '|' + key] || (r.lastAck && r.lastAck.indexOf(key) === 0);
  }

  function kindIcon(kind) {
    return ICONS[kind === 'medicament' ? 'pill' : kind === 'rdv' ? 'doctor' : 'pin'];
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

  function checkReminders() {
    if (isShown('view-home')) renderFrame();
    var now = new Date();
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var key = dateKey(now);
    var items = [];
    for (var i = 0; i < reminders.length; i++) if (happensOn(reminders[i], now)) items.push(reminders[i]);
    items.sort(function (a, b) { return minutesOf(a.time) - minutesOf(b.time); });

    if (alerting) {
      var late = nowMin - minutesOf(alerting.r.time);
      if (isDone(alerting.r, alerting.key) || late > REMINDER_WINDOW_MIN) {
        closeReminder();
      } else if (alerting.early && late >= 0) {
        openReminder(alerting.r, key, nowMin, false); // l'annonce devient « C'est l'heure ! »
      } else if (!alerting.early && nowMin - alerting.lastSound >= RESOUND_MIN) {
        alerting.lastSound = nowMin;
        if (android()) android().alert();
      }
      return;
    }
    for (var j = 0; j < items.length; j++) {
      var r = items[j];
      var delta = minutesOf(r.time) - nowMin;
      if (isDone(r, key)) continue;
      if (delta <= 0 && -delta <= REMINDER_WINDOW_MIN) { openReminder(r, key, nowMin, false); return; }
      if (delta > 0 && delta <= EARLY_MIN && !announced[r.id + '|' + key]) { openReminder(r, key, nowMin, true); return; }
    }
  }

  function openReminder(r, key, nowMin, early) {
    alerting = { r: r, key: key, early: early, lastSound: nowMin };
    var delta = minutesOf(r.time) - nowMin;
    $('reminder-when').textContent = early ? 'Dans ' + delta + ' minute' + (delta > 1 ? 's' : '') : "C'est l'heure !";
    $('reminder-icon').innerHTML = '<span class="icon">' + kindIcon(r.kind) + '</span>';
    $('reminder-title').textContent = r.title;
    $('reminder-title').className = 'ln-text ' + sizeClass(r.title);
    $('reminder-time').textContent = (r.kind === 'rdv' ? 'Rendez-vous à ' : 'À ') + timeLabel(r.time);
    $('reminder-done').textContent = early ? "J'ai compris" : r.kind === 'rdv' ? "J'ai bien noté" : "C'est fait";
    show($('reminder-alert'), true);
    if (android()) android().alert();
  }

  function closeReminder() {
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

  // Bandeau et écran créés ici pour ne pas toucher à tablette.html.
  function setupHomeExtras() {
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
    face.id = 'overlay-face';
    face.className = 'overlay-face';
    face.setAttribute('alt', '');
    face.setAttribute('hidden', '');
    $('overlay-text').parentNode.insertBefore(face, $('overlay-text'));

    setInterval(checkBirthdays, 30000);
  }

  function onFamily(payload) {
    faces = payload.faces || {};
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
    onLeave: function () { if (window.papoteAppelsLeave) window.papoteAppelsLeave(); },
    closeOverlayForCall: closeOverlayForCall,
    goHome: function () { showView('view-home'); }
  };

  // ---------- La nuit, l'écran se met en veille ----------
  // De 23h à 7h : écran noir et luminosité au minimum. Un toucher le rallume 2 minutes ;
  // un rappel ou un appel le rallume tant qu'il est affiché. Un nouvel envoi attend le matin
  // (ou le prochain toucher) pour ne pas allumer l'écran en pleine nuit.

  var SLEEP_FROM = 23;
  var SLEEP_TO = 7;
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
    var night = hour >= SLEEP_FROM || hour < SLEEP_TO;
    var should = night && Date.now() > wakeUntil && !somethingToShow();
    if (should === asleep) return;
    asleep = should;
    sleepScreen.style.display = should ? 'block' : 'none';
    if (should) showView('view-home');
    if (android() && android().setSleep) android().setSleep(should);
  }

  function wakeScreen() {
    wakeUntil = Date.now() + WAKE_MS;
    updateSleep();
  }

  function setupSleep() {
    sleepScreen = document.createElement('div');
    sleepScreen.style.cssText = 'display:none;position:fixed;top:0;right:0;bottom:0;left:0;z-index:1000;background:#000';
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
