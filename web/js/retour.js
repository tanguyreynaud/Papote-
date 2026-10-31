// Aucun bouton sans retour (Tanguy, 30/10 : « l'utilisateur doit toujours savoir si ça charge, si le bouton a été
// appuyé »). Chargé avant tout le reste de l'app et de l'admin : tout bouton dont l'action prend du temps (appel au
// serveur, envoi…) montre une petite roue à la place de son texte et ne se touche plus, jusqu'à la fin de l'action.
// Une seule règle pour toute l'app, même pour un bouton ajouté plus tard. L'action garde son message de fin
// (réussite ou erreur) ; un bouton qui gère déjà son attente (désactivé, aria-busy, « Un instant… ») est laissé tel quel.
// Tant que l'action dure, les clics suivants sur le même bouton sont ignorés : un double clic n'appelle rien deux fois.
// Vérifié par la galerie : node galerie.js --boutons (outils/galerie/boutons.js).

const ATTENTE = 120; // ms : une action plus rapide ne fait pas clignoter de roue
const MAX = 60_000; // une action qui ne finit jamais (caméra ouverte…) ne bloque pas le bouton pour toujours

const style = document.createElement('style');
style.textContent = '[data-retour]{position:relative;pointer-events:none;color:transparent !important}'
  + '[data-retour] *{visibility:hidden}'
  + '[data-retour]::after{content:"";position:absolute;inset:0;margin:auto;width:18px;height:18px;box-sizing:border-box;border-radius:50%;'
  + 'border:2.5px solid color-mix(in srgb,var(--retour,#4f46e5) 28%,transparent);border-top-color:var(--retour,#4f46e5);animation:retour-roue .8s linear infinite}'
  + '@keyframes retour-roue{to{transform:rotate(360deg)}}'
  + '@media (prefers-reduced-motion:reduce){[data-retour]::after{animation-duration:2.4s}}';
document.head.append(style);

// Un bouton dont l'action est en cours ne se touche plus : le 2e clic d'un double clic (avant même la roue, qui attend
// 120 ms) est ignoré, pour qu'aucune action ne parte deux fois (Tanguy, 30/10 ; vérifié par node galerie.js --double).
const occupes = new WeakMap(); // bouton → événement qui l'a occupé

// Une fenêtre est ouverte (confirmation, choix) : c'est elle, le retour ; la roue attend qu'elle se ferme.
const fenetreOuverte = () => Boolean(document.querySelector('.dialog-back:not(.closing), dialog[open]'));

function boutonDe(e, ecouteur) {
  if (e.type === 'submit') return e.submitter || e.target.querySelector?.('button[type=submit], button:not([type])') || null;
  const b = e.target?.closest?.('button, [role=button], input[type=submit], input[type=button]');
  return b && (ecouteur === b || ecouteur?.contains?.(b) || ecouteur === document || ecouteur === window) ? b : null;
}

function occuper(b, promesse, evenement) {
  if (occupes.has(b)) return;
  occupes.set(b, evenement);
  let fini = false;
  let pose = false;
  const gereDeja = () => b.disabled || b.getAttribute('aria-busy') === 'true' || b.classList.contains('charge');
  const texte = b.textContent;
  const poser = () => {
    if (fini || pose || !b.isConnected || b.hidden || !b.getClientRects().length || fenetreOuverte()) return;
    // L'action a changé le bouton elle-même (texte, état) : elle montre déjà quelque chose.
    if (gereDeja() || b.textContent !== texte) return;
    b.style.setProperty('--retour', getComputedStyle(b).color);
    b.dataset.retour = '';
    b.setAttribute('aria-busy', 'true');
    pose = true;
  };
  const enlever = () => {
    if (!pose) return;
    delete b.dataset.retour;
    b.removeAttribute('aria-busy');
    b.style.removeProperty('--retour');
    pose = false;
  };
  const suivi = setInterval(() => { if (fenetreOuverte()) enlever(); else poser(); }, 150);
  const debut = setTimeout(poser, ATTENTE);
  const fin = () => { fini = true; occupes.delete(b); clearInterval(suivi); clearTimeout(debut); clearTimeout(limite); enlever(); };
  const limite = setTimeout(fin, MAX);
  promesse.then(fin, fin);
}

// Tous les écouteurs « click » et « submit » : si l'action rend une promesse (fonction async), le bouton touché
// montre l'attente. Les autres écouteurs ne changent pas.
const proto = EventTarget.prototype;
const ajouter = proto.addEventListener;
const retirer = proto.removeEventListener;
const enveloppes = new WeakMap();
proto.addEventListener = function (type, ecouteur, options) {
  if ((type !== 'click' && type !== 'submit') || typeof ecouteur !== 'function') return ajouter.call(this, type, ecouteur, options);
  let env = enveloppes.get(ecouteur);
  if (!env) {
    env = function (e) {
      const b = boutonDe(e, this);
      // Un envoi par requestSubmit() (message rapide) n'a pas de bouton touché : il n'est jamais bloqué.
      const enCours = b && (e.type !== 'submit' || e.submitter) && occupes.get(b);
      if (enCours && enCours !== e) { e.preventDefault(); e.stopImmediatePropagation(); return undefined; }
      const r = ecouteur.apply(this, arguments);
      if (b && r && typeof r.then === 'function') occuper(b, r, e);
      return r;
    };
    enveloppes.set(ecouteur, env);
  }
  return ajouter.call(this, type, env, options);
};
proto.removeEventListener = function (type, ecouteur, options) {
  const env = (type === 'click' || type === 'submit') && typeof ecouteur === 'function' ? enveloppes.get(ecouteur) : null;
  return retirer.call(this, type, env || ecouteur, options);
};
