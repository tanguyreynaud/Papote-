# Vérifie une tablette Papote branchée en USB et dit ce qui ne va pas.
# Utilisation : double-cliquer sur diagnostic.bat (ou : diagnostic.ps1 -Serial XXXX)
param([string]$Serial)

$ErrorActionPreference = 'Continue'
$Package = 'com.papote.tablette'
$script:problems = 0

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Ok($text) { Say "  [OK]  $text" 'Green' }
function Bad($text, $fix) {
    $script:problems++
    Say "  [!!]  $text" 'Red'
    if ($fix) { Say "        -> $fix" 'Yellow' }
}

$adb = Get-Command adb -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$adbExe = if ($adb) { $adb.Path } else {
    @("$PSScriptRoot\platform-tools\adb.exe", "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
      'C:\Android\Sdk\platform-tools\adb.exe', "$env:LOCALAPPDATA\Flutter\platform-tools\adb.exe") |
        Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $adbExe) { Say "ADB introuvable (voir installer-tablette.ps1)." 'Red'; exit 1 }
if ($Serial) { $env:ANDROID_SERIAL = $Serial }
function Adb { ((& $adbExe @args 2>&1) | ForEach-Object { "$_" }) -join "`n" }

Say "=== Diagnostic de la tablette Papote ===`n" 'Cyan'
$devices = @((Adb devices) -split "`n" | Select-Object -Skip 1 | Where-Object { $_ -match "`tdevice$" })
if ($devices.Count -eq 0) { Say 'Aucune tablette branchée (ou débogage USB non autorisé).' 'Red'; exit 1 }
if ($devices.Count -gt 1 -and -not $Serial) { Say 'Plusieurs appareils branchés : utilisez -Serial.' 'Red'; exit 1 }

$model = (Adb shell getprop ro.product.model).Trim()
$android = (Adb shell getprop ro.build.version.release).Trim()
$sdk = [int](Adb shell getprop ro.build.version.sdk)
Say "Tablette : $model (Android $android, SDK $sdk)`n"

Say 'Appli' 'Cyan'
$pkg = Adb shell dumpsys package $Package
if ($pkg -notmatch 'versionName=([^\s]+)') { Bad 'Papote n''est pas installée.' 'Lancer installer-tablette.bat'; exit 1 }
$version = $Matches[1]
try { $online = (Invoke-RestMethod 'https://papote-maj.web.app/version.json' -TimeoutSec 10).versionName } catch { $online = '?' }
if ($version -eq $online) { Ok "Version $version (la dernière)" }
else { Bad "Version $version installée, $online publiée" 'Elle se met à jour toute seule dans les 6 heures (ou relancer installer-tablette.bat)' }
$top = Adb shell dumpsys activity activities
if ($top -match "ResumedActivity.*$Package") { Ok 'Papote est à l''écran' } else { Bad 'Papote n''est pas à l''écran' 'Redémarrer la tablette' }

Say "`nMode kiosque" 'Cyan'
$dp = Adb shell dumpsys device_policy
if ($dp -match "Device Owner[\s\S]*?$Package") { Ok 'Propriétaire de l''appareil (kiosque complet, mises à jour automatiques)' }
else { Bad 'Mode kiosque inactif' 'Supprimer les comptes de la tablette puis relancer installer-tablette.bat' }
if ($dp -match 'no_outgoing_calls') { Ok 'Appels sortants de la carte SIM bloqués' } else { Bad 'Blocage des appels sortants absent' 'Relancer installer-tablette.bat' }
$role = Adb shell dumpsys role
if ($role -match "CALL_SCREENING[\s\S]{0,200}holders=$Package") { Ok 'Appels de la carte SIM refusés (filtrage des appels)' }
else { Bad 'Filtrage des appels inactif' 'Relancer installer-tablette.bat' }

Say "`nRéglages" 'Cyan'
if ((Adb shell settings get global auto_time).Trim() -eq '1') { Ok 'Date et heure automatiques' } else { Bad 'Heure manuelle' 'Relancer installer-tablette.bat' }
if ((Adb shell settings get global stay_on_while_plugged_in).Trim() -eq '7') { Ok 'Écran toujours allumé sur le chargeur' } else { Bad 'L''écran peut s''éteindre sur le chargeur' 'Relancer installer-tablette.bat' }
$disabled = Adb shell pm list packages -d
$useless = Get-Content (Join-Path $PSScriptRoot 'applis-inutiles.txt') | Where-Object { $_ -and $_ -notmatch '^#' } | ForEach-Object { $_.Trim() }
$installed = Adb shell pm list packages
$active = @($useless | Where-Object { $installed -match "package:$([regex]::Escape($_))(\r?\n|$)" -and $disabled -notmatch "package:$([regex]::Escape($_))(\r?\n|$)" })
if ($active.Count -eq 0) { Ok 'Applis inutiles désactivées' } else { Bad "$($active.Count) applis inutiles encore actives" 'Relancer installer-tablette.bat' }

Say "`nRéseau" 'Cyan'
$wifi = Adb shell dumpsys wifi
if ($wifi -match 'mWifiInfo SSID: "?([^",]+)"?,') { Ok "Wifi : $($Matches[1])" } else { Say '  [ ? ]  Wifi : non connecté' 'Yellow' }
$ping = Adb shell ping -c 1 -W 3 8.8.8.8
if ($ping -match '1 received') { Ok 'Internet fonctionne' } else { Bad 'Pas d''internet' 'Vérifier la box, ou le bouton « régler le wifi » sur la tablette' }
if ((Adb shell getprop gsm.sim.state) -match 'READY|LOADED') { Ok 'Carte SIM présente' } else { Say '  [ - ]  Pas de carte SIM' 'DarkGray' }

Say "`nBatterie et stockage" 'Cyan'
$bat = Adb shell dumpsys battery
$level = if ($bat -match 'level: (\d+)') { [int]$Matches[1] } else { -1 }
$plugged = $bat -match 'AC powered: true|USB powered: true'
$temp = if ($bat -match 'temperature: (\d+)') { [int]$Matches[1] / 10 } else { 0 }
if ($plugged) { Ok "Sur le chargeur, batterie $level %" } elseif ($level -ge 30) { Bad "Pas sur le chargeur (batterie $level %)" 'La laisser branchée en permanence' } else { Bad "Batterie faible : $level %, pas sur le chargeur" 'Brancher le chargeur' }
if ($temp -gt 42) { Bad "Batterie chaude : $temp °C" 'Éloigner la tablette du soleil ou d''une source de chaleur' } elseif ($temp -gt 0) { Ok "Température batterie : $temp °C" }
$df = Adb shell df -h /data
if ($df -match '(\d+)%\s+/data') { $used = [int]$Matches[1]; if ($used -lt 90) { Ok "Stockage utilisé : $used %" } else { Bad "Stockage presque plein : $used %" 'Les vidéos anciennes peuvent être supprimées depuis l''appli famille' } }

Say "`nJournal récent de la tablette" 'Cyan'
$journal = Adb logcat -d -s PapoteJournal:I
($journal -split "`n" | Where-Object { $_ -match 'PapoteJournal' } | Select-Object -Last 15) | ForEach-Object { Say "  $_" 'DarkGray' }

Say ''
if ($script:problems -eq 0) { Say '=== Tout est en ordre. ===' 'Green' }
else { Say "=== $($script:problems) point(s) à corriger (voir ci-dessus). ===" 'Red' }
if (-not $Serial) { Read-Host "`nAppuyez sur Entrée pour fermer" }
