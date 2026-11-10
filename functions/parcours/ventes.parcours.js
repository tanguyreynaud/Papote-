// Factures de vente gardées chez Papote (Tanguy, 10/11) : chaque facture Stripe copiée en PDF (une seule fois, même
// tâche relancée), PDF indisponible puis revenu, et contrôle de la clôture du mois « une facture = un PDF = un
// paiement » (rien à signaler, puis copie impossible : signalée avec le trou de numérotation).

const test = require('node:test');
const assert = require('node:assert');
const s = require('./simulation');
const a = require('./acteurs');
const { brancher } = require('./commun');

brancher();

const pieces = async () => (await s.db.collection('gestion/ventes/pieces').get()).docs.map((d) => ({ id: d.id, ...d.data() }))
  .sort((x, y) => x.numero.localeCompare(y.numero));
const copier = async () => { await s.tache('gestionCopieVentes'); await s.calme(); };

// Mois à Paris (« AAAA-MM ») de l'instant simulé, et nombre de jours jusqu'au 2 du mois suivant.
function moisEnCours() {
  const d = new Date(Date.now() + 3600e3);
  const suivant = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 2, 12));
  return { cle: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, jours: (suivant - d) / s.JOUR };
}

async function cloturer(cle) {
  await s.appeler('gestionCloturer', { mois: cle }, a.TANGUY);
  await s.calme();
  return (await s.lire('gestion/archives')).mois[cle];
}

test('chaque facture copiée une seule fois ; PDF indisponible puis revenu ; clôture sans rien à signaler', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  s.avancer(31);
  s.stripe.finirEssai(id);
  await s.calme();
  const { cle, jours } = moisEnCours();

  await copier();
  let p = await pieces();
  assert.deepStrictEqual(p.map((x) => [x.numero, x.type, x.statut, x.abonnement]), [
    ['PAP-0001', 'facture', 'paid', id], // mise en service
    ['PAP-0002', 'facture', 'paid', id], // premier mois
  ]);
  assert.ok(p.every((x) => /^gestion\/ventes\/\d{4}\/facture-PAP-000\d\.pdf$/.test(x.chemin) && x.octets > 0 && /^[0-9a-f]{64}$/.test(x.sha256)));
  assert.deepStrictEqual(s.fichiersGardes.filter((f) => f.startsWith('gestion/ventes/')).length, 2);

  // Tâche relancée : rien n'est recopié.
  await copier();
  assert.strictEqual(s.fichiersGardes.filter((f) => f.startsWith('gestion/ventes/')).length, 2);

  // Stripe ne donne pas le PDF du mois suivant : rien de gardé (jamais une page d'erreur), nouvel essai le lendemain.
  s.stripe.prelevementMensuel(id);
  await s.calme();
  s.reglages.pdfEnPanne = 1;
  await copier();
  assert.strictEqual((await pieces()).length, 2);
  assert.ok(s.journal.some((l) => /PAP-0003 : copie du PDF ratée/.test(l)));
  await copier();
  p = await pieces();
  assert.deepStrictEqual(p.map((x) => x.numero), ['PAP-0001', 'PAP-0002', 'PAP-0003']);

  // Clôture du mois : chaque facture a sa copie et son paiement.
  s.avancer(jours);
  const fiche = await cloturer(cle);
  assert.deepStrictEqual(fiche.controle, []);
});

test('clôture : une facture sans copie possible est signalée, avec le trou de numérotation', async () => {
  const paul = await s.compte('Paul', 'paul@exemple.fr');
  const { abonnement: id } = await a.commanderEtPayer({ email: paul.email });
  s.avancer(31);
  s.stripe.finirEssai(id);
  await s.calme();
  s.stripe.prelevementMensuel(id);
  await s.calme();
  const { cle, jours } = moisEnCours();
  // La copie de la facture du milieu (PAP-0002) n'a jamais pu se faire.
  await copier();
  await s.db.doc(`gestion/ventes/pieces/${[...s.stripe.etat.factures.values()].find((f) => f.number === 'PAP-0002').id}`).delete();
  s.avancer(jours);
  s.reglages.pdfEnPanne = 10;
  const fiche = await cloturer(cle);
  s.reglages.pdfEnPanne = 0;
  const attendu = [
    'Facture PAP-0002 : pas de copie du PDF chez Papote',
    'Numérotation : PAP-0002 manque (aucune copie gardée)',
  ];
  // La mise en service est d'un autre mois si la commande date du mois d'avant : seules ces lignes comptent.
  assert.deepStrictEqual(fiche.controle.filter((l) => /PAP-0002/.test(l)), attendu);
  // Le récapitulatif envoyé à Papote le dit aussi.
  const recap = s.boite.filter((m) => m.a === 'contact@mapapote.fr').pop();
  assert.match(recap.texte || '', /Factures à vérifier : .*PAP-0002/);
});
