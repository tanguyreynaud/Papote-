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

Le refus du 31e proche lui-même est une règle Firestore : il est testé avec les règles, dans `tests/regles/`
(branche de l'app web).

## Comment c'est fait

- `simulation.js` charge `functions/index.js` avec les faux services, rejoue les déclencheurs Firestore à chaque
  écriture, envoie les événements Stripe au webhook, et fait avancer l'horloge (`avancer(jours)`).
  Une erreur dans une fonction (déclencheur, webhook, `logger.error`) fait échouer le scénario.
- `faux-stripe.js` : Stripe en mémoire, avec ce que font le client et sa banque (payer, refuser, fin du mois offert…).
- `acteurs.js` : les gestes de Tanguy dans l'admin, du client sur le site, de la tablette et des proches.
