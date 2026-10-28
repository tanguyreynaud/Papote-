// Appels : vidéo du téléphone vers la tablette (vraie liaison WebRTC avec une tablette simulée),
// appel de Mamie vers un proche ou toute la famille (audio, puis vidéo), refus, tablette occupée.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');
const tablette = require('../tablette');

const { s } = banc;

banc.brancher();

const appelsDe = async (fid, uid) => (await g.liste(`families/${fid}/calls`)).filter((c) => c.callerUid === uid);

async function lancerAppel(t) {
  await t.page.locator('#tile-call:not([disabled])').waitFor();
  await t.page.click('#tile-call');
  assert.match(await g.texteFenetre(t), /Appeler Mamie Emma en vidéo/);
  await g.repondre(t, 'Appeler');
  await t.page.locator('#call').waitFor({ state: 'visible' });
}

// Note chaque réglage de débit vidéo demandé par l'app (RTCRtpSender.setParameters).
const espionnerDebit = (tel) => tel.page.evaluate(() => {
  window.__debits = window.__debits || [];
  if (RTCRtpSender.prototype.setParameters.__espion) return;
  const vrai = RTCRtpSender.prototype.setParameters;
  RTCRtpSender.prototype.setParameters = function (params) {
    if (this.track && this.track.kind === 'video' && params.encodings && params.encodings[0]) {
      const { maxBitrate, maxFramerate, scaleResolutionDownBy } = params.encodings[0];
      window.__debits.push({ maxBitrate, maxFramerate, scaleResolutionDownBy });
    }
    return vrai.call(this, params);
  };
  RTCRtpSender.prototype.setParameters.__espion = true;
});
// Le dernier réglage noté, une fois qu'il vaut `debit`.
async function dernierDebit(tel, debit) {
  await tel.page.waitForFunction((d) => { const l = window.__debits || []; return l.length && l[l.length - 1].maxBitrate === d; }, debit, { timeout: 10_000 })
    .catch(async () => assert.fail(`débit attendu ${debit}, réglages notés : ${JSON.stringify(await tel.page.evaluate(() => window.__debits))}`));
  return tel.page.evaluate(() => window.__debits[window.__debits.length - 1]);
}

test('Appel vidéo vers la tablette : ça sonne, la tablette décroche, image reçue, on raccroche', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const uid = (await g.liste(`families/${fid}/members`)).find((m) => m.email === 'julie@exemple.fr').id;
  const mamie = await tablette.ouvrir(fid, tab);

  await lancerAppel(julie);
  await julie.page.locator('#call-status', { hasText: 'Ça sonne' }).waitFor();
  const [appel] = await g.attendreBase(async () => { const l = await appelsDe(fid, uid); return l.length && l; }, 'appel écrit');
  assert.strictEqual(appel.state, 'ringing');
  assert.strictEqual(appel.callerName, 'Julie');
  assert.strictEqual(appel.offer.type, 'offer');

  await tablette.decrocher(mamie, appel.id);
  // Liaison établie : plus de message, l'image de Mamie s'affiche.
  await julie.page.locator('#call-status').waitFor({ state: 'hidden' });
  await julie.page.waitForFunction(() => {
    const v = document.getElementById('call-remote');
    return v.srcObject && v.readyState >= 2 && v.videoWidth > 0;
  }, null, { timeout: 15_000 });
  assert.deepStrictEqual((await tablette.pistes(mamie)).sort(), ['audio', 'video'], 'la tablette reçoit le son et l\'image');

  // Cadrage de l'image de Mamie : entière avec la même vidéo floutée derrière quand l'écran a une autre forme,
  // plein écran quand on en couperait moins de 15 % ; Raccrocher toujours visible.
  const cadrage = () => julie.page.evaluate(() => {
    const video = document.getElementById('call-remote');
    const fond = document.getElementById('call-remote-fond');
    return {
      remplit: video.classList.contains('remplit'),
      ajustement: getComputedStyle(video).objectFit,
      memeImage: !!video.srcObject && fond.srcObject === video.srcObject,
      fondVisible: getComputedStyle(fond).display !== 'none',
    };
  });
  await julie.page.waitForFunction(() => document.getElementById('call-remote-fond').srcObject);
  assert.deepStrictEqual(await cadrage(), { remplit: false, ajustement: 'contain', memeImage: true, fondVisible: true }, 'téléphone : image entière sur fond flouté');
  assert.ok(await julie.page.locator('#call-hangup').isVisible(), 'Raccrocher visible');
  // L'appel vidéo passe en plein écran : le navigateur refuse alors de changer la taille de la page.
  await julie.page.evaluate(() => document.fullscreenElement && document.exitFullscreen());
  // Écran couché de la même forme que l'image reçue (la fausse caméra n'est pas forcément en 4:3).
  const { largeurImage, hauteurImage } = await julie.page.evaluate(() => {
    const v = document.getElementById('call-remote');
    return { largeurImage: v.videoWidth, hauteurImage: v.videoHeight };
  });
  await julie.page.setViewportSize({ width: 1000, height: Math.round((1000 * hauteurImage) / largeurImage) });
  await julie.page.waitForFunction(() => document.getElementById('call-remote').classList.contains('remplit'), null, { timeout: 5_000 })
    .catch(async () => assert.fail(`pas de plein écran : ${await julie.page.evaluate(() => {
      const v = document.getElementById('call-remote');
      const c = document.getElementById('call');
      return `image ${v.videoWidth}x${v.videoHeight}, appel ${c.clientWidth}x${c.clientHeight}, classes « ${c.className} »`;
    })}`));
  assert.deepStrictEqual(await cadrage(), { remplit: true, ajustement: 'cover', memeImage: true, fondVisible: false }, 'écran de même forme : plein écran');
  assert.ok(await julie.page.locator('#call-hangup').isVisible(), 'Raccrocher visible en plein écran');

  // Qualité de la vidéo envoyée selon le réseau de la tablette (answer.reseau, écrit par la tablette avec sa réponse).
  await espionnerDebit(julie);
  await tablette.ref(mamie, appel.id).update({ 'answer.reseau': 'wifi' });
  assert.deepStrictEqual(await dernierDebit(julie, 1_200_000), { maxBitrate: 1_200_000, maxFramerate: 20, scaleResolutionDownBy: 1 }, 'tablette en Wi-Fi : pleine qualité');
  await tablette.ref(mamie, appel.id).update({ 'answer.reseau': 'sim' });
  assert.deepStrictEqual(await dernierDebit(julie, 500_000), { maxBitrate: 500_000, maxFramerate: 15, scaleResolutionDownBy: 1.5 }, 'tablette sur SIM : économe');

  await julie.page.click('#call-hangup');
  await g.attendreBase(async () => (await tablette.ref(mamie, appel.id).get()).data().state === 'ended', 'appel terminé');
  await julie.page.locator('#call').waitFor({ state: 'hidden', timeout: 10_000 });
  await mamie.arreterRelais();
});

test('Appel refusé par la tablette : proposition de laisser un message vidéo ; raccrocher pendant la sonnerie', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const uid = (await g.liste(`families/${fid}/members`)).find((m) => m.email === 'julie@exemple.fr').id;

  await lancerAppel(julie);
  const [appel] = await g.attendreBase(async () => { const l = await appelsDe(fid, uid); return l.length && l; }, 'appel écrit');
  await s.db.doc(`families/${fid}/calls/${appel.id}`).update({ state: 'declined', endedAt: s.FieldValue.serverTimestamp() });
  await julie.page.locator('#call-status', { hasText: 'L\'appel a été refusé' }).waitFor();
  assert.match(await g.texteFenetre(julie), /Mamie Emma ne peut pas répondre pour le moment\. Lui laisser un message vidéo/);
  await g.repondre(julie, 'Annuler');
  await g.attendreVue(julie, 'view-home');

  // Raccrocher pendant que ça sonne : l'appel s'arrête aussi chez Mamie.
  await lancerAppel(julie);
  await julie.page.locator('#call-status', { hasText: 'Ça sonne' }).waitFor();
  await julie.page.click('#call-hangup');
  await g.attendreBase(async () => (await appelsDe(fid, uid)).filter((c) => c.state === 'ended').length === 1, 'appel annulé');
  await julie.page.locator('#call').waitFor({ state: 'hidden', timeout: 10_000 });
});

test('Mamie appelle Julie : sonnerie, réponse audio, passage en vidéo, Mamie raccroche', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const uid = (await g.liste(`families/${fid}/members`)).find((m) => m.email === 'julie@exemple.fr').id;
  const mamie = await tablette.ouvrir(fid, tab);

  const cid = await tablette.appeler(mamie, { vers: uid });
  await julie.page.locator('#incoming').waitFor({ state: 'visible' });
  assert.strictEqual(await julie.page.locator('#incoming-name').innerText(), 'Mamie Emma');
  // Tablette sur SIM : la vidéo envoyée en passant en vidéo reste économe.
  await tablette.ref(mamie, cid).update({ 'offer.reseau': 'sim' });
  await espionnerDebit(julie);
  await julie.page.click('#incoming-answer');
  const reponse = await tablette.prendreReponse(mamie, cid);
  assert.deepStrictEqual([reponse.uid, reponse.name], [uid, 'Julie']);
  await julie.page.locator('#incoming').waitFor({ state: 'hidden' });
  await julie.page.locator('#call-timer', { hasText: /0:0\d/ }).waitFor();
  assert.strictEqual(await julie.page.locator('#call-name').innerText(), 'Mamie Emma');

  // « Passer en vidéo » : la caméra s'allume, la tablette est prévenue.
  await julie.page.click('#call-video');
  await g.attendreBase(async () => (await tablette.ref(mamie, cid).get()).data().answer.video === true, 'vidéo signalée');
  await julie.page.waitForFunction(() => document.getElementById('call-local').srcObject);
  assert.deepStrictEqual(await dernierDebit(julie, 500_000), { maxBitrate: 500_000, maxFramerate: 15, scaleResolutionDownBy: 1.5 }, 'tablette sur SIM : vidéo économe');

  await tablette.raccrocher(mamie, cid);
  await julie.page.locator('#call-status', { hasText: 'Appel terminé' }).waitFor();
  await julie.page.locator('#call').waitFor({ state: 'hidden', timeout: 10_000 });
});

test('Mamie appelle toute la famille : Paul répond, la sonnerie s\'arrête chez Julie, tablette occupée', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const paul = await banc.telephone('Paul');
  await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });
  const mamie = await tablette.ouvrir(fid, tab);

  const cid = await tablette.appeler(mamie);
  await julie.page.locator('#incoming').waitFor({ state: 'visible' });
  await paul.page.locator('#incoming').waitFor({ state: 'visible' });
  await paul.page.click('#incoming-answer');
  await tablette.prendreReponse(mamie, cid);
  await julie.page.locator('#incoming').waitFor({ state: 'hidden' });
  // Pendant l'appel, Julie voit que la tablette est occupée.
  await julie.page.locator('#tile-call', { hasText: 'Déjà en appel' }).waitFor();
  assert.strictEqual(await julie.page.locator('#tile-call').isDisabled(), true);

  await paul.page.click('#call-hangup');
  await g.attendreBase(async () => (await tablette.ref(mamie, cid).get()).data().state === 'ended', 'appel terminé');
  await julie.page.locator('#tile-call', { hasText: 'Appel vidéo' }).waitFor();
  await mamie.arreterRelais();
});

test('Refuser l\'appel de Mamie : il s\'arrête pour la tablette', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const mamie = await tablette.ouvrir(fid, tab);
  const cid = await tablette.appeler(mamie);
  await julie.page.locator('#incoming').waitFor({ state: 'visible' });
  await julie.page.click('#incoming-decline');
  await julie.page.locator('#incoming').waitFor({ state: 'hidden' });
  await g.attendreBase(async () => (await tablette.ref(mamie, cid).get()).data().state === 'declined', 'appel refusé');
  await mamie.arreterRelais();
});
