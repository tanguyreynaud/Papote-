# Économie de données : sur la tablette, seul Papote (et ce dont il a besoin) utilise internet.
# Décidé avec Tanguy le 28/10 : mesuré au repos sur la SIM, la tablette consommait ~280 Mo par mois,
# dont la moitié par les services Google et le Play Store. Objectif : « ça doit venir que de Papote ».
#   1. Économiseur de données d'Android : aucune appli n'utilise le réseau en arrière-plan, sauf Papote.
#   2. Les applis inutiles (Google et Blackview) sont désactivées : elles ne se lancent plus et ne
#      téléchargent plus rien. Rien n'est désinstallé : -Annuler les remet toutes.
# Gardés (et autorisés en arrière-plan pour les services Google) : services Google et WebView (pages de Papote), voix Google (lecture), clavier (mot de passe
# du wifi), installation des mises à jour de Papote, alertes d'urgence, connexion au wifi d'un hôtel.
# Attention : sans Play Store, le WebView n'est plus mis à jour tout seul (à refaire par le script).
# Lancé par installer-tablette.ps1 ; seul : .\economie-donnees.ps1 [-Serial X] [-Annuler]
param(
    [string]$Serial,
    [switch]$Annuler
)

$ErrorActionPreference = 'Stop'
$Package = 'com.papote.tablette'
function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
if (-not $script:AdbExe) {
    $cmd = Get-Command adb -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $script:AdbExe = if ($cmd) { $cmd.Path } else { Join-Path $PSScriptRoot 'platform-tools\adb.exe' }
}
if ($Serial) { $env:ANDROID_SERIAL = $Serial }
function Adb {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = & $script:AdbExe @args 2>&1 | ForEach-Object { "$_" }
    $ErrorActionPreference = $old
    return ($out -join "`n").Trim()
}

# Applis désactivées (absentes sur une autre tablette : ignorées).
$Inutiles = @(
    'com.android.vending',                          # Play Store (mises à jour en arrière-plan)
    'com.google.android.youtube', 'com.google.android.apps.youtube.music',
    'com.google.android.keep', 'com.google.android.apps.translate', 'com.google.android.apps.fitness',
    'com.google.android.apps.adm',                  # Localiser mon appareil
    'com.google.android.apps.restore', 'com.google.android.apps.safetyhub', 'com.google.android.apps.turbo',
    'com.google.android.feedback', 'com.google.android.gms.location.history', 'com.google.ambient.streaming',
    'com.google.android.as', 'com.google.android.as.oss', 'com.google.android.federatedcompute',
    'com.google.android.ondevicepersonalization.services', 'com.google.android.odad',
    'com.google.android.partnersetup', 'com.google.android.printservice.recommendation',
    'com.google.android.apps.setupwizard.searchselector', 'com.google.android.dialer',
    'com.google.android.apps.carrier.carrierwifi', 'com.google.android.healthconnect.controller',
    'com.blackview.weather', 'com.blackview.filetrans', 'com.blackview.easytrans', 'com.blackview.appsedge',
    'com.blackview.userfeedback', 'com.blackview.apkupgrade'
)

$installes = (Adb shell pm list packages) -split "`n" | ForEach-Object { $_ -replace '^package:', '' }

if ($Annuler) {
    Say 'Économie de données : retour aux réglages d''Android…' 'Cyan'
    Adb shell cmd netpolicy set restrict-background false | Out-Null
    foreach ($p in $Inutiles) { if ($installes -contains $p) { Adb shell pm enable $p | Out-Null } }
    Say 'Applis remises et économiseur de données coupé.' 'Green'
    return
}

Say 'Économie de données : seul Papote utilise internet…' 'Cyan'
# 1. Économiseur de données, Papote autorisé en arrière-plan.
# Android 14 et plus écrivent « appId= », les plus anciens « userId= ».
$uid = [regex]::Match((Adb shell dumpsys package $Package), '(?:userId|appId)=(\d+)').Groups[1].Value
if (-not $uid) { Say 'Papote n''est pas installé : économie de données non réglée.' 'Red'; return }
Adb shell cmd netpolicy add restrict-background-whitelist $uid | Out-Null
# Services Google aussi (même uid pour gms et gsf) : App Check / Play Integrity et notifications push.
foreach ($g in 'com.google.android.gms', 'com.google.android.gsf') {
    $gu = [regex]::Match((Adb shell dumpsys package $g), '(?:userId|appId)=(\d+)').Groups[1].Value
    if ($gu) { Adb shell cmd netpolicy add restrict-background-whitelist $gu | Out-Null }
}
Adb shell cmd netpolicy set restrict-background true | Out-Null
# 2. Applis inutiles désactivées pour l'utilisateur (réversible, pas désinstallées).
$faites = 0
foreach ($p in $Inutiles) {
    if ($installes -notcontains $p) { continue }
    $r = Adb shell pm disable-user --user 0 $p
    if ($r -match 'new state: disabled') { $faites++ } else { Say "  $p : $r" 'Yellow' }
}
$ok = (Adb shell cmd netpolicy get restrict-background) -match 'enabled'
$liste = (Adb shell cmd netpolicy list restrict-background-whitelist) -match "\b$uid\b"
if ($ok -and $liste) { Say "Économie de données active ($faites applis inutiles désactivées)." 'Green' }
else { Say 'Économie de données : réglage non confirmé par Android.' 'Red' }
