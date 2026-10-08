# Fonctions partagées par publier-mise-a-jour.ps1 et promouvoir-mise-a-jour.ps1.
# version.json : toutes les tablettes ; version-test.json : tablettes installées avec -Canal test.

$script:base = 'https://papote-maj.web.app'

function Get-Feed($fileName) {
    try { return Invoke-RestMethod -Uri "$script:base/$fileName" -Headers @{ 'Cache-Control' = 'no-cache' } } catch { return $null }
}

function Get-PublishedFeeds {
    $stable = Get-Feed 'version.json'
    $test = Get-Feed 'version-test.json'
    if (-not $stable) { $stable = [pscustomobject]@{ versionCode = 0 } }
    if (-not $test) { $test = $stable }
    return [pscustomobject]@{ stable = $stable; test = $test }
}

# Enregistre installation\<fichier> dans git, l'envoie sur GitHub et renvoie { url, sha256 }.
function Save-ApkOnGitHub($fileName, $message) {
    $path = Join-Path $root "installation\$fileName"
    git -C $root add -- "installation/$fileName"
    git -C $root commit -q -m $message -- "installation/$fileName"
    if ($LASTEXITCODE) { throw "Échec de l'enregistrement de installation\$fileName" }
    for ($i = 1; $i -le 4; $i++) {
        git -C $root push -q origin HEAD
        if (-not $LASTEXITCODE) { break }
        if ($i -eq 4) { throw "Échec de l'envoi sur GitHub" }
        Start-Sleep -Seconds ([math]::Pow(2, $i))
    }
    $sha1 = (git -C $root rev-parse HEAD).Trim()
    $remote = (git -C $root remote get-url origin).Trim()
    $repo = [regex]::Match($remote, 'github\.com[:/](.+?)(\.git)?$').Groups[1].Value
    return [pscustomobject]@{
        versionCode = 0; versionName = ''
        url = "https://raw.githubusercontent.com/$repo/$sha1/installation/$fileName"
        sha256 = (Get-FileHash $path -Algorithm SHA256).Hash.ToLower()
    }
}

# Écrit les deux fichiers de version et les met en ligne sur Firebase (site papote-maj).
function Publish-Feeds($feeds) {
    $public = Join-Path $root 'maj\public'
    if (Test-Path $public) { Remove-Item -Recurse -Force $public }
    New-Item -ItemType Directory -Force $public | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding $false
    foreach ($pair in @(@('version.json', $feeds.stable), @('version-test.json', $feeds.test))) {
        $f = $pair[1]
        if (-not $f.url) { continue }
        $json = [ordered]@{ versionCode = [int]$f.versionCode; versionName = $f.versionName; url = $f.url; sha256 = $f.sha256 } | ConvertTo-Json
        [System.IO.File]::WriteAllText((Join-Path $public $pair[0]), $json, $utf8)
    }
    firebase deploy --only hosting --config "$root\maj\firebase.json" --project papote-famille
    if ($LASTEXITCODE) { throw "Échec de la publication" }
}
