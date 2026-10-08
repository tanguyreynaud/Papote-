# Passe la version en test à toutes les tablettes, sans recompiler.
# À lancer quand la version publiée avec « publier-mise-a-jour.ps1 -Test » a fait ses preuves
# sur les tablettes de test.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'maj-commun.ps1')

$feeds = Get-PublishedFeeds
if ([int]$feeds.test.versionCode -le [int]$feeds.stable.versionCode) {
    Write-Host "Rien à faire : la version de test ($($feeds.test.versionName)) est déjà celle de toutes les tablettes." -ForegroundColor Yellow
    exit 0
}

# Même fichier APK, rangé aussi comme installation\Papote.apk pour les nouvelles installations.
Invoke-WebRequest -UseBasicParsing $feeds.test.url -OutFile (Join-Path $root 'installation\Papote.apk')
if ((Get-FileHash (Join-Path $root 'installation\Papote.apk') -Algorithm SHA256).Hash.ToLower() -ne $feeds.test.sha256) {
    throw "L'APK de test téléchargé ne correspond pas à son empreinte."
}
$entry = Save-ApkOnGitHub 'Papote.apk' "Version $($feeds.test.versionName) ($($feeds.test.versionCode)) pour toutes les tablettes"
$entry.versionCode = $feeds.test.versionCode
$entry.versionName = $feeds.test.versionName
$feeds.stable = $entry
Publish-Feeds $feeds
Write-Host "Version $($entry.versionName) ($($entry.versionCode)) publiée pour toutes les tablettes." -ForegroundColor Green
