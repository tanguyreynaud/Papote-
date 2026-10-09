# Fonctions serveur Papote

Abonnements et paiements Stripe. Plan complet et état des familles : `abonnement.js` (règles) et `index.js` (fonctions).

## Mise en route (une fois)

1. `outils\admin\abonnements.bat offert "Mamie"` : la famille de Tanguy ne sera jamais suspendue.
2. `outils\stripe\installer-stripe.bat` avec la clé **de test** Stripe : crée les tarifs, le portail client, le webhook, et range les clés dans Firebase.
3. `firebase deploy --only functions --config firebase.fonctions.json --project papote-famille` (offre Blaze nécessaire). Ce fichier à part évite de toucher à `firebase.json`. Mettre d'abord dans `.env` la région de la base (`firebase firestore:databases:get "(default)"`).
4. Paiement d'essai depuis le site avec la carte 4242 4242 4242 4242.
5. Relancer `installer-stripe.bat` avec la clé **réelle**, puis redéployer.

## Tests

`npm test` : règles de passage entre statuts (actif, impayé, suspendu...).

## Livraison en point relais et e-mails

- Le site fait choisir un point relais Mondial Relay (`vitrine/commande.html`) avant le paiement. Le code enseigne de test `BDTEST` est à remplacer par celui du compte pro dans ce fichier.
- Colis parti : bouton du tableau de bord admin (fonction `tabletteEnvoyee`) ou `outils\admin\abonnements.bat envoyee <e-mail|code> <numéro de suivi>`. Le client reçoit l'e-mail avec le lien de suivi (`commandeModifiee`).
- Tablette pas jumelée : rappels au client 5 et 12 jours après l'envoi (`rappelsJumelage`), puis `alerteJumelage: true` sur la commande à 20 jours.
- E-mails envoyés par SMTP : `MAIL_SMTP` et `MAIL_EXPEDITEUR` dans `.env`, mot de passe rangé par `outils\mail\installer-mail.bat` (secret `MAIL_MOT_DE_PASSE`, à créer AVANT le déploiement).
