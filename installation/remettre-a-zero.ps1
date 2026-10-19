# Remet une tablette Papote à l'état usine, pour la rendre au fournisseur.
# Utilisation : double-cliquer sur remettre-a-zero.bat (tablette branchée en USB, débogage USB activé).
#   -Serial XXXX pour choisir la tablette si plusieurs appareils sont branchés.
# La tablette quitte sa famille, puis Android efface tout (comme Paramètres > Réinitialiser) :
# photos, comptes, wifi, Papote. Elle redémarre sur l'écran de première configuration.
# Garde-fou : le n° de série est à retaper.
param(
    [string]$Serial
)

$ErrorActionPreference = 'Stop'
$Package = 'com.papote.tablette'
$Apk = Join-Path $PSScriptRoot 'Papote.apk'
# Première version de Papote qui sait se remettre à l'état usine.
$VersionMini = 67

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Fail($text) {
    Say "`n$text" 'Red'
    Read-Host "`nAppuyez sur Entrée pour fermer"
    exit 1
}

function Find-Adb {
    $cmd = Get-Command adb -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd -and $cmd.Path) { return $cmd.Path }
    $candidates = @(
        (Join-Path $PSScriptRoot 'platform-tools\adb.exe'),
        "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
        'C:\Android\Sdk\platform-tools\adb.exe',
        "$env:LOCALAPPDATA\Flutter\platform-tools\adb.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    return $null
}

function Adb {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = & $script:AdbExe @args 2>&1 | ForEach-Object { "$_" }
    $ErrorActionPreference = $old
    return ($out -join "`n").Trim()
}

Say "=== Remise à l'état usine d'une tablette Papote ===`n" 'Cyan'

$script:AdbExe = Find-Adb
if (-not $script:AdbExe) { Fail 'ADB est introuvable (voir installer-tablette.ps1).' }

# 1. Une seule tablette branchée et autorisée
Adb start-server | Out-Null
if ($Serial) { $env:ANDROID_SERIAL = $Serial }
$lines = (Adb devices) -split "`n" | Select-Object -Skip 1 | Where-Object { $_.Trim() }
if ($Serial) { $lines = @($lines | Where-Object { $_ -match "^$([regex]::Escape($Serial))\s" }) }
$ready = @($lines | Where-Object { $_ -match "`tdevice$" })
if ($ready.Count -eq 0) { Fail 'Aucune tablette prête : branchez-la en USB, avec le débogage USB autorisé.' }
if ($ready.Count -gt 1) { Fail 'Plusieurs appareils sont branchés. Ne laissez que la tablette à remettre à zéro (ou utilisez -Serial).' }

$serie = (Adb shell getprop ro.serialno).Trim()
$env:ANDROID_SERIAL = $serie
$model = Adb shell getprop ro.product.model
Say "Tablette branchée : $model, n° de série $serie" 'Green'

# 2. Papote doit être installé, propriétaire de l'appareil, et assez récent
if ((Adb shell pm list packages $Package) -notmatch [regex]::Escape($Package)) {
    Fail "Papote n'est pas sur cette tablette. Faites la remise à zéro à la main : Paramètres > Système > Réinitialiser."
}
$owner = Adb shell dumpsys device_policy
if ($owner -notmatch "Device Owner[\s\S]*?$([regex]::Escape($Package))") {
    Fail "Papote n'est pas en mode kiosque sur cette tablette : faites la remise à zéro à la main (Paramètres > Système > Réinitialiser)."
}
$code = 0
if ((Adb shell dumpsys package $Package) -match 'versionCode=(\d+)') { $code = [int]$Matches[1] }
if ($code -lt $VersionMini) {
    if (-not (Test-Path $Apk)) { Fail "Fichier introuvable : $Apk" }
    Say "Mise à jour de Papote (version $code) pour pouvoir remettre la tablette à zéro…"
    $res = Adb install -r $Apk
    if ($res -notmatch 'Success') { Fail "La mise à jour a échoué :`n$res" }
    Start-Sleep -Seconds 8
}

# 3. Confirmation : le n° de série à retaper
Say "`nATTENTION : tout sera effacé sur cette tablette (famille, photos, wifi, Papote)." 'Yellow'
Say 'Elle repartira comme sortie du carton. Cette opération ne peut pas être annulée.' 'Yellow'
$typed = (Read-Host "`nPour confirmer, tapez le n° de série de la tablette ($serie)").Trim()
if ($typed -ne $serie) { Fail 'N° de série différent : rien n''a été fait.' }

# Sa clé App Check est retirée (la tablette effacée ne doit plus pouvoir obtenir de jeton).
$outilCle = Join-Path $PSScriptRoot '..\outils\admin\cle-tablette.js'
if (Test-Path $outilCle) {
    try { & node $outilCle --retirer $serie 2>$null | Out-Null } catch { }
}

# 4. Papote quitte la famille puis demande à Android d'effacer la tablette.
#    Un code à usage unique est écrit dans les réglages d'Android (seul le câble peut le faire),
#    puis envoyé à Papote : il n'efface que si les deux sont identiques.
Say "`nRemise à l'état usine en cours…"
# Le droit d'effacer (« wipe-data ») n'est pris en compte qu'à l'activation du mode kiosque :
# on le désactive puis le réactive pour que la version installée l'obtienne.
Adb shell am start -n "$Package/.MainActivity" --ez remove_owner true | Out-Null
Start-Sleep -Seconds 4
$owner = Adb shell dpm set-device-owner "$Package/.AdminReceiver"
if ($owner -notmatch 'Success') { Say "Réactivation du mode kiosque : $owner" 'DarkGray' }
Start-Sleep -Seconds 2
$jeton = -join ((48..57) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
Adb logcat -c | Out-Null
Adb shell settings put global papote_usine $jeton | Out-Null
Adb shell am start -n "$Package/.MainActivity" --es usine $jeton | Out-Null
Start-Sleep -Seconds 15
$still = Adb get-state
if ($still -match 'device') {
    Adb shell settings delete global papote_usine | Out-Null
    $journal = (Adb logcat -d -s PapoteJournal) -split "`n" | Where-Object { $_ -match 'usine' }
    if ($journal) { Say "`nJournal de la tablette :" 'Yellow'; $journal | ForEach-Object { Say "  $_" 'Yellow' } }
    Say "`nLa tablette n'a pas redémarré. Faites-le à la main :" 'Yellow'
    Say 'Paramètres > Système > Réinitialiser > Effacer toutes les données.' 'Yellow'
} else {
    Say 'La tablette s''efface et redémarre. Vous pouvez la débrancher quand elle affiche l''écran de bienvenue d''Android.' 'Green'
}
Say "`n=== Terminé ===" 'Cyan'
Read-Host "`nAppuyez sur Entrée pour fermer"
