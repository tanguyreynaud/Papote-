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
      if (!m) { text.textContent = t; text.classList.toggle('seul', !extra?.title); } else {
        const q = document.createElement('span');
        q.className = 'dialog-q';
        q.textContent = m[1];
        const d = document.createElement('span');
        d.className = 'dialog-d';
        d.textContent = m[2];
        text.replaceChildren(q, ' ', d);
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
    [/^Changer le code|^Inviter/, 'famille'],
  ].find(([r]) => r.test(message));
  return m ? m[1] : 'help';
}

export function askConfirm(message, okLabel = actionLabel(message)) {
  const danger = /^(Supprimer|Quitter|Retirer|Refuser|Se déconnecter|Changer)/.test(message);
  return dialog(message, [
    { label: 'Annuler', value: false, cls: 'secondary' },
    { label: okLabel, value: true, cls: danger ? 'primary danger-btn' : 'primary' },
  ], { icone: iconeDe(message), danger });
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
    { label: 'Annuler', value: false, cls: 'link' },
  ], { title, stack: true, cls: 'dialog-menu', tete });
}

export function notice(message) {
  return dialog(message, [{ label: 'OK', value: true, cls: 'primary' }]);
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
      { icone: 'i-tablette', titre: 'Son écran est-il allumé ?', texte: `Vous n'êtes pas sur place ? Appelez ${nom} ou quelqu'un près d'elle, et demandez-le.` },
      { icone: 'i-plug', titre: 'Écran noir : rallumez-la', texte: 'Branchez le chargeur, puis appuyez 3 secondes sur le bouton marche/arrêt, sur le côté.' },
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
