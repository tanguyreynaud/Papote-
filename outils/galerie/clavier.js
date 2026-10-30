// Clavier du téléphone ouvert : pour chaque champ à remplir visible à l'écran, on le touche, puis on réduit
// la hauteur de l'écran de la place du clavier (Chrome Android avec interactive-widget=resizes-content, posé
// dans les pages : le clavier rétrécit la page au lieu de la recouvrir). On vérifie alors :
//   - que le champ garde la main (l'écran ne s'est pas fermé) et reste visible, sans rien par-dessus ;
//   - que le bouton qui l'envoie (Envoyer, Continuer…) se voit, ou se trouve en faisant défiler, sans rien par-dessus ;
//   - que la page ne devient pas plus large que l'écran.
// C'est une simulation : un vrai clavier Android ou iPhone reste à essayer sur le téléphone.
'use strict';

// Place du clavier Gboard sur un Pixel en portrait, suggestions comprises (CSS px).
const CLAVIER = 330;
// Paysage : le clavier prend plus de la moitié de l'écran.
const CLAVIER_PAYSAGE = 210;

// Champs qui ouvrent le clavier (pas les cases, curseurs, fichiers…).
const CHAMPS = 'input:not([type]), input[type=text], input[type=email], input[type=tel], input[type=number], input[type=search], input[type=password], input[type=url], textarea, [contenteditable=""], [contenteditable=true]';

// Champs visibles de l'écran (au plus 4 par écran : les autres se comportent comme eux).
async function champsVisibles(page) {
  return page.evaluate((sel) => {
    const vus = [...document.querySelectorAll(sel)].filter((el) => {
      if (el.disabled || el.readOnly) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) <= 0.05 || el.closest('[hidden]') !== null) return false;
      // Sous une fenêtre ou un écran posé par-dessus : on ne peut pas le toucher, rien à juger.
      el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      const b = el.getBoundingClientRect();
      const dessus = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return Boolean(dessus) && (dessus === el || el.contains(dessus) || dessus.contains(el) || (el.closest('label') !== null && dessus.closest('label') === el.closest('label')));
    });
    return vus.slice(0, 4).map((el, i) => {
      el.dataset.clavier = String(i);
      return el.id ? `#${el.id}` : (el.name ? `${el.tagName.toLowerCase()}[name="${el.name}"]` : `${el.tagName.toLowerCase()} ${i + 1}`);
    });
  }, CHAMPS);
}

// Ce qui se passe une fois le clavier ouvert sur le champ n° i (data-clavier) : liste de problèmes.
function examiner(i) {
  const el = document.querySelector(`[data-clavier="${i}"]`);
  const pb = [];
  if (!el) return ['le champ a disparu'];
  if (document.activeElement !== el) pb.push('le champ perd la main');
  const H = window.innerHeight;
  const W = document.documentElement.clientWidth;
  // Rien par-dessus l'élément (barre du bas, bandeau…) à son milieu et à ses bords haut et bas.
  const recouvert = (cible) => {
    const r = cible.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 1), W - 1);
    for (const y of [r.top + 4, r.top + r.height / 2, r.bottom - 4]) {
      if (y < 0 || y > H) return 'hors de l\'écran';
      const dessus = document.elementFromPoint(x, y);
      if (dessus && dessus !== cible && !cible.contains(dessus) && !dessus.contains(cible)) {
        const nom = dessus.id ? `#${dessus.id}` : (dessus.className && typeof dessus.className === 'string' ? `.${dessus.className.split(' ')[0]}` : dessus.tagName.toLowerCase());
        return `caché par ${nom}`;
      }
    }
    return '';
  };
  // Le navigateur amène le champ touché à l'écran.
  el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  if (r.bottom > H + 1 || r.top < -1) pb.push(`le champ sort de l'écran (bas à ${Math.round(r.bottom)} px pour ${H} px visibles)`);
  else {
    const c = recouvert(el);
    if (c) pb.push(`le champ est ${c}`);
  }
  // Bouton qui envoie : dans le même formulaire, la même feuille ou la même page.
  const boite = el.closest('form, dialog, [role=dialog], .sheet, .modal, .page, section, main') || document.body;
  const boutons = [...boite.querySelectorAll('button[type=submit], button.primary, .send-btn, button.btn-primary')]
    .filter((b) => !b.closest('[hidden]') && b.getBoundingClientRect().width > 0 && getComputedStyle(b).visibility !== 'hidden');
  const bouton = boutons.find((b) => (el.form && b.form === el.form)) || boutons[0];
  if (bouton) {
    bouton.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    const c = recouvert(bouton);
    if (c) pb.push(`le bouton « ${(bouton.textContent || '').trim().slice(0, 30)} » est ${c}, même en faisant défiler`);
    el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
  if (document.documentElement.scrollWidth > W + 1) pb.push(`la page devient plus large que l'écran (${document.documentElement.scrollWidth} px pour ${W})`);
  return pb;
}

// Vérifie les champs de l'écran affiché. Rend { problemes: [...], capture: bool } ; la capture « clavier ouvert »
// (premier champ, ou premier champ en défaut) est écrite dans fichier si l'écran a un champ.
async function verifier(page, taille, fichier) {
  // Menu ☰ ouvert : on le referme avant de taper dans la page, rien à juger ici.
  if (await page.locator('[aria-expanded="true"]').count().catch(() => 0)) return { problemes: [], capture: false };
  const champs = await champsVisibles(page).catch(() => []);
  if (!champs.length) return { problemes: [], capture: false };
  const paysage = taille.width > taille.height;
  const hClavier = taille.height - (paysage ? CLAVIER_PAYSAGE : CLAVIER);
  const problemes = [];
  let capture = null;
  for (let i = 0; i < champs.length; i++) {
    await page.setViewportSize({ width: taille.width, height: taille.height });
    await page.waitForTimeout(150);
    const loc = page.locator(`[data-clavier="${i}"]`);
    try {
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
      await loc.focus({ timeout: 2000 });
    } catch (e) {
      continue; // champ devenu inaccessible entre-temps (écran qui change) : rien à juger
    }
    await page.setViewportSize({ width: taille.width, height: hClavier });
    await page.waitForTimeout(400);
    const pb = await page.evaluate(examiner, i).catch((e) => [`vérification impossible (${e.message.split('\n')[0]})`]);
    for (const p of pb) problemes.push(`Clavier sur ${champs[i]} : ${p}`);
    if (capture === null || (pb.length && !capture.pb)) {
      await page.evaluate((j) => document.querySelector(`[data-clavier="${j}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'instant' }), i).catch(() => {});
      await page.screenshot({ path: fichier, type: 'jpeg', quality: 62 }).catch(() => {});
      capture = { pb: pb.length > 0 };
    }
  }
  await page.setViewportSize({ width: taille.width, height: taille.height });
  return { problemes, capture: capture !== null };
}

module.exports = { verifier, CLAVIER };
