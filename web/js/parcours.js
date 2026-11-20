// Parcours pas à pas de l'espace admin (envoi d'une commande, réception d'une tablette ou d'accessoires) :
// une étape par écran, des cases à cocher, et « C'est fait » seulement quand tout est coché.
// Chaque étape : { cle, titre, texte, cases: [texte], contenu(zone, etat, rafraichir), pret(etat),
//   valider(etat) (async, peut lever une erreur affichée), bouton, saute(etat), apres (contenu sous les cases),
//   plusTard (étape sans risque : « Plus tard » la remet, elle revient d'office juste avant la dernière étape) }.
// L'avancement est rendu à sauver(etat) après chaque étape : on peut fermer et reprendre plus tard.

import { messageErreur } from './gestion-api.js';
import { boutonCharge } from './dialogue.js';

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
      el('button', { type: 'button', class: 'secondary pc-retour' }, '‹ Précédente'),
      el('button', { type: 'button', class: 'link pc-plus-tard' }, 'Plus tard'),
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
  // Étapes remises à plus tard : celles marquées plusTard, avant la dernière, pas encore faites. Rien d'autre à
  // retenir : etat.faits suffit. La dernière étape (colis déposé, tablette remise) ne s'ouvre qu'une fois tout fait.
  const remises = (liste) => liste.map((x, n) => n).filter((n) => n < liste.length - 1 && liste[n].plusTard && !etat.faits[liste[n].cle]);
  let rattrapage = false;
  const apres = (liste) => {
    const fin = liste.length - 1;
    let n = rattrapage ? fin : Math.min(i + 1, fin);
    const r = remises(liste).filter((x) => x !== i || etat.faits[liste[i].cle]);
    if (n === fin && r.length) { rattrapage = true; n = r[0]; } else if (n === fin) rattrapage = false;
    return n;
  };
  if (i === visibles().length - 1 && remises(visibles()).length) { rattrapage = true; [i] = remises(visibles()); }
  d.querySelector('#pc-titre').textContent = titre;
  const corps = d.querySelector('.pc-corps');
  const erreur = d.querySelector('.pc-erreur');
  const suivant = d.querySelector('.pc-suivant');
  const retour = d.querySelector('.pc-retour');
  const plusTard = d.querySelector('.pc-plus-tard');

  function afficher() {
    const liste = visibles();
    const e = liste[i];
    erreur.hidden = true;
    const attente = remises(liste);
    const dernierVu = rattrapage ? liste.length - 1 : i;
    // Liste des étapes, noms en entier, rangées par groupe (« Tablette et carte SIM », « Le colis »…) quand il y en a.
    d.querySelector('.pc-etapes').replaceChildren(...liste.flatMap((x, n) => [
      x.groupe && (n === 0 || liste[n - 1].groupe !== x.groupe) ? el('li', { class: 'pc-groupe', 'aria-hidden': 'true' }, x.groupe) : null,
      el('li', { class: n === i ? 'actuelle' : attente.includes(n) && n < dernierVu ? 'remise' : n < dernierVu ? 'fait' : '', 'aria-current': n === i ? 'step' : null },
        el('span', {}, n === i ? String(n + 1) : attente.includes(n) && n < dernierVu ? '…' : n < dernierVu ? '✓' : String(n + 1)),
        el('em', {}, x.titre, attente.includes(n) && n < dernierVu && n !== i ? el('small', { class: 'muted' }, ' · plus tard') : null)),
    ]).filter(Boolean));
    d.classList.remove('etapes-ouvertes');
    const cases = ((typeof e.cases === 'function' ? e.cases(etat) : e.cases) || []).map((texte) => el('label', { class: 'pc-case' },
      el('input', { type: 'checkbox', checked: !!etat.faits[e.cle], onchange: majBouton }), el('span', {}, texte)));
    corps.replaceChildren(...[
      el('div', { class: 'pc-ou' },
        el('p', { class: 'pc-numero muted small' }, `Étape ${i + 1} sur ${liste.length}${e.groupe ? ` · ${e.groupe}` : ''}`),
        // Téléphone : la liste des étapes est repliée, ce lien la montre.
        el('button', { type: 'button', class: 'link pc-voir', onclick: () => d.classList.toggle('etapes-ouvertes') }, 'Voir les étapes')),
      el('div', { class: 'pc-barre', 'aria-hidden': 'true' }, liste.map((x, n) => el('i', { class: n === i ? 'actuelle' : attente.includes(n) ? '' : n < dernierVu ? 'fait' : '' }))),
      el('h3', {}, e.titre),
      rattrapage ? el('p', { class: 'pc-remise small' }, 'Vous aviez remis cette étape à plus tard. Elle est à faire avant de terminer.') : null,
      e.texte ? el('p', { class: 'pc-texte' }, typeof e.texte === 'function' ? e.texte(etat) : e.texte) : null,
      e.apres ? null : el('div', { class: 'pc-contenu' }),
      cases.length ? el('div', { class: 'pc-cases' }, cases) : null,
      e.apres ? el('div', { class: 'pc-contenu pc-apres' }) : null,
    ].filter(Boolean));
    if (e.contenu) e.contenu(corps.querySelector('.pc-contenu'), etat, majBouton);
    retour.hidden = i === 0;
    plusTard.hidden = !e.plusTard || rattrapage || i === liste.length - 1 || !!etat.faits[e.cle];
    suivant.textContent = e.bouton || (i === liste.length - 1 ? 'Terminer' : 'C\'est fait');
    majBouton();
    corps.scrollTop = 0;
  }

  function majBouton() {
    const e = visibles()[i];
    boutonCharge(suivant, false);
    const coche = [...corps.querySelectorAll('.pc-case input[type=checkbox]')].every((c) => c.checked);
    suivant.disabled = !coche || (e.pret ? !e.pret(etat) : false);
  }

  retour.onclick = () => { i = Math.max(0, i - 1); afficher(); };
  suivant.onclick = async () => {
    const liste = visibles();
    const e = liste[i];
    suivant.disabled = true;
    boutonCharge(suivant, true);
    try {
      if (e.valider) await e.valider(etat);
      etat.faits[e.cle] = Date.now();
      const derniere = i === visibles().length - 1;
      const prochaine = derniere ? i : apres(visibles());
      etat.etape = prochaine;
      if (derniere) etat.fini = Date.now();
      if (sauver) await sauver(etat);
      if (derniere) {
        termine = true;
        if (fin) fin(etat);
        d.close();
        return;
      }
      i = prochaine;
      afficher();
    } catch (err) {
      console.error(err);
      erreur.textContent = messageErreur(err);
      erreur.hidden = false;
      majBouton();
    }
  };

  // « Plus tard » : on passe à la suite sans rien cocher ni valider ; l'étape reviendra avant la dernière.
  plusTard.onclick = async () => {
    const prochaine = apres(visibles());
    etat.etape = prochaine;
    i = prochaine;
    afficher();
    try { if (sauver) await sauver(etat); } catch (err) { console.error(err); }
  };

  afficher();
  d.showModal();
  return new Promise((ok) => d.addEventListener('close', () => ok(termine), { once: true }));
}

/** Ferme le parcours ouvert (l'avancement déjà sauvé est gardé). */
export function fermerParcours() {
  if (dialogue && dialogue.open) dialogue.close();
}
