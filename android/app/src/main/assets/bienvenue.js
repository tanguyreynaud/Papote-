/*
 * Écran « Bienvenue » : première installation chez le client, sans PC.
 * 1. le nom de la tablette, 2. le wifi (sauté si la carte SIM donne internet),
 * 3. le QR code et le code à taper dans l'app famille, 4. « C'est bien vous ? » Oui / Non.
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
  }

  // Étape en cours (1 nom, 2 wifi, 3 famille), affichée en haut ; 0 = pas d'étapes (wifi plus tard).
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
      for (var i = 1; i <= 3; i++) steps.appendChild(el('span', 'dot' + (i < stepNum ? ' done' : i === stepNum ? ' on' : '')));
      steps.appendChild(el('span', 'welcome-stepnum', 'Étape ' + stepNum + ' sur 3'));
      head.appendChild(steps);
    }
    box.appendChild(head);
    box.appendChild(el('h1', 'welcome-title', title));
    if (subtitle) box.appendChild(el('p', 'welcome-sub', subtitle));
    root.appendChild(card);
    return box;
  }

  function button(text, cls, onClick) {
    var b = el('button', 'welcome-btn ' + (cls || ''), text);
    b.addEventListener('click', onClick, false);
    return b;
  }

  // ---------- 1. Nom de la tablette ----------

  function showName() {
    stepNum = 1;
    art = 'nom';
    var box = screen('Bienvenue !', 'Pour commencer, donnez un nom à cette tablette.');
    var input = el('input', 'welcome-input');
    input.type = 'text';
    input.maxLength = 40;
    input.placeholder = 'Par exemple : Mamie Jeanne';
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
    stepNum = 2;
    art = 'wifi';
    var st = wifiState();
    // Carte SIM avec internet : pas besoin de wifi.
    if (!repair && st.mobile && st.internet && !st.wifi) { finishWifi(); return; }
    var box = screen('Connexion à internet', 'Touchez le nom de votre box.');
    if (st.wifi && st.internet) {
      box.appendChild(el('p', 'welcome-ok', 'Connectée à « ' + st.wifi + ' »'));
      box.appendChild(button('Continuer', 'primary', finishWifi));
    }
    var list = el('div', 'welcome-list');
    box.appendChild(list);
    box.appendChild(button('Chercher à nouveau', '', function () { fillNetworks(list); }));
    if (repair) box.appendChild(button('Fermer', 'no', closeRepair));
    fillNetworks(list);
  }

  function fillNetworks(list) {
    list.innerHTML = '';
    list.appendChild(el('p', 'welcome-sub', 'Recherche des réseaux…'));
    setTimeout(function () {
      var nets = [];
      try { nets = JSON.parse(android().wifiScan()); } catch (e) { nets = []; }
      list.innerHTML = '';
      if (!nets.length) {
        list.appendChild(el('p', 'welcome-sub', 'Aucun réseau trouvé. Rapprochez la tablette de la box, puis touchez « Chercher à nouveau ».'));
      }
      for (var i = 0; i < nets.length && i < 6; i++) {
        (function (n) {
          var b = button(n.ssid, 'network', function () { askPassword(n); });
          b.appendChild(el('span', 'bars bars-' + n.level));
          list.appendChild(b);
        })(nets[i]);
      }
    }, 2500);
  }

  function askPassword(net) {
    chosen = net;
    if (!net.secure) { connect(''); return; }
    var box = screen('« ' + net.ssid + ' »', 'Tapez le mot de passe du wifi. Il est souvent écrit sous la box.');
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

  // ---------- 3. Code et QR code ----------

  function pretty(code) { return code.slice(0, 4) + '-' + code.slice(4); }

  function showPair(s) {
    stepNum = 3;
    art = ''; // le QR code est l'illustration
    var box = screen('Reliez la tablette à votre famille', '');
    if (s.error) {
      box.appendChild(el('p', 'welcome-error', s.error));
      return;
    }
    var row = el('div', 'welcome-pair');
    var qr = android().qrCode ? android().qrCode('https://papote-famille.web.app/?tablette=' + s.code) : '';
    if (qr) {
      var img = el('img', 'welcome-qr');
      img.src = qr;
      row.appendChild(img);
    }
    var steps = el('div', 'welcome-steps');
    steps.appendChild(el('p', 'welcome-step', 'Avec votre téléphone, scannez ce QR code.'));
    steps.appendChild(el('p', 'welcome-or', 'ou'));
    steps.appendChild(el('p', 'welcome-step', 'Ouvrez papote-famille.web.app, touchez « Ajouter ma tablette » et tapez :'));
    steps.appendChild(el('p', 'welcome-code', pretty(s.code)));
    steps.appendChild(el('p', 'welcome-sub', 'Le code change toutes les 15 minutes.'));
    row.appendChild(steps);
    box.appendChild(row);
  }

  // ---------- 4. Confirmation ----------

  function showConfirm(s) {
    stepNum = 3;
    art = 'confirmer';
    var who = s.claimedName || 'Quelqu\'un';
    var fam = s.familyName ? ' à la famille de ' + s.familyName : '';
    var box = screen(who + ' veut relier cette tablette' + fam + '.', 'C\'est bien vous ?');
    var row = el('div', 'welcome-actions');
    row.appendChild(button('Non', 'no', function () { android().confirmPairing(false); }));
    row.appendChild(button('Oui', 'primary', function () {
      root.innerHTML = '';
      screen('C\'est fait !', 'La tablette est reliée à la famille.');
      android().confirmPairing(true);
    }));
    box.appendChild(row);
  }

  window.PapoteBienvenue = {
    show: function (s) {
      ensureRoot();
      root.removeAttribute('hidden');
      var key = s.step + '|' + (s.code || '') + '|' + (s.error || '') + '|' + (s.claimedName || '');
      if (key === current) return; // déjà affiché (et la saisie en cours n'est pas effacée)
      current = key;
      clearInterval(wifiTimer);
      if (s.step === 'name') showName();
      else if (s.step === 'wifi') showWifi();
      else if (s.step === 'pair') showPair(s);
      else if (s.step === 'confirm') showConfirm(s);
    },
    openWifi: openRepair,
    hide: function () {
      if (repair) return; // le réglage du wifi en cours reste affiché
      if (!root) return;
      root.setAttribute('hidden', '');
      current = '';
      clearInterval(wifiTimer);
    }
  };
})();
