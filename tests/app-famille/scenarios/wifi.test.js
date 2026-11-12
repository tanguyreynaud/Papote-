// Changer le wifi de la tablette depuis l'appli (A36, Tanguy 12/11) : le mot de passe ne va jamais dans
// l'ordre (lisible des autres responsables) mais dans commands/{id}/secret/wifi, avec une expiration ; la
// fenêtre montre le vrai résultat renvoyé par la tablette (Connectée, Mot de passe refusé, Réseau introuvable).
// La tablette est simulée ici avec les droits du serveur, comme Sync.changerWifi : elle lit le secret, passe
// l'ordre « running » en effaçant le secret, puis répond state + result + issue.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

const { s } = banc;

banc.brancher();

const ficheTablette = async (fid) => (await g.liste(`families/${fid}/members`)).find((m) => m.role === 'tablette');

/** Attend le prochain ordre de ce type, pas encore pris. */
const ordre = (fid, type) => g.attendreBase(async () => (await g.liste(`families/${fid}/commands`))
  .find((c) => c.type === type && c.state === 'pending'), `ordre ${type}`);

/** La tablette simulée prend l'ordre wifi : lit puis efface le mot de passe, essaie, répond. */
async function tabletteEssaie(fid, cmd, { issue, state, result }) {
  const ref = s.db.doc(`families/${fid}/commands/${cmd.id}`);
  const secret = (await ref.collection('secret').doc('wifi').get()).data();
  const lot = s.db.batch();
  lot.update(ref, { state: 'running', result: `La tablette essaie « ${cmd.ssid} »…` });
  lot.delete(ref.collection('secret').doc('wifi'));
  await lot.commit();
  await new Promise((r) => setTimeout(r, 400));
  await ref.update({ state, result, issue, doneAt: s.Timestamp.now() });
  return secret;
}

test('Wifi depuis l\'appli : mot de passe à part et effacé, vrai résultat (refusé, introuvable, connectée)', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const tab = await ficheTablette(fid);
  await s.db.doc(`families/${fid}/members/${tab.id}`).update({ lastOnline: s.Timestamp.now(), wifi: { ssid: 'Livebox-Emma' } });
  await g.ouvrirTuile(julie, 'settings');
  await julie.page.locator('#wifi-current', { hasText: 'Livebox-Emma' }).waitFor();
  await julie.page.click('#wifi-modify');

  // La tablette cherche les réseaux autour d'elle.
  const scan = await ordre(fid, 'wifiScan');
  await s.db.doc(`families/${fid}/commands/${scan.id}`).update({
    state: 'done', doneAt: s.Timestamp.now(),
    reseaux: [
      { ssid: 'Livebox-Emma', security: 'wpa2', signal: 4 },
      { ssid: 'Freebox-Jardin', security: 'wpa2', signal: 3 },
      { ssid: 'Voisin', security: 'wpa2', signal: 1 },
    ],
  });
  const ligne = (ssid) => julie.page.locator('#wifi-list .wifi-item', { hasText: ssid });
  await ligne('Freebox-Jardin').waitFor();

  // 1. Mauvais mot de passe : la tablette reste sur la Livebox, la fenêtre le dit, on peut corriger.
  await ligne('Freebox-Jardin').locator('.wifi-choice').click();
  await ligne('Freebox-Jardin').locator('input[type=password]').fill('mauvais-mdp');
  await ligne('Freebox-Jardin').locator('button[type=submit]').click();
  let cmd = await ordre(fid, 'wifi');
  assert.strictEqual(cmd.ssid, 'Freebox-Jardin');
  assert.ok(!('password' in cmd), 'le mot de passe n\'est jamais dans l\'ordre');
  const secretRef = s.db.doc(`families/${fid}/commands/${cmd.id}/secret/wifi`);
  const secretAvant = (await secretRef.get()).data();
  assert.strictEqual(secretAvant.password, 'mauvais-mdp');
  const resteMin = (secretAvant.expireAt.toMillis() - Date.now()) / 60_000;
  assert.ok(resteMin > 55 && resteMin <= 60, `expire dans une heure (${resteMin.toFixed(1)} min)`);
  const statut = ligne('Freebox-Jardin').locator('.wifi-statut');
  await tabletteEssaie(fid, cmd, {
    state: 'failed', issue: 'mot-de-passe',
    result: 'Mot de passe refusé par « Freebox-Jardin ». La tablette est restée sur « Livebox-Emma ».',
  });
  await statut.locator('strong', { hasText: 'Mot de passe refusé' }).waitFor();
  assert.match(await statut.innerText(), /restée sur « Livebox-Emma »/);
  assert.ok(!(await statut.evaluate((e) => e.classList.contains('ok'))));
  // Couleur calme : pas de rouge pour un mot de passe refusé.
  const couleur = await statut.evaluate((e) => getComputedStyle(e).color);
  const [r, v] = couleur.match(/\d+/g).map(Number);
  assert.ok(!(r > 150 && v < 100), `texte pas rouge (${couleur})`);
  assert.strictEqual(await ligne('Freebox-Jardin').locator('input[type=password]').inputValue(), '', 'mot de passe tapé effacé');
  assert.ok(await ligne('Freebox-Jardin').locator('button[type=submit]').isEnabled(), 'on peut réessayer');
  await g.attendreBase(async () => !(await s.db.doc(`families/${fid}/commands/${cmd.id}`).get()).exists, 'ordre effacé après le résultat');
  assert.ok(!(await secretRef.get()).exists, 'mot de passe effacé');

  // 2. Réseau introuvable (parti entre la recherche et l'essai).
  await ligne('Voisin').locator('.wifi-choice').click();
  await ligne('Voisin').locator('input[type=password]').fill('motdepasse-voisin');
  await ligne('Voisin').locator('button[type=submit]').click();
  cmd = await ordre(fid, 'wifi');
  await tabletteEssaie(fid, cmd, {
    state: 'failed', issue: 'introuvable',
    result: 'Réseau « Voisin » introuvable autour de la tablette. La tablette est restée sur « Livebox-Emma ».',
  });
  await ligne('Voisin').locator('.wifi-statut strong', { hasText: 'Réseau introuvable' }).waitFor();

  // 3. Bon mot de passe : « Connectée », l'ancien wifi reste enregistré sur la tablette.
  await ligne('Freebox-Jardin').locator('.wifi-choice').click();
  await ligne('Freebox-Jardin').locator('input[type=password]').fill('bon-mot-de-passe');
  await ligne('Freebox-Jardin').locator('button[type=submit]').click();
  cmd = await ordre(fid, 'wifi');
  const secret = await tabletteEssaie(fid, cmd, {
    state: 'done', issue: 'connectee',
    result: 'Connectée à « Freebox-Jardin ». L\'ancien wifi « Livebox-Emma » reste enregistré.',
  });
  assert.strictEqual(secret.password, 'bon-mot-de-passe');
  const ok = ligne('Freebox-Jardin').locator('.wifi-statut.ok');
  await ok.locator('strong', { hasText: 'Connectée' }).waitFor();
  assert.match(await ok.innerText(), /reste enregistré/);
  assert.ok(!(await ligne('Freebox-Jardin').locator('button[type=submit]').isEnabled()), 'pas de second envoi');
  await g.attendreBase(async () => (await g.liste(`families/${fid}/commands`)).length === 0, 'plus aucun ordre gardé');
});

test('Wifi depuis l\'appli : fenêtre fermée avant que la tablette prenne l\'ordre, ordre et mot de passe retirés', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const tab = await ficheTablette(fid);
  await s.db.doc(`families/${fid}/members/${tab.id}`).update({ lastOnline: s.Timestamp.now(), wifi: { ssid: 'Livebox-Emma' } });
  await g.ouvrirTuile(julie, 'settings');
  await julie.page.locator('#wifi-current', { hasText: 'Livebox-Emma' }).waitFor();
  await julie.page.click('#wifi-modify');
  const scan = await ordre(fid, 'wifiScan');
  await s.db.doc(`families/${fid}/commands/${scan.id}`).update({
    state: 'done', doneAt: s.Timestamp.now(), reseaux: [{ ssid: 'Freebox-Jardin', security: 'wpa2', signal: 3 }],
  });
  const ligne = julie.page.locator('#wifi-list .wifi-item', { hasText: 'Freebox-Jardin' });
  await ligne.locator('.wifi-choice').click();
  await ligne.locator('input[type=password]').fill('bon-mot-de-passe');
  await ligne.locator('button[type=submit]').click();
  const cmd = await ordre(fid, 'wifi');
  await ligne.locator('.wifi-statut', { hasText: 'en attente de la tablette' }).waitFor();
  await julie.page.click('#wifi-close');
  await julie.page.locator('#sheet-wifi').waitFor({ state: 'hidden' });
  await g.attendreBase(async () => !(await s.db.doc(`families/${fid}/commands/${cmd.id}`).get()).exists, 'ordre retiré');
  await g.attendreBase(async () => !(await s.db.doc(`families/${fid}/commands/${cmd.id}/secret/wifi`).get()).exists, 'mot de passe retiré');
});
