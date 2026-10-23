/*
 * Écran « Bienvenue » : première installation chez le client, sans PC (parcours du 21/10).
 * 1. Bienvenue, 2. le wifi (sauté si la carte SIM donne internet), 3. le QR code et le code à taper
 * dans l'app famille, puis « On prépare votre tablette… » pendant que le proche règle tout sur son
 * téléphone (nom, photo, son, options). Le nom et la météo ne se demandent plus sur la tablette.
 * Ancien parcours gardé pour une tablette de remplacement : « C'est bien vous ? » Oui / Non.
 * Les étapes viennent d'Android (Sync.java, état « welcome »).
 */
(function () {
  'use strict';

  function android() { return window.PapoteAndroid; }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  var root = null;
  var current = '';
  var wifiTimer = null;
  var chosen = null;

  function ensureRoot() {
    if (root) return;
    root = el('div', 'welcome');
    root.setAttribute('hidden', '');
    document.body.appendChild(root);
    scrollbar(root, true);
  }

  // Barre de défilement toujours visible (celle d'Android s'efface et passe inaperçue) :
  // un rail et un curseur à droite de la zone qui défile, cachés quand tout tient à l'écran.
  // fixed : zone en plein écran (rail collé au bord de l'écran).
  function scrollbar(area, fixed) {
    var track = el('div', 'scroll-track' + (fixed ? ' fixed' : ''));
    var thumb = el('div', 'scroll-thumb');
    track.appendChild(thumb);
    (fixed ? document.body : area.parentNode).appendChild(track);
    function update() {
      if (!track.parentNode) return;
      var h = area.clientHeight;
      var total = area.scrollHeight;
      var shown = h > 0 && total > h + 2 && !area.hasAttribute('hidden');
      track.style.display = shown ? 'block' : 'none';
      if (!shown) return;
      if (!fixed) {
        track.style.top = area.offsetTop + 'px';
        track.style.height = h + 'px';
      }
      var trackH = fixed ? window.innerHeight : h;
      var thumbH = Math.max(trackH * h / total, 40);
      thumb.style.height = thumbH + 'px';
      thumb.style.top = ((trackH - thumbH) * area.scrollTop / (total - h)) + 'px';
    }
    area.addEventListener('scroll', update, false);
    window.addEventListener('resize', update, false);
    if (window.MutationObserver) {
      new MutationObserver(function () { setTimeout(update, 50); })
        .observe(area, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
    }
    setTimeout(update, 300);
    return update;
  }

  // Étape en cours (1 bienvenue, 2 internet, 3 téléphone), affichée en haut ; 0 = pas d'étapes
  // (wifi plus tard, préparation, ancien parcours).
  var STEPS = 3;
  var stepNum = 0;

  // Illustration de l'étape (bienvenue/<nom>.svg), dans le panneau de gauche ; vide = pas de panneau.
  var art = '';

  function screen(title, subtitle) {
    root.innerHTML = '';
    var card = el('div', 'welcome-card' + (art ? ' with-art' : ''));
    if (art) {
      var panel = el('div', 'welcome-art');
      var img = el('img', '');
      img.src = 'bienvenue/' + art + '.svg';
      img.alt = '';
      panel.appendChild(img);
      card.appendChild(panel);
    }
    var box = el('div', 'welcome-box');
    card.appendChild(box);
    var head = el('div', 'welcome-head');
    var logo = el('img', 'welcome-logo');
    logo.src = 'logo.svg';
    logo.alt = '';
    head.appendChild(logo);
    head.appendChild(el('span', 'welcome-brand', 'Papote'));
    if (stepNum && !repair) {
      var steps = el('div', 'welcome-dots');
      for (var i = 1; i <= STEPS; i++) steps.appendChild(el('span', 'dot' + (i < stepNum ? ' done' : i === stepNum ? ' on' : '')));
      steps.appendChild(el('span', 'welcome-stepnum', 'Étape ' + stepNum + ' sur ' + STEPS));
      head.appendChild(steps);
    }
    if (!repair) {
      // Haut-parleur : réécouter la phrase du guide de cet écran.
      var listen = el('button', 'welcome-listen');
      listen.setAttribute('aria-label', 'Réécouter');
      listen.innerHTML = '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">' +
        '<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>' +
        '<path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      listen.addEventListener('click', function () {
        if (lastGuide) playGuide(lastGuide);
      }, false);
      head.appendChild(listen);
    }
    box.appendChild(head);
    if (stepNum && !repair) box.appendChild(el('p', 'welcome-eyebrow', 'Étape ' + stepNum + ' sur ' + STEPS));
    box.appendChild(el('h1', 'welcome-title', title));
    if (subtitle) box.appendChild(el('p', 'welcome-sub', subtitle));
    root.appendChild(card);
    return box;
  }

  // Voix du guide (demande de Tanguy) : une phrase courte à l'arrivée sur chaque écran, une seule
  // fois par écran (pas de répétition quand l'écran se redessine). Uniquement pendant l'installation.
  // Les phrases sont des fichiers MP3 (voix naturelle, outils/voix/generer-voix-guide.py) : pas besoin
  // du moteur de voix d'Android, pas encore prêt au démarrage. Sans fichier, la voix d'Android lit le texte.
  var lastGuide = null;
  var guideAudio = null;
  function playGuide(g) {
    if (guideAudio) guideAudio.pause();
    guideAudio = new Audio('bienvenue/voix/' + g.id + '.mp3');
    var fallback = function () {
      try { (android().speakGuide ? android().speakGuide(g.text) : android().speak(g.text)); } catch (e) {}
    };
    guideAudio.onerror = fallback;
    var p = guideAudio.play();
    if (p && p.catch) p.catch(fallback);
  }
  function sayGuide(id, text) {
    if (repair || (lastGuide && lastGuide.id === id)) return;
    lastGuide = { id: id, text: text };
    playGuide(lastGuide);
  }

  function button(text, cls, onClick) {
    var b = el('button', 'welcome-btn ' + (cls || ''), text);
    b.addEventListener('click', onClick, false);
    return b;
  }

  // « Retour » : l'écran d'installation précédent (Sync.welcomeBack), pour avancer sans stress.
  // En haut, à côté du logo : toujours visible, même quand l'écran défile.
  function addBack(box, toStart) {
    var b = el('button', 'welcome-back', '‹ Retour');
    b.addEventListener('click', function () {
      b.disabled = true;
      android().welcomeBack(toStart);
    }, false);
    var head = box.querySelector('.welcome-head');
    head.classList.add('has-back');
    head.insertBefore(b, head.querySelector('.welcome-dots') || head.querySelector('.welcome-listen'));
  }

  // ---------- 1. Bienvenue ----------

  function showStart() {
    stepNum = 1;
    art = 'nom';
    var box = screen('Bienvenue sur Papote', 'Cette tablette va recevoir les photos et les messages de la famille.');
    sayGuide('accueil', 'Bonjour, et bienvenue sur Papote ! Appuyez sur Commencer.');
    var go = button('Commencer', 'primary', function () {
      go.disabled = true;
      go.textContent = 'Un instant…';
      android().welcomeSeen();
    });
    box.appendChild(go);
  }

  // ---------- Ancien parcours : nom de la tablette ----------

  function showName() {
    stepNum = 1;
    art = 'nom';
    var box = screen('Bienvenue !', 'Pour commencer, donnez un nom à cette tablette.');
    var input = el('input', 'welcome-input');
    input.type = 'text';
    input.maxLength = 40;
    input.placeholder = 'Ex. : Mamie Jeanne';
    box.appendChild(input);
    var go = button('Continuer', 'primary', function () {
      var name = input.value.trim();
      if (!name) { input.focus(); return; }
      go.disabled = true;
      go.textContent = 'Un instant…';
      android().setTabletName(name);
    });
    box.appendChild(go);
    setTimeout(function () { input.focus(); }, 300);
  }

  // ---------- 2. Wifi ----------

  function wifiState() {
    try { return JSON.parse(android().wifiStatus()); } catch (e) { return {}; }
  }

  function showWifi() {
    stepNum = repair ? 0 : 2;
    art = 'wifi';
    var st = wifiState();
    // Carte SIM avec internet : pas besoin de wifi.
    if (!repair && st.mobile && st.internet && !st.wifi) { finishWifi(); return; }
    var connected = st.wifi && st.internet;
    var box = screen('Connexion à internet', connected ? '' : 'Choisissez le wifi de votre box.');
    if (connected) sayGuide('wifi-ok', 'La tablette est connectée à internet. Appuyez sur Continuer.');
    else sayGuide('wifi-choisir', 'Choisissez le wifi de votre box.');
    if (connected) {
      box.appendChild(el('p', 'welcome-ok', 'Connectée à « ' + st.wifi + ' »'));
      box.appendChild(button('Continuer', 'primary', finishWifi));
      box.appendChild(button('Choisir un autre réseau', '', openNetworks));
    } else {
      box.appendChild(button('Choisir un réseau', 'primary', openNetworks));
    }
    if (repair) box.appendChild(button('Fermer', 'no', closeRepair));
    else addBack(box, false);
    // La fenêtre des réseaux ne s'ouvre que sur « Choisir un réseau » : la personne a le temps de lire.
  }

  // Icône wifi comme sur Android : un éventail plein jusqu'à la force du signal (0 à 3), cadenas si protégé.
  var FAN = 'M12 21L23.5 6.5C23.05 6.16 18.57 2.5 12 2.5S.95 6.16.5 6.5L12 21z';
  function wifiIcon(level, secure) {
    var scale = [0.42, 0.6, 0.8, 1][Math.max(0, Math.min(3, level))];
    var svg = '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">' +
      '<path d="' + FAN + '" fill="#e9e1d4"/>' +
      '<path d="' + FAN + '" fill="#4f46e5" transform="translate(12 21) scale(' + scale + ') translate(-12 -21)"/>' +
      (secure ? '<g transform="translate(15.5 14.5)"><rect x="0" y="3" width="8" height="6.5" rx="1.3" fill="#24212f"/>' +
        '<path d="M1.8 3V1.9a2.2 2.2 0 0 1 4.4 0V3" fill="none" stroke="#24212f" stroke-width="1.4"/></g>' : '') +
      '</svg>';
    var span = el('span', 'wifi-icon');
    span.innerHTML = svg;
    return span;
  }

  // Fenêtre « Choisir un réseau » par-dessus l'étape 2.
  function openNetworks() {
    closeNetworks();
    var veil = el('div', 'welcome-modal');
    veil.addEventListener('click', function (e) { if (e.target === veil) closeNetworks(); }, false);
    var sheet = el('div', 'welcome-sheet');
    sheet.appendChild(el('h2', 'welcome-sheet-title', 'Choisir un réseau'));
    var list = el('div', 'welcome-list');
    sheet.appendChild(list);
    scrollbar(list, false);
    var row = el('div', 'welcome-sheet-actions');
    row.appendChild(button('Actualiser', '', function () { fillNetworks(list); }));
    row.appendChild(button('Fermer', 'no', closeNetworks));
    sheet.appendChild(row);
    veil.appendChild(sheet);
    root.appendChild(veil);
    fillNetworks(list);
  }

  function closeNetworks() {
    var old = root && root.querySelector('.welcome-modal');
    if (old) old.parentNode.removeChild(old);
  }

  function fillNetworks(list) {
    list.innerHTML = '';
    list.appendChild(el('p', 'welcome-sub', 'Recherche des réseaux…'));
    setTimeout(function () {
      var nets = [];
      try { nets = JSON.parse(android().wifiScan()); } catch (e) { nets = []; }
      var current = wifiState().wifi;
      list.innerHTML = '';
      if (!nets.length) {
        list.appendChild(el('p', 'welcome-sub', 'Aucun réseau trouvé. Rapprochez la tablette de la box, puis touchez « Actualiser ».'));
      }
      for (var i = 0; i < nets.length && i < 12; i++) {
        (function (n) {
          var b = button('', 'network', function () { closeNetworks(); askPassword(n); });
          b.appendChild(wifiIcon(n.level, n.secure));
          var text = el('span', 'network-text');
          text.appendChild(el('span', 'network-name', n.ssid));
          if (n.ssid === current) text.appendChild(el('span', 'network-state', 'Connecté'));
          b.appendChild(text);
          list.appendChild(b);
        })(nets[i]);
      }
    }, 2500);
  }

  function askPassword(net) {
    chosen = net;
    if (!net.secure) { connect(''); return; }
    var box = screen('« ' + net.ssid + ' »', 'Tapez le mot de passe du wifi. Il est souvent écrit sous la box.');
    sayGuide('wifi-mdp', 'Tapez le mot de passe du wifi. Il est souvent écrit sous la box.');
    var input = el('input', 'welcome-input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.autocapitalize = 'off';
    input.spellcheck = false;
    box.appendChild(input);
    box.appendChild(button('Se connecter', 'primary', function () { connect(input.value); }));
    box.appendChild(button('Choisir un autre réseau', '', function () { current = ''; showWifi(); }));
    setTimeout(function () { input.focus(); }, 300);
  }

  function connect(password) {
    var box = screen('Connexion…', 'La tablette se connecte à « ' + chosen.ssid + ' ».');
    android().wifiConnect(chosen.ssid, password);
    var tries = 0;
    clearInterval(wifiTimer);
    wifiTimer = setInterval(function () {
      var st = wifiState();
      tries++;
      if (st.wifi === chosen.ssid && st.internet) {
        clearInterval(wifiTimer);
        box.appendChild(el('p', 'welcome-ok', 'C\'est bon, la tablette a internet !'));
        setTimeout(finishWifi, 1500);
      } else if (tries > 20) {
        clearInterval(wifiTimer);
        box.appendChild(el('p', 'welcome-error', 'La connexion n\'a pas marché. Vérifiez le mot de passe.'));
        box.appendChild(button('Réessayer', 'primary', function () { askPassword(chosen); }));
        box.appendChild(button('Choisir un autre réseau', '', function () { current = ''; showWifi(); }));
      }
    }, 1500);
  }

  // ---------- Wifi plus tard : bouton « Wifi » de l'accueil quand internet manque ----------

  var repair = false;

  function finishWifi() {
    if (repair) closeRepair();
    else android().wifiDone();
  }

  function closeRepair() {
    repair = false;
    clearInterval(wifiTimer);
    if (root) root.setAttribute('hidden', '');
    current = '';
  }

  function openRepair() {
    ensureRoot();
    repair = true;
    current = 'repair';
    root.removeAttribute('hidden');
    // Pas de code : le bouton n'apparaît que lorsqu'internet est déjà coupé, il n'y a rien à casser.
    showWifi();
  }

  // ---------- 3. Ville de la météo ----------
  // La famille pourra la changer ensuite depuis son appli (families/{fid}.meteoVille).

  // Comme pour le wifi : un bouton « Choisir la ville » et une fenêtre : le code postal, puis la liste
  // de ses communes.
  // Ville touchée dans la fenêtre : affichée ici avec « Continuer », enregistrée seulement à ce moment-là.
  var chosenCity = null;

  // Le détecteur de visage (modèle de 13 Mo) se télécharge dès qu'internet est là, pendant les
  // étapes météo et famille : il est prêt à l'étape « Placez la tablette », sans attente.
  function preloadFaceDetector() {
    try {
      if (typeof window.papoteFaceDetector === 'function') window.papoteFaceDetector();
    } catch (e) { }
  }

  function showMeteo() {
    preloadFaceDetector();
    stepNum = 3;
    art = 'meteo';
    var c = chosenCity;
    var box = screen('La météo', c ? '' : 'Tapez le code postal de la tablette, puis choisissez la ville : elle affichera sa météo.');
    if (c) {
      box.appendChild(el('p', 'welcome-ok', 'Météo de ' + c.nom + (c.detail ? ' (' + c.detail.replace(/^\d{5} · /, '') + ')' : '')));
      box.appendChild(button('Continuer', 'primary', function () {
        chosenCity = null;
        android().meteoChoose(c.nom, c.lat, c.lon);
      }));
      box.appendChild(button('Choisir une autre ville', '', openCities));
    } else {
      box.appendChild(button('Choisir la ville', 'primary', openCities));
      box.appendChild(button('Passer cette étape', 'no', function () { closeNetworks(); android().meteoSkip(); }));
    }
    // La fenêtre ne s'ouvre que sur « Choisir la ville » : la personne a le temps de lire.
  }

  var PIN = '<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">' +
    '<path d="M12 22c-4.2-4.9-6.5-8.4-6.5-11.5a6.5 6.5 0 0 1 13 0c0 3.1-2.3 6.6-6.5 11.5z" fill="#4f46e5"/>' +
    '<circle cx="12" cy="10.3" r="2.6" fill="#fff"/></svg>';

  // Code postal tapé sur un pavé de chiffres dessiné ici (le clavier d'Android montre aussi
  // « - / , . » : inutile et source d'erreurs). À gauche le pavé, à droite les communes.
  function openCities() {
    closeNetworks();
    var veil = el('div', 'welcome-modal top');
    veil.addEventListener('click', function (e) { if (e.target === veil) closeNetworks(); }, false);
    var sheet = el('div', 'welcome-sheet cities');
    sheet.appendChild(el('h2', 'welcome-sheet-title', 'Choisir la ville'));
    var body = el('div', 'cities-body');
    var left = el('div', 'cities-pad');
    var code = el('div', 'cities-code');
    left.appendChild(code);
    var pad = el('div', 'digit-pad');
    var value = '';
    var list = el('div', 'welcome-list');
    function show() {
      code.innerHTML = '';
      for (var i = 0; i < 5; i++) code.appendChild(el('span', 'code-box' + (i < value.length ? ' full' : i === value.length ? ' next' : ''), value.charAt(i)));
      if (value.length === 5) fillCities(value, list);
      else { list.innerHTML = ''; list.appendChild(el('p', 'welcome-sub', 'Tapez les 5 chiffres du code postal.')); }
    }
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].forEach(function (k) {
      if (!k) { pad.appendChild(el('span', 'digit empty')); return; }
      var b = button(k, 'digit' + (k === '⌫' ? ' erase' : ''), function () {
        if (k === '⌫') value = value.slice(0, -1);
        else if (value.length < 5) value += k;
        else return;
        show();
      });
      pad.appendChild(b);
    });
    left.appendChild(pad);
    body.appendChild(left);
    var right = el('div', 'cities-list');
    right.appendChild(list);
    body.appendChild(right);
    sheet.appendChild(body);
    var row = el('div', 'welcome-sheet-actions');
    row.appendChild(button('Fermer', 'no', closeNetworks));
    sheet.appendChild(row);
    veil.appendChild(sheet);
    root.appendChild(veil);
    scrollbar(list, false);
    show();
  }

  function fillCities(query, list) {
    list.innerHTML = '';
    if (query.length < 2) return;
    var found = [];
    try { found = JSON.parse(android().meteoSearch(query)); } catch (e) { found = []; }
    if (!found.length) {
      list.appendChild(el('p', 'welcome-sub', 'Aucune ville pour ce code postal. Vérifiez les chiffres.'));
      return;
    }
    for (var i = 0; i < found.length; i++) {
      (function (c) {
        var b = button('', 'network', function () {
          if (document.activeElement) document.activeElement.blur();
          closeNetworks();
          chosenCity = c;
          showMeteo();
        });
        var icon = el('span', 'wifi-icon');
        icon.innerHTML = PIN;
        b.appendChild(icon);
        var text = el('span', 'network-text');
        text.appendChild(el('span', 'network-name', c.nom));
        if (c.detail) text.appendChild(el('span', 'city-detail', c.detail));
        b.appendChild(text);
        list.appendChild(b);
      })(found[i]);
    }
  }

  // ---------- 4. Code et QR code ----------

  function pretty(code) { return code.slice(0, 4) + '-' + code.slice(4); }

  function showPair(s) {
    preloadFaceDetector();
    stepNum = 3;
    art = ''; // le QR code est l'illustration
    var box = screen('Connectez votre téléphone', '');
    if (!s.error) sayGuide('code', 'Dernière étape : avec votre téléphone, scannez le code affiché à l\'écran.');
    if (s.error) {
      box.appendChild(el('p', 'welcome-error', s.error));
      return;
    }
    // Deux façons à égalité, côte à côte (demande de Tanguy, 21/10) : le QR code, ou le site + le code.
    var row = el('div', 'welcome-pair');
    var scan = el('div', 'pair-card');
    scan.appendChild(el('p', 'pair-card-title', 'Scannez le QR code'));
    var qr = android().qrCode ? android().qrCode('https://app.mapapote.fr/?tablette=' + s.code) : '';
    if (qr) {
      var img = el('img', 'welcome-qr');
      img.src = qr;
      scan.appendChild(img);
    }
    row.appendChild(scan);
    row.appendChild(el('span', 'pair-or', 'ou'));
    var type = el('div', 'pair-card');
    type.appendChild(el('p', 'pair-card-title', 'Rendez-vous sur'));
    type.appendChild(el('p', 'pair-site', 'app.mapapote.fr'));
    type.appendChild(el('p', 'pair-card-hint', 'puis entrez ce code :'));
    type.appendChild(el('p', 'welcome-code', pretty(s.code)));
    row.appendChild(type);
    box.appendChild(row);
    if (s.claimedName || s.joined) {
      // Le proche a scanné : l'écran ne change pas (demande de Tanguy), une ligne dit qu'il s'en occupe.
      var busy = el('p', 'welcome-busy', '');
      busy.appendChild(el('span', 'boot-spin welcome-busy-spin', ''));
      busy.appendChild(document.createTextNode((s.claimedName || 'Votre proche') + ' termine l’installation sur son téléphone…'));
      box.appendChild(busy);
      // 30 min après le scan sans fin d'installation : un autre proche peut reprendre avec ce code.
      if (s.reprendre) box.appendChild(el('p', 'welcome-sub welcome-reprise', 'Pas fini ? Un autre proche peut reprendre en scannant ce code.'));
    }
    if (!s.restart && !s.claimedName && !s.joined) {
      var st = wifiState();
      addBack(box, !!(st.mobile && st.internet && !st.wifi));
    }
    if (s.restart) {
      // Touché deux fois : un appui par erreur n'annule pas l'installation en cours.
      var again = button('Recommencer avec un autre téléphone', 'no small', function () {
        if (!again.armed) {
          again.armed = true;
          again.textContent = 'Touchez encore pour recommencer';
          setTimeout(function () { again.armed = false; again.textContent = 'Recommencer avec un autre téléphone'; }, 5000);
          return;
        }
        again.disabled = true;
        again.textContent = 'Un instant…';
        android().cancelPairing();
      });
      box.appendChild(again);
    }
  }

  // ---------- Préparation : le proche règle tout sur son téléphone ----------
  // Réservée (claimedName) : un petit « Recommencer avec un autre téléphone », à toucher deux fois
  // (un appui par erreur n'annule pas l'installation en cours). Famille rejointe : plus de bouton,
  // l'écran reste jusqu'à la première photo ou la fin des réglages (Sync.java).

  function showPrepare(s) {
    stepNum = 0;
    art = '';
    var sub = s.claimedName ? s.claimedName + ' s’en occupe sur son téléphone.' : 'Encore quelques instants.';
    var box = screen('On prépare votre tablette…', sub);
    box.className += ' welcome-prepare';
    box.appendChild(el('span', 'boot-spin welcome-spin', ''));
    if (s.restart) {
      var again = button('Recommencer avec un autre téléphone', 'no small', function () {
        if (!again.armed) {
          again.armed = true;
          again.textContent = 'Touchez encore pour recommencer';
          setTimeout(function () { again.armed = false; again.textContent = 'Recommencer avec un autre téléphone'; }, 5000);
          return;
        }
        again.disabled = true;
        again.textContent = 'Un instant…';
        android().cancelPairing();
      });
      box.appendChild(again);
    }
  }

  // ---------- Ancien parcours : confirmation ----------

  function showConfirm(s) {
    stepNum = 0;
    art = 'confirmer';
    var who = s.claimedName || 'Quelqu\'un';
    var fam = s.familyName ? ' à la famille de ' + s.familyName : '';
    var box = screen(who + ' veut relier cette tablette' + fam + '.', 'C\'est bien vous ?');
    sayGuide('confirmer', 'Quelqu\'un veut relier cette tablette. C\'est bien vous ?');
    var row = el('div', 'welcome-actions');
    row.appendChild(button('Non', 'no', function () { android().confirmPairing(false); }));
    row.appendChild(button('Oui', 'primary', function () {
      android().confirmPairing(true);
      showPlacement();
    }));
    box.appendChild(row);
  }

  // ---------- 5. Placement de la tablette ----------
  // La caméra décroche les appels et sait qu'un envoi a été vu : la personne qui installe s'assoit à
  // la place habituelle et tourne la tablette jusqu'à voir son visage dans le rond. Le guidage utilise
  // le détecteur des appels (appels.js, window.papoteFaceDetector) ; sans lui, l'image seule.

  var placing = false;
  var placeStream = null;
  var placeTimer = null;

  function showPlacement() {
    placing = true;
    current = 'place';
    stepNum = 0;
    art = '';
    var box = screen('Placez la tablette', 'Asseyez-vous là où la personne s’installe d’habitude, puis tournez doucement la tablette.');
    sayGuide('placer', 'Asseyez-vous là où la personne s’installe d’habitude, puis tournez doucement la tablette.');
    // L'image de la caméra prend la place de l'illustration, à gauche.
    var card = box.parentNode;
    card.className = 'welcome-card with-art';
    var panel = el('div', 'welcome-art');
    var view = el('div', 'place-view');
    var video = el('video', 'place-video');
    video.muted = true;
    video.autoplay = true;
    video.setAttribute('playsinline', '');
    view.appendChild(video);
    view.appendChild(el('span', 'place-ring'));
    panel.appendChild(view);
    card.insertBefore(panel, box);
    var hint = el('p', 'place-hint', 'Ouverture de la caméra…');
    box.appendChild(hint);
    box.appendChild(button('C’est bon', 'primary', finishPlacement));
    box.appendChild(button('Passer cette étape', 'no', finishPlacement));
    startPlacementCamera(video, hint);
  }

  function startPlacementCamera(video, hint) {
    var none = 'Caméra indisponible : vous pouvez passer cette étape.';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { hint.textContent = none; return; }
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 720 }, aspectRatio: { ideal: 4 / 3 } },
      audio: false
    }).then(function (stream) {
      if (!placing) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      placeStream = stream;
      video.srcObject = stream;
      hint.textContent = 'Préparation de la caméra…';
      if (typeof window.papoteLocateFace === 'function') guide(video, hint);
      else hint.textContent = 'Tournez la tablette jusqu’à voir votre visage dans le rond.';
    }, function () { hint.textContent = none; });
  }

  // Le visage est-il au milieu de l'image ? window.papoteLocateFace(video) (appels.js) donne le plus
  // grand visage en fractions de l'image, ou null. Le premier appel charge le modèle (quelques s).
  function guide(video, hint) {
    var good = 0;
    var busy = false;
    clearInterval(placeTimer);
    placeTimer = setInterval(function () {
      if (!placing || busy || !video.videoWidth) return;
      busy = true;
      Promise.resolve(window.papoteLocateFace(video)).then(function (f) {
        busy = false;
        if (placing) showFace(f);
      }, function () { busy = false; });
    }, 350);

    function showFace(f) {
      var view = video.parentNode;
      if (!f) {
        good = 0;
        view.className = 'place-view';
        hint.textContent = 'Votre visage n’est pas visible : tournez doucement la tablette vers vous.';
        return;
      }
      var cx = f.x + f.width / 2;
      var cy = f.y + f.height / 2;
      // Assez au centre, sans exiger la perfection : un quart de l'image de marge sur les côtés,
      // un peu plus en hauteur (le visage est souvent dans le haut). Une fois bien placé, on
      // tolère un petit écart pour que le vert ne clignote pas au moindre mouvement.
      var marge = good > 0 ? 0.08 : 0;
      if (Math.abs(cx - 0.5) < 0.25 + marge && Math.abs(cy - 0.5) < 0.3 + marge) {
        good++;
        view.className = 'place-view ok';
        hint.textContent = good > 2 ? 'C’est parfait : la tablette est bien placée.' : 'Presque… ne bougez plus.';
      } else {
        good = 0;
        view.className = 'place-view';
        hint.textContent = 'On vous voit, mais pas au centre : tournez encore un peu la tablette.';
      }
    }
  }

  function finishPlacement() {
    placing = false;
    clearInterval(placeTimer);
    if (placeStream) placeStream.getTracks().forEach(function (t) { t.stop(); });
    placeStream = null;
    current = '';
    if (root) {
      root.innerHTML = '';
      root.setAttribute('hidden', '');
    }
  }

  window.PapoteBienvenue = {
    show: function (s) {
      if (placing) return; // la tablette est reliée : on finit le placement avant tout le reste
      ensureRoot();
      root.removeAttribute('hidden');
      var key = s.step + '|' + (s.code || '') + '|' + (s.error || '') + '|' + (s.claimedName || '') + '|' + (s.familyName || '') + '|' + (s.restart ? 1 : 0) + '|' + (s.joined ? 1 : 0) + '|' + (s.reprendre ? 1 : 0);
      if (key === current) return; // déjà affiché (et la saisie en cours n'est pas effacée)
      current = key;
      clearInterval(wifiTimer);
      if (s.step === 'start') showStart();
      else if (s.step === 'prepare') showPrepare(s);
      else if (s.step === 'name') showName();
      else if (s.step === 'wifi') showWifi();
      else if (s.step === 'meteo') showMeteo();
      else if (s.step === 'pair') showPair(s);
      else if (s.step === 'confirm') showConfirm(s);
    },
    openWifi: openRepair,
    hide: function () {
      if (repair || placing) return; // le réglage du wifi ou le placement en cours reste affiché
      if (guideAudio) guideAudio.pause();
      if (!root) return;
      root.setAttribute('hidden', '');
      current = '';
      clearInterval(wifiTimer);
    }
  };
})();
