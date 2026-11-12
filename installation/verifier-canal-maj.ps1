# Vérification du canal de mise à jour des tablettes (A37, audit RM7), lancée chaque jour par GitHub
# (.github/workflows/canal-maj.yml) et utilisable à la main après une publication :
#   powershell -ExecutionPolicy Bypass -File installation\verifier-canal-maj.ps1
# Fait comme la tablette : lit version.json et version-test.json sur papote-maj.web.app, télécharge chaque APK
# annoncé et vérifie qu'il répond, que sa taille est plausible et que son empreinte est celle annoncée. Vérifie
# aussi que chaque APK annoncé porte une étiquette git (sinon un ménage de branches peut l'effacer) et que la
# version annoncée n'est pas plus ancienne que la dernière version étiquetée. Code de sortie 1 au moindre souci
# (sur GitHub : exécution rouge, donc e-mail « run failed »).

. (Join-Path $PSScriptRoot 'canal-maj.ps1')

# Liste des problèmes du canal (vide si tout va bien). Les lectures passent par Read-Feed, Test-ApkPublie
# et Get-EtiquettesDistantes, remplacées par les essais.
function Invoke-VerificationCanal {
    $pb = @()
    $lus = @{}
    foreach ($nom in 'version.json', 'version-test.json') {
        try { $lus[$nom] = Read-Feed $nom } catch { $pb += $_.Exception.Message }
    }
    try { $etiquettes = @(Get-EtiquettesDistantes) } catch { $pb += $_.Exception.Message; $etiquettes = $null }
    $dejaTelecharge = @{}
    foreach ($nom in 'version.json', 'version-test.json') {
        $e = $lus[$nom]
        if (-not $e) { continue }
        Write-Host "$nom : version $($e.versionName) ($($e.versionCode)), $($e.url)"
        if (-not $dejaTelecharge.ContainsKey($e.url)) {
            $dejaTelecharge[$e.url] = $true
            $pb += @(Test-ApkPublie $e $nom)
        }
        if ($null -ne $etiquettes) {
            $commit = Get-CommitDeUrl $e.url
            if ($commit -and -not @($etiquettes | Where-Object { $_.commit -eq $commit }).Count) {
                $pb += "l'APK de $nom (commit $commit) ne porte aucune étiquette tablette-* : un ménage de branches pourrait l'effacer (voir installation\LISEZMOI-MISES-A-JOUR.md)"
            }
            $max = if ($nom -eq 'version.json') { Get-PlusHautCodeEtiquete $etiquettes -Stable } else { Get-PlusHautCodeEtiquete $etiquettes }
            if ($e.versionCode -lt $max) {
                $pb += "$nom annonce la version $($e.versionCode), plus ancienne que la dernière version étiquetée ($max) : fichier remplacé par erreur, ou publication interrompue après l'étiquette"
            }
        }
    }
    if ($lus['version.json'] -and $lus['version-test.json'] -and $lus['version-test.json'].versionCode -lt $lus['version.json'].versionCode) {
        $pb += "version-test.json ($($lus['version-test.json'].versionCode)) est plus ancien que version.json ($($lus['version.json'].versionCode)) : les tablettes de test resteraient en arrière"
    }
    return @($pb | Where-Object { $_ })
}

if ($MyInvocation.InvocationName -ne '.') {
    $pb = @(Invoke-VerificationCanal)
    $resume = $env:GITHUB_STEP_SUMMARY
    if ($pb.Count) {
        foreach ($p in $pb) {
            if ($env:GITHUB_ACTIONS) { Write-Host "::error::$p" } else { Write-Host "PROBLÈME : $p" -ForegroundColor Red }
        }
        if ($resume) { (@('### Canal de mise à jour : problème') + ($pb | ForEach-Object { "- $_" })) -join "`n" | Out-File -Append -Encoding utf8 $resume }
        exit 1
    }
    Write-Host 'Canal de mise à jour correct : fichiers de version lisibles, APK téléchargés avec la bonne empreinte, versions étiquetées.' -ForegroundColor Green
    if ($resume) { '### Canal de mise à jour correct' | Out-File -Append -Encoding utf8 $resume }
}
