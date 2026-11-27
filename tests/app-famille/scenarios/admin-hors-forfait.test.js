// « Hors-forfait bloqué chez l'opérateur » (Tanguy, 19/11) : case obligatoire sur chaque ligne SIM, non cochée sur les
// lignes d'avant. Par les vrais clics de l'admin, avec les vraies fonctions serveur : la case est sur la fiche de la
// carte, « Préparer l'envoi » s'arrête sur elle avec une phrase calme, le serveur refuse le départ, un double toucher
// n'écrit qu'une fois, et la case reste cochée après actualisation de la page.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');

const { s, acteurs: a } = banc;
const GSTATIC = 'https://www.gstatic.com/firebasejs/12.19.0/';
const PHRASE = /attend encore le blocage du hors-forfait sur sa ligne : activez-le dans l'espace client de l'opérateur, puis cochez la case\./;

banc.brancher();

async function ouvrirAdmin(nom, hash) {
  await banc.admin.auth().createUser({ uid: a.TANGUY.uid, email: a.TANGUY.email, emailVerified: true, displayName: 'Tanguy' }).catch(() => {});
  const jeton = await banc.admin.auth().createCustomToken(a.TANGUY.uid, { admin: true });
  const t = await banc.telephone(nom, { largeur: 1280, hauteur: 900 });
  await t.context.route('**/version.json', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await t.page.goto(`${banc.origine}/admin.html${hash}`);
  await t.page.evaluate(async ({ jeton: j, G }) => {
    const { getApp } = await import(`${G}firebase-app.js`);
    const { getAuth, signInWithCustomToken } = await import(`${G}firebase-auth.js`);
    await signInWithCustomToken(getAuth(getApp('admin')), j);
  }, { jeton, G: GSTATIC });
  await t.page.locator('#dashboard').waitFor({ state: 'visible' });
  return t;
}

const ecrituresCase = () => banc.appels.filter((x) => x.nom === 'gestionSim' && x.data && x.data.action === 'modifier'
  && x.data.champs && 'horsForfaitBloque' in x.data.champs);

test('admin : ligne SIM d\'avant sans « Hors-forfait bloqué chez l\'opérateur » : envoi arrêté avec la phrase, double toucher = une écriture, cochée après actualisation', async () => {
  await s.db.doc('gestion/reglages').set({ expediteur: { nom: 'Papote', adresse: '1 rue de test', cp: '07000', ville: 'Privas' } }, { merge: true });
  const tablette = await a.tablettePreparee();
  const simId = await a.simSurTablette(tablette);
  // Ligne notée avant le 19/11 : le champ n'existe pas.
  await s.db.doc(`sims/${simId}`).update({ horsForfaitBloque: s.FieldValue.delete() });
  const { abonnement: id } = await a.commanderEtPayer({ email: 'claire@exemple.fr', nom: 'Claire Dupont', carte: true });
  await s.appeler('gestionStock', { action: 'modifier', id: tablette.fiche, champs: { commande: id } }, a.TANGUY);
  const faits = { mode: Date.now(), tablette: Date.now(), sim: Date.now(), 'sim-installer': Date.now() };
  await s.appeler('gestionParcours', { type: 'envoi', commande: id, preparation: { etape: 4, faits, tablette: tablette.fiche } }, a.TANGUY);

  // La fiche de la carte : la case est là, non cochée, avec ce qu'il faut faire.
  const t = await ouvrirAdmin('ordinateur', `#sim/${simId}`);
  const p = t.page;
  const laCase = p.locator('input[data-hors-forfait]');
  await laCase.waitFor({ state: 'visible', timeout: 20_000 });
  assert.strictEqual(await p.locator('label.case-hors-forfait').innerText(), 'Hors-forfait bloqué chez l\'opérateur');
  assert.strictEqual(await laCase.isChecked(), false, 'ligne d\'avant : non cochée');
  assert.match(await p.locator('[data-hors-forfait-aide]').innerText(),
    /Tant que cette case n'est pas cochée, la tablette de cette ligne ne part pas\. Activez le blocage du hors-forfait dans l'espace client de l'opérateur, puis cochez-la\./);

  // « Préparer l'envoi » s'arrête sur elle : la phrase, et « C'est fait » éteint.
  await p.goto(`${banc.origine}/admin.html#commande/${id}`);
  await p.getByRole('button', { name: 'Reprendre la préparation' }).first().click();
  await p.locator('dialog.parcours[open]').waitFor();
  assert.strictEqual(await p.locator('.pc-corps h3').innerText(), 'Hors-forfait bloqué ?');
  assert.match(await p.locator('.pc-texte').innerText(), new RegExp(`^La tablette ${tablette.ref} ${PHRASE.source}$`));
  assert.ok(await p.locator('.pc-suivant').isDisabled(), '« C\'est fait » éteint tant que la case n\'est pas cochée');
  // Le serveur refuse aussi le départ (ici la remise en main propre), avec la même explication.
  await assert.rejects(s.appeler('tabletteEnvoyee', { commande: id, mainPropre: true }, a.TANGUY),
    /attend encore le blocage du hors-forfait sur sa ligne : activez-le dans l'espace client de l'opérateur, puis cochez « Hors-forfait bloqué chez l'opérateur »/);
  assert.strictEqual((await s.lire(`commandes/${id}`)).expedition, 'a-preparer', 'rien n\'est parti');
  await p.locator('dialog.parcours .fermer').click();

  // Cochée sur la fiche puis enregistrée : une seule écriture.
  await p.goto(`${banc.origine}/admin.html#sim/${simId}`);
  await laCase.waitFor({ state: 'visible', timeout: 20_000 });
  const avant = ecrituresCase().length;
  // Tanguy 27/11 : rien n'est envoyé à la coche, tout part avec « Enregistrer » (touché deux fois : un seul envoi).
  await laCase.check();
  await p.waitForTimeout(400);
  assert.strictEqual(ecrituresCase().length - avant, 0, 'cocher n\'enregistre rien');
  await p.locator('button[data-enregistrer-blocages]').dblclick();
  await p.waitForFunction(() => /^Noté/.test(document.querySelector('[data-hors-forfait-aide]')?.textContent || ''), null, { timeout: 15_000 });
  assert.strictEqual(await laCase.isChecked(), true);
  assert.strictEqual(ecrituresCase().length - avant, 1, 'double toucher : une seule écriture');
  const ligne = await s.lire(`sims/${simId}`);
  assert.strictEqual(ligne.horsForfaitBloque, true);
  assert.strictEqual(ligne.horsForfaitBloquePar, a.TANGUY.email);
  assert.ok(Number.isFinite(ligne.horsForfaitBloqueLe));

  // Page actualisée : toujours cochée, avec la date et l'auteur.
  await p.reload();
  await p.locator('#dashboard').waitFor({ state: 'visible' });
  await laCase.waitFor({ state: 'visible', timeout: 20_000 });
  assert.strictEqual(await laCase.isChecked(), true, 'cochée après actualisation');
  assert.match(await p.locator('[data-hors-forfait-aide]').innerText(), new RegExp(`^Noté le .+ par ${a.TANGUY.email.replace(/\./g, '\\.')} : aucun hors-forfait possible sur cette ligne\\.$`));

  // La préparation reprend sans s'arrêter, et le serveur laisse partir la tablette.
  await p.goto(`${banc.origine}/admin.html#commande/${id}`);
  await p.getByRole('button', { name: 'Reprendre la préparation' }).first().click();
  await p.locator('dialog.parcours[open]').waitFor();
  assert.strictEqual(await p.locator('.pc-corps h3').innerText(), 'La tablette dans le carton');
  await p.locator('dialog.parcours .fermer').click();
  await s.appeler('tabletteEnvoyee', { commande: id, mainPropre: true }, a.TANGUY);
  assert.strictEqual((await s.lire(`commandes/${id}`)).expedition, 'envoyee');
});
