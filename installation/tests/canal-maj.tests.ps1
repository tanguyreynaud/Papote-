# Essais des garde-fous du canal de mise à jour (A37) : lecture des fichiers de version, vérification
# quotidienne. Sans réseau : les accès web sont remplacés. Lancer : pwsh installation/tests/canal-maj.tests.ps1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'outils-essais.ps1')
. (Join-Path $PSScriptRoot '..\verifier-canal-maj.ps1')
$script:pauseLecture = 0

# Faux site : $script:site[nom de fichier] = texte, ou un scriptblock qui échoue.
$script:site = @{}
$script:lectures = 0
function Read-WebText($url) {
    $script:lectures++
    $nom = $url.Substring($url.LastIndexOf('/') + 1)
    $v = $script:site[$nom]
    if ($v -is [scriptblock]) { return (& $v) }
    if ($null -eq $v) { throw 'réponse 404' }
    return $v
}
# Faux GitHub : $script:apks[url] = octets.
$script:apks = @{}
function Save-WebFile($url, $path) {
    if (-not $script:apks.ContainsKey($url)) { throw 'réponse 404' }
    [System.IO.File]::WriteAllBytes($path, $script:apks[$url])
}
$script:etiquettesEssai = @()
$script:etiquettesEnPanne = $false
function Get-EtiquettesDistantes {
    if ($script:etiquettesEnPanne) { throw 'Impossible de lire les étiquettes sur GitHub (réseau).' }
    return $script:etiquettesEssai
}

function New-Apk($graine) { $b = New-Object byte[] (600KB); (New-Object System.Random $graine).NextBytes($b); return ,$b }
function Get-Sha($octets) { $s = [System.Security.Cryptography.SHA256]::Create(); return (($s.ComputeHash($octets) | ForEach-Object { $_.ToString('x2') }) -join '') }

# Canal correct : stable 171, test 189, APK présents, étiquettes posées.
function Initialize-CanalCorrect {
    $script:apks = @{}
    $a = New-Apk 1; $b = New-Apk 2
    $script:stable = New-EntreeEssai 171 '2.99.64' ('1' * 40) (Get-Sha $a) 'Papote.apk'
    $script:test = New-EntreeEssai 189 '2.99.82' ('2' * 40) (Get-Sha $b) 'Papote-test.apk'
    $script:apks[$script:stable.url] = $a
    $script:apks[$script:test.url] = $b
    $script:site = @{ 'version.json' = (ConvertTo-TexteVersion $script:stable); 'version-test.json' = (ConvertTo-TexteVersion $script:test) }
    $script:etiquettesEssai = @(
        [pscustomobject]@{ nom = 'tablette-v2.99.64-171'; commit = ('1' * 40) },
        [pscustomobject]@{ nom = 'tablette-test-v2.99.82-189'; commit = ('2' * 40) })
}

Write-Host 'Lecture des fichiers de version'
Test-Cas 'lecture correcte' {
    Initialize-CanalCorrect
    $f = Read-Feeds
    Assert-Vrai ($f.stable.versionCode -eq 171 -and $f.test.versionCode -eq 189) 'les deux versions lues'
}
Test-Cas 'lecture ratée : erreur après 3 essais, jamais de version 0 par défaut' {
    Initialize-CanalCorrect
    $script:site['version.json'] = { throw 'coupure réseau' }
    $script:lectures = 0
    Assert-Erreur { Read-Feeds } 'Impossible de lire https://papote-maj.web.app/version.json après 3 essais (coupure réseau)'
    Assert-Vrai ($script:lectures -eq 3) "3 lectures (fait : $($script:lectures))"
}
Test-Cas 'coupure passagère : la 2e lecture suffit' {
    Initialize-CanalCorrect
    $script:texteBon = $script:site['version.json']
    $script:compte = 0
    $script:site['version.json'] = { $script:compte++; if ($script:compte -eq 1) { throw 'coupure' }; $script:texteBon }
    Assert-Vrai ((Read-Feeds).stable.versionCode -eq 171) 'version lue au 2e essai'
    Assert-Vrai ($script:compte -eq 2) '2 lectures'
}
Test-Cas 'version-test.json absent (404) : erreur, pas de copie de version.json' {
    Initialize-CanalCorrect
    $script:site.Remove('version-test.json')
    Assert-Erreur { Read-Feeds } 'version-test.json après 3 essais (réponse 404)'
}
Test-Cas 'JSON mal formé' {
    Initialize-CanalCorrect
    $script:site['version.json'] = '{"versionCode": 171, "url": '
    Assert-Erreur { Read-Feed 'version.json' } 'illisible (JSON mal formé)'
}
Test-Cas 'fichier vide (page HTML vide, réponse tronquée)' {
    Initialize-CanalCorrect
    $script:site['version.json'] = ''
    Assert-Erreur { Read-Feed 'version.json' } 'version.json est vide'
}
Test-Cas 'page HTML à la place du JSON' {
    Initialize-CanalCorrect
    $script:site['version.json'] = '<!DOCTYPE html><html><body>Site Not Found</body></html>'
    Assert-Erreur { Read-Feed 'version.json' } 'illisible'
}
Test-Cas 'champs manquants ou faux' {
    foreach ($cas in @(
            @{ e = (New-EntreeEssai 0); m = 'versionCode absent ou invalide' },
            @{ e = (New-EntreeEssai 171 ''); m = 'versionName absent' },
            @{ e = (New-EntreeEssai 171 '2.99' ('a' * 40) 'XYZ'); m = 'empreinte sha256' },
            @{ e = [pscustomobject]@{ versionCode = 171; versionName = '2.99'; url = 'https://exemple.com/Papote.apk'; sha256 = ('b' * 64) }; m = "adresse d'APK" },
            @{ e = [pscustomobject]@{ versionCode = 171; versionName = '2.99'; url = 'https://raw.githubusercontent.com/tanguyreynaud/Papote-/main/installation/Papote.apk'; sha256 = ('b' * 64) }; m = "adresse d'APK" },
            @{ e = [pscustomobject]@{ versionCode = 171; versionName = '2.99'; sha256 = ('b' * 64) }; m = "adresse d'APK" })) {
        $script:site['version.json'] = ConvertTo-TexteVersion $cas.e
        Assert-Erreur { Read-Feed 'version.json' } $cas.m
    }
}
Test-Cas 'adresse de secours maj.mapapote.fr acceptée (comme MajGarde)' {
    $e = [pscustomobject]@{ versionCode = 200; versionName = '3.0'; url = 'https://maj.mapapote.fr/Papote-200.apk'; sha256 = ('c' * 64) }
    Assert-Vrai (@(Test-EntreeVersion $e).Count -eq 0) 'aucun problème'
}

Write-Host 'Étiquettes'
Test-Cas 'noms et numéros' {
    Assert-Vrai ((Get-NomEtiquette 'stable' '2.99.64' 171) -eq 'tablette-v2.99.64-171') 'nom stable'
    Assert-Vrai ((Get-NomEtiquette 'test' '2.99.82' 189) -eq 'tablette-test-v2.99.82-189') 'nom test'
    Assert-Vrai ((Get-CodeEtiquette 'tablette-v2.99.64-retour-192') -eq 192) 'numéro d''un retour'
    Assert-Vrai ((Get-CodeEtiquette 'publie/main') -eq 0) 'autre étiquette ignorée'
}
Test-Cas 'sortie de git ls-remote (étiquette annotée : le commit désigné)' {
    $l = @("$('9' * 40)`trefs/tags/tablette-v2.99.64-171", "$('1' * 40)`trefs/tags/tablette-v2.99.64-171^{}", "$('2' * 40)`trefs/tags/tablette-test-v2.99.82-189")
    $e = @(ConvertFrom-LsRemote $l)
    Assert-Vrai ($e.Count -eq 2) '2 étiquettes'
    Assert-Vrai (($e | Where-Object nom -eq 'tablette-v2.99.64-171').commit -eq ('1' * 40)) 'commit désigné, pas l''objet étiquette'
    Assert-Vrai ((Get-PlusHautCodeEtiquete $e) -eq 189 -and (Get-PlusHautCodeEtiquete $e -Stable) -eq 171) 'plus hauts numéros'
}

Write-Host 'Vérification quotidienne'
Test-Cas 'canal correct : aucun problème' {
    Initialize-CanalCorrect
    $pb = @(Invoke-VerificationCanal)
    Assert-Vrai ($pb.Count -eq 0) "aucun problème (trouvé : $($pb -join ' | '))"
}
Test-Cas 'version.json injoignable' {
    Initialize-CanalCorrect
    $script:site.Remove('version.json')
    $pb = @(Invoke-VerificationCanal)
    Assert-Vrai ($pb.Count -eq 1 -and $pb[0] -like '*version.json après 3 essais*') "1 problème (trouvé : $($pb -join ' | '))"
}
Test-Cas 'APK effacé de GitHub (404)' {
    Initialize-CanalCorrect
    $script:apks.Remove($script:stable.url)
    $pb = @(Invoke-VerificationCanal)
    Assert-Vrai (($pb -join ' ') -like "*l'APK de version.json ne se télécharge pas*") "problème signalé (trouvé : $($pb -join ' | '))"
}
Test-Cas 'APK dont l''empreinte ne correspond pas' {
    Initialize-CanalCorrect
    $script:apks[$script:test.url] = New-Apk 3
    $pb = @(Invoke-VerificationCanal)
    Assert-Vrai (($pb -join ' ') -like "*version-test.json n'a pas l'empreinte annoncée*") "problème signalé (trouvé : $($pb -join ' | '))"
}
Test-Cas 'APK trop petit (page d''erreur servie à la place)' {
    Initialize-CanalCorrect
    $petit = [System.Text.Encoding]::UTF8.GetBytes('404: Not Found')
    $script:apks[$script:stable.url] = $petit
    $script:stable.sha256 = Get-Sha $petit
    $script:site['version.json'] = ConvertTo-TexteVersion $script:stable
    $pb = @(Invoke-VerificationCanal)
    Assert-Vrai (($pb -join ' ') -like '*fait 14 octets*') "problème signalé (trouvé : $($pb -join ' | '))"
}
Test-Cas 'versionCode en ligne plus petit que la dernière version étiquetée' {
    Initialize-CanalCorrect
    $script:etiquettesEssai += [pscustomobject]@{ nom = 'tablette-v2.99.90-195'; commit = ('3' * 40) }
    $pb = @(Invoke-VerificationCanal)
    Assert-Vrai (($pb -join ' ') -like '*version.json annonce la version 171, plus ancienne que la dernière version étiquetée (195)*') "problème signalé (trouvé : $($pb -join ' | '))"
}
Test-Cas 'APK publié sans étiquette' {
    Initialize-CanalCorrect
    $script:etiquettesEssai = @($script:etiquettesEssai[1])
    $pb = @(Invoke-VerificationCanal)
    Assert-Vrai ($pb.Count -eq 1 -and $pb[0] -like "*version.json (commit 1111*) ne porte aucune étiquette*") "1 problème (trouvé : $($pb -join ' | '))"
}
Test-Cas 'étiquettes illisibles : signalé, le reste est quand même vérifié' {
    Initialize-CanalCorrect
    $script:etiquettesEnPanne = $true
    try {
        $script:apks.Remove($script:test.url)
        $pb = @(Invoke-VerificationCanal)
        Assert-Vrai ($pb.Count -eq 2) "2 problèmes (trouvé : $($pb -join ' | '))"
    } finally { $script:etiquettesEnPanne = $false }
}
Test-Cas 'version de test plus ancienne que la stable' {
    Initialize-CanalCorrect
    $script:test.versionCode = 170
    $script:site['version-test.json'] = ConvertTo-TexteVersion $script:test
    $script:etiquettesEssai = @([pscustomobject]@{ nom = 'tablette-v2.99.64-171'; commit = ('1' * 40) }, [pscustomobject]@{ nom = 'tablette-test-v2.99.82-170'; commit = ('2' * 40) })
    $pb = @(Invoke-VerificationCanal)
    Assert-Vrai (($pb -join ' ') -like '*version-test.json (170) est plus ancien que version.json (171)*') "problème signalé (trouvé : $($pb -join ' | '))"
}

Complete-Essais
