# Tests de bout en bout de l'app famille

L'app famille (`web/`) est ouverte dans un vrai navigateur (Chromium sans écran) et utilisée comme
un proche le ferait : inscription, installation de la tablette, photos, messages, appels…
Tout tourne sur l'ordinateur, sur les émulateurs Firebase : rien n'est envoyé en ligne, rien n'est payant.

## Lancer

```
cd tests\app-famille
npm install
npm test
```

Il faut Node 20 ou plus et Java 11 ou plus (pour les émulateurs). Le premier lancement télécharge
Chromium et les émulateurs (quelques minutes), les suivants durent environ 10 minutes.

Un seul fichier : `npm test -- scenarios/appels.test.js` ne marche pas (le script lance tous les
scénarios) ; utiliser plutôt
`npx firebase-tools@14 emulators:exec --only firestore,auth,storage --project demo-papote --config firebase.json "node --test --test-concurrency=1 scenarios/appels.test.js"`.

À chaque échec, le dernier écran de chaque téléphone est enregistré dans `captures/`.

## Ce qui est testé

| Fichier | Parcours |
| --- | --- |
| `installation` | Inscription, code de la tablette, réglages de départ, accueil |
| `proches` | Invitation par e-mail, code famille (accepté, refusé, faux), responsable, retrait d'un proche |
| `envois` | Photos (légende, 5 max, suppression, zip), vidéo, aperçu avant envoi (forme gardée, plein écran qui reste ouvert, Refilmer / Galerie, debout et couchée), filmer dans Papote (caméra, Filmer / Arrêter, retour, caméra refusée), messages (rapides, vu, réponse de Mamie), droits |
| `agenda` | Rappels (erreurs, modification, pause, confirmation de Mamie), anniversaires |
| `appels` | Vidéo vers la tablette (vraie liaison WebRTC), refus, Mamie appelle un proche ou toute la famille |
| `reglages` | Réglages de la tablette, profil, thème, quitter la famille, deux familles, déconnexion |
| `abonnement` | Annulation sous 30 jours, résiliation puis « garder », relier une commande, payer depuis l'app, pause |
| `horsligne` | Envois gardés sans réseau, partis au retour du réseau ou à la prochaine ouverture |
| `retour` | Bouton retour d'Android : chaque écran revient à celui d'avant, une fenêtre se ferme, « Voulez-vous quitter Papote ? » dans l'app Android |

Chaque test échoue aussi s'il y a une erreur dans la console, une fenêtre grise du navigateur
(confirm/alert) ou une erreur dans une fonction serveur.

## Comment ça marche

- **Fonctions serveur** : celles de la branche `main` (publiées), extraites dans `.fonctions/` par
  `preparer.js` et exécutées dans le même processus (`functions/parcours/simulation.js`) : Stripe et
  les e-mails sont simulés. `PAPOTE_FONCTIONS=<dossier functions>` pour en tester d'autres.
- **Règles** : `firestore.rules` et `storage-eu.rules` de ce dépôt, copiées dans `.regles/`.
- **SDK Firebase** : l'app le charge depuis gstatic ; le banc (`banc.js`) le sert depuis
  `node_modules/firebase` et le branche sur les émulateurs (App Check et notifications coupés).
- **Tablette** : simulée (`tablette.js`) avec le SDK admin et une vraie page WebRTC pour les appels.
- **Gestes** (`gestes.js`) : se connecter, installer, rejoindre une famille, répondre aux fenêtres…

Ports des émulateurs : Firestore 8087, Auth 9097, Storage 9197 (voir `firebase.json`).

Sur GitHub, `.github/workflows/app-famille.yml` lance ces tests à chaque changement de `web/`, des
règles ou des tests.
