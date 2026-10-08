// Premier lancement : trois écrans courts pour un nouveau membre (une seule fois par téléphone).
const KEY = 'papote.guideVu';

const STEPS = [
  { icon: 'photo', title: 'Envoyer une photo', text: (n) => `Touchez « Photos », puis le bouton + en bas. ${n} la voit tout de suite sur sa tablette.` },
  { icon: 'message', title: 'Écrire un message', text: (n) => `Touchez « Messages », écrivez en bas et envoyez. Les réponses de ${n} s'affichent ici.` },
  { icon: 'call', title: 'Appeler en vidéo', text: (n) => `Touchez « Appel vidéo » : la tablette de ${n} sonne et l'image s'affiche en grand.` },
];

function seen() {
  try { return localStorage.getItem(KEY) === '1'; } catch (e) { return true; }
}

export function showGuideOnce(name) {
  if (seen()) return;
  let i = 0;
  const back = document.createElement('div');
  back.className = 'guide-back';
  back.innerHTML = `<div class="guide" role="dialog" aria-modal="true">
      <span class="guide-icon"><svg><use href=""/></svg></span>
      <h2></h2><p></p>
      <div class="guide-dots">${STEPS.map(() => '<span></span>').join('')}</div>
      <div class="guide-buttons">
        <button type="button" class="link guide-skip">Passer</button>
        <button type="button" class="primary guide-next"></button>
      </div>
    </div>`;
  const render = () => {
    const step = STEPS[i];
    back.querySelector('use').setAttribute('href', `#i-${step.icon}`);
    back.querySelector('h2').textContent = step.title;
    back.querySelector('p').textContent = step.text(name);
    back.querySelectorAll('.guide-dots span').forEach((d, k) => d.classList.toggle('on', k === i));
    back.querySelector('.guide-next').textContent = i === STEPS.length - 1 ? "C'est parti" : 'Suivant';
    back.querySelector('.guide-skip').hidden = i === STEPS.length - 1;
  };
  const close = () => {
    try { localStorage.setItem(KEY, '1'); } catch (e) { /* rien */ }
    back.remove();
  };
  back.querySelector('.guide-next').addEventListener('click', () => {
    if (i === STEPS.length - 1) close();
    else { i++; render(); }
  });
  back.querySelector('.guide-skip').addEventListener('click', close);
  render();
  document.body.append(back);
}
