# Petit cadre d'essais sans dépendance (pas de Pester : même résultat sous PowerShell 5 et 7).
$script:reussis = 0
$script:rates = @()

function Test-Cas($nom, [scriptblock]$corps) {
    try { & $corps; $script:reussis++; Write-Host "  ok  $nom" -ForegroundColor Green }
    catch { $script:rates += $nom; Write-Host "  RATÉ $nom : $($_.Exception.Message)" -ForegroundColor Red }
}

function Assert-Vrai($condition, $message) { if (-not $condition) { throw "attendu : $message" } }

# Le bloc doit échouer avec un message qui contient $motif.
function Assert-Erreur([scriptblock]$bloc, $motif) {
    $msg = $null
    try { & $bloc } catch { $msg = $_.Exception.Message }
    if ($null -eq $msg) { throw "aucune erreur (attendu : « $motif »)" }
    if ($msg -notlike "*$motif*") { throw "erreur inattendue : $msg (attendu : « $motif »)" }
}

function Complete-Essais {
    Write-Host ''
    if ($script:rates.Count) { Write-Host "$($script:rates.Count) essai(s) raté(s), $($script:reussis) réussi(s)." -ForegroundColor Red; exit 1 }
    Write-Host "$($script:reussis) essais réussis." -ForegroundColor Green
}

# Entrée de version valide, modifiable.
function New-EntreeEssai([int]$code = 171, $name = '2.99.64', $commit = ('a' * 40), $sha = ('b' * 64), $fichier = 'Papote.apk') {
    return [pscustomobject]@{ versionCode = $code; versionName = $name; url = "https://raw.githubusercontent.com/tanguyreynaud/Papote-/$commit/installation/$fichier"; sha256 = $sha }
}

function ConvertTo-TexteVersion($e) { return ([ordered]@{ versionCode = $e.versionCode; versionName = $e.versionName; url = $e.url; sha256 = $e.sha256 } | ConvertTo-Json) }
