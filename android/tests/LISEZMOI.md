# Essais de la tablette, sans tablette

Deux familles d'essais, à lancer depuis le dossier du dépôt.

**Écrans et appels** (la page de la tablette dans un vrai navigateur, Android et Firebase imités) :

```
npm install --no-save playwright firebase@12.19.0
npx playwright install chromium
node --test "android/tests/*.test.js"
```

28 scénarios : trois jours simulés et mise à jour (duree.test.js), file des envois, voix, nuit, rappels, SOS, anniversaire, pause, wifi, appels
(sonnerie, décrocher, raccrocher, appelant disparu, deuxième appel, Mamie qui appelle, test du son).

appcheck.test.js fait tourner le **vrai** code App Check de Firebase (paquet `firebase`, même version que dans appels.js) :
il compte les demandes de jeton pendant une heure et échoue si la page se met à en redemander en boucle
(pics de processeur du 19/11 : un jeton gardé après sa 35e minute était redemandé des milliers de fois par seconde).

**Petites fonctions Java** (veille, dates, météo, jeton, écritures en attente) :

```
cd android
.\gradlew.bat test
```
