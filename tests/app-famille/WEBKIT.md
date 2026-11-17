# L'app famille sous WebKit (Safari d'iPhone)

Toute la suite tourne deux fois en CI (`.github/workflows/app-famille.yml`, matrice `moteur`) :

- **chromium** : Chrome d'Android (390 × 844, agent Android), comme avant ;
- **webkit** : Safari d'iPhone, `PAPOTE_MOTEUR=webkit` et `PAPOTE_APPAREIL` (« iPhone 15 » par défaut) : taille de
  l'écran avec les barres de Safari (393 × 659), agent Safari d'iOS, doigt (touch), écran ×3. L'admin (largeur > 600)
  s'ouvre dans Safari sur Mac.

En local : `PAPOTE_MOTEUR=webkit npm test` (il faut `npx playwright install webkit`).

## Ce qui change sous WebKit, sans rien sauter

| Sous Chromium | Sous WebKit |
| --- | --- |
| Caméra et micro simulés (`--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`) | Caméra et micro simulés du WebKit de Playwright, permis par `context.grantPermissions(['camera', 'microphone'])` |
| Appui long, doigt posé puis levé ou glissé (CDP `Input.dispatchTouchEvent`) | Les événements qu'envoie Safari d'iPhone, dans son ordre (`pointerdown` puis `touchstart`, `pointerup`/`pointercancel`…) sur l'élément sous le doigt (`gestes.doigt`) |
| Liens `intent://` vus par CDP (`Page.frameRequestedNavigation`) | Vus par l'événement `navigate` de la page (Navigation API), adresse entière avec son `#Intent;…;end` (`gestes.espionnerNavigation`) |
| Clavier ouvert : 844 → 510 px | 659 → 399 px (ce qui reste de Safari au-dessus du clavier et de sa barre) |
| Téléphone tourné : 844 × 390 | 659 × 393 (la taille du téléphone, couchée) |
| Double appui | Le même, et en plus : l'écran ne doit jamais zoomer (`visualViewport.scale`), Safari zoomant au double appui |
| Réseau coupé : `context.setOffline` | Le même ; messages de WebKit tolérés comme ceux de Chromium (`Failed to load resource: WebKit encountered an internal error`, `Beacon API cannot load …TYPE=terminate`). Sauf `horsligne` (photos choisies sans réseau) : le `setOffline` du WebKit de Playwright coupe aussi les adresses `blob:` (la photo choisie ne s'ouvre plus), ce que Safari ne fait pas ; `gestes.reseau` y coupe chaque requête http(s) (« internet déconnecté »), avec `navigator.onLine` à `false` et les événements `offline` / `online` |
| Plein écran d'un élément (`requestFullscreen`) | Retiré sur iPhone, comme dans Safari d'iPhone (seule une vidéo a son plein écran, `webkitEnterFullscreen`) : l'app prend le chemin d'un iPhone |
| Invitations de l'accueil : glissement des tuiles jugé au pas d'une image (≤ 40 px) et au nombre d'images (≥ 3) | Jugé à la vitesse (pas ramené à 1/60 s, ≤ 40 px) et à la durée (≥ 150 ms) : le WebKit de Playwright sans écran laisse parfois 230 ms entre deux images pendant que la carte suivante se met en place |

La tablette filme en 640 × 480 (comme sa caméra) dans les deux moteurs.

Messages de Safari tolérés (et seulement sous WebKit, voir `banc.js`) :

- `Viewport argument key "interactive-widget" not recognized and ignored` : la balise viewport sert à Chrome
  d'Android ; Safari l'ignore et le dit.
- `Fetch API cannot load http://…/google.firestore.v1.Firestore/(Listen|Write)/channel?… due to access control checks`
  (erreur « non rattrapée ») : le SDK Firestore abandonne ses longues requêtes (fin d'écoute, changement de base, page
  qui part) et WebKit note chaque abandon vers une autre origine ainsi. Rien de visible pour le proche ; seulement ces
  deux canaux, mot pour mot.
- Nom d'un fichier téléchargé : le WebKit de Playwright remplace les espaces par « _ » (`Mamie_Emma.vcf`).

## Non couvert sous WebKit

Chaque saut est écrit dans le code par `banc.nonCouvert('webkit', '<raison>')` : sous WebKit, l'essai (ou la partie)
est sauté avec cette raison dans le compte rendu (`# SKIP` / `# NON COUVERT`), jamais en silence. L'essai
`scenarios/webkit-liste.test.js` vérifie que chaque raison est ici, mot pour mot.

### envois (5 essais sur 9)

- `Vidéo : préparée dans le téléphone, envoyée dans Storage, lue dans la visionneuse`
- `Vidéo debout : aperçu à sa forme, lecture, plein écran qui reste ouvert, Galerie, téléphone tourné`
- `Vidéo couchée : aperçu à sa forme, lecture, plein écran qui reste ouvert, Galerie, téléphone tourné`
- `Filmer dans Papote : caméra, Filmer / Arrêter, aperçu, Refilmer, retour d'Android, envoi sans préparation`
- `Filmer : caméra refusée, message clair et repli sur l'appareil photo du téléphone`

Raison : MediaRecorder absent du WebKit de Playwright (Linux), alors que Safari d'iPhone l'a depuis iOS 14.3 : la
vidéo préparée dans le téléphone et « Filmer dans Papote » ne peuvent pas y tourner comme sur un iPhone

(La préparation d'une vidéo réencode dans le navigateur avec MediaRecorder, et « Filmer » n'est proposé que s'il
existe : sans lui, l'app suivrait un chemin qu'aucun iPhone ne prend.)

### partage (5 essais sur 5)

- `Une photo partagée depuis WhatsApp avec un texte joint : « Envoyer » s'ouvre prêt, légende vide, un appui et elle part`
- `Trois photos partagées depuis la Galerie : un seul envoi de trois photos, double appui sur Envoyer compris`
- `Une vidéo partagée depuis l'appareil photo : la page Vidéos s'ouvre avec l'aperçu, et elle part`
- `Partage sans photo ni vidéo (un simple lien) : l'accueil s'ouvre normalement, aucune erreur`
- `Retour d'Android sur la fenêtre d'envoi ouverte par un partage : elle se ferme, rien ne part`

Raison : « Partager » vers Papote passe par l'app Android (cible de partage, puis le service worker) : Safari d'iPhone
n'a pas de cible de partage web et l'app Android n'existe pas sur iPhone

### sepa (une vérification ; le reste de l'essai tourne)

- `« Passer au prélèvement » : double appui et appui long, une seule page Stripe…` : que l'appui long ouvre la page.

Raison : appui long : le WebKit de Playwright n'a pas de vrai doigt (pas de CDP) ; le doigt simulé (pointer/touch)
n'engendre aucun clic, donc « au plus une page » est vérifié mais pas « la page s'ouvre »

## Défauts trouvés par WebKit et corrigés dans l'app

- **Double appui sur un bouton qui ouvre une fenêtre** (`web/js/ui.js`) : sur l'écran d'un iPhone 15 dans Safari
  (393 × 659), le 2e toucher d'un double appui sur « Résilier l'abonnement » tombait sur « Garder Papote » de la
  fenêtre « Avant de partir » à peine ouverte : elle se refermait aussitôt (rien ne semble s'ouvrir, « Merci de
  rester »). Ailleurs, ce 2e toucher pouvait tomber sur le fond gris ou sur un autre bouton, choisi sans avoir lu.
  Une fenêtre ouverte pendant un clic ignore maintenant tout toucher (fond, boutons, croix) arrivé moins de 500 ms
  après ce clic et à moins de 40 px. Le même défaut se voit dans Chromium à cette taille ; à 390 × 844, le 2e toucher
  tombait par chance sur le texte de la fenêtre.
