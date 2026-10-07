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

**Sur le téléphone de la famille** : https://papote-famille.web.app
- rejoindre avec le code famille, sans créer de compte ;
- envoyer des photos (réduites automatiquement) et des messages ;
- voir si Mamie a vu l'envoi et si elle a envoyé un bisou ;
- s'installe comme une app : Safari > Partager > « Sur l'écran d'accueil » (iPhone),
  ou Chrome > ⋮ > « Ajouter à l'écran d'accueil » (Android).

## Installer une nouvelle tablette

1. Sur la tablette : Paramètres > À propos > appuyer 7 fois sur « Numéro de build »,
   puis Options pour les développeurs > activer « Débogage USB ».
2. Pour le mode kiosque complet, la tablette ne doit avoir **aucun compte** (Google, Samsung…).
   Le plus simple : la réinitialiser et passer la configuration sans ajouter de compte.
3. Brancher la tablette au PC en USB et double-cliquer sur `installation/installer-tablette.bat`.
4. Entrer le code famille (dans l'app famille, menu Réglages).

## Publier une mise à jour

1. Augmenter `versionCode` et `versionName` dans `android/app/build.gradle.kts`, puis faire un commit.
2. Lancer `installation/publier-mise-a-jour.ps1` : il compile le code enregistré, range l'APK sur GitHub
   et publie le numéro de version sur https://papote-maj.web.app.
3. Les tablettes vérifient toutes les 6 heures et s'installent la nouvelle version toutes seules.

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
