// Clavier du téléphone ouvert : classe .clavier-ouvert sur <html> (famille.css cache alors la barre du bas et
// « Installer l'app »). Chargé par l'appli famille (famille.js) et l'admin (admin.js), qui ont tous deux cette barre :
// avant, l'admin n'avait pas la règle et la barre cachait les boutons au-dessus du clavier (galerie, 11/11).
//
// Clavier ouvert = un champ à remplir a la main ET la page a rétréci (interactive-widget=resizes-content).
// Le seul :focus ne suffit pas : refermé par le bouton retour d'Android, le clavier part mais le champ garde
// la main, et la barre du bas restait cachée (Tanguy, 11/11). Classe .clavier-ouvert sur <html> (famille.css).
const hauteurSansClavier = {};
const CHAMP_A_CLAVIER = 'input:not([type=checkbox], [type=radio], [type=range], [type=file], [type=button], [type=submit]), textarea, [contenteditable=""], [contenteditable="true"]';
function majClavier() {
  const sens = innerWidth > innerHeight ? 'paysage' : 'portrait';
  hauteurSansClavier[sens] = Math.max(hauteurSansClavier[sens] || 0, innerHeight);
  const champ = document.activeElement && document.activeElement.matches && document.activeElement.matches(CHAMP_A_CLAVIER);
  document.documentElement.classList.toggle('clavier-ouvert', !!champ && innerHeight < hauteurSansClavier[sens] - 120);
}
for (const evenement of ['resize', 'focusin', 'focusout']) addEventListener(evenement, () => setTimeout(majClavier, 0));
majClavier();
