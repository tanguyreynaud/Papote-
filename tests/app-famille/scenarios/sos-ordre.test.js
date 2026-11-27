// Ordre d'appel du SOS (Tanguy, 18/11) : dans Réglages, carte « Ordre d'appel SOS », réservée aux responsables. Les
// proches qui ont un portable, dans l'ordre où la tablette les appelle ; flèches ↑/↓ (jamais de glisser), un double
// appui ne déplace qu'une fois, Enregistrer en double appui n'écrit qu'une fois (families/{fid}.sosOrdre + rev), l'ordre
// revient après actualisation, un proche arrivé après est appelé en dernier, « Revenir à l'ordre par défaut » efface
// le choix. Un proche qui n'est pas responsable ne voit pas la carte (les règles refusent aussi : tests/regles).

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

const CARTE = '#sos-ordre-card';
const lignes = (t) => t.page.locator('#sos-ordre-liste .sos-ordre-prenom').allInnerTexts();
// Position du bouton dans la page (pas à l'écran : le doigt fait défiler jusqu'à la flèche).
const hautDansLaPage = (t, sel) => t.page.locator(sel).evaluate((e) => Math.round(e.getBoundingClientRect().top + window.scrollY));
// La ligne dit « Activé · Julie, Léa, Paul » : l'ordre d'appel.
const resume = async (t) => { const m = /^Activé · (.+)$/.exec((await t.page.locator('#sos-ordre-value').innerText()).trim()); return m ? m[1].split(', ') : []; };
const fleche = (t, prenom, sens) => `#sos-ordre-liste li:has(.sos-ordre-prenom:text-is("${prenom}")) .${sens}`;

async function modifier(t) {
  await t.page.click(`${CARTE} .setting-modify`);
  await t.page.locator(`${CARTE} .setting-edit`).waitFor({ state: 'visible' });
}

async function attendreResume(t, attendu, message) {
  const debut = Date.now();
  let vu = [];
  while (Date.now() - debut < 15_000) {
    vu = await resume(t);
    if (JSON.stringify(vu) === JSON.stringify(attendu)) return;
    await t.page.waitForTimeout(150);
  }
  assert.deepStrictEqual(vu, attendu, message);
}

test('Ordre d\'appel SOS : ↑/↓, double appui, enregistré, relu après actualisation, nouveau proche en dernier, ordre par défaut ; caché pour un proche', async () => {
  const julie = await banc.telephone('Julie');
  const paul = await banc.telephone('Paul');
  const lea = await banc.telephone('Léa');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const uidPaul = await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });
  const uidLea = await g.rejoindre(julie, fid, lea, { email: 'lea@exemple.fr', prenom: 'Léa', genre: 'femme' });
  const uidJulie = (await g.lire(`families/${fid}`)).createdBy;
  await g.attendreBase(async () => (await g.liste(`families/${fid}/members`)).filter((m) => m.role === 'famille' && m.telephone).length === 3,
    'les trois numéros enregistrés');

  // Par défaut : la responsable (Julie) d'abord, puis les prénoms par ordre alphabétique.
  await g.ouvrirTuile(julie, 'settings');
  await julie.page.locator(CARTE).waitFor({ state: 'visible' });
  assert.strictEqual(await julie.page.locator(`${CARTE} h2`).innerText(), 'SOS famille');
  await attendreResume(julie, ['Julie', 'Léa', 'Paul'], 'ordre par défaut');
  await julie.page.locator('#sos-ordre-value', { hasText: 'Activé · Julie' }).waitFor();

  await modifier(julie);
  assert.deepStrictEqual(await lignes(julie), ['Julie', 'Léa', 'Paul']);
  // Même taille pour toutes les flèches ; la première ne monte pas, la dernière ne descend pas.
  const tailles = await julie.page.locator('#sos-ordre-liste .sos-ordre-btn').evaluateAll((bs) => bs.map((b) => `${b.offsetWidth}x${b.offsetHeight}`));
  assert.strictEqual(new Set(tailles).size, 1, `flèches de tailles différentes : ${tailles}`);
  assert.ok(parseInt(tailles[0], 10) >= 48, `flèches trop petites : ${tailles[0]}`);
  assert.strictEqual(await julie.page.locator(fleche(julie, 'Julie', 'monter')).isDisabled(), true);
  assert.strictEqual(await julie.page.locator(fleche(julie, 'Paul', 'descendre')).isDisabled(), true);

  // Rien ne bouge sous le doigt : les boutons du bas restent à leur place quand le mot apparaît.
  const avant = await hautDansLaPage(julie, `${CARTE} button[type=submit]`);

  // Double appui sur ↑ de Paul : il monte d'une place seulement (le 2e appui ne fait pas monter Léa, arrivée dessous).
  await g.doubleAppui(julie, fleche(julie, 'Paul', 'monter'));
  await julie.page.waitForTimeout(300);
  assert.deepStrictEqual(await lignes(julie), ['Julie', 'Paul', 'Léa'], 'un seul déplacement au double appui');
  await julie.page.locator('#sos-ordre-liste li.vient-de-bouger .sos-ordre-prenom', { hasText: 'Paul' }).waitFor();
  await julie.page.locator('#sos-ordre-annonce', { hasText: 'Paul passe en n° 2' }).waitFor();
  assert.strictEqual(await hautDansLaPage(julie, `${CARTE} button[type=submit]`), avant, 'Enregistrer n\'a pas bougé');
  // Rien d'écrit avant Enregistrer.
  assert.strictEqual((await g.lire(`families/${fid}`)).sosOrdre, undefined);

  // Un appui de plus, un peu après : Paul en tête.
  await julie.page.waitForTimeout(600);
  await julie.page.click(fleche(julie, 'Paul', 'monter'));
  assert.deepStrictEqual(await lignes(julie), ['Paul', 'Julie', 'Léa']);
  await julie.page.locator('#sos-ordre-annonce', { hasText: 'Paul passe en n° 1' }).waitFor();
  assert.strictEqual(await julie.page.locator(fleche(julie, 'Paul', 'monter')).isDisabled(), true);

  // Enregistrer en double appui : une seule écriture (rev + 1), l'ordre des uid.
  const rev = (await g.lire(`families/${fid}`)).rev || 0;
  await g.doubleAppui(julie, `${CARTE} .setting-edit button[type=submit]`);
  await g.toast(julie, 'Ordre d\'appel SOS envoyé à la tablette');
  await g.attendreBase(async () => Array.isArray((await g.lire(`families/${fid}`)).sosOrdre), 'ordre enregistré');
  await julie.page.waitForTimeout(1000);
  const fam = await g.lire(`families/${fid}`);
  assert.deepStrictEqual(fam.sosOrdre, [uidPaul, uidJulie, uidLea]);
  assert.strictEqual(fam.rev, rev + 1, 'une seule écriture');
  await julie.page.locator(`${CARTE} .setting-edit`).waitFor({ state: 'hidden' });
  await attendreResume(julie, ['Paul', 'Julie', 'Léa'], 'résumé après Enregistrer');
  await julie.page.locator('#sos-ordre-value', { hasText: 'Activé · ' }).waitFor();

  // Page rechargée : l'ordre enregistré revient, dans le résumé et dans la liste à modifier.
  await julie.page.reload();
  await g.attendreVue(julie, 'view-home', 30_000);
  await g.ouvrirTuile(julie, 'settings');
  await attendreResume(julie, ['Paul', 'Julie', 'Léa'], 'ordre relu après actualisation');
  await modifier(julie);
  assert.deepStrictEqual(await lignes(julie), ['Paul', 'Julie', 'Léa']);
  await julie.page.click(`${CARTE} .setting-cancel`);

  // Paul n'est pas responsable : pas de carte.
  await g.ouvrirFamille(paul);
  await paul.page.locator('#tablet-owner-note').waitFor({ state: 'visible' });
  assert.strictEqual(await paul.page.locator(CARTE).isVisible(), false, 'carte cachée pour un proche');

  // Marc arrive après : appelé en dernier, sans rien changer à l'ordre choisi.
  await g.retourAccueil(julie); // Réglages : plus de flèche, la barre du bas (23/11)
  await g.attendreVue(julie, 'view-home');
  const marc = await banc.telephone('Marc');
  const uidMarc = await g.rejoindre(julie, fid, marc, { email: 'marc@exemple.fr', prenom: 'Marc' });
  await g.attendreBase(async () => (await g.lire(`families/${fid}/members/${uidMarc}`)).telephone, 'numéro de Marc');
  await g.ouvrirTuile(julie, 'settings');
  await attendreResume(julie, ['Paul', 'Julie', 'Léa', 'Marc'], 'Marc en dernier');
  await modifier(julie);
  assert.deepStrictEqual(await lignes(julie), ['Paul', 'Julie', 'Léa', 'Marc']);

  // Revenir à l'ordre par défaut : la liste se remet (responsable d'abord, puis l'alphabet), enregistré = effacé.
  await julie.page.click('#sos-ordre-defaut');
  assert.deepStrictEqual(await lignes(julie), ['Julie', 'Léa', 'Marc', 'Paul']);
  await julie.page.locator('#sos-ordre-annonce', { hasText: 'Ordre par défaut remis' }).waitFor();
  await julie.page.click(`${CARTE} .setting-edit button[type=submit]`);
  await g.toast(julie, 'Ordre par défaut envoyé à la tablette');
  await g.attendreBase(async () => !('sosOrdre' in (await g.lire(`families/${fid}`))), 'ordre effacé');
  await attendreResume(julie, ['Julie', 'Léa', 'Marc', 'Paul'], 'ordre par défaut après Enregistrer');
});

// Tanguy, 27/11 : deux proches au même prénom ne se distinguaient pas dans l'ordre d'appel. Chaque ligne montre la photo
// (ou l'initiale) ; les homonymes ont en plus la fin de leur numéro.
test('Ordre d\'appel SOS : photo ou initiale sur chaque ligne ; deux « Paul » se distinguent par la fin du numéro', async () => {
  const julie = await banc.telephone('Julie');
  const paul = await banc.telephone('Paul');
  const pol = await banc.telephone('Pol');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const uidPaul = await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });
  const uidPol = await g.rejoindre(julie, fid, pol, { email: 'pol@exemple.fr', prenom: 'Pol' });
  await g.attendreBase(async () => (await g.liste(`families/${fid}/members`)).filter((m) => m.role === 'famille' && m.telephone).length === 3,
    'les trois numéros enregistrés');
  // Le second s'appelle Paul lui aussi, et a une photo.
  const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=';
  await banc.s.db.doc(`families/${fid}/members/${uidPaul}`).update({ face: null });
  await banc.s.db.doc(`families/${fid}/members/${uidPol}`).update({ name: 'Paul', face: PHOTO });
  const telDe = async (uid) => (await g.lire(`families/${fid}/members/${uid}`)).telephone.replace(/\s/g, '');
  const fin = (tel) => `·· ${tel.slice(6, 8)} ${tel.slice(8)}`;

  await g.ouvrirTuile(julie, 'settings');
  await julie.page.locator('#sos-ordre-value', { hasText: 'Paul, Paul' }).waitFor();
  await modifier(julie);
  if (process.env.CAPTURE) { await julie.page.waitForTimeout(5000); await julie.page.locator('#sos-ordre-card').screenshot({ path: process.env.CAPTURE }); }
  const vues = await julie.page.locator('#sos-ordre-liste li').evaluateAll((lis) => lis.map((li) => ({
    uid: li.dataset.uid, prenom: li.querySelector('.sos-ordre-prenom').textContent,
    tete: li.querySelector('.sos-ordre-tete').tagName === 'IMG' ? 'photo' : li.querySelector('.sos-ordre-tete').textContent,
    fin: li.querySelector('.sos-ordre-role')?.textContent || '',
    large: li.scrollWidth <= li.clientWidth,
  })));
  const de = (uid) => vues.find((v) => v.uid === uid);
  assert.deepStrictEqual(vues.map((v) => v.prenom), ['Julie', 'Paul', 'Paul']);
  assert.strictEqual(vues[0].fin, '', 'pas de numéro quand le prénom est seul');
  assert.strictEqual(de(uidPaul).tete, 'P');
  assert.strictEqual(de(uidPol).tete, 'photo');
  assert.strictEqual(de(uidPaul).fin, fin(await telDe(uidPaul)));
  assert.strictEqual(de(uidPol).fin, fin(await telDe(uidPol)));
  assert.ok(vues.every((v) => v.large), 'aucune ligne ne déborde');
});
