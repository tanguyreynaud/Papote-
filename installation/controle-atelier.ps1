# Contrôle atelier : vérifie le matériel d'une tablette avant la mise en carton, sans famille ni commande.
# Lancé par installer-tablette.ps1 (ou seul : powershell -ExecutionPolicy Bypass -File controle-atelier.ps1 [-Serial X]).
# Son, prise jack, micro, caméra, écran tactile (questions O/N), puis wifi et kiosque en automatique.
# Code de sortie 0 si tout est bon, 1 sinon (« NE PAS ENVOYER »). Résumé dans $env:TEMP\controle-<série>.txt.
param(
    [string]$Serial,
    # Volume des essais de son (%), plus bas si quelqu'un dort à côté
    [int]$Volume = 70
)

$ErrorActionPreference = 'Stop'
$Package = 'com.papote.tablette'
$Activite = "$Package/.ControleActivity"
$Fichier = "/sdcard/Android/data/$Package/files/controle.txt"

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
function Etape($nom) { Adb shell am start -n $Activite --es etape $nom --ei volume $Volume | Out-Null }
# Attend la ligne « nom=… » écrite par la tablette, renvoie sa valeur (ou $null).
function Resultat($nom, $secondes) {
    $fin = (Get-Date).AddSeconds($secondes)
    while ((Get-Date) -lt $fin) {
        $m = [regex]::Match((Adb shell cat $Fichier), "(?m)^$nom=(.*)$")
        if ($m.Success) { return $m.Groups[1].Value.Trim() }
        Start-Sleep -Milliseconds 700
    }
    return $null
}
function Oui($question) {
    while ($true) {
        $r = Read-Host "$question (O/N)"
        if ($r -match '^[oOyY]') { return $true }
        if ($r -match '^[nN]') { return $false }
    }
}
function Casque { return (Adb shell dumpsys audio) -match 'Devices: [^\n]*(headset|headphone)\(' }

$bilan = [ordered]@{}
Say "`n=== Contrôle atelier ===" 'Cyan'
Adb shell rm -f $Fichier | Out-Null

# 1. Haut-parleur (casque débranché)
if (Casque) {
    Say 'Débranchez le casque ou les écouteurs de la tablette…' 'Yellow'
    $t = (Get-Date).AddSeconds(60)
    while ((Casque) -and (Get-Date) -lt $t) { Start-Sleep -Seconds 1 }
}
Say "`n1. Haut-parleur : la tablette dit « Bonjour, et bienvenue sur Papote »."
do {
    Etape son
    $null = Resultat 'son' 15
    Adb shell "sed -i '/^son=/d' $Fichier" | Out-Null
    $ok = Oui 'Entendu clairement par le haut-parleur, sans grésillement ?'
} while (-not $ok -and (Oui 'Réessayer ?'))
$bilan['Haut-parleur'] = $ok

# 2. Prise jack
Say "`n2. Prise jack : branchez un casque ou des écouteurs sur la tablette."
$t = (Get-Date).AddSeconds(90)
while (-not (Casque) -and (Get-Date) -lt $t) { Start-Sleep -Seconds 1 }
if (-not (Casque)) {
    Say 'Aucun casque détecté par la tablette.' 'Yellow'
    $bilan['Prise jack'] = $false
} else {
    Etape son
    $null = Resultat 'son' 15
    $bilan['Prise jack'] = Oui 'Le son passe dans le casque (et plus dans le haut-parleur) ?'
    Say 'Débranchez le casque.'
    $t = (Get-Date).AddSeconds(60)
    while ((Casque) -and (Get-Date) -lt $t) { Start-Sleep -Seconds 1 }
}

# 3. Micro : 4 s enregistrées puis réécoutées ; le niveau mesuré écarte un micro muet
Say "`n3. Micro : quand l'écran dit « Parlez maintenant », dites une phrase près de la tablette."
Read-Host 'Appuyez sur Entrée pour commencer' | Out-Null
Etape micro
$niveau = Resultat 'micro' 20
$crete = if ($niveau -match 'niveau (\d+)') { [int]$Matches[1] } else { 0 }
Start-Sleep -Seconds 5
Say "Niveau mesuré : $crete (au moins 1000 pour une voix normale)." 'DarkGray'
$bilan['Micro'] = ($crete -ge 1000) -and (Oui 'Votre phrase a été rejouée clairement ?')

# 4. Caméra de face
Say "`n4. Caméra : placez-vous devant la tablette."
Etape camera
$cam = Resultat 'camera' 15
if ($cam -ne 'avant') { Say "Caméra : $cam" 'Yellow' }
$bilan['Caméra'] = ($cam -eq 'avant') -and (Oui 'Vous vous voyez nettement à l''écran ?')

# 5. Écran tactile : les 9 cases doivent toutes répondre
Say "`n5. Écran tactile : touchez les 9 cases, elles deviennent vertes."
Etape ecran
$bilan['Écran tactile'] = (Resultat 'ecran' 120) -eq 'ok'
if (-not $bilan['Écran tactile']) { Say 'Toutes les cases n''ont pas répondu.' 'Yellow' }
Etape fin

# 6. Automatique : wifi avec internet, kiosque
$net = Adb shell dumpsys connectivity
$bilan['Wifi et internet'] = $net -match 'ni\{WIFI CONNECTED[^\n]*IS_VALIDATED'
$bilan['Mode kiosque'] = (Adb shell dpm list-owners) -match "$([regex]::Escape($Package)).*DeviceOwner"

Adb shell rm -f $Fichier | Out-Null
Say "`n--- Bilan du contrôle atelier ---" 'Cyan'
$lignes = @()
foreach ($k in $bilan.Keys) {
    $v = [bool]$bilan[$k]
    Say ("  {0} {1}" -f $(if ($v) { 'OK ' } else { 'KO ' }), $k) $(if ($v) { 'Green' } else { 'Red' })
    $lignes += "$k=$(if ($v) { 'ok' } else { 'ko' })"
}
$serie = (Adb shell getprop ro.serialno).Trim()
$lignes | Set-Content -Encoding utf8 (Join-Path $env:TEMP "controle-$serie.txt")
if ($bilan.Values -contains $false) {
    Say "`n!!! NE PAS ENVOYER CETTE TABLETTE : contrôle atelier échoué." 'Red'
    exit 1
}
Say "`nContrôle atelier réussi." 'Green'
exit 0
