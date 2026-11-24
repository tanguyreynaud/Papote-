// Deux proches au même instant (inspection 5, 3/11) : le même rappel modifié par deux téléphones, le même message
// supprimé par deux téléphones. Aucune erreur, aucune donnée en double, les deux écrans finissent d'accord.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

banc.brancher();

const jour = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

async function famille() {
  const julie = await banc.telephone('Julie');
  const paul = await banc.telephone('Paul');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });
  return { julie, paul, fid };
}

test('Le même rappel modifié par deux proches en même temps : une seule version, les deux écrans d\'accord', async () => {
  const { julie, paul, fid } = await famille();
  for (const t of [julie, paul]) await g.ouvrirTuile(t, 'agenda');

  await julie.page.click('#add-reminder');
  await julie.page.locator('#sheet-reminder').waitFor({ state: 'visible' });
  await julie.page.fill('#rem-title', 'Prendre le Doliprane');
  await julie.page.fill('#rem-time', '09:00');
  await julie.page.click('#btn-reminder');
  const chezJulie = julie.page.locator('#reminders li', { hasText: 'Doliprane' });
  const chezPaul = paul.page.locator('#reminders li', { hasText: 'Doliprane' });
  await chezJulie.waitFor();
  await chezPaul.waitFor();

  // Les deux ouvrent « Modifier », changent l'heure et valident au même instant.
  await chezJulie.locator('button', { hasText: 'Modifier' }).click();
  await chezPaul.locator('button', { hasText: 'Modifier' }).click();
  await julie.page.locator('#sheet-reminder').waitFor({ state: 'visible' });
  await paul.page.locator('#sheet-reminder').waitFor({ state: 'visible' });
  await julie.page.fill('#rem-time', '10:30');
  await paul.page.fill('#rem-time', '11:45');
  await Promise.all([julie.page.click('#btn-reminder'), paul.page.click('#btn-reminder')]);
  await g.toast(julie, 'Rappel modifié');
  await g.toast(paul, 'Rappel modifié');

  // Un seul rappel, à l'une des deux heures, et les deux téléphones affichent la même.
  const rappels = await g.attendreBase(async () => { const l = await g.liste(`families/${fid}/reminders`); return l.length === 1 && l; }, 'un seul rappel');
  assert.ok(['10:30', '11:45'].includes(rappels[0].time), `heure gardée : ${rappels[0].time}`);
  await chezJulie.filter({ hasText: `à ${rappels[0].time}` }).waitFor();
  await chezPaul.filter({ hasText: `à ${rappels[0].time}` }).waitFor();
  // La feuille se ferme en fondu (23/11) : on lui laisse le temps de partir.
  for (const t of [julie, paul]) await t.page.locator('#sheet-reminder').waitFor({ state: 'hidden', timeout: 2000 });
});

test('Le même message supprimé par deux proches en même temps : disparu une fois, aucune erreur', async () => {
  const { julie, paul, fid } = await famille();
  for (const t of [julie, paul]) await g.ouvrirTuile(t, 'messages');

  // Paul écrit ; Paul (auteur) et Julie (responsable) peuvent tous deux supprimer.
  await paul.page.fill('#message-text', 'À effacer');
  await paul.page.click('#btn-message');
  const chezJulie = julie.page.locator('#messages li', { hasText: 'À effacer' });
  const chezPaul = paul.page.locator('#messages li', { hasText: 'À effacer' });
  await chezJulie.waitFor();
  await chezPaul.waitFor();
  await g.attendreBase(async () => (await g.liste(`families/${fid}/posts`)).some((p) => p.text === 'À effacer'), 'message écrit');

  await chezJulie.locator('button[aria-label="Supprimer ce message"]').click();
  await chezPaul.locator('button[aria-label="Supprimer ce message"]').click();
  await Promise.all([g.repondre(julie, 'Supprimer'), g.repondre(paul, 'Supprimer')]);

  await chezJulie.waitFor({ state: 'detached' });
  await chezPaul.waitFor({ state: 'detached' });
  await g.attendreBase(async () => !(await g.liste(`families/${fid}/posts`)).some((p) => p.text === 'À effacer'), 'message supprimé');
  // Aucun des deux ne voit « La suppression a échoué ».
  for (const t of [julie, paul]) {
    assert.ok(await t.page.locator('.dialog-back', { hasText: 'suppression a échoué' }).count() === 0, `${t.nom || ''} pas d'erreur`);
  }
  // Le jour d'après (ou la 2e suppression qui arrive après la 1re) : rien ne revient.
  await new Promise((r) => setTimeout(r, 2000));
  assert.strictEqual((await g.liste(`families/${fid}/posts`)).filter((p) => p.text === 'À effacer').length, 0);
});

// Rien ne surgit (cohérence, 24/11) : dans une liste, seule la ligne vraiment nouvelle arrive en fondu. Les listes sont
// redessinées en entier à chaque nouveauté : les lignes déjà là ne doivent jamais se ranimer (pas de clignotement), et
// mon propre message, déjà à l'écran, non plus.
test('Fondu des listes : seule la ligne nouvelle s\'anime, chez l\'autre proche ; les lignes déjà là ne clignotent pas', async () => {
  const { julie, paul } = await famille();
  const ecouter = (t) => t.page.evaluate(() => {
    window.__arrivees = [];
    document.addEventListener('animationstart', (e) => { if (e.animationName === 'arrive') window.__arrivees.push(e.target.textContent); });
  });
  const arrivees = (t) => t.page.evaluate(() => window.__arrivees);
  for (const t of [julie, paul]) { await g.ouvrirTuile(t, 'messages'); await ecouter(t); }

  for (const texte of ['Premier message', 'Deuxième message', 'Troisième message']) {
    await paul.page.fill('#message-text', texte);
    await paul.page.click('#btn-message');
    await julie.page.locator('#messages li', { hasText: texte }).waitFor();
    await paul.page.locator('#messages li:not(.en-route)', { hasText: texte }).waitFor();
    await julie.page.waitForTimeout(600);
  }
  const chezJulie = await arrivees(julie);
  assert.strictEqual(chezJulie.length, 3, `chez Julie, chaque message de Paul arrive une fois en fondu : ${JSON.stringify(chezJulie)}`);
  ['Premier', 'Deuxième', 'Troisième'].forEach((m, i) => assert.ok(chezJulie[i].includes(m), `le ${i + 1}e fondu est le ${i + 1}e message : ${chezJulie[i]}`));
  assert.deepStrictEqual(await arrivees(paul), [], 'chez Paul, ses propres messages ne se ranimant pas');

  // Rappels : Julie en ajoute deux ; chez Paul, chacun arrive une fois, le premier ne se ranime pas au second.
  for (const t of [julie, paul]) { await g.retourAccueil(t).catch(() => t.page.click('#view-messages .back')); await g.attendreVue(t, 'view-home'); await g.ouvrirTuile(t, 'agenda'); }
  await paul.page.evaluate(() => { window.__arrivees.length = 0; });
  for (const [titre, heure] of [['Arroser les fleurs', '09:00'], ['Prendre le courrier', '11:00']]) {
    await julie.page.click('#add-reminder');
    await julie.page.locator('#sheet-reminder').waitFor({ state: 'visible' });
    await julie.page.fill('#rem-title', titre);
    await julie.page.fill('#rem-time', heure);
    await julie.page.click('#btn-reminder');
    await paul.page.locator('#reminders li', { hasText: titre }).waitFor();
    await julie.page.locator('#sheet-reminder').waitFor({ state: 'hidden' });
    await paul.page.waitForTimeout(600);
  }
  const chezPaul = await arrivees(paul);
  assert.strictEqual(chezPaul.length, 2, `chez Paul, chaque rappel arrive une fois : ${JSON.stringify(chezPaul)}`);
  assert.ok(chezPaul[0].includes('Arroser') && chezPaul[1].includes('courrier'), JSON.stringify(chezPaul));
});
