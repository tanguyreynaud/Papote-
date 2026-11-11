// La nuit chez Mamie (veille de 21 h à 6 h 30) : l'écran s'éteint, une photo envoyée le soir attend le matin sans
// rien allumer, mais un appel de la famille sonne quand même et l'écran se rendort après.

const { test, assert, g, s, brancher, chezMamie, familleChezMamie, envoyerPhoto, enGrand, diagnostic } = require('../commun');

brancher();

const endormie = (mamie) => mamie.page.evaluate(() => {
  const h = document.querySelector('.night-clock');
  if (!h) return false;
  const e = h.parentNode;
  return getComputedStyle(e).display !== 'none' && Number(getComputedStyle(e).opacity) > 0.9;
});
const attendreSommeil = (mamie, oui, delai = 20_000) => g.attendreBase(async () => (await endormie(mamie)) === oui, oui ? 'la tablette s\'endort' : 'la tablette se réveille', delai)
  .catch(async (e) => { throw new Error(`${e.message}\n${await diagnostic(mamie)}`); });

test('La nuit : écran en veille ; une photo attend le matin sans rien allumer ; un appel sonne quand même ; le matin, la photo s\'affiche', { timeout: 300_000 }, async () => {
  const { julie, mamie, fid } = await familleChezMamie();
  // La famille règle la veille sur l'heure qu'il est (même forme que l'app : families/{fid}.veille, en heures) :
  // pour la tablette, c'est la nuit. L'horloge n'est pas truquée : la tablette et le serveur ont la même heure.
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Paris' }).format(new Date())) % 24;
  assert.ok(Number.isInteger(h), `heure de Paris (${h})`);
  await s.db.doc(`families/${fid}`).update({ veille: { active: true, de: h, a: (h + 3) % 24 } });
  await mamie.pont('changed').catch(() => {});
  await attendreSommeil(mamie, true, 150_000);
  assert.match((await mamie.texte('.night-clock')).trim(), /^\d{1,2}:\d\d$/, 'l\'heure, en petit, sur l\'écran de nuit');

  // Julie envoie une photo tard le soir : rien ne s'allume.
  await envoyerPhoto(julie, { texte: 'Soir', legende: 'Bonne nuit Mamie 🌙' });
  await g.attendreBase(async () => { const e = mamie.envois(); return e && e.posts && e.posts.some((p) => p.text === 'Bonne nuit Mamie 🌙'); }, 'la photo est arrivée sur la tablette', 60_000);
  await mamie.page.waitForTimeout(4000);
  assert.strictEqual(await endormie(mamie), true, 'la photo ne réveille pas l\'écran');
  assert.deepStrictEqual((await mamie.appels('setSleep')).map((x) => x.args[0]).slice(-1), [true], 'Android garde l\'écran baissé');
  assert.ok(!(await g.liste(`families/${fid}/posts`))[0].seenAt, 'pas « Vu » pendant que Mamie dort');

  // Un appel en pleine nuit sonne et se voit.
  await julie.page.click('#view-photos .back');
  await g.attendreVue(julie, 'view-home');
  await julie.page.locator('#tile-call:not([disabled])').waitFor({ timeout: 30_000 });
  await julie.page.click('#tile-call');
  await g.repondre(julie, 'Appeler');
  await chezMamie(mamie, '#call-ring:not([hidden])', 30_000);
  await attendreSommeil(mamie, false);
  await julie.page.click('#call-hangup');
  await mamie.page.locator('#call-ring').waitFor({ state: 'hidden', timeout: 15_000 });

  // L'écran se rendort après l'appel (2 minutes sans toucher au plus).
  await attendreSommeil(mamie, true, 150_000);

  // Le matin (la veille ne couvre plus l'heure qu'il est) : la photo du soir s'affiche en grand.
  await s.db.doc(`families/${fid}`).update({ veille: { active: true, de: (h + 5) % 24, a: (h + 8) % 24 } });
  await mamie.pont('changed').catch(() => {});
  await attendreSommeil(mamie, false, 150_000);
  await chezMamie(mamie, '#overlay:not([hidden])', 60_000);
  assert.match(await enGrand(mamie), /Bonne nuit Mamie 🌙/);
  await mamie.toucher('#overlay-close');
  await g.attendreBase(async () => (await g.liste(`families/${fid}/posts`)).every((p) => p.seenAt), 'photo vue le matin', 30_000);
});
