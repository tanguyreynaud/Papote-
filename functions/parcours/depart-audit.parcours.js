// Audit du départ d'un client (11/11) : sondes. Chaque scénario note ce qu'il observe (console) ; rien n'est corrigé ici.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher, mailsA, commande } = require('./commun');

brancher();

const famille = (fid) => s.lire(`families/${fid}`);
const fiche = (t) => s.lire(`stock/${t.fiche}`);
const preleveMateriel = () => [...s.stripe.etat.paiements.values()].filter((p) => /non rendu/.test(p.description || ''));
const noter = (...x) => console.log('   SONDE', ...x);

async function familleAbonnee(acheteur) {
  await s.db.doc('gestion/reglages').set({ expediteur: { nom: 'Papote', adresse: '1 rue de test', cp: '07000', ville: 'Privas' } }, { merge: true });
  const t = await a.tablettePreparee();
  const { abonnement: id } = await a.commanderEtPayer({ email: acheteur.email });
  await a.preparerEtEnvoyer(id, t);
  s.avancer(2);
  await a.afficherCode(t);
  const fid = await a.installer(acheteur, t);
  s.avancer(31);
  s.stripe.finirEssai(id);
  await s.calme();
  assert.strictEqual((await famille(fid)).abonnement.statut, 'actif');
  return { id, fid, t };
}

async function finDeContrat(paul) {
  const { id, fid, t } = await familleAbonnee(paul);
  const { le } = await s.appeler('resilierAbonnement', { fid }, paul);
  await s.calme();
  s.avancer((le - Date.now()) / s.JOUR + 0.1);
  s.stripe.arreterALaDate(id);
  await s.calme();
  assert.strictEqual((await commande(id)).restitution.statut, 'attendue');
  return { id, fid, t, le };
}

// « Matériel reçu » comme l'admin (gestion.js, zoneMaterielRecu) puis remise en stock à la main.
async function recueEtRemiseEnStock(id, t) {
  await s.appeler('tabletteRendue', { commande: id, manquants: [] }, a.TANGUY);
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { etat: 'revenue' } }, a.TANGUY);
  await s.calme();
  await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { etat: 'en-stock' } }, a.TANGUY);
  await s.calme();
}

test('S1 remise en stock puis nuit : la tablette revenue est-elle reprise par son ancienne famille ?', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid, t } = await finDeContrat(paul);
  s.avancer(5);
  await recueEtRemiseEnStock(id, t);
  let f = await fiche(t);
  noter('S1 après remise en stock :', { etat: f.etat, fid: f.fid || null, commande: f.commande || null, simId: !!f.simId, tabletUid: f.tabletUid || null });
  const membre = await s.lire(`families/${fid}/members/${t.tabletUid}`);
  noter('S1 fiche membre de la tablette dans l\'ancienne famille :', membre ? 'encore là' : 'retirée');
  const anciens = (await s.db.collection('pairings').where('fid', '==', fid).get()).docs.map((d) => d.get('status'));
  noter('S1 anciens jumelages de la famille :', anciens);
  s.avancer(1);
  const bilan = await s.tache('gestionAutomatique').catch((e) => ({ erreur: e.message }));
  await s.calme();
  noter('S1 bilan de la nuit :', JSON.stringify(bilan && (bilan.stock || bilan)));
  f = await fiche(t);
  noter('S1 après la nuit :', { etat: f.etat, fid: f.fid || null, memeAncienneFamille: f.fid === fid, tabletUid: f.tabletUid || null });
  // Nouvelle commande d'un autre client : peut-on lui donner cette tablette ?
  const { abonnement: id2 } = await a.commanderEtPayer({ email: 'lea@exemple.fr', nom: 'Léa Durand' });
  const lien = await s.appeler('gestionStock', { action: 'modifier', id: t.fiche, champs: { commande: id2 } }, a.TANGUY).then(() => 'accepté', (e) => `refusé : ${e.message}`);
  noter('S1 relier la tablette revenue à une nouvelle commande :', lien);
  const dispo = await s.requete('stockDisponible', {});
  noter('S1 stock annoncé au site :', dispo.texte || JSON.stringify(dispo.json || dispo));
});

test('S2 ex-famille qui a rendu la tablette : « reprendre Papote » dans l\'appli', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid, t } = await finDeContrat(paul);
  s.avancer(5);
  await recueEtRemiseEnStock(id, t);
  s.avancer(3);
  const r = await s.appeler('creerPaiement', { fid, formule: 'sim' }, paul).then((x) => x, (e) => ({ refus: e.message }));
  noter('S2 creerPaiement :', JSON.stringify(r));
  if (r.url) {
    const session = r.url.split('/').pop();
    const meta = s.stripe.etat.sessions.get(session).metadata;
    noter('S2 metadata de la page de paiement :', JSON.stringify(meta));
    const { abonnement } = s.stripe.payerSession(session, { email: paul.email, nom: 'Paul Martin' });
    await s.calme();
    const c = await commande(abonnement);
    noter('S2 nouvelle commande :', { expedition: c.expedition, recuPar: c.preparation && c.preparation.recuPar, reprise: !!c.reprise });
    noter('S2 famille :', (await famille(fid)).abonnement.statut, '; tablette', (await fiche(t)).etat, 'fid', (await fiche(t)).fid || null);
    noter('S2 payé :', [...s.stripe.etat.factures.values()].filter((x) => x.subscription === abonnement).map((x) => [x.status, x.amount_paid]));
  }
});

test('S3 tablette revenue dont la ligne SIM a été suspendue : repart-elle chez un nouveau client ?', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, t } = await finDeContrat(paul);
  s.avancer(5);
  await recueEtRemiseEnStock(id, t);
  const simId = (await fiche(t)).simId;
  noter('S3 SIM après remise en stock :', simId ? (await s.lire(`sims/${simId}`)).statut : 'aucune');
  if (simId) await s.appeler('gestionSim', { action: 'modifier', id: simId, champs: { statut: 'suspendue' } }, a.TANGUY).catch((e) => noter('S3 suspendre :', e.message));
  noter('S3 SIM :', simId ? (await s.lire(`sims/${simId}`)).statut : '-', 'simId sur la fiche :', !!(await fiche(t)).simId);
  const { abonnement: id2 } = await a.commanderEtPayer({ email: 'lea@exemple.fr', nom: 'Léa Durand' });
  const envoi = await a.preparerEtEnvoyer(id2, t, '87654321').then(() => 'colis parti', (e) => `refusé : ${e.message}`);
  noter('S3 envoi avec une ligne suspendue :', envoi, '; SIM', simId ? (await s.lire(`sims/${simId}`)).statut : '-');
});

test('S4 « Matériel reçu » en même temps avec deux listes différentes (deux onglets)', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id } = await finDeContrat(paul);
  s.avancer(5);
  const r = await Promise.allSettled([
    s.appeler('tabletteRendue', { commande: id, manquants: ['chargeur'] }, a.TANGUY),
    s.appeler('tabletteRendue', { commande: id, manquants: [] }, a.TANGUY),
  ]);
  await s.calme();
  const c = await commande(id);
  noter('S4 réponses :', r.map((x) => (x.status === 'fulfilled' ? JSON.stringify(x.value) : x.reason.message)));
  noter('S4 commande :', JSON.stringify({ statut: c.restitution.statut, manquants: c.restitution.manquants || null, montant: c.restitution.montant || 0 }),
    '; prélevé :', preleveMateriel().map((p) => p.amount));
});

test('S5 les 140 € tombent pendant que Papote note « Matériel reçu »', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id } = await finDeContrat(paul);
  s.avancer(31);
  const r = await Promise.allSettled([
    s.tache('restitutions'),
    s.appeler('tabletteRendue', { commande: id, manquants: [] }, a.TANGUY),
  ]);
  await s.calme();
  const c = await commande(id);
  noter('S5', r.map((x) => x.status), JSON.stringify({ statut: c.restitution.statut, paiement: c.restitution.paiement || null, rembourse: c.restitution.rembourse || null, tente: !!c.restitution.prelevementTenteLe }),
    '; prélevé :', preleveMateriel().map((p) => p.amount), '; remboursé :', s.stripe.etat.remboursements.map((x) => x.amount));
});

test('S6 tablette jamais rendue, 140 € refusés : la purge à 3 mois', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid, t } = await finDeContrat(paul);
  s.stripe.carteExpiree = true;
  if (typeof s.stripe.expirerCarte === 'function') s.stripe.expirerCarte(id);
  s.avancer(31);
  await s.tache('restitutions');
  await s.calme();
  noter('S6 restitution :', (await commande(id)).restitution.statut, '; mails :', mailsA(paul.email).slice(-2));
  for (let i = 0; i < 5; i++) {
    s.avancer(30);
    await s.tache('purgeMensuelle');
    await s.calme();
    if (!(await famille(fid))) { noter('S6 famille effacée au passage', i + 1); break; }
  }
  const f = await fiche(t);
  noter('S6 après la purge : famille', (await famille(fid)) ? 'encore là' : 'effacée', '; fiche tablette', { etat: f.etat, fid: f.fid || null, commande: !!f.commande },
    '; restitution', (await commande(id)).restitution.statut);
  const bilan = await s.tache('gestionAutomatique').catch((e) => ({ erreur: e.message }));
  await s.calme();
  noter('S6 nuit suivante :', JSON.stringify(bilan && (bilan.erreurs || bilan)));
});

test('S7 140 € déjà prélevés : la famille ou Papote peuvent-ils encore créer un retour ?', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id, fid } = await finDeContrat(paul);
  s.avancer(31);
  await s.tache('restitutions');
  await s.calme();
  noter('S7 restitution :', (await commande(id)).restitution.statut);
  noter('S7 famille, « Je renvoie la tablette » :', await s.appeler('renvoyerTablette', { fid }, paul).then(() => 'QR créé', (e) => `refusé : ${e.message}`));
  noter('S7 admin, étiquette de retour :', await s.appeler('gestionEtiquette', { commande: id, sens: 'retour' }, a.TANGUY).then(() => 'créée', (e) => `refusé : ${e.message}`));
  const fin = await s.appeler('finDeContrat', { fid }, paul).catch((e) => ({ refus: e.message }));
  noter('S7 ce que l\'appli sait :', JSON.stringify(fin));
});

test('S8 140 € : Stripe débite mais la réponse se perd (coupure) ; la tablette arrive ensuite', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { id } = await finDeContrat(paul);
  s.avancer(31);
  const vrai = s.stripe.api.paymentIntents.create;
  s.stripe.api.paymentIntents.create = async (...args) => { await vrai.apply(s.stripe.api.paymentIntents, args); throw new Error('socket hang up'); };
  await s.tache('restitutions').catch((e) => noter('S8 tâche :', e.message));
  s.stripe.api.paymentIntents.create = vrai;
  await s.calme();
  let c = await commande(id);
  noter('S8 après la coupure :', JSON.stringify({ statut: c.restitution.statut, erreur: c.restitution.erreur || null, paiement: c.restitution.paiement || null }),
    '; réellement prélevé :', preleveMateriel().map((p) => p.amount), '; mails client :', mailsA(paul.email).slice(-1));
  s.avancer(3);
  const r = await s.appeler('tabletteRendue', { commande: id, manquants: [] }, a.TANGUY).then((x) => JSON.stringify(x), (e) => e.message);
  await s.calme();
  c = await commande(id);
  noter('S8 « Matériel reçu » :', r, '; statut', c.restitution.statut, '; remboursé :', s.stripe.etat.remboursements.map((x) => x.amount));
  s.erreurs.length = 0;
});

test('S9 tablette revenue, remise en stock et redonnée le jour même à un nouveau client : où entre-t-elle ?', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const lea = await s.compte('Léa', 'lea@exemple.fr');
  const { id, fid, t } = await finDeContrat(paul);
  s.avancer(5);
  await recueEtRemiseEnStock(id, t);
  const { abonnement: id2 } = await a.commanderEtPayer({ email: lea.email, nom: 'Léa Durand' });
  const fid2 = (await commande(id2)).fid;
  await a.preparerEtEnvoyer(id2, t, '87654321');
  let f = await fiche(t);
  noter('S9 colis parti :', { etat: f.etat, fid: f.fid || null, commandeNouvelle: f.commande === id2 });
  s.avancer(0.5);
  const bilan = await s.tache('gestionAutomatique').catch((e) => ({ erreur: e.message }));
  await s.calme();
  f = await fiche(t);
  noter('S9 après la nuit :', JSON.stringify(bilan && (bilan.stock || bilan)), { etat: f.etat, ancienneFamille: f.fid === fid, nouvelleFamille: f.fid === fid2, alerte: f.alerteJumelage || null });
  // La tablette, remise à zéro et réinstallée (nouveaux comptes, nouvelle clé), arrive chez Léa et affiche son code.
  const { createHash, randomBytes } = require('node:crypto');
  const neuve = { ...t, tabletUid: `${t.tabletUid}-2`, callsUid: `${t.callsUid}-2` };
  const cle = randomBytes(32).toString('base64url');
  await s.db.doc(`clesTablettes/${createHash('sha256').update(cle).digest('hex')}`).set({ serie: t.serie, tabletUid: neuve.tabletUid, creeLe: s.FieldValue.serverTimestamp() });
  s.avancer(2);
  await a.afficherCode(neuve);
  const p = await s.lire(`pairings/${neuve.code}`);
  noter('S9 code affiché chez la nouvelle cliente :', { status: p.status, fid: p.fid || null, entreeSeuleDansSaFamille: p.fid === fid2 });
  noter('S9 ancienne famille :', (await famille(fid)).abonnement.statut, '; nouvelle :', (await famille(fid2)).abonnement.statut,
    '; commande 2 tabletteRelieeLe :', !!(await commande(id2)).tabletteRelieeLe);
  s.erreurs.length && noter('S9 erreurs :', s.erreurs.map(String));
  s.erreurs.length = 0;
});
