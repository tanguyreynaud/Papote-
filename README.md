# Papote

Une alternative maison et gratuite à Linote : une tablette Android simplifiée pour Mamie,
et une app pour que la famille lui envoie photos et messages depuis iPhone ou Android.

## Ce que ça fait

**Sur la tablette** (Android 9 ou plus récent, en mode kiosque, toujours sur son chargeur) :
- l'heure, la date, le moment de la journée et la météo en très grand, les photos de la famille à droite
  (un appui ouvre le diaporama, qui défile tout seul) ;
- chaque nouvel envoi s'affiche en plein écran : photo, message, message vocal, vidéo ;
- rappels en plein écran 15 minutes avant puis à l'heure ; anniversaires de la famille ;
- appels vidéo de la famille vers la tablette, avec un gros bouton « Décrocher » ;
- couleurs sombres le soir, écran en veille de 23 h à 7 h ;
- mises à jour installées toutes seules (voir « Publier une mise à jour »).

**Sur le téléphone de la famille** : https://app.mapapote.fr
- rejoindre avec le code famille, sans créer de compte ;
- envoyer des photos (réduites automatiquement) et des messages ;
- voir si Mamie a vu l'envoi et si elle a envoyé un bisou ;
- s'installe comme une app : Safari > Partager > « Sur l'écran d'accueil » (iPhone),
  ou Chrome > ⋮ > « Ajouter à l'écran d'accueil » (Android).

## Tous les scripts et outils

Scripts `.bat` : double-cliquer dessus, ou les lancer depuis PowerShell dans le dossier du projet.
Outils `node` : depuis le dossier du projet, `node <chemin>`.

| Script | À quoi il sert | Commande |
| --- | --- | --- |
| Installer une tablette | Installe Papote, le mode kiosque et les réglages ; note la tablette dans le stock | `.\installation\installer-tablette.bat` |
| Diagnostic | Vérifie une tablette branchée et dit ce qui ne va pas | `.\installation\diagnostic.bat` |
| Retirer Papote | Enlève Papote et le mode kiosque, réactive les applis (sans tout effacer) | `.\installation\retirer-papote.bat` |
| Remettre à l'état usine | Efface tout pour rendre la tablette au fournisseur (n° de série à retaper) | `.\installation\remettre-a-zero.bat` |
| Publier une mise à jour tablette | Compile et publie : les tablettes l'installent seules (`-Test` : tablettes de test d'abord) | `.\installation\publier-mise-a-jour.ps1` |
| Passer la version de test à tous | Donne la version de test à toutes les tablettes, sans recompiler | `.\installation\promouvoir-mise-a-jour.ps1` |
| Publier l'app famille | Vérifie puis met en ligne l'app famille : d'abord `test`, puis `en-ligne` | `node outils/web/publier.mjs test` (branche de l'app famille) |
| Vérifier l'app famille | Contrôle l'app famille avant sa mise en ligne | `node outils/web/verifier.mjs` (branche de l'app famille) |
| Publier le site vitrine | Met en ligne mapapote.fr : d'abord `test`, puis `en-ligne` | `node outils/vitrine/publier.mjs test` |
| Abonnements | Liste les familles et leur abonnement ; famille offerte | `node outils/admin/abonnements.js` |
| Badge administrateur | Donne ou retire l'accès admin à un compte Google | `node outils/admin/badge-admin.js` |
| Statistiques | Visites et commandes des 30 derniers jours | `node outils/admin/statistiques.js [jours]` |
| Nettoyer les comptes anonymes | Supprime les comptes anonymes qui ne sont dans aucune famille | `node outils/admin/nettoyer-comptes-anonymes.js` |
| Préparer une tablette (stock) | Note la tablette dans le stock et donne son numéro T-0xx (lancé par l'installation) | `node outils/gestion/preparer-tablette.js --serie <n°>` |
| Clés Stripe | Prépare le compte Stripe et range ses clés | `.\outils\stripe\installer-stripe.bat` |
| Mot de passe des e-mails | Range le mot de passe d'envoi des e-mails | `.\outils\mail\installer-mail.bat` |
| Mot de passe des factures | Range le mot de passe de la boîte mail des factures | `.\outils\gestion\installer-factures.bat` |
| Clés Sendcloud | Range les clés Sendcloud (étiquettes de colis) | `.\outils\gestion\installer-sendcloud.bat` |
| Clé du chat de support | Range la clé Anthropic du chat de support | `.\outils\support\installer-support.bat` |
| Tester le chat de support | Pose une série de questions au chat et affiche ses réponses | `node outils/support/tester-chat.js` |

Les clés et mots de passe sont lus dans le presse-papiers puis effacés : jamais affichés ni écrits dans le dépôt.

## Installer une nouvelle tablette

1. Sur la tablette : Paramètres > À propos > appuyer 7 fois sur « Numéro de build »,
   puis Options pour les développeurs > activer « Débogage USB ».
2. Pour le mode kiosque complet, la tablette ne doit avoir **aucun compte** (Google, Samsung…).
   Le plus simple : la réinitialiser et passer la configuration sans ajouter de compte.
3. Brancher la tablette au PC en USB et double-cliquer sur `installation/installer-tablette.bat`.
4. Entrer le code tablette (app famille, Réglages > Installer une tablette), ou rien :
   la tablette affiche alors l'écran « Bienvenue » et le client la configure lui-même, sans PC :
   nom de la tablette, wifi (sauté s'il y a une carte SIM avec internet), ville de la météo, puis QR code
   ou code à taper dans l'app famille (« Ajouter ma tablette »), confirmation « C'est bien vous ? » sur la
   tablette, et placement de la tablette face à la personne (image de la caméra).
   Ville de la météo connue d'avance : `-Ville "Lyon"` au script d'installation (l'étape est alors sautée).
   Sur la tablette, on tape le code postal puis on choisit la commune dans la liste (geo.api.gouv.fr).
   La famille peut la changer ensuite : l'appli famille écrit `families/{fid}.meteoVille = {nom, lat, lon}`
   (lat/lon facultatifs, retrouvés d'après le nom), et la tablette indique la ville en cours sur sa fiche
   (`members/{uid}.meteoVille`).
5. Sur le PC qui a la clé d'administration (`%USERPROFILE%\.papote\cle-admin-firebase.json`),
   l'installation note aussi la tablette dans le stock (`outils/gestion/preparer-tablette.js`,
   d'après son n° de série) et affiche son numéro, par exemple « >>> Écrivez T-012 sur le carton. ».
   Écrivez-le sur le carton. Au jumelage chez le client, la tablette envoie ce n° de série et sa
   commande est reliée à la famille. Sans la clé, cette étape est simplement sautée.
6. L'installation crée aussi la clé App Check de la tablette (`outils/admin/cle-tablette.js --serie`)
   et la lui envoie : la tablette prouve ainsi à Firebase qu'elle est une vraie tablette Papote.
   La clé n'est écrite nulle part sur le PC. La remise à zéro la retire (`--retirer`).
   Sans l'outil, la tablette marche quand même : rien n'est encore exigé côté Firebase.

## Remettre une tablette à l'état usine (retour au fournisseur)

Brancher la tablette en USB et double-cliquer sur `installation/remettre-a-zero.bat`.
Le script affiche le n° de série de la tablette et demande de le retaper pour confirmer.
La tablette quitte sa famille, puis Android efface tout (famille, photos, wifi, Papote) et
redémarre sur l'écran de première configuration, comme sortie du carton. Garde-fou : Papote
n'efface que la tablette dont on lui donne le n° de série.
Une tablette qui n'est pas en mode kiosque se remet à zéro à la main :
Paramètres > Système > Réinitialiser > Effacer toutes les données.

## Publier une mise à jour

1. Augmenter `versionCode` et `versionName` dans `android/app/build.gradle.kts`, puis faire un commit.
2. Lancer `installation/publier-mise-a-jour.ps1 -Test` : seules les tablettes de test (installées avec
   `-Canal test`) reçoivent la nouvelle version.
3. Si tout va bien, `installation/promouvoir-mise-a-jour.ps1` la passe à toutes les tablettes, sans recompiler.
   (Sans `-Test`, `publier-mise-a-jour.ps1` publie directement pour toutes les tablettes.)
4. Les tablettes vérifient toutes les 6 heures et s'installent la nouvelle version toutes seules.

En une commande, depuis un PowerShell dans `installation/` :

    .\installer-tablette.ps1 -Code ABCD-2345 -Wifi "Nom du wifi" -MotDePasse "..." -Oui

Ce que le script fait à la tablette, de A à Z :
1. installe Papote (caméra et micro autorisés d'office) ;
2. date et heure automatiques, écran toujours allumé sur le chargeur, barre de navigation du bas masquée,
   wifi si demandé ;
3. mode kiosque (propriétaire de l'appareil) : Papote est l'écran d'accueil et ne se quitte pas, pas de volet
   de notifications, pas de menu « Éteindre », pas de démarrage sans échec ;
4. Papote filtre les appels (rôle « filtrage des appels ») : appels de la carte SIM refusés ; les SMS reçus ne
   s'affichent nulle part (appli Messages désactivée) et Papote peut envoyer ses alertes ;
5. désactive les applis inutiles listées dans `installation/applis-inutiles.txt` (rien n'est effacé) ;
6. relie la tablette à la famille avec le code tablette.

Option : `-Numeros "0612345678,0698765432"`
(avec une carte SIM : SMS d'alerte quand la tablette n'a plus internet depuis 30 minutes, puis quand il revient).

Au démarrage, l'appli règle elle-même le volume (fort), bloque les boutons de volume, rallume l'écran en
journée si on appuie sur le bouton marche/arrêt, et met l'écran en veille de 23 h à 7 h.

Pour vérifier une tablette branchée (avant un envoi, ou en cas de souci) : `installation/diagnostic.bat`.
Il contrôle la version, le mode kiosque, les réglages, le réseau, la batterie et affiche le journal récent.

Pour remettre la tablette à la normale : `installation/retirer-papote.bat`.

Maintenance par ADB :
- sortir du kiosque temporairement : `adb shell am start -n com.papote.tablette/.MainActivity --ez unlock true`
- y revenir : `adb shell am start -n com.papote.tablette/.MainActivity --ez lock true`

## Organisation du code

| Dossier | Contenu |
|---|---|
| `web/` | App famille (`index.html`), hébergée sur Firebase Hosting |
| `android/` | App de la tablette : écran (`app/src/main/assets/`), synchronisation Firebase et météo en Java, mode kiosque |
| `installation/` | `Papote.apk` prêt à installer et les scripts d'installation |
| `firestore.rules` | Règles de sécurité : seuls les membres d'une famille voient ses photos |

L'écran de la tablette est une page locale (`tablette.html`, `tablette.js`, `tablette.css`).
Les accès à Firebase et à la météo passent par le Java (`Sync.java`, API REST, sans SDK Firebase) ;
les vidéos et les messages vocaux sont lus par Android. Après une modification, publier une mise à jour
(ci-dessus) ou relancer `installer-tablette.bat` pour une tablette branchée.

## Coûts

0 € : Firebase en offre gratuite (Spark), météo Open-Meteo (gratuite, sans clé).

Pour limiter les coûts si le nombre de tablettes grandit :
- chaque modification côté famille incrémente `families/{fid}.rev` ; la tablette ne lit que ce
  marqueur (1 lecture toutes les 20 s), et ne relit envois et rappels que s'il a changé ;
  sur les tablettes récentes, la page l'écoute en direct et la tablette ne vérifie plus que toutes les 10 min ;
- un envoi ne contient qu'un aperçu (~10 à 40 Ko) ; la photo ou le son complets sont dans
  `posts/{id}/media/{image|audio}`, chargés seulement à la demande ;
- l'app famille garde photos et vocaux déjà ouverts en cache sur le téléphone.

## Reconstruire l'app Android

La clé de signature est hors du dépôt, dans `%USERPROFILE%\.papote\` (à sauvegarder) :
copier `signing.properties` dans `android/`, puis

```
cd android
gradlew assembleRelease
copy app\build\outputs\apk\release\app-release.apk ..\installation\Papote.apk
```
