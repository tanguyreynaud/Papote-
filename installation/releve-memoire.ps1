# Relevé de la mémoire et de la tenue de Papote sur une tablette branchée en USB, après plusieurs jours sans
# redémarrage (inspection 5, 3/11) : la tablette doit tenir 3 jours chez Mamie sans ralentir ni planter.
# À lancer : jour 0 juste après l'allumage, puis chaque jour (ou au moins au jour 3). Chaque relevé est ajouté
# à releve-memoire.csv à côté de ce script ; le script compare au premier relevé et dit si la mémoire grimpe.
# Rien n'est modifié sur la tablette : lecture seule.
# Utilisation : double-cliquer sur releve-memoire.bat (ou : releve-memoire.ps1 -Serial XXXX)
param([string]$Serial)

$ErrorActionPreference = 'Continue'
$Package = 'com.papote.tablette'
$Csv = Join-Path $PSScriptRoot 'releve-memoire.csv'

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Ok($text) { Say "  [OK]  $text" 'Green' }
function Bad($text, $fix) { Say "  [!!]  $text" 'Red'; if ($fix) { Say "        -> $fix" 'Yellow' } }

$adb = Get-Command adb -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$adbExe = if ($adb) { $adb.Path } else {
    @("$PSScriptRoot\platform-tools\adb.exe", "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
      'C:\Android\Sdk\platform-tools\adb.exe', "$env:LOCALAPPDATA\Flutter\platform-tools\adb.exe") |
        Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $adbExe) { Say "ADB introuvable (voir installer-tablette.ps1)." 'Red'; exit 1 }
if ($Serial) { $env:ANDROID_SERIAL = $Serial }
function Adb { ((& $adbExe @args 2>&1) | ForEach-Object { "$_" }) -join "`n" }

Say "=== Relevé mémoire de la tablette Papote ===`n" 'Cyan'
$devices = @((Adb devices) -split "`n" | Select-Object -Skip 1 | Where-Object { $_ -match "`tdevice$" })
if ($devices.Count -eq 0) { Say 'Aucune tablette branchée (ou débogage USB non autorisé).' 'Red'; exit 1 }
if ($devices.Count -gt 1 -and -not $Serial) { Say 'Plusieurs appareils branchés : utilisez -Serial.' 'Red'; exit 1 }

# Depuis combien de temps la tablette tourne (sans redémarrage), et Papote (sans relance de son processus).
$uptimeS = [double]((Adb shell cat /proc/uptime) -split ' ')[0]
$tabletteH = [math]::Round($uptimeS / 3600, 1)
$pid = (Adb shell pidof $Package).Trim()
if (-not $pid) { Bad 'Papote ne tourne pas' 'Regarder l''écran de la tablette, relancer si besoin'; $papoteH = 0 }
else {
    $start = [double]((Adb shell cat /proc/$pid/stat) -split ' ')[21] / 100  # ticks depuis le démarrage
    $papoteH = [math]::Round(($uptimeS - $start) / 3600, 1)
}
$version = if ((Adb shell dumpsys package $Package) -match 'versionName=([^\s]+)') { $Matches[1] } else { '?' }
Say "Tablette allumée depuis $tabletteH h, Papote (version $version) tourne depuis $papoteH h."
if ($pid -and $papoteH -lt $tabletteH - 0.5) { Bad "Papote a été relancée depuis l'allumage (processus plus jeune que la tablette)" 'Lire le journal ci-dessous : plantage ? (le chien de garde la relance)' }

# Mémoire de Papote (dumpsys meminfo : TOTAL PSS en ko) et mémoire libre de la tablette.
$mem = Adb shell dumpsys meminfo $Package
$pss = if ($mem -match 'TOTAL PSS:\s+(\d+)') { [int]$Matches[1] } elseif ($mem -match 'TOTAL\s+(\d+)') { [int]$Matches[1] } else { 0 }
$pssMo = [math]::Round($pss / 1024)
$java = if ($mem -match 'Java Heap:\s+(\d+)') { [math]::Round([int]$Matches[1] / 1024) } else { 0 }
$natif = if ($mem -match 'Native Heap:\s+(\d+)') { [math]::Round([int]$Matches[1] / 1024) } else { 0 }
$vues = if ($mem -match 'Views:\s+(\d+)') { [int]$Matches[1] } else { 0 }
$activites = if ($mem -match 'Activities:\s+(\d+)') { [int]$Matches[1] } else { 0 }
$libre = if ((Adb shell cat /proc/meminfo) -match 'MemAvailable:\s+(\d+)') { [math]::Round([int]$Matches[1] / 1024) } else { 0 }
$stockage = if ((Adb shell df /data) -match '(\d+)%\s+/data') { [int]$Matches[1] } else { 0 }
Say "Mémoire de Papote : $pssMo Mo (Java $java Mo, natif $natif Mo, $vues vues, $activites activité(s)). Libre sur la tablette : $libre Mo. Stockage utilisé : $stockage %."
if ($activites -gt 1) { Bad "$activites activités en mémoire (il n'en faut qu'une)" 'Fuite d''écran : à signaler' }
if ($libre -lt 300) { Bad "Moins de 300 Mo libres" 'La tablette va manquer de mémoire : à signaler' }

# Plantages et erreurs depuis l'allumage (le logcat garde les dernières heures seulement : le journal Papote complète).
$crash = Adb logcat -d -b crash
$nbCrash = @(($crash -split "`n") | Where-Object { $_ -match "FATAL EXCEPTION|$Package" }).Count
$erreurs = @(((Adb logcat -d -s PapoteJournal:I) -split "`n") | Where-Object { $_ -match 'PapoteJournal' })
$nbErreurs = @($erreurs | Where-Object { $_ -match 'impossible|erreur|échec|plant|redémarr|relanc|Gardien' }).Count
if ($nbCrash -eq 0) { Ok 'Aucun plantage dans le journal système' } else { Bad "$nbCrash ligne(s) de plantage" 'Copier la sortie de « adb logcat -d -b crash » et la signaler' }
Say "Journal Papote : $($erreurs.Count) lignes récentes, $nbErreurs qui parlent d'un souci."
($erreurs | Select-Object -Last 8) | ForEach-Object { Say "  $_" 'DarkGray' }

# Relevé ajouté au fichier, comparé au premier relevé de la même série (même allumage de la tablette).
$ligne = [pscustomobject]@{
    date = (Get-Date -Format 'yyyy-MM-dd HH:mm'); version = $version; tabletteH = $tabletteH; papoteH = $papoteH
    papoteMo = $pssMo; javaMo = $java; natifMo = $natif; vues = $vues; activites = $activites; libreMo = $libre; stockagePct = $stockage; plantages = $nbCrash
}
$anciens = if (Test-Path $Csv) { @(Import-Csv $Csv) } else { @() }
$ligne | Export-Csv $Csv -Append -NoTypeInformation -Encoding UTF8
$serie = @($anciens | Where-Object { [double]$_.tabletteH -le $tabletteH -and [double]$_.tabletteH -gt $tabletteH - 24 * 10 })
Say ''
if ($serie.Count -gt 0) {
    $premier = $serie[0]
    $hausse = $pssMo - [int]$premier.papoteMo
    $dureeH = $tabletteH - [double]$premier.tabletteH
    Say "Depuis le relevé du $($premier.date) ($([math]::Round($dureeH, 1)) h plus tôt) : mémoire de Papote $($premier.papoteMo) -> $pssMo Mo ($(if ($hausse -ge 0) { '+' })$hausse Mo)." 'Cyan'
    if ($dureeH -ge 12 -and $hausse -gt 150) { Bad "La mémoire grimpe de plus de 150 Mo : fuite probable" 'Envoyer releve-memoire.csv et le journal au fil tablette' }
    elseif ($dureeH -ge 12) { Ok 'Mémoire stable (hausse sous 150 Mo)' }
    else { Say '  (comparaison significative à partir de 12 h d''écart)' 'DarkGray' }
    if ($tabletteH -ge 70 -and $papoteH -ge 70 -and $nbCrash -eq 0) { Ok '3 jours sans redémarrage ni plantage : tenue validée' }
} else { Say "Premier relevé de cette série enregistré dans $Csv : relancer demain, puis au jour 3." 'Cyan' }
if (-not $Serial) { Read-Host "`nAppuyez sur Entrée pour fermer" }
