# Installe Papote sur une tablette Android branchée en USB (débogage USB activé).
# Utilisation : double-cliquer sur installer-tablette.bat, ou
#   powershell -ExecutionPolicy Bypass -File installer-tablette.ps1 -Code ABCD-2345
#   (-Code : code tablette, créé dans l'app famille, Réglages > Installer une tablette)
#   (-Serial XXXX pour choisir la tablette si plusieurs appareils sont branchés, -Oui pour ne rien demander)
# Tablettes Android 9 et plus.
#   -Wifi "Nom du réseau" -MotDePasse "..." pour connecter la tablette au wifi au passage.
#   -Ville "Lyon" pour la ville de la météo (sinon le client la choisit sur l'écran Bienvenue).
#   Refuse une tablette hors critères (vrai Android 13+, puce 4G récente) ; -Essai pour un simple test.
param(
    [string]$Code,
    [string]$Serial,
    [string]$Wifi,
    [string]$MotDePasse,
    # Numéros prévenus par SMS si la tablette (avec carte SIM) perd internet, séparés par des virgules
    [string]$Numeros,
    # -Canal test : tablette de test, qui reçoit les nouvelles versions avant les autres
    [string]$Canal,
    # Ville de la météo ; la famille peut la changer ensuite depuis son appli
    [string]$Ville,
    # -Essai : installe quand même une tablette hors critères (tests seulement, jamais pour un client)
    [switch]$Essai,
    [switch]$Oui
)

$ErrorActionPreference = 'Stop'
$Package = 'com.papote.tablette'
$Apk = Join-Path $PSScriptRoot 'Papote.apk'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Fail($text) {
    Say "`n$text" 'Red'
    if (-not $Oui) { Read-Host "`nAppuyez sur Entrée pour fermer" }
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
if ($Serial) { $env:ANDROID_SERIAL = $Serial }
while ($true) {
    $lines = (Adb devices) -split "`n" | Select-Object -Skip 1 | Where-Object { $_.Trim() }
    if ($Serial) { $lines = @($lines | Where-Object { $_ -match "^$([regex]::Escape($Serial))\s" }) }
    $ready = @($lines | Where-Object { $_ -match "`tdevice$" })
    $unauthorized = @($lines | Where-Object { $_ -match 'unauthorized' })
    if ($ready.Count -eq 1) { break }
    if ($ready.Count -gt 1) { Fail 'Plusieurs appareils sont branchés. Ne laissez que la tablette à installer (ou utilisez -Serial).' }
    if ($unauthorized.Count) {
        Say "Sur la tablette, acceptez la fenêtre « Autoriser le débogage USB ? » (cochez « Toujours autoriser »)." 'Yellow'
    } else {
        Say 'En attente de la tablette : branchez-la en USB, avec le débogage USB activé.' 'Yellow'
    }
    Start-Sleep -Seconds 3
}

$model = Adb shell getprop ro.product.model
$android = Adb shell getprop ro.build.version.release
$sdk = [int](Adb shell getprop ro.build.version.sdk)
Say "Appareil détecté : $model (Android $android)" 'Green'
if ($sdk -lt 28) { Fail "Papote demande une tablette Android 9 ou plus récente (celle-ci : Android $android)." }

# Critères des tablettes vendues : vrai Android 13 ou plus (le niveau système ne se maquille pas,
# contrairement au numéro affiché) et une puce 4G récente. Hors critères : refusée, sauf -Essai.
$puce = (Adb shell getprop ro.board.platform).Trim().ToLower()
$niveaux = @{ 28 = '9'; 29 = '10'; 30 = '11'; 31 = '12'; 32 = '12L'; 33 = '13'; 34 = '14'; 35 = '15'; 36 = '16' }
$vrai = if ($niveaux.ContainsKey($sdk)) { $niveaux[$sdk] } else { "niveau $sdk" }
$refus = @()
if ($sdk -lt 33) { $refus += "Android trop ancien : affiche $android, en réalité Android $vrai (il faut 13 ou plus)." }
if ($puce -match 'sc7731|sc9832|sc7730|mt6580') { $refus += "Puce $puce : 3G seulement, pas de 4G." }
elseif ($puce -match 'sc9863|sp9863') { $refus += "Puce $puce : ancienne et lente pour la visio (prendre une Unisoc T606 ou plus récente)." }
if ($refus.Count) {
    foreach ($r in $refus) { Say $r 'Yellow' }
    if (-not $Essai) { Fail 'Tablette hors critères : installation refusée (ajoutez -Essai pour un simple test).' }
    Say 'Installation d''essai (-Essai) : cette tablette ne doit pas être envoyée à un client.' 'Yellow'
}
# Garde-fou : ne jamais installer le mode kiosque sur un téléphone branché par erreur.
if (-not $Oui) {
    $answer = Read-Host "Installer Papote sur cet appareil ? (O/N)"
    if ($answer -notmatch '^[oOyY]') { Fail 'Installation annulée.' }
}

# 2. Code tablette
# Sans code : la tablette affichera l'écran « Bienvenue » et le client la reliera lui-même
# (nom, wifi, puis QR code à scanner avec l'app famille).
if (-not $Code -and -not $Oui) {
    Say "`nCode tablette (app Papote : Réglages > Installer une tablette), ou Entrée pour laisser le client la relier lui-même."
    $Code = Read-Host 'Code tablette'
}
$Code = ($Code.ToUpper() -replace '[^A-Z0-9]', '')
if ($Code -and $Code.Length -ne 8) { Fail "Le code tablette doit contenir 8 caractères (reçu : « $Code »)." }

# 3. Installation de la dernière version publiée (-g : caméra et micro accordés d'office pour les appels).
#    Les fichiers APK du dossier peuvent dater : la version en ligne du canal est téléchargée et
#    vérifiée (empreinte). Sans internet, l'APK du dossier sert, avec un avertissement.
$feedName = if ($Canal -eq 'test') { 'version-test.json' } else { 'version.json' }
$feed = $null
try { $feed = Invoke-RestMethod -Uri "https://papote-maj.web.app/$feedName" -Headers @{ 'Cache-Control' = 'no-cache' } -TimeoutSec 20 } catch {}
$attendu = 0
if ($feed -and $feed.url -and $feed.sha256) {
    $telecharge = Join-Path $env:TEMP "Papote-$($feed.versionCode).apk"
    try {
        if (-not (Test-Path $telecharge) -or (Get-FileHash $telecharge -Algorithm SHA256).Hash.ToLower() -ne $feed.sha256) {
            Say "Téléchargement de la dernière version ($($feed.versionName))…"
            Invoke-WebRequest -UseBasicParsing $feed.url -OutFile $telecharge -TimeoutSec 300
        }
        if ((Get-FileHash $telecharge -Algorithm SHA256).Hash.ToLower() -ne $feed.sha256) { throw 'empreinte différente' }
        $Apk = $telecharge
        $attendu = [int]$feed.versionCode
    } catch {
        Say "Dernière version pas téléchargée ($($_.Exception.Message)) : APK du dossier utilisé." 'Yellow'
    }
} else {
    Say 'Pas d''internet : APK du dossier utilisé, peut-être pas le plus récent.' 'Yellow'
}
if ($Canal -eq 'test' -and -not $attendu) { $Apk = Join-Path $PSScriptRoot 'Papote-test.apk' }

function Installed-VersionCode {
    $m = [regex]::Match((Adb shell dumpsys package $Package), 'versionCode=(\d+)')
    if ($m.Success) { return [int]$m.Groups[1].Value } else { return 0 }
}
$avant = Installed-VersionCode
if ($attendu -and $avant -ge $attendu) {
    # Déjà à jour (ou plus récente) : Android refuserait de revenir en arrière, et rien n'est effacé.
    Say "App déjà installée en version à jour ($avant)." 'Green'
} else {
    Say "`nInstallation de l'app…"
    $res = Adb install -r -g $Apk
    if ($res -notmatch 'Success') { Fail "L'installation a échoué :`n$res" }
    if ($attendu -and (Installed-VersionCode) -ne $attendu) { Fail "Version installée inattendue ($(Installed-VersionCode) au lieu de $attendu)." }
    Say "App installée$(if ($attendu) { " (version $($feed.versionName))" })." 'Green'
}

# 4. Réglages : date et heure automatiques (indispensable pour les connexions sécurisées),
#    écran allumé tant que la tablette est branchée
Adb shell settings put global auto_time 1 | Out-Null
Adb shell settings put global auto_time_zone 1 | Out-Null
Adb shell settings put global stay_on_while_plugged_in 7 | Out-Null
# Barre de navigation du bas masquée pour de bon (réglage des tablettes UNISOC, sans effet ailleurs)
Adb shell settings put system show_navigationbar 0 | Out-Null
# Tablette en français, clavier AZERTY : Papote change la langue au démarrage grâce à ces droits
Adb shell pm grant $Package android.permission.CHANGE_CONFIGURATION | Out-Null
Adb shell appops set $Package WRITE_SETTINGS allow | Out-Null
# Wifi (facultatif)
if ($Wifi) {
    $res = if ($MotDePasse) { Adb shell cmd wifi connect-network "`"$Wifi`"" wpa2 "`"$MotDePasse`"" } else { Adb shell cmd wifi connect-network "`"$Wifi`"" open }
    Say "Wifi « $Wifi » : $res" 'DarkGray'
}

# 5. Mode kiosque (propriétaire de l'appareil) : la tablette reste sur Papote
#    et les mises à jour s'installent toutes seules.
# dpm list-owners : dumpsys device_policy cite le paquet ailleurs (« Device Owner Type: -1 » suivi
# d'une liste d'applis) et faisait croire au kiosque actif sur une tablette neuve.
$owner = Adb shell dpm list-owners
if ($owner -match "$([regex]::Escape($Package)).*DeviceOwner") {
    Say 'Mode kiosque déjà actif.' 'Green'
} else {
    $res = Adb shell dpm set-device-owner "$Package/.AdminReceiver"
    if ($res -match 'Success') {
        Say 'Mode kiosque activé : la tablette reste sur Papote.' 'Green'
    } else {
        Say "`nLe mode kiosque n'a pas pu être activé." 'Yellow'
        if ($res -match 'account') {
            Say ("Android l'exige sur une tablette sans compte (Google, Samsung…). " +
                 "Supprimez les comptes dans Paramètres > Comptes, ou réinitialisez la tablette " +
                 "sans ajouter de compte, puis relancez ce script.") 'Yellow'
        } else {
            Say $res 'DarkGray'
        }
        Say "En attendant, Papote devient l'écran d'accueil (sans mises à jour automatiques)." 'Yellow'
        Adb shell cmd package set-home-activity "$Package/.MainActivity" | Out-Null
    }
}

# Carte SIM : numéro ICCID noté pour la page « Forfaits SIM »
$sim = Adb shell content query --uri content://telephony/siminfo --projection icc_id:display_name
$iccids = @([regex]::Matches($sim, 'icc_id=(\d{10,22})') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique)
$simState = Adb shell getprop gsm.sim.state
if ($simState -match 'PIN_REQUIRED|PUK_REQUIRED|NETWORK_LOCKED') {
    # Le client ne connaît pas ce code : la tablette resterait bloquée sur la demande au démarrage.
    Say "`nATTENTION : la carte SIM demande un code PIN." 'Red'
    Say 'Avant l''envoi, retirez Papote (retirer-papote.bat), tapez le code PIN, puis désactivez-le :' 'Red'
    Say 'Paramètres > Sécurité > Verrouillage de la carte SIM. Relancez ensuite cette installation.' 'Red'
} elseif ($simState -match 'READY|LOADED' -and $iccids.Count) {
    Say "Carte SIM : ICCID $($iccids -join ', ')" 'Green'
    Say 'Si elle a demandé un code PIN au démarrage, désactivez-le avant l''envoi (Paramètres > Sécurité > Verrouillage de la carte SIM).' 'Yellow'
} else {
    Say 'Pas de carte SIM.' 'DarkGray'
}

# 6. Appels et SMS de la carte SIM refusés (Papote filtre les appels), applis inutiles désactivées
Adb shell cmd role add-role-holder android.app.role.CALL_SCREENING $Package | Out-Null
$useless = Get-Content (Join-Path $PSScriptRoot 'applis-inutiles.txt') | Where-Object { $_ -and $_ -notmatch '^#' }
foreach ($p in $useless) { Adb shell pm disable-user --user 0 $p.Trim() | Out-Null }
Say 'Appels de la carte SIM bloqués, applis inutiles désactivées.' 'Green'

# 7. Lancement relié à la famille
$pinArgs = @()
if ($Numeros) { $pinArgs += @('--es', 'numeros', ($Numeros -replace '[^0-9+,]', '')) }
if ($Canal) { $pinArgs += @('--es', 'canal', $(if ($Canal -eq 'test') { 'test' } else { 'stable' })) }
if ($Ville) { $pinArgs += @('--es', 'ville', "`"$($Ville.Trim())`"") }
if ($Code) {
    Adb shell am start -n "$Package/.MainActivity" --es code $Code @pinArgs --ez lock true | Out-Null
} else {
    Adb shell am start -n "$Package/.MainActivity" @pinArgs --ez lock true | Out-Null
    Say "`nLa tablette affiche « Bienvenue » : le client lui donnera un nom, choisira son wifi et la reliera à sa famille." 'Cyan'
}

# 8. Clé App Check de la tablette (preuve pour Firebase que c'est une vraie tablette Papote).
#    Créée par outils\admin\cle-tablette.js, envoyée à la tablette, jamais écrite dans un fichier ni affichée.
#    Sans l'outil ou sans la clé d'administration, la tablette marche quand même (rien n'est encore exigé).
$outilCle = Join-Path $PSScriptRoot '..\outils\admin\cle-tablette.js'
if (Test-Path $outilCle) {
    $serieCle = (Adb shell getprop ro.serialno).Trim()
    # Les messages de l'outil passent par stderr : avec 'Stop', PowerShell 5 les prendrait pour une erreur.
    $oldPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $ligne = (& node $outilCle --serie $serieCle 2>$null | Where-Object { $_ -match '^CLE=' } | Select-Object -First 1)
        if ($ligne -and $ligne -match '^CLE=([A-Za-z0-9_-]{20,100})$') {
            # Commande passée par l'entrée standard : certaines tablettes notent dans leur journal
            # système les commandes « adb shell … » reçues en arguments (la clé y apparaîtrait).
            "am start -n $Package/.MainActivity --es appCheckKey $($Matches[1])`nexit`n" | & $script:AdbExe shell 2>$null | Out-Null
            $Matches = $null
            Say 'Clé App Check posée sur la tablette.' 'Green'
        } else {
            Say 'Clé App Check : pas pu la créer (la tablette marche quand même).' 'Yellow'
        }
    } catch {
        Say "Clé App Check : pas pu la créer ($($_.Exception.Message))." 'Yellow'
    } finally {
        $ErrorActionPreference = $oldPref
    }
}

# 9. Stock : la tablette est notée comme préparée (n° de série), avec son numéro à écrire sur le carton.
#    Seulement sur le PC qui a la clé d'administration ; un échec n'empêche pas l'installation.
$cleAdmin = Join-Path $env:USERPROFILE '.papote\cle-admin-firebase.json'
if ($refus.Count) {
    Say "`nTablette d'essai : elle n'est pas notée dans le stock." 'DarkGray'
} elseif (Test-Path $cleAdmin) {
    $serie = (Adb shell getprop ro.serialno).Trim()
    $modele = (Adb shell getprop ro.product.model).Trim()
    $outil = Join-Path $PSScriptRoot '..\outils\gestion\preparer-tablette.js'
    try {
        $sortie = (& node $outil --serie $serie --modele $modele 2>&1 | ForEach-Object { "$_" }) -join "`n"
        if ($LASTEXITCODE) { Say "`nStock : la tablette n'a pas pu être notée ($sortie)" 'Yellow' }
        else {
            Say ''
            foreach ($ligne in ($sortie -split "`n")) {
                if ($ligne -match '>>>') { Write-Host " $ligne " -ForegroundColor Black -BackgroundColor Yellow } else { Say $ligne 'Green' }
            }
        }
    } catch {
        Say "`nStock : la tablette n'a pas pu être notée ($($_.Exception.Message))" 'Yellow'
    }
}

# 10. Contrôle final, comme chez le client : la tablette redémarre et doit revenir seule sur Papote,
#     verrouillée, en moins d'une minute. Sinon elle ne part pas (la Blackview Tab 60 Pro restait
#     1 à 2 min sur son bureau, et le kiosque passait pour actif alors qu'il ne l'était pas).
Say "`nContrôle final : redémarrage de la tablette…"
$problemes = @()
if ((Adb shell dpm list-owners) -notmatch "$([regex]::Escape($Package)).*DeviceOwner") { $problemes += 'mode kiosque absent' }
Adb reboot | Out-Null
Start-Sleep -Seconds 5
Adb wait-for-device | Out-Null
$debut = Get-Date
$limite = $debut.AddMinutes(4)
$ok = $false
while ((Get-Date) -lt $limite) {
    Start-Sleep -Seconds 2
    if ((Adb shell getprop sys.boot_completed) -ne '1') { $debut = Get-Date; continue }
    $etat = Adb shell dumpsys activity activities
    if ($etat -match "topResumedActivity=\S+ \S+ $([regex]::Escape($Package))/" -and $etat -match 'mLockTaskModeState=LOCKED') { $ok = $true; break }
    if (((Get-Date) - $debut).TotalSeconds -gt 60) { break }
}
if (-not $ok) { $problemes += 'Papote ne revient pas seule et verrouillée après un redémarrage' }
if ($problemes.Count) {
    Say "`n!!! NE PAS ENVOYER CETTE TABLETTE : $($problemes -join ' ; ')." 'Red'
    Say 'Lancez diagnostic.bat et prévenez Claude.' 'Red'
    if (-not $Oui) { Read-Host "`nAppuyez sur Entrée pour fermer" }
    exit 1
}
Say ("Redémarrage contrôlé : Papote revient seule, verrouillée, en {0:N0} s." -f ((Get-Date) - $debut).TotalSeconds) 'Green'

Say "`n=== Terminé ! La tablette affiche Papote. ===" 'Cyan'
Say 'Vous pouvez débrancher le câble USB (laissez la tablette sur son chargeur).'
if (-not $Oui) { Read-Host "`nAppuyez sur Entrée pour fermer" }
