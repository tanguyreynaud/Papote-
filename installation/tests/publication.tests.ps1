# Essais des garde-fous de publication et du retour en arrière (A37, audit RM7 et RM8), sans Android SDK,
# sans Firebase et sans GitHub : un dépôt git temporaire tient lieu de GitHub, le site papote-maj et la
# compilation sont remplacés. Lancer : pwsh installation/tests/publication.tests.ps1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'outils-essais.ps1')
. (Join-Path $PSScriptRoot '..\maj-commun.ps1')
$script:pauseLecture = 0

# --- Faux site papote-maj, faux GitHub ---
$script:site = @{}
function Read-WebText($url) {
    $nom = $url.Substring($url.LastIndexOf('/') + 1)
    $v = $script:site[$nom]
    if ($v -is [scriptblock]) { return (& $v) }
    if ($null -eq $v) { throw 'réponse 404' }
    return $v
}
# L'APK « sur GitHub » : le fichier enregistré dans installation/ du faux dépôt (sauf $script:apkFaux).
$script:apkFaux = $null
# Les APK déjà « en ligne » avant l'essai (commits 111… et 222…) : $script:apkAncien.
$script:apkAncien = New-Object byte[] (600KB)
for ($i = 0; $i -lt $script:apkAncien.Length; $i += 7) { $script:apkAncien[$i] = 42 }
$script:shaAncien = (Get-FileHash -InputStream (New-Object System.IO.MemoryStream (, $script:apkAncien)) -Algorithm SHA256).Hash.ToLower()
function Save-WebFile($url, $path) {
    if ($script:apkFaux) { [System.IO.File]::WriteAllBytes($path, $script:apkFaux); return }
    if ($url -match '/(1{40}|2{40})/') { [System.IO.File]::WriteAllBytes($path, $script:apkAncien); return }
    $nom = $url.Substring($url.LastIndexOf('/') + 1)
    Copy-Item (Join-Path $root "installation/$nom") $path
}
$script:deploiements = 0
$script:deploiementFige = $false
function Invoke-DeploiementFirebase {
    $script:deploiements++
    if ($script:deploiementFige) { return }
    $script:site = @{}
    foreach ($f in Get-ChildItem (Join-Path $root 'maj/public')) { $script:site[$f.Name] = [System.IO.File]::ReadAllText($f.FullName) }
}
$script:etiquettesEssai = @()
function Get-EtiquettesDistantes { return $script:etiquettesEssai }
$script:reponse = 'O'
function Read-Host($invite) { return $script:reponse }
$script:compilations = 0
function Build-Apk($work) {
    $script:compilations++
    $apk = Join-Path $work 'app-release.apk'
    $b = New-Object byte[] (700KB); (New-Object System.Random $script:compilations).NextBytes($b)
    [System.IO.File]::WriteAllBytes($apk, $b)
    return $apk
}

function Invoke-Git { git -C $root @args; if ($LASTEXITCODE) { throw "git $args" } }

# Faux dépôt : « GitHub » = dépôt nu rangé sous .../github.com/tanguyreynaud/Papote-.git (même adresse
# reconnue par Save-ApkOnGitHub). Historique : code 171, publication test 171 étiquetée, code 189.
function Initialize-Depot {
    $base = Join-Path ([System.IO.Path]::GetTempPath()) "papote-essai-$([guid]::NewGuid().ToString('N'))"
    $nu = Join-Path $base 'github.com/tanguyreynaud/Papote-.git'
    git init -q --bare $nu
    $script:root = Join-Path $base 'depot'
    git init -q -b essai $script:root
    Invoke-Git config user.email essai@exemple.invalid
    Invoke-Git config user.name Essai
    # Barres obliques : sous Windows aussi, l'adresse doit contenir « github.com/… » comme une vraie.
    Invoke-Git remote add origin ($nu -replace '\\', '/')
    New-Item -ItemType Directory -Force (Join-Path $root 'android/app'), (Join-Path $root 'installation'), (Join-Path $root 'maj') | Out-Null
    function Set-Gradle($code, $name) {
        [System.IO.File]::WriteAllText((Join-Path $root 'android/app/build.gradle.kts'), "android {`n    defaultConfig {`n        versionCode = $code`n        versionName = `"$name`"`n    }`n}`n")
    }
    Set-Gradle 171 '2.99.64'
    Invoke-Git add -A; Invoke-Git commit -q -m 'Code 2.99.64'
    $script:source171 = (git -C $root rev-parse HEAD).Trim()
    [System.IO.File]::WriteAllBytes((Join-Path $root 'installation/Papote-test.apk'), [byte[]](1..200))
    Invoke-Git add -A; Invoke-Git commit -q -m 'Publication de la version 2.99.64 (171) pour les tablettes de test'
    $script:publication171 = (git -C $root rev-parse HEAD).Trim()
    Invoke-Git tag -a tablette-test-v2.99.64-171 -m "Publication de la version 2.99.64 (171) pour les tablettes de test`n`nsource: $script:source171"
    Invoke-Git tag ancienne-sans-source $script:publication171
    Set-Gradle 189 '2.99.82'
    Invoke-Git add -A; Invoke-Git commit -q -m 'Code 2.99.82'
    $script:source189 = (git -C $root rev-parse HEAD).Trim()
    Invoke-Git push -q origin HEAD --tags
    $script:base = $base
}

function Set-SiteEssai([int]$stable = 180, [int]$test = 189) {
    $script:feedsAvant = [pscustomobject]@{
        stable = (New-EntreeEssai $stable '2.99.70' ('1' * 40) $script:shaAncien 'Papote.apk')
        test = (New-EntreeEssai $test '2.99.82' ('2' * 40) $script:shaAncien 'Papote-test.apk') }
    $script:site = @{ 'version.json' = (ConvertTo-TexteVersion $script:feedsAvant.stable); 'version-test.json' = (ConvertTo-TexteVersion $script:feedsAvant.test) }
    $script:etiquettesEssai = @(
        [pscustomobject]@{ nom = "tablette-v2.99.70-$stable"; commit = ('1' * 40) },
        [pscustomobject]@{ nom = "tablette-test-v2.99.82-$test"; commit = ('2' * 40) },
        [pscustomobject]@{ nom = 'tablette-test-v2.99.64-171'; commit = $script:publication171 })
}

Initialize-Depot
try {
    Write-Host 'Lecture avant publication'
    Test-Cas 'lecture ratée : publication arrêtée, rien changé' {
        Set-SiteEssai
        $script:site['version-test.json'] = { throw 'coupure réseau' }
        Assert-Erreur { Get-PublishedFeeds } "Publication arrêtée, rien n'a été changé : Impossible de lire https://papote-maj.web.app/version-test.json après 3 essais (coupure réseau)"
    }
    Test-Cas 'fichier mal formé : publication arrêtée' {
        Set-SiteEssai
        $script:site['version.json'] = '{"versionCode": "abc"}'
        Assert-Erreur { Get-PublishedFeeds } 'version.json a un contenu inattendu'
    }

    Write-Host 'Numéros et étiquettes'
    Test-Cas 'versionCode plus petit que la dernière version étiquetée : refusé' {
        Set-SiteEssai
        Assert-Erreur { Assert-CodeLibre 185 $script:etiquettesEssai } "la version 185 n'est pas plus grande que la dernière version étiquetée (189)"
        Assert-Erreur { Assert-CodeLibre 189 $script:etiquettesEssai } 'au moins 190'
        Assert-CodeLibre 190 $script:etiquettesEssai
    }
    Test-Cas 'étiquette déjà prise (GitHub ou ce PC) : refusé' {
        Set-SiteEssai
        Assert-Erreur { Assert-EtiquetteLibre 'tablette-test-v2.99.82-189' $script:etiquettesEssai } 'existe déjà sur GitHub'
        Assert-Erreur { Assert-EtiquetteLibre 'tablette-test-v2.99.64-171' @() } 'existe déjà sur ce PC'
        Assert-EtiquetteLibre 'tablette-v2.99.90-190' $script:etiquettesEssai
    }

    Write-Host 'Mise en ligne des fichiers de version'
    Test-Cas 'entrée incomplète : rien écrit, rien mis en ligne (version.json jamais supprimé)' {
        Set-SiteEssai
        $script:deploiements = 0
        $nouveaux = [pscustomobject]@{ stable = [pscustomobject]@{ versionCode = 190; versionName = '2.99.90'; url = $null; sha256 = $null }; test = $script:feedsAvant.test }
        Assert-Erreur { Publish-Feeds $nouveaux $script:feedsAvant } "rien n'a été mis en ligne : version.json serait incomplet"
        Assert-Vrai ($script:deploiements -eq 0) 'aucune mise en ligne'
        Assert-Vrai (-not (Test-Path (Join-Path $root 'maj/public'))) 'aucun fichier écrit'
    }
    Test-Cas 'versions en ligne non lues : refusé' {
        Set-SiteEssai
        Assert-Erreur { Publish-Feeds $script:feedsAvant $null } "les versions en ligne n'ont pas été lues"
    }
    Test-Cas 'version.json qui recule : refusé' {
        Set-SiteEssai
        $nouveaux = [pscustomobject]@{ stable = (New-EntreeEssai 175); test = $script:feedsAvant.test }
        Assert-Erreur { Publish-Feeds $nouveaux $script:feedsAvant } 'version.json reculerait de 180 à 175'
    }
    Test-Cas 'version-test.json qui recule : refusé' {
        Set-SiteEssai
        $nouveaux = [pscustomobject]@{ stable = $script:feedsAvant.stable; test = (New-EntreeEssai 185) }
        Assert-Erreur { Publish-Feeds $nouveaux $script:feedsAvant } 'version-test.json reculerait de 189 à 185'
    }
    Test-Cas 'test plus ancien que stable : refusé' {
        Set-SiteEssai
        $nouveaux = [pscustomobject]@{ stable = (New-EntreeEssai 195); test = $script:feedsAvant.test }
        Assert-Erreur { Publish-Feeds $nouveaux $script:feedsAvant } 'la version de test (189) serait plus ancienne'
    }
    Test-Cas 'mise en ligne figée (ancien fichier encore servi) : ATTENTION' {
        Set-SiteEssai
        $script:deploiementFige = $true
        try {
            $nouveaux = [pscustomobject]@{ stable = $script:feedsAvant.stable; test = (New-EntreeEssai 190 '2.99.90' ('3' * 40) ('e' * 64) 'Papote-test.apk') }
            Assert-Erreur { Publish-Feeds $nouveaux $script:feedsAvant } "version-test.json en ligne n'est pas celui qui vient d'être publié (version 189 au lieu de 190)"
        } finally { $script:deploiementFige = $false }
    }

    Write-Host 'Publication complète dans le faux dépôt'
    Test-Cas 'APK enregistré, étiqueté (avec sa source), envoyé, annoncé et vérifié' {
        Set-SiteEssai
        [System.IO.File]::WriteAllBytes((Join-Path $root 'installation/Papote-test.apk'), (New-Object byte[] (600KB)))
        $entry = Save-ApkOnGitHub 'Papote-test.apk' 'Publication de la version 2.99.90 (190) pour les tablettes de test' 'tablette-test-v2.99.90-190' $script:source189
        $commit = (git -C $root rev-parse HEAD).Trim()
        Assert-Vrai ($entry.url -eq "https://raw.githubusercontent.com/tanguyreynaud/Papote-/$commit/installation/Papote-test.apk") "adresse visant le commit ($($entry.url))"
        $distant = (git -C $root ls-remote origin 'refs/tags/tablette-test-v2.99.90-190^{}') -join ''
        Assert-Vrai ($distant -like "$commit*") 'étiquette envoyée sur le faux GitHub et posée sur le commit de l''APK'
        $msg = (git -C $root for-each-ref --format='%(contents)' refs/tags/tablette-test-v2.99.90-190) -join "`n"
        Assert-Vrai ($msg -like "*source: $script:source189*") 'source notée dans l''étiquette'
        $entry.versionCode = 190; $entry.versionName = '2.99.90'
        Publish-Feeds ([pscustomobject]@{ stable = $script:feedsAvant.stable; test = $entry }) $script:feedsAvant
        $lu = ConvertFrom-TexteVersion $script:site['version-test.json'] 'version-test.json'
        Assert-Vrai ($lu.versionCode -eq 190 -and $lu.sha256 -eq $entry.sha256) 'version-test.json en ligne'
        Assert-Vrai ((ConvertFrom-TexteVersion $script:site['version.json'] 'version.json').versionCode -eq 180) 'version.json toujours là'
    }
    Test-Cas 'APK servi avec une autre empreinte : ATTENTION après publication' {
        Set-SiteEssai
        $b = New-Object byte[] (600KB)
        [System.IO.File]::WriteAllBytes((Join-Path $root 'installation/Papote-test.apk'), $b)
        $sha = (Get-FileHash (Join-Path $root 'installation/Papote-test.apk') -Algorithm SHA256).Hash.ToLower()
        $script:apkFaux = New-Object byte[] (650KB)
        try {
            $nouveaux = [pscustomobject]@{ stable = $script:feedsAvant.stable; test = (New-EntreeEssai 190 '2.99.90' ('3' * 40) $sha 'Papote-test.apk') }
            Assert-Erreur { Publish-Feeds $nouveaux $script:feedsAvant } "ATTENTION : la publication est en ligne mais sa vérification a échoué"
        } finally { $script:apkFaux = $null }
    }

    Write-Host 'Retour en arrière'
    Test-Cas 'essai : code de 171 extrait et renuméroté 191, rien enregistré ni publié' {
        Set-SiteEssai 180 190
        $script:etiquettesEssai += [pscustomobject]@{ nom = 'tablette-test-v2.99.90-190'; commit = ('3' * 40) }
        $avantHead = (git -C $root rev-parse HEAD).Trim()
        $avantTags = @(git -C $root tag -l).Count
        $script:deploiements = 0; $script:compilations = 0
        $r = Invoke-RetourArriere -Depuis 'tablette-test-v2.99.64-171' -Essai
        Assert-Vrai ($r.source -eq $script:source171) 'code compilé pour 171'
        Assert-Vrai ($r.code -eq 191 -and $r.name -eq '2.99.64-retour') "nouvelle version 2.99.64-retour (191) (obtenu $($r.name) ($($r.code)))"
        Assert-Vrai ($r.etiquette -eq 'tablette-v2.99.64-retour-191') "étiquette ($($r.etiquette))"
        $g = [System.IO.File]::ReadAllText($r.gradle)
        Assert-Vrai ($g -match 'versionCode = 191' -and $g -match 'versionName = "2.99.64-retour"') 'build.gradle.kts renuméroté'
        Assert-Vrai ((git -C $root rev-parse HEAD).Trim() -eq $avantHead -and @(git -C $root tag -l).Count -eq $avantTags) 'aucun commit ni étiquette'
        Assert-Vrai ($script:deploiements -eq 0 -and $script:compilations -eq 0) 'ni compilation ni mise en ligne'
    }
    Test-Cas 'étiquette inconnue ou qui n''est pas une publication : refusé' {
        Set-SiteEssai
        Assert-Erreur { Invoke-RetourArriere -Depuis 'tablette-v9.9-999' -Essai } 'introuvable'
        Assert-Erreur { Invoke-RetourArriere -Depuis 'publie/main' -Essai } "n'est pas une étiquette de publication"
    }
    Test-Cas 'version pas plus ancienne que celle en ligne : rien à faire' {
        Set-SiteEssai 160 171
        Assert-Erreur { Invoke-RetourArriere -Depuis 'tablette-test-v2.99.64-171' -Test -Essai } "n'est pas plus ancienne que celle en ligne"
    }
    Test-Cas 'étiquette sans « source: » sur un commit qui n''est pas une compilation : refusé' {
        Set-SiteEssai
        Invoke-Git tag -a tablette-v2.99.82-189 -m 'sans source' $script:source189
        try { Assert-Erreur { Invoke-RetourArriere -Depuis 'tablette-v2.99.82-189' -Essai } 'ne dit pas quel code a été compilé' }
        finally { Invoke-Git tag -d tablette-v2.99.82-189 | Out-Null }
    }
    Test-Cas 'étiquette ancienne sans « source: » sur un commit de compilation : le parent est pris' {
        Set-SiteEssai
        Invoke-Git tag tablette-v2.99.64-171 $script:publication171
        try { Assert-Vrai ((Invoke-RetourArriere -Depuis 'tablette-v2.99.64-171' -Essai).source -eq $script:source171) 'parent du commit de publication' }
        finally { Invoke-Git tag -d tablette-v2.99.64-171 | Out-Null }
    }
    Test-Cas 'code noté qui ne porte pas le numéro de l''étiquette : refusé' {
        Set-SiteEssai
        Invoke-Git tag -a tablette-v2.99.70-175 -m "faux`n`nsource: $script:source171" $script:publication171
        try { Assert-Erreur { Invoke-RetourArriere -Depuis 'tablette-v2.99.70-175' -Essai } 'porte la version 171, pas 175' }
        finally { Invoke-Git tag -d tablette-v2.99.70-175 | Out-Null }
    }
    Test-Cas 'refus à la question de confirmation : rien publié' {
        Set-SiteEssai
        $script:reponse = 'N'; $script:compilations = 0
        try { Assert-Erreur { Invoke-RetourArriere -Depuis 'tablette-test-v2.99.64-171' } 'Retour en arrière annulé' }
        finally { $script:reponse = 'O' }
        Assert-Vrai ($script:compilations -eq 0) 'pas de compilation'
    }
    Test-Cas 'retour complet (compilation remplacée) : APK étiqueté, toutes les tablettes en 190' {
        Set-SiteEssai
        Invoke-RetourArriere -Depuis 'tablette-test-v2.99.64-171' | Out-Null
        $s = ConvertFrom-TexteVersion $script:site['version.json'] 'version.json'
        $t = ConvertFrom-TexteVersion $script:site['version-test.json'] 'version-test.json'
        Assert-Vrai ($s.versionCode -eq 190 -and $s.versionName -eq '2.99.64-retour' -and $t.versionCode -eq 190) "version 190 partout (obtenu $($s.versionCode) / $($t.versionCode))"
        $distant = (git -C $root ls-remote origin 'refs/tags/tablette-v2.99.64-retour-190^{}') -join ''
        Assert-Vrai ($distant -like "$(Get-CommitDeUrl $s.url)*") 'étiquette envoyée sur le commit annoncé'
        $msg = (git -C $root for-each-ref --format='%(contents)' refs/tags/tablette-v2.99.64-retour-190) -join "`n"
        Assert-Vrai ($msg -like "*source: $script:source171*") 'source de 171 notée'
    }
} finally {
    Remove-Item -Recurse -Force $script:base -ErrorAction SilentlyContinue
}
Complete-Essais
