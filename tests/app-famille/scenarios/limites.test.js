// Limites du jour (A12, Tanguy 12/11 ; serveur : functions/limites.js) : 50 messages écrits par famille, puis un mot
// calme à la place de la barre d'écriture jusqu'à minuit ; rappels : 30 dans l'agenda et 10 ajoutés par jour au plus.
// Double appui, message rapide, texte gardé, rien d'écrit en trop.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

const { s } = banc;

banc.brancher();

const jourParis = () => new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const compteur = (fid) => s.db.doc(`families/${fid}/compteurs/jour`);
const postsDe = async (fid, type) => (await g.liste(`families/${fid}/posts`)).filter((p) => p.type === type);
// Retour (flèche de la page), puis la tuile Messages de nouveau.
async function rouvrirMessages(t) {
  await t.page.click('#view-messages .back');
  await g.attendreVue(t, 'view-home');
  await g.ouvrirTuile(t, 'messages');
}
const TEXTE_MESSAGES = "50 messages aujourd'hui : c'est le maximum pour la journée. Vous pourrez écrire de nouveau demain.";

test('Messages : le 50e part, le suivant est refusé calmement (texte gardé, rien en attente), la barre revient après minuit', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  // 49 messages déjà écrits aujourd'hui par la famille.
  await compteur(fid).set({ jour: jourParis(), messages: 49, parAuteur: { autre: 49 }, rappels: 0 });
  await g.ouvrirTuile(julie, 'messages');
  assert.strictEqual(await julie.page.locator('#messages-limite').isVisible(), false);

  // Le 50e part ; le serveur ferme la journée.
  await julie.page.fill('#message-text', 'Le cinquantième');
  await julie.page.click('#btn-message');
  await julie.page.locator('#messages li.bubble.mine:not(.en-route)', { hasText: 'Le cinquantième' }).waitFor();
  await g.attendreBase(async () => (await compteur(fid).get()).get('bloqueJusqua'), 'journée fermée par le serveur');

  // Le suivant : refusé par les règles, un mot calme à la place de la barre, le texte revient dans le champ.
  await julie.page.fill('#message-text', 'Encore un petit mot');
  await julie.page.click('#btn-message');
  const note = julie.page.locator('#messages-limite');
  await note.waitFor({ state: 'visible' });
  assert.strictEqual(await note.innerText(), TEXTE_MESSAGES);
  assert.strictEqual(await julie.page.locator('#btn-message').isVisible(), false);
  assert.strictEqual(await julie.page.locator('.quick-msg').first().isVisible(), false);
  assert.strictEqual(await julie.page.inputValue('#message-text'), 'Encore un petit mot');
  await julie.page.locator('#messages li.en-route').waitFor({ state: 'detached' });
  assert.strictEqual(await julie.page.locator('.outbox').first().isVisible(), false, 'rien en attente de réseau');
  assert.strictEqual(await g.fenetresOuvertes(julie), 0, 'pas de fenêtre');
  assert.deepStrictEqual((await postsDe(fid, 'message')).map((m) => m.text), ['Le cinquantième']);

  // Page rouverte : le mot est là tout de suite (compteur lu à l'ouverture).
  await rouvrirMessages(julie);
  await note.waitFor({ state: 'visible' });

  // Minuit passé (heure de blocage dépassée) : la barre revient à l'ouverture de la page, et l'envoi part.
  await compteur(fid).update({ bloqueJusqua: s.Timestamp.fromMillis(Date.now() - 1000) });
  await rouvrirMessages(julie);
  await julie.page.locator('#btn-message').waitFor({ state: 'visible' });
  assert.strictEqual(await note.isVisible(), false);
  await julie.page.fill('#message-text', 'Bonjour, nouveau jour');
  await julie.page.click('#btn-message');
  await g.attendreBase(async () => (await postsDe(fid, 'message')).length === 2, '2 messages');
});

test('Messages : journée déjà pleine à l\'ouverture, double appui sur un message rapide : rien n\'est écrit', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await g.ouvrirTuile(julie, 'messages');
  // Un autre proche vient de remplir la journée pendant que Julie a la page ouverte.
  await compteur(fid).set({ jour: jourParis(), messages: 50, parAuteur: { autre: 50 }, rappels: 0, bloqueJusqua: s.Timestamp.fromMillis(Date.now() + 3600e3) });
  await g.doubleAppui(julie, '.quick-msg');
  const note = julie.page.locator('#messages-limite');
  await note.waitFor({ state: 'visible' });
  await julie.page.waitForTimeout(800);
  assert.strictEqual((await postsDe(fid, 'message')).length, 0);
  assert.strictEqual(await julie.page.locator('#messages li.en-route').count(), 0);
  assert.strictEqual(await g.fenetresOuvertes(julie), 0);
  // Un message écrit au clavier puis Entrée/Envoyer n'est plus possible : la barre est cachée.
  assert.strictEqual(await julie.page.locator('#message-text').isVisible(), false);
});

async function ouvrirAjout(t) {
  await t.page.click('#add-reminder');
  await t.page.locator('#sheet-reminder').waitFor({ state: 'visible' });
}

test('Rappels : 30 dans l\'agenda au plus (dit dès l\'ouverture), 10 ajoutés par jour (double appui : un seul)', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  // 30 rappels en cours, posés 10 par 10 (le serveur n'en garde que 10 créés par jour : compteur remis entre deux).
  for (let lot = 0; lot < 3; lot++) {
    const batch = s.db.batch();
    for (let i = 0; i < 10; i++) {
      batch.set(s.db.collection(`families/${fid}/reminders`).doc(), {
        title: `Rappel ${lot}-${i}`, kind: 'autre', time: `0${lot + 7}:${String(i * 5).padStart(2, '0')}`, repeat: 'daily', date: null, days: [],
        createdBy: 'Julie', createdAt: s.Timestamp.now(), lastAck: null,
      });
    }
    await batch.commit();
    await s.calme();
    await compteur(fid).delete();
  }
  assert.strictEqual((await g.liste(`families/${fid}/reminders`)).length, 30);
  await g.ouvrirTuile(julie, 'agenda');
  await julie.page.locator('#reminders li').nth(29).waitFor();

  await ouvrirAjout(julie);
  const note = julie.page.locator('#rem-limite');
  await note.waitFor({ state: 'visible' });
  assert.match(await note.innerText(), /30 rappels dans l'agenda : c'est le maximum/);
  await julie.page.fill('#rem-title', 'Un de trop');
  await g.doubleAppui(julie, '#btn-reminder');
  await julie.page.waitForTimeout(600);
  assert.strictEqual(await note.isVisible(), true);
  assert.strictEqual(await julie.page.locator('#sheet-reminder').isVisible(), true);
  assert.strictEqual((await g.liste(`families/${fid}/reminders`)).length, 30);
  // Un anniversaire reste possible : le mot s'en va sur l'onglet Anniversaire.
  await julie.page.click('#agenda-seg .seg[data-seg="birthday"]');
  assert.strictEqual(await note.isVisible(), false);
  await julie.page.click('#reminder-close');
  await julie.page.locator('#sheet-reminder').waitFor({ state: 'hidden' });

  // Un rappel supprimé : place libre. Le compteur du jour en est à 9 rappels ajoutés.
  const premier = julie.page.locator('#reminders li').first();
  await premier.locator('.del').click();
  await g.repondre(julie, 'Supprimer');
  await g.attendreBase(async () => (await g.liste(`families/${fid}/reminders`)).length === 29, '29 rappels');
  await compteur(fid).set({ jour: jourParis(), messages: 0, parAuteur: {}, rappels: 9 });

  // Le 10e du jour (double appui : un seul enregistré) ; le serveur ferme la journée des rappels.
  await ouvrirAjout(julie);
  assert.strictEqual(await note.isVisible(), false);
  await julie.page.fill('#rem-title', 'Dixième');
  await g.doubleAppui(julie, '#btn-reminder');
  await julie.page.locator('#sheet-reminder').waitFor({ state: 'hidden' });
  await g.attendreBase(async () => (await compteur(fid).get()).get('rappelsBloquesJusqua'), 'journée des rappels fermée');
  assert.strictEqual((await g.liste(`families/${fid}/reminders`)).filter((r) => r.title === 'Dixième').length, 1);

  // Le suivant : refusé par les règles, dit calmement dans la fenêtre, qui reste ouverte (rien de perdu).
  // (L'agenda est de nouveau à 30 : un rappel est retiré pour ne voir que la limite du jour.)
  await julie.page.locator('#reminders li', { hasText: 'Dixième' }).locator('.del').click();
  await g.repondre(julie, 'Supprimer');
  await g.attendreBase(async () => (await g.liste(`families/${fid}/reminders`)).length === 29, '29 rappels');
  await ouvrirAjout(julie);
  await julie.page.fill('#rem-title', 'Onzième');
  await julie.page.click('#btn-reminder');
  await note.waitFor({ state: 'visible' });
  assert.strictEqual(await note.innerText(), "10 rappels ajoutés aujourd'hui : c'est le maximum pour la journée. Vous pourrez en ajouter de nouveau demain.");
  assert.strictEqual(await julie.page.locator('#rem-error').isVisible(), false);
  assert.strictEqual(await julie.page.locator('#sheet-reminder').isVisible(), true);
  assert.strictEqual(await julie.page.isEnabled('#btn-reminder'), true);
  assert.strictEqual(await julie.page.inputValue('#rem-title'), 'Onzième');
  assert.strictEqual((await g.liste(`families/${fid}/reminders`)).filter((r) => r.title === 'Onzième').length, 0);
  // Modifier un rappel existant reste possible.
  await julie.page.click('#reminder-close');
  await julie.page.locator('#sheet-reminder').waitFor({ state: 'hidden' });
  await julie.page.locator('#reminders li').first().locator('.agenda-edit', { hasText: 'Modifier' }).click();
  await julie.page.locator('#sheet-reminder').waitFor({ state: 'visible' });
  assert.strictEqual(await note.isVisible(), false);
  await julie.page.fill('#rem-title', 'Rappel modifié');
  await julie.page.click('#btn-reminder');
  await julie.page.locator('#sheet-reminder').waitFor({ state: 'hidden' });
  await julie.page.locator('#reminders li', { hasText: 'Rappel modifié' }).waitFor();
});
