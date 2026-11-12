# Mises à jour des tablettes : publier, surveiller, revenir en arrière

Le canal de mise à jour, en bref :

- `https://papote-maj.web.app/version.json` (toutes les tablettes) et `version-test.json` (tablettes installées avec
  `-Canal test`) disent quelle version installer, avec l'adresse de l'APK et son empreinte (sha256).
- L'APK lui-même est rangé dans ce dépôt GitHub (`installation/Papote.apk`, `installation/Papote-test.apk`), à
  l'adresse d'un **commit précis**. Les tablettes le téléchargent sans compte : **le dépôt doit rester public**.
- Chaque APK publié porte une **étiquette git** (`tag`) : `tablette-v<version>-<numéro>` pour toutes les tablettes,
  `tablette-test-v<version>-<numéro>` pour les tablettes de test. Sans étiquette, un ménage de branches pourrait
  faire disparaître le commit, et les tablettes éteintes à ce moment-là ne pourraient plus se mettre à jour.

## Publier

| Script | Rôle |
|---|---|
| `publier-mise-a-jour.ps1 -Test` | compile le code enregistré et le publie pour les tablettes de test |
| `promouvoir-mise-a-jour.ps1` | passe la version de test à toutes les tablettes, sans recompiler |
| `publier-mise-a-jour.ps1` | compile et publie pour toutes les tablettes |
| `revenir-en-arriere.ps1` | republie une ancienne version (voir plus bas) |
| `verifier-canal-maj.ps1` | vérifie ce qui est en ligne (le même contrôle que GitHub fait chaque jour) |

Garde-fous de ces scripts (A37, audit du 11/11, RM7) :

1. **Rien ne part si les versions en ligne ne sont pas lues.** Chaque fichier de version est lu jusqu'à 3 fois ;
   s'il ne répond pas, est vide, n'est pas du JSON, ou a un champ faux (numéro, nom, adresse que la tablette
   refuserait, empreinte), le script s'arrête avec « Publication arrêtée, rien n'a été changé ». Avant, une
   lecture ratée donnait « version 0 » et la mise en ligne, qui remplace tout le site, **supprimait** `version.json`.
2. **Les deux fichiers sont toujours écrits complets.** Avant la mise en ligne, chacun est contrôlé ; un fichier
   incomplet arrête tout. Aucun des deux ne peut reculer (Android refuse une version plus ancienne : c'est le rôle
   du retour en arrière), et la version de test n'est jamais plus ancienne que celle de toutes les tablettes.
3. **Le numéro (versionCode) doit dépasser celui de toutes les versions étiquetées**, même jamais annoncées, et
   l'étiquette ne doit pas exister déjà.
4. **Étiquette** créée et envoyée sur GitHub avec chaque APK. Elle note le commit du code compilé
   (`source: …`), dont se sert le retour en arrière. Si son envoi échoue, la publication continue (la branche
   protège déjà le commit) mais le script affiche en rouge la commande à relancer.
5. **Vérification après publication** : les fichiers en ligne sont relus et doivent être ceux qui viennent d'être
   écrits ; chaque APK annoncé est téléchargé et son empreinte vérifiée. Sinon : « ATTENTION … » en rouge.

## Surveillance quotidienne (gratuite)

`.github/workflows/canal-maj.yml` (sur la branche `main`) lance `verifier-canal-maj.ps1` chaque matin. Il est rouge,
et GitHub t'envoie un e-mail « Run failed », si :

- un fichier de version ne répond pas ou a un contenu inattendu ;
- un APK annoncé ne se télécharge pas (dépôt passé en privé, commit effacé), a une taille anormale ou une
  empreinte différente ;
- un APK annoncé ne porte aucune étiquette `tablette-*` ;
- une version annoncée est plus ancienne que la dernière version étiquetée (fichier remplacé par erreur, ou
  publication interrompue entre l'étiquette et la mise en ligne).

Que faire : ouvrir l'exécution rouge (le message dit quoi), puis selon le cas republier, relancer
`git push origin refs/tags/<étiquette>`, ou revenir en arrière. GitHub coupe les tâches planifiées d'un dépôt
sans aucun envoi depuis 60 jours (il prévient par e-mail) : un envoi ou « Enable workflow » les relance.

## Revenir en arrière

Android **refuse d'installer un numéro plus petit** que celui de la tablette. Revenir en arrière, c'est donc
reprendre le code d'une version publiée qui marchait, lui donner un numéro **plus grand** que tout ce qui a été
publié, le compiler et le publier. `revenir-en-arriere.ps1` fait exactement cela :

```
git tag -l "tablette-*"                                     # versions publiées
powershell -ExecutionPolicy Bypass -File installation\revenir-en-arriere.ps1 -Depuis tablette-v2.99.64-171 -Essai
powershell -ExecutionPolicy Bypass -File installation\revenir-en-arriere.ps1 -Depuis tablette-v2.99.64-171 -Test
powershell -ExecutionPolicy Bypass -File installation\revenir-en-arriere.ps1 -Depuis tablette-v2.99.64-171
```

1. `-Essai` d'abord : lit les versions en ligne et les étiquettes, extrait le code de la version choisie, le
   renumérote, et affiche ce qui serait fait (nouvelle version `<ancienne>-retour`, nouveau numéro, étiquette).
   Rien n'est compilé, enregistré ni publié.
2. `-Test` : publie le retour pour la tablette de test (T-003). Attendre qu'elle l'installe et vérifier.
3. Sans option : publie le retour pour toutes les tablettes (et la tablette de test). Pas de question « 30 jours » :
   un retour en arrière est une urgence. Une confirmation O/N est demandée avant de compiler.

Garde-fous : l'étiquette doit être une étiquette de publication et exister ; la version choisie doit être plus
ancienne que celle en ligne pour ce canal ; le code repris doit porter le numéro de l'étiquette (sinon arrêt) ;
une étiquette ancienne sans ligne `source:` n'est acceptée que si son commit est une compilation
(« Publication de la version … », le code est alors celui du commit parent). Ensuite, mêmes garde-fous que
pour une publication (lectures, fichiers complets, vérification après publication).

Après un retour en arrière, la version suivante doit avoir un numéro plus grand que celui du retour : le script
de publication le rappelle de lui-même.

## Essais

`installation/tests/*.tests.ps1`, sans réseau, sans Firebase et sans Android SDK (lancés par
`.github/workflows/powershell.yml` sous PowerShell 7 et Windows PowerShell 5.1) :

```
pwsh installation/tests/canal-maj.tests.ps1
pwsh installation/tests/publication.tests.ps1
```
