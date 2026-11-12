# Tests du parcours client

Le parcours d'un client, de la commande sur le site jusqu'au retour de la tablette, rejoué avec les
**vraies fonctions** de `functions/` sur les émulateurs Firebase. Rien ne part en ligne, rien n'est payé :
Stripe, les e-mails, les notifications et la voix sont simulés.

## Lancer

- **Automatique** : GitHub lance tout à chaque changement de `functions/` (onglet « Actions » du dépôt, workflow « Tests »).
- **Sur le PC** (Java 11 ou plus nécessaire pour l'émulateur Firestore) : dans `functions`, `npm run parcours`.

## Ce qui est vérifié

`parcours-client.parcours.js` : commande sur le site, paiement SEPA, « Préparer l'envoi » dans l'admin, colis
déposé, installation par une personne dont l'e-mail diffère de l'acheteur (l'acheteur, qui scanne en même temps,
est invité), envois photo, message et vidéo, appels (décroché, manqué), annulation dans les 30 jours et
remboursement des 60 € au retour de la tablette.

`cas-limites.parcours.js` : colis non retiré (rappels J+5 et J+12, alerte J+20, délai d'annulation), abonnement pris
depuis l'appli avec la tablette déjà installée, compteur des 30 proches, SEPA refusé ou accepté plus tard, page de
paiement abandonnée, stock épuisé, fausse signature Stripe, annulation par l'admin ou par le client avant l'envoi,
résiliation (dernier mois, rappel, 140 € si la tablette ne revient pas), installation reprise ou annulée, commande
reliée par son code, commande offerte, SOS.

`logique.parcours.js`, `croises.parcours.js`, `argent.parcours.js`, `temps.parcours.js` : remise en main propre,
impayés et pause, reprise d'un abonnement résilié, deux commandes sur une famille, deux responsables ou deux onglets
en même temps, messages Stripe en double ou dans le désordre, étiquettes et « Matériel reçu » en double, cinq mois
jour par jour.

Tâches planifiées : `s.tache('restitutions')` (et les autres tâches de `taches.js`) lance la tâche seule, comme
`tachesHoraires` le fait à son heure ; `tachesHoraires` elle-même est lancée à 3 h et 10 h dans `logique.parcours.js`.

Gestes humains côté serveur (tests de nuit, 03/11) : double appui, nouvel essai après une panne, gestes dans le
désordre, appels ou tâches en même temps.

- `resiliation.parcours.js` : « Résilier » deux fois, « Garder » deux fois, puis « Résilier » (un e-mail par vraie
  demande) ; Stripe injoignable puis nouvel essai ; arrêt décidé par Papote que la famille ne peut pas reprendre, même
  par un vieil onglet ; « Garder » refusé après la date d'arrêt.
- `retour.parcours.js` : « Je renvoie la tablette » deux fois en même temps (un seul QR code payé) ; Sendcloud en
  panne puis nouvel essai ; reprise par Papote pendant un retour anticipé (QR annulé si le colis n'est pas déposé,
  refusée s'il l'est) ; tablette rendue avant la date d'arrêt ; main propre notée par Papote puis Mondial Relay quand
  même ; tâche des restitutions relancée ou lancée deux fois (140 € et avis une seule fois, pas de remboursement).
- `sos-reseau.parcours.js` : SOS décroché au 1er ou au 2e essai, « Refuser » sur l'app Android (faux jeton, deux
  fois) ; tablette débranchée puis rebranchée ; notifications en panne puis revenues ; tâche des alertes lancée deux
  fois en même temps ; plus d'alerte après la fin de l'abonnement. Le SMS du SOS part de la tablette elle-même
  (`android/…/SmsAlert.java`) : il n'est pas testé ici.

`installation-qr.parcours.js` : installation d'une tablette par QR code (installation-qr.js) : QR créé par
l'admin, inscription de la tablette (fiche d'achat reprise, clé App Check jamais gardée en clair), nouvel essai de la
même tablette, autre tablette refusée, QR expiré après 24 h ; hors critères noté sans refus, tablette d'essai à part,
20 QR par heure au plus.

`courriels-rejetes.parcours.js` : e-mails perdus (courriels-perdus.js) : webhook Brevo refusé sans la clé ; rejet
noté sur la bonne commande et en « À faire », une seule fois ; envoi groupé, adresse sans commande, adresse corrigée ;
« colis parti » ou mise en demeure non partis (`reglages.mailsEnPanne = n`) : un seul nouvel essai à la tâche
horaire suivante, puis « À faire » ; rien pour un e-mail de confort.

`menage.parcours.js` : ménage des données (menage.js) : adresses IP d'un appel effacées à sa fin (décroché, manqué,
appel de la famille), appels, ordres, alertes et incidents de plus de 90 jours effacés par lots (récents, appel en
cours et ordre en attente gardés), comptes sans famille depuis plus de 3 mois effacés (membre, responsable, tablette,
administrateur et commande en cours gardés).

`limites.parcours.js` : limites contre les abus (limites.js, A12) : voix Google coupée au 10e message du jour du
même proche (pas pour les autres, ni pour les légendes de photos), drapeau des 50 messages jusqu'à minuit (Paris) et
messages passés en même temps sans voix, copie d'anciens messages non comptée, rappels 10 créés par jour et 30 en
cours (le rappel en trop effacé), rappel modifié 20 fois par jour avec la voix, coût (aucune lecture sur un « vu »).
Le refus lui-même (51e message, 11e rappel) est une règle Firestore, testé dans `tests/regles/` (branche de l'app).

Le refus du 31e proche lui-même est une règle Firestore : il est testé avec les règles, dans `tests/regles/`
(branche de l'app web).

## Comment c'est fait

- `simulation.js` charge `functions/index.js` avec les faux services, rejoue les déclencheurs Firestore à chaque
  écriture, envoie les événements Stripe au webhook, et fait avancer l'horloge (`avancer(jours)`).
  Une erreur dans une fonction (déclencheur, webhook, `logger.error`) fait échouer le scénario.
  Pannes à la demande : `sendcloud.panne = true` (Sendcloud répond 503), `reglages.pushEnPanne = n` (les n prochaines
  notifications échouent).
- `faux-stripe.js` : Stripe en mémoire, avec ce que font le client et sa banque (payer, refuser, fin du mois offert…).
  Comme le vrai, une clé d'idempotence rend le même paiement ou remboursement.
- `acteurs.js` : les gestes de Tanguy dans l'admin, du client sur le site, de la tablette et des proches.
