// Faute de frappe dans l'adresse e-mail (Tanguy, 12/11, point 43) : « gmail.con », « hotmial.fr », « orange.f »…
// La page propose « Vouliez-vous dire … ? » avec un bouton « Corriger », sans jamais bloquer : l'adresse saisie reste
// valable si le client ne corrige pas. Aucune IA, aucun appel extérieur : une liste des boîtes courantes en France.
// Utilisé par commande.html et « Être prévenu » (accueil.html) ; testé par functions/email-correcteur.test.js.
(function (racine) {
  var DOMAINES = ['gmail.com', 'hotmail.fr', 'hotmail.com', 'yahoo.fr', 'yahoo.com', 'orange.fr', 'wanadoo.fr', 'free.fr',
    'sfr.fr', 'laposte.net', 'outlook.fr', 'outlook.com', 'live.fr', 'live.com', 'msn.com', 'icloud.com', 'me.com',
    'bbox.fr', 'neuf.fr', 'aol.com', 'gmx.fr', 'gmx.com', 'numericable.fr', 'protonmail.com', 'proton.me', 'club-internet.fr', 'aliceadsl.fr'];
  // Domaines qui n'existent pas pour des e-mails mais qu'on tape souvent.
  var DIRECTS = { 'gmail.fr': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail': 'gmail.com', 'hotmail': 'hotmail.fr', 'orange': 'orange.fr',
    'free': 'free.fr', 'yahoo': 'yahoo.fr', 'icloud.fr': 'icloud.com', 'laposte.fr': 'laposte.net', 'outlook': 'outlook.fr' };
  // Fin d'adresse mal tapée, pour n'importe quel domaine (« monentreprise.con »).
  var FINS = { con: 'com', cmo: 'com', ocm: 'com', cm: 'com', comm: 'com', vom: 'com', xom: 'com', co: null,
    fe: 'fr', f: 'fr', frr: 'fr', rf: 'fr', ft: 'fr', dr: 'fr', nte: 'net', ent: 'net', nett: 'net' };

  // Distance de Damerau-Levenshtein (insertion, suppression, remplacement, deux lettres inversées).
  function distance(a, b) {
    var d = [];
    for (var i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (var j = 0; j <= b.length; j++) { d[0][j] = j; }
    for (i = 1; i <= a.length; i++) {
      for (j = 1; j <= b.length; j++) {
        var c = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  }

  // Adresse corrigée à proposer, ou null si rien ne semble faux (ou si on ne sait pas).
  function suggestion(saisie) {
    var mel = String(saisie || '').trim().toLowerCase().replace(/\s+/g, '');
    var at = mel.lastIndexOf('@');
    if (at < 1 || at === mel.length - 1) return null;
    var nom = mel.slice(0, at);
    var domaine = mel.slice(at + 1).replace(/\.+$/, '').replace(/,/g, '.').replace(/\.{2,}/g, '.');
    if (DOMAINES.indexOf(domaine) >= 0) return domaine === mel.slice(at + 1) ? null : nom + '@' + domaine;
    if (DIRECTS[domaine]) return nom + '@' + DIRECTS[domaine];
    var meilleur = null;
    var ecart = Infinity;
    DOMAINES.forEach(function (d) {
      var e = distance(domaine, d);
      if (e < ecart) { ecart = e; meilleur = d; }
    });
    // Une faute pour un domaine court, deux pour un long (« hotmial.fr », « gmal.com », « wanado.fr »).
    if (meilleur && ecart <= (meilleur.length <= 7 ? 1 : 2)) return nom + '@' + meilleur;
    var point = domaine.lastIndexOf('.');
    if (point > 0) {
      var fin = FINS[domaine.slice(point + 1)];
      if (fin) return nom + '@' + domaine.slice(0, point + 1) + fin;
    }
    return null;
  }

  // Branche la proposition sous un champ e-mail. La proposition apparaît quand le client quitte le champ ou s'arrête
  // de taper ; « Corriger » remplace l'adresse et prévient la page (évènement input) ; rien n'est jamais bloqué.
  function brancher(champ) {
    if (!champ || champ.dataset.correcteur) return;
    champ.dataset.correcteur = '1';
    var bulle = document.createElement('p');
    bulle.className = 'mel-suggestion';
    bulle.hidden = true;
    bulle.setAttribute('role', 'status');
    var texte = document.createElement('span');
    var bouton = document.createElement('button');
    bouton.type = 'button';
    bouton.textContent = 'Corriger';
    bulle.append(texte, bouton);
    var parent = champ.closest('label') || champ;
    parent.insertAdjacentElement('afterend', bulle);
    var propose = null;
    var minuterie = null;
    function verifier() {
      propose = suggestion(champ.value);
      if (!propose) { bulle.hidden = true; return; }
      texte.textContent = 'Vouliez-vous dire ' + propose + ' ? ';
      bulle.hidden = false;
    }
    champ.addEventListener('input', function () {
      clearTimeout(minuterie);
      if (!bulle.hidden && !suggestion(champ.value)) bulle.hidden = true;
      minuterie = setTimeout(verifier, 900);
    });
    champ.addEventListener('blur', function () { clearTimeout(minuterie); verifier(); });
    bouton.addEventListener('click', function () {
      if (!propose) return;
      champ.value = propose;
      bulle.hidden = true;
      champ.dispatchEvent(new Event('input', { bubbles: true }));
      clearTimeout(minuterie);
      champ.focus();
    });
  }

  var api = { suggestion: suggestion, brancher: brancher, distance: distance };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else racine.papoteEmail = api;
})(this);
