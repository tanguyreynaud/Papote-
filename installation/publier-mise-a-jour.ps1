# Publie une nouvelle version de Papote : les tablettes l'installent d'elles-mêmes.
#
# 1. Augmenter versionCode (et versionName) dans android/app/build.gradle.kts.
# 2. Enregistrer les changements avec git (commit) : seul le code enregistré est publié.
# 3. Lancer : powershell -ExecutionPolicy Bypass -File installation\publier-mise-a-jour.ps1
#
# Les tablettes (en mode kiosque) vérifient toutes les 6 heures et s'installent la mise à jour
# toutes seules, sans rien demander.

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

# L'APK est rangé dans le dépôt GitHub (le Firebase gratuit refuse les APK) :
# installation/Papote.apk, enregistré et envoyé, puis adressé par son commit.
Copy-Item $apk (Join-Path $root 'installation\Papote.apk') -Force
git -C $root commit -q -m "Publication de la version $name ($code)" -- installation/Papote.apk
if ($LASTEXITCODE) { throw "Échec de l'enregistrement de installation\Papote.apk" }
# Envoi sur GitHub, avec quelques nouvelles tentatives si le réseau hoquette
for ($i = 1; $i -le 4; $i++) {
    git -C $root push -q origin HEAD
    if (-not $LASTEXITCODE) { break }
    if ($i -eq 4) { throw "Échec de l'envoi sur GitHub" }
    Start-Sleep -Seconds ([math]::Pow(2, $i))
}
$sha1 = (git -C $root rev-parse HEAD).Trim()
$remote = (git -C $root remote get-url origin).Trim()
$repo = [regex]::Match($remote, 'github\.com[:/](.+?)(\.git)?$').Groups[1].Value
$url = "https://raw.githubusercontent.com/$repo/$sha1/installation/Papote.apk"

# Le petit fichier de version, sur Firebase
$public = Join-Path $root 'maj\public'
if (Test-Path $public) { Remove-Item -Recurse -Force $public }
New-Item -ItemType Directory -Force $public | Out-Null
$sha = (Get-FileHash $apk -Algorithm SHA256).Hash.ToLower()
$json = @{ versionCode = $code; versionName = $name; url = $url; sha256 = $sha } | ConvertTo-Json
[System.IO.File]::WriteAllText("$public\version.json", $json, (New-Object System.Text.UTF8Encoding $false))

firebase deploy --only hosting --config "$root\maj\firebase.json" --project papote-famille
if ($LASTEXITCODE) { throw "Échec de la publication" }
Write-Host "Version $name ($code) publiée." -ForegroundColor Green
