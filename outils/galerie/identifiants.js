// Le bon identifiant part au serveur (Tanguy, 30/10, après l'arrêt de l'abonnement de EJ4N-DVBA depuis la commande
// 8X9K-EB7T). Sur la page d'une commande de l'admin, chaque bouton qui touche l'argent ou le client est touché (menu ⋮
// compris), la confirmation acceptée, et l'on regarde ce qui part au serveur (faux-firebase.js, window.__appels) :
// toute action sur une commande doit porter `commande: <la commande de la page>` et, si elle porte une famille, celle
// de la commande. Dans l'appli famille, les actions d'abonnement doivent porter la famille ouverte.
// Rend la liste des appels { page, bouton, fonction, data, probleme }.
'use strict';

const fs = require('fs');
const path = require('path');
const { lister, SEL } = require('./boutons');

// Fonctions qui agissent sur une commande ou un abonnement, et ce qu'elles doivent porter.
const ACTIONS_COMMANDE = {
  retracter: ['commande', 'fid'], resilierAbonnement: ['commande', 'fid'], annulerResiliation: ['commande', 'fid'],
  pauseHospitalisation: ['commande'], tabletteRendue: ['commande'], gestionAnnulerCommande: ['commande'],
  gestionEtiquette: ['commande'], gestionAnnulerEtiquette: ['commande'], gestionRenvoyerCode: ['commande'],
  gestionCommande: ['commande'], gestionStock: ['commande'], gestionParcours: ['commande'],
};
// Appli famille : actions d'abonnement, toutes sur la famille ouverte.
const ACTIONS_FAMILLE = ['resilierAbonnement', 'annulerResiliation', 'renvoyerTablette', 'creerPaiement', 'portailClient', 'facturesFamille', 'finDeContrat', 'retracter'];

const pause = (p, ms) => p.waitForTimeout(ms);

// Accepte la confirmation ouverte (admin : <dialog class="dialogue-papote"> ; appli : .dialog-back .dialog), en remplissant
// un champ éventuel (date de reprise d'une pause, nom à retaper…).
async function confirmer(page, valeur) {
  for (let i = 0; i < 3; i++) {
    const champ = page.locator('dialog.dialogue-papote input, .dialog-back .dialog input').first();
    if (await champ.count()) await champ.fill(valeur).catch(() => {});
    const ok = page.locator('dialog.dialogue-papote .actions button.primary, dialog.dialogue-papote .actions button.danger, .dialog-back .dialog .dialog-buttons button.primary, .dialog-back .dialog .dialog-buttons button.danger').first();
    if (!await ok.count()) return i > 0;
    await ok.click({ timeout: 1500 }).catch(() => {});
    await pause(page, 500);
  }
  return true;
}

// Touche le bouton `nom` d'une scène, accepte les confirmations, et rend les appels partis au serveur.
async function toucher(mod, browser, base, scene, taille, nom, valeur) {
  const { ctx, page } = await mod.ouvrir(browser, base, scene, taille);
  try {
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    const noms = await page.evaluate(lister, SEL);
    const i = noms.indexOf(nom);
    if (i < 0) return null;
    await page.evaluate(() => { window.__appels = []; });
    // Le menu ⋮ se ferme au moindre défilement (celui de la liste des boutons) : on le rouvre avant de toucher l'item.
    const cible = page.locator(`[data-bouton="${i}"]`);
    await pause(page, 300); // le défilement de la liste ferme le menu une image plus tard
    if (!await cible.isVisible() && scene.faire) await scene.faire(page);
    await cible.click({ timeout: 2000, noWaitAfter: true });
    await pause(page, 500);
    await confirmer(page, valeur);
    // Une zone qui s'ouvre (« Matériel reçu », « Remplacer un élément ») : son bouton principal est touché à son tour.
    const apres = await page.evaluate(lister, SEL).catch(() => []);
    const nouveaux = apres.map((n, j) => ({ n, j })).filter(({ n }) => !noms.includes(n) && /Enregistrer|Remplacer|Envoyer|Créer|Confirmer|Valider/.test(n));
    for (const { j } of nouveaux.slice(0, 2)) {
      await page.locator(`[data-bouton="${j}"]`).click({ timeout: 1500, noWaitAfter: true }).catch(() => {});
      await pause(page, 400);
      await confirmer(page, valeur);
    }
    await pause(page, 800);
    return await page.evaluate(() => (window.__appels || []).map((a) => ({ nom: a.nom, data: a.data === undefined ? null : JSON.parse(JSON.stringify(a.data)) })));
  } catch (e) {
    return null;
  } finally {
    await ctx.close();
  }
}

function jugerAdmin(appels, commande, fid) {
  const problemes = [];
  for (const a of appels) {
    const attendu = ACTIONS_COMMANDE[a.nom];
    if (!attendu) continue;
    const d = a.data || {};
    // gestionStock : seule l'action « remplacer » vise une commande ; gestionParcours : envoi/reçu seulement.
    if (a.nom === 'gestionStock' && d.action !== 'remplacer') continue;
    if (a.nom === 'gestionParcours' && !['envoi', 'recu'].includes(d.type)) continue;
    if (attendu.includes('commande') && d.commande !== commande) problemes.push({ fonction: a.nom, data: d, probleme: `commande attendue ${commande}, reçue ${JSON.stringify(d.commande)}` });
    else if (attendu.includes('fid') && fid && d.fid !== fid) problemes.push({ fonction: a.nom, data: d, probleme: `famille attendue ${fid}, reçue ${JSON.stringify(d.fid)}` });
  }
  return problemes;
}

// Admin : chaque page de commande de la galerie, boutons de la page puis du menu ⋮.
async function admin({ browser, base, progression }) {
  const mod = require('./admin');
  const taille = mod.TAILLES.pc;
  const pages = mod.SCENES.filter((s) => /^#commande\/CMD-/.test(s.page) && !s.faire);
  const ouvrirMenu = async (p) => { const b = p.locator('#dc-corps .menu-points-bouton, #dc-corps [aria-haspopup="menu"]').first(); if (await b.count()) { await b.click(); await pause(p, 500); } };
  const resultats = [];
  let faits = 0;
  for (const page of pages) {
    const id = page.page.replace('#commande/', '');
    const c = page.donnees().fonctions.gestionDonnees.commandes.find((x) => x.id === id);
    const fid = c ? c.fid : null;
    for (const [etape, scene] of [['page', page], ['menu ⋮', { ...page, faire: ouvrirMenu }]]) {
      const { ctx, page: p } = await mod.ouvrir(browser, base, scene, taille);
      const noms = (await p.evaluate(lister, SEL).catch(() => [])).filter((n) => !/^#nav-|^#b-|Imprimer|Retour|Fermer|onglet/i.test(n));
      await ctx.close();
      for (const nom of noms) {
        if (etape === 'menu ⋮' && !/menu-points-item|« /.test(nom)) { /* tout bouton : le menu ouvert ajoute ses items */ }
        const appels = await toucher(mod, browser, base, scene, taille, nom, '15/12/2027');
        if (!appels) continue;
        const vises = appels.filter((a) => ACTIONS_COMMANDE[a.nom] && !(a.nom === 'gestionStock' && (a.data || {}).action !== 'remplacer') && !(a.nom === 'gestionParcours' && !['envoi', 'recu'].includes((a.data || {}).type)));
        if (!vises.length) continue;
        const problemes = jugerAdmin(vises, id, fid);
        resultats.push({ page: `${page.titre} (${id})`, etape, bouton: nom, appels: vises.map((a) => `${a.nom} ${JSON.stringify(a.data)}`), problemes });
      }
      progression(`admin : ${++faits}/${pages.length * 2} écrans de commande`);
    }
  }
  return resultats;
}

// Appli famille : les écrans de l'abonnement (« Mon abonnement », arrêt, retour) ; chaque action porte la famille ouverte.
async function famille({ browser, base, progression }) {
  const mod = require('./famille');
  const taille = mod.TAILLES[0];
  const scenes = mod.SCENES.filter((s) => !s.avant && /abonnement|Abonnement|résili|Résili|retour|Retour|Payer|payer/.test(`${s.groupe} ${s.titre}`));
  const resultats = [];
  let faits = 0;
  for (const scene of scenes) {
    const { ctx, page: p } = await mod.ouvrir(browser, base, scene, taille);
    const noms = await p.evaluate(lister, SEL).catch(() => []);
    await ctx.close();
    for (const nom of noms) {
      const appels = await toucher(mod, browser, base, scene, taille, nom, 'Mamie Emma');
      if (!appels) continue;
      const vises = appels.filter((a) => ACTIONS_FAMILLE.includes(a.nom));
      if (!vises.length) continue;
      const problemes = vises.filter((a) => !a.data || a.data.fid !== mod.FID).map((a) => ({ fonction: a.nom, data: a.data, probleme: `famille attendue ${mod.FID}, reçue ${JSON.stringify(a.data && a.data.fid)}` }));
      resultats.push({ page: scene.titre, etape: 'écran', bouton: nom, appels: vises.map((a) => `${a.nom} ${JSON.stringify(a.data)}`), problemes });
    }
    progression(`famille : ${++faits}/${scenes.length} écrans d'abonnement`);
  }
  return resultats;
}

function rapport(parties, dossier) {
  const lignes = [];
  let soucis = 0;
  for (const { nom, version, resultats } of parties) {
    const faux = resultats.filter((r) => r.problemes.length);
    soucis += faux.length;
    lignes.push(`${nom} (${version}) : ${resultats.length} bouton(s) qui agissent sur une commande ou un abonnement, ${faux.length} avec un mauvais identifiant`);
    for (const r of resultats) {
      lignes.push(`  ${r.problemes.length ? 'FAUX' : 'ok  '} ${r.page} · ${r.etape} · ${r.bouton} → ${r.appels.join(' ; ')}`);
      for (const pb of r.problemes) lignes.push(`       ${pb.fonction} : ${pb.probleme}`);
    }
  }
  const fichier = path.join(dossier, 'identifiants.txt');
  fs.writeFileSync(fichier, lignes.join('\n') + '\n');
  return { fichier, texte: lignes.join('\n'), soucis };
}

module.exports = { admin, famille, rapport };
