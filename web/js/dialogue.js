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

// Menu « ⋮ » : les actions d'une ligne rangées derrière un seul bouton, chacune garde sa confirmation.
// La liste est placée en position fixe, pour ne pas être coupée par un tableau qui défile.
let menuOuvert = null;
function fermerMenu() {
  if (!menuOuvert) return;
  menuOuvert.liste.hidden = true;
  menuOuvert.bouton.setAttribute('aria-expanded', 'false');
  menuOuvert = null;
}
document.addEventListener('click', (e) => { if (menuOuvert && !menuOuvert.boite.contains(e.target)) fermerMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fermerMenu(); });
window.addEventListener('scroll', fermerMenu, true);
window.addEventListener('resize', fermerMenu);

// actions : [{ libelle, faire(bouton), danger }] ; les valeurs vides sont ignorées.
export function menuPoints(actions, titre = 'Plus d\'actions') {
  const boite = document.createElement('div');
  boite.className = 'menu-points';
  const bouton = document.createElement('button');
  bouton.type = 'button';
  bouton.className = 'menu-points-bouton';
  bouton.textContent = '⋮';
  bouton.title = titre;
  bouton.setAttribute('aria-label', titre);
  bouton.setAttribute('aria-haspopup', 'menu');
  bouton.setAttribute('aria-expanded', 'false');
  const liste = document.createElement('div');
  liste.className = 'menu-points-liste';
  liste.setAttribute('role', 'menu');
  liste.hidden = true;
  for (const a of actions.filter(Boolean)) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `menu-points-item${a.danger ? ' danger' : ''}`;
    item.setAttribute('role', 'menuitem');
    item.textContent = a.libelle;
    item.addEventListener('click', () => { fermerMenu(); a.faire(bouton); });
    liste.append(item);
  }
  // Un clic dans le menu n'ouvre pas la ligne (de tableau) qui le contient.
  boite.addEventListener('click', (e) => e.stopPropagation());
  boite.addEventListener('keydown', (e) => e.stopPropagation());
  bouton.addEventListener('click', () => {
    const ouvrir = liste.hidden;
    fermerMenu();
    if (!ouvrir || bouton.disabled) return;
    const r = bouton.getBoundingClientRect();
    liste.hidden = false;
    const bas = r.bottom + 6 + liste.offsetHeight > window.innerHeight && r.top > liste.offsetHeight + 6;
    liste.style.top = `${bas ? r.top - liste.offsetHeight - 6 : r.bottom + 6}px`;
    liste.style.left = `${Math.max(8, r.right - liste.offsetWidth)}px`;
    bouton.setAttribute('aria-expanded', 'true');
    menuOuvert = { boite, bouton, liste };
    liste.querySelector('button')?.focus();
  });
  boite.append(bouton, liste);
  return boite;
}
