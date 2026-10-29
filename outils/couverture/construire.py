# Carte 4G Bouygues de l'ARCEP réduite en carreaux de 100 m, pour la vérification « éligible » de la commande
# (functions/couverture.js). À relancer chaque trimestre, quand l'ARCEP publie une nouvelle carte :
#
#   python -m venv venv && venv/bin/pip install py7zr pyogrio shapely rasterio numpy
#   venv/bin/python construire.py 2026_T2
#
# Télécharge https://data.arcep.fr/mobile/couvertures_theoriques/<trimestre>/Metropole/00_Metropole/
# <trimestre>_couv_Metropole_BOUY_4G_data.gpkg.7z (environ 300 Mo, licence ouverte), puis écrit dans
# functions/couverture/ :
#   bouygues-4g.bin.gz  un carreau sur 2 bits (0 rien, 1 CL limitée, 2 BC bonne, 3 TBC très bonne), ligne par
#                       ligne du nord au sud, d'ouest en est, en Lambert-93 (EPSG:2154) ;
#   bouygues-4g.json    l'origine, le pas, la taille de la grille et le trimestre.
# Un carreau prend le meilleur niveau dont la zone couvre son centre.
import gzip, json, os, sys, time, urllib.request
import numpy as np, py7zr, shapely
from pyogrio import raw
from rasterio import features
from rasterio.transform import from_origin

PAS = 100
# France métropolitaine en Lambert-93, arrondie au pas (la carte de l'ARCEP tient dedans).
X0, Y0, X1, Y1 = 99000, 6046000, 1243000, 7111000
NIVEAUX = (('CL', 1), ('BC', 2), ('TBC', 3))

trimestre = sys.argv[1] if len(sys.argv) > 1 else '2026_T2'
ici = os.path.dirname(os.path.abspath(__file__))
sortie = os.path.join(ici, '..', '..', 'functions', 'couverture')
nom = f'{trimestre}_couv_Metropole_BOUY_4G_data.gpkg'
archive = os.path.join(ici, nom + '.7z')
if not os.path.exists(archive):
    url = f'https://data.arcep.fr/mobile/couvertures_theoriques/{trimestre}/Metropole/00_Metropole/{nom}.7z'
    print('Téléchargement', url)
    urllib.request.urlretrieve(url, archive)
if not os.path.exists(os.path.join(ici, nom)):
    with py7zr.SevenZipFile(archive) as z:
        z.extractall(ici)

t0 = time.time()
meta, _, wkb, champs = raw.read(os.path.join(ici, nom), columns=['niveau'])
if meta['crs'] != 'EPSG:2154':
    sys.exit(f'Projection inattendue : {meta["crs"]}')
geometries = shapely.from_wkb(wkb)
niveaux = champs[0]
largeur, hauteur = (X1 - X0) // PAS, (Y1 - Y0) // PAS
transformation = from_origin(X0, Y1, PAS, PAS)
grille = np.zeros((hauteur, largeur), np.uint8)
for niveau, valeur in NIVEAUX:
    formes = [(g, valeur) for g, n in zip(geometries, niveaux) if n == niveau]
    if not formes:
        sys.exit(f'Aucune zone « {niveau} » : le format de l\'ARCEP a changé ?')
    np.maximum(grille, features.rasterize(formes, out_shape=(hauteur, largeur), transform=transformation,
                                          fill=0, dtype='uint8'), out=grille)
    print(f'{niveau} : {time.time() - t0:.0f} s')

# 4 carreaux par octet, le premier dans les deux bits de poids fort.
plat = grille.reshape(-1)
plat = np.concatenate([plat, np.zeros((-len(plat)) % 4, np.uint8)]).reshape(-1, 4)
octets = (plat[:, 0] << 6 | plat[:, 1] << 4 | plat[:, 2] << 2 | plat[:, 3]).astype(np.uint8)
os.makedirs(sortie, exist_ok=True)
with open(os.path.join(sortie, 'bouygues-4g.bin.gz'), 'wb') as f:
    f.write(gzip.compress(octets.tobytes(), 9, mtime=0))
with open(os.path.join(sortie, 'bouygues-4g.json'), 'w') as f:
    json.dump({'source': f'ARCEP, Mon réseau mobile, couverture théorique 4G Bouygues Telecom, {trimestre}',
               'trimestre': trimestre, 'epsg': 2154, 'x0': X0, 'y1': Y1, 'pas': PAS,
               'largeur': int(largeur), 'hauteur': int(hauteur)}, f, ensure_ascii=False, indent=2)
compte = {v: int((grille == v).sum()) for v in range(4)}
print('Carreaux par niveau (0 rien, 1 CL, 2 BC, 3 TBC) :', compte)
