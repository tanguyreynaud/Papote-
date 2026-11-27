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
  assert.match(await doliprane.innerText(), /Tous les jours à 9 h/);
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
  assert.match(await kine.innerText(), /Le mar, ven à 14 h 30/);
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
  await doliprane.filter({ hasText: 'Tous les jours à 10 h 30' }).waitFor();

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
  await doliprane.locator('.seen', { hasText: 'Mamie Emma a confirmé aujourd\'hui à 10 h 32' }).waitFor();

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

// Tanguy, 27/11 : « tout doit passer au style Papote ». La date d'un rappel s'ouvre en calendrier Papote sous le champ,
// l'heure en deux listes (heures, minutes) ; plus aucune roue ni calendrier standard du téléphone.
test('Rappel : date choisie dans le calendrier Papote, heure dans les listes, jours sans case à cocher', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie.dates@exemple.fr', prenom: 'Julie' });
  await g.ouvrirTuile(julie, 'agenda');
  await ouvrirAjout(julie);
  await julie.page.fill('#rem-title', 'Dentiste');
  await g.choisirDansListe(julie, '#rem-fields label:has(#rem-repeat) .liste-papote', 'Une seule fois');
  // Aucun champ standard visible dans la fenêtre.
  const nus = await julie.page.evaluate(() => [...document.querySelectorAll('#sheet-reminder select, #sheet-reminder input[type=date], #sheet-reminder input[type=time]')]
    .filter((e) => !e.classList.contains('liste-native') || getComputedStyle(e).opacity !== '0').map((e) => e.id));
  assert.deepStrictEqual(nus, []);

  // Calendrier : sous (ou sur) le champ, dans l'écran ; hier ne peut pas être choisi ; après-demain est choisi.
  const date = julie.page.locator('#rem-date-wrap .date-papote');
  await date.click();
  const cal = julie.page.locator('.calendrier-papote');
  await cal.waitFor();
  const place = await cal.evaluate((c) => { const r = c.getBoundingClientRect(); return { haut: Math.round(r.top), bas: Math.round(innerHeight - r.bottom), coupe: c.scrollHeight - c.clientHeight }; });
  assert.ok(place.haut >= 0 && place.bas >= 0 && place.coupe <= 2, `calendrier entier dans l'écran : ${JSON.stringify(place)}`);
  assert.strictEqual(await cal.getByRole('button', { name: 'Effacer' }).count(), 0, 'date obligatoire : pas de « Effacer »');
  const hier = cal.locator(`[data-jour="${jour(-1)}"]`);
  if (await hier.count()) assert.strictEqual(await hier.isDisabled(), true, 'hier ne se choisit pas');
  const cible = jour(2);
  if (!(await cal.locator(`[data-jour="${cible}"]`).count())) await cal.getByRole('button', { name: 'Mois suivant' }).click();
  await cal.locator(`[data-jour="${cible}"]`).click();
  await cal.waitFor({ state: 'detached' });
  assert.strictEqual(await julie.page.inputValue('#rem-date'), cible);
  // Plus de 2e ligne bleue : le champ dit le jour en toutes lettres ; « Demain » et « Aujourd'hui » en clair.
  assert.strictEqual(await julie.page.locator('#rem-date-jour').count(), 0);
  const attendu = new Date(`${cible}T12:00`).toLocaleDateString('fr-FR', { weekday: 'long' });
  assert.match((await date.innerText()).trim().toLowerCase(), new RegExp(`^${attendu} \\d`));
  await julie.page.fill('#rem-date', jour(1));
  assert.strictEqual((await date.innerText()).trim(), 'Demain');
  await julie.page.fill('#rem-date', jour(0));
  assert.strictEqual((await date.innerText()).trim(), 'Aujourd\'hui');
  await julie.page.fill('#rem-date', cible);

  // Heure : 14 h, puis 30.
  await g.choisirDansListe(julie, '.heure-papote .liste-papote >> nth=0', '14 h');
  await g.choisirDansListe(julie, '.heure-papote .liste-papote >> nth=1', '30');
  assert.strictEqual(await julie.page.inputValue('#rem-time'), '14:30');
  await julie.page.click('#btn-reminder');
  await julie.page.locator('#reminders li', { hasText: 'Dentiste' }).waitFor();
  await g.attendreBase(async () => (await g.liste(`families/${fid}/reminders`)).some((x) => x.title === 'Dentiste'), 'rappel écrit');
  const r = (await g.liste(`families/${fid}/reminders`)).find((x) => x.title === 'Dentiste');
  assert.strictEqual(r.date, cible);
  assert.strictEqual(r.time, '14:30');

  // Rouvert en modification : le bouton montre la date et l'heure enregistrées.
  await ouvrirAjout(julie);
  await g.choisirDansListe(julie, '#rem-fields label:has(#rem-repeat) .liste-papote', 'Certains jours de la semaine');
  const jours = await julie.page.locator('#rem-days label').evaluateAll((ls) => ls.map((l) => { const b = l.getBoundingClientRect(); return { w: Math.round(b.width), y: Math.round(b.top), case: getComputedStyle(l.querySelector('input')).opacity }; }));
  assert.strictEqual(new Set(jours.map((j) => j.y)).size, 1, 'les sept jours sur une ligne');
  assert.ok(jours.every((j) => j.case === '0' && j.w >= 40), `sept cases égales sans case à cocher : ${JSON.stringify(jours)}`);
  await julie.page.locator('#rem-days label', { hasText: 'Mar' }).click();
  assert.strictEqual(await julie.page.locator('#rem-days input[value="2"]').isChecked(), true);
  // Jour choisi : bleu clair, bord et texte bleus (pas une case pleine).
  const choisi = await julie.page.locator('#rem-days label', { hasText: 'Mar' }).evaluate((l) => { const c = getComputedStyle(l); return { fond: c.backgroundColor, bord: c.borderTopColor, texte: c.color }; });
  assert.ok(choisi.bord === choisi.texte && choisi.fond !== choisi.bord, `jour choisi en bleu clair : ${JSON.stringify(choisi)}`);
  // Petits écrans (Tanguy, 27/11) : 360 px = les sept jours sur une ligne ; 320 px = deux lignes de quatre. Toujours
  // assez larges pour le doigt, mot entier, rien hors de l'écran ; « Médicament » tient dans sa case.
  const grand = julie.page.viewportSize();
  for (const [large, rangs] of [[360, 1], [320, 2]]) {
    await julie.page.setViewportSize({ width: large, height: grand.height });
    const m = await julie.page.locator('#rem-days label, #rem-fields .choice-ligne label').evaluateAll((ls) => ls.filter((l) => l.checkVisibility()).map((l) => { const b = l.getBoundingClientRect();
      return { mot: l.textContent.trim(), jour: !!l.closest('#rem-days'), w: Math.round(b.width), h: Math.round(b.height), y: Math.round(b.top), dehors: b.left < 0 || b.right > innerWidth, coupe: l.scrollWidth > l.clientWidth + 1 }; }));
    const js = m.filter((x) => x.jour);
    assert.strictEqual(js.length, 7, `${large} px : sept jours`);
    assert.strictEqual(new Set(js.map((j) => j.y)).size, rangs, `${large} px : jours sur ${rangs} ligne(s) : ${JSON.stringify(js)}`);
    assert.ok(js.every((j) => j.w >= 40 && j.h >= 44), `${large} px : jours assez grands pour le doigt : ${JSON.stringify(js)}`);
    assert.ok(m.every((x) => !x.dehors && !x.coupe), `${large} px : aucun mot coupé ni hors de l'écran : ${JSON.stringify(m)}`);
    const champs = await julie.page.locator('#rem-fields .liste-papote').evaluateAll((bs) => bs.filter((b) => b.checkVisibility()).map((b) => ({ mot: b.textContent.trim(), coupe: b.scrollWidth > b.clientWidth + 1 || [...b.children].some((c) => c.scrollWidth > c.clientWidth + 1) })));
    assert.ok(champs.every((c) => !c.coupe), `${large} px : aucun champ au texte coupé : ${JSON.stringify(champs)}`);
  }
  await julie.page.setViewportSize(grand);
  // « Jusqu'au (facultatif) » : une date choisie peut être effacée.
  await julie.page.locator('#rem-fin-wrap .date-papote').click();
  await cal.waitFor();
  await cal.locator('.cal-jour:not([disabled])').last().click();
  assert.notStrictEqual(await julie.page.inputValue('#rem-fin'), '');
  await julie.page.locator('#rem-fin-wrap .date-papote').click();
  await cal.getByRole('button', { name: 'Effacer' }).click();
  assert.strictEqual(await julie.page.inputValue('#rem-fin'), '');
});
