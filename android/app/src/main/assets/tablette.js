/*
 * Écran de la tablette Papote. Écrit en JavaScript ES5 pour le navigateur d'Android 4.4.
 * Les données arrivent de l'app Android par window.Papote.onStatus / onPosts / onReminders ;
 * les actions repartent par window.PapoteAndroid (markSeen, sendHeart, playVoice…).
 */
(function () {
  'use strict';

  var IDLE_MS = 90000;   // retour à l'accueil après 1 min 30 sans toucher l'écran
  var FRAME_MS = 12000;  // changement de photo sur l'accueil

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
    document.body.className = ((hour >= 21 || hour < 7) ? 'night' : '') +
      (playing && playing.post.video ? ' video-playing' : '');
    // Barre du bas des écrans : « Il est 18h21, samedi 12 juillet »
    var bar = 'Il est ' + hour + 'h' + pad(now.getMinutes()) + ', ' + day + ' ' + now.getDate() +
      (now.getDate() === 1 ? 'er' : '') + ' ' + MOIS[now.getMonth()];
    var clocks = document.querySelectorAll('.ln-clock');
    for (var i = 0; i < clocks.length; i++) clocks[i].textContent = bar;
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
  var CLOUD = '<path fill="#cbd5e1" stroke="#94a3b8" stroke-width="2" d="M20 58h40a12 12 0 0 0 0-24 18 18 0 0 0-34-4A13 13 0 0 0 20 58z"/>';
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
    var has = photos.length > 0;
    show($('frame-img'), has);
    show($('frame-caption'), has);
    show($('frame-empty'), !has);
    if (!has) return;
    frameIndex = frameIndex % Math.min(photos.length, 20);
    var p = photos[frameIndex];
    if ($('frame-img').getAttribute('src') !== p.image) $('frame-img').setAttribute('src', p.image);
    $('frame-caption').textContent = 'De ' + p.authorName;
  }

  // Fond flouté : la photo est réduite à quelques pixels puis agrandie (le flou CSS
  // n'existe pas sur Android 4.4).
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
    var img = new Image();
    img.onload = function () {
      try {
        var c = document.createElement('canvas');
        c.width = 24;
        c.height = Math.max(1, Math.round(24 * img.height / img.width));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        apply('url("' + c.toDataURL('image/jpeg', 0.8) + '")');
      } catch (e) { apply('none'); }
    };
    img.src = url;
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
  }

  function renderPhoto() {
    var p = photos[photoIndex];
    if (!p) return;
    $('photo-img').setAttribute('src', p.image);
    var caption = p.authorName + ', ' + whenLabel(p.createdAt);
    $('photo-caption').textContent = p.text ? p.text + ' — ' + caption : caption;
    if (photoIndex >= photos.length - 1) $('photo-prev').setAttribute('disabled', ''); else $('photo-prev').removeAttribute('disabled');
    if (photoIndex === 0) $('photo-next').setAttribute('disabled', ''); else $('photo-next').removeAttribute('disabled');
    markSeen(p);
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
    // Comme un mot écrit à la main : le texte, puis la signature.
    var text = mode === 'message' ? p.text
      : mode === 'photo' ? (p.text || 'Une nouvelle photo pour vous !')
        : mode === 'voice' ? 'Un message vocal de ' + p.authorName
          : 'Une vidéo de ' + p.authorName + (p.text ? ' : ' + p.text : '');
    $('overlay-text').textContent = text;
    $('overlay-text').className = 'ln-text ' + (mode === 'photo' ? 'size-m' : sizeClass(text));
    show($('overlay-from'), !media);
    $('overlay-from').textContent = '— ' + p.authorName;
    // Photo : à droite, sur toute la hauteur.
    show($('ln-media'), mode === 'photo');
    if (mode === 'photo') $('overlay-img').setAttribute('src', p.image);
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

  function checkReminders() {
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
    onVoiceEnded: voiceEnded,
    onLeave: function () { if (window.papoteAppelsLeave) window.papoteAppelsLeave(); },
    closeOverlayForCall: closeOverlayForCall,
    goHome: function () { showView('view-home'); }
  };

  // ---------- Événements ----------

  function start() {
    fillIcons();
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
    on($('photo-stage'), 'touchstart', function (e) { startX = e.touches[0].clientX; });
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
