// Questions et messages dans la page, à la place des fenêtres du navigateur (confirm, alert, prompt).
// Une seule boîte à la fois ; Échap ou « Annuler » répond non.

function boite({ texte, oui, non, danger, saisie }) {
  return new Promise((resoudre) => {
    const d = document.createElement('dialog');
    d.className = 'dialogue-papote';
    const p = document.createElement('p');
    p.textContent = texte;
    d.append(p);
    let champ = null;
    if (saisie != null) {
      champ = document.createElement('input');
      champ.value = saisie;
      champ.setAttribute('aria-label', texte);
      d.append(champ);
    }
    const boutons = document.createElement('div');
    boutons.className = 'actions';
    const fin = (valeur) => { d.close(); d.remove(); resoudre(valeur); };
    if (non) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'secondary';
      b.textContent = non;
      b.addEventListener('click', () => fin(champ ? null : false));
      boutons.append(b);
    }
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = danger ? 'primary danger' : 'primary';
    ok.textContent = oui;
    ok.addEventListener('click', () => fin(champ ? champ.value : true));
    boutons.append(ok);
    d.append(boutons);
    if (champ) champ.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok.click(); } });
    d.addEventListener('cancel', (e) => { e.preventDefault(); fin(champ ? null : non ? false : undefined); });
    document.body.append(d);
    d.showModal();
    (champ || ok).focus();
  });
}

// Oui ou non : « oui » est le libellé du bouton qui fait l'action.
export const demander = (texte, { oui = 'Confirmer', non = 'Annuler', danger = false } = {}) => boite({ texte, oui, non, danger });
// Un texte à saisir : null si annulé.
export const saisir = (texte, valeur = '', { oui = 'Valider' } = {}) => boite({ texte, oui, non: 'Annuler', saisie: valeur });
// Une information : un seul bouton.
export const prevenir = (texte) => boite({ texte, oui: 'D\'accord' });
