# Publie une nouvelle version de Papote : les tablettes l'installent d'elles-mêmes.
#
# 1. Augmenter versionCode (et versionName) dans android/app/build.gradle.kts.
# 2. Enregistrer les changements avec git (commit) : seul le code enregistré est publié.
# 3. Lancer : powershell -ExecutionPolicy Bypass -File installation\publier-mise-a-jour.ps1
#
# Les tablettes vérifient toutes les 6 heures. Android 5 et plus (mode kiosque) : installation
# silencieuse. Android 4.4 : l'écran d'installation s'ouvre en journée, il suffit de toucher « Installer ».

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$feed = 'https://papote-maj.web.app/version.json'

# Version du code enregistré
$gradle = git -C $root show HEAD:android/app/build.gradle.kts | Out-String
$code = [int]([regex]::Match($gradle, 'versionCode = (\d+)').Groups[1].Value)
$name = [regex]::Match($gradle, 'versionName = "([^"]+)"').Groups[1].Value

# Version déjà publiée
$published = 0
try { $published = [int](Invoke-RestMethod -Uri $feed -Headers @{ 'Cache-Control' = 'no-cache' }).versionCode } catch { }
if ($code -le $published) {
    throw "La version $code est déjà publiée (en ligne : $published). Augmentez versionCode dans android/app/build.gradle.kts puis faites un commit."
}
if (git -C $root status --porcelain -- android) {
    Write-Host "Attention : des changements non enregistrés dans android/ ne seront pas publiés." -ForegroundColor Yellow
}

# Compilation à partir du code enregistré seulement
$work = Join-Path $env:TEMP 'papote-publication'
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Force $work | Out-Null
git -C $root archive -o "$work\src.zip" HEAD android
Expand-Archive "$work\src.zip" -DestinationPath $work
Copy-Item "$root\android\local.properties", "$root\android\signing.properties" "$work\android\"
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
Push-Location "$work\android"
try { & .\gradlew.bat assembleRelease -q; if ($LASTEXITCODE) { throw "Échec de la compilation" } } finally { Pop-Location }
$apk = "$work\android\app\build\outputs\apk\release\app-release.apk"

# Fichiers publiés
$public = Join-Path $root 'maj\public'
if (Test-Path $public) { Remove-Item -Recurse -Force $public }
New-Item -ItemType Directory -Force $public | Out-Null
$file = "Papote-$code.apk"
Copy-Item $apk "$public\$file"
$sha = (Get-FileHash "$public\$file" -Algorithm SHA256).Hash.ToLower()
$json = @{ versionCode = $code; versionName = $name; apk = $file; sha256 = $sha } | ConvertTo-Json
[System.IO.File]::WriteAllText("$public\version.json", $json, (New-Object System.Text.UTF8Encoding $false))

# Même APK pour les nouvelles installations par câble
Copy-Item $apk (Join-Path $root 'installation\Papote.apk') -Force

firebase deploy --only hosting --config "$root\maj\firebase.json" --project papote-famille
if ($LASTEXITCODE) { throw "Échec de la publication" }
Write-Host "Version $name ($code) publiée. Pensez à enregistrer installation\Papote.apk (commit)." -ForegroundColor Green
