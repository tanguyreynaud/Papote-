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

## CGV en PDF

Les CGV sont jointes en PDF à chaque e-mail de confirmation de commande (A13, 12/11/2026). Après tout changement de `cgv.html`, relancer `node outils/cgv-pdf/generer.js` et garder le nouveau `functions/documents/cgv.pdf` (sinon les tests des fonctions sont rouges), puis publier les fonctions.

## Se désinscrire

`desinscription.html` : page du lien « Se désinscrire des e-mails d'information » (A4, 12/11/2026), qui n'est que sur
les rappels de commande, « Être prévenu », l'ouverture des commandes et les nouvelles de l'admin, jamais sur un e-mail
de service. Le lien des e-mails est `https://mapapote.fr/desinscription?c=…&j=…` : `firebase.vitrine.json` le relie à la
fonction `desinscription`, qui renvoie vers cette page (GET, rien ne change) ou retire l'accord (POST : le bouton de la
page, ou « Se désabonner » de la messagerie grâce à l'en-tête List-Unsubscribe-Post). Publier les fonctions avant le
site : sinon `/desinscription` n'existe pas encore.
