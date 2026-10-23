# Tests de la tablette avant envoi

Une tablette ne part chez un client que si **tout** est coché. 🤖 = vérifié par
`installer-tablette.ps1` (il s'arrête en rouge sinon) ; 👤 = à faire à la main.
Les autres listes (commandes, stock, app famille) viendront à côté de celle-ci.

## A. Matériel, sur chaque tablette (le fabricant peut en avoir raté une)

- 🤖 Android 13 ou plus en vrai, puce 4G récente (T606 ou mieux)
- 🤖 Redémarrage : Papote revient seule, verrouillée (couvre aussi la batterie vide)
- 👤 Appui long sur marche/arrêt : aucun menu, pas de barre du haut, pas de bureau du fabricant
- 👤 Gestes et boutons de navigation sans effet (accueil, récents, retour)
- 👤 Haut-parleur : voix du guide (🔊), sonnerie, radio, vidéo audibles à 2 m
- 👤 Micro : rien (mousse, coque, support) ne le couvre ; pendant l'appel test, le son coupe si on bouche son trou
- 👤 Appel vidéo de 5 min : pas d'écho chez le proche, Mamie entend bien
- 👤 Caméra : Mamie cadrée assise à 50 cm, réponse automatique quand elle est vue
- 👤 Écran tactile : toucher les quatre coins et le centre, tout répond
- 👤 Nouveau modèle seulement : noter ses particularités dans la mémoire du projet

## B. Chaque tablette, à l'installation (script)

- 🤖 Tablette autorisée en USB, une seule branchée
- 🤖 Dernière version publiée téléchargée, empreinte vérifiée, version installée contrôlée
- 🤖 Mode kiosque (propriétaire de l'appareil) réellement actif
- 🤖 Redémarrage : Papote revient seule et verrouillée en moins d'une minute
- 🤖 Carte SIM sans code PIN (sinon avertissement rouge)
- 🤖 Tablette notée au stock, numéro T-xxx affiché
- 👤 Écrire le numéro T-xxx sur le carton

## C. Chaque tablette, parcours client (avant mise en carton)

- 👤 Écran « Bienvenue » affiché, étape 1 sur 3
- 👤 Choisir un wifi, mot de passe faux puis bon
- 👤 Code et QR affichés ; scanner avec l'app famille : la tablette se relie
- 👤 Envoyer une photo, une vidéo, un message écrit depuis l'app famille : reçus, « vue » remontée
- 👤 « Écouter » lit le message à voix haute
- 👤 Appeler la tablette depuis l'app famille, puis appeler depuis la tablette
- 👤 SOS (si activé) : toute la famille sonne, « Annuler » marche
- 👤 Couper le wifi 2 min : carte « Pas d'internet », puis retour seul
- 👤 Débrancher le chargeur : la famille est prévenue
- 👤 Remettre sur « Bienvenue » (`--ez bienvenue true`) avant la mise en carton
- 👤 Chargée à plus de 80 %, câble et chargeur dans le carton

## D. Chaque nouvelle version, sur les tablettes de test avant tout le monde

- 👤 Publier avec `publier-mise-a-jour.ps1 -Test`, vérifier que T-002 et T-003 se mettent à jour seules
- 👤 Refaire A et C sur une tablette de test
- 👤 Seulement ensuite : `promouvoir-mise-a-jour.ps1`
