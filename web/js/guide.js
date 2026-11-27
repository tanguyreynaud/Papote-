// Premier lancement : trois écrans courts pour un nouveau membre (une seule fois par téléphone).
import { deOuD } from './ui.js';
const KEY = 'papote.guideVu';

// enRoute : famille préparée à la commande, tablette pas encore arrivée (A43) : rien n'est promis « tout de suite ».
const STEPS = [
  { icon: 'photo', title: 'Envoyer une photo', text: (n, enRoute) => (enRoute
    ? `Touchez « Envoyer une photo », en haut de l'accueil. ${n} la verra sur sa tablette dès son arrivée.`
    : `Touchez « Envoyer une photo », en haut de l'accueil. ${n} la voit tout de suite sur sa tablette.`) },
  { icon: 'message', title: 'Écrire un message', text: (n) => `Touchez « Messages », écrivez en bas et envoyez. Les réponses ${deOuD(n)}${n} s'affichent ici.` },
  { icon: 'call', title: 'Appeler en vidéo', text: (n) => `Touchez « Appel vidéo » : la tablette ${deOuD(n)}${n} sonne et l'image s'affiche en grand.` },
];

// Déjà vu : les réglages de la tablette ont été la fenêtre de démarrage (une seule à la fois, V8 du 17/11).
export function guideVu() {
  try { localStorage.setItem(KEY, '1'); } catch (e) { /* rien */ }
}

function seen() {
  try { return localStorage.getItem(KEY) === '1'; } catch (e) { return true; }
}

export function showGuideOnce(name, { enRoute = false } = {}) {
  if (seen()) return;
  let i = 0;
  const back = document.createElement('div');
  back.className = 'guide-back';
  back.innerHTML = `<div class="guide" role="dialog" aria-modal="true">
      <span class="guide-icon"><svg><use href=""/></svg></span>
      <h2></h2><p></p>
      <div class="guide-dots">${STEPS.map(() => '<span></span>').join('')}</div>
      <div class="guide-buttons">
        <button type="button" class="secondary guide-skip">Passer</button>
        <button type="button" class="primary guide-next"></button>
      </div>
    </div>`;
  const render = () => {
    const step = STEPS[i];
    back.querySelector('use').setAttribute('href', `#i-${step.icon}`);
    back.querySelector('h2').textContent = step.title;
    back.querySelector('p').textContent = step.text(name, enRoute);
    back.querySelectorAll('.guide-dots span').forEach((d, k) => d.classList.toggle('on', k === i));
    back.querySelector('.guide-next').textContent = i === STEPS.length - 1 ? "C'est parti" : 'Suivant';
    // Dernière étape : « Passer » s'efface et « C'est parti » prend toute la largeur (Tanguy, 27/11 : seul à droite).
    back.querySelector('.guide-skip').hidden = i === STEPS.length - 1;
  };
  const close = () => { guideVu(); back.remove(); };
  back.querySelector('.guide-next').addEventListener('click', () => {
    if (i === STEPS.length - 1) close();
    else { i++; render(); }
  });
  back.querySelector('.guide-skip').addEventListener('click', close);
  render();
  document.body.append(back);
}
