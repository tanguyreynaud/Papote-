// Fenêtres de l'app à la place des confirm() et alert() du navigateur, jugées vieillottes.

function dialog(message, buttons) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'dialog-back';
    const box = document.createElement('div');
    box.className = 'dialog';
    box.setAttribute('role', 'alertdialog');
    const text = document.createElement('p');
    text.textContent = message;
    const row = document.createElement('div');
    row.className = 'dialog-buttons';
    const close = (value) => {
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
    box.append(text, row);
    back.append(box);
    document.body.append(back);
    row.lastChild.focus();
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

export function notice(message) {
  return dialog(message, [{ label: 'OK', value: true, cls: 'primary' }]);
}
