// Largeur des écrans sur un petit téléphone (360 px) : aucun écran ne doit défiler de côté (bug du 27/10).
// Le contrôle lui-même est fait à chaque écran atteint (gestes.attendreVue), dans tous les scénarios (390 px).

const test = require('node:test');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

test('360 px : connexion, installation, accueil, chaque page et chaque onglet tiennent dans l\'écran', async () => {
  const t = await banc.telephone('Petit', { largeur: 360, hauteur: 740 });
  // Valeurs longues exprès : adresse e-mail, prénom et nom de la mamie.
  await g.familleInstallee(t, {
    email: 'jean-christophe.dupont-lefebvre@exemple-tres-long.fr',
    prenom: 'Jean-Christophe',
    nom: 'Mamie Marie-Thérèse de la Rochefoucauld',
  });
  await g.attendreVue(t, 'view-home');
  for (const pageNom of ['photos', 'messages', 'videos', 'agenda', 'invite', 'settings']) {
    if (!(await t.page.locator(`.tile[data-page="${pageNom}"]`).isVisible())) continue;
    await g.ouvrirTuile(t, pageNom);
    await t.page.click(`#view-${pageNom} .page-head .back`);
    await g.attendreVue(t, 'view-home');
  }
  for (const onglet of ['notifs', 'profile', 'support']) {
    if (!(await t.page.locator(`.nav-item[data-tab="${onglet}"]`).isVisible())) continue;
    await t.page.click(`.nav-item[data-tab="${onglet}"]`);
    await t.page.waitForTimeout(400);
    await g.verifierLargeur(t, onglet);
  }
});
