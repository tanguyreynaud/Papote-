# Papote

Une alternative maison et gratuite à Linote : une tablette Android simplifiée pour Mamie,
et une app pour que la famille lui envoie photos et messages depuis iPhone ou Android.

## Ce que ça fait

**Sur la tablette** (Android 4.4 ou plus récent, toujours allumée sur son chargeur) :
- l'heure et la date en très grand, la dernière photo de la famille sur tout le bord droit ;
- jusqu'à 4 visages de la famille : un appui lance un appel vidéo (tablettes Android 5 et plus) ;
- deux gros boutons « Photos » et « Messages » ;
- chaque nouvel envoi s'affiche en plein écran : photo, message (texte calibré pour tenir sans défiler),
  message vocal (« Écouter » d'abord, puis « Réécouter », « Envoyer un bisou » ou « OK ») ;
- rappels en plein écran 15 minutes avant (« Dans 15 minutes ») puis à l'heure (« C'est l'heure ! ») ;
- appels vidéo de la famille vers la tablette, avec un gros bouton « Décrocher » ;
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
3. Sur Android 4.4 (comme la Galaxy Tab E), le mode kiosque n'existe pas : Papote devient l'écran
   d'accueil et bloque le volet des notifications. Au premier lancement, choisir « Papote » puis « Toujours ».
4. Brancher la tablette au PC en USB et double-cliquer sur `installation/installer-tablette.bat`.
5. Entrer le code famille (dans l'app famille, menu ⚙︎ Réglages).

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

L'écran de la tablette est une page locale écrite pour le navigateur d'Android 4.4 (JavaScript ES5).
Les accès réseau passent par le Java (`Sync.java`), qui active TLS 1.2 et un chiffrement à jour
via les services Google Play sur les vieilles tablettes. Après une modification, reconstruire l'APK
puis relancer `installer-tablette.bat`.

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
