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

# Versions déjà publiées
$feeds = Get-PublishedFeeds
$published = [int]($(if ($Test) { $feeds.test } else { $feeds.stable }).versionCode)
if ($code -le $published) {
    throw "La version $code est déjà publiée (en ligne : $published). Augmentez versionCode dans android/app/build.gradle.kts puis faites un commit."
}
if (git -C $root status --porcelain -- android) {
    Write-Host "Attention : des changements non enregistrés dans android/ ne seront pas publiés." -ForegroundColor Yellow
}

# Compilation à partir du code enregistré seulement
$work = Join-Path $env:TEMP 'papote-publication'
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Force $work | Out-Null
git -C $root archive -o "$work\src.zip" HEAD android
Expand-Archive "$work\src.zip" -DestinationPath $work
Copy-Item "$root\android\local.properties", "$root\android\signing.properties" "$work\android\"
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
Push-Location "$work\android"
try { & .\gradlew.bat assembleRelease -q; if ($LASTEXITCODE) { throw "Échec de la compilation" } } finally { Pop-Location }
$apk = "$work\android\app\build\outputs\apk\release\app-release.apk"

# L'APK est rangé dans le dépôt GitHub (le Firebase gratuit refuse les APK), adressé par son commit :
# installation/Papote.apk pour tout le monde, installation/Papote-test.apk pour les tablettes de test.
$file = if ($Test) { 'Papote-test.apk' } else { 'Papote.apk' }
Copy-Item $apk (Join-Path $root "installation\$file") -Force
$entry = Save-ApkOnGitHub $file "Publication de la version $name ($code)$(if ($Test) { ' pour les tablettes de test' })"
$entry.versionCode = $code
$entry.versionName = $name

# Fichiers de version : la version de test suit toujours au moins la version stable.
if ($Test) { $feeds.test = $entry } else { $feeds.stable = $entry; $feeds.test = $entry }
Publish-Feeds $feeds
Write-Host "Version $name ($code) publiée$(if ($Test) { ' pour les tablettes de test' } else { ' pour toutes les tablettes' })." -ForegroundColor Green
