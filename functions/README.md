# Fonctions serveur Papote

Abonnements et paiements Stripe. Plan complet et état des familles : `abonnement.js` (règles) et `index.js` (fonctions).

## Mise en route (une fois)

1. `outils\admin\abonnements.bat offert "Mamie"` : la famille de Tanguy ne sera jamais suspendue.
2. `outils\stripe\installer-stripe.bat` avec la clé **de test** Stripe : crée les tarifs, le portail client, le webhook, et range les clés dans Firebase.
3. `firebase deploy --only functions` (offre Blaze nécessaire).
4. Paiement d'essai depuis le site avec la carte 4242 4242 4242 4242.
5. Relancer `installer-stripe.bat` avec la clé **réelle**, puis redéployer.

## Tests

`npm test` : règles de passage entre statuts (actif, impayé, suspendu...).
