// Contenu de l'espace Validation (validation.js) : chaque parcours expliqué étape par étape, chaque dépense avec
// son coût par famille, et chaque geste humain à essayer. Écrit d'après le code (fonctions de main, app et admin de
// dlattc, tablette de cmnwxy) au 30/10/2026. Changer un parcours change son empreinte : s'il était validé, il
// repasse « a changé » dans l'admin.
//
// Étape : { qui, titre, detail, emails: [fonction de functions/mail.js], cout, test: [etat, detail] }
//   qui   : client (celui qui commande et paie), proche, mamie, tablette, papote (le serveur, tout seul), tanguy
//   etat  : auto (essai automatique qui passe), main (à essayer à la main), non (pas encore essayé)

export const QUI = {
  client: 'Le client',
  proche: 'Un proche',
  mamie: 'Mamie',
  tablette: 'La tablette',
  papote: 'Papote (automatique)',
  tanguy: 'Toi',
};

export const TESTS = { auto: 'Essai automatique', main: 'À essayer à la main', non: 'Pas encore essayé' };

export const FLUX = [
  {
    id: 'commande',
    titre: 'Commande sur le site',
    resume: 'Du site vitrine au paiement des 60 € : la tablette est mise de côté, le client reçoit sa confirmation, toi la nouvelle commande.',
    etapes: [
      { qui: 'client', titre: 'Vérifie la 4G chez son proche', detail: 'Il tape l\'adresse du proche. Si la carte SIM capte mal à cet endroit, le paiement ne s\'ouvre pas et il peut laisser son contact. L\'adresse est notée sur la commande.', cout: 'Gratuit (données publiques de l\'Arcep)', test: ['auto', 'Parcours serveur « couverture 4G vérifiée par Papote »'] },
      { qui: 'client', titre: 'Choisit un point relais et donne ses coordonnées', detail: 'Code postal ou « Autour de moi », puis nom, e-mail et téléphone (le téléphone sert à Mondial Relay). Tout est gardé une heure s\'il revient en arrière depuis Stripe.', cout: 'Gratuit (sélecteur Sendcloud)', test: ['auto', 'Galerie du site (clavier ouvert, largeur) et double clic sur « Payer »'] },
      { qui: 'papote', titre: 'Met une tablette de côté et ouvre le paiement', detail: 'Une tablette en stock est réservée pendant que la page Stripe est ouverte. Sans stock, le site affiche « Être prévenu » à la place de « Commander » : on ne vend que le stock réel.', cout: 'Rien tant que rien n\'est payé', test: ['auto', 'Parcours « stock épuisé » et « page de paiement abandonnée »'] },
      { qui: 'client', titre: 'Paie 60 € par carte ou par prélèvement SEPA', detail: 'Page Stripe : la mise en service de 60 € tout de suite, puis 25 € par mois une fois chaque mois écoulé. Aucun prélèvement mensuel avant la réception.', cout: 'Carte : environ 1,15 € + 0,42 € (Stripe Billing 0,7 %). SEPA : 0,35 € + 0,42 €', test: ['main', 'Vrai Stripe : outils/test-commande sur ton PC (cartes de test). Faux Stripe dans les parcours serveur'] },
      { qui: 'papote', titre: 'Enregistre la commande et prévient tout le monde', detail: 'Stripe prévient le serveur : la commande est créée avec son code XXXX-XXXX, le client reçoit sa confirmation, toi l\'e-mail « Nouvelle commande ». Un message Stripe reçu deux fois ne crée rien en double.', emails: ['commandeConfirmee', 'nouvelleCommande'], cout: 'Gratuit (e-mails Brevo, 300 par jour)', test: ['auto', 'Parcours « commande, envoi, installation… » et « messages Stripe en double puis dans le désordre »'] },
      { qui: 'client', titre: 'Note son code de commande', detail: 'La page « Merci » affiche le code XXXX-XXXX : il sert à relier la commande si la tablette ne la reconnaît pas toute seule.', cout: 'Gratuit', test: ['auto', 'Galerie du site'] },
      { qui: 'papote', titre: 'SEPA : attend la banque', detail: 'Un prélèvement SEPA met quelques jours. Accepté : la commande passe « à préparer » et la confirmation part. Refusé : commande annulée, tablette de nouveau libre, le client et toi êtes prévenus.', emails: ['sepaRefuse'], cout: 'Un refus SEPA peut coûter des frais Stripe (à vérifier sur ton tableau Stripe)', test: ['auto', 'Parcours « SEPA accepté quelques jours après » et « SEPA refusé »'] },
      { qui: 'papote', titre: 'Panier abandonné : trois rappels au plus', detail: 'La tablette mise de côté est libérée. Le visiteur reçoit un rappel une heure après, le lendemain soir, puis une semaine après (le dernier), avec un lien de désinscription.', emails: ['relancePanier'], cout: 'Gratuit', test: ['auto', 'Parcours « page de paiement abandonnée »'] },
      { qui: 'client', titre: 'Peut annuler avant l\'envoi', detail: 'Tant que le colis n\'est pas parti, l\'annulation rembourse les 60 € tout de suite et la tablette revient au stock. Tu reçois un e-mail.', emails: ['commandeAnnulee', 'annulationAvantEnvoi'], cout: 'Les frais Stripe des 60 € ne sont pas rendus par Stripe (environ 1 €)', test: ['auto', 'Parcours « client qui recommande et annule » et « Tanguy annule une commande pas encore partie »'] },
    ],
  },
  {
    id: 'preparation',
    titre: 'Préparation et envoi du colis',
    resume: 'Ce que tu fais entre la commande et le dépôt au point relais : tablette, carte SIM, colis, étiquette.',
    etapes: [
      { qui: 'tanguy', titre: 'Voit la commande à préparer', detail: 'Admin › Accueil (À faire) et Commandes › Tablettes à envoyer. Expédition annoncée sous 3 à 5 jours ouvrés.', cout: 'Gratuit', test: ['auto', 'Galerie admin et balayage des boutons'] },
      { qui: 'tanguy', titre: 'Relie une tablette et une carte SIM', detail: 'Les deux sont obligatoires avant le premier envoi : sans tablette reliée dans Stock et sans carte SIM, le bouton d\'envoi est bloqué.', cout: 'Tablette 120 à 150 €, ligne SIM 2 à 5 € par mois (voir Dépenses)', test: ['auto', 'Parcours serveur et admin (envoi bloqué sans tablette ni SIM)'] },
      { qui: 'tanguy', titre: 'Installe Papote sur une tablette neuve', detail: 'Script economie-donnees.ps1 sur ton PC : Papote verrouillée en kiosque, charge limitée à 80 %, réglages pour économiser la carte SIM. Une tablette revenue a été remise à zéro au retour.', cout: 'Ton temps (environ 15 € par client dans ton calcul)', test: ['main', 'Fait sur T-003 ; à refaire sur chaque nouveau modèle'] },
      { qui: 'tanguy', titre: 'Prépare le colis et crée l\'étiquette', detail: 'Le parcours d\'envoi de l\'admin note si une enceinte part dans le colis (elle compte dans le matériel à rendre), puis crée l\'étiquette Mondial Relay par Sendcloud. Colis de moins d\'un kilo.', cout: 'Étiquette environ 6 € (ton chiffre, à vérifier sur la facture Sendcloud). Carton, pochette, calage environ 3 €', test: ['non', 'Faux Sendcloud dans les essais : une vraie étiquette reste à créer une fois'] },
      { qui: 'tanguy', titre: 'Dépose le colis', detail: 'Le numéro de suivi est enregistré : le client reçoit « Tablette en route » avec le lien de suivi. Le premier prélèvement mensuel est recalé sur la fin des 30 jours pour changer d\'avis.', emails: ['colisParti'], cout: 'Gratuit', test: ['auto', 'Parcours « commande, envoi, installation… »'] },
      { qui: 'tanguy', titre: 'Ou la remet en main propre', detail: 'Pour les mamies ou un client proche de Lyon : envoyée et reçue le jour même, e-mail « chez vous », 30 jours pour changer d\'avis.', emails: ['tabletteRemise'], cout: 'Gratuit', test: ['auto', 'Parcours « remise en main propre »'] },
      { qui: 'tanguy', titre: 'Commande offerte', detail: 'Admin › Commandes › « + Commande offerte » : même parcours sans paiement ; la famille est offerte et jamais mise en pause.', cout: 'Le matériel et l\'envoi, sans recette', test: ['auto', 'Parcours « commande offerte (les mamies) »'] },
    ],
  },
  {
    id: 'installation',
    titre: 'Réception et installation',
    resume: 'Du colis retiré à la tablette prête : le premier proche qui scanne installe, le payeur rejoint ensuite.',
    etapes: [
      { qui: 'papote', titre: 'Colis pas retiré, tablette pas jumelée', detail: 'Rappels au client à J+5 et J+12, e-mail pour toi à J+20. Colis revenu chez toi : « Colis revenu » dans l\'admin annule, rembourse et remet la tablette en stock.', emails: ['rappelJumelage'], cout: 'Un colis revenu coûte l\'aller (environ 6 €)', test: ['auto', 'Parcours « colis non retiré » et « colis jamais retiré »'] },
      { qui: 'mamie', titre: 'Allume la tablette', detail: 'Bienvenue, puis Internet (sauté avec la carte SIM), puis un QR code avec le code et « app.mapapote.fr » écrits dessous.', cout: 'Quelques Mo de la carte SIM', test: ['main', 'Galerie tablette ; sur T-003 à chaque nouvelle version'] },
      { qui: 'proche', titre: 'Scanne le QR code et crée son compte', detail: 'Le premier proche qui scanne devient propriétaire de la famille. Une seule fois : « Faisons connaissance » (prénom, genre, photo, date de naissance).', cout: 'Gratuit', test: ['auto', 'Tests de l\'app famille (installation) et galerie'] },
      { qui: 'proche', titre: 'Donne un nom : « Mamie Jeanne »', detail: 'La famille est créée et l\'installation est validée dès ce moment : les invitations en attente partent. Reprise par un autre proche si rien ne bouge pendant 30 minutes ; « Annuler l\'installation » efface tout.', emails: ['invitation'], cout: 'Gratuit', test: ['auto', 'Parcours « installation abandonnée en route » et « Annuler l\'installation »'] },
      { qui: 'proche', titre: 'Photo, essai du son, options', detail: 'Au moins une photo, le son réglé depuis le téléphone, le SOS et les options choisis. À la fin, l\'e-mail « la tablette est prête » avec le mode d\'emploi en quatre lignes.', emails: ['installationFinie'], cout: 'Gratuit', test: ['auto', 'Tests de l\'app famille et galerie'] },
      { qui: 'papote', titre: 'Relie la commande', detail: 'Par l\'e-mail du compte, ou par le code XXXX-XXXX. Le payeur qui rejoint devient responsable aussi, le propriétaire ne change pas. Sans commande reliée : 48 h où tout marche, un e-mail pour toi, puis la famille passe « sans abonnement ».', emails: ['alerteAdmin'], cout: 'Gratuit', test: ['auto', 'Parcours « commande reliée à la main », « celui qui a payé rejoint », « deux commandes au même e-mail »'] },
      { qui: 'papote', titre: 'Compte la réception', detail: 'Suivi « livré » ou tablette reliée : les 30 jours pour changer d\'avis partent de là, puis le premier prélèvement de 25 €.', cout: 'Gratuit', test: ['auto', 'Parcours serveur'] },
    ],
  },
  {
    id: 'proches',
    titre: 'Proches : inviter, rejoindre, retirer',
    resume: 'Comment la famille s\'agrandit, qui décide, et ce qui se passe quand quelqu\'un part.',
    etapes: [
      { qui: 'proche', titre: 'Invite par e-mail ou par lien', detail: 'Un responsable invite par e-mail, ou partage le lien de la famille. 30 proches au plus ; les demandes en attente ne comptent pas.', emails: ['invitation'], cout: 'Gratuit', test: ['auto', 'Parcours « 31e proche » et tests de l\'app famille'] },
      { qui: 'proche', titre: 'Demande à rejoindre', detail: 'Celui qui arrive par le lien attend l\'accord : les responsables reçoivent un e-mail et une notification, la personne est prévenue quand c\'est accepté.', emails: ['demandeRejoindre', 'demandeAcceptee'], cout: 'Gratuit', test: ['auto', 'Tests de l\'app famille'] },
      { qui: 'proche', titre: 'Retire un proche', detail: 'Un proche retiré perd l\'accès tout de suite ; une ancienne invitation ne sert plus (corrigé le 30/10). Un responsable parti ne touche plus à l\'abonnement.', cout: 'Gratuit', test: ['auto', 'Inspection n° 2 et parcours « un responsable parti »'] },
      { qui: 'tablette', titre: 'Garde les anciens numéros', detail: 'Les numéros d\'une famille restent sur la tablette jusqu\'au prochain jumelage ou à la remise à zéro (ton accord du 30/10).', cout: 'Gratuit', test: ['main', 'À voir sur T-003'] },
    ],
  },
  {
    id: 'envois',
    titre: 'Photos, vidéos et forfait de la carte SIM',
    resume: 'Ce qui se passe quand un proche envoie une photo, et comment la carte SIM de 1 Go tient le mois.',
    etapes: [
      { qui: 'proche', titre: 'Envoie une photo, une vidéo ou un message', detail: 'Vidéo réduite sur le téléphone avant l\'envoi (30 s, 640 px, environ 1,1 Mbit/s). La famille garde 200 photos et 40 vidéos.', cout: 'Stockage en Europe : quelques centimes par famille et par mois', test: ['auto', 'Tests de l\'app famille (envois) et galerie, envoi bloqué compris'] },
      { qui: 'papote', titre: 'Réveille la tablette', detail: 'Une notification push fait venir l\'envoi tout de suite ; la tablette télécharge chaque fichier une seule fois. La voix lit le message (voix Google, gardée en cache).', cout: 'Push gratuit ; voix dans la part gratuite (1 M caractères par mois)', test: ['main', 'Vidéo non reçue le 28/10 (corrigé) : à revérifier sur T-003'] },
      { qui: 'mamie', titre: 'Regarde, envoie un cœur ou une réponse', detail: 'Le proche voit « vu » et le cœur dans l\'app.', cout: 'Gratuit', test: ['auto', 'Galerie tablette et double clic tablette'] },
      { qui: 'tablette', titre: 'Ménage la carte SIM', detail: '1 Go par mois. À 70 % : mode Éco ; à 88 % : vidéo très réduite ; à 95 % : le son seul, ni vidéo, ni météo, ni mise à jour. En Wi-Fi, rien n\'est limité. La nuit (21 h - 6 h 30), un signe de vie par heure seulement.', cout: 'Repos mesuré : 85 à 125 Mo par mois sur T-003', test: ['auto', 'Parcours « garde-fou du forfait » ; mesure de 24 h à faire un samedi'] },
      { qui: 'tablette', titre: 'Se met à jour', detail: 'Les mises à jour des tablettes clients sont groupées une fois par mois, sauf urgence.', cout: 'APK de 2 Mo', test: ['main', 'Installée par le fil tablette avec ton accord'] },
    ],
  },
  {
    id: 'appels',
    titre: 'Appels vidéo et téléphone',
    resume: 'Les appels dans les deux sens, ce qui sonne, et ce qui se passe quand personne ne répond.',
    etapes: [
      { qui: 'proche', titre: 'Appelle Mamie en visio', detail: 'La tablette sonne 45 secondes, puis l\'appel est manqué. La vidéo passe par un relais Cloudflare quand les deux appareils ne se voient pas directement.', cout: 'Relais gratuit (1 To par mois). Visio 4,4 Mo par minute sur la carte SIM (2,8 en Éco)', test: ['auto', 'Tests de l\'app famille (appels WebRTC) ; vraie visio entre deux appareils à la main'] },
      { qui: 'mamie', titre: 'Appelle la famille', detail: 'Les téléphones des proches qui reçoivent les appels sonnent (« Mamie vous appelle »). Dès qu\'un proche décroche, les autres arrêtent de sonner ; sans réponse, « Appel manqué ».', cout: 'Push gratuit', test: ['auto', 'Galerie des appels et parcours serveur'] },
      { qui: 'papote', titre: 'Aucun téléphone ne sonne', detail: 'Si aucun proche ne peut recevoir l\'appel, tous les proches reçoivent un e-mail.', emails: ['appelSansTelephone'], cout: 'Gratuit', test: ['auto', 'Parcours « appel ou SOS qui ne fait sonner personne »'] },
      { qui: 'mamie', titre: 'Appelle par téléphone', detail: 'Avec la carte SIM, Mamie peut appeler le portable d\'un proche, et recevoir les appels des numéros de la famille.', cout: 'Dans le forfait de la ligne (appels illimités)', test: ['main', 'Chantier téléphone en cours ; à essayer sur T-003'] },
      { qui: 'tablette', titre: 'Garde la visio dans le forfait', detail: 'Sur la carte SIM : 2 h de visio en pleine qualité, puis jusqu\'à 3 h en qualité réduite. Illimité en Wi-Fi.', cout: 'Dans le forfait de 1 Go', test: ['auto', 'Parcours forfaits SIM'] },
      { qui: 'proche', titre: 'Reçoit l\'appel téléphone fermé', detail: 'Seulement avec l\'app Android. Chrome n\'est pas garanti ; impossible sur iPhone sans app native.', cout: 'Gratuit', test: ['main', 'Pixel 9a'] },
    ],
  },
  {
    id: 'sos',
    titre: 'SOS',
    resume: 'Mamie appuie sur SOS : qui est prévenu, dans quel ordre, et ce qui se passe si personne ne répond.',
    etapes: [
      { qui: 'mamie', titre: 'Appuie sur SOS', detail: 'Un décompte laisse le temps d\'annuler un appui par erreur.', cout: 'Gratuit', test: ['auto', 'Galerie tablette et double clic tablette'] },
      { qui: 'tablette', titre: 'Envoie un SMS à tous et appelle', detail: 'SMS à tous les proches depuis la carte SIM, puis appels téléphone dans l\'ordre choisi par la famille.', cout: 'Dans le forfait de la ligne (SMS et appels illimités)', test: ['main', 'À essayer sur T-003 avec la vraie carte SIM'] },
      { qui: 'papote', titre: 'Fait sonner les téléphones', detail: '« SOS : Mamie vous appelle ». Sans réponse au 2e essai, toute la famille reçoit « Mamie a appuyé sur SOS ». Aucun téléphone ne peut sonner : e-mail SOS à tous.', emails: ['appelSansTelephone'], cout: 'Gratuit', test: ['auto', 'Parcours « SOS sans réponse au 2e essai »'] },
    ],
  },
  {
    id: 'alertes',
    titre: 'Alertes des responsables',
    resume: 'Quand la tablette est débranchée, muette ou pas regardée : qui reçoit quoi, et quand.',
    etapes: [
      { qui: 'papote', titre: 'Tablette débranchée', detail: 'Plus de 10 minutes sans courant : une notification aux responsables seulement, une fois par épisode.', cout: 'Push gratuit ; vérification toutes les 5 minutes (tâche planifiée, quelques centimes par mois en tout)', test: ['auto', 'Tests unitaires des alertes'] },
      { qui: 'papote', titre: 'Tablette qui ne répond plus', detail: '70 minutes sans signe de vie (2 h la nuit) : notification aux responsables. Rien pendant une pause hospitalisation.', cout: 'Gratuit', test: ['auto', 'Parcours « pause hospitalisation : aucune alerte »'] },
      { qui: 'papote', titre: 'Mamie pas vue depuis 48 h', detail: 'Ni vue par la caméra, ni touchée depuis deux jours : une alerte aux responsables, envoyée à 10 h, pas de rappel tant que rien ne change.', cout: 'Gratuit', test: ['auto', 'Parcours « pas vue depuis deux jours »'] },
      { qui: 'tablette', titre: 'Vérifie ses notifications', detail: 'Une fois par jour, un essai de notification ; sans réponse, la tablette repasse à l\'écoute normale.', cout: 'Gratuit', test: ['main', 'Vérifié sur T-003 le 28/10'] },
    ],
  },
  {
    id: 'paiements',
    titre: 'Prélèvements mensuels et impayés',
    resume: '25 € chaque mois une fois le mois écoulé, et ce qui se passe quand un prélèvement échoue.',
    etapes: [
      { qui: 'papote', titre: 'Prélève 25 € par mois', detail: 'À terme échu : le mois écoulé. Le premier prélèvement arrive à la fin des 30 jours pour changer d\'avis. Facture Stripe à chaque fois, visible dans l\'app.', cout: 'SEPA 0,35 € ou carte environ 0,63 €, plus 0,18 € de Stripe Billing', test: ['auto', 'Faux Stripe dans les parcours ; vrai Stripe seulement en mode test'] },
      { qui: 'papote', titre: 'Prélèvement refusé', detail: 'Les responsables sont prévenus. Tout marche encore 7 jours, puis Papote se met en pause (tablette en pause, envois bloqués). Dès que c\'est payé, tout repart tout seul, sans 2e abonnement.', emails: ['paiementEchoue', 'papoteEnPause'], cout: 'Un échec SEPA peut avoir des frais Stripe (à vérifier)', test: ['auto', 'Parcours « prélèvement refusé : responsables prévenus, pause 7 jours plus tard »'] },
      { qui: 'tanguy', titre: 'En pause depuis 30 jours', detail: 'Une ligne À faire : tu arrêtes l\'abonnement et demandes le retour de la tablette (écrit dans les CGV).', cout: 'Risque : tablette pas rendue (140 € prélevés)', test: ['auto', 'Parcours « suspendue depuis 30 jours »'] },
      { qui: 'papote', titre: 'Prélèvement contesté', detail: 'Tu reçois une alerte : Stripe demande une réponse sous 7 jours (facture et e-mails à fournir).', emails: ['alerteAdmin'], cout: 'Frais de litige Stripe (à vérifier, souvent 15 à 20 €)', test: ['non', 'Pas d\'essai avec un vrai litige'] },
      { qui: 'tanguy', titre: 'Hospitalisation', detail: 'Sur justificatif, « Pause hospitalisation » dans l\'admin : plus de prélèvement ni d\'alerte jusqu\'à la date choisie. La famille reçoit un e-mail à la pause et à la reprise.', emails: ['pausePrelevements', 'reprisePrelevements'], cout: 'Pas de recette pendant la pause', test: ['auto', 'Parcours « la pause hospitalisation vise la commande ouverte »'] },
      { qui: 'papote', titre: 'Famille offerte', detail: 'Les mamies : jamais en pause, rien de prélevé.', cout: 'Ligne SIM et matériel sans recette', test: ['auto', 'Parcours « commande offerte »'] },
    ],
  },
  {
    id: 'resiliation',
    titre: 'Annulation et résiliation',
    resume: 'Changer d\'avis dans les 30 jours, résilier ensuite, ou arrêt décidé par toi.',
    etapes: [
      { qui: 'client', titre: 'Annule dans les 30 jours après réception', detail: '« Annuler ma commande » dans l\'app : tout est remboursé, 60 € compris, quand la tablette revient. Pendant ces 30 jours, c\'est le seul bouton.', emails: ['retourTablette'], cout: 'Les frais Stripe des 60 € sont perdus (environ 1 €), plus l\'aller et le retour du colis', test: ['auto', 'Parcours « commande, envoi, installation…, annulation et remboursement des 60 € »'] },
      { qui: 'client', titre: 'Résilie ensuite', detail: 'Sans engagement : Papote s\'arrête à la date de fin de période, le dernier mois est prélevé à l\'arrêt, rien au prorata. Tu reçois « Un client a résilié ».', emails: ['resiliationEnregistree', 'resiliation'], cout: 'Gratuit', test: ['auto', 'Parcours « résiliation après le premier mois »'] },
      { qui: 'client', titre: 'Change d\'avis : « Garder mon abonnement »', detail: 'Possible jusqu\'à la date d\'arrêt, sauf si c\'est toi qui as arrêté l\'abonnement.', emails: ['resiliationAnnulee'], cout: 'Gratuit', test: ['auto', 'Parcours « deux responsables demandent l\'arrêt » (un seul e-mail)'] },
      { qui: 'tanguy', titre: 'Arrête un abonnement', detail: 'Page de la commande › Arrêter l\'abonnement : vise cette commande, jamais une autre de la même famille. Le client ne peut pas annuler l\'arrêt.', emails: ['resiliationEnregistree'], cout: 'Gratuit', test: ['auto', 'Parcours « deux commandes pour la même famille : Arrêter et Reprendre »'] },
      { qui: 'client', titre: 'Reprend après une résiliation', detail: 'Si la tablette est encore là : reprise sans les 60 €, le retour attendu est annulé.', emails: ['commandeConfirmee', 'nouvelleCommande'], cout: 'Frais Stripe des prélèvements seulement', test: ['auto', 'Parcours « abonnement résilié, tablette encore là : reprise sans les 60 € »'] },
    ],
  },
  {
    id: 'retour',
    titre: 'Retour de la tablette',
    resume: 'Après une annulation ou une résiliation : l\'étiquette, les rappels, la réception et ce qui est prélevé si rien ne revient.',
    etapes: [
      { qui: 'client', titre: 'Demande son QR code de retour', detail: 'Dès la résiliation. Le QR code Mondial Relay est créé à la demande, une seule étiquette payée par commande, même avec un double clic. Sans adresse connue, un message clair.', emails: ['retourTablette', 'etiquetteRetour'], cout: 'Étiquette retour environ 3,70 € (ton chiffre, à vérifier chez Sendcloud), payée seulement si elle est demandée', test: ['auto', 'Parcours « étiquette de retour : une seule étiquette » ; vraie étiquette Sendcloud pas essayée'] },
      { qui: 'papote', titre: 'Rappelle 7 jours avant la date limite', detail: 'La tablette est à rendre dans les 30 jours après la fin.', emails: ['rappelRestitution'], cout: 'Gratuit', test: ['auto', 'Parcours « résiliation après le premier mois »'] },
      { qui: 'tanguy', titre: 'Reçoit et vérifie le matériel', detail: '« Matériel reçu » : tu coches ce qui est revenu. Remboursement si c\'était une annulation ; un élément manquant est prélevé seul (chargeur 10 €, enceinte 10 €).', emails: ['tabletteRecue'], cout: 'Gratuit', test: ['auto', 'Parcours « Matériel reçu deux fois (double clic) »'] },
      { qui: 'papote', titre: 'Rien n\'est revenu à temps', detail: '30 jours après la fin : 140 € prélevés (150 € avec l\'enceinte), le client est prévenu.', emails: ['materielNonRendu'], cout: 'Tablette à racheter si le prélèvement échoue', test: ['auto', 'Parcours « 140 € si la tablette ne revient pas »'] },
      { qui: 'tanguy', titre: 'Remet la tablette en stock', detail: 'La tablette revenue est détachée de la famille et de ses comptes, remise à zéro, puis « en stock » ou « à réparer ».', cout: 'Ton temps', test: ['auto', 'Parcours « tablette revenue puis repartie chez un autre client »'] },
    ],
  },
  {
    id: 'pilotage',
    titre: 'Pilotage des tablettes depuis l\'admin',
    resume: 'Ce que tu peux faire à distance sur une tablette, et ce que ça coûte à sa carte SIM.',
    etapes: [
      { qui: 'tanguy', titre: 'Donne un ordre', detail: 'Page de la tablette : redémarrer, état complet, lire le journal, mettre à jour, recharger l\'écran, volumes, remettre à zéro.', cout: 'Quelques Ko de la carte SIM par ordre', test: ['auto', 'Galerie admin et double clic ; vraie tablette à la main'] },
      { qui: 'papote', titre: 'Réveille la tablette', detail: 'L\'ordre part par notification ; la tablette l\'exécute et écrit son résultat. Rien n\'est ajouté à ses tours réguliers.', cout: 'Push gratuit', test: ['main', 'Sur T-003'] },
      { qui: 'tanguy', titre: 'Remet à zéro', detail: 'Seulement avec ton accord écrit pour une tablette chez un client.', cout: 'Gratuit', test: ['main', 'Jamais fait à distance sur T-003'] },
    ],
  },
  {
    id: 'aide',
    titre: 'Aide : chat et demandes de rappel',
    resume: 'Le chat d\'aide du site, la demande de rappel, et le bilan de la semaine.',
    etapes: [
      { qui: 'client', titre: 'Pose une question au chat', detail: 'Le chat répond avec ce que Papote sait (conditions, prix, fonctionnement). 300 questions par jour au plus, tous visiteurs confondus.', cout: 'IA Anthropic : environ 0,5 à 2 € par mois en tout', test: ['auto', 'Tests unitaires du chat'] },
      { qui: 'client', titre: 'Demande à être rappelé', detail: 'Tu reçois la conversation et son numéro ; il reçoit « bien reçu ».', emails: ['demandeRappel', 'rappelConfirme'], cout: 'Gratuit', test: ['auto', 'Tests unitaires du chat'] },
      { qui: 'papote', titre: 'Fait le bilan de la semaine', detail: 'Nombre de questions, demandes de rappel, et les questions restées sans réponse.', emails: ['bilanSupport'], cout: 'Gratuit', test: ['auto', 'Galerie des e-mails'] },
    ],
  },
  {
    id: 'gestion',
    titre: 'Ta gestion : récap, comptes, budget',
    resume: 'Ce que l\'admin fait pour toi chaque semaine et chaque mois, et les garde-fous de dépense.',
    etapes: [
      { qui: 'papote', titre: 'Récap du lundi', detail: 'Ce qu\'il y a à faire cette semaine (envois, retours, impayés).', emails: ['recapSemaine'], cout: 'Gratuit', test: ['auto', 'Galerie des e-mails'] },
      { qui: 'papote', titre: 'Relève les factures fournisseurs', detail: 'Les factures envoyées à factures@mapapote.fr sont lues et préremplies dans Dépenses.', cout: 'IA Anthropic : quelques centimes par facture', test: ['main', 'Vérifié avec tes factures Cdiscount'] },
      { qui: 'papote', titre: 'Livres comptables du mois', detail: 'Envoyés chaque mois, clôture dans Comptabilité › Registres.', emails: ['livresComptables'], cout: 'Gratuit', test: ['auto', 'Tests unitaires de la gestion'] },
      { qui: 'papote', titre: 'Surveille le budget Google', detail: 'E-mail à 30 € et à 100 € ; à 150 €, la facturation Google est coupée (tout s\'arrête). Ne couvre pas Anthropic : limite à poser dans la console Anthropic.', emails: ['budget'], cout: 'Gratuit', test: ['auto', 'Tests unitaires du budget'] },
      { qui: 'tanguy', titre: 'Envoie un e-mail d\'information', detail: 'Clients › E-mail d\'information : seulement à ceux qui l\'acceptent, avec un lien de désinscription.', emails: ['information'], cout: 'Gratuit jusqu\'à 300 e-mails par jour (Brevo)', test: ['auto', 'Galerie admin et e-mails'] },
    ],
  },
];

// Dépenses par famille, en euros. parMois = coût mensuel moyen par famille ; unique = une fois par client.
// fixe = par mois quel que soit le nombre de familles. sur = chiffre vérifié (code, facture, tarif public) ou estimé.
export const PRIX_MOIS = 25;
export const MISE_EN_SERVICE = 60;

export const DEPENSES = [
  {
    id: 'sim', poste: 'Ligne de la carte SIM', quand: 'Chaque mois, pour chaque tablette',
    parMois: 2, sur: 'Ton chiffre : ligne à 2 € (NRJ ou Cdiscount Mobile, Bouygues). Lyca en stock : 4,99 €',
    detail: 'Le plus gros poste. Le garde-fou du forfait (1 Go) évite tout hors-forfait ; appels et SMS illimités servent au téléphone et au SOS.',
    optimisation: ['Passer les 10 Lyca (4,99 €) sur des lignes à 2 € dès qu\'elles sont ouvertes : 3 € par mois et par famille.', 'Ouvrir 2 ou 3 lignes d\'avance seulement (6 € par mois de stock), pas plus.', 'Résilier ou suspendre la ligne dès qu\'une tablette revient.'],
  },
  {
    id: 'stripe-mois', poste: 'Stripe : prélèvement mensuel', quand: 'Chaque mois',
    parMois: 0.53, sur: 'Tarif public Stripe France : SEPA 0,35 €, carte européenne 1,5 % + 0,25 €, Stripe Billing 0,7 %',
    detail: 'SEPA : 0,35 € + 0,18 € (Billing) = 0,53 €. Carte : 0,63 € + 0,18 € = 0,81 €.',
    optimisation: ['Proposer le SEPA en premier pour l\'abonnement (0,28 € de moins par mois que la carte). Ton choix du 26/10 : carte en premier, à rediscuter.', 'Stripe Billing (0,7 %) est le prix des abonnements automatiques : rien à gagner sans tout refaire.'],
  },
  {
    id: 'stripe-ms', poste: 'Stripe : mise en service de 60 €', quand: 'Une fois par client',
    unique: 1.57, sur: 'Tarif public Stripe : carte 1,15 € + Billing 0,42 € (SEPA : 0,77 €)',
    detail: 'Perdu si le client annule (Stripe ne rend pas ses frais).',
    optimisation: ['Rien d\'urgent : c\'est 2,6 % des 60 €.'],
  },
  {
    id: 'envoi', poste: 'Envoi du colis (Mondial Relay par Sendcloud)', quand: 'Une fois par client',
    unique: 6, sur: 'Ton chiffre (29/10), à vérifier sur la première facture Sendcloud',
    detail: 'Colis de moins d\'un kilo depuis le 30/10. Un colis jamais retiré revient et coûte l\'aller.',
    optimisation: ['Vérifier le tarif de la tranche 0-1 kg dans Sendcloud et chez Mondial Relay en direct (compte pro) ou Boxtal.', 'Remise en main propre quand c\'est possible (mamies, Lyon) : 0 €.'],
  },
  {
    id: 'retour', poste: 'Étiquette de retour', quand: 'Une fois par client qui part',
    unique: 3.7, sur: 'Ton chiffre (29/10), à vérifier chez Sendcloud',
    detail: 'Créée seulement quand le client la demande, une seule par commande (même avec un double clic).',
    optimisation: ['Déjà optimisé : jamais d\'étiquette payée d\'avance.'],
  },
  {
    id: 'emballage', poste: 'Carton, pochette, calage, carte Bienvenue', quand: 'Une fois par client',
    unique: 3, sur: 'Estimé (carton Raja 1,97 €, pochette 0,35 €, calage 0,50 €)',
    detail: 'La pochette à bulles resservira au retour.',
    optimisation: ['Commander les cartons par lots de 50 à 100.'],
  },
  {
    id: 'tablette', poste: 'Tablette 4G', quand: 'Achat, puis amortie sur plusieurs clients',
    parMois: 4, sur: 'Estimé : 130 à 150 € sur 3 ans environ (Cdiscount 129,99 €, Hem France 8/128 à 150 € TTC)',
    detail: 'Charge limitée à 80 % pour faire durer la batterie. Une tablette revenue repart chez un autre client.',
    optimisation: ['Acheter par 3 ou 4 au meilleur prix vérifié (bande 28 obligatoire).', 'Batterie à changer vers 3 ans plutôt que la tablette (environ 50 €).'],
  },
  {
    id: 'preparation', poste: 'Ton temps de préparation', quand: 'Une fois par client',
    unique: 15, sur: 'Ton chiffre (29/10)',
    detail: 'Installer, relier, emballer, déposer.',
    optimisation: ['Le script d\'installation fait déjà presque tout ; l\'admin guide le parcours d\'envoi.'],
  },
  {
    id: 'firebase', poste: 'Firebase (base, stockage, fonctions)', quand: 'Chaque mois',
    parMois: 0.3, sur: 'Audit du 26/10 : 3 à 8 € par mois à 10 familles, 25 à 30 € à 100',
    detail: 'La base « europe » et le stockage en Europe n\'ont pas de part gratuite. Photos et vidéos sont le poste principal ; chaque fichier n\'est téléchargé qu\'une fois par la tablette. Budget : alerte à 30 et 100 €, coupure à 150 €.',
    optimisation: ['Fait : le recomptage des proches ne tourne plus à chaque signe de vie de la tablette.', 'Fait : 200 photos et 40 vidéos par famille, vidéos réduites avant l\'envoi.', 'Piste : regrouper les signes de vie de la tablette (batterie, SIM) en une seule écriture.'],
  },
  {
    id: 'ia', poste: 'IA Anthropic (chat d\'aide, lecture des factures)', quand: 'Chaque mois',
    parMois: 0.02, fixe: 2, sur: 'Audit du 26/10 : 0,5 à 2 € par mois en tout',
    detail: 'Pas couvert par le coupe-circuit Google : plafond de 300 questions par jour dans le code.',
    optimisation: ['À faire de ton côté : poser une limite de dépense dans console.anthropic.com (Settings › Limits).'],
  },
  {
    id: 'mails', poste: 'E-mails (Brevo)', quand: 'À chaque e-mail',
    parMois: 0, sur: 'Brevo gratuit jusqu\'à 300 e-mails par jour',
    detail: 'Largement assez jusqu\'à plusieurs centaines de familles.',
    optimisation: ['Rien à faire.'],
  },
  {
    id: 'gratuits', poste: 'Push, relais vidéo, voix', quand: 'À chaque usage',
    parMois: 0, sur: 'Notifications Firebase gratuites ; relais Cloudflare 1 To gratuit ; voix Google 1 M caractères gratuits',
    detail: 'SMS et appels du SOS passent par la ligne de la tablette, déjà payée : aucun service de SMS payant.',
    optimisation: ['Rien à faire.'],
  },
  {
    id: 'domaine', poste: 'Nom de domaine et boîte mapapote.fr (OVH)', quand: 'Chaque année',
    fixe: 1, sur: 'Estimé : environ 10 à 15 € par an',
    detail: 'Frais fixes, quel que soit le nombre de familles.',
    optimisation: ['Rien à faire.'],
  },
  {
    id: 'societe', poste: 'Frais de la société (après la SASU)', quand: 'Chaque mois, à venir',
    fixe: 40, sur: 'Estimé : banque, RC Pro, médiateur CM2C, logiciel de comptabilité, facture électronique',
    detail: 'Pas encore payés : ils arrivent avec la SASU (semaine du 9/11).',
    optimisation: ['Comparer 2 ou 3 banques pro en ligne et RC Pro avant de signer.'],
  },
];

// Gestes humains : comment ils sont vérifiés. etat : auto (outil qui passe), main (à faire à la main), non.
export const GESTES = [
  { id: 'double', partie: 'Partout', geste: 'Double clic ou double appui sur chaque bouton', etat: 'auto', comment: 'galerie --double (site, app, tablette, admin) : rien ne part en double ; 11 boutons corrigés le 30/10.' },
  { id: 'effet', partie: 'Partout', geste: 'Chaque bouton montre tout de suite qu\'il est appuyé', etat: 'auto', comment: 'galerie --boutons, serveur bloqué : l\'écran doit changer en 0,7 s. Admin 211 boutons, aucun sans effet.' },
  { id: 'identifiant', partie: 'Admin et app', geste: 'Le bouton agit sur la bonne commande ou la bonne famille', etat: 'auto', comment: 'galerie --identifiants : l\'identifiant envoyé au serveur est celui de la page.' },
  { id: 'clavier', partie: 'App, site, admin', geste: 'Clavier ouvert : champ caché, bouton d\'envoi inaccessible', etat: 'auto', comment: 'Simulé dans la galerie (hauteur réduite). Reste à essayer avec un vrai clavier Android et iPhone.' },
  { id: 'rafraichir', partie: 'App et admin', geste: 'Rafraîchir la page sur chaque écran', etat: 'auto', comment: 'galerie --boutons rafraîchit chaque écran.' },
  { id: 'onglets', partie: 'App et admin', geste: 'Deux onglets ouverts, deux personnes en même temps', etat: 'auto', comment: 'Parcours serveur et inspection n° 2 (deux onglets de l\'admin, deux responsables).' },
  { id: 'hors-ligne', partie: 'App famille', geste: 'Pas de réseau du tout', etat: 'auto', comment: 'Tests de l\'app famille : écran calme « Pas de connexion internet », réouverture toute seule.' },
  { id: 'coupure', partie: 'App famille', geste: 'Réseau coupé ou très lent au milieu d\'un envoi', etat: 'main', comment: 'La galerie montre un envoi qui ne finit pas ; la vraie coupure (mode avion pendant l\'envoi) reste à faire.' },
  { id: 'veille', partie: 'App famille', geste: 'Téléphone verrouillé ou app quittée pendant un envoi', etat: 'non', comment: 'À faire sur le Pixel et un iPhone : l\'envoi doit reprendre ou dire qu\'il a échoué.' },
  { id: 'retour-bouton', partie: 'App et site', geste: 'Bouton Retour du téléphone pendant une fenêtre ou un parcours', etat: 'main', comment: 'Revu le 29/10 sur l\'app Android ; à refaire sur Chrome et iPhone.' },
  { id: 'stripe-retour', partie: 'Site', geste: 'Revenir en arrière depuis la page Stripe', etat: 'main', comment: 'Bouton Payer remis à zéro au retour (corrigé le 27/10) ; essai avec outils/test-commande sur ton PC.' },
  { id: 'carte-refusee', partie: 'Site', geste: 'Carte refusée, 3D Secure annulé', etat: 'main', comment: 'Scénario « refus » de outils/test-commande (cartes de test Stripe).' },
  { id: 'session', partie: 'App et admin', geste: 'Session expirée ou déconnexion dans un autre onglet', etat: 'non', comment: 'À faire : l\'écran de connexion doit revenir sans rien perdre d\'important.' },
  { id: 'rotation', partie: 'App famille', geste: 'Tourner le téléphone', etat: 'main', comment: 'Quelques écrans capturés en paysage ; pas tous.' },
  { id: 'texte-grand', partie: 'App et site', geste: 'Texte agrandi dans les réglages du téléphone', etat: 'non', comment: 'Pas encore essayé : utile pour les proches âgés.' },
  { id: 'noms', partie: 'Partout', geste: 'Noms très longs, accents, emojis, collage', etat: 'non', comment: 'À ajouter à la galerie : un nom de 40 lettres, « Zoé 🌸 », une adresse collée.' },
  { id: 'remplissage', partie: 'Site et app', geste: 'Remplissage automatique du navigateur (adresse, e-mail)', etat: 'non', comment: 'À faire sur Chrome Android et Safari.' },
  { id: 'autorisations', partie: 'App famille', geste: 'Autorisation refusée : caméra, micro, photos, notifications', etat: 'main', comment: 'À faire sur le Pixel et un iPhone : un message clair, jamais un écran figé.' },
  { id: 'gros-fichier', partie: 'App famille', geste: 'Photo énorme ou format iPhone (HEIC), vidéo très longue', etat: 'non', comment: 'Les vidéos sont réduites à 30 s ; la photo HEIC reste à essayer.' },
  { id: 'installation-coupee', partie: 'App famille', geste: 'Quitter en plein milieu de l\'installation', etat: 'auto', comment: 'Parcours « installation abandonnée en route » : un autre proche reprend après 30 min.' },
  { id: 'appuis-mamie', partie: 'Tablette', geste: 'Appui long, glisser, paume posée, plusieurs doigts', etat: 'main', comment: 'À faire sur T-003 : rien ne doit sortir de Papote ni rester bloqué.' },
  { id: 'courant', partie: 'Tablette', geste: 'Batterie vide puis rallumage, coupure de courant', etat: 'main', comment: 'À faire sur T-003 : Papote doit revenir seule, verrouillée.' },
  { id: 'reseau-appel', partie: 'Tablette', geste: 'Wi-Fi ou carte SIM perdu pendant un appel', etat: 'non', comment: 'À faire sur T-003 : l\'appel doit se terminer proprement des deux côtés.' },
  { id: 'demarrage-sans-reseau', partie: 'Tablette', geste: 'Démarrage sans internet', etat: 'auto', comment: 'Banc d\'essai de la tablette (relecture du 29/10) ; à revoir sur T-003.' },
  { id: 'maj-coupee', partie: 'Tablette', geste: 'Redémarrage pendant une mise à jour', etat: 'non', comment: 'À faire sur T-003 avant la première mise à jour groupée.' },
  { id: 'boutons-physiques', partie: 'Tablette', geste: 'Boutons volume et marche', etat: 'main', comment: 'Menu du bouton marche bloqué ; volume à vérifier pendant un appel.' },
  { id: 'nuit', partie: 'Tablette', geste: 'Appel ou SOS pendant la nuit', etat: 'auto', comment: 'Galerie tablette (appel la nuit) ; à revoir sur T-003.' },
  { id: 'stripe-double', partie: 'Serveur', geste: 'Paiements reçus en double ou dans le désordre', etat: 'auto', comment: 'Parcours serveur « messages Stripe en double puis dans le désordre ».' },
];
