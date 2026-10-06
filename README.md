# Papote

Une alternative maison et gratuite à Linote : une tablette Android simplifiée pour Mamie,
et une app pour que la famille lui envoie photos et messages depuis iPhone ou Android.

## Ce que ça fait

**Sur la tablette** (verrouillée sur Papote, toujours allumée sur son chargeur) :
- l'heure, la date et la météo de Saint-Martin-de-Valamas en très grand ;
- un cadre photo qui fait défiler les dernières photos de la famille ;
- deux gros boutons « Photos » et « Messages » ;
- chaque nouvel envoi s'affiche en grand avec un petit son, et un bouton « ❤️ Envoyer un bisou » ;
- passage en couleurs sombres la nuit (21 h – 7 h), retour automatique à l'accueil.

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
4. Entrer le code famille (dans l'app famille, menu ⚙︎ Réglages).

Pour remettre la tablette à la normale : `installation/retirer-papote.bat`.

Maintenance par ADB :
- sortir du kiosque temporairement : `adb shell am start -n com.papote.tablette/.MainActivity --ez unlock true`
- y revenir : `adb shell am start -n com.papote.tablette/.MainActivity --ez lock true`

## Organisation du code

| Dossier | Contenu |
|---|---|
| `web/` | App famille (`index.html`) et écran tablette (`tablette.html`), hébergés sur Firebase Hosting |
| `android/` | Petite app Android qui affiche l'écran tablette en plein écran et gère le mode kiosque |
| `installation/` | `Papote.apk` prêt à installer et les scripts d'installation |
| `firestore.rules` | Règles de sécurité : seuls les membres d'une famille voient ses photos |

L'écran de la tablette est une page web : une modification de `web/` arrive sur toutes les tablettes
après `firebase deploy --only hosting`, sans réinstaller l'app.

## Coûts

0 € : Firebase en offre gratuite (Spark), météo Open-Meteo (gratuite, sans clé).
Les photos sont stockées dans Firestore (environ 200 à 600 Ko chacune, 1 Go gratuit).

## Reconstruire l'app Android

La clé de signature est hors du dépôt, dans `%USERPROFILE%\.papote\` (à sauvegarder) :
copier `signing.properties` dans `android/`, puis

```
cd android
gradlew assembleRelease
copy app\build\outputs\apk\release\app-release.apk ..\installation\Papote.apk
```
