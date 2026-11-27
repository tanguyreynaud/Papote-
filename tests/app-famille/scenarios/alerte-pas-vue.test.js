// Délai de l'alerte « pas vue » (functions/alertes.js, chaque jour à 10 h), réglé dans Réglages > La tablette, carte
// « Alerte si la tablette n'est pas utilisée » : de 1 à 5 jours, 5 par défaut (Tanguy, 21/11 ; 2 avant). Un responsable le
// change, il reste après actualisation, un double appui n'écrit qu'une fois ; un proche ne le voit pas et ne peut pas
// l'écrire (firestore.rules), et une valeur hors bornes écrite par erreur s'affiche ramenée.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

const { s } = banc;

banc.brancher();

const CARTE = 'alerte-pas-vue-card';
const valeur = (t) => t.page.locator('#alerte-pas-vue-value');
async function modifier(t) {
  await t.page.click(`#${CARTE} .setting-modify`);
  await t.page.locator(`#${CARTE} .setting-edit`).waitFor({ state: 'visible' });
}
const coche = (t) => t.page.locator('#alerte-pas-vue-liste').inputValue();
const LISTE = '#form-alerte-pas-vue .liste-papote';

test('Alerte « pas vue » : 5 jours par défaut, 3 jours choisis (double appui = une écriture), gardés après actualisation', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await g.ouvrirTuile(julie, 'settings');
  await julie.page.locator(`#${CARTE} h2`, { hasText: 'Tablette pas utilisée' }).waitFor();
  assert.strictEqual(await valeur(julie).innerText(), 'Alerte aux responsables après 5 jours');
  assert.strictEqual((await g.lire(`families/${fid}`)).alertePasVueJours, undefined, 'rien d\'écrit tant qu\'on ne choisit pas');

  await modifier(julie);
  const form = julie.page.locator('#form-alerte-pas-vue');
  assert.match(await form.innerText(), /Prévenir les responsables si la tablette n'est pas utilisée depuis :/);
  // Une liste déroulante Papote (Tanguy, 27/11 : « pourquoi faire 5 choix »), ouverte sous le champ.
  assert.strictEqual((await julie.page.locator(LISTE).innerText()).trim(), '5 jours', '5 jours par défaut');
  await julie.page.click(LISTE);
  assert.deepStrictEqual(await julie.page.locator('.liste-papote-menu .liste-papote-choix').allInnerTexts(),
    ['1 jour', '2 jours', '3 jours', '4 jours', '5 jours']);
  await julie.page.keyboard.press('Escape');
  assert.strictEqual(await coche(julie), '5', '5 jours choisi par défaut');

  // 3 jours, double appui sur Enregistrer : un message, une seule écriture (rev +1).
  await s.calme();
  const revAvant = (await g.lire(`families/${fid}`)).rev || 0;
  await g.choisirDansListe(julie, LISTE, '3 jours');
  await g.doubleAppui(julie, `#${CARTE} .setting-edit button[type=submit]`);
  await g.toast(julie, 'Alerte enregistrée : après 3 jours');
  await g.attendreBase(async () => (await g.lire(`families/${fid}`)).alertePasVueJours === 3, '3 jours écrits');
  await julie.page.waitForTimeout(1500);
  await s.calme();
  assert.strictEqual(((await g.lire(`families/${fid}`)).rev || 0) - revAvant, 1, 'une seule écriture');
  await valeur(julie).filter({ hasText: 'Alerte aux responsables après 3 jours' }).waitFor();
  assert.strictEqual(await julie.page.locator(`#${CARTE} .setting-edit`).isVisible(), false, 'refermée après l\'enregistrement');

  // Page rechargée : toujours 3 jours, coché à la réouverture.
  await julie.page.reload();
  await g.attendreVue(julie, 'view-home');
  await g.ouvrirTuile(julie, 'settings');
  await valeur(julie).filter({ hasText: 'après 3 jours' }).waitFor();
  await modifier(julie);
  assert.strictEqual(await coche(julie), '3');
  // Annuler ne change rien.
  await g.choisirDansListe(julie, LISTE, '5 jours');
  await julie.page.click(`#${CARTE} .setting-cancel`);
  await julie.page.waitForTimeout(500);
  assert.strictEqual((await g.lire(`families/${fid}`)).alertePasVueJours, 3);
  await valeur(julie).filter({ hasText: 'après 3 jours' }).waitFor();

  // 1 jour, au singulier.
  await modifier(julie);
  assert.strictEqual(await coche(julie), '3', 'rouverte sur la valeur enregistrée, pas sur le choix annulé');
  await g.choisirDansListe(julie, LISTE, '1 jour');
  await julie.page.click(`#${CARTE} .setting-edit button[type=submit]`);
  await g.toast(julie, 'Alerte enregistrée : après 1 jour');
  await g.attendreBase(async () => (await g.lire(`families/${fid}`)).alertePasVueJours === 1, '1 jour écrit');
  await valeur(julie).filter({ hasText: /après 1 jour$/ }).waitFor();

  // Valeur hors bornes écrite par erreur (outil, ancienne version) : affichée ramenée, comme le serveur la lit.
  await s.db.doc(`families/${fid}`).update({ alertePasVueJours: 9 });
  await valeur(julie).filter({ hasText: 'après 5 jours' }).waitFor();
  await s.db.doc(`families/${fid}`).update({ alertePasVueJours: 2 });
  await valeur(julie).filter({ hasText: 'après 2 jours' }).waitFor();
  await s.db.doc(`families/${fid}`).update({ alertePasVueJours: 'trois' });
  await valeur(julie).filter({ hasText: 'après 5 jours' }).waitFor();
});

test('Alerte « pas vue » : un proche (pas responsable) ne voit pas le réglage et ne peut pas l\'écrire', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const paul = await banc.telephone('Paul');
  await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });
  await g.ouvrirFamille(paul);
  await paul.page.locator('#tablet-owner-note').waitFor();
  assert.strictEqual(await paul.page.locator(`#${CARTE}`).isVisible(), false, 'carte cachée pour un proche');

  // Même en écrivant directement dans la base depuis son téléphone : refusé par les règles.
  const code = await paul.page.evaluate(async (fid) => {
    const { db } = await import(`${location.origin}/js/firebase.js`);
    const { doc, updateDoc } = await import('https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js');
    try {
      await updateDoc(doc(db, 'families', fid), { alertePasVueJours: 5 });
      return 'écrit';
    } catch (e) { return e.code; }
  }, fid).catch((e) => `erreur : ${e.message}`);
  banc.tolerer(paul, /permission|insufficient|PERMISSION_DENIED/i);
  assert.strictEqual(code, 'permission-denied');
  assert.strictEqual((await g.lire(`families/${fid}`)).alertePasVueJours, undefined, 'rien d\'écrit');
});

test('Accueil : plus de « pas touché » ; « n\'a pas vu vos 3 derniers envois » tant qu\'aucun signe de vie ne suit', async () => {
  const julie = await banc.telephone('Julie');
  const { fid } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const tab = (await g.liste(`families/${fid}/members`)).find((m) => m.role === 'tablette');
  const ref = s.db.doc(`families/${fid}/members/${tab.id}`);
  const ilYa = (h) => s.Timestamp.fromMillis(Date.now() - h * 3600_000);
  // Ni touchée ni vue depuis 20 h, en ligne : avant, bandeau orange « pas touché » ; maintenant, tout va bien.
  await ref.update({ lastOnline: s.Timestamp.now(), lastActive: ilYa(30), lastSeen: ilYa(20) });
  // Tout va bien : plus aucun bandeau (Tanguy, 24/11).
  await julie.page.locator('#activity').waitFor({ state: 'hidden' });
  // Le serveur a compté 3 envois pas vus depuis le dernier signe de vie.
  await s.db.doc(`families/${fid}`).update({ alerteNonVus: { le: s.Timestamp.now(), depuis: ilYa(20), nombre: 3 } });
  await julie.page.locator('#activity.warn', { hasText: "n'a pas vu vos 3 derniers envois. Un petit appel ?" }).waitFor();
  // Elle passe devant la tablette : l'alerte disparaît.
  await ref.update({ lastSeen: s.Timestamp.now() });
  await julie.page.locator('#activity').waitFor({ state: 'hidden' });
  // Aucun signe de vie depuis 5 jours (réglage par défaut) : le bandeau le dit.
  await s.db.doc(`families/${fid}`).update({ alerteNonVus: s.FieldValue.delete() });
  await ref.update({ lastActive: ilYa(6 * 24), lastSeen: ilYa(6 * 24) });
  await julie.page.locator('#activity.warn', { hasText: 'Aucun signe de Mamie Emma sur la tablette depuis 6 jours. Un petit appel ?' }).waitFor();
});
