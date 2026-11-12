# Passe la version en test à toutes les tablettes, sans recompiler.
# À lancer quand la version publiée avec « publier-mise-a-jour.ps1 -Test » a fait ses preuves
# sur les tablettes de test.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'maj-commun.ps1')

# Pas deux versions pour toutes les tablettes en moins de 30 jours, sauf urgence.
Confirm-StableCadence
$feeds = Get-PublishedFeeds
if ([int]$feeds.test.versionCode -le [int]$feeds.stable.versionCode) {
    Write-Host "Rien à faire : la version de test ($($feeds.test.versionName)) est déjà celle de toutes les tablettes." -ForegroundColor Yellow
    exit 0
}

$etiquettes = Get-EtiquettesDistantes
$etiquette = Get-NomEtiquette 'stable' $feeds.test.versionName $feeds.test.versionCode
Assert-EtiquetteLibre $etiquette $etiquettes
# Code compilé : celui noté dans l'étiquette de test de cette version (pour revenir-en-arriere.ps1).
$source = ''
$commitTest = Get-CommitDeUrl $feeds.test.url
$etiquetteTest = @($etiquettes | Where-Object { $_.commit -eq $commitTest -and $_.nom -like 'tablette-test-*' }) | Select-Object -First 1
if ($etiquetteTest) {
    $msg = (git -C $root for-each-ref --format='%(contents)' "refs/tags/$($etiquetteTest.nom)") -join "`n"
    $m = [regex]::Match($msg, '(?m)^source: ([0-9a-f]{40})\s*$')
    if ($m.Success) { $source = $m.Groups[1].Value }
}
if (-not $source -and $commitTest) { $source = ((git -C $root rev-parse "$commitTest^") -join '').Trim() }

# Même fichier APK, rangé aussi comme installation\Papote.apk pour les nouvelles installations.
Invoke-WebRequest -UseBasicParsing $feeds.test.url -OutFile (Join-Path $root 'installation\Papote.apk')
if ((Get-FileHash (Join-Path $root 'installation\Papote.apk') -Algorithm SHA256).Hash.ToLower() -ne $feeds.test.sha256) {
    throw "L'APK de test téléchargé ne correspond pas à son empreinte."
}
$entry = Save-ApkOnGitHub 'Papote.apk' "Version $($feeds.test.versionName) ($($feeds.test.versionCode)) pour toutes les tablettes" $etiquette $source
$entry.versionCode = $feeds.test.versionCode
$entry.versionName = $feeds.test.versionName
$nouveaux = [pscustomobject]@{ stable = $entry; test = $feeds.test }
Publish-Feeds $nouveaux $feeds
Write-Host "Version $($entry.versionName) ($($entry.versionCode)) publiée pour toutes les tablettes." -ForegroundColor Green
