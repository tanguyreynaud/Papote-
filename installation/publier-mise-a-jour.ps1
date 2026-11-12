# Publie une nouvelle version de Papote : les tablettes l'installent d'elles-mêmes.
#
# 1. Augmenter versionCode (et versionName) dans android/app/build.gradle.kts.
# 2. Enregistrer les changements avec git (commit) : seul le code enregistré est publié.
# 3. Lancer : powershell -ExecutionPolicy Bypass -File installation\publier-mise-a-jour.ps1
#
# Mises à jour par étapes :
#   -Test       : seulement les tablettes de test (installées avec -Canal test)
#   (sans -Test) : toutes les tablettes
#   promouvoir-mise-a-jour.ps1 : passe la version de test à toutes les tablettes, sans recompiler.
#   revenir-en-arriere.ps1     : republie une ancienne version (voir LISEZMOI-MISES-A-JOUR.md).
#
# Les tablettes (en mode kiosque) vérifient toutes les 6 heures et s'installent la mise à jour
# toutes seules, sans rien demander.
param([switch]$Test)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'maj-commun.ps1')

# Version du code enregistré
$gradle = git -C $root show HEAD:android/app/build.gradle.kts | Out-String
$code = [int]([regex]::Match($gradle, 'versionCode = (\d+)').Groups[1].Value)
$name = [regex]::Match($gradle, 'versionName = "([^"]+)"').Groups[1].Value

# Pas deux versions pour toutes les tablettes en moins de 30 jours, sauf urgence (le canal test n'est pas concerné).
if (-not $Test) { Confirm-StableCadence }

# Versions déjà publiées : si un fichier de version ne peut pas être lu, tout s'arrête ici (A37).
$feeds = Get-PublishedFeeds
$published = [int]($(if ($Test) { $feeds.test } else { $feeds.stable }).versionCode)
if ($code -le $published) {
    throw "La version $code est déjà publiée (en ligne : $published). Augmentez versionCode dans android/app/build.gradle.kts puis faites un commit."
}
# Ni un numéro déjà étiqueté (même s'il n'a jamais été annoncé), ni une étiquette déjà prise.
$etiquettes = Get-EtiquettesDistantes
Assert-CodeLibre $code $etiquettes
$etiquette = Get-NomEtiquette $(if ($Test) { 'test' } else { 'stable' }) $name $code
Assert-EtiquetteLibre $etiquette $etiquettes
if (git -C $root status --porcelain -- android) {
    Write-Host "Attention : des changements non enregistrés dans android/ ne seront pas publiés." -ForegroundColor Yellow
}

# Compilation à partir du code enregistré seulement
$source = (git -C $root rev-parse HEAD).Trim()
$work = Join-Path ([System.IO.Path]::GetTempPath()) 'papote-publication'
New-SourceAndroid $source $work | Out-Null
$apk = Build-Apk $work

# L'APK est rangé dans le dépôt GitHub (le Firebase gratuit refuse les APK), adressé par son commit, qui porte
# une étiquette (tablette-v<version>-<numéro>) : installation/Papote.apk pour tout le monde,
# installation/Papote-test.apk pour les tablettes de test.
$file = if ($Test) { 'Papote-test.apk' } else { 'Papote.apk' }
Copy-Item $apk (Join-Path $root "installation\$file") -Force
$entry = Save-ApkOnGitHub $file "Publication de la version $name ($code)$(if ($Test) { ' pour les tablettes de test' })" $etiquette $source
$entry.versionCode = $code
$entry.versionName = $name

# Fichiers de version : la version de test suit toujours au moins la version stable.
$nouveaux = [pscustomobject]@{ stable = $feeds.stable; test = $feeds.test }
if ($Test) { $nouveaux.test = $entry } else { $nouveaux.stable = $entry; $nouveaux.test = $entry }
Publish-Feeds $nouveaux $feeds
Write-Host "Version $name ($code) publiée$(if ($Test) { ' pour les tablettes de test' } else { ' pour toutes les tablettes' })." -ForegroundColor Green
