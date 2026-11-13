// Tous les e-mails envoyés par les fonctions (functions/mail.js), chacun dans toutes ses variantes, affichés
// comme dans une boîte de réception : sur un téléphone (390 px) et sur un ordinateur (720 px, la largeur d'une
// lecture dans Gmail). Rien n'est envoyé : les e-mails sont fabriqués avec de fausses données puis capturés.
//
// Ajouter un e-mail : une ligne dans SCENES (titre, groupe, contenu = mail.xxx({ … })).
'use strict';

const path = require('path');

const TAILLES = [
  { nom: 'telephone', width: 390, height: 844 },
  { nom: 'ordinateur', width: 720, height: 800 },
];

const J = 864e5;
const MAINTENANT = new Date('2026-10-26T10:30:00+01:00').getTime();
const dans = (jours) => MAINTENANT + jours * J;
const RELAIS = { transporteur: 'mondial-relay', nom: 'Tabac de la Gare', id: '012345', adresse: '4 rue de la Gare', cp: '69003', ville: 'Lyon', destinataire: 'Julie Martin' };
const ADRESSE = { nom: 'Julie Martin', adresse: '12 rue des Lilas', cp: '69003', ville: 'Lyon' };
const APPLI = 'https://app.mapapote.fr/';
const SUIVI = 'https://www.mondialrelay.fr/suivi-de-colis/?numeroExpedition=12345678&codePostal=69003';
const QR = 'https://app.mapapote.fr/?retour=1';
const ETIQUETTE = 'https://panel.sendcloud.sc/etiquette/123.pdf';
const DESINSCRIPTION = 'https://mapapote.fr/desinscription?c=0123456789abcdef0123456789abcdef&j=0123456789abcdef0123456789abcdef';
const CHAT = [
  { role: 'user', content: 'Est-ce que ça marche sans internet chez ma mère ?' },
  { role: 'assistant', content: 'Oui : la tablette est livrée avec sa carte SIM 4G, incluse dans les 25 € par mois. Il n\'y a rien à installer.' },
  { role: 'user', content: 'Et si elle est en maison de retraite, c\'est possible ?' },
];

// Les scènes, dans l'ordre des flux : commande → livraison → famille → abonnement → fin → site → interne.
function scenes(mail) {
  const G1 = 'Commande et livraison';
  const G2 = 'Famille';
  const G3 = 'Abonnement';
  const G4 = 'Fin de contrat et retour de la tablette';
  const G5 = 'Chat d\'aide du site';
  const G6 = 'Pour Tanguy (e-mails internes)';
  const si = (f, args) => (typeof mail[f] === 'function' ? mail[f](args) : null);
  return [
    { titre: 'Commande confirmée (point relais)', groupe: G1, fonction: 'commandeConfirmee', contenu: si('commandeConfirmee', { nom: 'Julie', code: 'ABCD-1234', relais: RELAIS }) },
    { titre: 'Commande confirmée (adresse, sans point relais)', groupe: G1, fonction: 'commandeConfirmee', contenu: si('commandeConfirmee', { nom: 'Julie', code: 'ABCD-1234', relais: ADRESSE }) },
    { titre: 'Abonnement pris dans l\'appli (tablette déjà installée)', groupe: G1, fonction: 'commandeConfirmee', contenu: si('commandeConfirmee', { nom: 'Julie', code: 'ABCD-1234', dejaInstallee: true }) },
    { titre: 'Abonnement repris après une résiliation', groupe: G1, fonction: 'commandeConfirmee', contenu: si('commandeConfirmee', { nom: 'Julie', code: 'ABCD-1234', dejaInstallee: true, reprise: true }) },
    { titre: 'Paiement SEPA refusé (client)', groupe: G1, fonction: 'sepaRefuse', contenu: si('sepaRefuse', { nom: 'Julie' }) },
    { titre: 'Panier abandonné, rappel 1 (une heure après)', groupe: G1, fonction: 'relancePanier', contenu: si('relancePanier', { etape: 1, nom: 'Julie', lien: 'https://mapapote.fr/commande.html?reprise=1', desinscription: DESINSCRIPTION }) },
    { titre: 'Panier abandonné, rappel 2 (le lendemain soir)', groupe: G1, fonction: 'relancePanier', contenu: si('relancePanier', { etape: 2, nom: 'Julie', lien: 'https://mapapote.fr/commande.html?reprise=1', desinscription: DESINSCRIPTION }) },
    { titre: 'Panier abandonné, rappel 3 (une semaine après, le dernier)', groupe: G1, fonction: 'relancePanier', contenu: si('relancePanier', { etape: 3, nom: 'Julie', lien: 'https://mapapote.fr/commande.html?reprise=1', desinscription: DESINSCRIPTION }) },
    { titre: '« Être prévenu » : c\'est noté (avec téléphone)', groupe: G1, fonction: 'listeAttenteConfirmee', note: 'Nouveau : rien ne partait avant.', contenu: si('listeAttenteConfirmee', { prenom: 'Julie', telephone: '06 12 34 56 78', desinscription: DESINSCRIPTION }) },
    { titre: '« Être prévenu » : c\'est noté (sans téléphone)', groupe: G1, fonction: 'listeAttenteConfirmee', contenu: si('listeAttenteConfirmee', { prenom: '', desinscription: DESINSCRIPTION }) },
    { titre: 'Tablettes disponibles : vous pouvez commander', groupe: G1, fonction: 'lancement', contenu: si('lancement', { prenom: 'Julie', desinscription: DESINSCRIPTION }) },
    { titre: 'Tablette en route (suivi Mondial Relay)', groupe: G1, fonction: 'colisParti', contenu: si('colisParti', { nom: 'Julie', suivi: '12345678', lien: SUIVI, relais: RELAIS, code: 'ABCD-1234' }) },
    { titre: 'Tablette remise en main propre', groupe: G1, fonction: 'tabletteRemise', contenu: si('tabletteRemise', { nom: 'Julie', code: 'ABCD-1234' }) },
    { titre: 'Rappel de jumelage 1 (J+5)', groupe: G1, fonction: 'rappelJumelage', contenu: si('rappelJumelage', { nom: 'Julie', numero: 1, code: 'ABCD-1234' }) },
    { titre: 'Rappel de jumelage 2 (J+12)', groupe: G1, fonction: 'rappelJumelage', contenu: si('rappelJumelage', { nom: 'Julie', numero: 2, code: 'ABCD-1234' }) },
    { titre: 'Commande annulée avant l\'envoi (remboursée)', groupe: G1, fonction: 'commandeAnnulee', contenu: si('commandeAnnulee', { nom: 'Julie', rembourse: 6000 }) },
    { titre: 'Commande annulée avant l\'envoi (rien prélevé)', groupe: G1, fonction: 'commandeAnnulee', contenu: si('commandeAnnulee', { nom: 'Julie', rembourse: 0 }) },
    { titre: 'Colis jamais retiré, revenu chez Papote (remboursé)', groupe: G1, fonction: 'colisRevenu', note: 'Nouveau (A4, 12/11) : avant, « la tablette ne partira pas ».', contenu: si('colisRevenu', { nom: 'Julie', rembourse: 6000 }) },

    { titre: 'Invitation d\'un proche', groupe: G2, fonction: 'invitation', contenu: si('invitation', { prenom: 'Julie', tablette: 'Mamie Jeanne', lien: `${APPLI}?famille=abc`, email: 'thomas.martin@gmail.com' }) },
    { titre: 'Quelqu\'un veut rejoindre la famille (aux responsables)', groupe: G2, fonction: 'demandeRejoindre', contenu: si('demandeRejoindre', { prenom: 'Anne', email: 'anne.durand@gmail.com', famille: 'Mamie Jeanne' }) },
    { titre: 'Demande acceptée (à la personne)', groupe: G2, fonction: 'demandeAcceptee', note: 'Nouveau : rien ne partait avant.', contenu: si('demandeAcceptee', { prenom: 'Anne', famille: 'Mamie Jeanne', lien: APPLI }) },
    { titre: 'Installation terminée : la tablette est prête', groupe: G2, fonction: 'installationFinie', note: 'Nouveau : le mode d\'emploi en quatre lignes, à garder.', contenu: si('installationFinie', { prenom: 'Julie', famille: 'Mamie Jeanne', lien: APPLI }) },
    { titre: 'Appel sans aucun téléphone qui sonne', groupe: G2, fonction: 'appelSansTelephone', contenu: si('appelSansTelephone', { nom: 'Mamie Jeanne', sos: false, lien: APPLI }) },
    { titre: 'SOS sans aucun téléphone qui sonne', groupe: G2, fonction: 'appelSansTelephone', contenu: si('appelSansTelephone', { nom: 'Mamie Jeanne', sos: true, lien: APPLI }) },
    { titre: 'Forfait internet presque épuisé : débit réduit ensuite (aux responsables, 95 %)', groupe: G2, fonction: 'forfaitPresqueEpuise', note: 'Nouveau (5/11).', contenu: si('forfaitPresqueEpuise', { nom: 'Mamie Jeanne', type: 'reduit', fin: dans(16), lien: APPLI }) },
    { titre: 'Forfait internet presque épuisé : internet coupé ensuite (aux responsables, 95 %)', groupe: G2, fonction: 'forfaitPresqueEpuise', note: 'Nouveau (5/11).', contenu: si('forfaitPresqueEpuise', { nom: 'Mamie Jeanne', type: 'bloque', fin: dans(16), lien: APPLI }) },

    { titre: 'Paiement de l\'abonnement refusé', groupe: G3, fonction: 'paiementEchoue', contenu: si('paiementEchoue', { nom: 'Julie', famille: 'Mamie Jeanne', pauseLe: dans(7), lien: `${APPLI}?abonnement=1` }) },
    { titre: 'Papote en pause (impayé après 7 jours)', groupe: G3, fonction: 'papoteEnPause', contenu: si('papoteEnPause', { nom: 'Julie', famille: 'Mamie Jeanne', lien: `${APPLI}?abonnement=1` }) },
    { titre: 'Passer au prélèvement SEPA (15 jours après le 1er prélèvement par carte)', groupe: G3, fonction: 'passerAuSepa', note: 'Nouveau (10/11).', contenu: si('passerAuSepa', { nom: 'Julie', famille: 'Mamie Jeanne', lien: APPLI }) },
    { titre: 'Passer au prélèvement SEPA : relance unique (30 jours après)', groupe: G3, fonction: 'passerAuSepa', note: 'Nouveau (10/11).', contenu: si('passerAuSepa', { nom: 'Julie', famille: 'Mamie Jeanne', relance: true, lien: APPLI }) },
    { titre: 'Résiliation enregistrée (par le client)', groupe: G3, fonction: 'resiliationEnregistree', note: 'Ajouté par le fil Gestion.', contenu: si('resiliationEnregistree', { nom: 'Julie', famille: 'Mamie Jeanne', le: dans(30), tablettePretee: true }) },
    { titre: 'Papote arrête votre abonnement (par l\'admin)', groupe: G3, fonction: 'resiliationEnregistree', note: 'Ajouté par le fil Gestion.', contenu: si('resiliationEnregistree', { nom: 'Julie', famille: 'Mamie Jeanne', le: dans(30), tablettePretee: true, parPapote: true }) },
    { titre: '« Garder mon abonnement » : l\'abonnement continue', groupe: G3, fonction: 'resiliationAnnulee', note: 'Ajouté par le fil Gestion.', contenu: si('resiliationAnnulee', { nom: 'Julie', famille: 'Mamie Jeanne' }) },
    { titre: 'Hospitalisation : prélèvements en pause', groupe: G3, fonction: 'pausePrelevements', note: 'Nouveau : rien ne partait avant.', contenu: si('pausePrelevements', { nom: 'Julie', famille: 'Mamie Jeanne', jusqua: dans(60) }) },
    { titre: 'Hospitalisation : les prélèvements reprennent', groupe: G3, fonction: 'reprisePrelevements', note: 'Nouveau : rien ne partait avant.', contenu: si('reprisePrelevements', { nom: 'Julie', famille: 'Mamie Jeanne' }) },

    { titre: 'Abonnement terminé : comment rendre la tablette', groupe: G4, fonction: 'retourTablette', contenu: si('retourTablette', { nom: 'Julie', avant: dans(30), retractation: null, montant: 15000 }) },
    { titre: 'Commande annulée après l\'envoi : rendre la tablette, remboursement au retour', groupe: G4, fonction: 'retourTablette', contenu: si('retourTablette', { nom: 'Julie', avant: dans(30), retractation: 6000, montant: 15000 }) },
    { titre: 'QR code de retour (fin d\'abonnement)', groupe: G4, fonction: 'etiquetteRetour', contenu: si('etiquetteRetour', { nom: 'Julie', lien: QR, qr: true, avant: dans(30), fin: true, retractation: null, montant: 15000 }) },
    { titre: 'QR code de retour (commande annulée, remboursement au retour)', groupe: G4, fonction: 'etiquetteRetour', contenu: si('etiquetteRetour', { nom: 'Julie', lien: QR, qr: true, avant: dans(30), fin: true, retractation: 6000, montant: 15000 }) },
    { titre: 'Étiquette à imprimer (fin d\'abonnement)', groupe: G4, fonction: 'etiquetteRetour', contenu: si('etiquetteRetour', { nom: 'Julie', lien: ETIQUETTE, qr: false, avant: dans(30), fin: true, retractation: null, montant: 15000 }) },
    { titre: 'Étiquette pour remplacer un élément (chargeur…)', groupe: G4, fonction: 'etiquetteRetour', contenu: si('etiquetteRetour', { nom: 'Julie', lien: ETIQUETTE, qr: false, fin: false }) },
    { titre: 'Rappel : pensez à rendre la tablette (QR code déjà créé)', groupe: G4, fonction: 'rappelRestitution', contenu: si('rappelRestitution', { nom: 'Julie', avant: dans(10), lien: QR, qr: true, montant: 15000 }) },
    { titre: 'Rappel : pensez à rendre la tablette (sans QR code)', groupe: G4, fonction: 'rappelRestitution', contenu: si('rappelRestitution', { nom: 'Julie', avant: dans(10), lien: null, qr: false, montant: 15000 }) },
    { titre: 'Tablette bien reçue', groupe: G4, fonction: 'tabletteRecue', contenu: si('tabletteRecue', { nom: 'Julie', rembourse: 0 }) },
    { titre: 'Tablette bien reçue, remboursement', groupe: G4, fonction: 'tabletteRecue', contenu: si('tabletteRecue', { nom: 'Julie', rembourse: 6000 }) },
    { titre: 'Tablette reçue, chargeur manquant prélevé', groupe: G4, fonction: 'tabletteRecue', note: 'Avant, l\'e-mail disait « plus rien ne sera prélevé » même avec un élément manquant.', contenu: si('tabletteRecue', { nom: 'Julie', rembourse: 0, manquants: ['chargeur et câble'], montant: 1000 }) },
    { titre: 'Tablette reçue, élément manquant mais prélèvement refusé', groupe: G4, fonction: 'tabletteRecue', note: 'Nouveau : rien ne partait avant.', contenu: si('tabletteRecue', { nom: 'Julie', rembourse: 0, manquants: ['chargeur et câble', 'enceinte'], montant: 2000, echec: true }) },
    { titre: 'Tablette jamais rendue : matériel prélevé', groupe: G4, fonction: 'materielNonRendu', note: 'Nouveau : rien ne partait avant.', contenu: si('materielNonRendu', { nom: 'Julie', montant: 15000, avant: dans(-1) }) },

    { titre: 'Demande de rappel : bien reçu (au visiteur)', groupe: G5, fonction: 'rappelConfirme', note: 'Nouveau : rien ne partait avant.', contenu: si('rappelConfirme', { nom: 'Julie Martin', telephone: '06 12 34 56 78' }) },

    { titre: 'Nouvelle commande (tablette en stock)', groupe: G6, fonction: 'nouvelleCommande', contenu: si('nouvelleCommande', { nom: 'Julie Martin', email: 'julie.martin@gmail.com', telephone: '06 12 34 56 78', code: 'ABCD-1234', relais: RELAIS, proche: { adresse: '8 rue du Griffon, 69001 Lyon', couverture4g: 'TBC' }, delai: 'stock', commande: 'sub_123' }) },
    { titre: 'Nouvelle commande (plus de stock, à préparer vite)', groupe: G6, fonction: 'nouvelleCommande', contenu: si('nouvelleCommande', { nom: 'Julie Martin', email: 'julie.martin@gmail.com', code: 'ABCD-1234', relais: ADRESSE, proche: { adresse: 'Le Bourg, 63490 Brousse', couverture4g: 'commune:85' }, delai: 'precommande', commande: 'sub_123' }) },
    { titre: 'Nouvel abonnement (tablette déjà installée)', groupe: G6, fonction: 'nouvelleCommande', contenu: si('nouvelleCommande', { nom: 'Julie Martin', email: 'julie.martin@gmail.com', code: 'ABCD-1234', dejaInstallee: true, commande: 'sub_123' }) },
    { titre: 'Abonnement repris', groupe: G6, fonction: 'nouvelleCommande', contenu: si('nouvelleCommande', { nom: 'Julie Martin', email: 'julie.martin@gmail.com', code: 'ABCD-1234', dejaInstallee: true, reprise: true, commande: 'sub_123' }) },
    { titre: 'Paiement SEPA refusé (commande annulée)', groupe: G6, fonction: 'sepaRefuse', contenu: si('sepaRefuse', { nom: 'Julie Martin', email: 'julie.martin@gmail.com', papote: true, commande: 'sub_123' }) },
    { titre: 'Commande annulée par le client avant l\'envoi', groupe: G6, fonction: 'annulationAvantEnvoi', contenu: si('annulationAvantEnvoi', { nom: 'Julie Martin', email: 'julie.martin@gmail.com', code: 'ABCD-1234', commande: 'sub_123' }) },
    { titre: 'Un client a résilié (retour attendu)', groupe: G6, fonction: 'resiliation', contenu: si('resiliation', { nom: 'Julie Martin', email: 'julie.martin@gmail.com', code: 'ABCD-1234', commande: 'sub_123', retractation: null }) },
    { titre: 'Un client a annulé après l\'envoi (colis de retour suivi)', groupe: G6, fonction: 'resiliation', contenu: si('resiliation', { nom: 'Julie Martin', email: 'julie.martin@gmail.com', code: 'ABCD-1234', commande: 'sub_123', retractation: 6000, suivi: '87654321', lienSuivi: SUIVI }) },
    { titre: 'Alerte : forfait SIM à 80 % (débit réduit ensuite)', groupe: G6, fonction: 'alerteForfait', note: 'Nouveau (5/11).', contenu: si('alerteForfait', { nom: 'Mamie Jeanne', famille: 'fam-jeanne', pourCent: 81, conso: 812, plafond: 1000, debut: dans(-14), fin: dans(16), type: 'reduit', seuil: 80, commande: 'sub_123' }) },
    { titre: 'Alerte : forfait SIM à 95 % (internet coupé ensuite)', groupe: G6, fonction: 'alerteForfait', note: 'Nouveau (5/11).', contenu: si('alerteForfait', { nom: 'Mamie Jeanne', famille: 'fam-jeanne', pourCent: 96, conso: 962, plafond: 1000, debut: dans(-14), fin: dans(16), type: 'bloque', seuil: 95, commande: 'sub_123' }) },
    { titre: 'Alerte : internet sans doute coupé par le forfait (pas une panne)', groupe: G6, fonction: 'alerteForfait', note: 'Nouveau (5/11).', contenu: si('alerteForfait', { nom: 'Mamie Jeanne', famille: 'fam-jeanne', pourCent: 98, conso: 981, plafond: 1000, debut: dans(-14), fin: dans(16), type: 'bloque', coupee: true, commande: 'sub_123' }) },
    { titre: 'Alerte : carte SIM hors service depuis plus de 2 h', groupe: G6, fonction: 'alerteSimHorsService', note: 'Nouveau (13/11) : une fois par panne, Tanguy seul.', contenu: si('alerteSimHorsService', { nom: 'Mamie Jeanne', famille: 'fam-jeanne', ref: 'T-003', operateur: 'Lyca Mobile', depuis: dans(0) - 2.2 * 3600e3, commande: 'sub_123', motif: 'service', service: 'hors service', duree: '2 h 10' }) },
    { titre: 'Alerte : carte SIM sans antenne de son réseau depuis plus de 2 h', groupe: G6, fonction: 'alerteSimHorsService', note: 'Nouveau (13/11) : seulement des antennes d\'un autre réseau.', contenu: si('alerteSimHorsService', { nom: 'Mamie Jeanne', famille: 'fam-jeanne', ref: 'T-003', operateur: 'Lyca Mobile', depuis: dans(0) - 2.2 * 3600e3, commande: 'sub_123', motif: 'antennes', hote: '20820', service: 'urgences', duree: '2 h 30' }) },
    { titre: 'Carte SIM revenue après une alerte', groupe: G6, fonction: 'alerteSimHorsService', note: 'Nouveau (13/11) : le mot de fin, ligne « À faire » levée.', contenu: si('alerteSimHorsService', { nom: 'Mamie Jeanne', famille: 'fam-jeanne', ref: 'T-003', operateur: 'Lyca Mobile', depuis: dans(0) - 2.2 * 3600e3, commande: 'sub_123', motif: 'service', duree: '3 h 40', revenu: true }) },
    { titre: 'Alerte : prélèvement contesté', groupe: G6, fonction: 'alerteAdmin', contenu: si('alerteAdmin', { titre: 'Prélèvement contesté (25 €) : Julie Martin', detail: 'La banque du client conteste le prélèvement du 12 octobre. Stripe demande une réponse sous 7 jours : facture et e-mails de la commande à fournir depuis le tableau de bord Stripe.', commande: 'sub_123' }) },
    { titre: 'Alerte : tablette pas connectée 48 h après le retrait du colis', groupe: G6, fonction: 'alerteAdmin', note: 'Nouveau (12/11, M0).', contenu: si('alerteAdmin', { titre: 'Tablette pas encore connectée, colis retiré il y a 48 h : Julie Martin', detail: 'Colis retiré il y a 48 h : la tablette n\'est toujours pas entrée dans sa famille. L\'écran de la tablette dit à la personne que Papote est prévenu et s\'en occupe. Le plus souvent, elle n\'a pas de connexion chez la personne (pas de box, wifi à choisir, 4G faible). Appelez le client pour l\'aider.', commande: 'sub_123' }) },
    { titre: 'Alerte : tablette remise en main propre, pas connectée 48 h après', groupe: G6, fonction: 'alerteAdmin', note: 'Nouveau (12/11, M0).', contenu: si('alerteAdmin', { titre: 'Tablette pas encore connectée, remise en main propre il y a 48 h : Julie Martin', detail: 'Remise en main propre il y a 48 h : la tablette n\'est toujours pas entrée dans sa famille. L\'écran de la tablette dit à la personne que Papote est prévenu et s\'en occupe. Le plus souvent, elle n\'a pas de connexion chez la personne (pas de box, wifi à choisir, 4G faible). Appelez le client pour l\'aider.', commande: 'sub_123' }) },
    { titre: 'Alerte : colis sans suivi, tablette pas connectée 5 jours après l\'envoi', groupe: G6, fonction: 'alerteAdmin', note: 'Nouveau (12/11, M0).', contenu: si('alerteAdmin', { titre: 'Tablette pas encore connectée, colis parti sans suivi il y a 5 jours : Julie Martin', detail: 'Colis parti il y a 5 jours sans suivi Sendcloud (compté arrivé 3 jours après l\'envoi) : la tablette n\'est toujours pas entrée dans sa famille. L\'écran de la tablette dit à la personne que Papote est prévenu et s\'en occupe. Le plus souvent, elle n\'a pas de connexion chez la personne (pas de box, wifi à choisir, 4G faible). Appelez le client pour l\'aider.', commande: 'sub_123' }) },
    { titre: 'Alerte : tablette connectée à internet mais sans famille', groupe: G6, fonction: 'alerteAdmin', note: 'Nouveau (12/11, M0) : tout de suite, une fois par tablette et par commande.', contenu: si('alerteAdmin', { titre: 'Tablette connectée mais sans famille : T-007 (commande de Julie Martin)', detail: 'La tablette T-007 (n° de série R9XN30ABCDE) a internet et affiche son code, mais elle ne trouve pas sa famille : la famille de sa commande n\'a pas été préparée à la commande (ancienne commande). Son écran dit à la personne que Papote est prévenu et s\'en occupe. Appelez le client : seul Papote peut relier cette tablette à une famille.', commande: 'sub_123' }) },
    { titre: 'Demande de rappel du chat (avec la conversation)', groupe: G6, fonction: 'demandeRappel', contenu: si('demandeRappel', { nom: 'Julie Martin', telephone: '06 12 34 56 78', email: 'julie.martin@gmail.com', messages: CHAT }) },
    { titre: 'Bilan du chat d\'aide de la semaine', groupe: G6, fonction: 'bilanSupport', contenu: si('bilanSupport', { questions: 14, rappels: 2, sansReponse: ['Est-ce que ça marche en maison de retraite ?', 'Peut-on mettre deux tablettes sur la même famille ?'] }) },
    { titre: 'Récap du lundi : à faire cette semaine', groupe: G6, fonction: 'recapSemaine', contenu: si('recapSemaine', { aFaire: 3, lignes: [
      ['Cette semaine', ['150,00 € encaissés (3 paiements)', '2 nouvelles commandes', '6 abonnements payants en cours']],
      ['À faire', ['Commande ABCD-1234 : tablette à envoyer depuis 2 jours', 'Carte SIM 07 45 91 77 17 : recharge à faire avant le 3 novembre', 'Famille Mamie Jeanne : suspendue depuis 4 jours']],
      ['Franchise de TVA', ['1 250,00 € encaissés depuis le 1er janvier, soit 3 % du seuil de 37 500,00 €.']],
    ] }) },
    { titre: 'Livres comptables du mois', groupe: G6, fonction: 'livresComptables', contenu: si('livresComptables', { titres: ['Octobre 2026'], resume: [
      ['Octobre 2026', ['Recettes : 8 lignes, 410,00 €', 'Achats : 3 lignes, 389,70 €']],
    ] }) },
    { titre: 'E-mail d\'information (campagne de l\'admin)', groupe: G6, fonction: 'information', contenu: si('information', { objet: 'Du nouveau sur votre tablette Papote', message: 'Bonjour {prenom},\n\nLa tablette sait maintenant passer des appels téléphoniques : votre proche touche « Appeler », et votre téléphone sonne comme pour un vrai appel.\n\nRien à faire de votre côté : la mise à jour est automatique.', nom: 'Julie Martin', lienDesinscription: DESINSCRIPTION }) },
    { titre: 'Budget Google Cloud : alerte à 30 €', groupe: G6, fonction: 'budget', contenu: si('budget', { palier: 'alerte', montant: '31,20 €', paliers: { alerte: 30, avertissement: 100, coupure: 150 } }) },
    { titre: 'Budget Google Cloud : avertissement à 100 €', groupe: G6, fonction: 'budget', contenu: si('budget', { palier: 'avertissement', montant: '104,50 €', paliers: { alerte: 30, avertissement: 100, coupure: 150 } }) },
    { titre: 'Budget Google Cloud : coupe-circuit', groupe: G6, fonction: 'budget', contenu: si('budget', { palier: 'coupure', montant: '152,00 €', paliers: { alerte: 30, avertissement: 100, coupure: 150 } }) },
    { titre: 'Budget Google Cloud : coupure en cours (part avant la coupure)', groupe: G6, fonction: 'budget', contenu: si('budget', { palier: 'coupure', montant: '152,00 €', paliers: { alerte: 30, avertissement: 100, coupure: 150 }, coupee: null }) },
    { titre: 'Budget Google Cloud : la coupure a échoué', groupe: G6, fonction: 'budget', contenu: si('budget', { palier: 'coupure', montant: '152,00 €', paliers: { alerte: 30, avertissement: 100, coupure: 150 }, coupee: false }) },
  ];
}

// Ce qui se voit dans la boîte de réception, au-dessus de l'e-mail : expéditeur, objet, aperçu.
function enveloppe(contenu, largeur) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const apercu = (contenu.html.match(/<div style="display:none[^>]*>([^<]*)/) || [])[1] || '';
  const tete = `<div style="font:14px/1.4 Arial,sans-serif;color:#24212f;background:#fff;border-bottom:1px solid #e7e1d6;padding:12px 16px">
<div style="display:flex;gap:10px;align-items:center"><div style="width:36px;height:36px;border-radius:50%;background:#4f46e5;color:#fff;font-weight:bold;display:flex;align-items:center;justify-content:center;flex:none">P</div>
<div style="min-width:0"><div><b>Papote</b> <span style="color:#5f5a6b">&lt;contact@mapapote.fr&gt;</span></div><div style="font-weight:bold;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(contenu.subject)}</div>
<div style="color:#5f5a6b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(apercu.replace(/&#847;|&zwnj;|&nbsp;/g, ' ').trim())}</div></div></div></div>`;
  // L'e-mail lui-même, tel que le client de messagerie l'affiche, sous l'en-tête.
  return contenu.html.replace(/<body([^>]*)>/i, `<body$1>${tete}`);
}

async function capturer({ browser, base, dossierImages, progression, dossierSource }) {
  const mail = require(path.join(dossierSource, 'mail.js'));
  const SCENES = scenes(mail).filter((s) => s.contenu);
  const resultats = [];
  let n = 0;
  const total = SCENES.length * TAILLES.length;
  for (const scene of SCENES) {
    for (const taille of TAILLES) {
      n++;
      const ctx = await browser.newContext({ viewport: { width: taille.width, height: taille.height }, deviceScaleFactor: 2, locale: 'fr-FR' });
      const page = await ctx.newPage();
      const erreurs = [];
      page.on('pageerror', (e) => erreurs.push(String(e.message || e)));
      // Pas d'internet : ni police, ni image. Un e-mail doit être lisible sans rien charger.
      await page.route('**/*', (r) => r.abort());
      await page.setContent(enveloppe(scene.contenu, taille.width), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);
      const large = await page.evaluate(() => {
        const de = document.documentElement;
        return de.scrollWidth > de.clientWidth ? `page trop large (${de.scrollWidth} px pour ${de.clientWidth} px)` : '';
      });
      if (large) erreurs.push('Largeur : ' + large);
      // Le texte brut doit dire la même chose que le HTML : chaque chiffre en euros du HTML est dans le texte.
      const euros = (scene.contenu.html.match(/\d+(?:,\d+)?&nbsp;€/g) || []).map((e) => e.replace('&nbsp;', ' '));
      for (const e of euros) if (!scene.contenu.text.includes(e)) erreurs.push(`Texte brut sans « ${e} »`);
      const fichier = `emails-${String(n).padStart(3, '0')}.jpg`;
      await page.screenshot({ path: `${dossierImages}/${fichier}`, type: 'jpeg', quality: 70, fullPage: true, timeout: 15000 })
        .catch((e) => erreurs.push('Capture : ' + e.message.split('\n')[0]));
      resultats.push({ n, groupe: scene.groupe, titre: scene.titre, note: scene.note, fonction: scene.fonction, taille: taille.nom, fichier, erreurs, scene: SCENES.indexOf(scene) });
      await ctx.close();
      progression(`e-mails ${n}/${total}`);
    }
  }
  return resultats;
}

module.exports = { capturer, scenes, enveloppe, TAILLES };
