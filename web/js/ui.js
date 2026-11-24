// Fenêtres de l'app à la place des confirm() et alert() du navigateur, jugées vieillottes.

// Fenêtres ouvertes, la plus récente en dernier : le bouton retour d'Android ferme la dernière.
const ouvertes = [];

// Double appui sur un bouton qui ouvre une fenêtre : le 2e toucher tombe sur la fenêtre à peine ouverte, au même
// endroit. Sur un petit écran (iPhone 15 dans Safari, 659 px de haut), il tombait sur « Garder Papote » de la fenêtre
// « Avant de partir » à peine ouverte : elle se refermait aussitôt (« Résilier » doublé = rien ne s'ouvre, « Merci de
// rester ») ; ailleurs, ce pouvait être le fond gris ou un autre bouton, choisi sans avoir lu. Ce 2e toucher est
// ignoré par la fenêtre (fond, boutons, croix) : moins d'une demi-seconde après le toucher qui l'a ouverte (pendant ce
// clic), à moins de 40 px.
const DOUBLE_MS = 500;
const DOUBLE_PX = 40;
let dernierToucher = null; // { x, y, t } du dernier clic de la page
document.addEventListener('click', (e) => { dernierToucher = { x: e.clientX, y: e.clientY, t: e.timeStamp }; }, { capture: true, passive: true });

// « Wi-Fi » ne se coupe jamais en deux lignes (« Wi- » en bout de ligne, « Fi » dessous) : le mot reste entier.
// Le texte lu (textContent) ne change pas.
function poserSansCoupure(el, texte) {
  const morceaux = String(texte ?? '').split(/(Wi-Fi)/);
  if (morceaux.length === 1) { el.textContent = texte; return; }
  el.replaceChildren(...morceaux.filter(Boolean).map((m) => {
    if (m !== 'Wi-Fi') return m;
    const s = document.createElement('span');
    s.className = 'sans-coupure';
    s.textContent = m;
    return s;
  }));
}

function dialog(message, buttons, extra = null) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'dialog-back';
    const box = document.createElement('div');
    box.className = extra?.cls ? `dialog ${extra.cls}` : 'dialog';
    box.setAttribute('role', 'alertdialog');
    const text = document.createElement('p');
    // Sans titre : la première phrase, si elle est courte, est la question (en gras), la suite l'explique (plus
    // discrète). Le texte complet reste dans le même paragraphe, mot pour mot.
    const poserTexte = (t) => {
      const m = !extra?.title && /^(.{1,64}?[?!.…])\s+(\S[\s\S]*)$/.exec(t || '');
      text.className = extra?.title ? '' : 'dialog-msg';
      if (!m) { poserSansCoupure(text, t); text.classList.toggle('seul', !extra?.title); } else {
        const q = document.createElement('span');
        q.className = 'dialog-q';
        poserSansCoupure(q, m[1]);
        const d = document.createElement('span');
        d.className = 'dialog-d';
        poserSansCoupure(d, m[2]);
        text.replaceChildren(q, ' ', d);
        // Une adresse e-mail dont parle la question : seule sur sa ligne, entre la question et l'explication,
        // entière pour qu'on puisse la relire (une adresse vraiment très longue passe à la ligne).
        if (extra?.adresse) {
          const a = document.createElement('span');
          a.className = 'dialog-adresse';
          a.textContent = extra.adresse;
          d.before(a, ' ');
        }
      }
      text.hidden = !t;
    };
    poserTexte(message);
    const row = document.createElement('div');
    row.className = extra?.stack ? 'dialog-buttons stack' : 'dialog-buttons';
    // Le toucher qui ouvre cette fenêtre (fenêtre ouverte pendant ce clic) : son double est ignoré.
    // Le 2e clic peut porter la même heure que le 1er (heure des évènements arrondie au dixième de milliseconde : double
    // clic rapide, vu en CI le 19/11 sur la poubelle d'un message en attente, la fenêtre se refermait) : « au même
    // instant ou après », et l'évènement qui a ouvert la fenêtre est reconnu à lui-même, pas à son heure.
    const ouvreur = window.event?.type === 'click' && dernierToucher?.t === window.event.timeStamp
      ? { ...dernierToucher, ev: window.event } : null;
    const doublon = (e) => !!ouvreur && e !== ouvreur.ev && e.timeStamp - ouvreur.t < DOUBLE_MS && e.timeStamp >= ouvreur.t
      && Math.hypot(e.clientX - ouvreur.x, e.clientY - ouvreur.y) < DOUBLE_PX;
    const close = (value) => {
      if (back.classList.contains('closing')) return;
      ouvertes.splice(ouvertes.indexOf(close), 1);
      back.classList.add('closing');
      setTimeout(() => back.remove(), 150);
      resolve(value);
    };
    // Boutons changés juste après un toucher sur un bouton de cette fenêtre (api.boutons) : le 2e toucher d'un double
    // appui sur l'ancien bouton tomberait sur le nouveau au même endroit ; ignoré pendant une demi-seconde. Un
    // changement venu d'ailleurs (la tablette, le serveur) ne bloque rien, même juste après un toucher ailleurs dans
    // la page (CI WebKit, 20/11 : la fenêtre changée 0,4 s après un toucher sur l'accueil, son « OK » restait sourd).
    let nouveauxDepuis = -Infinity;
    let toucherIci = -Infinity; // dernier toucher sur un bouton de CETTE fenêtre
    // action(bouton) : le bouton agit sans fermer la fenêtre (elle change ensuite par l'api) ; sinon il la ferme.
    const poserBoutons = (liste) => {
      row.replaceChildren();
      for (const { label, value, cls, action, disabled, icone } of liste) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.disabled = !!disabled;
        b.textContent = label;
        if (icone) {
          const rond = document.createElement('span');
          rond.className = 'menu-icone';
          rond.setAttribute('aria-hidden', 'true');
          rond.innerHTML = `<svg><use href="#i-${icone}"/></svg>`;
          b.prepend(rond);
        }
        b.addEventListener('click', (e) => {
          if (doublon(e) || e.timeStamp - nouveauxDepuis < DOUBLE_MS || b.disabled) return;
          toucherIci = e.timeStamp;
          if (action) action(b); else close(value);
        });
        row.append(b);
      }
    };
    poserBoutons(buttons);
    back.addEventListener('click', (e) => { if (e.target === back && !doublon(e)) close(false); });
    const h = document.createElement('h2');
    h.className = 'dialog-title';
    h.textContent = extra?.title || '';
    if (extra?.title) box.append(h);
    // Croix en haut à droite (fenêtre sans bouton « Annuler ») : ferme sans rien choisir.
    if (extra?.croix) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'icon-btn dialog-croix';
      x.setAttribute('aria-label', 'Fermer');
      x.innerHTML = '<svg><use href="#i-close"/></svg>';
      x.addEventListener('click', (e) => { if (!doublon(e)) close(false); });
      box.append(x);
      box.classList.add('avec-croix');
    }
    // Menu d'une personne : sa photo (ou son initiale), son prénom et son adresse en tête de la fenêtre.
    if (extra?.title && extra.tete) {
      const tete = document.createElement('div');
      tete.className = 'dialog-tete';
      const rond = document.createElement(extra.tete.photo ? 'img' : 'span');
      rond.className = 'dialog-tete-photo';
      if (extra.tete.photo) { rond.src = extra.tete.photo; rond.alt = ''; } else { rond.textContent = (extra.title.trim()[0] || '?').toUpperCase(); rond.setAttribute('aria-hidden', 'true'); }
      const qui = document.createElement('div');
      h.replaceWith(tete);
      qui.append(h);
      if (extra.tete.sous) { const s = document.createElement('p'); s.className = 'dialog-tete-sous'; s.textContent = extra.tete.sous; qui.append(s); }
      tete.append(rond, qui);
    }
    // Fenêtre qui change en restant ouverte (SOS : en cours, puis comment il s'est terminé) : titre, texte, boutons.
    extra?.api?.({
      titre: (t) => { h.textContent = t; if (!h.isConnected) box.prepend(h); },
      texte: (t) => poserTexte(t),
      boutons: (liste) => {
        poserBoutons(liste);
        if (performance.now() - toucherIci < DOUBLE_MS) nouveauxDepuis = performance.now();
        row.firstChild?.focus();
      },
      fermer: (v) => close(v),
      ouverte: () => !back.classList.contains('closing'),
    });
    // Petit dessin en haut de la fenêtre (corbeille rouge pour supprimer, caméra pour appeler…) : on reconnaît la
    // question d'un coup d'œil.
    if (extra?.icone) {
      const rond = document.createElement('span');
      rond.className = extra.danger ? 'dialog-icone danger' : 'dialog-icone';
      rond.setAttribute('aria-hidden', 'true');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', `#i-${extra.icone}`);
      svg.append(use);
      rond.append(svg);
      box.append(rond);
      box.classList.add('avec-icone');
    }
    box.append(text);
    // Étapes numérotées (« Que faire ? ») : numéro, dessin du sprite de la page, phrase en gras, détail.
    if (extra?.etapes) {
      const ol = document.createElement('ol');
      ol.className = 'dialog-etapes';
      extra.etapes.forEach((e, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="etape-num">${i + 1}</span><svg class="etape-icone" aria-hidden="true"><use href="#${e.icone}"/></svg>`
          + '<span class="etape-texte"><strong></strong><span></span></span>';
        li.querySelector('strong').textContent = e.titre;
        li.querySelector('.etape-texte span').textContent = e.texte;
        ol.append(li);
      });
      box.append(ol);
    }
    if (extra?.list) {
      const ul = document.createElement('ul');
      ul.className = 'dialog-list';
      for (const item of extra.list) {
        const li = document.createElement('li');
        li.textContent = item;
        ul.append(li);
      }
      box.append(ul);
    }
    for (const line of extra?.after || []) {
      const p = document.createElement('p');
      p.textContent = line;
      box.append(p);
    }
    box.append(row);
    back.append(box);
    document.body.append(back);
    ouvertes.push(close);
    // Petit écran : la fenêtre, plus haute que l'écran, défile à l'intérieur. Sans preventScroll, le bouton qui prend
    // la main (en bas) faisait défiler jusqu'à lui : on arrivait sur la fin du texte, titre et premières étapes coupés
    // (tests du 21/11, « Que faire ? » : Marc, Nadia, Paul). La fenêtre s'ouvre toujours sur son titre.
    (extra?.stack ? row.firstChild : row.lastChild).focus({ preventScroll: true });
    box.scrollTop = 0;
  });
}

// Le bouton reprend l'action demandée : « Supprimer… ? » → Supprimer.
function actionLabel(message) {
  if (message.startsWith('Se déconnecter')) return 'Se déconnecter';
  const word = message.split(/[\s ]/)[0];
  return /^[A-ZÉ][a-zéèêàç]+er$/.test(word) ? word : 'Confirmer';
}

// Le dessin de la fenêtre, d'après le premier mot de la question.
function iconeDe(message) {
  const m = [
    [/^Supprimer|^Effacer/, 'trash'], [/^Appeler/, 'video'], [/^Redémarrer/, 'tablette'],
    [/^Quitter|^Se déconnecter/, 'sortie'], [/^Retirer|^Refuser|^Rendre|^Mettre|^Accepter/, 'user'],
    [/^Changer le code/, 'famille'],
    [/^Inviter|^Annuler l'invitation/, 'mail'],
  ].find(([r]) => r.test(message));
  return m ? m[1] : 'help';
}

/** nonLabel : le mot du bouton qui renonce ; adresse : une adresse e-mail montrée seule sur sa ligne sous la question. */
export function askConfirm(message, okLabel = actionLabel(message), nonLabel = 'Annuler', adresse = null) {
  const danger = /^(Supprimer|Quitter|Retirer|Refuser|Se déconnecter|Changer|Annuler l'invitation)/.test(message);
  return dialog(message, [
    { label: nonLabel, value: false, cls: 'secondary' },
    { label: okLabel, value: true, cls: danger ? 'primary danger-btn' : 'primary' },
  ], { icone: iconeDe(message), danger, adresse });
}

/** Étape « Avant de partir » avant une résiliation : garder (principal) ou résilier quand même. */
export function avantDePartir({ intro, perdu, suite }) {
  return dialog(intro, [
    { label: 'Garder Papote', value: false, cls: 'primary' },
    { label: 'Résilier quand même', value: true, cls: 'secondary' },
  ], { title: 'Avant de partir', list: perdu, after: suite, stack: true });
}

/**
 * SOS resté sans réponse (notification « <Prénom> a appuyé sur SOS ») : le nom, l'heure, et « Rappeler <Prénom> » en
 * premier, « Plus tard » dessous, même taille. true si « Rappeler » est touché (Tanguy, 20/11 : « Oui avec une popup »).
 */
export function fenetreSos(nom, quand) {
  return dialog(quand ? `${quand}. Personne n'a pu répondre.` : 'Personne n\'a pu répondre.', [
    { label: `Rappeler ${nom}`, value: true, cls: 'primary' },
    { label: 'Plus tard', value: false, cls: 'secondary' },
  ], { title: `${nom} a appuyé sur SOS`, stack: true, cls: 'dialog-sos' });
}

/**
 * SOS suivi en direct (fiche de la tablette, members/{uid}.sos) : la même fenêtre, qui change en restant ouverte.
 * etat : { titre, texte, boutons } ; boutons : [{ label, value, cls, action, disabled }] (action : ne ferme pas).
 * Renvoie { fin: Promise (valeur du bouton qui ferme, false pour le fond), maj(etat) }.
 */
export function fenetreSosSuivie(etat) {
  let api = null;
  const fin = dialog(etat.texte, etat.boutons, {
    title: etat.titre, stack: true, cls: 'dialog-sos', api: (a) => { api = a; },
  });
  return {
    fin,
    maj(e) {
      if (!api?.ouverte()) return;
      api.titre(e.titre);
      api.texte(e.texte);
      if (e.boutons) api.boutons(e.boutons);
    },
  };
}

/** Menu d'actions (bouton « ⋯ ») : renvoie la valeur choisie, ou false si annulé. */
export function chooseAction(title, options, tete = null) {
  return dialog('', [
    ...options.map((o) => ({ label: o.label, value: o.value, icone: o.icone, cls: o.danger ? 'secondary action-danger' : 'secondary' })),
  ], { title, stack: true, cls: 'dialog-menu dialog-menu-croix', tete, croix: true });
}

/**
 * Changer une photo (Tanguy, 23/11) : deux grandes cases « Appareil photo » et « Galerie », une croix en haut à
 * droite pour fermer. Renvoie 'camera', 'gallery', ou false si fermé.
 */
export function choisirPhoto(titre) {
  return dialog('', [
    { label: 'Appareil photo', value: 'camera', icone: 'camera', cls: 'secondary photo-case' },
    { label: 'Galerie', value: 'gallery', icone: 'gallery', cls: 'secondary photo-case' },
  ], { title: titre, stack: true, cls: 'dialog-menu dialog-photo', croix: true });
}

export function notice(message) {
  return dialog(message, [{ label: 'OK', value: true, cls: 'primary' }], { icone: /échoué|n'a pas pu|n'ont pas pu|ne répond pas|n'est pas parti|refusé/.test(message) ? 'outil' : 'help' });
}

/**
 * « Que faire ? » quand la tablette ne répond plus (Tanguy, 20/11) : 3 étapes concrètes, chacune avec son numéro,
 * son dessin et une phrase courte en gras, puis « Dépanner la tablette » en dessous (banc du 19/11 : Julie et Sylvie
 * arrivaient dans Dépanner sans consigne). depuis : « 2 h »… Rend 'depanner' si la personne touche ce lien.
 */
export function queFaireTablette(nom, depuis) {
  return dialog(depuis ? `Aucune nouvelle de la tablette depuis ${depuis}.` : '', [
    { label: 'Compris', value: true, cls: 'primary' },
    { label: 'Plus d\'aide : dépanner la tablette', value: 'depanner', cls: 'link' },
  ], {
    title: 'Que faire ?', stack: true, cls: 'dialog-que-faire',
    etapes: [
      { icone: 'i-phone', titre: `Vous êtes loin ? Appelez ${nom} ou un voisin`, texte: 'Demandez de vérifier que la tablette est branchée et que son écran est allumé.' },
      { icone: 'i-plug', titre: 'Écran noir : il faut la rallumer', texte: 'Brancher le chargeur, puis appuyer 3 secondes sur le bouton marche/arrêt, sur le côté.' },
      { icone: 'i-wifi', titre: 'Elle revient toute seule', texte: 'En quelques minutes. Ce message disparaît dès qu\'elle est reconnectée.' },
    ],
  });
}

/** Message d'échec avec « Besoin d'aide ? » : rend 'aide' si la personne le touche. */
export function noticeAide(message) {
  return dialog(message, [
    { label: 'Besoin d\'aide ?', value: 'aide', cls: 'secondary' },
    { label: 'OK', value: true, cls: 'primary' },
  ]);
}

/** Bouton retour d'Android : ferme la dernière fenêtre ouverte comme « Annuler ». false s'il n'y en a pas. */
export function fermerFenetre() {
  const close = ouvertes[ouvertes.length - 1];
  if (!close) return false;
  close(false);
  return true;
}

/** Retour arrière qui fermerait l'app : on demande d'abord. true = quitter. */
export function demanderQuitter() {
  return dialog('Voulez-vous quitter Papote ?', [
    { label: 'Rester', value: false, cls: 'secondary' },
    { label: 'Quitter', value: true, cls: 'primary' },
  ], { icone: 'sortie' });
}

/**
 * Rien ne surgit (cohérence, 24/11) : dans une liste que l'app redessine en entier à chaque nouveauté, seule la ligne
 * vraiment nouvelle arrive en fondu. cles : une clé par enfant, dans l'ordre (null = jamais animée, par exemple mon
 * propre message, déjà à l'écran en gris). Premier dessin, ou plus de 3 nouvelles lignes d'un coup (ouverture, changement
 * de famille) : rien ne bouge, pour que la liste ne clignote jamais.
 */
const dejaVues = new WeakMap();
const enArrivee = new WeakMap(); // liste → Map(clé → heure de début du fondu)
const DUREE_ARRIVEE = 300;
export function fonduNouveaux(liste, cles) {
  const avant = dejaVues.get(liste);
  dejaVues.set(liste, new Set(cles.filter((c) => c != null)));
  if (!avant) return;
  const debuts = enArrivee.get(liste) || new Map();
  enArrivee.set(liste, debuts);
  const maintenant = performance.now();
  for (const [c, t] of debuts) if (maintenant - t >= DUREE_ARRIVEE) debuts.delete(c);
  const enfants = [...liste.children];
  const nouvelles = enfants.map((e, i) => [e, cles[i]]).filter(([, c]) => c != null && !avant.has(c));
  // Liste pas à l'écran (autre page ouverte) : rien à animer, sinon le fondu partirait plus tard, à l'ouverture de la page.
  if (nouvelles.length <= 3 && liste.offsetParent !== null) for (const [, c] of nouvelles) debuts.set(c, maintenant);
  // La liste est parfois redessinée 2 ou 3 fois de suite (heure du serveur, « Vu ») : la ligne en train d'arriver
  // reprend son fondu là où il en était, au lieu d'être coupée net.
  enfants.forEach((e, i) => {
    const t = debuts.get(cles[i]);
    if (t == null) return;
    e.classList.add('arrive');
    if (maintenant > t) e.style.animationDelay = `-${Math.round(maintenant - t)}ms`;
  });
}

/**
 * Rien ne disparaît d'un coup (24/11) : la ligne qu'on vient de supprimer s'efface et se referme en 0,2 s avant que la
 * liste soit redessinée. revenir() la remet si la suppression échoue. Sans animation si le téléphone les a coupées.
 */
export function partir(ligne) {
  if (!ligne || !ligne.isConnected || matchMedia('(prefers-reduced-motion: reduce)').matches) return { fini: Promise.resolve(), revenir() {} };
  const avant = ligne.getAttribute('style');
  ligne.style.height = `${ligne.offsetHeight}px`;
  ligne.offsetHeight; // la hauteur de départ est prise en compte avant de la réduire
  ligne.classList.add('part');
  ligne.style.height = '0px';
  return {
    fini: new Promise((r) => setTimeout(r, 220)),
    revenir() { ligne.classList.remove('part'); if (avant === null) ligne.removeAttribute('style'); else ligne.setAttribute('style', avant); },
  };
}
