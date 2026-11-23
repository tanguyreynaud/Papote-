// La nuit chez Mamie (veille réglée par la famille, entre 19 h et 10 h) : l'écran s'éteint, une photo envoyée le soir attend le matin sans
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
  // La veille ne se règle plus qu'entre 19 h et 23 h 30 (coucher) et 5 h et 10 h (réveil), bornes que la tablette
  // applique aussi (17/11) : l'essai ne la cale plus sur l'heure qu'il est. La tablette est mise dans un fuseau où il
  // est 21 h passées (même minute qu'à Paris) ; l'horloge, elle, n'est pas truquée : tablette, comptes et serveur
  // ont la même heure. Le soir, nuit de 19 h à 5 h ; le matin, de 23 h à 5 h, qui ne couvre plus 21 h.
  // Fuseau choisi d'après l'heure qu'il est : à moins de 3 min d'une heure pile, on attend l'heure suivante, sinon la
  // tablette peut déjà être à 22 h quand on la regarde (lot j, 22/11, essai lancé vers 0 h 59 UTC : 22 !== 21).
  const maintenant = new Date();
  if (maintenant.getUTCMinutes() >= 57) await new Promise((r) => setTimeout(r, (60 - maintenant.getUTCMinutes()) * 60e3 - maintenant.getUTCSeconds() * 1e3 + 2000));
  const utc = new Date().getUTCHours();
  const decalage = ((21 - utc) % 24 + 24) % 24;
  const ecart = decalage > 14 ? decalage - 24 : decalage;
  const fuseau = ecart === 0 ? 'Etc/UTC' : `Etc/GMT${ecart > 0 ? '-' : '+'}${Math.abs(ecart)}`;
  const { julie, mamie, fid } = await familleChezMamie({ fuseau });
  assert.strictEqual(await mamie.page.evaluate(() => new Date().getHours()), 21, `21 h sur la tablette (${fuseau})`);
  await s.db.doc(`families/${fid}`).update({ veille: { active: true, de: 19, a: 5 } });
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
  await julie.page.click('.nav-item[data-tab="home"]'); // Photos : la barre du bas, plus de flèche (cohérence, 23/11)
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
  await s.db.doc(`families/${fid}`).update({ veille: { active: true, de: 23, a: 5 } });
  await mamie.pont('changed').catch(() => {});
  await attendreSommeil(mamie, false, 150_000);
  await chezMamie(mamie, '#overlay:not([hidden])', 60_000);
  assert.match(await enGrand(mamie), /Bonne nuit Mamie 🌙/);
  await mamie.toucher('#overlay-close');
  await g.attendreBase(async () => (await g.liste(`families/${fid}/posts`)).every((p) => p.seenAt), 'photo vue le matin', 30_000);
});
