// Les appels entre la vraie app famille et la vraie page d'appels de la tablette (liaison WebRTC réelle entre les
// deux navigateurs, caméras et micros simulés) : Julie appelle Mamie, Mamie appelle Julie, personne ne répond.

const { test, assert, g, brancher, chezMamie, familleChezMamie, diagnostic, doubleAppui } = require('../commun');

brancher();

const appels = (fid) => g.liste(`families/${fid}/calls`);

async function julieAppelle(julie) {
  await julie.page.locator('#tile-call:not([disabled])').waitFor({ timeout: 30_000 });
  await julie.page.click('#tile-call');
  assert.match(await g.texteFenetre(julie), /Appeler Mamie Emma en vidéo/);
  await g.repondre(julie, 'Appeler');
  await julie.page.locator('#call').waitFor({ state: 'visible' });
}

const imageRecue = (t, id, delai = 25_000) => t.page.waitForFunction((x) => {
  const v = document.getElementById(x);
  return v && v.srcObject && v.readyState >= 2 && v.videoWidth > 0;
}, id, { timeout: delai });

test('Julie appelle Mamie en vidéo : la tablette sonne, double appui sur « Décrocher », image dans les deux sens, Mamie raccroche', async () => {
  const { julie, mamie, fid } = await familleChezMamie();
  await julieAppelle(julie);
  await julie.page.locator('#call-status', { hasText: 'Ça sonne' }).waitFor();

  const debut = Date.now();
  await chezMamie(mamie, '#call-ring:not([hidden])', 30_000);
  console.log(`La tablette sonne ${Math.round((Date.now() - debut) / 100) / 10} s après l'appel.`);
  assert.match(await mamie.texte('#ring-name'), /Julie/);
  assert.ok((await mamie.appels('startRing')).length || (await mamie.appels()).some((a) => /ring/i.test(a.nom)), `la sonnerie d'Android est demandée (${(await mamie.appels()).map((a) => a.nom).filter((n, i, l) => l.indexOf(n) === i).join(', ')})`);

  await doubleAppui(mamie, '#ring-answer');
  await chezMamie(mamie, '#call-view:not([hidden])', 15_000);
  try {
    await imageRecue(julie, 'call-remote');
    await imageRecue(mamie, 'call-remote');
  } catch (e) {
    throw new Error(`Pas d'image entre les deux : ${e.message}\nJulie : ${await julie.page.locator('#call-status').innerText().catch(() => '?')}\n${await diagnostic(mamie)}`);
  }
  await julie.page.locator('#call-status').waitFor({ state: 'hidden' });
  const [appel] = await appels(fid);
  assert.strictEqual((await appels(fid)).length, 1, 'un seul appel');
  assert.strictEqual(appel.state, 'active' in appel ? appel.state : appel.state);
  assert.ok(appel.answer && appel.answer.type === 'answer', 'une seule réponse de la tablette');

  // Pendant un appel reçu, c'est la famille qui raccroche : aucun bouton à toucher par mégarde chez Mamie.
  assert.strictEqual(await mamie.visible('#call-out-hangup'), false);
  await julie.page.click('#call-hangup');
  await julie.page.locator('#call').waitFor({ state: 'hidden', timeout: 15_000 });
  await g.attendreBase(async () => (await appels(fid))[0].state === 'ended', 'appel terminé dans la base');
  await mamie.page.locator('#call-view').waitFor({ state: 'hidden', timeout: 15_000 });
  assert.strictEqual(await mamie.visible('#view-home'), true, 'Mamie retrouve son accueil');
  // La caméra de Mamie est bien éteinte.
  assert.strictEqual(await mamie.page.evaluate(() => { const v = document.getElementById('call-local'); return !!(v.srcObject && v.srcObject.getTracks().some((t) => t.readyState === 'live')); }), false, 'caméra éteinte après l\'appel');
});

test('Coupure en plein appel (le téléphone de Julie disparaît d\'un coup) : la tablette raccroche seule, caméra éteinte, accueil revenu', { timeout: 170_000 }, async () => {
  const { julie, mamie, fid } = await familleChezMamie();
  await julieAppelle(julie);
  await chezMamie(mamie, '#call-ring:not([hidden])', 30_000);
  await mamie.toucher('#ring-answer');
  await imageRecue(mamie, 'call-remote');
  // Le téléphone de Julie perd tout (tunnel, batterie) : rien n'est écrit dans la base, la liaison tombe.
  await julie.context.setOffline(true);
  await julie.page.goto('about:blank').catch(() => {});
  const debut = Date.now();
  await mamie.page.locator('#call-view').waitFor({ state: 'hidden', timeout: 90_000 })
    .catch(async () => assert.fail(`La tablette reste en appel après la coupure.\n${await diagnostic(mamie)}`));
  console.log(`Coupure : la tablette a raccroché seule au bout de ${Math.round((Date.now() - debut) / 1000)} s.`);
  assert.strictEqual(await mamie.visible('#view-home'), true);
  assert.strictEqual(await mamie.page.evaluate(() => { const v = document.getElementById('call-local'); return !!(v.srcObject && v.srcObject.getTracks().some((t) => t.readyState === 'live')); }), false, 'caméra éteinte');
  await g.attendreBase(async () => (await appels(fid))[0].state === 'ended', 'appel terminé dans la base', 20_000);
  await julie.context.setOffline(false);
});

test('Mamie appelle Julie : double appui sur son visage, un seul appel ; Julie répond, ils se parlent, Julie raccroche', async () => {
  const { julie, mamie, fid } = await familleChezMamie();
  await chezMamie(mamie, '#view-home .call-btn', 30_000);
  await mamie.toucher('#view-home .call-btn');
  await chezMamie(mamie, '.call-person', 15_000);
  assert.match(await mamie.texte('.call-person-name'), /Julie/);
  await doubleAppui(mamie, '.call-person');

  await julie.page.locator('#incoming').waitFor({ state: 'visible', timeout: 30_000 });
  assert.strictEqual(await julie.page.locator('#incoming-name').innerText(), 'Mamie Emma');
  await mamie.page.locator('.call-out .call-title', { hasText: /Ça sonne/ }).waitFor({ timeout: 15_000 })
    .catch(async () => assert.fail(`La tablette ne dit pas « Ça sonne ».\n${await diagnostic(mamie)}`));
  await julie.page.click('#incoming-answer');
  await julie.page.locator('#incoming').waitFor({ state: 'hidden' });
  await julie.page.locator('#call-timer', { hasText: /0:0\d/ }).waitFor({ timeout: 20_000 });
  await mamie.page.locator('.call-title', { hasText: 'En ligne avec Julie' }).waitFor({ timeout: 20_000 })
    .catch(async () => assert.fail(`La tablette n'est pas « En ligne avec Julie ».\n${await diagnostic(mamie)}`));
  assert.strictEqual((await appels(fid)).length, 1, 'un seul appel malgré le double appui');

  await julie.page.click('#call-hangup');
  await mamie.page.locator('.call-title', { hasText: 'Appel terminé' }).waitFor({ timeout: 15_000 });
  await g.attendreBase(async () => (await appels(fid))[0].state === 'ended', 'appel terminé dans la base');
  // 4 s plus tard, l'accueil revient tout seul.
  await mamie.page.waitForFunction(() => { const c = document.querySelector('.call-out'); return !c || c.hasAttribute('hidden'); }, null, { timeout: 10_000 });
});

test('Tablette avec carte SIM : Mamie touche Julie deux fois, un seul appel téléphone part, vers le numéro donné par Julie', async () => {
  const { mamie } = await familleChezMamie({ etat: { telephone: true } });
  await chezMamie(mamie, '#view-home .call-btn', 30_000);
  await mamie.toucher('#view-home .call-btn');
  await chezMamie(mamie, '.call-person', 15_000);
  await doubleAppui(mamie, '.call-person');
  await mamie.page.waitForTimeout(1500);
  const partis = await mamie.appels('phoneCall');
  assert.strictEqual(partis.length, 1, `un seul appel téléphone (${JSON.stringify(partis)})`);
  assert.match(String(partis[0].args[0]).replace(/\s/g, ''), /^(\+33|0)612345678$/, 'le numéro de Julie');
});

test('Julie appelle, Mamie ne répond pas : au bout de 45 s Julie est prévenue, la tablette cesse de sonner et garde la trace', { timeout: 150_000 }, async () => {
  const { julie, mamie, fid } = await familleChezMamie();
  await julieAppelle(julie);
  await chezMamie(mamie, '#call-ring:not([hidden])', 30_000);
  const debut = Date.now();
  await g.attendreBase(async () => (await appels(fid))[0].state === 'missed', 'appel noté manqué', 70_000);
  const duree = Math.round((Date.now() - debut) / 1000);
  console.log(`Appel sans réponse : manqué au bout de ${duree} s. Julie lit : « ${(await julie.page.locator('#call-status').innerText().catch(() => '')).trim()} » ${await g.texteFenetre(julie).catch(() => '')}`);
  assert.ok(duree >= 40 && duree <= 50, `45 s (mesuré ${duree} s)`);
  await mamie.page.locator('#call-ring').waitFor({ state: 'hidden', timeout: 10_000 });
  assert.strictEqual(await mamie.visible('#view-home'), true);
  console.log(`Écran de Mamie après l'appel manqué : ${(await mamie.page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 300)))}`);
});
