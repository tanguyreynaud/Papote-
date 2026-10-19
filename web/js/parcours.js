// Parcours pas à pas de l'espace admin (envoi d'une commande, réception d'une tablette ou d'accessoires) :
// une étape par écran, des cases à cocher, et « C'est fait » seulement quand tout est coché.
// Chaque étape : { cle, titre, texte, cases: [texte], contenu(zone, etat, rafraichir), pret(etat),
//   valider(etat) (async, peut lever une erreur affichée), bouton, saute(etat), apres (contenu sous les cases) }.
// L'avancement est rendu à sauver(etat) après chaque étape : on peut fermer et reprendre plus tard.

import { messageErreur } from './gestion-api.js';

const el = (tag, attrs = {}, ...enfants) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...enfants.flat().filter((x) => x != null && x !== false));
  return e;
};
export { el };

let dialogue;
function fenetre() {
  if (dialogue) return dialogue;
  dialogue = el('dialog', { class: 'fenetre parcours', 'aria-labelledby': 'pc-titre' },
    el('div', { class: 'fenetre-tete' },
      el('h2', { id: 'pc-titre' }),
      el('button', { type: 'button', class: 'fermer', 'aria-label': 'Fermer (l\'avancement est gardé)' }, '✕')),
    el('ol', { class: 'pc-etapes' }),
    el('div', { class: 'pc-corps' }),
    el('p', { class: 'pc-erreur error', hidden: true }),
    el('div', { class: 'pc-pied' },
      el('button', { type: 'button', class: 'link pc-retour' }, '← Étape précédente'),
      el('button', { type: 'button', class: 'primary pc-suivant' }, 'C\'est fait')));
  dialogue.querySelector('.fermer').addEventListener('click', () => dialogue.close());
  document.body.append(dialogue);
  return dialogue;
}

/**
 * Ouvre un parcours. etat : objet libre partagé par les étapes ({ etape, faits:{cle: ms}, ... }).
 * Renvoie une promesse résolue à la fermeture, avec true si le parcours est allé au bout.
 */
export function ouvrirParcours({ titre, etapes, etat, sauver, fin }) {
  const d = fenetre();
  etat.faits = etat.faits || {};
  const visibles = () => etapes.filter((e) => !e.saute || !e.saute(etat));
  let i = Math.min(Math.max(0, Number(etat.etape) || 0), visibles().length - 1);
  let termine = false;
  d.querySelector('#pc-titre').textContent = titre;
  const corps = d.querySelector('.pc-corps');
  const erreur = d.querySelector('.pc-erreur');
  const suivant = d.querySelector('.pc-suivant');
  const retour = d.querySelector('.pc-retour');

  function afficher() {
    const liste = visibles();
    const e = liste[i];
    erreur.hidden = true;
    d.querySelector('.pc-etapes').replaceChildren(...liste.map((x, n) => el('li', {
      class: n < i ? 'fait' : n === i ? 'actuelle' : '',
      title: x.titre,
    }, el('span', {}, n < i ? '✓' : String(n + 1)), el('em', {}, x.titre))));
    const cases = ((typeof e.cases === 'function' ? e.cases(etat) : e.cases) || []).map((texte) => el('label', { class: 'pc-case' },
      el('input', { type: 'checkbox', checked: !!etat.faits[e.cle], onchange: majBouton }), el('span', {}, texte)));
    corps.replaceChildren(...[
      el('p', { class: 'pc-numero muted small' }, `Étape ${i + 1} sur ${liste.length}`),
      el('h3', {}, e.titre),
      e.texte ? el('p', { class: 'pc-texte' }, typeof e.texte === 'function' ? e.texte(etat) : e.texte) : null,
      e.apres ? null : el('div', { class: 'pc-contenu' }),
      cases.length ? el('div', { class: 'pc-cases' }, cases) : null,
      e.apres ? el('div', { class: 'pc-contenu pc-apres' }) : null,
    ].filter(Boolean));
    if (e.contenu) e.contenu(corps.querySelector('.pc-contenu'), etat, majBouton);
    retour.hidden = i === 0;
    suivant.textContent = e.bouton || (i === liste.length - 1 ? 'Terminer' : 'C\'est fait');
    majBouton();
    corps.scrollTop = 0;
  }

  function majBouton() {
    const e = visibles()[i];
    const coche = [...corps.querySelectorAll('.pc-case input')].every((c) => c.checked);
    suivant.disabled = !coche || (e.pret ? !e.pret(etat) : false);
  }

  retour.onclick = () => { i = Math.max(0, i - 1); afficher(); };
  suivant.onclick = async () => {
    const liste = visibles();
    const e = liste[i];
    suivant.disabled = true;
    const texteBouton = suivant.textContent;
    suivant.textContent = 'Un instant…';
    try {
      if (e.valider) await e.valider(etat);
      etat.faits[e.cle] = Date.now();
      const derniere = i === visibles().length - 1;
      etat.etape = derniere ? i : i + 1;
      if (derniere) etat.fini = Date.now();
      if (sauver) await sauver(etat);
      if (derniere) {
        termine = true;
        if (fin) fin(etat);
        d.close();
        return;
      }
      i += 1;
      afficher();
    } catch (err) {
      console.error(err);
      erreur.textContent = messageErreur(err);
      erreur.hidden = false;
      suivant.textContent = texteBouton;
      majBouton();
    }
  };

  afficher();
  d.showModal();
  return new Promise((ok) => d.addEventListener('close', () => ok(termine), { once: true }));
}

/** Ferme le parcours ouvert (l'avancement déjà sauvé est gardé). */
export function fermerParcours() {
  if (dialogue && dialogue.open) dialogue.close();
}
