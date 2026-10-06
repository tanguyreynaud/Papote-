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
    calendar: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 2h2v2h6V2h2v2h3a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3V2zm12 8H5v9h14v-9zM5 6v2h14V6H5zm2 6h4v4H7v-4z"/></svg>',
    pill: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M4.2 13.4 13.4 4.2a5 5 0 0 1 7.1 7.1l-9.2 9.2a5 5 0 0 1-7.1-7.1zm1.4 1.4a3 3 0 0 0 4.2 4.2l4.2-4.2-4.2-4.2-4.2 4.2z"/></svg>',
    doctor: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7V3z"/></svg>',
    pin: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a7 7 0 0 1 7 7c0 5-7 13-7 13S5 14 5 9a7 7 0 0 1 7-7zm0 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M7 4v16l13-8z"/></svg>',
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
    var ids = ['view-home', 'view-photos', 'view-messages', 'view-agenda', 'view-setup'];
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
      if (posts[i].text || posts[i].audio) unseenMessages++;
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
      if (!p.text && !p.audio) continue;
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
      if (p.text) item.appendChild(body);
      if (p.audio) {
        var label = document.createElement('p');
        label.className = 'voice-label';
        label.textContent = 'Message vocal' + (p.duration ? ' (' + formatDuration(p.duration) + ')' : '');
        item.insertBefore(label, item.children[1] || null);
      }
      var actions = document.createElement('div');
      actions.className = 'message-actions';
      if (p.audio) actions.appendChild(playButton(p, 'small-btn play'));
      var replyBtn = document.createElement('button');
      replyBtn.className = 'small-btn';
      replyBtn.textContent = 'Répondre';
      replyBtn.setAttribute('data-post', p.id);
      on(replyBtn, 'click', function () { openReply(this.getAttribute('data-post')); });
      actions.appendChild(replyBtn);
      item.appendChild(actions);
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
      if (p.seen || shownInOverlay[p.id] || (p.type === 'photo' && !p.image) || (p.type === 'voice' && !p.audio)) continue;
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
      : p.type === 'voice' ? 'Message vocal de ' + p.authorName
        : 'Message de ' + p.authorName;
    show($('overlay-play'), !!p.audio);
    setPlayLabel($('overlay-play'), false);
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

  // ---------- Messages vocaux ----------

  var playingId = null;
  var playingButton = null;

  function formatDuration(s) {
    return Math.floor(s / 60) + ':' + pad(s % 60);
  }

  function setPlayLabel(button, playing) {
    var label = button.querySelector('.label');
    var text = playing ? 'Arrêter' : 'Écouter';
    if (label) label.textContent = text; else button.textContent = text;
    if (playing) button.classList.add('playing'); else button.classList.remove('playing');
  }

  function stopAudio() {
    if (android() && android().stopVoice) android().stopVoice();
    else $('player').pause();
    resetPlayUi();
  }

  // Fin de lecture (appelé aussi par Android quand le vocal est terminé).
  function resetPlayUi() {
    if (playingButton) setPlayLabel(playingButton, false);
    playingId = null;
    playingButton = null;
  }

  function togglePlay(p, button) {
    var wasPlaying = playingId === p.id;
    stopAudio();
    if (wasPlaying) return;
    if (android() && android().playVoice) {
      android().playVoice(p.audio);
    } else {
      $('player').setAttribute('src', p.audio);
      $('player').play();
    }
    playingId = p.id;
    playingButton = button;
    setPlayLabel(button, true);
    markSeen(p);
  }

  function playButton(p, className) {
    var b = document.createElement('button');
    b.className = className;
    b.textContent = 'Écouter';
    on(b, 'click', function () { togglePlay(p, b); });
    return b;
  }

  // ---------- Réponses toutes faites ----------

  var replyTo = null;

  function openReply(postId) {
    replyTo = postId || null;
    show($('reply-panel'), true);
  }

  function sendReply(text) {
    if (android()) android().reply(replyTo || '', text);
    for (var i = 0; i < posts.length; i++) if (posts[i].id === replyTo) posts[i].seen = true;
    show($('reply-panel'), false);
    show($('reply-sent'), true);
    setTimeout(function () { show($('reply-sent'), false); }, 2500);
    replyTo = null;
  }

  // ---------- Rappels et agenda ----------

  var reminders = [];
  var REMINDER_WINDOW_MIN = 60;  // un rappel manqué reste affiché pendant 1 heure
  var RESOUND_MIN = 5;           // le son est rejoué toutes les 5 minutes tant que ce n'est pas fait
  var alerting = null;           // { r: rappel, key: 'AAAA-MM-JJ', lastSound: minutes }
  var handled = {};              // rappels déjà confirmés sur la tablette : id|date -> true

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

  function todaysItems(d) {
    var items = [];
    for (var i = 0; i < reminders.length; i++) if (happensOn(reminders[i], d)) items.push(reminders[i]);
    items.sort(function (a, b) { return minutesOf(a.time) - minutesOf(b.time); });
    return items;
  }

  function renderNextReminder() {
    var now = new Date();
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var key = dateKey(now);
    var items = todaysItems(now);
    var next = null;
    for (var i = 0; i < items.length; i++) {
      if (minutesOf(items[i].time) >= nowMin && !isDone(items[i], key)) { next = items[i]; break; }
    }
    show($('next-reminder'), !!next);
    if (next) $('next-reminder').textContent = 'À ' + next.time.replace(':', 'h') + ' : ' + next.title;
  }

  function checkReminders() {
    var now = new Date();
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var key = dateKey(now);
    if (alerting) {
      if (isDone(alerting.r, alerting.key) || nowMin - minutesOf(alerting.r.time) > REMINDER_WINDOW_MIN) {
        closeReminder();
      } else if (nowMin - alerting.lastSound >= RESOUND_MIN) {
        alerting.lastSound = nowMin;
        if (android()) android().alert();
      }
      return;
    }
    var items = todaysItems(now);
    for (var i = 0; i < items.length; i++) {
      var r = items[i];
      var late = nowMin - minutesOf(r.time);
      if (late >= 0 && late <= REMINDER_WINDOW_MIN && !isDone(r, key)) {
        openReminder(r, key, nowMin);
        return;
      }
    }
  }

  function openReminder(r, key, nowMin) {
    alerting = { r: r, key: key, lastSound: nowMin };
    $('reminder-icon').innerHTML = '<span class="icon">' + kindIcon(r.kind) + '</span>';
    $('reminder-title').textContent = r.title;
    $('reminder-time').textContent = r.kind === 'rdv' ? 'Rendez-vous à ' + r.time.replace(':', 'h') : r.time.replace(':', 'h');
    $('reminder-done').textContent = r.kind === 'rdv' ? "J'ai bien noté" : "C'est fait";
    show($('reminder-alert'), true);
    if (android()) android().alert();
  }

  function closeReminder() {
    alerting = null;
    show($('reminder-alert'), false);
    renderNextReminder();
    if (isShown('view-agenda')) renderAgenda();
  }

  function confirmReminder() {
    if (!alerting) return;
    var now = new Date();
    handled[alerting.r.id + '|' + alerting.key] = true;
    if (android()) android().ackReminder(alerting.r.id, dateKey(now) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()));
    closeReminder();
    setTimeout(checkReminders, 500);
  }

  function renderAgenda() {
    var list = $('agenda-list');
    list.innerHTML = '';
    var now = new Date();
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var count = 0;
    for (var offset = 0; offset < 7; offset++) {
      var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      var items = todaysItems(d);
      if (!items.length) continue;
      var title = document.createElement('p');
      title.className = 'agenda-day';
      title.textContent = offset === 0 ? "Aujourd'hui" : offset === 1 ? 'Demain'
        : JOURS[d.getDay()].charAt(0).toUpperCase() + JOURS[d.getDay()].slice(1) + ' ' + d.getDate() + ' ' + MOIS[d.getMonth()];
      list.appendChild(title);
      for (var i = 0; i < items.length; i++) {
        var r = items[i];
        var done = offset === 0 && isDone(r, dateKey(d));
        var row = document.createElement('div');
        row.className = 'agenda-item' + (offset === 0 && minutesOf(r.time) < nowMin ? ' past' : '');
        row.innerHTML = '<span class="time"></span><span class="icon"></span>&nbsp;<span class="what"></span>';
        row.querySelector('.time').textContent = r.time.replace(':', 'h');
        row.querySelector('.icon').innerHTML = kindIcon(r.kind);
        row.querySelector('.what').textContent = r.title;
        if (done) {
          var mark = document.createElement('span');
          mark.className = 'done-mark';
          mark.textContent = 'Fait';
          row.appendChild(mark);
        }
        list.appendChild(row);
        count++;
      }
    }
    show($('agenda-empty'), count === 0);
  }

  function onReminders(payload) {
    reminders = payload.reminders || [];
    renderNextReminder();
    if (isShown('view-agenda')) renderAgenda();
    checkReminders();
  }

  var lastMinute = -1;
  setInterval(function () {
    var m = new Date().getMinutes();
    if (m === lastMinute) return;
    lastMinute = m;
    renderNextReminder();
    checkReminders();
  }, 1000);

  window.Papote = {
    onStatus: onStatus, onPosts: onPosts, onWeather: onWeather, onReminders: onReminders,
    onVoiceEnded: function () { resetPlayUi(); }
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
    for (var i = 0; i < homes.length; i++) on(homes[i], 'click', function () { showView('view-home'); });
    on($('btn-photos'), 'click', function () { openPhotos(0); });
    on($('home-frame'), 'click', function () { openPhotos(frameIndex); });
    on($('btn-messages'), 'click', function () { renderMessages(); showView('view-messages'); });
    on($('btn-agenda'), 'click', function () { renderAgenda(); showView('view-agenda'); });
    on($('reminder-done'), 'click', confirmReminder);
    on($('overlay-play'), 'click', function () { if (overlayPost) togglePlay(overlayPost, $('overlay-play')); });
    on($('overlay-reply'), 'click', function () {
      if (!overlayPost) return;
      var id = overlayPost.id;
      markSeen(overlayPost);
      stopAudio();
      nextOverlay();
      openReply(id);
    });
    on($('reply-cancel'), 'click', function () { show($('reply-panel'), false); replyTo = null; });
    var choices = document.querySelectorAll('.reply-choice');
    for (var c = 0; c < choices.length; c++) {
      on(choices[c], 'click', function () { sendReply(this.getAttribute('data-reply')); });
    }
    on($('player'), 'ended', resetPlayUi);

    // Veille : on signale à l'app que Mamie utilise la tablette (au plus une fois par minute).
    var lastTouch = 0;
    on(document, 'touchstart', function () {
      var now = Date.now();
      if (now - lastTouch < 60000) return;
      lastTouch = now;
      if (android() && android().touched) android().touched();
    });
    on($('photo-prev'), 'click', olderPhoto);
    on($('photo-next'), 'click', newerPhoto);
    on($('photo-heart'), 'click', function () { heart(photos[photoIndex], $('photo-heart'), 'Bisou'); });
    on($('overlay-close'), 'click', function () {
      stopAudio();
      if (overlayPost) markSeen(overlayPost);
      nextOverlay();
    });
    on($('overlay-heart'), 'click', function () {
      if (!overlayPost) return;
      heart(overlayPost, $('overlay-heart'), 'Bisou');
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
