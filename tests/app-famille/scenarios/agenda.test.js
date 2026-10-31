// Agenda : rappels (tous les jours, certains jours, une fois), modification, pause, confirmation de Mamie,
// anniversaires (celui donné à l'inscription, ajout, date impossible), suppression, rappels passés effacés.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

const { s } = banc;

banc.brancher();

const jour = (decalage = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + decalage);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }); // comme la page (le PC ou le serveur de tests peut être en UTC)
};

async function ouvrirAjout(t) {
  await t.page.click('#add-reminder');
  await t.page.locator('#sheet-reminder').waitFor({ state: 'visible' });
}

test('Rappels : ajout, erreurs, modification, pause, confirmation par la tablette, suppression', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await g.ouvrirTuile(julie, 'agenda');

  // L'anniversaire donné à l'inscription est déjà là.
  const anniv = julie.page.locator('#birthdays li', { hasText: 'Julie' });
  await anniv.waitFor();
  assert.match(await anniv.innerText(), /12 mai/);

  // Tous les jours à 9 h.
  await ouvrirAjout(julie);
  await julie.page.click('#btn-reminder');
  await julie.page.locator('#rem-error', { hasText: 'Écrivez ce qu\'il faut rappeler' }).waitFor();
  await julie.page.fill('#rem-title', 'Prendre le Doliprane');
  await julie.page.click('#btn-reminder');
  await julie.page.locator('#sheet-reminder').waitFor({ state: 'hidden' });
  const doliprane = julie.page.locator('#reminders li', { hasText: 'Prendre le Doliprane' });
  await doliprane.waitFor();
  assert.match(await doliprane.innerText(), /Tous les jours à 09:00/);
  assert.match(await doliprane.innerText(), /Prévenue 15 min avant/);

  // Certains jours : il faut au moins un jour.
  await ouvrirAjout(julie);
  await julie.page.fill('#rem-title', 'Kiné');
  await julie.page.check('input[name="rem-kind"][value="rdv"]');
  await julie.page.selectOption('#rem-repeat', 'weekly');
  await julie.page.fill('#rem-time', '14:30');
  await julie.page.click('#btn-reminder');
  await julie.page.locator('#rem-error', { hasText: 'Choisissez au moins un jour' }).waitFor();
  await julie.page.locator('#rem-days label', { hasText: 'Mar' }).locator('input').check();
  await julie.page.locator('#rem-days label', { hasText: 'Ven' }).locator('input').check();
  await julie.page.selectOption('#rem-avance', '60');
  await julie.page.fill('#rem-fin', jour(-1));
  await julie.page.click('#btn-reminder');
  await julie.page.locator('#rem-error', { hasText: 'La date de fin est déjà passée' }).waitFor();
  await julie.page.fill('#rem-fin', jour(60));
  await julie.page.click('#btn-reminder');
  const kine = julie.page.locator('#reminders li', { hasText: 'Kiné' });
  await kine.waitFor();
  assert.match(await kine.innerText(), /Le mar, ven à 14:30/);
  assert.match(await kine.innerText(), /Prévenue 1 h avant · jusqu'au/);

  // Une seule fois, demain.
  await ouvrirAjout(julie);
  await julie.page.fill('#rem-title', 'Coiffeur');
  await julie.page.selectOption('#rem-repeat', 'once');
  await julie.page.fill('#rem-date', jour(1));
  await julie.page.fill('#rem-time', '10:00');
  await julie.page.click('#btn-reminder');
  await julie.page.locator('#reminders li', { hasText: 'Coiffeur' }).waitFor();

  const rappels = await g.attendreBase(async () => { const l = await g.liste(`families/${fid}/reminders`); return l.length === 3 && l; }, '3 rappels enregistrés');
  const k = rappels.find((r) => r.title === 'Kiné');
  assert.deepStrictEqual({ kind: k.kind, repeat: k.repeat, days: k.days.sort(), time: k.time, avanceMin: k.avanceMin, finLe: k.finLe },
    { kind: 'rdv', repeat: 'weekly', days: [2, 5], time: '14:30', avanceMin: 60, finLe: jour(60) });
  assert.strictEqual(rappels.find((r) => r.title === 'Coiffeur').date, jour(1));

  // Modifier : le Doliprane passe à 10 h 30.
  await doliprane.locator('button', { hasText: 'Modifier' }).click();
  await julie.page.locator('#sheet-reminder').waitFor({ state: 'visible' });
  assert.strictEqual(await julie.page.inputValue('#rem-title'), 'Prendre le Doliprane');
  await julie.page.fill('#rem-time', '10:30');
  await julie.page.click('#btn-reminder');
  await g.toast(julie, 'Rappel modifié');
  await doliprane.filter({ hasText: 'Tous les jours à 10:30' }).waitFor();

  // Pause d'une semaine, puis reprise.
  await doliprane.locator('button', { hasText: 'Mettre en pause' }).click();
  await g.repondre(julie, 'Pendant une semaine');
  await g.toast(julie, 'Rappel en pause');
  await doliprane.locator('.pause-note', { hasText: 'En pause jusqu\'au' }).waitFor();
  await doliprane.locator('button', { hasText: 'Reprendre' }).click();
  await g.toast(julie, 'Rappel repris');
  await doliprane.locator('.pause-note').waitFor({ state: 'detached' });

  // Mamie confirme sur la tablette.
  const id = rappels.find((r) => r.title === 'Prendre le Doliprane').id;
  await s.db.doc(`families/${fid}/reminders/${id}`).update({ lastAck: `${jour(0)}T10:32` });
  await doliprane.locator('.seen', { hasText: 'Mamie Emma a confirmé aujourd\'hui à 10:32' }).waitFor();

  // Suppression.
  await kine.locator('button[aria-label="Supprimer ce rappel"]').click();
  await g.repondre(julie, 'Supprimer');
  await kine.waitFor({ state: 'detached' });
  await g.attendreBase(async () => (await g.liste(`families/${fid}/reminders`)).length === 2, 'rappel supprimé');
});

test('Anniversaires : ajout, date impossible, modification ; rappel passé effacé tout seul', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await g.ouvrirTuile(julie, 'agenda');

  await ouvrirAjout(julie);
  await julie.page.click('#agenda-seg .seg[data-seg="birthday"]');
  assert.strictEqual(await julie.page.locator('#btn-reminder').innerText(), 'Ajouter l\'anniversaire');
  await julie.page.fill('#bday-name', 'Léa');
  await julie.page.selectOption('#bday-day', '31');
  await julie.page.selectOption('#bday-month', '4');
  await julie.page.click('#btn-reminder');
  await julie.page.locator('#rem-error', { hasText: 'Il n\'y a pas de 31 avril' }).waitFor();
  await julie.page.selectOption('#bday-day', '29');
  await julie.page.selectOption('#bday-month', '2');
  await julie.page.fill('#bday-year', '1850');
  await julie.page.click('#btn-reminder');
  await julie.page.locator('#rem-error', { hasText: 'L\'année ne semble pas juste' }).waitFor();
  await julie.page.fill('#bday-year', '2016');
  await julie.page.click('#btn-reminder');
  const lea = julie.page.locator('#birthdays li', { hasText: 'Léa' });
  await lea.waitFor();
  assert.match(await lea.innerText(), /29 février/);

  // Modifier l'année.
  await lea.locator('button', { hasText: 'Modifier' }).click();
  await julie.page.fill('#bday-year', '2015');
  await julie.page.click('#btn-reminder');
  await g.toast(julie, 'Anniversaire modifié');
  const b = await g.attendreBase(async () => (await g.liste(`families/${fid}/birthdays`)).find((x) => x.name === 'Léa' && x.year === 2015), 'année modifiée');
  assert.deepStrictEqual([b.day, b.month], [29, 2]);

  // Un rappel « une seule fois » d'hier (téléphone resté fermé) : effacé à l'ouverture de l'agenda.
  await s.db.collection(`families/${fid}/reminders`).add({
    title: 'Pharmacie', kind: 'autre', time: '09:00', repeat: 'once', date: jour(-1), days: [],
    createdBy: 'Julie', createdAt: s.FieldValue.serverTimestamp(), lastAck: null,
  });
  await g.attendreBase(async () => !(await g.liste(`families/${fid}/reminders`)).length, 'rappel passé effacé');
  await julie.page.locator('#reminders li').waitFor({ state: 'detached' });
});
