# Génère les phrases du guide d'installation de la tablette en fichiers MP3 (voix naturelle Piper,
# hors ligne et gratuite), rangés dans android/app/src/main/assets/bienvenue/voix/.
# La tablette les joue sans dépendre du moteur de voix d'Android (pas prêt au démarrage, voix robotique).
#
#   python -m pip install piper-tts soundfile
#   python outils/voix/generer-voix-guide.py [--voix siwis]
#
# Voix siwis : jeu de données SIWIS, licence CC-BY 4.0 (citation dans le README de ce dossier).
# Le modèle (~60 Mo) est téléchargé une fois dans %TEMP%\piper-voix. Les textes doivent rester
# identiques à ceux de bienvenue.js (sayGuide) : la voix d'Android les dit si un fichier manque.
import argparse
import os
import subprocess
import sys
import tempfile
import urllib.request

import soundfile as sf

PHRASES = {
    'accueil': "Bonjour, et bienvenue sur Papote ! Appuyez sur Commencer.",
    'wifi-choisir': "Choisissez le wifi de votre box.",
    'wifi-ok': "La tablette est connectée à internet. Appuyez sur Continuer.",
    'wifi-mdp': "Tapez le mot de passe du wifi. Il est souvent écrit sous la box.",
    'code': "Dernière étape : avec votre téléphone, scannez le code affiché à l'écran.",
    'confirmer': "Quelqu'un veut relier cette tablette. C'est bien vous ?",
    'placer': "Asseyez-vous là où la personne s'installe d'habitude, puis tournez doucement la tablette.",
}

ap = argparse.ArgumentParser()
ap.add_argument('--voix', default='siwis', choices=['siwis', 'upmc', 'tom'])
args = ap.parse_args()

racine = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sortie = os.path.join(racine, 'android', 'app', 'src', 'main', 'assets', 'bienvenue', 'voix')
os.makedirs(sortie, exist_ok=True)

modeles = os.path.join(tempfile.gettempdir(), 'piper-voix')
os.makedirs(modeles, exist_ok=True)
nom = f'fr_FR-{args.voix}-medium'
modele = os.path.join(modeles, nom + '.onnx')
for ext in ('.onnx', '.onnx.json'):
    chemin = os.path.join(modeles, nom + ext)
    if not os.path.exists(chemin):
        url = f'https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/{args.voix}/medium/{nom}{ext}'
        print('Téléchargement de', url)
        urllib.request.urlretrieve(url, chemin)

piper = os.path.join(os.path.dirname(sys.executable), 'Scripts', 'piper.exe')
if not os.path.exists(piper):
    piper = 'piper'

for cle, texte in PHRASES.items():
    wav = os.path.join(modeles, cle + '.wav')
    # length_scale > 1 : un peu plus lent, plus facile à suivre pour une personne âgée.
    # PYTHONUTF8 : sous Windows, piper lit sinon le texte en cp1252 et prononce mal les accents.
    subprocess.run([piper, '-m', modele, '-f', wav, '--length-scale', '1.1', '--sentence-silence', '0.3'],
                   input=texte.encode('utf-8'), check=True, capture_output=True,
                   env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'})
    son, frequence = sf.read(wav)
    sf.write(os.path.join(sortie, cle + '.mp3'), son, frequence, format='MP3')
    os.remove(wav)
    print(f'{cle}.mp3 : {len(son) / frequence:.1f} s')
