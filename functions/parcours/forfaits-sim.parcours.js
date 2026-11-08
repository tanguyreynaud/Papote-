// Forfaits SIM prépayés (Lyca, 30 jours) : recharge notée depuis l'admin, rappel avant la fin, facture reçue
// rangée sur sa ligne.

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher } = require('./commun');
const { regles: g } = require('../gestion');
const { mailsA } = require('./commun');

brancher();

const TANGUY = { uid: 'tanguy-admin', email: 'tanguy@mapapote.fr', prenom: 'Tanguy', admin: true };

test('« J\'ai rechargé » : dépense reliée à la carte, fin du forfait 30 jours plus tard, rappel 3 jours avant', async () => {
  const { id } = await s.appeler('gestionSim', { action: 'ajouter', champs: {
    statut: 'active', operateur: 'Lyca', numero: '07 51 23 45 67', prix: 499, prochaineRecharge: Date.now() + 2 * s.JOUR,
  } }, TANGUY);
  const alertes = async () => g.alertesSim(await s.lire(`sims/${id}`), Date.now());
  assert.deepStrictEqual(await alertes(), ['à recharger dans 2 j']);

  const avant = Date.now();
  const r = await s.appeler('gestionSim', { action: 'recharger', id }, TANGUY);
  const depense = await s.lire(`depenses/${r.depense}`);
  assert.strictEqual(depense.sim, id);
  assert.strictEqual(depense.categorie, 'sim');
  assert.strictEqual(depense.montant, 499);
  assert.strictEqual(depense.libelle, 'Recharge du forfait Lyca 07 51 23 45 67');
  const ligne = await s.lire(`sims/${id}`);
  assert.ok(ligne.prochaineRecharge >= avant + 30 * s.JOUR && ligne.prochaineRecharge <= Date.now() + 30 * s.JOUR);
  assert.deepStrictEqual(await alertes(), [], 'plus de rappel après la recharge');
  const donnees = await s.appeler('gestionDonnees', {}, TANGUY);
  assert.strictEqual(donnees.depenses.find((d) => d.id === r.depense).sim, id, 'la page voit la recharge sur la carte');

  s.avancer(27.5);
  assert.deepStrictEqual(await alertes(), ['à recharger dans 3 j']);
  s.avancer(4);
  assert.deepStrictEqual(await alertes(), ['forfait fini : à recharger']);
});

test('facture de forfait reliée à la main depuis sa page : la fin du forfait suit', async () => {
  const { id } = await s.appeler('gestionSim', { action: 'ajouter', champs: { statut: 'active', operateur: 'Lyca', prix: 499 } }, TANGUY);
  const { id: dep } = await s.appeler('gestionDepense', {
    action: 'ajouter', categorie: 'sim', libelle: 'Lyca Pass', montant: 499, date: Date.now() - 5 * s.JOUR,
  }, TANGUY);
  await s.appeler('gestionDepense', { action: 'modifier', id: dep, champs: { sim: id } }, TANGUY);
  const ligne = await s.lire(`sims/${id}`);
  assert.ok(Math.abs(ligne.prochaineRecharge - (Date.now() + 25 * s.JOUR)) < 60000);
  await assert.rejects(s.appeler('gestionDepense', { action: 'modifier', id: dep, champs: { sim: 'inconnue' } }, TANGUY), /introuvable/);
});

test('garde-fou du forfait : la famille de la tablette reçoit le forfait de sa carte, et sa nouvelle date à chaque recharge', async () => {
  const proche = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  await a.afficherCode(t);
  const fid = await a.installer(proche, t);
  assert.strictEqual((await s.lire(`stock/${t.fiche}`)).fid, fid, 'tablette reliée à sa famille');
  const { id } = await s.appeler('gestionSim', { action: 'ajouter', champs: {
    statut: 'active', operateur: 'Lyca', numero: '07 51 23 45 67', prix: 499, go: 1, activation: Date.now(), tablette: t.fiche,
  } }, TANGUY);
  const jour = Math.min(Number(new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }).slice(8)), 28);
  assert.deepStrictEqual((await s.lire(`families/${fid}`)).forfaitSim, { mo: 1000, jour, finForfait: 'reduit' });
  await s.appeler('gestionSim', { action: 'recharger', id }, TANGUY);
  const aujourdhui = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
  assert.deepStrictEqual((await s.lire(`families/${fid}`)).forfaitSim, { mo: 1000, debut: aujourdhui, finForfait: 'reduit' });
  await s.appeler('gestionSim', { action: 'modifier', id, champs: { go: 2 } }, TANGUY);
  assert.deepStrictEqual((await s.lire(`families/${fid}`)).forfaitSim, { mo: 2000, debut: aujourdhui, finForfait: 'reduit' });
  // « À la fin du forfait : internet coupé » choisi dans l'admin : recopié sur la famille.
  await s.appeler('gestionSim', { action: 'modifier', id, champs: { finForfait: 'bloque' } }, TANGUY);
  assert.deepStrictEqual((await s.lire(`families/${fid}`)).forfaitSim, { mo: 2000, debut: aujourdhui, finForfait: 'bloque' });
  // Le numéro de la carte rejoint la fiche de la tablette dans la famille (tuile « Appeler » de l'app).
  const tablette = () => s.lire(`families/${fid}/members/${t.tabletUid}`);
  assert.strictEqual((await tablette()).telephone, '07 51 23 45 67');
  await s.appeler('gestionSim', { action: 'modifier', id, champs: { numero: '07 00 00 00 01' } }, TANGUY);
  assert.strictEqual((await tablette()).telephone, '07 00 00 00 01');
  // Tablette reliée avant que le numéro soit recopié (ou fiche effacée) : la tâche du matin (alerteMatin) le retrouve.
  await s.db.doc(`families/${fid}/members/${t.tabletUid}`).update({ telephone: s.FieldValue.delete() });
  assert.strictEqual((await tablette()).telephone, undefined);
  await s.tache('alerteMatin');
  assert.strictEqual((await tablette()).telephone, '07 00 00 00 01');
  // Carte retirée : plus de numéro (null : inutile de chercher encore).
  await s.appeler('gestionSim', { action: 'modifier', id, champs: { tablette: null } }, TANGUY);
  assert.strictEqual((await tablette()).telephone, null);
});

// Alerte de fin de forfait (forfait-alerte.js, Tanguy 5/11) : Papote à 80 et 95 %, la famille à 95 % avec un message
// selon ce que fait l'opérateur au bout, une seule fois par forfait ; forfait « internet coupé » épuisé puis
// tablette muette : « sans doute coupée par le forfait », jamais une panique « ne répond plus ».
async function familleSurSim(finForfait) {
  // 14 h à Paris (l'e-mail à la famille part en journée seulement).
  const heure = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  s.avancer(((14 - heure + 24) % 24) / 24);
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const t = await a.tablettePreparee();
  await a.afficherCode(t);
  const fid = await a.installer(paul, t, { nom: 'Mamie' });
  // Famille abonnée (sans commande reliée, l'installation la laisse « en attente » : pas d'alerte).
  await s.db.doc(`families/${fid}`).update({ 'abonnement.statut': 'actif' });
  const { id } = await s.appeler('gestionSim', { action: 'ajouter', champs: {
    statut: 'active', operateur: finForfait === 'bloque' ? 'Sosh' : 'Lyca', numero: '07 51 23 45 67', go: 1, activation: Date.now(), tablette: t.fiche, finForfait,
  } }, TANGUY);
  const forfait = (await s.lire(`families/${fid}`)).forfaitSim;
  assert.strictEqual(forfait.finForfait, finForfait);
  // Ce que la tablette envoie déjà (Sync.java : sim.dataCycleMo, plafondMo, niveau, cycleDebut) : rien de nouveau.
  const cycleDebut = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
  const fiche = s.db.doc(`families/${fid}/members/${t.tabletUid}`);
  const conso = (mo) => fiche.update({
    lastOnline: s.Timestamp.now(),
    sim: { operateur: 'Sosh', dataMoisMo: mo, dataCycleMo: mo, plafondMo: 1000, niveau: mo >= 950 ? 3 : mo >= 880 ? 2 : mo >= 700 ? 1 : 0, cycleDebut, vuLe: s.Timestamp.now() },
  });
  const fin = new Date(`${cycleDebut}T12:00:00Z`);
  fin.setUTCMonth(fin.getUTCMonth() + 1);
  const date = fin.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'Europe/Paris' });
  // E-mails et notifications de l'installation : hors sujet ici.
  await s.calme();
  s.boite.length = 0;
  s.notifications.length = 0;
  return { paul, fid, t, conso, fiche, date, sim: id };
}

const ADMIN = 'contact@mapapote.fr';

test('fin de forfait « débit réduit » : Papote à 80 et 95 %, la famille une fois à 95 % (appels plus lents jusqu\'au …)', async () => {
  const { paul, conso, fiche, date } = await familleSurSim('reduit');
  await conso(500);
  await s.tache('alerteForfait');
  assert.deepStrictEqual(s.boite, [], 'rien sous 80 %');
  await conso(812);
  await s.tache('alerteForfait');
  assert.deepStrictEqual(mailsA(ADMIN), ['Forfait SIM à 80 % : tablette de Mamie']);
  assert.deepStrictEqual(mailsA(paul.email), [], 'la famille n\'est pas dérangée à 80 %');
  await s.tache('alerteForfait');
  assert.strictEqual(s.boite.length, 1, 'une seule fois par seuil');
  await conso(962);
  await s.tache('alerteForfait');
  assert.deepStrictEqual(mailsA(ADMIN), ['Forfait SIM à 80 % : tablette de Mamie', 'Forfait SIM à 95 % : tablette de Mamie']);
  assert.deepStrictEqual(mailsA(paul.email), ['La tablette de Mamie a presque utilisé son forfait internet du mois']);
  const texte = s.boite.find((m) => m.a === paul.email).texte;
  assert.ok(texte.includes(`La tablette de Mamie a presque utilisé son forfait internet du mois : jusqu'au ${date} les appels vidéo seront plus lents ; branchez-la au wifi si vous pouvez.`), texte);
  await conso(990);
  await s.tache('alerteForfait');
  assert.strictEqual(s.boite.length, 3, 'rien de plus pendant ce forfait');
  assert.deepStrictEqual((await s.lire(fiche.path)).alerteForfait.admin, [80, 95]);
  const journal = await s.db.collection('alertes').where('genre', '==', 'forfait').get();
  assert.strictEqual(journal.size, 1, 'alerte à la famille comptée pour l\'admin');
});

test('fin de forfait « internet coupé » : la famille sait que c\'est coupé jusqu\'au …, puis la tablette muette n\'est pas une panne', async () => {
  const { paul, conso, fiche, date } = await familleSurSim('bloque');
  await conso(970);
  await s.tache('alerteForfait');
  assert.deepStrictEqual(mailsA(ADMIN), ['Forfait SIM à 95 % : tablette de Mamie'], '80 et 95 % passés d\'un coup : un seul e-mail');
  const texte = s.boite.find((m) => m.a === paul.email).texte;
  assert.ok(texte.includes(`La tablette de Mamie a presque utilisé son forfait internet du mois : internet sera coupé jusqu'au ${date} ; branchez-la au wifi si vous pouvez.`), texte);
  const admin95 = s.boite.find((m) => m.a === ADMIN).texte;
  assert.match(admin95, /Forfait « internet coupé » au bout/);

  // Le forfait s'épuise, l'opérateur coupe : plus de nouvelles de la tablette.
  await fiche.update({ lastOnline: s.Timestamp.fromMillis(Date.now() - 3 * 3600_000) });
  await s.tache('alerteForfait');
  assert.deepStrictEqual(mailsA(ADMIN).slice(1), ['Tablette de Mamie : internet sans doute coupé par le forfait']);
  assert.match(s.boite.at(-1).texte, /pas une panne\. Internet revient le/);
  assert.doesNotMatch(s.boite.at(-1).texte, /hors ligne/i);
  await s.tache('alerteForfait');
  assert.strictEqual(mailsA(ADMIN).length, 2, 'une seule fois');
  // Les téléphones de la famille : pas « ne répond plus », mais la raison et le geste utile.
  await s.tache('alertesTablettes');
  const n = s.notifications.filter((x) => x.type === 'alerte');
  assert.strictEqual(n.length, 1);
  assert.strictEqual(n[0].titre, 'La tablette de Mamie n\'a sans doute plus internet');
  assert.strictEqual(n[0].texte, `Son forfait du mois est épuisé, internet revient le ${date}. Branchez-la au wifi si vous pouvez.`);
});

test('achat Sosh par e-mail : confirmation, justificatif, puis vraie facture d\'un autre montant (8/11)', async () => {
  const piece = (filename) => ({ filename, contentType: 'application/pdf', content: Buffer.from('%PDF-1.4') });
  const lu = { facture: true, fournisseur: 'Sosh', categorie: 'sim', libelle: 'Carte SIM Sosh', tva: null, numero: null, ligne: null, accessoires: [], tablettes: null };
  const le5 = Date.UTC(2026, 10, 5, 12);
  // 1. Confirmation de commande : achat « facture pas encore reçue », SIM en stock avec son forfait.
  await g.rangerFacture({ ...lu, confirmation: true, montant: 1000, date: le5, numero: 'X041532676',
    cartesSim: { quantite: 1, operateur: 'Sosh', iccids: [], numeros: [], prixCarte: 1000, forfait: 299, go: 1, renouvellementAuto: true, dureeForfait: 30, finForfait: null },
  }, piece('confirmation-commande.txt'), 'e-mail de Sosh');
  const achats = async () => (await s.db.collection('depenses').where('fournisseur', '==', 'Sosh').get()).docs;
  const [achat] = await achats();
  assert.strictEqual(achat.get('confirmation'), true);
  const sims = async () => (await s.db.collection('sims').where('depense', '==', achat.id).get()).docs.map((d) => d.data());
  const [sim] = await sims();
  assert.deepStrictEqual([sim.prix, sim.go, sim.renouvellementAuto, sim.dureeForfait, sim.numero], [299, 1, true, 30, null], 'fiche SIM préremplie');
  assert.strictEqual(sim.finForfait, undefined, 'fin de forfait pas écrite dans le mail : laissée vide');

  // 2. « Bienvenue chez Sosh » : « Justificatif d'achat.pdf » lu comme une facture de 10 € par l'IA.
  const justificatif = g.confirmationSelonTitre({ ...lu, confirmation: false, montant: 1000, date: le5 + 2 * s.JOUR, ligne: '06 08 99 16 12' }, "Justificatif d'achat.pdf");
  assert.match(await g.rangerFacture(justificatif, piece("Justificatif d'achat.pdf"), 'e-mail de Sosh'), /déjà enregistrée/);
  assert.strictEqual((await s.lire(`depenses/${achat.id}`)).confirmation, true, 'toujours « facture pas encore reçue »');
  assert.strictEqual((await sims())[0].numero, '0608991612', 'le numéro de la ligne complète la carte SIM');

  // 3. 1re facture Sosh : 10 € d'activation + le forfait = 12,99 €. Rattachée à l'achat, pas de 2e dépense.
  const r = await g.rangerFacture({ ...lu, confirmation: false, montant: 1299, tva: 217, numero: 'FA-2026-11', date: le5 + 15 * s.JOUR }, piece('Facture.pdf'), 'e-mail de Sosh');
  assert.deepStrictEqual(r, { materiel: [], rattachee: true, montantDifferent: true });
  assert.strictEqual((await achats()).length, 1, 'une seule dépense Sosh');
  const apres = await s.lire(`depenses/${achat.id}`);
  assert.deepStrictEqual([apres.confirmation, apres.montant, apres.tva, apres.numero, apres.aVerifier], [false, 1299, 217, 'FA-2026-11', true]);
  assert.match(apres.remarque, /12,99 €.*10,00 €/);
  assert.strictEqual((await sims()).length, 1, 'pas de 2e carte SIM');

  // 4. « Ce n'est pas la facture » depuis l'admin : l'achat repasse en « facture pas encore reçue ».
  await s.appeler('gestionDepense', { action: 'attendreFacture', id: achat.id }, TANGUY);
  assert.strictEqual((await s.lire(`depenses/${achat.id}`)).confirmation, true);
});
