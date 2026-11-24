// Badge de la cloche après une reconnexion (bug Tanguy 20/11 : « le badge des notifs semble être remis plein à chaque
// fois qu'on se reconnecte »). L'heure du dernier passage sur les notifications n'était gardée que sur le téléphone,
// et la déconnexion efface tout ce qui est propre au compte : tout redevenait non lu. Elle est maintenant sur la fiche
// du proche (notifsVues). Julie voit ses notifications, se déconnecte et se reconnecte : badge vide. Sur un 2e
// téléphone, même compte : badge vide aussi. Marc, connecté ensuite sur le téléphone de Julie, n'hérite de rien : ses
// notifications à lui restent non lues ; puis Julie, revenue, ne reprend pas celles de Marc.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

const { s } = banc;

banc.brancher();

async function seDeconnecter(t) {
  await g.ouvrirProfil(t); // par Réglages, « Mon profil » (barre à 3 boutons, 20/11)
  await g.attendreVue(t, 'view-profile');
  await t.page.click('#view-profile [data-action="logout"]');
  await g.repondre(t, 'Se déconnecter');
  await g.attendreVue(t, 'view-login');
}

async function seReconnecter(t, email) {
  await g.seConnecter(t, email);
  await g.attendreVue(t, 'view-home');
  await g.fermerAccueil(t);
}

/** Réponse de la tablette, écrite comme par elle (serveur) : une notification pour toute la famille. */
const reponseDeMamie = (fid, tab, text) => s.db.collection(`families/${fid}/posts`).add({
  type: 'reply', text, authorUid: tab.tabletUid, authorName: 'Mamie Emma', createdAt: s.FieldValue.serverTimestamp(),
});

/** La page des notifications a reçu ces textes (elle se remplit même cachée) : le badge est à jour. */
async function notifsArrivees(t, textes) {
  await t.page.waitForFunction((attendus) => {
    const tout = document.getElementById('notifs').innerText;
    return attendus.every((x) => tout.includes(x));
  }, textes, { timeout: 15_000 }).catch(async () => {
    assert.fail(`[${t.nom}] notifications attendues : ${textes.join(' / ')} ; affiché : ${await t.page.locator('#notifs').innerText()}`);
  });
  // Ma fiche (heure du dernier passage) arrive avec les membres, dans la même seconde.
  await t.page.waitForTimeout(1500);
}

/** Le chiffre du badge, ou null s'il est caché. */
const badge = (t) => t.page.evaluate(() => {
  const b = document.getElementById('nav-badge');
  return b.hidden ? null : b.textContent;
});

async function voirLesNotifs(t) {
  await t.page.click('#btn-bell');
  await g.attendreVue(t, 'view-notifs');
  assert.strictEqual(await badge(t), null, `[${t.nom}] badge vidé en ouvrant les notifications`);
  await g.retourAccueil(t);
}

test('Notifications vues : toujours vues après déconnexion et reconnexion, et sur un 2e téléphone', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await reponseDeMamie(fid, tab, 'Merci ma chérie');
  await reponseDeMamie(fid, tab, 'Il fait beau ici');
  await notifsArrivees(julie, ['Merci ma chérie', 'Il fait beau ici']);
  assert.strictEqual(await badge(julie), '2', 'deux réponses de Mamie non lues');

  await voirLesNotifs(julie);
  // Une seule écriture : l'heure du passage, sur la fiche de Julie (horodatage serveur).
  const uid = (await g.liste(`families/${fid}/members`)).find((m) => m.email === 'julie@exemple.fr').id;
  await g.attendreBase(async () => (await s.lire(`families/${fid}/members/${uid}`))?.notifsVues, 'notifsVues écrit');

  await seDeconnecter(julie);
  await seReconnecter(julie, 'julie@exemple.fr');
  await notifsArrivees(julie, ['Merci ma chérie', 'Il fait beau ici']);
  assert.strictEqual(await badge(julie), null, 'déjà vues avant la déconnexion : badge vide à la reconnexion');

  // Page rechargée : toujours vide.
  await julie.page.reload();
  await g.attendreVue(julie, 'view-home');
  await notifsArrivees(julie, ['Merci ma chérie']);
  assert.strictEqual(await badge(julie), null, 'badge vide après rechargement');

  // Ce qui arrive ensuite compte toujours.
  await reponseDeMamie(fid, tab, 'Bisous à tous');
  await notifsArrivees(julie, ['Bisous à tous']);
  assert.strictEqual(await badge(julie), '1', 'la nouvelle réponse est comptée');

  // Rouvrir les notifications sans rien de nouveau : pas d'écriture de plus (données mobiles).
  // On attend que l'heure dépasse la précédente (et non « moins de 10 s ») : sur un WebKit lent, la précédente
  // pouvait dater de moins de 10 s et l'écriture attendue arrivait après la mesure.
  const precedente = (await s.lire(`families/${fid}/members/${uid}`)).notifsVues.toMillis();
  await voirLesNotifs(julie);
  await g.attendreBase(async () => {
    const f = await s.lire(`families/${fid}/members/${uid}`);
    return f?.notifsVues && f.notifsVues.toMillis() > precedente;
  }, 'notifsVues avancé');
  const avant = (await s.lire(`families/${fid}/members/${uid}`)).notifsVues.toMillis();
  await julie.page.click('#btn-bell');
  await g.attendreVue(julie, 'view-notifs');
  await g.retourAccueil(julie);
  await julie.page.waitForTimeout(1500);
  assert.strictEqual((await s.lire(`families/${fid}/members/${uid}`)).notifsVues.toMillis(), avant, 'rien de nouveau : pas d\'écriture');

  // Même compte sur un autre téléphone : les notifications vues le sont aussi là.
  const julie2 = await banc.telephone('Julie, 2e téléphone');
  await seReconnecter(julie2, 'julie@exemple.fr');
  await notifsArrivees(julie2, ['Merci ma chérie', 'Il fait beau ici', 'Bisous à tous']);
  assert.strictEqual(await badge(julie2), null, 'vues sur le 1er téléphone : badge vide sur le 2e');
});

test('Autre compte sur le même téléphone : ses propres notifications, rien de celles vues par Julie', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const marc = await banc.telephone('Marc');
  await g.rejoindre(julie, fid, marc, { email: 'marc@exemple.fr', prenom: 'Marc' });
  await marc.context.close();
  await reponseDeMamie(fid, tab, 'Merci ma chérie');
  await reponseDeMamie(fid, tab, 'Il fait beau ici');
  await notifsArrivees(julie, ['Merci ma chérie', 'Il fait beau ici']);
  assert.ok(await badge(julie), 'Julie a des notifications non lues');
  await voirLesNotifs(julie);
  const uidJulie = (await g.liste(`families/${fid}/members`)).find((m) => m.email === 'julie@exemple.fr').id;
  await g.attendreBase(async () => (await s.lire(`families/${fid}/members/${uidJulie}`))?.notifsVues, 'notifsVues de Julie');

  // Marc se connecte sur le téléphone de Julie : les réponses de Mamie sont non lues pour lui.
  await seDeconnecter(julie);
  const tMarc = { ...julie, nom: 'Marc sur le téléphone de Julie' };
  await seReconnecter(tMarc, 'marc@exemple.fr');
  await notifsArrivees(tMarc, ['Merci ma chérie', 'Il fait beau ici']);
  const chiffre = await badge(tMarc);
  assert.ok(chiffre && (chiffre === '9+' || Number(chiffre) >= 2), `Marc n'hérite pas de Julie : ses notifications restent non lues (badge ${chiffre})`);
  const uidMarc = (await g.liste(`families/${fid}/members`)).find((m) => m.email === 'marc@exemple.fr').id;
  assert.strictEqual((await s.lire(`families/${fid}/members/${uidMarc}`)).notifsVues, undefined, 'rien écrit sur la fiche de Marc');

  // Julie revient : toujours vues pour elle, et Marc n'a toujours rien vu (aucune écriture pour lui).
  await seDeconnecter(tMarc);
  await seReconnecter(julie, 'julie@exemple.fr');
  await notifsArrivees(julie, ['Merci ma chérie', 'Il fait beau ici']);
  assert.strictEqual(await badge(julie), null, 'Julie retrouve ses notifications vues');
  assert.strictEqual((await s.lire(`families/${fid}/members/${uidMarc}`)).notifsVues, undefined, 'Marc n\'a toujours rien vu');
});

// Tanguy, 24/11 : « 9+ » à chaque retour dans l'app, sans rien de nouveau à lire. Tout comptait dans le chiffre, même
// « Mamie a vu votre photo », les appels décrochés et les rappels confirmés. Ces nouvelles restent dans la liste, mais
// le chiffre ne compte plus que ce qui attend le proche : réponse de Mamie, envoi d'un autre proche, appel manqué.
test('Cloche : « Mamie a vu », appels décrochés et rappels confirmés ne comptent pas dans le chiffre', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const marc = await banc.telephone('Marc');
  await g.rejoindre(julie, fid, marc, { email: 'marc@exemple.fr', prenom: 'Marc' });
  await marc.context.close();
  await voirLesNotifs(julie);
  const membres = await g.liste(`families/${fid}/members`);
  const uJulie = membres.find((m) => m.email === 'julie@exemple.fr').id;
  const uMarc = membres.find((m) => m.email === 'marc@exemple.fr').id;
  await julie.page.waitForTimeout(1500);
  const maintenant = s.FieldValue.serverTimestamp();
  // Douze envois de Julie vus par Mamie, deux appels décrochés, un rappel confirmé : rien à lire.
  for (let i = 0; i < 12; i++) {
    await s.db.collection(`families/${fid}/posts`).add({
      type: 'message', text: `Coucou ${i}`, authorUid: uJulie, authorName: 'Julie', createdAt: maintenant, seenAt: maintenant,
    });
  }
  await s.db.collection(`families/${fid}/calls`).add({
    callerUid: uJulie, callerName: 'Julie', state: 'ended', answer: { uid: tab.tabletUid }, createdAt: maintenant, endedAt: maintenant,
  });
  await s.db.collection(`families/${fid}/calls`).add({
    callerUid: tab.tabletUid, callerName: 'Mamie Emma', calleeUid: uMarc, calleeName: 'Marc', state: 'ended',
    answer: { uid: uMarc, name: 'Marc' }, createdAt: maintenant, endedAt: maintenant,
  });
  const ici = new Date(Date.now() + 60_000);
  const pad = (n) => String(n).padStart(2, '0');
  await s.db.collection(`families/${fid}/reminders`).add({
    title: 'Pharmacie', lastAck: `${ici.getFullYear()}-${pad(ici.getMonth() + 1)}-${pad(ici.getDate())}T${pad(ici.getHours())}:${pad(ici.getMinutes())}`,
  });
  await notifsArrivees(julie, ['Mamie Emma a vu le message que vous avez envoyé', 'Mamie Emma a appelé Marc', 'a confirmé le rappel « Pharmacie »']);
  assert.strictEqual(await badge(julie), null, 'rien qui attend Julie : pas de chiffre');
  await julie.page.reload();
  await g.attendreVue(julie, 'view-home');
  await notifsArrivees(julie, ['Mamie Emma a appelé Marc']);
  assert.strictEqual(await badge(julie), null, 'toujours rien après rechargement');

  // Ce qui attend Julie compte : un message de Marc, une réponse de Mamie, un appel manqué.
  await s.db.collection(`families/${fid}/posts`).add({
    type: 'message', text: 'Je passe dimanche', authorUid: uMarc, authorName: 'Marc', createdAt: s.FieldValue.serverTimestamp(),
  });
  await reponseDeMamie(fid, tab, 'Merci ma chérie');
  await s.db.collection(`families/${fid}/calls`).add({
    callerUid: tab.tabletUid, callerName: 'Mamie Emma', calleeUid: uJulie, calleeName: 'Julie', state: 'missed',
    createdAt: s.FieldValue.serverTimestamp(), endedAt: s.FieldValue.serverTimestamp(),
  });
  await notifsArrivees(julie, ['Je passe dimanche', 'Merci ma chérie', 'Appel manqué de Mamie Emma']);
  assert.strictEqual(await badge(julie), '3', 'message de Marc, réponse de Mamie, appel manqué');
  await voirLesNotifs(julie);
});

// Tanguy, 24/11 : « le badge ne doit compter que ce qui n'a pas été vu, où que ce soit ». La réponse de Mamie lue dans
// Messages n'est plus comptée sur la cloche ; pas plus celle qui arrive pendant que Messages est ouvert.
test('Cloche : ce qui a été vu dans Messages n\'est plus compté, même après rechargement', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  await reponseDeMamie(fid, tab, 'Merci ma chérie');
  await notifsArrivees(julie, ['Merci ma chérie']);
  assert.strictEqual(await badge(julie), '1', 'une réponse non lue');
  await g.ouvrirTuile(julie, 'messages');
  await julie.page.waitForTimeout(800);
  await reponseDeMamie(fid, tab, 'Il fait beau ici');
  await julie.page.locator('#view-messages').getByText('Il fait beau ici').waitFor({ timeout: 15_000 });
  await julie.page.click('#view-messages .back');
  await g.attendreVue(julie, 'view-home');
  await notifsArrivees(julie, ['Il fait beau ici']);
  assert.strictEqual(await badge(julie), null, 'vues dans Messages : plus de chiffre');
  await julie.page.reload();
  await g.attendreVue(julie, 'view-home');
  await notifsArrivees(julie, ['Merci ma chérie', 'Il fait beau ici']);
  assert.strictEqual(await badge(julie), null, 'toujours rien après rechargement');
  await reponseDeMamie(fid, tab, 'Bisous');
  await notifsArrivees(julie, ['Bisous']);
  assert.strictEqual(await badge(julie), '1', 'la suivante compte');
});
