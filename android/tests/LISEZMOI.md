# Essais de la tablette, sans tablette

Deux familles d'essais, à lancer depuis le dossier du dépôt.

**Écrans et appels** (la page de la tablette dans un vrai navigateur, Android et Firebase imités) :

```
npm install -g playwright
npx playwright install chromium
node --test "android/tests/*.test.js"
```

28 scénarios : trois jours simulés et mise à jour (duree.test.js), file des envois, voix, nuit, rappels, SOS, anniversaire, pause, wifi, appels
(sonnerie, décrocher, raccrocher, appelant disparu, deuxième appel, Mamie qui appelle, test du son).

**Petites fonctions Java** (veille, dates, météo, jeton, écritures en attente) :

```
cd android
.\gradlew.bat test
```
