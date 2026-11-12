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
| `installation` | Inscription ; commande du site : famille préparée (invitation « Entrer dans ma famille », nom de la personne, tablette entrée seule) |
| `mise-en-route` | Audit du 12/11 : `?tablette=` sans aucun effet (seul Papote relie une tablette, A29) ; numéro de commande pour celui qui a payé avec une autre adresse (A40 : entrée directe et responsable, double appui, code inconnu, trop d'essais) ; le nom, puis « Réglons la tablette », puis le guide, et e-mails des proches pour les responsables (A43) ; proche à l'étranger (M5) ; numéro de Mamie à enregistrer (M8) |
| `natif` | Liens piégés : `?natif=` d'un autre, et `#connexion=` ignoré hors de l'app Android (L3) |
| `proches` | Invitation par e-mail, code famille (accepté, refusé, faux), responsable, retrait d'un proche |
| `envois` | Photos (légende, 5 max, suppression, « Tout télécharger » : photos, vidéos et messages dans un .zip), vidéo, aperçu avant envoi (forme gardée, plein écran qui reste ouvert, Refilmer / Galerie, debout et couchée), filmer dans Papote (caméra, Filmer / Arrêter, retour, caméra refusée), messages (rapides, vu, réponse de Mamie), droits |
| `photos-multiples` | 5 photos en un envoi : transfert coupé à la 3e (réseau gardé, ou coupé net puis revenu), double appui sur Envoyer, ordre des photos, aucun fichier orphelin dans Storage ; limite des 200 derniers envois de photos |
| `partage` | « Partager » d'Android vers Papote (WhatsApp, Galerie, appareil photo) : une photo (le texte joint par l'appli d'origine n'est pas repris en légende), trois photos en un envoi (double appui sur Envoyer), une vidéo, un partage sans photo ni vidéo, retour d'Android sur la fenêtre ouverte ; le partage n'est proposé qu'une fois |
| `clavier-bas` | Clavier ouvert : la zone d'écriture touche le clavier (Messages depuis la barre du bas ou la tuile, légende d'une photo) ; clavier refermé par le retour d'Android, champ toujours actif : la barre du bas revient ; téléphone tourné : pas pris pour un clavier |
| `agenda` | Rappels (erreurs, modification, pause, confirmation de Mamie), anniversaires |
| `appels` | Vidéo vers la tablette (vraie liaison WebRTC), refus, Mamie appelle un proche ou toute la famille |
| `reglages` | Réglages de la tablette, profil, thème, quitter la famille, deux familles, déconnexion |
| `abonnement` | Annulation sous 30 jours, résiliation puis « garder », relier une commande, payer depuis l'app, pause |
| `horsligne` | Envois gardés sans réseau, partis au retour du réseau ou à la prochaine ouverture |
| `retour` | Bouton retour d'Android : chaque écran revient à celui d'avant, une fenêtre se ferme, « Voulez-vous quitter Papote ? » dans l'app Android |
| `resiliation` | Résilier (« Avant de partir », garder), « Garder mon abonnement », annuler la commande sous 30 jours, « Garder la tablette et reprendre » : double appui, appui long, retour d'Android, page rechargée (aussi pendant l'appel au serveur), petite hauteur ; sans réseau, serveur muet, serveur en panne (503) à chaque bouton : un seul appel au serveur, une roue pendant l'attente, un message clair |
| `renvoi` | Renvoyer la tablette (Mondial Relay, QR code sans impression) : adresse demandée quand la commande n'en a pas (erreur de code postal, clavier ouvert), retour avant la date d'arrêt, réseau coupé, serveur muet puis page rechargée, un seul QR code ; tablette reçue et remboursée ; « main propre » jamais proposée |
| `mauvais-jours` | Abonnement arrêté : jamais « doit être réglé » ni « Régler » ; « Votre proche est décédé ? » : une question, un seul appel au serveur, des mots justes |
| `sos` | SOS de la tablette : toute la famille sonne, retour d'Android pendant la sonnerie, double appui sur « Répondre », sonnerie arrêtée chez les autres, téléphone sans réseau pendant la sonnerie, page rechargée, 2e essai sans réponse ; ce qu'en disent les Notifications |
| `admin-journee` | L'admin (`admin.html`) avec les vraies fonctions : le matin (« Préparer l'envoi » avec l'étiquette, mauvais numéro T-… refusé, doubles appuis), l'après-midi (retour complet, rien prélevé, remise à zéro puis stock), l'envoi sur téléphone (390 px) |
| `admin-colis-en-route` | Famille préparée : colis parti, tablette pas entrée : « En route », liste « Envoyées, pas encore jumelées », « Colis revenu » dans le ⋮, ligne « À faire » après 20 jours (fonctions qui transmettent `tabletteRelieeLe`) |

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
- **Gestes** (`gestes.js`) : se connecter, installer, rejoindre une famille, répondre aux fenêtres… et les gestes
  maladroits : double appui et appui long du doigt, clavier ouvert (petite hauteur), fonction serveur qui ne répond
  pas (`serveurMuet`), nombre d'appels au serveur (`nbAppels`), « main propre » jamais affichée (`jamaisMainPropre`).
- **Serveur en panne** : `banc.pannes.set('nomDeLaFonction', { status: 'UNAVAILABLE' })` fait répondre 503 à la fonction.

Ports des émulateurs : Firestore 8087, Auth 9097, Storage 9197 (voir `firebase.json`). Le banc lit les adresses posées par
`emulators:exec` (`FIRESTORE_EMULATOR_HOST`…) : une copie de `firebase.json` avec d'autres ports (`--config`) marche telle quelle.

Sur GitHub, `.github/workflows/app-famille.yml` lance ces tests à chaque changement de `web/`, des
règles ou des tests.
