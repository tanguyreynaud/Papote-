# Parcours de Mamie : les trois branches ensemble

Ce dossier rejoue ce que vivent Mamie et sa famille, de la commande à l'appel du dimanche, avec **le vrai code des
trois branches en même temps** :

- l'app famille de cette branche (`web/`), dans un vrai navigateur ;
- les fonctions serveur de `main` (comme `tests/app-famille`) ;
- la tablette de sa branche (`claude/project-thread-cmnwxy`) : son code Java de synchronisation (`Sync.java` et
  ses voisines, **non modifié**) compilé pour tourner sur l'ordinateur, et ses écrans (`tablette.html`,
  `tablette.js`, `appels.js`) dans un vrai navigateur.

Tout tourne sur les émulateurs Firebase, avec les vraies règles. Rien en ligne, rien à payer.

## Lancer

    cd tests/parcours-mamie
    npm test

Il faut Node 22, Java 17 ou plus et Maven. La première fois, Maven télécharge Android (≈ 200 Mo, Maven Central).
Durée : environ 10 minutes. En CI : `.github/workflows/parcours-mamie.yml` (push sur cette branche, ou bouton
« Run workflow » avant une publication ou une mise à jour des tablettes).

- `PAPOTE_TABLETTE=<dossier du dépôt>` : essayer une tablette pas encore poussée (un correctif en cours).
- `PAPOTE_FONCTIONS=<dossier functions>` : pareil pour les fonctions.
- `PAPOTE_BAVARD=1` : le journal de l'appli de la tablette et chacune de ses demandes au réseau.

## Ce qui est joué

| Fichier | Ce que vit la famille |
| --- | --- |
| `arrivee.test.js` | Commande payée, tablette reliée dans Stock, colis, « Commencer » : la tablette entre seule dans sa famille (rien à scanner : seul Papote relie une tablette, le serveur la reconnaît à son n° de série) ; le proche entre, donne le nom, passe « Réglons la tablette » ; première photo, « Vu ». |
| `envois.test.js` | 3 photos d'un coup (« Suivante », double appui), message avec emojis, vidéo. |
| `appels.test.js` | Julie appelle (vraie vidéo dans les deux sens), Mamie appelle (internet, carte SIM), personne ne répond (45 s), coupure en plein appel ; carte « Julie a essayé de vous appeler à … » (A49) : gardée au redémarrage, partie quand Mamie décroche. |
| `hors-ligne.test.js` | Box coupée, « OK » touché sans réseau, tablette éteinte et rallumée sans réseau, rattrapage au retour. |
| `sos.test.js` | SOS par internet (annuler, double appui) et par la carte SIM (SMS puis appel) ; appuis répétés : pas de 2e SMS en 10 min, même tablette rallumée, l'appel repart (A47). |
| `nuit.test.js` | Veille : une photo du soir attend le matin, un appel sonne quand même. |

## Comment ça marche

- `tablette-jvm/` : un petit projet Maven. Il compile les sources Java de la tablette telles quelles, avec la
  bibliothèque d'Android pour la compilation seulement, et le peu d'Android dont `Sync` a besoin, réécrit à la
  main (`android-imite/` : journal, minuteries, horloge ; `stubs/` : notifications Firebase).
  `ReseauVersEmulateurs` sert chaque adresse `https://…googleapis.com` par l'émulateur correspondant ; tout le
  reste d'internet est coupé. `PontTablette` joue `MainActivity` : il fait le lien avec la page.
- `tablette-reelle.js` : ouvre les écrans de la tablette et branche leurs ponts (`PapoteAndroid.…`) sur ce code
  Java. Le reste d'Android (sonnerie, volume, carte SIM, wifi) est l'imitation des essais de la tablette
  (`android/tests/banc.js` de sa branche), reprise telle quelle.
- `commun.js` : les gestes partagés (`familleChezMamie()` refait tout le chemin du colis pour de vrai).

## Ce que ce banc ne voit pas

- La tablette elle-même : Android, `MainActivity`, le WebView, l'APK, le mode kiosque, la veille de l'écran, les
  sons, la carte SIM, la 4G, les vrais appels téléphone et SMS.
- Les notifications (réveil de la tablette par le serveur, sonnerie du téléphone app fermée), l'app Android du
  téléphone, l'iPhone.
- Le vrai Stripe, les vrais e-mails, la météo (coupée).
- Le temps long (72 h sans réseau, jeton expiré) : seulement une coupure de quelques minutes avec extinction.
- La liaison vidéo entre deux réseaux différents (relais TURN) : ici les deux navigateurs sont sur le même ordinateur.
