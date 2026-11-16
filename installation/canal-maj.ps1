# Canal de mise à jour des tablettes (A37, audit RM7) : lecture et contrôle des fichiers de version,
# vérification d'un APK publié, noms des étiquettes git. Fonctions sans effet de bord sur le site :
# utilisées par maj-commun.ps1 (publication, retour en arrière) et par verifier-canal-maj.ps1
# (vérification quotidienne sur GitHub). Compatible PowerShell 5 (PC de Tanguy) et 7 (GitHub).
# Le même fichier existe sur main et sur la branche de la tablette : le garder identique des deux côtés.

# PowerShell 5 : GitHub et Firebase exigent TLS 1.2, pas toujours activé par défaut sous Windows.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$script:baseMaj = 'https://papote-maj.web.app'
# Mêmes règles que MajGarde.java (la tablette refuse toute autre adresse).
$script:motifUrlApk = '^https://raw\.githubusercontent\.com/tanguyreynaud/Papote-/([0-9a-f]{40})/installation/Papote(-test)?\.apk$'
$script:motifUrlApkSecours = '^https://maj\.mapapote\.fr/[A-Za-z0-9._-]{1,80}\.apk$'
# La tablette refuse au-delà de 30 Mo (MajGarde.TAILLE_MAX) ; en dessous de 500 Ko ce n'est pas un APK de Papote.
$script:tailleMaxApk = 30MB
$script:tailleMinApk = 500KB
# Relectures d'un fichier de version avant d'abandonner, et pause entre deux (secondes).
$script:essaisLecture = 3
$script:pauseLecture = 3

# --- Accès au réseau : deux fonctions seulement, remplacées par les essais (installation/tests). ---

# Contenu texte d'une adresse ; erreur si elle ne répond pas 200.
function Read-WebText($url) {
    $r = Invoke-WebRequest -UseBasicParsing -Uri $url -Headers @{ 'Cache-Control' = 'no-cache' } -TimeoutSec 30
    if ([int]$r.StatusCode -ne 200) { throw "réponse $($r.StatusCode)" }
    if ($r.Content -is [byte[]]) { return [System.Text.Encoding]::UTF8.GetString($r.Content) }
    return [string]$r.Content
}

# Télécharge une adresse dans un fichier ; erreur si elle ne répond pas 200.
function Save-WebFile($url, $path) {
    $r = Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $path -PassThru -TimeoutSec 120
    if ([int]$r.StatusCode -ne 200) { throw "réponse $($r.StatusCode)" }
}

# --- Fichiers de version ---

# Liste des problèmes d'une entrée de version.json (vide si tout va bien).
function Test-EntreeVersion($entree) {
    $pb = @()
    if ($null -eq $entree) { return @('fichier vide') }
    $code = 0
    if (-not [int]::TryParse([string]$entree.versionCode, [ref]$code) -or $code -le 0) { $pb += "versionCode absent ou invalide ($($entree.versionCode))" }
    if (-not ([string]$entree.versionName -match '^[0-9A-Za-z._-]{1,40}$')) { $pb += "versionName absent ou invalide ($($entree.versionName))" }
    $url = [string]$entree.url
    if (-not ($url -match $script:motifUrlApk -or $url -match $script:motifUrlApkSecours)) { $pb += "adresse d'APK absente ou refusée par la tablette ($url)" }
    if (-not ([string]$entree.sha256 -cmatch '^[0-9a-f]{64}$')) { $pb += "empreinte sha256 absente ou mal formée" }
    return $pb
}

# Texte JSON -> entrée vérifiée ; erreur claire sinon.
function ConvertFrom-TexteVersion($texte, $nomFichier) {
    if ([string]::IsNullOrWhiteSpace($texte)) { throw "$nomFichier est vide." }
    try { $entree = $texte | ConvertFrom-Json } catch { throw "$nomFichier est illisible (JSON mal formé)." }
    $pb = @(Test-EntreeVersion $entree)
    if ($pb.Count) { throw "$nomFichier a un contenu inattendu : $($pb -join ' ; ')." }
    return [pscustomobject]@{
        versionCode = [int]$entree.versionCode; versionName = [string]$entree.versionName
        url = [string]$entree.url; sha256 = [string]$entree.sha256
    }
}

# Lit un fichier de version en ligne, avec plusieurs essais. Ne renvoie JAMAIS de valeur par défaut :
# s'il ne peut pas être lu ou s'il est inattendu, c'est une erreur (la publication s'arrête).
function Read-Feed($nomFichier) {
    $url = "$script:baseMaj/$nomFichier"
    $derniere = ''
    for ($i = 1; $i -le $script:essaisLecture; $i++) {
        try { return ConvertFrom-TexteVersion (Read-WebText $url) $nomFichier }
        catch { $derniere = $_.Exception.Message }
        if ($i -lt $script:essaisLecture -and $script:pauseLecture) { Start-Sleep -Seconds $script:pauseLecture }
    }
    throw "Impossible de lire $url après $($script:essaisLecture) essais ($derniere)."
}

# Les deux fichiers en ligne : { stable, test }. Erreur si l'un des deux manque ou est inattendu.
function Read-Feeds {
    $stable = Read-Feed 'version.json'
    $test = Read-Feed 'version-test.json'
    return [pscustomobject]@{ stable = $stable; test = $test }
}

# --- APK publié ---

# Liste des problèmes de l'APK annoncé par une entrée : il répond, sa taille est plausible, son empreinte est la bonne.
function Test-ApkPublie($entree, $nomFichier) {
    $tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "papote-verif-$([guid]::NewGuid().ToString('N')).apk")
    try {
        try { Save-WebFile $entree.url $tmp } catch { return @("l'APK de $nomFichier ne se télécharge pas ($($entree.url) : $($_.Exception.Message))") }
        if (-not (Test-Path $tmp)) { return @("l'APK de $nomFichier ne se télécharge pas ($($entree.url))") }
        $taille = (Get-Item $tmp).Length
        $pb = @()
        if ($taille -lt $script:tailleMinApk -or $taille -gt $script:tailleMaxApk) { $pb += "l'APK de $nomFichier fait $taille octets (attendu entre $($script:tailleMinApk) et $($script:tailleMaxApk))" }
        $sha = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
        if ($sha -ne $entree.sha256) { $pb += "l'APK de $nomFichier n'a pas l'empreinte annoncée ($sha au lieu de $($entree.sha256))" }
        return $pb
    } finally {
        if (Test-Path $tmp) { Remove-Item -Force $tmp }
    }
}

# Commit visé par l'adresse d'un APK sur GitHub ($null pour l'adresse de secours).
function Get-CommitDeUrl($url) {
    $m = [regex]::Match([string]$url, $script:motifUrlApk)
    if ($m.Success) { return $m.Groups[1].Value }
    return $null
}

# --- Étiquettes git (une par APK publié, pour que le commit ne soit jamais effacé par un ménage de branches) ---

# tablette-v<versionName>-<versionCode> (toutes les tablettes), tablette-test-v<versionName>-<versionCode> (test).
function Get-NomEtiquette($canal, $versionName, $versionCode) {
    if ($canal -eq 'test') { return "tablette-test-v$versionName-$versionCode" }
    return "tablette-v$versionName-$versionCode"
}

# versionCode d'une étiquette (0 si ce n'est pas une étiquette de publication).
function Get-CodeEtiquette($nom) {
    $m = [regex]::Match([string]$nom, '^tablette-(test-)?v[0-9A-Za-z._-]+-(\d+)$')
    if ($m.Success) { return [int]$m.Groups[2].Value }
    return 0
}

# Étiquettes de publication du dépôt GitHub : objets { nom, commit }. Erreur si GitHub ne répond pas.
function Get-EtiquettesDistantes {
    # PowerShell 5 : avec $ErrorActionPreference = 'Stop', un message de git sur stderr arrêterait tout.
    $ErrorActionPreference = 'Continue'
    $lignes = git ls-remote --tags origin 'refs/tags/tablette-*' 2>&1
    if ($LASTEXITCODE) { throw "Impossible de lire les étiquettes sur GitHub ($($lignes -join ' '))." }
    return ConvertFrom-LsRemote $lignes
}

# Sortie de « git ls-remote --tags » -> { nom, commit } (pour une étiquette annotée, le commit qu'elle désigne).
function ConvertFrom-LsRemote($lignes) {
    $parNom = [ordered]@{}
    foreach ($l in @($lignes)) {
        $m = [regex]::Match([string]$l, '^([0-9a-f]{40})\s+refs/tags/(.+?)(\^\{\})?$')
        if (-not $m.Success) { continue }
        $nom = $m.Groups[2].Value
        if ($m.Groups[3].Success -or -not $parNom.Contains($nom)) { $parNom[$nom] = $m.Groups[1].Value }
    }
    $res = @()
    foreach ($k in $parNom.Keys) { $res += [pscustomobject]@{ nom = $k; commit = $parNom[$k] } }
    return $res
}

# Plus grand versionCode parmi des étiquettes (seulement celles du canal stable si -Stable).
function Get-PlusHautCodeEtiquete($etiquettes, [switch]$Stable) {
    $max = 0
    foreach ($e in @($etiquettes)) {
        if ($null -eq $e) { continue }
        if ($Stable -and $e.nom -like 'tablette-test-*') { continue }
        $c = Get-CodeEtiquette $e.nom
        if ($c -gt $max) { $max = $c }
    }
    return $max
}
