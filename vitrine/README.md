# Site vitrine Papote

Page de présentation publique : fonctionnement, tarifs, FAQ, boutons Commander (paiement Stripe, voir `functions/`) et page `merci.html` après paiement. Fichiers statiques, sans dépendance.

Polices : servies par le site lui-même (`polices/`, copie des fichiers Google Fonts « latin », licence OFL), demandées dès le haut de chaque page. En attendant, le texte s'affiche dans une police du téléphone (Roboto sur Android, Arial ailleurs) agrandie ou réduite pour prendre exactement la même place (`« … repli »` dans chaque page) : rien ne saute à l'arrivée de la vraie police. Si une police ou une taille de texte change, refaire ce réglage (largeur d'un même texte dans les deux polices).

## Publication

Second site Firebase Hosting du projet `papote-famille`, à côté de l'app famille (dont l'adresse ne change pas).

Adresse du site : https://mapapote.fr (et www), branchée sur ce site dans la console Firebase > Hosting > « Ajouter un domaine personnalisé ». L'ancienne adresse https://papote.web.app marche toujours.

Une seule fois : `firebase hosting:sites:create papote --project papote-famille` (adresse https://papote.web.app ; si le nom est pris, en choisir un autre et le reporter dans `firebase.vitrine.json` et `functions/.env`).

Ensuite, comme l'app famille :
- `node outils/vitrine/publier.mjs test` : adresse de test à vérifier ;
- `node outils/vitrine/publier.mjs en-ligne` : mise en ligne.

La configuration est dans `firebase.vitrine.json` (site `papote` seul) : `firebase.json` et l'app famille ne sont pas concernés.
