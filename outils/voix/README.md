# Voix des phrases fixes

**Voix actuelle : Google « Kore »** (fr-FR-Chirp3-HD-Kore, choisie par Tanguy le 23/10), générée une
seule fois par `generer-voix-google.js` : guide d'installation (`assets/bienvenue/voix/`) et mots par
défaut des photos sans légende (`assets/voix/mots/`). Les messages écrits par la famille restent lus par
la voix d'Android (gratuite) : une voix Google à chaque message coûterait 0,30 à 0,80 € par famille et par mois.

Pour changer une phrase : la modifier dans le script **et** dans `bienvenue.js` / `tablette.js`, puis relancer.

## Ancienne voix (abandonnée)

# Voix du guide d'installation

`generer-voix-guide.py` crée les MP3 de `android/app/src/main/assets/bienvenue/voix/` avec
[Piper](https://github.com/rhasspy/piper) (hors ligne, gratuit).

Voix utilisée : **siwis** (fr_FR-siwis-medium), entraînée sur le jeu de données SIWIS
(University of Edinburgh, https://datashare.is.ed.ac.uk/handle/10283/2353), licence CC-BY 4.0 :
usage commercial permis en citant la source (mentions légales du site).

Pour changer une phrase : la modifier ici **et** dans `bienvenue.js` (sayGuide), puis relancer le script.
