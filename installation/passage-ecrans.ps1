# Passage de tous les écrans sur la vraie tablette branchée en USB : chaque écran de Papote (les mêmes
# que la galerie, numérotés T1, T2…) est ouvert avec une fausse famille « Mamie Jeanne », puis capturé.
# Résultat : une page ecrans-<série>\ecrans.html ouverte à la fin (vraies couleurs, vraie taille, vraies polices).
# Rien n'est envoyé : l'écran d'essai n'a pas de lien avec l'app ni internet (ControleActivity, étape galerie).
# Les vrais envois de la famille continuent d'arriver derrière ; la tablette revient sur Papote à la fin.
# Utilisation : double-cliquer passage-ecrans.bat, ou passage-ecrans.ps1 [-Serial X] [-Ecrans 14,15,40]
param(
    [string]$Serial,
    # Seulement ces numéros, séparés par des virgules : -Ecrans 14,15,40 (par défaut : tous, environ 10 minutes)
    [string]$Ecrans
)

$ErrorActionPreference = 'Continue'
$Package = 'com.papote.tablette'
$Activite = "$Package/.ControleActivity"
$Fichier = "/sdcard/Android/data/$Package/files/controle.txt"

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
$cmd = Get-Command adb -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$AdbExe = if ($cmd) { $cmd.Path } else {
    @("$PSScriptRoot\platform-tools\adb.exe", "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe", 'C:\Android\Sdk\platform-tools\adb.exe') |
        Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $AdbExe) { Say 'ADB introuvable (voir installer-tablette.ps1).' 'Red'; exit 1 }
if ($Serial) { $env:ANDROID_SERIAL = $Serial }
function Adb { ((& $AdbExe @args 2>&1) | ForEach-Object { "$_" }) -join "`n" }

$devices = @((Adb devices) -split "`n" | Select-Object -Skip 1 | Where-Object { $_ -match "`tdevice$" })
if ($devices.Count -eq 0) { Say 'Aucune tablette branchée (ou débogage USB non autorisé).' 'Red'; exit 1 }
if ($devices.Count -gt 1 -and -not $Serial) { Say 'Plusieurs appareils branchés : utilisez -Serial.' 'Red'; exit 1 }
$serie = (Adb shell getprop ro.serialno).Trim()
$version = if ((Adb shell dumpsys package $Package) -match 'versionName=([^\s]+)') { $Matches[1] } else { '?' }
# (dumpsys ne liste pas une activité sans filtre d'intention : on demande à Android de la trouver.)
if ((Adb shell cmd package resolve-activity --brief -n $Activite) -notmatch 'ControleActivity\s*$') { Say "Papote $version n'a pas encore l'écran d'essai : installez une version plus récente." 'Red'; exit 1 }

$sortie = Join-Path $PSScriptRoot "ecrans-$serie"
if (Test-Path $sortie) { Remove-Item -Recurse -Force $sortie }
New-Item -ItemType Directory -Path $sortie | Out-Null

# Ouvre l'écran n et attend « ecran=n/total<TAB>groupe<TAB>titre<TAB>erreurs » (ou « ecran=fin/total »).
function Ouvrir($n) {
    Adb shell rm -f $Fichier | Out-Null
    Adb shell am start -n $Activite --es etape galerie --ei n $n | Out-Null
    $fin = (Get-Date).AddSeconds(150)  # les écrans « pas d'internet » attendent 100 s pour de vrai
    while ((Get-Date) -lt $fin) {
        Start-Sleep -Milliseconds 700
        # Le fichier est écrit en UTF-8 : lu octet par octet puis décodé, sinon les accents sont perdus.
        $tmp = Join-Path $env:TEMP 'papote-controle.txt'
        Remove-Item -Force $tmp -ErrorAction SilentlyContinue
        Adb pull $Fichier $tmp | Out-Null
        if (-not (Test-Path $tmp)) { continue }
        $l = [IO.File]::ReadAllLines($tmp, [Text.Encoding]::UTF8) | Where-Object { $_ -like 'ecran=*' } | Select-Object -First 1
        if ($l) { return $l.Substring(6) }
    }
    return $null
}

Say "=== Passage des écrans sur la tablette $serie (Papote $version) ===`n" 'Cyan'
$premier = Ouvrir 1
if (-not $premier) { Say "La tablette ne répond pas (écran d'essai)." 'Red'; Adb shell am start -n $Activite --es etape fin | Out-Null; exit 1 }
$total = [int](($premier -split "`t")[0] -split '/')[1]
$liste = if ($Ecrans) { @($Ecrans -split '[^0-9]+' | Where-Object { $_ } | ForEach-Object { [int]$_ } | Where-Object { $_ -ge 1 -and $_ -le $total }) } else { 1..$total }

$ecransFaits = @()
foreach ($n in $liste) {
    $ligne = if ($n -eq 1 -and $premier) { $premier } else { Ouvrir $n }
    if (-not $ligne) { Say "  T$n : pas de réponse" 'Red'; $ecransFaits += [pscustomobject]@{ N = $n; Groupe = '?'; Titre = 'pas de réponse'; Erreurs = 'pas de réponse'; Image = '' }; continue }
    $p = $ligne -split "`t"
    $image = "T$n.png"
    Adb shell screencap -p /sdcard/papote-ecran.png | Out-Null
    Adb pull /sdcard/papote-ecran.png (Join-Path $sortie $image) | Out-Null
    $erreurs = if ($p.Count -gt 3) { $p[3].Trim() } else { '' }
    $ecransFaits += [pscustomobject]@{ N = $n; Groupe = $p[1]; Titre = $p[2]; Erreurs = $erreurs; Image = $image }
    Say ("  T{0} {1}{2}" -f $n, $p[2], $(if ($erreurs) { "  !! $erreurs" })) $(if ($erreurs) { 'Yellow' } else { 'Gray' })
}
Adb shell rm -f /sdcard/papote-ecran.png $Fichier | Out-Null
Adb shell am start -n $Activite --es etape fin | Out-Null

# Une page avec toutes les captures, rangées par groupe comme la galerie.
function Html($t) { [Net.WebUtility]::HtmlEncode([string]$t) }
$corps = ''
$groupe = $null
foreach ($e in $ecransFaits) {
    if ($e.Groupe -ne $groupe) { $groupe = $e.Groupe; $corps += "<h2>$(Html $groupe)</h2>`n" }
    $err = if ($e.Erreurs) { "<p class=err>$(Html $e.Erreurs)</p>" } else { '' }
    $img = if ($e.Image) { "<a href=""$($e.Image)""><img src=""$($e.Image)"" loading=lazy alt=""""></a>" } else { '' }
    $corps += "<figure><figcaption><b>T$($e.N)</b> $(Html $e.Titre)</figcaption>$img$err</figure>`n"
}
$nbErr = @($ecransFaits | Where-Object { $_.Erreurs }).Count
$page = @"
<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Écrans de la tablette $serie</title>
<style>body{margin:0;padding:16px;background:#fdfaf5;color:#24212f;font:16px/1.4 sans-serif}h1{font-size:22px}h2{font-size:18px;margin:28px 0 8px;color:#4f46e5}
figure{display:inline-block;vertical-align:top;margin:0 12px 16px 0;width:min(560px,100%)}img{width:100%;border:1px solid #ddd8cc;border-radius:4px}
figcaption{margin-bottom:4px}.err{color:#b42318;margin:4px 0 0}</style></head><body>
<h1>Écrans de la tablette $serie (Papote $version), $(Get-Date -Format 'dd/MM/yyyy HH:mm')</h1>
<p>Fausse famille « Mamie Jeanne », rien n'a été envoyé. $($ecransFaits.Count) écrans, $nbErr avec une erreur de la page. Les numéros T sont ceux de la galerie.</p>
$corps</body></html>
"@
[IO.File]::WriteAllText((Join-Path $sortie 'ecrans.html'), $page, (New-Object Text.UTF8Encoding $true))
Say "`n$($ecransFaits.Count) écrans capturés, $nbErr avec une erreur : $sortie\ecrans.html" $(if ($nbErr) { 'Yellow' } else { 'Green' })
Start-Process (Join-Path $sortie 'ecrans.html')
if ($nbErr) { exit 1 }
exit 0
