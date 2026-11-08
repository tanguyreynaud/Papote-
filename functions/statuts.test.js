const test = require('node:test');
const assert = require('node:assert');
const s = require('./statuts');

const permis = (refus) => assert.strictEqual(refus, '');
const refuse = (refus, motif) => assert.match(refus, motif);

test('étiquette aller : seulement une commande à envoyer', () => {
  permis(s.refusEtiquette({ expedition: 'a-preparer' }, 'aller'));
  refuse(s.refusEtiquette({ expedition: 'envoyee' }, 'aller'), /déjà envoyée/);
  refuse(s.refusEtiquette({ expedition: 'paiement-en-attente' }, 'aller'), /SEPA/);
  refuse(s.refusEtiquette({ expedition: 'annulee' }, 'aller'), /pas à envoyer/);
});

test('étiquette retour : seulement s\'il y a du matériel à récupérer (Tanguy, 30/10)', () => {
  // L'exemple de Tanguy : commande pas envoyée, rien de reçu.
  refuse(s.refusEtiquette({ expedition: 'a-preparer' }, 'retour'), /Rien à récupérer/);
  refuse(s.refusEtiquette({ expedition: 'annulee' }, 'retour'), /Rien à récupérer/);
  refuse(s.refusEtiquette({ expedition: 'envoyee', fid: 'f' }, 'retour'), /Rien à récupérer/);
  // Fin de contrat ou changement d'avis après l'envoi.
  permis(s.refusEtiquette({ expedition: 'envoyee', restitution: { statut: 'attendue' } }, 'retour'));
  permis(s.refusEtiquette({ expedition: 'annulee', envoyeeLe: 1, restitution: { statut: 'echec' } }, 'retour'));
  // Retour attendu d'une tablette jamais partie : rien à renvoyer.
  refuse(s.refusEtiquette({ expedition: 'a-preparer', restitution: { statut: 'attendue' } }, 'retour'), /Rien à récupérer/);
  // Commande offerte d'une famille supprimée, tablette remplacée chez le client.
  permis(s.refusEtiquette({ restitution: { statut: 'a-recuperer' } }, 'retour'));
  permis(s.refusEtiquette({ expedition: 'envoyee', fid: 'f' }, 'retour', { remplacee: true }));
  // Matériel déjà rendu ou facturé.
  refuse(s.refusEtiquette({ expedition: 'envoyee', restitution: { statut: 'rendue' } }, 'retour'), /Rien à récupérer/);
});

test('colis envoyé : commande à envoyer, ou numéro corrigé ; en main propre, seulement à envoyer', () => {
  permis(s.refusEnvoi({ expedition: 'a-preparer' }));
  permis(s.refusEnvoi({ expedition: 'envoyee' }));
  refuse(s.refusEnvoi({ expedition: 'annulee' }), /annulée/);
  refuse(s.refusEnvoi({ expedition: 'paiement-en-attente' }), /SEPA/);
  permis(s.refusEnvoi({ expedition: 'a-preparer' }, { mainPropre: true }));
  refuse(s.refusEnvoi({ expedition: 'envoyee' }, { mainPropre: true }), /déjà envoyée/);
  refuse(s.refusEnvoi({ expedition: 'annulee' }, { mainPropre: true }), /annulée/);
});

test('« le client a reçu le colis » : seulement un colis parti', () => {
  permis(s.refusReception({ expedition: 'envoyee' }));
  refuse(s.refusReception({ expedition: 'a-preparer' }), /pas encore parti/);
  refuse(s.refusReception({ expedition: 'paiement-en-attente' }), /pas encore parti/);
  refuse(s.refusReception({ expedition: 'annulee' }), /annulée/);
});

test('matériel rendu : seulement un retour attendu', () => {
  for (const statut of ['attendue', 'echec', 'a-recuperer']) permis(s.refusRetourMateriel({ restitution: { statut } }));
  refuse(s.refusRetourMateriel({ expedition: 'envoyee', fid: 'f' }), /Aucun retour/);
  refuse(s.refusRetourMateriel({ expedition: 'a-preparer' }), /Aucun retour/);
  refuse(s.refusRetourMateriel({ restitution: { statut: 'rendue' } }), /déjà noté rendu/);
  permis(s.refusRetourMateriel({ restitution: { statut: 'facturee' } }));
});

test('tablette reliée à une commande : ni inutilisable, ni commande annulée', () => {
  permis(s.refusLienCommande({}, 'en-stock', { expedition: 'a-preparer' }));
  permis(s.refusLienCommande({}, 'commandee', { expedition: 'a-preparer' }));
  for (const etat of ['perdue', 'hors-service', 'a-reparer']) refuse(s.refusLienCommande({}, etat, { expedition: 'a-preparer' }), /perdue, hors service ou à réparer/);
  refuse(s.refusLienCommande({}, 'en-stock', { expedition: 'annulee' }), /annulée/);
  // Tablette jumelée à une famille : pas à vendre, sauf pour une commande de cette même famille.
  refuse(s.refusLienCommande({ fid: 'test' }, 'en-stock', { expedition: 'a-preparer', fid: 'client' }), /dans une famille : pas à vendre/);
  refuse(s.refusLienCommande({ fid: 'test' }, 'en-stock', { expedition: 'a-preparer' }), /pas à vendre/);
  permis(s.refusLienCommande({ fid: 'f' }, 'chez-client', { expedition: 'envoyee', fid: 'f' }));
});

test('cartes SIM : statuts, recharge et suppression', () => {
  permis(s.refusStatutSim('stock', 'active'));
  permis(s.refusStatutSim('active', 'suspendue'));
  permis(s.refusStatutSim('suspendue', 'active'));
  permis(s.refusStatutSim('active', 'resiliee'));
  permis(s.refusStatutSim('active', 'active'));
  permis(s.refusStatutSim(undefined, 'active'));
  refuse(s.refusStatutSim('resiliee', 'active'), /résiliée ne peut pas passer active/);
  refuse(s.refusStatutSim('active', 'stock'), /ne peut pas passer/);
  permis(s.refusRecharge({ statut: 'active' }));
  for (const statut of ['stock', 'suspendue', 'resiliee']) refuse(s.refusRecharge({ statut }), /Seule une ligne active/);
  permis(s.refusSuppressionSim({}, null));
  permis(s.refusSuppressionSim({}, { etat: 'en-stock' }));
  for (const etat of ['envoyee', 'chez-client', 'en-retour']) refuse(s.refusSuppressionSim({}, { etat }), /chez un client/);
});

test('envoi : tablette reliée et carte SIM obligatoires pour l\'offre tout compris', () => {
  const c = { expedition: 'a-preparer', formule: 'sim' };
  refuse(s.refusEnvoiSansSim(c, []), /Reliez d'abord la tablette/);
  refuse(s.refusEnvoiSansSim(c, [{ etat: 'preparee', ref: 'T-004' }]), /carte SIM à la tablette T-004/);
  // Carte SIM sans numéro de ligne (Tanguy, 8/11) : refusé aussi.
  refuse(s.refusEnvoiSansSim(c, [{ etat: 'preparee', ref: 'T-004', simId: 'sim1' }]), /numéro de ligne de la carte SIM de la tablette T-004/);
  refuse(s.refusEnvoiSansSim(c, [{ etat: 'preparee', simId: 'sim1' }], { sim1: { iccid: '8933' } }), /numéro de ligne/);
  refuse(s.refusEnvoiSansSim(c, [{ etat: 'preparee', simId: 'sim1' }], { sim1: { numero: '  ' } }), /numéro de ligne/);
  permis(s.refusEnvoiSansSim(c, [{ etat: 'preparee', simId: 'sim1' }], { sim1: { numero: '07 45 91 77 17' } }));
  // Formule absente (commande récente) : la carte reste obligatoire.
  refuse(s.refusEnvoiSansSim({ expedition: 'a-preparer' }, [{ etat: 'preparee' }]), /carte SIM/);
  // Numéro de suivi corrigé après le départ, ancienne commande Wi-Fi : rien de plus demandé.
  permis(s.refusEnvoiSansSim({ expedition: 'envoyee', formule: 'sim' }, []));
  permis(s.refusEnvoiSansSim({ expedition: 'a-preparer', formule: 'wifi' }, []));
});

test('départ d\'une tablette (envoi, étiquette, remplacement) : carte SIM avec numéro obligatoire', () => {
  refuse(s.refusSimSansNumero({ ref: 'T-007' }, null), /Reliez d'abord une carte SIM à la tablette T-007/);
  refuse(s.refusSimSansNumero({ ref: 'T-007', simId: 'x' }, null), /numéro de ligne/);
  refuse(s.refusSimSansNumero({ simId: 'x' }, { iccid: '8933', numero: null }), /numéro de ligne/);
  permis(s.refusSimSansNumero({ simId: 'x' }, { numero: '0608991612' }));
});

test('étiquette en double (double clic, vieil onglet) : refusée tant que l\'ancienne n\'a pas servi ou n\'est pas vieille de 30 jours', () => {
  const maintenant = Date.now();
  permis(s.refusEtiquetteEnDouble({}, 'retour', maintenant));
  permis(s.refusEtiquetteEnDouble({ etiquettes: { aller: { colis: 1, le: maintenant } } }, 'retour', maintenant), 'un autre sens ne compte pas');
  refuse(s.refusEtiquetteEnDouble({ etiquettes: { retour: { colis: 1, le: maintenant - 3600e3 } } }, 'retour', maintenant), /existe déjà/);
  refuse(s.refusEtiquetteEnDouble({ etiquettes: { aller: { colis: 1, le: maintenant } } }, 'aller', maintenant), /existe déjà/);
  permis(s.refusEtiquetteEnDouble({ etiquettes: { retour: { colis: 1, le: maintenant, livre: true } } }, 'retour', maintenant), 'colis arrivé : une nouvelle est possible');
  permis(s.refusEtiquetteEnDouble({ etiquettes: { retour: { colis: 1, le: maintenant - 31 * 864e5 } } }, 'retour', maintenant), 'vieille de 31 jours');
});
