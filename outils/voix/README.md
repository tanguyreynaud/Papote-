# Voix du guide d'installation

`generer-voix-guide.py` crée les MP3 de `android/app/src/main/assets/bienvenue/voix/` avec
[Piper](https://github.com/rhasspy/piper) (hors ligne, gratuit).

Voix utilisée : **siwis** (fr_FR-siwis-medium), entraînée sur le jeu de données SIWIS
(University of Edinburgh, https://datashare.is.ed.ac.uk/handle/10283/2353), licence CC-BY 4.0 :
usage commercial permis en citant la source (mentions légales du site).

Pour changer une phrase : la modifier ici **et** dans `bienvenue.js` (sayGuide), puis relancer le script.
