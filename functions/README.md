# Fonctions serveur Papote

Abonnements et paiements Stripe. Plan complet et état des familles : `abonnement.js` (règles) et `index.js` (fonctions).

## Mise en route (une fois)

1. `outils\admin\abonnements.bat offert "Mamie"` : la famille de Tanguy ne sera jamais suspendue.
2. `outils\stripe\installer-stripe.bat` avec la clé **de test** Stripe : crée les tarifs, le portail client, le webhook, et range les clés dans Firebase.
3. `firebase deploy --only functions --config firebase.fonctions.json --project papote-famille` (offre Blaze nécessaire). Ce fichier à part évite de toucher à `firebase.json`. Mettre d'abord dans `.env` la région de la base (`firebase firestore:databases:get "(default)"`).
4. Paiement d'essai depuis le site avec la carte 4242 4242 4242 4242.
5. Relancer `installer-stripe.bat` avec la clé **réelle**, puis redéployer.

## Tâches planifiées

Deux fonctions planifiées seulement (Cloud Scheduler : 3 gratuites, puis 0,10 $/tâche/mois) :
`alertesTablettes` toutes les 5 minutes (`alertes.js`), et `tachesHoraires` toutes les heures pile, heure de Paris
(`taches.js`), qui lance à leur heure les autres tâches (`taches.PLANNING`) : `relancesPaniers`, `finDeGrace`,
`gestionCourrier` et `alerteForfait` toutes les heures ; `gestionAutomatique` à 4 h, `restitutions` à 9 h, `rappelsJumelage` et
`alerteMatin` à 10 h chaque jour ; `gestionRecap` (8 h) et `bilanSupport` (9 h) le lundi ; `purgeMensuelle` (4 h) et
`gestionCloture` (5 h) le 1er du mois. Une tâche en erreur est journalisée et n'arrête pas les autres.

`alerteForfait` (`forfait-alerte.js`) : forfait internet de la carte SIM d'une tablette (lu sur sa fiche,
`members/{uid}.sim`) à 80 et 95 % : e-mail à contact@mapapote.fr, puis à 95 % e-mail calme aux responsables de la
famille (en journée), une fois par forfait (`members/{uid}.alerteForfait`). Le message suit
`families/{fid}.forfaitSim.finForfait` (« débit réduit » ou « internet coupé », choisi sur la carte SIM dans l'admin).
Forfait « internet coupé » épuisé puis tablette muette : « internet sans doute coupé par le forfait », pas une panne.

Ménage quotidien (`menage.js`, lancé avec `rappelsJumelage` à 10 h, sans tâche planifiée de plus) : appels finis,
ordres exécutés ou refusés (`families/{fid}/calls`, `commands`), `alertes/` et `incidentsAppels/` de plus de 90 jours,
par lots de 300 (jamais un appel qui sonne ou en cours, jamais un ordre qui attend sa tablette) ; comptes de connexion
membres d'aucune famille et sans connexion depuis 3 mois (jamais une tablette, l'administrateur, un responsable ou
un e-mail dont une commande est en cours). À la fin de chaque appel, `appelsManques` efface ses adresses IP
(`offer.sdp`, `answer.sdp`, candidats réseau).

## Tests

`npm test` : règles de passage entre statuts (actif, impayé, suspendu...).

`npm run parcours` : parcours client complet (commande, envoi, installation, envois, appel, annulation, cas limites)
sur les émulateurs Firebase, Stripe simulé. Lancé aussi par GitHub à chaque changement : voir `parcours/README.md`.

## Livraison en point relais et e-mails

- Le site fait choisir un point relais Mondial Relay avant le paiement (`vitrine/commande.html`, sélecteur Sendcloud : clé publique de l'intégration « Papote » dans SENDCLOUD_CLE). `livraison.id` est l'identifiant Sendcloud du point relais, à utiliser pour créer l'étiquette dans Sendcloud.
- Colis parti : bouton du tableau de bord admin (fonction `tabletteEnvoyee`) ou `outils\admin\abonnements.bat envoyee <e-mail|code> <numéro de suivi>`. Le client reçoit l'e-mail avec le lien de suivi (`commandeModifiee`).
- Tablette pas jumelée : rappels au client 5 et 12 jours après l'envoi (`rappelsJumelage`), puis `alerteJumelage: true` sur la commande à 20 jours.
- E-mails envoyés par SMTP : `MAIL_SMTP` et `MAIL_EXPEDITEUR` dans `.env`, mot de passe rangé par `outils\mail\installer-mail.bat` (secret `MAIL_MOT_DE_PASSE`, à créer AVANT le déploiement).
