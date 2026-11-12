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
`gestionCourrier`, `alerteForfait` et `courrielsAReessayer` toutes les heures ; `gestionAutomatique` à 4 h, `restitutions` à 9 h, `rappelsJumelage` et
`alerteMatin` à 10 h chaque jour ; `gestionRecap` (8 h) et `bilanSupport` (9 h) le lundi ; `purgeMensuelle` (4 h) et
`gestionCloture` (5 h) le 1er du mois. Une tâche en erreur est journalisée et n'arrête pas les autres.

`alerteForfait` (`forfait-alerte.js`) : forfait internet de la carte SIM d'une tablette (lu sur sa fiche,
`members/{uid}.sim`) à 80 et 95 % : e-mail à contact@mapapote.fr, puis à 95 % e-mail calme aux responsables de la
famille (en journée), une fois par forfait (`members/{uid}.alerteForfait`). Le message suit
`families/{fid}.forfaitSim.finForfait` (« débit réduit » ou « internet coupé », choisi sur la carte SIM dans l'admin).
Forfait « internet coupé » épuisé puis tablette muette : « internet sans doute coupé par le forfait », pas une panne.

## Tests

`npm test` : règles de passage entre statuts (actif, impayé, suspendu...).

`npm run parcours` : parcours client complet (commande, envoi, installation, envois, appel, annulation, cas limites)
sur les émulateurs Firebase, Stripe simulé. Lancé aussi par GitHub à chaque changement : voir `parcours/README.md`.

## Livraison en point relais et e-mails

- Le site fait choisir un point relais Mondial Relay avant le paiement (`vitrine/commande.html`, sélecteur Sendcloud : clé publique de l'intégration « Papote » dans SENDCLOUD_CLE). `livraison.id` est l'identifiant Sendcloud du point relais, à utiliser pour créer l'étiquette dans Sendcloud.
- Colis parti : bouton du tableau de bord admin (fonction `tabletteEnvoyee`) ou `outils\admin\abonnements.bat envoyee <e-mail|code> <numéro de suivi>`. Le client reçoit l'e-mail avec le lien de suivi (`commandeModifiee`).
- Tablette pas jumelée : rappels au client 5 et 12 jours après l'envoi (`rappelsJumelage`), puis `alerteJumelage: true` sur la commande à 20 jours.
- E-mails envoyés par SMTP : `MAIL_SMTP` et `MAIL_EXPEDITEUR` dans `.env`, mot de passe rangé par `outils\mail\installer-mail.bat` (secret `MAIL_MOT_DE_PASSE`, à créer AVANT le déploiement).

## E-mails perdus (rejets Brevo, envois ratés)

`courriels-perdus.js` (audit des e-mails du 11/11, point 2). Chaque e-mail perdu va dans `courrielsPerdus/{id}`, sur la
commande de l'adresse (`mailErreur`, lu par l'admin) et en ligne « À faire » (récap du lundi ; `gestionDonnees`
renvoie `courrielsPerdus` et `courrielsAFaire` ; `gestionCourrielTraite({ id })` règle une ligne). Corriger l'adresse
e-mail d'une commande règle aussi ses lignes.

- **Rejet signalé par Brevo** (adresse inexistante ou mal écrite, boîte pleine, bloqué, indésirable, désinscrit) :
  fonction `brevoWebhook`, protégée par le secret `BREVO_WEBHOOK_SECRET`.
- **Envoi SMTP raté** pour un e-mail important (tout sauf les e-mails de confort `mail.CONFORT` et les envois en
  nombre) : gardé, renvoyé **une seule fois** par la tâche horaire suivante (`courrielsAReessayer`, dans
  `tachesHoraires` : aucune tâche Cloud Scheduler en plus), puis ligne « À faire ».

Réglage, une fois (avant le prochain déploiement des fonctions, sinon il s'arrête ou demande la valeur) :

1. `firebase functions:secrets:set BREVO_WEBHOOK_SECRET --project papote-famille` et coller une longue valeur au
   hasard (`openssl rand -hex 32`). Jamais dans le dépôt.
2. Déployer les fonctions.
3. Brevo > Transactionnel > Paramètres > Webhook > « Ajouter un webhook » : URL
   `https://europe-west1-papote-famille.cloudfunctions.net/brevoWebhook?cle=<la valeur du secret>`, événements
   Hard bounce, Soft bounce, Bloqué, Adresse invalide, Plainte (spam), Désinscrit, Erreur. Si Brevo propose un jeton
   « Bearer » ou un en-tête, la même valeur peut y aller à la place de `?cle=` (en-tête `Authorization: Bearer …` ou
   `X-Papote-Cle`).
4. Essai : un e-mail vers une adresse qui n'existe pas (`nimporte-quoi-1234@mapapote.fr`) donne une ligne « À faire ».
