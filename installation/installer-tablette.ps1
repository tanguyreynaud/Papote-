# Installe Papote sur une tablette Android branchée en USB (débogage USB activé).
# Utilisation : double-cliquer sur installer-tablette.bat, ou
#   powershell -ExecutionPolicy Bypass -File installer-tablette.ps1 -Code ABCD-2345
param(
    [string]$Code
)

$ErrorActionPreference = 'Stop'
$Package = 'com.papote.tablette'
$Apk = Join-Path $PSScriptRoot 'Papote.apk'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Fail($text) {
    Say "`n$text" 'Red'
    Read-Host "`nAppuyez sur Entrée pour fermer"
    exit 1
}

function Find-Adb {
    $cmd = Get-Command adb -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        (Join-Path $PSScriptRoot 'platform-tools\adb.exe'),
        "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
        'C:\Android\Sdk\platform-tools\adb.exe',
        "$env:LOCALAPPDATA\Flutter\platform-tools\adb.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    return $null
}

# Exécute adb et renvoie la sortie texte sans faire échouer le script.
function Adb {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = & $script:AdbExe @args 2>&1 | ForEach-Object { "$_" }
    $script:AdbExit = $LASTEXITCODE
    $ErrorActionPreference = $old
    return ($out -join "`n").Trim()
}

Say "=== Installation de Papote sur une tablette ===`n" 'Cyan'

if (-not (Test-Path $Apk)) { Fail "Fichier introuvable : $Apk" }
$script:AdbExe = Find-Adb
if (-not $script:AdbExe) {
    Fail ("ADB est introuvable. Téléchargez les « SDK Platform-Tools » sur developer.android.com, " +
          "puis copiez le dossier platform-tools à côté de ce script.")
}

# 1. Tablette branchée et autorisée
Adb start-server | Out-Null
while ($true) {
    $lines = (Adb devices) -split "`n" | Select-Object -Skip 1 | Where-Object { $_.Trim() }
    $ready = @($lines | Where-Object { $_ -match "`tdevice$" })
    $unauthorized = @($lines | Where-Object { $_ -match 'unauthorized' })
    if ($ready.Count -eq 1) { break }
    if ($ready.Count -gt 1) { Fail 'Plusieurs appareils sont branchés. Ne laissez que la tablette à installer.' }
    if ($unauthorized.Count) {
        Say "Sur la tablette, acceptez la fenêtre « Autoriser le débogage USB ? » (cochez « Toujours autoriser »)." 'Yellow'
    } else {
        Say 'En attente de la tablette : branchez-la en USB, avec le débogage USB activé.' 'Yellow'
    }
    Start-Sleep -Seconds 3
}

$model = Adb shell getprop ro.product.model
$android = Adb shell getprop ro.build.version.release
Say "Tablette détectée : $model (Android $android)" 'Green'

# 2. Code famille
if (-not $Code) {
    Say "`nLe code famille se trouve dans l'app Papote, menu Réglages (exemple : ABCD-2345)."
    $Code = Read-Host 'Code famille'
}
$Code = ($Code.ToUpper() -replace '[^A-Z0-9]', '')
if ($Code.Length -ne 8) { Fail "Le code famille doit contenir 8 caractères (reçu : « $Code »)." }

# 3. Installation de l'app
Say "`nInstallation de l'app…"
$res = Adb install -r -g $Apk
if ($res -notmatch 'Success') { Fail "L'installation a échoué :`n$res" }
Say 'App installée.' 'Green'

# 4. Réglages : date et heure automatiques (indispensable pour les connexions sécurisées),
#    écran allumé tant que la tablette est branchée
Adb shell settings put global auto_time 1 | Out-Null
Adb shell settings put global auto_time_zone 1 | Out-Null
Adb shell settings put global stay_on_while_plugged_in 7 | Out-Null

# 5. Mode kiosque (propriétaire de l'appareil, Android 5 et plus)
$sdk = [int](Adb shell getprop ro.build.version.sdk)
$homeChooser = $false
if ($sdk -lt 21) {
    Say "`nAndroid $android n'a pas de mode kiosque : Papote devient l'écran d'accueil." 'Yellow'
    $homeChooser = $true
} else {
    $owners = Adb shell dpm list-owners
    if ($owners -match $Package) {
        Say 'Mode kiosque déjà actif.' 'Green'
    } else {
        $res = Adb shell dpm set-device-owner "$Package/.AdminReceiver"
        if ($res -match 'Success') {
            Say 'Mode kiosque activé : la tablette reste sur Papote.' 'Green'
        } else {
            Say "`nLe mode kiosque complet n'a pas pu être activé." 'Yellow'
            if ($res -match 'account') {
                Say ("Android l'exige sur une tablette sans compte (Google, Samsung…). " +
                     "Pour l'avoir : supprimez les comptes dans Paramètres > Comptes, ou réinitialisez la tablette " +
                     "sans ajouter de compte, puis relancez ce script.") 'Yellow'
            } else {
                Say $res 'DarkGray'
            }
            Say "En attendant, Papote devient l'écran d'accueil de la tablette." 'Yellow'
            $res = Adb shell cmd package set-home-activity "$Package/.MainActivity"
            if ($res -notmatch 'Success') { $homeChooser = $true }
        }
    }
}

# 6. Lancement relié à la famille
Adb shell am start -n "$Package/.MainActivity" --es code $Code --ez lock true | Out-Null

if ($homeChooser) {
    Start-Sleep -Seconds 2
    Adb shell am start -a android.intent.action.MAIN -c android.intent.category.HOME | Out-Null
    Say "`nSur la tablette, choisissez « Papote » puis « Toujours »." 'Yellow'
    Say 'Le bouton Accueil ramènera ainsi toujours sur Papote.' 'Yellow'
}

Say "`n=== Terminé ! La tablette affiche Papote. ===" 'Cyan'
Say 'Vous pouvez débrancher le câble USB (laissez la tablette sur son chargeur).'
Read-Host "`nAppuyez sur Entrée pour fermer"
