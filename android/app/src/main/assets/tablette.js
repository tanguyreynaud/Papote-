/*
 * Écran de la tablette Papote. Écrit en JavaScript ES5 pour le navigateur d'Android 4.4.
 * Les données arrivent de l'app Android par window.Papote.onStatus / onPosts / onWeather ;
 * les actions repartent par window.PapoteAndroid.markSeen / sendHeart.
 */
(function () {
  'use strict';

  var IDLE_MS = 90000;   // retour à l'accueil après 1 min 30 sans toucher l'écran
  var FRAME_MS = 12000;  // changement de photo sur l'accueil

  var JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  var MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
    'septembre', 'octobre', 'novembre', 'décembre'];

  var familyName = '';
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

  // ---------- Icônes (SVG : les emojis d'Android 4.4 sont incomplets) ----------

  var ICONS = {
    camera: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9zm3 5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>',
    letter: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1.4 2 7.6 5.6L19.6 7H4.4zM20 8.6l-8 5.9-8-5.9V17h16V8.6z"/></svg>',
    heart: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 21s-7.5-4.6-9.6-9C.9 8.8 2.6 5 6.3 4.6 8.6 4.4 10.4 5.6 12 7.6c1.6-2 3.4-3.2 5.7-3 3.7.4 5.4 4.2 3.9 7.4C19.5 16.4 12 21 12 21z"/></svg>'
  };

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
  function drops(color) {
    return '<g stroke="' + color + '" stroke-width="4" stroke-linecap="round">' +
      '<line x1="28" y1="64" x2="24" y2="74"/><line x1="42" y1="64" x2="38" y2="74"/><line x1="56" y1="64" x2="52" y2="74"/></g>';
  }
  var SNOW = '<g fill="#93c5fd"><circle cx="26" cy="68" r="3.5"/><circle cx="40" cy="72" r="3.5"/><circle cx="54" cy="68" r="3.5"/></g>';
  var BOLT = '<path fill="#facc15" d="M42 56 32 72h9l-4 10 14-18h-9l4-8z"/>';
  var FOG = '<g stroke="#94a3b8" stroke-width="4" stroke-linecap="round"><line x1="12" y1="40" x2="68" y2="40"/><line x1="18" y1="52" x2="62" y2="52"/><line x1="12" y1="64" x2="68" y2="64"/></g>';

  function weatherSvg(kind, isDay) {
    var body;
    switch (kind) {
      case 'clear': body = isDay ? sun(40, 40, 15) : MOON; break;
      case 'partly': body = (isDay ? sun(30, 28, 11) : '<g transform="translate(-8,-8) scale(.8)">' + MOON + '</g>') + CLOUD; break;
      case 'cloudy': body = CLOUD; break;
      case 'fog': body = FOG; break;
      case 'rain': body = CLOUD + drops('#3b82f6'); break;
      case 'snow': body = CLOUD + SNOW; break;
      case 'storm': body = CLOUD + BOLT; break;
      default: body = CLOUD;
    }
    return '<svg viewBox="0 0 80 80">' + body + '</svg>';
  }

  var WEATHER = {
    0: ['clear', 'Grand soleil'], 1: ['partly', 'Plutôt ensoleillé'], 2: ['partly', 'Quelques nuages'],
    3: ['cloudy', 'Couvert'], 45: ['fog', 'Brouillard'], 48: ['fog', 'Brouillard givrant'],
    51: ['rain', 'Bruine légère'], 53: ['rain', 'Bruine'], 55: ['rain', 'Forte bruine'],
    56: ['rain', 'Bruine verglaçante'], 57: ['rain', 'Bruine verglaçante'],
    61: ['rain', 'Petite pluie'], 63: ['rain', 'Pluie'], 65: ['rain', 'Forte pluie'],
    66: ['rain', 'Pluie verglaçante'], 67: ['rain', 'Pluie verglaçante'],
    71: ['snow', 'Un peu de neige'], 73: ['snow', 'Neige'], 75: ['snow', 'Forte neige'], 77: ['snow', 'Grains de neige'],
    80: ['rain', 'Averses'], 81: ['rain', 'Averses'], 82: ['storm', 'Fortes averses'],
    85: ['snow', 'Averses de neige'], 86: ['snow', 'Fortes averses de neige'],
    95: ['storm', 'Orage'], 96: ['storm', 'Orage avec grêle'], 99: ['storm', 'Orage avec grêle']
  };

  function describe(code, isDay) {
    var w = WEATHER[code] || ['cloudy', ''];
    var label = w[1];
    if (!isDay && code === 0) label = 'Ciel dégagé';
    if (!isDay && code === 1) label = 'Peu nuageux';
    return { kind: w[0], label: label };
  }

  function fillIcons() {
    var els = document.querySelectorAll('[data-icon]');
    for (var i = 0; i < els.length; i++) els[i].innerHTML = ICONS[els[i].getAttribute('data-icon')];
  }

  // ---------- Navigation ----------

  function showView(view) {
    var ids = ['view-home', 'view-photos', 'view-messages', 'view-setup'];
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

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function greetingFor(hour) {
    if (hour < 6 || hour >= 22) return 'Bonne nuit';
    if (hour < 12) return 'Bonjour';
    if (hour < 18) return 'Bon après-midi';
    return 'Bonsoir';
  }

  function tick() {
    var now = new Date();
    var time = pad(now.getHours()) + ':' + pad(now.getMinutes());
    $('clock').textContent = time;
    $('setup-clock').textContent = time;
    var day = JOURS[now.getDay()];
    $('date').textContent = day.charAt(0).toUpperCase() + day.slice(1) + ' ' + now.getDate() +
      (now.getDate() === 1 ? 'er' : '') + ' ' + MOIS[now.getMonth()] + ' ' + now.getFullYear();
    var hour = now.getHours();
    $('greeting').textContent = greetingFor(hour) + (familyName ? ' ' + familyName : '');
    var night = hour >= 21 || hour < 7;
    if (night) document.body.className = 'night'; else document.body.className = '';
  }

  // ---------- Textes ----------

  function whenLabel(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    var now = new Date();
    var yesterday = new Date(now.getTime() - 86400000);
    var hm = pad(d.getHours()) + 'h' + pad(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return "aujourd'hui à " + hm;
    if (d.toDateString() === yesterday.toDateString()) return 'hier à ' + hm;
    return 'le ' + JOURS[d.getDay()] + ' ' + d.getDate() + ' ' + MOIS[d.getMonth()];
  }

  // ---------- Météo ----------

  function onWeather(data) {
    try {
      var now = describe(data.current.weather_code, data.current.is_day);
      $('weather-icon').innerHTML = weatherSvg(now.kind, data.current.is_day);
      $('weather-temp').textContent = Math.round(data.current.temperature_2m) + '°';
      $('weather-label').textContent = now.label;
      $('weather-minmax').textContent = "Aujourd'hui : de " + Math.round(data.daily.temperature_2m_min[0]) +
        '° à ' + Math.round(data.daily.temperature_2m_max[0]) + '°';
      var tomorrow = describe(data.daily.weather_code[1], 1);
      $('weather-tomorrow').textContent = 'Demain : ' + tomorrow.label.toLowerCase() + ', ' +
        Math.round(data.daily.temperature_2m_max[1]) + '°';
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

  function setBadge(id, n) {
    show($(id), n > 0);
    $(id).textContent = n > 9 ? '9+' : String(n);
  }

  function renderBadges() {
    var unseenPhotos = 0;
    var unseenMessages = 0;
    for (var i = 0; i < posts.length; i++) {
      if (posts[i].seen) continue;
      if (posts[i].image) unseenPhotos++;
      if (posts[i].text) unseenMessages++;
    }
    setBadge('badge-photos', unseenPhotos);
    setBadge('badge-messages', unseenMessages);
  }

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
    $('photo-caption').textContent = p.text ? '« ' + p.text + ' »  ' + caption : caption;
    if (photoIndex >= photos.length - 1) $('photo-prev').setAttribute('disabled', ''); else $('photo-prev').removeAttribute('disabled');
    if (photoIndex === 0) $('photo-next').setAttribute('disabled', ''); else $('photo-next').removeAttribute('disabled');
    markSeen(p);
  }

  // La plus récente est à l'index 0 : « suivante » va vers les plus récentes.
  function olderPhoto() { if (photoIndex < photos.length - 1) { photoIndex++; renderPhoto(); } }
  function newerPhoto() { if (photoIndex > 0) { photoIndex--; renderPhoto(); } }

  // ---------- Messages ----------

  function renderMessages() {
    var list = $('message-list');
    list.innerHTML = '';
    var count = 0;
    for (var i = 0; i < posts.length; i++) {
      var p = posts[i];
      if (!p.text) continue;
      count++;
      var item = document.createElement('div');
      item.className = p.seen ? 'message' : 'message unseen';
      var head = document.createElement('p');
      head.className = 'message-head';
      head.textContent = p.authorName + ', ' + whenLabel(p.createdAt);
      var body = document.createElement('p');
      body.className = 'message-body';
      body.textContent = p.text;
      item.appendChild(head);
      item.appendChild(body);
      if (p.image) {
        var img = document.createElement('img');
        img.setAttribute('src', p.image);
        item.appendChild(img);
      }
      list.appendChild(item);
      markSeen(p);
    }
    show($('message-empty'), count === 0);
  }

  // ---------- Vu et bisous ----------

  function markSeen(p) {
    if (p.seen) return;
    p.seen = true;
    if (android()) android().markSeen(p.id);
  }

  function heart(p, button, label) {
    if (!p) return;
    p.seen = true;
    if (android()) android().sendHeart(p.id);
    var span = button.querySelector('.label');
    span.textContent = 'Envoyé !';
    button.setAttribute('disabled', '');
    setTimeout(function () {
      span.textContent = label;
      button.removeAttribute('disabled');
    }, 2500);
  }

  // ---------- Fenêtre « nouveau » ----------

  function queueUnseen() {
    for (var i = posts.length - 1; i >= 0; i--) {
      var p = posts[i];
      // Une photo n'est montrée que lorsqu'elle est téléchargée.
      if (p.seen || shownInOverlay[p.id] || (p.type === 'photo' && !p.image)) continue;
      shownInOverlay[p.id] = true;
      overlayQueue.push(p);
    }
    if (!overlayPost) nextOverlay();
  }

  function nextOverlay() {
    overlayPost = overlayQueue.shift() || null;
    if (!overlayPost) {
      show($('overlay'), false);
      return;
    }
    var p = overlayPost;
    $('overlay-title').textContent = p.type === 'photo'
      ? 'Nouvelle photo de ' + p.authorName
      : 'Message de ' + p.authorName;
    show($('overlay-img'), !!p.image);
    if (p.image) $('overlay-img').setAttribute('src', p.image);
    show($('overlay-text'), !!p.text);
    $('overlay-text').textContent = p.text || '';
    show($('overlay'), true);
    // Le son est joué par l'app Android (son de notification de la tablette).
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
    familyName = payload.familyName || '';
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
    tick();
    renderFrame();
    renderBadges();
    if (isShown('view-messages')) renderMessages();
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

  window.Papote = { onStatus: onStatus, onPosts: onPosts, onWeather: onWeather };

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
    for (var i = 0; i < homes.length; i++) on(homes[i], 'click', function () { showView('view-home'); });
    on($('btn-photos'), 'click', function () { openPhotos(0); });
    on($('home-frame'), 'click', function () { openPhotos(frameIndex); });
    on($('btn-messages'), 'click', function () { renderMessages(); showView('view-messages'); });
    on($('photo-prev'), 'click', olderPhoto);
    on($('photo-next'), 'click', newerPhoto);
    on($('photo-heart'), 'click', function () { heart(photos[photoIndex], $('photo-heart'), 'Bisou'); });
    on($('overlay-close'), 'click', function () {
      if (overlayPost) markSeen(overlayPost);
      nextOverlay();
    });
    on($('overlay-heart'), 'click', function () {
      if (!overlayPost) return;
      heart(overlayPost, $('overlay-heart'), 'Envoyer un bisou');
      setTimeout(nextOverlay, 1200);
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
  }

  start();
})();
