# Papote

Une tablette Android très simple pour un proche âgé, toujours allumée sur son chargeur, et une app pour que
sa famille lui envoie photos, vidéos et messages, et l'appelle en vidéo. « Zéro clic pour Mamie » : la
tablette n'a rien à régler, tout se fait depuis le téléphone de la famille.

- **Tablette** (Android 13 ou plus, 4G, mode kiosque) : heure, date et météo en très grand, diaporama des
  photos, chaque envoi affiché et lu à voix haute, rappels et anniversaires, appels vidéo avec un gros bouton
  « Décrocher », SOS, nuit en bleu doux. Mises à jour installées toutes seules, groupées une fois par mois.
- **App famille** (iPhone et Android, dans le navigateur ou installée sur l'écran d'accueil) : envois, agenda,
  appels, réglages de la tablette, abonnement. Une app Android native existe aussi (`telephone/`).
- **Site** (`vitrine/`) : présentation, commande et paiement (Stripe), suivi du colis.
- **Admin** (dans l'app web) : commandes, stock de tablettes, SIM, alertes, retours.

## Trois branches de référence (les « troncs »)

| Tronc | Contient | Publié par |
|---|---|---|
| `main` | Fonctions serveur (`functions/`), site (`vitrine/`), outils (`outils/`) | Bouton **Publier** (GitHub Actions) |
| `claude/project-thread-dlattc` | App famille et admin (`web/`), règles Firestore et Storage, index | Hébergement et règles (PC), index |
| `claude/project-thread-cmnwxy` | App de la tablette (`android/`), scripts d'installation | APK construit sur le PC, mis à jour par les tablettes |

Chaque modification se prépare sur une branche de travail, passe la CI, puis est fusionnée dans son tronc.
Les copies de `web/` ou `android/` qui traîneraient sur `main` ne sont pas la référence.

**Ordre de publication** : index (si changés), puis fonctions et site (bouton Publier sur `main`), puis
hébergement et règles (depuis `dlattc`), puis tablette. Jamais `firebase deploy` sans `--only`.

## Tests automatiques (gratuits : dépôt public)

À chaque modification, GitHub Actions lance les tests du tronc touché :
- `main` : tests unitaires et parcours clients de bout en bout sur émulateurs Firebase ; balayages du site
  et des e-mails ; recherche de secrets ; et **les tests de l'app famille contre ces fonctions** (les troncs
  sont testés ensemble) ;
- `dlattc` : app famille dans un vrai navigateur (installation, envois, appels, réseau coupé, double appui…),
  balayages de chaque bouton de l'app et de l'admin, règles ;
- `cmnwxy` : scénarios et endurance de l'écran de la tablette, balayages ;
- scripts PowerShell : contrôle de syntaxe.

Rien n'est fusionné si la CI est rouge. Pas testé automatiquement : un vrai appel sur la tablette, la vraie 4G,
les SMS, Stripe réel, la réception des e-mails, l'APK installé.

## Organisation du code

| Dossier | Contenu |
|---|---|
| `functions/` | Fonctions Firebase : commandes, paiement, familles, appels, alertes, voix, tâches planifiées |
| `vitrine/` | Site public et page de commande |
| `web/` (dlattc) | App famille et admin, hébergées sur Firebase Hosting |
| `android/` (cmnwxy) | App de la tablette : écran en page locale, synchronisation en Java, mode kiosque |
| `telephone/` | App Android native de la famille |
| `installation/` (cmnwxy) | Installation des tablettes : voir `installation/LISEZMOI.md` |
| `outils/` | Scripts du PC (sauvegarde, stock, clés, galerie des écrans) : voir `outils/LISEZMOI.md` |

## Sécurité

Aucune clé ni aucun mot de passe dans le dépôt : ils sont rangés dans Secret Manager ou sur le PC
(`%USERPROFILE%\.papote\`). Accès admin par le badge `admin` du compte. Les tablettes prouvent leur identité
avec App Check.

## Coûts

Firebase (formule Blaze) : moins d'un euro par mois sans client, environ 0,40 $ par mois à 10 familles.
Météo MET Norway (gratuite). Les coûts sont surveillés en continu : tâches planifiées regroupées, lectures
limitées, vieilles versions de secrets détruites à chaque publication.
