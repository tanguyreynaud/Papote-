// « Installer la carte SIM » (Tanguy, 13/11 ; sim-installation.js) : l'admin envoie un ordre à la tablette par son
// code (pairings/{code}.ordre), la tablette répond (pairings/{code}.simTest, écrit comme l'appli de la tablette), le
// déclencheur recopie le résultat sur la fiche du stock. Code renouvelé avant la réponse : l'ordre suit. Pas de colis
// déposé, de remise en main propre ni d'étiquette sans test réussi.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher } = require('./commun');

brancher();

async function tabletteAvecCarte() {
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: `claire${Date.now()}@exemple.fr` });
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { commande: id } }, a.TANGUY);
  const simId = await a.simSurTablette(t, { testee: false });
  const { iccid } = await s.lire(`sims/${simId}`);
  return { t, id, simId, iccid };
}
const ordre = (t, type = 'simTest') => s.appeler('gestionStock', { action: 'simOrdre', stock: t.fiche, type }, a.TANGUY);
const etat = (t) => s.appeler('gestionStock', { action: 'simEtat', stock: t.fiche }, a.TANGUY);

test('carte SIM : sans code affiché, refus clair ; ordre dans le code le plus récent ; résultat recopié ; colis déposé ensuite', async () => {
  const { t, id, iccid } = await tabletteAvecCarte();
  await assert.rejects(ordre(t), /n'affiche pas encore son code/);
  // Pas de colis, ni de remise, ni d'étiquette avant le test.
  await assert.rejects(s.appeler('tabletteEnvoyee', { commande: id, suivi: '12345678', tablette: t.ref }, a.TANGUY), /Testez d'abord la carte SIM/);
  await assert.rejects(s.appeler('tabletteEnvoyee', { commande: id, mainPropre: true }, a.TANGUY), /Testez d'abord la carte SIM/);
  await assert.rejects(s.appeler('gestionEtiquette', { commande: id, sens: 'aller' }, a.TANGUY), /Testez d'abord la carte SIM/);

  const ancien = await a.afficherCode(t);
  const code = await a.afficherCode(t);
  const r = await ordre(t);
  assert.strictEqual(r.code, code, 'le code le plus récent');
  assert.strictEqual((await s.lire(`pairings/${ancien}`)).ordre, undefined);
  const o = (await s.lire(`pairings/${code}`)).ordre;
  assert.deepStrictEqual(Object.keys(o).sort(), ['demandeLe', 'id', 'simAttendue', 'type']);
  assert.strictEqual(o.type, 'simTest');
  assert.strictEqual(o.simAttendue, iccid);
  assert.strictEqual(o.id, r.id);
  // Double appui : le même ordre.
  const r2 = await ordre(t);
  assert.strictEqual(r2.id, r.id);
  assert.strictEqual(r2.deja, true);
  assert.strictEqual((await etat(t)).verdict.attente, true);

  // La tablette ne trouve pas de carte, puis la bonne carte est mise.
  await a.repondreOrdreSim(t, { etat: 'absente', iccid: null, mcc: null, mnc: null, operateur: null, inscrite: false, donnees: { ok: false, ms: null } });
  let e = await etat(t);
  assert.strictEqual(e.verdict.ok, false);
  assert.match(e.verdict.message, /Aucune carte détectée/);
  assert.strictEqual((await s.lire(`stock/${t.fiche}`)).simTest.ok, false);
  const r3 = await ordre(t);
  assert.notStrictEqual(r3.id, r.id, 'déjà répondu : nouvel ordre');
  await a.repondreOrdreSim(t);
  e = await etat(t);
  assert.strictEqual(e.verdict.ok, true, e.verdict.message);
  assert.deepStrictEqual(e.verdict.coches, { carte: true, reseau: true, inscrite: true, internet: true });
  const fiche = await s.lire(`stock/${t.fiche}`);
  assert.strictEqual(fiche.simTest.ok, true);
  assert.strictEqual(fiche.simTest.simAttendue, iccid);
  assert.strictEqual(fiche.simTest.ordre, r3.id);

  await s.appeler('tabletteEnvoyee', { commande: id, suivi: '12345678', tablette: t.ref }, a.TANGUY);
  assert.strictEqual((await s.lire(`commandes/${id}`)).expedition, 'envoyee');
});

test('carte SIM : code renouvelé avant la réponse (ordre reporté), retrait du code PIN puis test « -apres-pin », mauvaise carte', async () => {
  const { t, simId } = await tabletteAvecCarte();
  const premier = await a.afficherCode(t);
  const r = await ordre(t, 'simPin');
  assert.strictEqual((await s.lire(`pairings/${premier}`)).ordre.type, 'simPin');
  // Un quart d'heure plus tard, la tablette affiche un nouveau code : l'ordre y est recopié.
  s.avancer(15 / 1440);
  const second = await a.afficherCode(t);
  const reporte = (await s.lire(`pairings/${second}`)).ordre;
  // Un « Retirer le code PIN » déjà parti est reporté comme le test qui le suit (la tablette exécute un id une fois).
  assert.strictEqual(reporte.id, `${r.id}-apres-pin`);
  assert.strictEqual(reporte.type, 'simTest');
  assert.strictEqual((await s.lire(`stock/${t.fiche}`)).simOrdre.code, second);
  // Une autre tablette qui recopie ce n° de série ne reçoit rien.
  await s.db.doc('pairings/INTRUS22').set({
    status: 'waiting', tabletUid: 'intrus', callsUid: 'intrus2', name: 'Tablette', serie: t.serie,
    expiresAt: s.Timestamp.fromMillis(Date.now() + 20 * 60_000), createdAt: s.FieldValue.serverTimestamp(),
  });
  await s.calme();
  assert.strictEqual((await s.lire('pairings/INTRUS22')).ordre, undefined);
  // … et son résultat n'est pas recopié.
  await s.db.doc('pairings/INTRUS22').update({ simTest: { id: `${r.id}-apres-pin`, le: s.FieldValue.serverTimestamp(), etat: 'ok', iccid: '0', mcc: '208', donnees: { ok: true, ms: 1 } } });
  await s.calme();
  assert.strictEqual((await s.lire(`stock/${t.fiche}`)).simTest, undefined);

  // Code PIN retiré, puis le test enchaîné par la tablette.
  await a.repondreOrdreSim(t, {}, { code: second, id: `${r.id}-apres-pin` });
  const e = await etat(t);
  assert.strictEqual(e.verdict.ok, true, e.verdict.message);
  assert.strictEqual((await s.lire(`stock/${t.fiche}`)).simTest.id, `${r.id}-apres-pin`);
  // Le résultat a été écrit : pas de report sur un code suivant.
  s.avancer(15 / 1440);
  const troisieme = await a.afficherCode(t);
  assert.strictEqual((await s.lire(`pairings/${troisieme}`)).ordre, undefined);

  // Une autre carte mise dans la tablette (la fiche de la carte changée) : l'envoi redemande un test.
  await s.appeler('gestionSim', { action: 'modifier', id: simId, champs: { iccid: '8933209999999999999' } }, a.TANGUY);
  const ver = await etat(t);
  assert.strictEqual(ver.verdict.ok, false);
  const r2 = await ordre(t);
  await a.repondreOrdreSim(t, { iccid: '8933201111111111111' }, { code: troisieme });
  const mauvaise = await etat(t);
  assert.strictEqual(mauvaise.verdict.ok, false);
  assert.strictEqual(mauvaise.verdict.coches.carte, false);
  assert.match(mauvaise.verdict.message, /Ce n'est pas la carte choisie/);
  assert.strictEqual((await s.lire(`stock/${t.fiche}`)).simTest.ordre, r2.id);
});

// Numéro d'essai noté (Tanguy, 17/11) : la tablette envoie un SMS puis appelle ce portable pendant le test. Numéro
// fictif : le dépôt est public.
test('carte SIM avec numéro d\'essai : l\'ordre porte l\'appel, SMS et appel exigés pour l\'envoi, reportés avec l\'ordre', async () => {
  const numero = (n) => s.appeler('gestionStock', { action: 'simNumero', numero: n }, a.TANGUY);
  await assert.rejects(numero('01 23 45 67 89'), /portable français, qui commence par 06 ou 07/);
  assert.deepStrictEqual(await numero('06 12 34 56 78'), { ok: true, numero: '06 12 34 56 78' });
  assert.strictEqual((await s.lire('gestion/reglages')).numeroEssai, '+33612345678');
  try {
    const { t, id } = await tabletteAvecCarte();
    await a.afficherCode(t);
    const r = await ordre(t);
    assert.strictEqual(r.appel, true);
    const o = (await s.lire(`pairings/${t.code}`)).ordre;
    assert.deepStrictEqual(o.appel, { numero: '+33612345678', secondes: 20, texte: `Papote : test de la carte SIM de ${t.ref}` });
    let e = await etat(t);
    assert.strictEqual(e.numero, '06 12 34 56 78');
    assert.match(e.verdict.message, /appelle votre portable/);
    // 60 s sans réponse : encore normal avec l'appel (90 s).
    s.avancer(60 / 86400);
    assert.match((await etat(t)).verdict.message, /appelle votre portable/);

    // Carte qui marche mais appel refusé par le réseau : pas d'envoi.
    await a.repondreOrdreSim(t, { appel: { ok: false, secondes: 0, raison: 'refuse' } });
    e = await etat(t);
    assert.strictEqual(e.verdict.ok, false);
    assert.deepStrictEqual(e.verdict.coches, { carte: true, reseau: true, inscrite: true, internet: true, sms: true, appel: false });
    assert.match(e.verdict.message, /n'a pas laissé passer l'appel/);
    const fiche = await s.lire(`stock/${t.fiche}`);
    assert.deepStrictEqual([fiche.simTest.ok, fiche.simTest.avecAppel, fiche.simTest.appel.raison], [false, true, 'refuse']);
    await assert.rejects(s.appeler('tabletteEnvoyee', { commande: id, mainPropre: true }, a.TANGUY), /Testez d'abord la carte SIM/);

    // « Retirer le code PIN », code renouvelé : le test « -apres-pin » reporté garde l'appel ; SMS et appel passés.
    const pin = await ordre(t, 'simPin');
    assert.ok((await s.lire(`pairings/${t.code}`)).ordre.appel);
    s.avancer(15 / 1440);
    const second = await a.afficherCode(t);
    const reporte = (await s.lire(`pairings/${second}`)).ordre;
    assert.strictEqual(reporte.id, `${pin.id}-apres-pin`);
    assert.strictEqual(reporte.appel.numero, '+33612345678');
    await a.repondreOrdreSim(t, {}, { code: second, id: `${pin.id}-apres-pin` });
    e = await etat(t);
    assert.strictEqual(e.verdict.ok, true, e.verdict.message);
    assert.match(e.verdict.message, /SMS parti et appel passé/);
    assert.deepStrictEqual((await s.lire(`stock/${t.fiche}`)).simTest.sms, { ok: true, code: -1, ms: 1800 });
    await s.appeler('tabletteEnvoyee', { commande: id, mainPropre: true }, a.TANGUY);
  } finally {
    // Numéro retiré : les autres parcours testent sans SMS ni appel.
    assert.deepStrictEqual(await numero(''), { ok: true, numero: '' });
  }
  assert.strictEqual((await s.lire('gestion/reglages')).numeroEssai, '');
});
