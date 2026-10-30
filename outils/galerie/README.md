# Galerie des écrans

Une seule page avec **tous les écrans, dans tous leurs états** : la tablette (en paysage, elle est bloquée
ainsi), l'app famille (téléphone), le site vitrine et l'admin (ordinateur et téléphone), et tous les e-mails
envoyés par les fonctions (téléphone et ordinateur), chacun avec un numéro : « T12 » pour la tablette, « F7 »
pour l'app famille, « S3 » pour le site, « A5 » pour l'admin, « E9 » pour un e-mail. Pour donner un avis, il
suffit de citer le numéro.

Les écrans sont remplis avec une **fausse famille** (Mamie Jeanne, Julie, Thomas, Anne) et de
fausses photos. Rien ne touche Firebase ni les vraies familles :

- tablette : la page `tablette.html` est ouverte comme dans la WebView, avec une fausse app Android
  (`window.PapoteAndroid`) qui lui donne les envois, la météo, les rappels, le wifi, la batterie… ;
- app famille, admin et site : tous les modules Firebase sont remplacés par `faux-firebase.js`, une petite
  base en mémoire dans le navigateur (les fonctions du serveur, Stripe compris, y sont de fausses réponses) ;
  le reste d'internet est coupé (sauf les polices Google).

Ce qui ne se capture pas : l'écran de l'appareil photo du téléphone (après avoir filmé : revoir, annuler,
envoyer), le vrai plein écran du lecteur vidéo (imité), une vraie visio entre deux appareils, les pages Stripe,
la voix, l'iPhone.

## Clavier ouvert

Sur téléphone (app famille, site, admin), chaque écran qui a un champ à remplir est repris **clavier ouvert**
(`clavier.js`) : on touche chaque champ visible, puis la hauteur de l'écran est réduite de la place du clavier
(330 px en portrait, 210 en paysage), comme le fait Chrome Android avec `interactive-widget=resizes-content`
posé dans les pages. La capture « clavier ouvert » est mise à côté de l'écran, et la galerie signale en rouge :
un champ qui perd la main ou reste caché (sous la barre du bas, une barre « Payer »…), un bouton d'envoi
qu'on ne peut pas atteindre, une page qui devient plus large que l'écran. La tablette n'a aucun champ à remplir.
C'est une simulation : un vrai clavier Android ou iPhone reste à essayer sur le téléphone.

## Lancer

Sur le PC, double-cliquer `galerie.bat` (la première fois, il installe Playwright et son
navigateur, environ 150 Mo). La page `sortie/galerie.html` s'ouvre à la fin : c'est un seul
fichier, captures comprises, qu'on peut envoyer tel quel. `sortie/artifact.html` est la même page avec les
captures à côté (`sortie/images/`), pour la publier sur claude.ai.

```
galerie.bat               tout (environ 10 minutes)
galerie.bat tablette      seulement la tablette
galerie.bat famille       seulement l'app famille
galerie.bat vitrine       seulement le site vitrine (téléphone et ordinateur)
galerie.bat admin         seulement l'admin (ordinateur et téléphone)
galerie.bat emails        seulement les e-mails (téléphone et ordinateur)
```

Par défaut, la tablette vient de `origin/claude/project-thread-cmnwxy`, l'app famille et l'admin de
`origin/claude/project-thread-dlattc`, le site et les e-mails de `origin/main` (mises à jour avant). Pour une autre source :
`node galerie.js --tablette=<branche>` ou `--famille=ici` (les fichiers du disque).

## Ajouter un écran

Une scène = un titre, ses données et les gestes à faire avant la capture :

- tablette : tableau `SCENES` de `tablette.js` (`t.statut`, `t.famille`, `t.rappels`, `t.cliquer`,
  `t.appel('ringing')`, `t.avancer(ms)`…) ;
- app famille, site, admin : tableau `SCENES` de `famille.js`, `vitrine.js`, `admin.js` (`donnees` = la base de départ, `faire` = les
  touchers ; `plein: true` capture toute la page qui défile) ;
- e-mails : fonction `scenes()` de `emails.js` (`contenu` = l'e-mail fabriqué par `functions/mail.js` avec de fausses
  données). La galerie vérifie que rien ne déborde sur un téléphone, et que chaque somme en euros du HTML est aussi
  dans le texte brut.

Les numéros suivent l'ordre des scènes : ajouter une scène au milieu décale les suivants.

## Aucun bouton sans effet

`node galerie.js --boutons` (ou `--boutons famille`, `--boutons admin`) : au lieu des captures, touche une fois
chaque bouton différent de l'app famille et de l'admin, sur le premier écran où il apparaît, avec un serveur qui ne
répond jamais. Dans les 0,7 s, l'écran doit montrer quelque chose (roue, fenêtre, message, autre page, choix d'un
fichier…). Les boutons qui ne montrent rien sont listés dans `sortie/boutons.txt`. Le message de fin (réussite ou
erreur, une fois que le serveur répond) n'est pas vérifié ici : il se regarde dans la galerie.

## Espace Validation de l'admin

Chaque galerie range aussi ses captures dans `validation/` (une fiche par partie, captures nommées par leur empreinte).
`publier-validation.bat` refait la galerie puis met les captures en ligne sur le site Firebase **papote-validation**
(hébergement gratuit, créé tout seul la première fois) ; l'admin les montre dans **Validation › Écrans**, rangées par
parcours, avec « Validé » / « À revoir » et un commentaire par écran.

```
cd C:\Users\tangu\papote-deploiement
git fetch origin
git checkout --detach origin/main
cd outils\galerie
.\publier-validation.bat          tout (environ 10 minutes)
.\publier-validation.bat admin    seulement l'admin : les autres parties gardent leurs captures
```

Chaque écran a un identifiant stable (partie, parcours, titre) : le choix de Tanguy le suit même quand les numéros
changent. Si ses captures changent après validation, l'admin le signale (« A changé »). Renommer une scène = un écran
neuf, à revalider. Le site est public mais sans moteur de recherche (noindex) : il ne montre que de fausses données.
