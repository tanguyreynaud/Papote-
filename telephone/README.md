# Papote sur téléphone (app Android de la famille)

Petite app Android pour que le téléphone d'un proche **sonne comme un vrai appel** quand la
tablette appelle : sonnerie en boucle, écran plein « Mamie vous appelle » même en veille et
verrouillé, boutons Répondre / Refuser. Tout le reste est l'app famille habituelle
(https://app.mapapote.fr), ouverte dans Chrome en plein écran (Trusted Web Activity) : connexion
Google, caméra, micro et nouveautés du site marchent sans republier l'app.

## Comment ça marche

1. Au lancement, l'app demande les notifications (Android 13+) et l'écran d'appel plein écran
   (Android 14+), récupère son jeton Firebase Cloud Messaging et ouvre
   `https://app.mapapote.fr/?natif=<jeton>`.
2. L'app famille range ce jeton dans `families/{fid}/members/{uid}/private/push`, champ `natifs`,
   et retire le jeton du navigateur de ce téléphone (sinon il sonnerait deux fois) :
   `web/js/push.js`.
3. Le serveur (`functions/push.js`, `functions/appels.js`) envoie en priorité haute Android :
   - `{ type: 'appel', cid, nom }` : le téléphone sonne (`Sonnerie.java` → `Appels.sonner`) ;
   - `{ type: 'fin', cid }` : quelqu'un a décroché, les autres téléphones se taisent ;
   - `{ type: 'manque', cid, nom }` : « Appel manqué », qui rappelle la tablette pendant 24 h ;
   - `{ type: 'alerte', titre, texte }` : tablette débranchée, silencieuse…
4. « Répondre » déverrouille le téléphone si besoin et ouvre `https://app.mapapote.fr/?appel=<cid>`.
   « Refuser » coupe la sonnerie de ce téléphone (la tablette continue jusqu'à 45 s pour les
   autres proches).

## À faire une fois

1. **Firebase** : console Firebase, projet `papote-famille`, *Ajouter une application* → Android,
   nom de paquet `fr.mapapote.famille`. Télécharger `google-services.json` et le mettre dans
   `telephone\app\` (il reste hors du dépôt, voir `.gitignore`).
2. **Clé de signature** (à garder précieusement, hors du dépôt) :

   ```
   keytool -genkeypair -v -keystore C:\Users\tangu\.papote\papote-telephone.jks -alias papote -keyalg RSA -keysize 2048 -validity 10000
   ```

   puis `telephone\signing.properties` :

   ```
   storeFile=C:/Users/tangu/.papote/papote-telephone.jks
   storePassword=...
   keyAlias=papote
   keyPassword=...
   ```

3. **Lien de confiance avec le site** : sans lui, Chrome affiche une barre d'adresse en haut.
   Le site doit publier `https://app.mapapote.fr/.well-known/assetlinks.json` avec l'empreinte
   SHA-256 de la clé de signature (celle de `keytool -list -v -keystore ...`) **et** celle de la
   clé de signature Google Play (Play Console → *Intégrité de l'appli*).

## Construire

Depuis `telephone\` (une commande par ligne) :

```
.\gradlew.bat assembleRelease
.\gradlew.bat bundleRelease
```

- `app\build\outputs\apk\release\app-release.apk` : à installer directement sur un téléphone
  (`adb install -r app\build\outputs\apk\release\app-release.apk`).
- `app\build\outputs\bundle\release\app-release.aab` : à envoyer sur le Play Store.

## Play Store

- Paquet `fr.mapapote.famille` (définitif une fois publié).
- Commencer par le **test interne** (jusqu'à 100 testeurs, disponible tout de suite).
- Déclaration demandée pour `USE_FULL_SCREEN_INTENT` : catégorie « appels » (l'app reçoit des
  appels vidéo de la tablette).
- Augmenter `versionCode` dans `app/build.gradle.kts` à chaque envoi.
