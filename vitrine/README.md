# Site vitrine Papote

Page de présentation publique : fonctionnement, tarifs, FAQ, boutons Commander (paiement Stripe, voir `functions/`) et page `merci.html` après paiement. Fichiers statiques, sans dépendance.

## Publication

Second site Firebase Hosting du projet `papote-famille`, à côté de l'app famille (dont l'adresse ne change pas).

Une seule fois : `firebase hosting:sites:create papote --project papote-famille` (adresse https://papote.web.app ; si le nom est pris, en choisir un autre et le reporter dans `.firebaserc` et `functions/.env`).

Ensuite, comme l'app famille :
- `node outils/vitrine/publier.mjs test` : adresse de test à vérifier ;
- `node outils/vitrine/publier.mjs en-ligne` : mise en ligne.

Prérequis dans `firebase.json` et `.firebaserc` (fil de l'app famille) : cibles d'hébergement `famille` (web/) et `vitrine` (vitrine/).
