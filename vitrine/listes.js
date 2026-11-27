// Listes déroulantes, dates et heures au style Papote (Tanguy, 27/11 : la liste standard du téléphone « est super
// moche », « pourquoi ça n'affiche pas directement une liste déroulante ? », « tout doit passer au style Papote »).
// Chaque <select>, <input type="date">, <input type="time"> et <input type="month"> garde sa place dans la page et
// reste la source de vérité (valeur, min, évènements « input » et « change ») : il est seulement rendu invisible, et un
// bouton à sa place ouvre les choix juste sous lui (au-dessus s'il n'y a pas la place) : une liste, ou un calendrier.
// Rien d'autre ne change dans le code qui lit ou écrit le champ. Sans dépendance.
// SITE : copie exacte de web/js/listes.js de l'app (branche de l'app et de l'admin) ; à garder identique. Les styles
// du site sont dans commande.html.

const habilles = new WeakSet();
const CHEVRON = '<svg class="liste-papote-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const CALENDRIER = '<svg class="liste-papote-chevron fixe" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.500" rx="3"/><path d="M3.500 10h17M8 3v4M16 3v4"/></svg>';
const MARGE = 8; // entre le panneau et le bord de l'écran
const HAUT_MAX = 320;
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const deux = (n) => String(n).padStart(2, '0');
const cleJour = (d) => `${d.getFullYear()}-${deux(d.getMonth() + 1)}-${deux(d.getDate())}`;

function titreDe(champ) {
  const propre = (t) => (t || '').replace(/\s+/g, ' ').trim().replace(/\s*:$/, '');
  if (champ.getAttribute('aria-label')) return champ.getAttribute('aria-label');
  const pour = champ.id && document.querySelector(`label[for="${champ.id}"]`);
  if (pour) return propre(pour.textContent);
  const autour = champ.closest('label');
  if (autour) return propre([...autour.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' '));
  return champ.title || 'Choisir';
}

// ---------- Le panneau ancré sous son bouton (liste ou calendrier) ----------

let fermerOuvert = null; // un seul panneau ouvert à la fois

/** Pose le panneau sous le bouton et le referme au toucher ailleurs, à Échap, au défilement de la page, au retour. */
function poser(bouton, panneau, { largeMin = 140, hautMax = HAUT_MAX, plein = false } = {}) {
  if (fermerOuvert) fermerOuvert(false);
  // Dans une fenêtre <dialog> ouverte en modal, seul ce qui est dedans se voit et se touche.
  (bouton.closest('dialog[open]') || document.body).append(panneau);
  bouton.setAttribute('aria-expanded', 'true');
  bouton.classList.add('ouverte');
  const placer = () => {
    const r = bouton.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = document.documentElement.clientWidth;
    const large = Math.min(Math.max(r.width, largeMin), vw - 2 * MARGE);
    panneau.style.width = `${large}px`;
    panneau.style.maxHeight = '';
    const entier = panneau.scrollHeight + 2;
    const voulu = plein ? entier : Math.min(entier, hautMax);
    const dessous = vh - r.bottom - MARGE - 4;
    const dessus = r.top - MARGE - 4;
    // Une liste se contente de 180 px sous son champ (elle défile) ; un calendrier se montre en entier, du côté où il tient.
    const enBas = dessous >= (plein ? voulu : Math.min(voulu, 180)) || dessous >= dessus;
    const haut = Math.max(96, Math.min(voulu, enBas ? dessous : dessus));
    panneau.style.maxHeight = `${haut}px`;
    panneau.style.left = `${Math.max(MARGE, Math.min(r.left, vw - MARGE - large))}px`;
    panneau.style.top = enBas ? `${r.bottom + 4}px` : `${Math.max(MARGE, r.top - 4 - Math.min(haut, entier))}px`;
    panneau.classList.toggle('vers-le-haut', !enBas);
  };
  placer();
  const fermer = (rendreLaMain = true) => {
    if (fermerOuvert !== fermer) return;
    fermerOuvert = null;
    panneau.remove();
    bouton.setAttribute('aria-expanded', 'false');
    bouton.classList.remove('ouverte');
    document.removeEventListener('pointerdown', dehors, true);
    document.removeEventListener('keydown', echap, true);
    window.removeEventListener('scroll', defile, true);
    window.removeEventListener('resize', sansMain);
    window.removeEventListener('popstate', sansMain);
    if (rendreLaMain) bouton.focus({ preventScroll: true });
  };
  const sansMain = () => fermer(false);
  const dehors = (e) => {
    if (panneau.contains(e.target)) return;
    // Toucher le bouton referme (son clic ne rouvre pas) ; toucher ailleurs referme sans rien choisir.
    if (bouton.contains(e.target)) bouton.dataset.fermeAuDoigt = '1';
    fermer(false);
  };
  const defile = (e) => { if (!panneau.contains(e.target)) fermer(false); };
  const echap = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fermer(); } else if (e.key === 'Tab') fermer();
  };
  fermerOuvert = fermer;
  document.addEventListener('pointerdown', dehors, true);
  document.addEventListener('keydown', echap, true);
  window.addEventListener('scroll', defile, true);
  window.addEventListener('resize', sansMain);
  window.addEventListener('popstate', sansMain);
  return { fermer, placer };
}

/** Le clic du bouton : ouvre, sauf s'il vient de refermer son propre panneau. */
function auClic(bouton, champ, ouvrir) {
  bouton.addEventListener('click', () => {
    if (bouton.dataset.fermeAuDoigt) { delete bouton.dataset.fermeAuDoigt; return; }
    if (champ.disabled || bouton.classList.contains('ouverte')) return;
    ouvrir();
  });
}

/** Liste de choix sous le bouton : choix = [{ label, value }], actuel = la valeur en cours. */
function ouvrirListe(bouton, titre, choix, actuel, surChoix) {
  const menu = document.createElement('div');
  menu.className = 'liste-papote-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', titre);
  const lignes = choix.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'liste-papote-choix';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(c.value === actuel));
    b.textContent = c.label;
    b.addEventListener('click', () => { fermer(); surChoix(c.value); });
    menu.append(b);
    return b;
  });
  const { fermer } = poser(bouton, menu);
  const choisi = lignes.find((b) => b.getAttribute('aria-selected') === 'true');
  if (choisi) menu.scrollTop = choisi.offsetTop - (menu.clientHeight - choisi.offsetHeight) / 2;
  // Rien de choisi encore : la liste a la main (flèches du clavier), sans mettre son premier choix en avant.
  if (choisi) choisi.focus({ preventScroll: true }); else { menu.tabIndex = -1; menu.focus({ preventScroll: true }); }
  menu.addEventListener('keydown', (e) => {
    const sens = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!sens && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const ici = lignes.indexOf(document.activeElement);
    const vers = e.key === 'Home' ? 0 : e.key === 'End' ? lignes.length - 1 : Math.max(0, Math.min(lignes.length - 1, ici + sens));
    lignes[vers]?.focus();
  });
}

function nouveauBouton(icone = CHEVRON) {
  const bouton = document.createElement('button');
  bouton.type = 'button';
  bouton.className = 'liste-papote';
  bouton.setAttribute('aria-expanded', 'false');
  const texte = document.createElement('span');
  texte.className = 'liste-papote-texte';
  bouton.append(texte);
  bouton.insertAdjacentHTML('beforeend', icone);
  return { bouton, texte };
}

/** Le champ d'origine devient invisible ; son libellé et le code qui lui donnent la main la passent au bouton. */
function cacher(champ, bouton) {
  champ.addEventListener('focus', () => bouton.focus({ preventScroll: true }));
  champ.classList.add('liste-native');
  champ.tabIndex = -1;
  champ.setAttribute('aria-hidden', 'true');
}

/** Suit la valeur posée par le code (sans évènement) et les attributs qui changent l'affichage. */
function suivre(champ, proto, maj, attributs) {
  const VALEUR = Object.getOwnPropertyDescriptor(proto, 'value');
  Object.defineProperty(champ, 'value', { configurable: true, get() { return VALEUR.get.call(champ); }, set(v) { VALEUR.set.call(champ, v); maj(); } });
  champ.addEventListener('input', maj);
  champ.addEventListener('change', maj);
  champ.form?.addEventListener('reset', () => setTimeout(maj));
  new MutationObserver(maj).observe(champ, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: attributs });
  return VALEUR;
}

function prevenir(champ) {
  champ.dispatchEvent(new Event('input', { bubbles: true }));
  champ.dispatchEvent(new Event('change', { bubbles: true }));
}

// ---------- <select> ----------

function habillerListe(sel) {
  const RANG = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  const { bouton, texte } = nouveauBouton();
  bouton.setAttribute('aria-haspopup', 'listbox');
  const maj = () => {
    const o = sel.options[RANG.get.call(sel)] || sel.options[0];
    texte.textContent = o ? o.textContent : '';
    bouton.classList.toggle('vide', !o || o.value === '');
    bouton.disabled = sel.disabled;
    bouton.hidden = sel.hidden;
    bouton.setAttribute('aria-label', `${titreDe(sel)} : ${texte.textContent}`);
  };
  suivre(sel, HTMLSelectElement.prototype, maj, ['disabled', 'hidden', 'selected']);
  Object.defineProperty(sel, 'selectedIndex', { configurable: true, get() { return RANG.get.call(sel); }, set(v) { RANG.set.call(sel, v); maj(); } });
  auClic(bouton, sel, () => {
    const choix = [...sel.options].map((o, i) => ({ o, i })).filter(({ o }) => !o.disabled && !o.hidden && !(o.value === '' && sel.options.length > 1 && (sel.required || o.textContent.trim() === (sel.getAttribute('aria-label') || '') || /^(Choisi|Sélectionn)/.test(o.textContent.trim()))))
      .map(({ o, i }) => ({ label: o.textContent, value: i })); // le choix vide qui sert de libellé (« Jour », « Choisissez la ville ») n'est pas proposé
    ouvrirListe(bouton, titreDe(sel), choix, RANG.get.call(sel), (rang) => {
      if (rang === RANG.get.call(sel)) return;
      RANG.set.call(sel, rang);
      maj();
      prevenir(sel);
    });
  });
  // Les classes du <select> (« tablette », « sim »…) passent au bouton : les mêmes règles de taille s'appliquent.
  for (const c of sel.classList) bouton.classList.add(c);
  cacher(sel, bouton);
  sel.after(bouton);
  maj();
}

// ---------- <input type="date"> : un calendrier ----------

function habillerDate(champ) {
  const { bouton, texte } = nouveauBouton(CALENDRIER);
  bouton.classList.add('date-papote');
  bouton.setAttribute('aria-haspopup', 'dialog');
  const lire = () => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(VALEUR.get.call(champ));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const maj = () => {
    const d = lire();
    texte.textContent = d ? `${d.getDate() === 1 ? '1er' : d.getDate()} ${MOIS[d.getMonth()]} ${d.getFullYear()}` : (champ.dataset.vide || 'Choisir une date');
    bouton.classList.toggle('vide', !d);
    bouton.disabled = champ.disabled;
    bouton.hidden = champ.hidden;
    bouton.setAttribute('aria-label', `${titreDe(champ)} : ${texte.textContent}`);
  };
  const VALEUR = suivre(champ, HTMLInputElement.prototype, maj, ['disabled', 'hidden', 'min', 'max']);
  const poserValeur = (v) => {
    if (v === VALEUR.get.call(champ)) return;
    VALEUR.set.call(champ, v);
    maj();
    prevenir(champ);
  };
  auClic(bouton, champ, () => {
    const choisie = lire();
    const auj = new Date();
    let vue = new Date((choisie || (champ.min && champ.min > cleJour(auj) ? new Date(`${champ.min}T00:00`) : auj)).getTime());
    vue.setDate(1);
    const cal = document.createElement('div');
    cal.className = 'liste-papote-menu calendrier-papote';
    cal.setAttribute('role', 'dialog');
    cal.setAttribute('aria-label', titreDe(champ));
    const dessiner = () => {
      const an = vue.getFullYear();
      const mois = vue.getMonth();
      const hors = (cle) => (champ.min && cle < champ.min) || (champ.max && cle > champ.max);
      const finPrec = cleJour(new Date(an, mois, 0));
      const debutSuiv = cleJour(new Date(an, mois + 1, 1));
      let h = `<div class="cal-tete"><button type="button" class="cal-nav" data-pas="-1" aria-label="Mois précédent"${champ.min && finPrec < champ.min ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>`
        + `<p class="cal-mois" aria-live="polite">${MOIS[mois].charAt(0).toUpperCase()}${MOIS[mois].slice(1)} ${an}</p>`
        + `<button type="button" class="cal-nav" data-pas="1" aria-label="Mois suivant"${champ.max && debutSuiv > champ.max ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button></div>`
        + `<div class="cal-grille" role="grid"><span>lun</span><span>mar</span><span>mer</span><span>jeu</span><span>ven</span><span>sam</span><span>dim</span>`;
      const decalage = (new Date(an, mois, 1).getDay() + 6) % 7; // lundi d'abord
      const nb = new Date(an, mois + 1, 0).getDate();
      for (let i = 0; i < decalage; i++) h += '<i></i>';
      for (let j = 1; j <= nb; j++) {
        const cle = `${an}-${deux(mois + 1)}-${deux(j)}`;
        const cls = `${cle === cleJour(auj) ? ' auj' : ''}`;
        h += `<button type="button" class="cal-jour${cls}" data-jour="${cle}" aria-pressed="${choisie && cle === cleJour(choisie)}"${hors(cle) ? ' disabled' : ''}>${j}</button>`;
      }
      h += '</div>';
      const pied = [];
      if (!hors(cleJour(auj))) pied.push('<button type="button" class="cal-lien" data-jour="' + cleJour(auj) + '">Aujourd\'hui</button>');
      if (!champ.required && champ.dataset.obligatoire === undefined && choisie) pied.push('<button type="button" class="cal-lien" data-jour="">Effacer</button>');
      if (pied.length) h += `<div class="cal-pied">${pied.join('')}</div>`;
      cal.innerHTML = h;
    };
    dessiner();
    const { fermer, placer } = poser(bouton, cal, { largeMin: 296, plein: true });
    cal.addEventListener('click', (e) => {
      const nav = e.target.closest('.cal-nav');
      if (nav) {
        vue = new Date(vue.getFullYear(), vue.getMonth() + Number(nav.dataset.pas), 1);
        dessiner();
        placer();
        cal.querySelector(`.cal-nav[data-pas="${nav.dataset.pas}"]:not([disabled])`)?.focus({ preventScroll: true });
        return;
      }
      const jour = e.target.closest('[data-jour]');
      if (!jour) return;
      fermer();
      poserValeur(jour.dataset.jour);
    });
    (cal.querySelector('.cal-jour[aria-pressed="true"]') || cal.querySelector('.cal-jour.auj:not([disabled])') || cal.querySelector('.cal-jour:not([disabled])'))?.focus({ preventScroll: true });
  });
  cacher(champ, bouton);
  champ.after(bouton);
  maj();
}

// ---------- <input type="time"> et <input type="month"> : deux listes côte à côte ----------

function deuxListes(champ, classe, { lire, ecrire, gauche, droite }) {
  const bloc = document.createElement('span');
  bloc.className = `duo-papote ${classe}`;
  const a = nouveauBouton();
  const b = nouveauBouton();
  bloc.append(a.bouton, b.bouton);
  const maj = () => {
    const v = lire(VALEUR.get.call(champ));
    for (const [x, cote, i] of [[a, gauche, 0], [b, droite, 1]]) {
      x.texte.textContent = v ? cote.label(v[i]) : cote.vide;
      x.bouton.classList.toggle('vide', !v);
      x.bouton.disabled = champ.disabled;
      x.bouton.setAttribute('aria-label', `${titreDe(champ)}, ${cote.nom} : ${x.texte.textContent}`);
    }
    bloc.hidden = champ.hidden;
  };
  const VALEUR = suivre(champ, HTMLInputElement.prototype, maj, ['disabled', 'hidden']);
  [[a, gauche, 0], [b, droite, 1]].forEach(([x, cote, i]) => {
    x.bouton.setAttribute('aria-haspopup', 'listbox');
    auClic(x.bouton, champ, () => {
      const v = lire(VALEUR.get.call(champ));
      const choix = cote.choix(v).map((n) => ({ label: n === null ? cote.aucun : cote.label(n), value: n }));
      ouvrirListe(x.bouton, `${titreDe(champ)}, ${cote.nom}`, choix, v ? v[i] : undefined, (n) => {
        const suite = n === null ? '' : ecrire(i === 0 ? [n, v ? v[1] : droite.defaut()] : [v ? v[0] : gauche.defaut(), n]);
        if (suite === VALEUR.get.call(champ)) return;
        VALEUR.set.call(champ, suite);
        maj();
        prevenir(champ);
      });
    });
  });
  cacher(champ, a.bouton);
  champ.after(bloc);
  maj();
}

function habillerHeure(champ) {
  const pas = 5;
  deuxListes(champ, 'heure-papote', {
    lire: (v) => { const m = /^(\d{2}):(\d{2})/.exec(v); return m ? [Number(m[1]), Number(m[2])] : null; },
    ecrire: ([h, m]) => `${deux(h)}:${deux(m)}`,
    gauche: { nom: 'heure', vide: 'Heure', label: (h) => `${h} h`, choix: () => Array.from({ length: 24 }, (_, h) => h), defaut: () => 9 },
    droite: {
      nom: 'minutes', vide: 'Min', label: (m) => deux(m), defaut: () => 0,
      // De 5 en 5 ; une heure déjà enregistrée à la minute près (09:07) garde sa minute dans la liste.
      choix: (v) => [...new Set([...Array.from({ length: 60 / pas }, (_, i) => i * pas), ...(v ? [v[1]] : [])])].sort((x, y) => x - y),
    },
  });
}

function habillerMois(champ) {
  const an = new Date().getFullYear();
  deuxListes(champ, 'mois-papote', {
    lire: (v) => { const m = /^(\d{4})-(\d{2})$/.exec(v); return m ? [Number(m[2]), Number(m[1])] : null; },
    ecrire: ([m, a]) => `${a}-${deux(m)}`,
    gauche: {
      nom: 'mois', vide: 'Mois', aucun: 'Aucune date', label: (m) => MOIS[m - 1], defaut: () => new Date().getMonth() + 1,
      choix: (v) => [...(champ.required || !v ? [] : [null]), ...Array.from({ length: 12 }, (_, i) => i + 1)],
    },
    droite: {
      nom: 'année', vide: 'Année', label: (a) => String(a), defaut: () => an,
      choix: (v) => { const de = Math.min(an - 1, v ? v[1] : an); return Array.from({ length: Math.max(an + 10, v ? v[1] : an) - de + 1 }, (_, i) => de + i); },
    },
  });
}

// ---------- Tout habiller ----------

const QUOI = 'select, input[type="date"], input[type="time"], input[type="month"]';

function habiller(champ) {
  if (habilles.has(champ) || champ.multiple || champ.dataset.natif !== undefined) return;
  habilles.add(champ);
  if (champ.tagName === 'SELECT') habillerListe(champ);
  else if (champ.type === 'date') habillerDate(champ);
  else if (champ.type === 'time') habillerHeure(champ);
  else if (champ.type === 'month') habillerMois(champ);
}

/** Habille toutes les listes, dates et heures de la page, et celles qui arrivent ensuite (écrans construits à la demande). */
export function habillerLesListes(racine = document) {
  racine.querySelectorAll(QUOI).forEach(habiller);
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.matches(QUOI)) habiller(n);
      n.querySelectorAll?.(QUOI).forEach(habiller);
    }
  }).observe(document.body, { childList: true, subtree: true });
}
