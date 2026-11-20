// Tout responsable gère l'abonnement au nom de la famille, qu'il paie ou non (Tanguy, 18/11) : moyen de paiement,
// factures, « Résilier l'abonnement », « Garder mon abonnement ». Un simple proche voit l'état, sans aucun bouton.
// Julie a commandé et paie ; elle rend Paul responsable ; Marie est un simple proche.

const test = require('node:test');
const assert = require('node:assert');
const banc = require('../banc');
const g = require('../gestes');

const { s } = banc;

banc.brancher();

const famille = (fid) => g.lire(`families/${fid}`);
const avantDePartir = (t) => t.page.locator('.dialog-back:not(.closing) .dialog', { hasText: 'Avant de partir' });

async function profil(t) {
  await g.ouvrirProfil(t);
  await g.attendreVue(t, 'view-profile');
  await t.page.locator('#abo-card').waitFor({ state: 'visible' });
}

async function rechargerPuisProfil(t) {
  await t.page.reload();
  await t.page.waitForFunction(() => {
    const vues = [...document.querySelectorAll('main > section, #loading')].filter((e) => !e.hidden).map((e) => e.id);
    return vues.length === 1 && ['view-home', 'view-profile', 'view-abonnement'].includes(vues[0]);
  }, null, { timeout: 20_000 });
  // Devenu responsable : le petit guide des responsables peut s'ouvrir une fois à l'accueil.
  await t.page.waitForTimeout(800);
  await g.fermerAccueil(t);
  await profil(t);
}

const mailsResiliation = (email) => s.boite.filter((m) => m.a === email && /résiliation/i.test(m.sujet));

test('Un responsable qui ne paie pas voit et utilise « Résilier l\'abonnement » (double appui = une demande), le rechargement montre l\'arrêt, il peut garder ; un simple proche ne voit rien', async () => {
  const julie = await banc.telephone('Julie');
  const { fid, tab } = await g.familleInstallee(julie, { email: 'julie@exemple.fr', prenom: 'Julie' });
  const paul = await banc.telephone('Paul');
  const uidPaul = await g.rejoindre(julie, fid, paul, { email: 'paul@exemple.fr', prenom: 'Paul' });
  const marie = await banc.telephone('Marie');
  await g.rejoindre(julie, fid, marie, { email: 'marie@exemple.fr', prenom: 'Marie', genre: 'femme' });

  // Julie rend Paul responsable : la question dit qu'il pourra gérer l'abonnement.
  await g.ouvrirFamille(julie);
  await julie.page.click('button[aria-label="Actions pour Paul"]');
  await g.repondre(julie, 'Rendre responsable');
  assert.match(await g.texteFenetre(julie), /Rendre Paul responsable \?.*gérer l'abonnement \(moyen de paiement, factures, résiliation\)/);
  await g.repondre(julie, 'Rendre responsable');
  await g.attendreBase(async () => ((await famille(fid)).admins || []).includes(uidPaul), 'Paul responsable');

  // Plus de 30 jours : le premier mois est prélevé, « Résilier » est proposé.
  s.avancer(31);
  s.stripe.finirEssai(tab.commande);
  await s.calme();
  s.boite.length = 0;

  // Marie, simple proche : l'état de l'abonnement, sans aucun bouton pour le changer.
  await rechargerPuisProfil(marie);
  await marie.page.locator('#abo-status', { hasText: 'Actif' }).waitFor();
  await marie.page.locator('#abo-readonly', { hasText: 'Seuls les responsables de la famille peuvent gérer ou résilier l\'abonnement' }).waitFor();
  for (const id of ['#btn-abo-page', '#btn-portail', '#btn-garder', '#btn-resilier', '#btn-resilier-deces']) {
    assert.strictEqual(await marie.page.locator(id).isVisible(), false, `${id} caché pour un simple proche`);
  }

  // Paul, responsable sans payer : la page « Abonnement et paiement », les factures du payeur, le portail Stripe.
  await rechargerPuisProfil(paul);
  assert.strictEqual(await paul.page.locator('#abo-readonly').isVisible(), false);
  await paul.page.click('#btn-abo-page');
  await g.attendreVue(paul, 'view-abonnement');
  await paul.page.locator('#factures-chargement').waitFor({ state: 'hidden' });
  await paul.page.locator('#factures-liste li', { hasText: '60 €' }).waitFor();
  const [portail] = await Promise.all([
    paul.page.waitForRequest((r) => r.url().startsWith('https://billing.stripe.test/')),
    paul.page.click('#btn-portail-page'),
  ]);
  assert.ok(portail, 'page Stripe du moyen de paiement ouverte');
  await paul.page.goto(banc.origine);
  await g.attendreVue(paul, 'view-home');
  await profil(paul);
  await paul.page.click('#btn-abo-page');
  await g.attendreVue(paul, 'view-abonnement');
  await paul.page.locator('#factures-chargement').waitFor({ state: 'hidden' });

  // « Résilier l'abonnement » : une fenêtre de l'app (jamais celle du navigateur), « Résilier quand même » touché deux fois.
  await paul.page.locator('#btn-resilier', { hasText: 'Résilier l\'abonnement' }).waitFor({ state: 'visible' });
  await paul.page.click('#btn-resilier');
  await avantDePartir(paul).waitFor();
  await g.doubleAppui(paul, '.dialog-back:not(.closing) .dialog button:has-text("Résilier quand même")');
  assert.match(await g.texteFenetre(paul), /Résiliation enregistrée\. Papote s'arrêtera le .*Un e-mail de confirmation part à l'adresse de la commande\./);
  await paul.page.waitForTimeout(300);
  assert.strictEqual(await g.fenetresOuvertes(paul), 1, 'une seule confirmation');
  await g.repondre(paul, 'OK');
  await s.calme();
  assert.strictEqual(g.nbAppels('resilierAbonnement'), 1, 'résiliation demandée une seule fois');
  const fam = await famille(fid);
  assert.ok(fam.abonnement.resiliationLe, 'arrêt noté');
  // L'abonnement reste celui de Julie (client Stripe de la commande) : elle reçoit la confirmation, une seule fois.
  assert.strictEqual(s.stripe.etat.abonnements.get(tab.commande).cancel_at * 1000, fam.abonnement.resiliationLe.toMillis());
  assert.strictEqual(mailsResiliation('julie@exemple.fr').length, 1, 'un e-mail au payeur');
  assert.ok(mailsResiliation('paul@exemple.fr').length <= 1, 'au plus une copie à Paul');
  assert.strictEqual(mailsResiliation('marie@exemple.fr').length, 0);
  await paul.page.locator('#btn-resilier').waitFor({ state: 'hidden' });

  // Page rechargée : l'arrêt prévu est dit à Paul comme à Julie, « Garder mon abonnement » est là pour les deux.
  await rechargerPuisProfil(paul);
  await paul.page.locator('#abo-status', { hasText: 'Arrêt prévu le' }).waitFor();
  await paul.page.locator('#btn-garder').waitFor({ state: 'visible' });
  await rechargerPuisProfil(julie);
  await julie.page.locator('#abo-status', { hasText: 'Arrêt prévu le' }).waitFor();
  await julie.page.locator('#btn-garder').waitFor({ state: 'visible' });
  await marie.page.locator('#abo-status', { hasText: 'Arrêt prévu le' }).waitFor();
  assert.strictEqual(await marie.page.locator('#btn-garder').isVisible(), false, 'pas de « Garder » pour un simple proche');

  // Paul garde l'abonnement (double appui : une seule demande).
  await g.doubleAppui(paul, '#btn-garder');
  assert.match(await g.texteFenetre(paul), /Résiliation annulée : votre abonnement continue/);
  await g.repondre(paul, 'OK');
  await s.calme();
  assert.strictEqual(g.nbAppels('annulerResiliation'), 1, 'reprise demandée une seule fois');
  assert.ok(!(await famille(fid)).abonnement.resiliationLe, 'résiliation annulée');
  await paul.page.locator('#btn-garder').waitFor({ state: 'hidden' });
  await g.jamaisMainPropre(paul);
});
