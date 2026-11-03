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

## Les autres balayages

Même mécanique (serveur bloqué, premier écran où chaque bouton apparaît), un fichier `sortie/*.txt` chacun :

| Commande | Ce qui est vérifié | Rapport |
| --- | --- | --- |
| `--double [vitrine famille tablette admin]` | chaque bouton touché deux fois puis une 3e fois : rien ne part en double | `double-clic.txt` |
| `--appui [vitrine famille tablette admin]` | le doigt posé 1,2 s sur chaque bouton : une action au plus, rien de sélectionné, pas de menu du long appui (tablette) | `appui-long.txt` |
| `--gestes [famille vitrine]` | chaque écran en paysage, zoom 130 %, texte +30 %, mode sombre, noms très longs ; bouton retour ; retour après paiement | `gestes.txt` |
| `--identifiants [admin famille]` | chaque bouton qui agit sur une commande ou un abonnement envoie bien l'identifiant de la page ouverte | `identifiants.txt` |
| `--accessibilite [famille vitrine admin tablette]` | axe-core (WCAG A/AA) + texte trop petit, cible trop petite ; les défauts WCAG acceptés sont dans `acceptes.txt` | `accessibilite.txt` |
| `--courriels` | chaque e-mail de 320 à 1000 px sans police ni image ; simulé dans Gmail sans styles, Outlook bureau (Word, approché), mode sombre partiel et total, images bloquées ; relecture du code d'après caniemail ; poids, liens, texte brut, contraste | `courriels.txt`, captures dans `courriels.html` |

### E-mails : ce que `--courriels` simule, et ce qu'il ne voit pas

Sans vraie boîte ni envoi, chaque e-mail est transformé comme le ferait chaque boîte puis rendu dans Chromium :

- **Gmail sans styles** (applis Gmail, comptes non Google, transferts) : `<style>`, `<link>`, `<script>`, `class`, `id`,
  `position` et images de fond retirés ; 360 et 1000 px. Rien ne doit déborder, le bouton doit garder sa taille.
- **Outlook bureau (moteur Word), approché** : commentaires `[if mso]` appliqués, `@media`, `max-width`, `border-radius`,
  flex/grid, padding des liens et taille des `<div>` ignorés ; 1000 px. La carte doit rester à 640 px au plus.
- **Mode sombre** : inversion totale (Outlook.com, applis Outlook, Gmail iOS) et partielle (appli Gmail Android :
  fonds clairs et textes foncés seulement), clarté inversée dans l'espace Lab. Chaque texte garde un contraste ≥ 4,5.
- **Images bloquées** : chaque `<img>` a un `alt` (vide si décorative), `width` et `height` ; le texte reste lisible.
- **Relecture du code** (caniemail) : en erreur ce qui casse vraiment (flex/grid, `max-width` sans tableau fixe pour
  Outlook, bouton sans repli `mso-padding-alt`, image sans `alt` ou sans `width`, `position`, image de fond sans
  couleur) ; le reste en avertissement à la fin de `courriels.txt`.

Ne se voit que dans une vraie boîte : les bizarreries exactes de Word (interlignes, marges des paragraphes, polices
de repli, mise à l'échelle 120 dpi), les vrais algorithmes de mode sombre (chaque boîte a le sien, et ils changent),
Apple Mail et Yahoo, les filtres anti-spam et la délivrabilité (SPF, DKIM, DMARC, réputation), le rendu des polices
réelles. Pour cela : un envoi de test vers de vraies boîtes Gmail et Outlook, ou un service comme Litmus / Email on Acid.

**Chaque balayage, et la galerie elle-même (erreur de page, clavier ouvert, largeur), finit en erreur (code 1)
dès qu'un souci est trouvé.** C'est ce que GitHub Actions lance à chaque changement, sur la branche concernée :
`balayages.yml` sur main (site, e-mails) et sur la branche de l'app/admin (web/), `tablette.yml` sur la branche de
la tablette (android/ : scénarios de l'écran, APK de débogage, balayages). Les règles « seniors » de
l'accessibilité (texte-petit, cible-petite) sont signalées sans bloquer : Tanguy tranche écran par écran.
Rien ne se fusionne tant qu'un balayage est rouge.

## Espace Validation de l'admin

Chaque galerie range aussi ses captures dans `validation/` (une fiche par partie, captures nommées par leur empreinte).
`publier-validation.bat` refait la galerie puis met les captures en ligne, **visibles par l'admin seul** (3/11) :
les images dans le stockage Firebase (`validation/i/`, chacune avec un jeton secret, aucune règle ne les ouvre), la
liste et les jetons dans le document Firestore `validation/captures` (règle : admin seul). Il utilise la clé admin du
PC (`%USERPROFILE%\.papote\cle-admin-firebase.json`) et le firebase-admin de `outils/admin`. L'admin les montre dans
**Validation › Écrans**, rangées par parcours, avec « Validé » / « À revoir » et un commentaire par écran.

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
