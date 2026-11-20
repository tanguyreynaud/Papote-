# Tests de bout en bout de l'app famille

L'app famille (`web/`) est ouverte dans un vrai navigateur (Chromium sans écran, et WebKit en taille iPhone : voir
`WEBKIT.md`) et utilisée comme un proche le ferait : inscription, installation de la tablette, photos, messages, appels…
Tout tourne sur l'ordinateur, sur les émulateurs Firebase : rien n'est envoyé en ligne, rien n'est payant.

## Avant chaque push d'un fil

**`outils/verifier-avant-pousser.sh`** (depuis la racine du dépôt, en bash) : secrets (gitleaks, comme la CI
« Secrets »), balayage accessibilité de l'app famille et/ou de l'admin selon les fichiers de `web/` touchés (galerie
de main, comme `balayages.yml`), tests des règles si elles bougent, et les scénarios d'ici qui ont changé.
`--complet` lance en plus tous les scénarios (une dizaine de minutes). Code 1 au moindre échec : on ne pousse pas.

Un toast (petit message en bas, 2,5 s) s'attend avec `g.toast(t, 'texte')`, jamais avec
`locator('#toast').waitFor()` : chaque toast affiché est noté par la page (`banc.js`, `NOTER_TOASTS`), il ne peut
donc pas être raté entre deux regards de Playwright (voir l'audit `tests-instables-18-11.md`).

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
| `mise-en-route` | Audit du 12/11 : `?tablette=` sans aucun effet (seul Papote relie une tablette, A29) ; numéro de commande tapé dans « Rejoindre une famille » : refusé sans appel au serveur, une seule tentative au double appui (A53, qui retire l'entrée par le numéro de commande d'A40) ; le nom (jamais « Votre proche » en majuscule), puis « Réglons la tablette » seule fenêtre au démarrage, boutons fixes, « C'est prêt » seulement tablette arrivée (A43, V7, V8 du 17/11), « Rejoindre une famille » ; petit guide d'un proche aux boutons fixes ; e-mails des proches pour les responsables (A43) ; proche à l'étranger (M5) ; numéro de Mamie à enregistrer, jamais coupé en fin de ligne (M8, V13) |
| `natif` | Liens piégés : `?natif=` d'un autre, et `#connexion=` ignoré hors de l'app Android (L3) |
| `proches` | Invitation par e-mail, code famille (accepté, refusé, faux), responsable, retrait d'un proche |
| `plusieurs-proches` | Audit du 19/11 : trois envois et trois messages au même instant ; deux appels vers la tablette au même instant (un seul sonne, l'autre : « déjà en communication ») ; deux responsables qui nomment chacun un responsable ; refus confirmé après une acceptation (le proche reste) et l'inverse ; même adresse invitée deux fois (l'e-mail repart) ; photo supprimée pendant qu'un autre la regarde en grand ; adresse sans « .fr » refusée à la connexion et à l'invitation |
| `envois` | Photos (légende, 5 max, suppression, « Tout télécharger » : photos, vidéos et messages dans un .zip), vidéo, aperçu avant envoi (forme gardée, plein écran qui reste ouvert, Refilmer / Galerie, debout et couchée), filmer dans Papote (caméra, Filmer / Arrêter, retour, caméra refusée), messages (rapides, vu, réponse de Mamie), droits |
| `photos-multiples` | 5 photos en un envoi : transfert coupé à la 3e (réseau gardé, ou coupé net puis revenu), double appui sur Envoyer, ordre des photos, aucun fichier orphelin dans Storage ; limite des 200 derniers envois de photos |
| `partage` | « Partager » d'Android vers Papote (WhatsApp, Galerie, appareil photo) : une photo (le texte joint par l'appli d'origine n'est pas repris en légende), trois photos en un envoi (double appui sur Envoyer), une vidéo, un partage sans photo ni vidéo, retour d'Android sur la fenêtre ouverte ; le partage n'est proposé qu'une fois |
| `clavier-bas` | Clavier ouvert : la zone d'écriture touche le clavier (Messages depuis la barre du bas ou la tuile, légende d'une photo) ; clavier refermé par le retour d'Android, champ toujours actif : la barre du bas revient ; téléphone tourné : pas pris pour un clavier |
| `agenda` | Rappels (erreurs, modification, pause, confirmation de Mamie), anniversaires |
| `limites` | Limites du jour (A12) : le 50e message part, le suivant est refusé avec un mot calme à la place de la barre (texte gardé, rien en attente, double appui sur un message rapide), la barre revient après minuit ; rappels : 30 dans l'agenda (dit dès l'ouverture), 10 ajoutés par jour (double appui : un seul), modification toujours possible |
| `appels` | Vidéo vers la tablette (vraie liaison WebRTC), refus, Mamie appelle un proche ou toute la famille |
| `reglages` | Réglages de la tablette, profil, thème, volumes (changer une barre ne fait rien sonner ; double appui sur chaque « Écouter », appels compris : une seule demande, Tanguy 19/11), quitter la famille, deux familles, déconnexion ; nom de la tablette jamais un numéro de téléphone (message sous le champ) ; nuit : coucher de 19 h à 23 h 30, réveil de 5 h à 10 h, une nuit d'avant hors des bornes ramenée et renvoyée à la tablette (Tanguy, 17/11) |
| `alerte-pas-vue` | Réglages > La tablette, « Alerte si la tablette n'est pas utilisée » (Tanguy, 18/11) : 2 jours par défaut, 1 à 5 jours au choix (mêmes tailles), double appui sur Enregistrer = une écriture, gardé après actualisation, Annuler ne change rien, valeur hors bornes affichée ramenée ; un proche ne voit pas la carte et la base lui refuse l'écriture |
| `deconnexion` | « Se déconnecter » retire le jeton de l'app Android de ce téléphone ; double appui = une seule déconnexion ; Annuler ne retire rien ; hors ligne, la déconnexion se fait quand même |
| `changement-compte` | Se déconnecter puis entrer avec un autre compte (Tanguy, 17/11) : lien e-mail dans le même onglet, page rechargée, nouvel onglet ; Google (fenêtre et redirection, simulées par le banc) ; compte neuf : « Vos informations » vides, rien du compte d'avant (prénom, photo, numéro, anniversaire, famille) ; 2e compte invité avec le même numéro : message clair, puis photo et numéro changés tous deux enregistrés ; fiche qui a déjà une photo ; retour du premier compte sans rien redemander ; « Se déconnecter » efface du téléphone tout ce qui est propre au compte, la page et la copie locale de la base comprises (V1) |
| `notifs-reconnexion` | Badge de la cloche (Tanguy, 20/11) : notifications vues, déconnexion puis reconnexion du même compte, page rechargée, 2e téléphone du même compte : badge vide ; une seule écriture par ouverture, aucune s'il n'y a rien de nouveau ; un autre compte sur le même téléphone garde ses propres notifications non lues, rien hérité du premier |
| `mes-informations` | Chaque champ (prénom, genre, photo, numéro, anniversaire) écrit à l'inscription et dans Profil, relu dans la base et après actualisation ; photo retirée qui ne revient pas (V2) ; numéro collé avec espaces ou +33 gardé en entier (V4) ; prénom vide refusé avec un mot (V6) ; prénom vide ou sans lettre (« Vos informations » au premier lancement, par le code famille, par une invitation ; Profil ; anniversaire de l'agenda) : un mot juste sous le champ, parti dès qu'une lettre est tapée, rien d'envoyé, anniversaire renommé avec le prénom (V5), tablette prévenue (rev, V3) ; numéro ajouté dans l'app ou par l'admin : « La tablette peut appeler… », tuile « Appeler », « Enregistrez le numéro » et Profil suivent sans actualiser |
| `abonnement` | Annulation sous 30 jours, résiliation puis « garder », relier une commande, payer depuis l'app, pause |
| `horsligne` | Envois gardés sans réseau, partis au retour du réseau ou à la prochaine ouverture |
| `retour` | Bouton retour d'Android : chaque écran revient à celui d'avant, une fenêtre se ferme, « Voulez-vous quitter Papote ? » dans l'app Android |
| `resiliation` | Résilier (« Avant de partir », garder), « Garder mon abonnement », annuler la commande sous 30 jours, « Garder la tablette et reprendre » : double appui, appui long, retour d'Android, page rechargée (aussi pendant l'appel au serveur), petite hauteur ; sans réseau, serveur muet, serveur en panne (503) à chaque bouton : un seul appel au serveur, une roue pendant l'attente, un message clair |
| `resiliation-responsables` | Tout responsable gère l'abonnement, même s'il ne paie pas (Tanguy, 18/11) : rendu responsable (la question le dit), factures, portail Stripe, « Résilier l'abonnement » (double appui = une demande), arrêt vu après rechargement, « Garder mon abonnement » ; un simple proche voit l'état sans aucun bouton |
| `renvoi` | Renvoyer la tablette (Mondial Relay, QR code sans impression) : adresse demandée quand la commande n'en a pas (erreur de code postal, clavier ouvert), retour avant la date d'arrêt, réseau coupé, serveur muet puis page rechargée, un seul QR code ; tablette reçue et remboursée ; « main propre » jamais proposée |
| `mauvais-jours` | Abonnement arrêté : jamais « doit être réglé » ni « Régler » ; « Votre proche est décédé ? » : une question, un seul appel au serveur, des mots justes |
| `sos` | SOS de la tablette : toute la famille sonne, retour d'Android pendant la sonnerie, double appui sur « Répondre », sonnerie arrêtée chez les autres, téléphone sans réseau pendant la sonnerie, page rechargée, 2e essai sans réponse ; ce qu'en disent les Notifications |
| `sos-ordre` | Réglages, « Ordre d'appel SOS » (responsables seulement) : ordre par défaut (responsables d'abord, puis l'alphabet), flèches ↑/↓ de même taille, double appui = un seul déplacement, Enregistrer en double appui = une écriture (`sosOrdre` + `rev`), ordre relu après actualisation, proche arrivé après appelé en dernier, « Revenir à l'ordre par défaut » ; carte cachée pour un proche |
| `admin-journee` | L'admin (`admin.html`) avec les vraies fonctions : le matin (« Préparer l'envoi » avec l'étiquette, mauvais numéro T-… refusé, doubles appuis), l'après-midi (retour complet, rien prélevé, remise à zéro puis stock), l'envoi sur téléphone (390 px) |
| `admin-colis-en-route` | Famille préparée : colis parti, tablette pas entrée : « En route », liste « Envoyées, pas encore jumelées », « Colis revenu » dans le ⋮, ligne « À faire » après 20 jours (fonctions qui transmettent `tabletteRelieeLe`) |
| `admin-remplacement` | Code de tablette de remplacement (R2) : valable 7 jours et pour une seule tablette (échéance affichée), rouvert sans en créer un autre, « Nouveau code » en double clic = un seul code (l'ancien ne marche plus), code servi, code expiré |
| `admin-sim-bloquee` | Carte SIM bloquée par un code (tablette 2bfc17b) : « Carte SIM bloquée : code PIN demandé » / « code PUK demandé » / « verrouillée » sur la page de la tablette, même mise en forme que « hors service », parti tout seul une fois débloquée |
| `tel-unique` | Un numéro de portable par proche dans la famille (Tanguy, 13/11) : numéro d'un autre proche refusé à l'entrée dans la famille (« Vos informations » revient avec « Ce numéro est déjà celui de Julie dans la famille. », rien d'écrit) et dans Profil ; son propre numéro accepté ; celui de la tablette ne compte pas ; double appui sur Enregistrer = une écriture ; admin : ligne « Numéro en double dans la famille … » dans « À faire » (numéro masqué) et mot sur la page de la famille |
| `wifi` | Wi-Fi de la tablette depuis l'appli : mot de passe à part et effacé, vrai résultat ; le réseau actuel touché dit comment en changer (la tablette ne sait pas oublier un réseau sur ordre), double appui sans ordre |
| `touchers` | Audit du 17/11 : tout ce qui a l'air de se toucher réagit (lignes des membres, « Non lu », photos de profil, lignes de l'agenda, notifications, titre et valeur des réglages, « Écouter ») ; « Tout télécharger » caché sur une page Photos vide (V14) |
| `declaration` | Bulle d'aide, l'assistant passe la main (chantier 3 du chat, 18/11) : demande guidée au lieu de « laissez votre téléphone », réponses et 2 photos gardées après fermeture de la bulle, photos réduites (4000 → 1600 px) et dans l'ordre du choix, réseau coupé puis « Réessayer » en double appui, réponse perdue après l'enregistrement : une seule déclaration et un seul e-mail ; refus sans connexion ou pour une autre famille ; admin Clients > Déclarations : état de la tablette, photo qui s'ouvre, « Marquer traitée » en double clic = un appel (vitrine et fonctions de main, ou `PAPOTE_FONCTIONS`) |
| `chat-aller` | Boutons de l'assistant (bulle d'aide) : `window.papoteAller(nom)` ouvre le bon écran pour chaque nom du serveur (Réglages et sa carte, Inviter, Profil et Abonnement, Notifications, Photos, Messages, Agenda) depuis l'accueil, une page, un onglet ou la feuille Wi-Fi ; « retour » ramène à l'accueil ; double appui ou deux boutons coup sur coup : une seule entrée d'historique ; nom inconnu ignoré ; `false` pendant que la tablette sonne et avant la connexion ; carte réservée aux responsables : les Réglages quand même ; conversation reprise du site (`#chat=…`, la bulle rappelle chaque seconde) : `false` pendant le démarrage puis l'écran dès l'accueil prêt, fragment effacé sans gêner l'appli ; `false` sur une question ouverte |
| `debordement` | Textes longs (nom de la tablette, prénoms, e-mails, réseaux Wi-Fi, communes de la météo) : à la ligne, jamais coupés net ni hors de l'écran ; « Installer l'app » : une ligne de la page de la largeur des tuiles, ne cache rien et rien ne le cache tout en bas, à chaque pas du défilement, debout et couché (320 × 568 à 412 × 915), zoom et grands caractères à 130 %, avec et sans carte en haut, message du bas affiché (V9) |

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
règles ou des tests, dans Chromium (Chrome d'Android) et dans WebKit (Safari d'iPhone 15 et d'iPhone SE).
`PAPOTE_MOTEUR=webkit` choisit WebKit en local ; ce qui n'y est pas couvert, et pourquoi : `WEBKIT.md`.
