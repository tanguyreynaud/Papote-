# Scripts et outils (PC)


Scripts `.bat` : double-cliquer dessus, ou les lancer depuis PowerShell dans le dossier du projet.
Outils `node` : depuis le dossier du projet, `node <chemin>`.

| Script | À quoi il sert | Commande |
| --- | --- | --- |
| **Vérifier avant de publier** | Lance tous les tests sur les versions exactes qui vont partir (fonctions de `main`, règles et app famille de dlattc, tablette de cmnwxy, galerie des écrans) et s'arrête net au premier échec ; affiche les SHA à publier | `.\outils\verifier.bat` (ou `fonctions`, `site`, `tablette`) |
| Installer une tablette | Installe Papote, le mode kiosque et les réglages ; note la tablette dans le stock | `.\installation\installer-tablette.bat` |
| Diagnostic | Vérifie une tablette branchée et dit ce qui ne va pas | `.\installation\diagnostic.bat` |
| Retirer Papote | Enlève Papote et le mode kiosque, réactive les applis (sans tout effacer) | `.\installation\retirer-papote.bat` |
| Remettre à l'état usine | Efface tout pour rendre la tablette au fournisseur (n° de série à retaper) | `.\installation\remettre-a-zero.bat` |
| Publier une mise à jour tablette | Compile et publie : les tablettes l'installent seules (`-Test` : tablettes de test d'abord) | `.\installation\publier-mise-a-jour.ps1` |
| Passer la version de test à tous | Donne la version de test à toutes les tablettes, sans recompiler | `.\installation\promouvoir-mise-a-jour.ps1` |
| Publier l'app famille | Vérifie puis met en ligne l'app famille : d'abord `test`, puis `en-ligne` | `node outils/web/publier.mjs test` (branche de l'app famille) |
| Vérifier l'app famille | Contrôle l'app famille avant sa mise en ligne | `node outils/web/verifier.mjs` (branche de l'app famille) |
| Publier le site vitrine | Met en ligne mapapote.fr : d'abord `test`, puis `en-ligne` | `node outils/vitrine/publier.mjs test` |
| Abonnements | Liste les familles et leur abonnement ; famille offerte | `node outils/admin/abonnements.js` |
| Sauvegarder | Copie la base et la liste des comptes dans `outils/admin/sauvegardes\` (les 4 dernières gardées) ; `--photos` pour copier aussi les fichiers | `.\outils\admin\sauvegarder.bat` |
| Sauvegarde automatique | Installe la sauvegarde chaque dimanche 3 h (tâche Windows, journal.txt dans le dossier, Google Drive conseillé) | `.\outils\admin\installer-sauvegarde-hebdo.bat "G:\Mon Drive\PapoteSauvegardes"` |
| Vérifier une sauvegarde | Restaure à blanc dans l'émulateur (Java requis) et contrôle chaque document ; une fois par mois | `.\outils\admin\verifier-sauvegarde.bat sauvegardes\papote-<date>.json` |
| Photo effacée | Les fichiers Storage sont gardés 7 jours par le bucket (suppression douce) : commandes gcloud | `outils/admin/RESTAURER-UN-FICHIER.md` |
| Restaurer la base | Réécrit une sauvegarde dans la base (`--oui` pour faire, `--effacer` pour remettre exactement, `--comptes` pour les comptes, `--photos` pour les photos et vidéos) | `.\outils\admin\restaurer.bat sauvegardes\papote-….json` |
| Badge administrateur | Donne ou retire l'accès admin à un compte Google | `node outils/admin/badge-admin.js` |
| Statistiques | Visites et commandes des 30 derniers jours | `node outils/admin/statistiques.js [jours]` |
| Nettoyer les comptes anonymes | Supprime les comptes anonymes qui ne sont dans aucune famille | `node outils/admin/nettoyer-comptes-anonymes.js` |
| Préparer une tablette (stock) | Note la tablette dans le stock et donne son numéro T-0xx (lancé par l'installation) | `node outils/gestion/preparer-tablette.js --serie <n°>` |
| Clés Stripe | Prépare le compte Stripe et range ses clés | `.\outils\stripe\installer-stripe.bat` |
| Mot de passe des e-mails | Range le mot de passe d'envoi des e-mails | `.\outils\mail\installer-mail.bat` |
| Mot de passe des factures | Range le mot de passe de la boîte mail des factures | `.\outils\gestion\installer-factures.bat` |
| Clés Sendcloud | Range les clés Sendcloud (étiquettes de colis) | `.\outils\gestion\installer-sendcloud.bat` |
| Clé du chat de support | Range la clé Anthropic du chat de support | `.\outils\support\installer-support.bat` |
| Tester le chat de support | Pose une série de questions au chat et affiche ses réponses | `node outils/support/tester-chat.js` |

Les clés et mots de passe sont lus dans le presse-papiers puis effacés : jamais affichés ni écrits dans le dépôt.
