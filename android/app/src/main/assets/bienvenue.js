/*
 * Écran « Bienvenue » : première mise en route chez le client, sans PC.
 * 1. Bienvenue, 2. internet (« Je cherche internet… » avec une carte SIM, puis le wifi de la box si besoin),
 * puis « On prépare votre tablette… / La tablette retrouve sa famille » jusqu'à ce que le serveur la relie
 * à sa famille. Rien à scanner, aucun code à taper : seul Papote relie une tablette (décision de Tanguy du
 * 12/11). Le QR code de la famille n'apparaît qu'ensuite, sur l'accueil sans photo (tablette.js).
 * Pas d'internet au bout de 90 s, ou pas reliée au bout de 2 min : l'écran le dit sans rien demander, et
 * c'est noté dans le journal pour Papote.
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

  // Étape en cours (1 bienvenue, 2 internet), affichée en haut ; 0 = pas d'étapes (wifi plus tard,
  // attente de la famille).
  var STEPS = 2;
  var stepNum = 0;

  // Illustration de l'étape (bienvenue/<nom>.svg), dans le panneau de gauche ; vide = pas de panneau.
  var art = '';

  // Écran d'attente (« Je cherche internet… », « On prépare votre tablette… ») : rien à lire à voix haute,
  // donc pas de haut-parleur (il relisait la phrase de l'écran d'avant). Remis à false par chaque écran.
  var muet = false;

  function screen(title, subtitle) {
    var sansVoix = muet;
    muet = false;
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
    if (!repair && !sansVoix) {
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
    var audio = new Audio('bienvenue/voix/' + g.id + '.mp3');
    guideAudio = audio;
    // Fichier de voix absent ou illisible : onerror ET le refus de play() arrivent tous les deux ; la voix
    // d'Android ne doit parler qu'une fois (balayage --double / --appui, 13/11 : « wifi-cherche » dit deux fois).
    var dite = false;
    var fallback = function () {
      if (dite || guideAudio !== audio) return;
      dite = true;
      try { (android().speakGuide ? android().speakGuide(g.text) : android().speak(g.text)); } catch (e) {}
    };
    audio.onerror = fallback;
    var p = audio.play();
    if (p && p.catch) p.catch(fallback);
  }
  function sayGuide(id, text) {
    if (repair || (lastGuide && lastGuide.id === id)) return;
    lastGuide = { id: id, text: text };
    playGuide(lastGuide);
  }

  // Un bouton d'installation ne fait qu'une étape : touché deux fois de suite (double clic), la 2e touche est ignorée
  // pendant 1,5 s, pour ne jamais envoyer deux fois le même ordre à Android (vérifié par node galerie.js --double).
  function button(text, cls, onClick) {
    var b = el('button', 'welcome-btn ' + (cls || ''), text);
    var dernier = 0;
    // Une touche double n'agit qu'une fois (1,5 s), sauf les touches du pavé de chiffres : « 75011 »
    // ou « 07160 » tapé d'un trait répète un chiffre, qui était perdu (galerie, 31/10).
    var pave = /(^| )digit( |$)/.test(cls || '');
    b.addEventListener('click', function (e) {
      var t = Date.now();
      if (!pave && t - dernier < 1500) return;
      dernier = t;
      onClick.call(this, e);
    }, false);
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

  // ---------- 2. Wifi ----------

  function wifiState() {
    try { return JSON.parse(android().wifiStatus()); } catch (e) { return {}; }
  }

  // Démarrage à froid : la carte SIM met souvent 30 s à 2 min à trouver internet après « Commencer ». Chez
  // une personne sans box, l'écran du wifi restait figé (audit premier jour 05/11, M0 du 12/11). Décision de
  // Tanguy (12/11) : d'abord « Je cherche internet… » ; si rien ne vient, l'erreur dite clairement et le wifi
  // à donner. La tablette continue de chercher derrière : la 4G arrivée, elle passe à la suite toute seule.
  var CHERCHE_MS = 90000;
  var chercheDepuis = 0;
  var chercheFini = false;

  // La carte SIM donne internet (sans wifi) : étape suivante, sauf pendant le choix d'un réseau.
  function simPrete(s) { return !repair && s.mobile && s.internet && !s.wifi; }

  function showWifi() {
    stepNum = repair ? 0 : 2;
    art = 'wifi';
    clearInterval(wifiTimer);
    var st = wifiState();
    // Carte SIM avec internet : pas besoin de wifi.
    if (simPrete(st)) { finishWifi(); return; }
    var connected = st.wifi && st.internet;
    if (!repair && !connected && st.sim && !chercheFini) { showSearch(); return; }
    var echec = !repair && !connected && chercheFini;
    var box = screen('Connexion à internet', connected || echec ? '' : 'Choisissez le wifi de votre box.');
    if (connected) sayGuide('wifi-ok', 'La tablette est connectée à internet. Appuyez sur Continuer.');
    else sayGuide('wifi-choisir', 'Choisissez le wifi de votre box.');
    if (echec) {
      box.appendChild(el('p', 'welcome-notice', 'La tablette n’a pas trouvé internet.')); // calme, jamais en rouge
      box.appendChild(el('p', 'welcome-sub', 'Choisissez le wifi de votre box. Elle continue aussi de chercher le réseau de sa carte SIM.'));
      box.appendChild(el('p', 'welcome-sub', 'Si ça dure, Papote est prévenu et vous recontacte.'));
    }
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
    if (!repair && !connected && st.sim) {
      wifiTimer = setInterval(function () {
        if (simPrete(wifiState()) && !(root && root.querySelector('.welcome-modal'))) {
          clearInterval(wifiTimer);
          finishWifi();
        }
      }, 3000);
    }
  }

  // « Je cherche internet… » : rien à lire, la tablette se connecte seule (carte SIM, ou wifi déjà connu).
  // « Choisir un wifi » reste à portée de main pour qui a une box (Tanguy, 12/11) ; pendant le choix d'un
  // réseau ou la saisie du mot de passe, l'écran ne change pas sous les doigts.
  function showSearch() {
    muet = true;
    var box = screen('Je cherche internet…', 'Un instant : la tablette se connecte toute seule.');
    box.className += ' welcome-prepare';
    box.appendChild(el('span', 'boot-spin welcome-spin', ''));
    box.appendChild(button('Choisir un wifi', '', openNetworks));
    addBack(box, false);
    if (!chercheDepuis) chercheDepuis = Date.now();
    wifiTimer = setInterval(function () {
      if (root && root.querySelector('.welcome-modal')) return; // liste des wifi ou mot de passe ouverts
      var s = wifiState();
      if (simPrete(s)) { clearInterval(wifiTimer); finishWifi(); return; }
      var trouve = s.wifi && s.internet;
      if (trouve || Date.now() - chercheDepuis >= CHERCHE_MS) {
        clearInterval(wifiTimer);
        chercheFini = true;
        if (!trouve && !searchLogged) {
          searchLogged = true;
          // Gardé dans le journal de la tablette : il part vers Papote dès qu'internet revient.
          try { android().logError('Installation : pas d’internet après 90 s de recherche'); } catch (e) { }
        }
        showWifi(); // wifi trouvé : « Connectée à … », sinon l'erreur et le choix du wifi
      }
    }, 3000);
  }
  var searchLogged = false;

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
    clearInterval(wifiTimer); // mot de passe en cours : la carte SIM ne coupe pas la saisie
    chosen = net;
    if (!net.secure) { connect(''); return; }
    var box = screen('« ' + net.ssid + ' »', 'Tapez le mot de passe du wifi. Il est souvent écrit sous la box.');
    sayGuide('wifi-mdp', 'Tapez le mot de passe du wifi. Il est souvent écrit sous la box.');
    var input = el('input', 'welcome-input');
    input.type = 'text';
    input.setAttribute('aria-label', 'Mot de passe du wifi');
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
    clearInterval(repairWatch);
    if (root) root.setAttribute('hidden', '');
    current = '';
  }

  // Internet revenu tout seul (la box redémarrait plus lentement que la tablette, après une coupure de
  // courant) : l'écran du wifi se referme, Mamie n'a rien à toucher.
  var repairWatch = null;

  function openRepair() {
    // Déjà ouvert (réglage du wifi, ou installation en cours) : on ne touche à rien, la saisie en cours reste.
    if (repair || (root && !root.hasAttribute('hidden') && current)) return;
    ensureRoot();
    repair = true;
    current = 'repair';
    root.removeAttribute('hidden');
    clearInterval(repairWatch);
    repairWatch = setInterval(function () {
      if (repair && wifiState().internet) closeRepair();
    }, 5000);
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

  // ---------- 3. Attente de la famille ----------
  // La tablette a écrit son code de jumelage sur le serveur (interne, jamais montré) ; le serveur la reconnaît
  // et la relie à sa famille. Rien à scanner ni à taper, et rien de lu à voix haute (décision de Tanguy, 12/11).
  // sansInternet : le code n'a pas pu être écrit (internet pas encore là) ; on le dit sans alarmer, avec le
  // wifi à portée de main.
  // Si personne ne la relie au bout de 2 minutes, l'écran le dit, sans rien demander au proche, et c'est noté
  // dans le journal pour Papote (Tanguy, 12/11).

  var ATTENTE_MS = 2 * 60000;
  var pairSince = 0;
  var pairTimer = null;
  var pairLogged = false;

  function showWaiting(s) {
    preloadFaceDetector();
    stepNum = 0;
    art = '';
    muet = true;
    clearTimeout(pairTimer);
    // Pas de code écrit (pas encore d'internet, ou Papote injoignable) : le même écran, qui le dit sans alarmer.
    var horsLigne = !!(s.sansInternet || s.error);
    // Code écrit, la famille ne l'a pas encore pris : au bout de 2 min, on le dit (et Papote est prévenu).
    var attendFamille = s.step === 'pair' && !horsLigne;
    if (attendFamille && !pairSince) pairSince = Date.now();
    var longtemps = attendFamille && Date.now() - pairSince >= ATTENTE_MS;
    var box = screen('On prépare votre tablette…', horsLigne
      ? 'La tablette attend internet pour retrouver sa famille.'
      : longtemps
        ? 'La tablette retrouve sa famille. Elle n’est pas encore reliée : laissez-la allumée, Papote est prévenu et s’en occupe.'
        : 'La tablette retrouve sa famille. Cela peut prendre quelques minutes.');
    box.className += ' welcome-prepare';
    box.appendChild(el('span', 'boot-spin welcome-spin', ''));
    if (horsLigne) {
      box.appendChild(button('Choisir un wifi', '', function () { android().welcomeBack(false); }));
    }
    if (attendFamille) {
      // « Retour » : vers le wifi, ou vers Bienvenue si le wifi a été sauté (carte SIM).
      var st = wifiState();
      addBack(box, !!(st.mobile && st.internet && !st.wifi));
      if (!longtemps) {
        var cle = current;
        pairTimer = setTimeout(function () { if (current === cle) showWaiting(s); }, ATTENTE_MS - (Date.now() - pairSince) + 100);
      } else if (!pairLogged) {
        pairLogged = true;
        // Gardé dans le journal de la tablette : il part vers Papote.
        try { android().logError('Installation : tablette pas reliée à une famille après 2 min'); } catch (e) { }
      }
    }
  }

  window.PapoteBienvenue = {
    show: function (s) {
      ensureRoot();
      root.removeAttribute('hidden');
      // L'attente de la famille ne dépend que de « internet ou pas » : un nouveau code (toutes les 15 min)
      // ne redessine pas l'écran.
      // « confirm » (ancien parcours, plus jamais écrit) : le même écran d'attente, plus de « C'est bien vous ? ».
      var attente = s.step === 'pair' || s.step === 'prepare' || s.step === 'confirm';
      var key = attente ? 'attente|' + (s.sansInternet || s.error ? 1 : 0) + '|' + (s.step === 'pair' ? 'pair' : 'prepare') : s.step;
      if (key === current) return; // déjà affiché (et la saisie en cours n'est pas effacée)
      current = key;
      clearInterval(wifiTimer);
      if (s.step === 'start') { chercheDepuis = 0; chercheFini = false; showStart(); }
      else if (s.step === 'name') showStart(); // ancien parcours retiré (12/11)
      else if (s.step === 'wifi') showWifi();
      else if (s.step === 'meteo') showMeteo();
      else if (attente) showWaiting(s);
    },
    openWifi: openRepair,
    hide: function () {
      if (repair) return; // le réglage du wifi en cours reste affiché
      if (guideAudio) guideAudio.pause();
      if (!root) return;
      root.setAttribute('hidden', '');
      current = '';
      clearInterval(wifiTimer);
      clearTimeout(pairTimer);
    }
  };
})();
