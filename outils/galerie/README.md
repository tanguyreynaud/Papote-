# Galerie des écrans

Une seule page avec **tous les écrans** de la tablette (paysage et portrait) et de l'app famille
(téléphone), chacun avec un numéro : « T12 » pour la tablette, « F7 » pour l'app famille. Pour
donner un avis, il suffit de citer le numéro.

Les écrans sont remplis avec une **fausse famille** (Mamie Jeanne, Julie, Thomas, Anne) et de
fausses photos. Rien ne touche Firebase ni les vraies familles :

- tablette : la page `tablette.html` est ouverte comme dans la WebView, avec une fausse app Android
  (`window.PapoteAndroid`) qui lui donne les envois, la météo, les rappels, le wifi, la batterie… ;
- app famille : tous les modules Firebase sont remplacés par `faux-firebase.js`, une petite base en
  mémoire dans le navigateur ; le reste d'internet est coupé (sauf les polices Google).

## Lancer

Sur le PC, double-cliquer `galerie.bat` (la première fois, il installe Playwright et son
navigateur, environ 150 Mo). La page `sortie/galerie.html` s'ouvre à la fin : c'est un seul
fichier, captures comprises, qu'on peut envoyer tel quel.

```
galerie.bat               tablette + app famille (environ 2 minutes)
galerie.bat tablette      seulement la tablette
galerie.bat famille       seulement l'app famille
```

Par défaut, la tablette vient de `origin/claude/project-thread-cmnwxy` et l'app famille de
`origin/claude/project-thread-dlattc` (mises à jour avant). Pour une autre source :
`node galerie.js --tablette=<branche>` ou `--famille=ici` (les fichiers du disque).

## Ajouter un écran

Une scène = un titre, ses données et les gestes à faire avant la capture :

- tablette : tableau `SCENES` de `tablette.js` (`t.statut`, `t.famille`, `t.rappels`, `t.cliquer`,
  `t.appel('ringing')`, `t.avancer(ms)`…) ;
- app famille : tableau `SCENES` de `famille.js` (`donnees` = la base de départ, `faire` = les
  touchers ; `plein: true` capture toute la page qui défile).

Les numéros suivent l'ordre des scènes : ajouter une scène au milieu décale les suivants.
