// Le bouton SOS de la vraie tablette, jusqu'au téléphone de la famille : par internet (l'app de Julie sonne) et par
// la carte SIM (SMS à la famille puis appel). Un appui par erreur se rattrape, un double appui ne lance qu'un SOS.

const { test, assert, g, brancher, chezMamie, familleChezMamie, diagnostic, doubleAppui, enDirect } = require('../commun');

brancher();

const appels = (fid) => g.liste(`families/${fid}/calls`);
// L'heure qu'il est vraiment, à Paris (novembre : UTC+1), pour une horloge tenue par l'essai, à la bonne heure.
const maintenantAParis = () => new Date(Date.now() + 3600_000).toISOString().slice(0, 19);

test('SOS par internet : double appui, « Annuler » rattrape ; relancé, il part après 5 s, Julie décroche, un seul appel', { timeout: 200_000 }, async () => {
  const { julie, mamie, fid } = await familleChezMamie();
  await chezMamie(mamie, '#sos-btn', 30_000);
  await doubleAppui(mamie, '#sos-btn');
  await chezMamie(mamie, '.call-out.sos-countdown', 5_000);
  assert.match(await mamie.texte('.call-out .call-sub'), /L’appel part dans \d seconde/);
  await mamie.toucher('.sos-cancel');
  await mamie.page.waitForTimeout(6500);
  assert.deepStrictEqual(await appels(fid), [], 'annulé : aucun appel n\'est parti');
  assert.strictEqual(await mamie.visible('#view-home'), true);

  await mamie.toucher('#sos-btn');
  const debut = Date.now();
  await julie.page.locator('#incoming').waitFor({ state: 'visible', timeout: 40_000 })
    .catch(async () => assert.fail(`Le téléphone de Julie ne sonne pas pour le SOS.\n${await diagnostic(mamie)}`));
  const delai = Math.round((Date.now() - debut) / 1000);
  console.log(`SOS : le téléphone de Julie sonne ${delai} s après l'appui. Julie lit : « ${(await julie.page.locator('#incoming').innerText()).replace(/\s+/g, ' ')} »`);
  assert.ok(delai >= 4 && delai <= 15, `5 s de décompte puis l'appel (${delai} s)`);
  // App ouverte : l'écran dit « SOS », comme la notification (avant le 11/11 : « Appel Papote », comme un appel ordinaire).
  assert.match(await julie.page.locator('#incoming .incoming-kind').innerText(), /^SOS$/i, 'Julie voit que c\'est un SOS');
  await julie.page.click('#incoming-answer');
  await mamie.page.locator('.call-out .call-title', { hasText: 'En ligne avec Julie' }).waitFor({ timeout: 20_000 })
    .catch(async () => assert.fail(`La tablette n'est pas « En ligne avec Julie ».\n${await diagnostic(mamie)}`));
  const l = await appels(fid);
  assert.strictEqual(l.length, 1, 'un seul appel');
  assert.strictEqual(l[0].calleeName, 'SOS', 'l\'appel est marqué SOS pour le serveur');
  await julie.page.click('#call-hangup');
  await mamie.page.locator('.call-out .call-title', { hasText: 'Appel terminé' }).waitFor({ timeout: 15_000 });
});

test('SOS avec carte SIM : un SMS à la famille (le numéro donné par Julie), puis un appel téléphone vers elle', async () => {
  const { mamie } = await familleChezMamie({ etat: { telephone: true } });
  await chezMamie(mamie, '#sos-btn', 30_000);
  await doubleAppui(mamie, '#sos-btn');
  await chezMamie(mamie, '.call-out.sos-countdown', 5_000);
  await mamie.page.waitForFunction(() => window.__appels.some((a) => a.nom === 'phoneCall'), null, { timeout: 15_000 })
    .catch(async () => assert.fail(`Aucun appel téléphone après le décompte.\n${await diagnostic(mamie)}`));
  const sms = await mamie.appels('sendSms');
  assert.strictEqual(sms.length, 1, `un seul SMS (${JSON.stringify(sms)})`);
  assert.match(String(sms[0].args[0]).replace(/\s/g, ''), /^(\+33|0)612345678$/);
  assert.match(sms[0].args[1], /^SOS Papote : Mamie Emma a appuyé sur le bouton SOS de sa tablette\. Appelez-la vite\.$/);
  const tel = await mamie.appels('phoneCall');
  assert.strictEqual(tel.length, 1, 'un seul appel téléphone');
  assert.match(String(tel[0].args[0]).replace(/\s/g, ''), /^(\+33|0)612345678$/);
  assert.match(await mamie.texte('.call-out .call-title'), /SOS/);
});

// A47-2 : Mamie appuie encore sur SOS peu après (inquiète, ou personne ne l'a rassurée) : la famille a déjà le SMS,
// pas de deuxième dans les 10 minutes, même après un redémarrage de la tablette ; les appels, eux, repartent.
test('SOS appuyé plusieurs fois (carte SIM) : un seul SMS en 10 min, même tablette rallumée ; l\'appel vers Julie repart à chaque appui', { timeout: 220_000 }, async () => {
  // L'horloge de la page est tenue par l'essai : un SOS ne compte comme « répondu » qu'après 40 s en ligne (sinon la
  // messagerie du proche arrêterait la chaîne), on les fait passer d'un coup.
  const { mamie, uid } = await familleChezMamie({ etat: { telephone: true }, heure: maintenantAParis() });
  const appelsTel = () => mamie.appels('phoneCall');
  // Android dit à la page où en est l'appel téléphone (AppelGsm.java) : Julie décroche, parle, raccroche.
  const julieDecrocheEtRaccroche = async (numero) => {
    const julie = { numero, uid, name: 'Julie', sortant: true };
    await mamie.page.evaluate((x) => window.Papote.onGsm(x), { etat: 'enLigne', ...julie });
    await mamie.page.clock.fastForward('00:41');
    await mamie.page.evaluate((x) => window.Papote.onGsm(x), { etat: 'fin', cause: 'raccroche', ...julie });
    await mamie.page.locator('.call-out').waitFor({ state: 'hidden', timeout: 20_000 })
      .catch(async () => assert.fail(`L'écran du SOS reste affiché après l'appel.\n${await diagnostic(mamie)}`));
  };
  const sosPart = async (n) => {
    await chezMamie(mamie, '#sos-btn', 30_000);
    await mamie.toucher('#sos-btn');
    await mamie.page.waitForFunction((k) => window.__appels.filter((a) => a.nom === 'phoneCall').length >= k, n, { timeout: 20_000 })
      .catch(async () => assert.fail(`SOS n° ${n} : pas d'appel téléphone.\n${await diagnostic(mamie)}`));
  };

  await sosPart(1);
  assert.strictEqual((await mamie.appels('sendSms')).length, 1, 'le premier SOS envoie le SMS');
  const numero = (await appelsTel())[0].args[0];
  await julieDecrocheEtRaccroche(numero);

  // 2e appui, une minute plus tard : l'appel repart, pas le SMS ; l'écran dit que la famille l'a déjà.
  await sosPart(2);
  assert.strictEqual((await mamie.appels('sendSms')).length, 1, 'pas de deuxième SMS');
  assert.strictEqual((await appelsTel())[1].args[0], numero, 'Julie rappelée');
  assert.match(await mamie.texte('.call-out'), /reçu votre SOS par SMS/);
  await julieDecrocheEtRaccroche(numero);

  // Tablette éteinte et rallumée (coupure de courant) : l'heure du dernier SMS est gardée.
  await mamie.rallumer();
  await enDirect(mamie);
  await sosPart(1);
  assert.strictEqual((await mamie.appels('sendSms')).length, 0, 'toujours pas de deuxième SMS après le redémarrage');
  assert.strictEqual((await appelsTel())[0].args[0], numero);
  await julieDecrocheEtRaccroche(numero);
});
