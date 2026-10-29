// Garde-fou du forfait SIM de la tablette (Forfait.java) : l'accueil prévient à 80 %, et l'appel suit le
// régime écrit par la tablette dans sa réponse (eco : image réduite ; audio : appel sans image).

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');
const tablette = require('../tablette');

const { s } = banc;

banc.brancher();

const ficheTablette = async (fid) => (await g.liste(`families/${fid}/members`)).find((m) => m.role === 'tablette');

test('Forfait de la tablette : rien avant 80 %, puis l\'accueil explique l\'image réduite et l\'appel sans image', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const tab = await ficheTablette(fid);
  const ref = s.db.doc(`families/${fid}/members/${tab.id}`);
  const sim = (dataCycleMo, niveau) => ref.update({
    lastOnline: s.Timestamp.now(), lastActive: s.Timestamp.now(),
    sim: { operateur: 'Lyca', dataMoisMo: dataCycleMo, dataCycleMo, plafondMo: 1000, niveau, cycleDebut: '2026-10-28', vuLe: s.Timestamp.now() },
  });
  await sim(750, 1);
  await julie.page.locator('#activity', { hasText: 'Tablette en ligne' }).waitFor();
  await sim(820, 1);
  await julie.page.locator('#activity.warn', { hasText: 'forfait internet de la tablette de Mamie Emma est utilisé à 82 %' }).waitFor();
  assert.match(await julie.page.locator('#activity').textContent(), /image réduite jusqu'à sa recharge, et passeront sans image à 95 %/);
  await sim(900, 2);
  await julie.page.locator('#activity.warn', { hasText: 'utilisé à 90 %' }).waitFor();
  assert.match(await julie.page.locator('#activity').textContent(), /image très réduite jusqu'à sa recharge, et passeront sans image à 95 %/);
  await sim(960, 3);
  await julie.page.locator('#activity.warn', { hasText: 'utilisé à 96 %' }).waitFor();
  assert.match(await julie.page.locator('#activity').textContent(), /appels passent sans image et les vidéos attendent le Wi-Fi/);
  await sim(900, 2);
  await julie.page.locator('#activity.warn', { hasText: 'utilisé à 90 %' }).waitFor();
  await julie.page.click('#tablet-chip');
  assert.match(await g.texteFenetre(julie), /Forfait internet : 900 Mo sur 1 Go depuis le 28 octobre\./);
});

test('Appel vers la tablette au forfait presque épuisé : image réduite, puis appel sans image expliqué', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const mamie = await tablette.ouvrir(fid, tab);
  await julie.page.locator('#tile-call:not([disabled])').waitFor();
  await julie.page.click('#tile-call');
  await g.repondre(julie, 'Appeler');
  const appel = await g.attendreBase(async () => (await g.liste(`families/${fid}/calls`))[0], 'appel écrit');
  await tablette.decrocher(mamie, appel.id);
  await julie.page.locator('#call-status').waitFor({ state: 'hidden' });

  await julie.page.evaluate(() => {
    window.__debits = [];
    const vrai = RTCRtpSender.prototype.setParameters;
    RTCRtpSender.prototype.setParameters = function (params) {
      if (this.track && this.track.kind === 'video' && params.encodings && params.encodings[0]) window.__debits.push({ ...params.encodings[0] });
      return vrai.call(this, params);
    };
  });
  const dernier = () => julie.page.evaluate(() => window.__debits[window.__debits.length - 1] || null);
  await tablette.ref(mamie, appel.id).update({ 'answer.reseau': 'sim', 'answer.regime': 'eco' });
  await julie.page.waitForFunction(() => (window.__debits || []).some((d) => d.maxBitrate === 300_000));
  const eco = await dernier();
  assert.deepStrictEqual([eco.maxBitrate, eco.maxFramerate, eco.scaleResolutionDownBy, eco.active], [300_000, 12, 1.5, true], 'image réduite à 70 %');
  await julie.page.locator('#call-status', { hasText: 'utilisé à 70 %' }).waitFor();

  await tablette.ref(mamie, appel.id).update({ 'answer.regime': 'mini' });
  await julie.page.waitForFunction(() => (window.__debits || []).some((d) => d.maxBitrate === 150_000));
  const mini = await dernier();
  assert.deepStrictEqual([mini.maxBitrate, mini.maxFramerate, mini.scaleResolutionDownBy, mini.active], [150_000, 10, 2, true], 'image très réduite à 88 %');
  await julie.page.locator('#call-status', { hasText: 'utilisé à 88 %' }).waitFor();
  assert.ok(!(await julie.page.locator('#call').evaluate((c) => c.classList.contains('audio'))), 'toujours en vidéo');

  await tablette.ref(mamie, appel.id).update({ 'answer.regime': 'audio' });
  await julie.page.locator('#call-status', { hasText: 'Appel sans image : le forfait internet de la tablette est presque épuisé.' }).waitFor();
  assert.ok(await julie.page.locator('#call').evaluate((c) => c.classList.contains('audio')), 'écran d\'appel audio (photo et nom)');
  await julie.page.waitForFunction(() => (window.__debits || []).some((d) => d.active === false));
  assert.ok(await julie.page.locator('#call-hangup').isVisible(), 'Raccrocher visible');

  await julie.page.click('#call-hangup');
  await julie.page.locator('#call').waitFor({ state: 'hidden', timeout: 10_000 });
  await mamie.arreterRelais();
});
