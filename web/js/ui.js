// Fenêtres de l'app à la place des confirm() et alert() du navigateur, jugées vieillottes.

// Fenêtres ouvertes, la plus récente en dernier : le bouton retour d'Android ferme la dernière.
const ouvertes = [];

function dialog(message, buttons, extra = null) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'dialog-back';
    const box = document.createElement('div');
    box.className = 'dialog';
    box.setAttribute('role', 'alertdialog');
    const text = document.createElement('p');
    text.textContent = message;
    text.hidden = !message;
    const row = document.createElement('div');
    row.className = extra?.stack ? 'dialog-buttons stack' : 'dialog-buttons';
    const close = (value) => {
      if (back.classList.contains('closing')) return;
      ouvertes.splice(ouvertes.indexOf(close), 1);
      back.classList.add('closing');
      setTimeout(() => back.remove(), 150);
      resolve(value);
    };
    for (const { label, value, cls } of buttons) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = label;
      b.addEventListener('click', () => close(value));
      row.append(b);
    }
    back.addEventListener('click', (e) => { if (e.target === back) close(false); });
    // Croix en haut à droite : ferme sans rien faire (à la place d'un bouton « Annuler »).
    if (extra?.croix) {
      box.classList.add('avec-croix');
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'icon-btn dialog-croix';
      x.setAttribute('aria-label', 'Fermer');
      x.innerHTML = '<svg><use href="#i-close"/></svg>';
      x.addEventListener('click', () => close(false));
      box.append(x);
    }
    if (extra?.title) {
      const h = document.createElement('h2');
      h.className = 'dialog-title';
      h.textContent = extra.title;
      box.append(h);
    }
    box.append(text);
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
    (extra?.stack ? row.firstChild : row.lastChild).focus();
  });
}

// Le bouton reprend l'action demandée : « Supprimer… ? » → Supprimer.
function actionLabel(message) {
  if (message.startsWith('Se déconnecter')) return 'Se déconnecter';
  const word = message.split(/[\s ]/)[0];
  return /^[A-ZÉ][a-zéèêàç]+er$/.test(word) ? word : 'Confirmer';
}

export function askConfirm(message, okLabel = actionLabel(message)) {
  const danger = /^(Supprimer|Quitter|Retirer|Refuser|Se déconnecter|Changer)/.test(message);
  return dialog(message, [
    { label: 'Annuler', value: false, cls: 'secondary' },
    { label: okLabel, value: true, cls: danger ? 'primary danger-btn' : 'primary' },
  ]);
}

/** Confirmation avec une croix pour fermer et un seul bouton d'action. */
export function confirmerAvecCroix(message, okLabel) {
  return dialog(message, [{ label: okLabel, value: true, cls: 'primary' }], { croix: true });
}

/** Étape « Avant de partir » avant une résiliation : garder (principal) ou résilier quand même. */
export function avantDePartir({ intro, perdu, suite }) {
  return dialog(intro, [
    { label: 'Garder Papote', value: false, cls: 'primary' },
    { label: 'Résilier quand même', value: true, cls: 'secondary' },
  ], { title: 'Avant de partir', list: perdu, after: suite, stack: true });
}

/** Menu d'actions (bouton « ⋯ ») : renvoie la valeur choisie, ou false si annulé. */
export function chooseAction(title, options) {
  return dialog('', [
    ...options.map((o) => ({ label: o.label, value: o.value, cls: o.danger ? 'secondary action-danger' : 'secondary' })),
    { label: 'Annuler', value: false, cls: 'link' },
  ], { title, stack: true });
}

export function notice(message) {
  return dialog(message, [{ label: 'OK', value: true, cls: 'primary' }]);
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
  ]);
}
