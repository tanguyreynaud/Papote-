# Fonctions partagées par publier-mise-a-jour.ps1, promouvoir-mise-a-jour.ps1 et revenir-en-arriere.ps1.
# version.json : toutes les tablettes ; version-test.json : tablettes installées avec -Canal test.
# Garde-fous du canal (A37, audit RM7) : voir installation/LISEZMOI-MISES-A-JOUR.md.

. (Join-Path $PSScriptRoot 'canal-maj.ps1')

# Versions en ligne. Si l'un des deux fichiers ne peut pas être lu ou a un contenu inattendu, la publication
# s'arrête AVANT tout changement : avant (audit RM7), une lecture ratée donnait une version 0 et la
# publication Firebase, qui remplace tout le site, supprimait version.json (toutes les tablettes en échec).
function Get-PublishedFeeds {
    try { return Read-Feeds }
    catch { throw "Publication arrêtée, rien n'a été changé : $($_.Exception.Message) Vérifiez la connexion à internet puis relancez." }
}

# Le versionCode doit dépasser celui de toutes les versions déjà étiquetées (Android refuse d'installer un
# numéro plus petit, et une tablette qui a déjà ce numéro ne prendrait pas un APK différent).
function Assert-CodeLibre([int]$code, $etiquettes) {
    $max = Get-PlusHautCodeEtiquete $etiquettes
    if ($code -le $max) {
        throw "Publication arrêtée : la version $code n'est pas plus grande que la dernière version étiquetée ($max). Augmentez versionCode dans android/app/build.gradle.kts (au moins $($max + 1)) puis faites un commit."
    }
}

# L'étiquette ne doit exister ni sur ce PC ni sur GitHub.
function Assert-EtiquetteLibre($nom, $etiquettes) {
    git -C $root rev-parse -q --verify "refs/tags/$nom" | Out-Null
    $locale = -not $LASTEXITCODE
    $distante = @($etiquettes | Where-Object { $_ -and $_.nom -eq $nom }).Count -gt 0
    if ($locale -or $distante) {
        throw "Publication arrêtée : l'étiquette $nom existe déjà$(if ($distante) { ' sur GitHub' } else { ' sur ce PC' }). Une publication précédente de ce numéro n'a pas abouti ? Augmentez versionCode, ou si cette version n'a jamais été annoncée aux tablettes, supprimez l'étiquette (git tag -d $nom) puis relancez."
    }
}

# Enregistre installation\<fichier> dans git, l'envoie sur GitHub avec son étiquette et renvoie { url, sha256 }.
# $source : commit dont le code a été compilé (noté dans l'étiquette, pour revenir-en-arriere.ps1).
function Save-ApkOnGitHub($fileName, $message, $etiquette, $source) {
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
    # Étiquette : le commit de l'APK reste sur GitHub même si sa branche est supprimée (ménage des branches).
    git -C $root tag -a $etiquette -m "$message`n`nsource: $source" $sha1
    if ($LASTEXITCODE) { throw "Échec de la création de l'étiquette $etiquette" }
    $envoyee = $false
    for ($i = 1; $i -le 4 -and -not $envoyee; $i++) {
        git -C $root push -q origin "refs/tags/$etiquette"
        if (-not $LASTEXITCODE) { $envoyee = $true } elseif ($i -lt 4) { Start-Sleep -Seconds ([math]::Pow(2, $i)) }
    }
    if (-not $envoyee) {
        # La branche envoyée protège déjà le commit : on continue, mais la vérification quotidienne sera rouge.
        Write-Host "ATTENTION : l'étiquette $etiquette n'a pas pu être envoyée sur GitHub. Dès que possible : git push origin refs/tags/$etiquette" -ForegroundColor Red
    }
    $remote = (git -C $root remote get-url origin).Trim()
    $repo = [regex]::Match($remote, 'github\.com[:/](.+?)(\.git)?$').Groups[1].Value
    return [pscustomobject]@{
        versionCode = 0; versionName = ''
        url = "https://raw.githubusercontent.com/$repo/$sha1/installation/$fileName"
        sha256 = (Get-FileHash $path -Algorithm SHA256).Hash.ToLower()
    }
}

# Mise en ligne du dossier maj\public sur Firebase (site papote-maj). Séparé pour les essais.
function Invoke-DeploiementFirebase {
    firebase deploy --only hosting --config "$root\maj\firebase.json" --project papote-famille
    if ($LASTEXITCODE) { throw "Échec de la publication" }
}

# Écrit les deux fichiers de version, les met en ligne sur Firebase, puis vérifie ce qui est en ligne.
# $avant : les versions lues en ligne avant la publication (Get-PublishedFeeds).
function Publish-Feeds($feeds, $avant) {
    # Garde-fous AVANT d'écrire quoi que ce soit : la mise en ligne remplace tout le site, un fichier manquant
    # ou incomplet serait supprimé ou cassé pour toutes les tablettes.
    foreach ($pair in @(@('version.json', $feeds.stable), @('version-test.json', $feeds.test))) {
        $pb = @(Test-EntreeVersion $pair[1])
        if ($pb.Count) { throw "Publication arrêtée, rien n'a été mis en ligne : $($pair[0]) serait incomplet ($($pb -join ' ; '))." }
    }
    if ($null -eq $avant) { throw "Publication arrêtée, rien n'a été mis en ligne : les versions en ligne n'ont pas été lues." }
    if ([int]$feeds.stable.versionCode -lt [int]$avant.stable.versionCode) {
        throw "Publication arrêtée, rien n'a été mis en ligne : version.json reculerait de $($avant.stable.versionCode) à $($feeds.stable.versionCode) (Android refuse une version plus ancienne : utilisez revenir-en-arriere.ps1)."
    }
    if ([int]$feeds.test.versionCode -lt [int]$avant.test.versionCode) {
        throw "Publication arrêtée, rien n'a été mis en ligne : version-test.json reculerait de $($avant.test.versionCode) à $($feeds.test.versionCode) (utilisez revenir-en-arriere.ps1 -Test)."
    }
    if ([int]$feeds.test.versionCode -lt [int]$feeds.stable.versionCode) {
        throw "Publication arrêtée, rien n'a été mis en ligne : la version de test ($($feeds.test.versionCode)) serait plus ancienne que celle de toutes les tablettes ($($feeds.stable.versionCode))."
    }

    $public = Join-Path $root 'maj\public'
    if (Test-Path $public) { Remove-Item -Recurse -Force $public }
    New-Item -ItemType Directory -Force $public | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding $false
    foreach ($pair in @(@('version.json', $feeds.stable), @('version-test.json', $feeds.test))) {
        $f = $pair[1]
        $json = [ordered]@{ versionCode = [int]$f.versionCode; versionName = $f.versionName; url = $f.url; sha256 = $f.sha256 } | ConvertTo-Json
        [System.IO.File]::WriteAllText((Join-Path $public $pair[0]), $json, $utf8)
    }
    Invoke-DeploiementFirebase

    # Vérification après publication : ce qui est en ligne est bien ce qui vient d'être écrit, et chaque APK
    # annoncé se télécharge avec la bonne empreinte (comme le fera la tablette).
    $pb = @()
    try { $enLigne = Read-Feeds } catch { $pb += $_.Exception.Message; $enLigne = $null }
    if ($enLigne) {
        foreach ($c in @(@('version.json', $feeds.stable, $enLigne.stable), @('version-test.json', $feeds.test, $enLigne.test))) {
            if ($c[2].versionCode -ne [int]$c[1].versionCode -or $c[2].url -ne $c[1].url -or $c[2].sha256 -ne $c[1].sha256) {
                $pb += "$($c[0]) en ligne n'est pas celui qui vient d'être publié (version $($c[2].versionCode) au lieu de $($c[1].versionCode))"
            }
        }
        $pb += @(Test-ApkPublie $enLigne.stable 'version.json')
        if ($enLigne.test.url -ne $enLigne.stable.url) { $pb += @(Test-ApkPublie $enLigne.test 'version-test.json') }
    }
    $pb = @($pb | Where-Object { $_ })
    if ($pb.Count) {
        throw "ATTENTION : la publication est en ligne mais sa vérification a échoué : $($pb -join ' ; '). Les tablettes ne prendront pas cette version (empreinte ou adresse refusée). Relancez la vérification dans quelques minutes (installation\verifier-canal-maj.ps1) ; si elle reste rouge, republiez ou revenez en arrière (installation\LISEZMOI-MISES-A-JOUR.md)."
    }
    Write-Host 'Vérification après publication : fichiers de version et APK corrects.' -ForegroundColor Green

    # Les tablettes sont prévenues tout de suite (config/version, écouté en direct) au lieu d'attendre
    # leur vérification du jour. Sans la clé d'administration, elles la trouveront quand même.
    $outil = Join-Path $root 'outils\admin\annoncer-version.js'
    $cleAdmin = if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.papote\cle-admin-firebase.json' } else { '' }
    if ((Test-Path $outil) -and $cleAdmin -and (Test-Path $cleAdmin)) {
        $old = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { & node $outil --stable $feeds.stable.versionCode --test $feeds.test.versionCode 2>&1 | ForEach-Object { Write-Host "$_" } }
        finally { $ErrorActionPreference = $old }
    }
}

# Prépare dans $work le code android/ du commit $rev (git archive : seul le code enregistré est compilé).
# $versionCode / $versionName : s'ils sont donnés, remplacent ceux de build.gradle.kts (retour en arrière).
# Renvoie { code, name, gradle } lus (ou écrits) dans build.gradle.kts.
function New-SourceAndroid($rev, $work, $versionCode, $versionName) {
    if (Test-Path $work) { Remove-Item -Recurse -Force $work }
    New-Item -ItemType Directory -Force $work | Out-Null
    git -C $root archive -o (Join-Path $work 'src.zip') $rev android
    if ($LASTEXITCODE) { throw "Impossible d'extraire le code du commit $rev" }
    Expand-Archive (Join-Path $work 'src.zip') -DestinationPath $work
    $gradle = Join-Path $work 'android/app/build.gradle.kts'
    $texte = [System.IO.File]::ReadAllText($gradle)
    if ($versionCode) {
        if ([regex]::Matches($texte, 'versionCode = \d+').Count -ne 1 -or [regex]::Matches($texte, 'versionName = "[^"]+"').Count -ne 1) {
            throw "build.gradle.kts du commit $rev : versionCode ou versionName introuvable (ou en double), rien n'a été changé."
        }
        $texte = [regex]::Replace($texte, 'versionCode = \d+', "versionCode = $versionCode")
        $texte = [regex]::Replace($texte, 'versionName = "[^"]+"', "versionName = `"$versionName`"")
        [System.IO.File]::WriteAllText($gradle, $texte, (New-Object System.Text.UTF8Encoding $false))
    }
    return [pscustomobject]@{
        code = [int]([regex]::Match($texte, 'versionCode = (\d+)').Groups[1].Value)
        name = [regex]::Match($texte, 'versionName = "([^"]+)"').Groups[1].Value
        gradle = $gradle
    }
}

# Vérifie le JavaScript de la tablette, compile l'APK signé dans $work et renvoie son chemin.
function Build-Apk($work) {
    Copy-Item "$root\android\local.properties", "$root\android\signing.properties" "$work\android\"
    # Vérification du JavaScript de la tablette avant de compiler : une seule faute de frappe bloque tout l'écran.
    $assets = "$work\android\app\src\main\assets"
    foreach ($js in 'tablette.js', 'bienvenue.js') {
        & node --check "$assets\$js"
        if ($LASTEXITCODE) { throw "Erreur de syntaxe dans $js : publication annulée." }
    }
    Get-Content -Raw "$assets\appels.js" | & node --input-type=module --check
    if ($LASTEXITCODE) { throw "Erreur de syntaxe dans appels.js : publication annulée." }

    $env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
    Push-Location "$work\android"
    try { & .\gradlew.bat assembleRelease -q; if ($LASTEXITCODE) { throw "Échec de la compilation" } } finally { Pop-Location }
    return "$work\android\app\build\outputs\apk\release\app-release.apk"
}

# Garde-fou « Urgence ? » (Tanguy, 05/11) : pas deux versions pour toutes les tablettes en moins de 30 jours,
# sauf urgence. La date est celle du dernier envoi de installation/Papote.apk (une publication stable = un commit).
function Confirm-StableCadence {
    $last = git -C $root log -1 --format=%ct -- installation/Papote.apk
    if (-not $last) { return }
    $days = [math]::Floor(((Get-Date).ToUniversalTime() - [DateTimeOffset]::FromUnixTimeSeconds([long]$last).UtcDateTime).TotalDays)
    if ($days -ge 30) { return }
    Write-Host "La dernière version pour toutes les tablettes date de $days jour(s) (moins de 30)." -ForegroundColor Yellow
    $r = Read-Host 'Urgence ? (O/N)'
    if ($r -notmatch '^[oOyY]') { throw "Publication arrêtée : pas d'urgence, la prochaine version attendra." }
}

# Retour en arrière (audit RM8) : Android refuse un versionCode plus petit, donc on recompile le code d'une
# version publiée (son étiquette) avec un numéro PLUS GRAND que tout ce qui a été publié, et on le publie.
# -Essai : toutes les lectures et vérifications, le code extrait et renuméroté, mais ni compilation, ni commit,
# ni étiquette, ni mise en ligne.
function Invoke-RetourArriere([string]$Depuis, [switch]$Test, [switch]$Essai) {
    if ((Get-CodeEtiquette $Depuis) -le 0) {
        throw "« $Depuis » n'est pas une étiquette de publication (attendu : tablette-v<version>-<numéro> ou tablette-test-v<version>-<numéro>). Liste : git tag -l 'tablette-*'"
    }
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { git -C $root fetch -q origin --tags 2>&1 | Out-Null } finally { $ErrorActionPreference = $old }
    $commitEtiquette = (git -C $root rev-parse -q --verify "refs/tags/$Depuis^{commit}")
    if ($LASTEXITCODE -or -not $commitEtiquette) { throw "L'étiquette $Depuis est introuvable (ni sur ce PC ni sur GitHub). Liste : git tag -l 'tablette-*'" }
    $commitEtiquette = "$commitEtiquette".Trim()

    # Code compilé pour cette version : noté dans l'étiquette (« source: <commit> »). Pour une étiquette sans
    # cette ligne, le parent du commit de publication, seulement si ce commit vient d'une compilation.
    $message = (git -C $root for-each-ref --format='%(contents)' "refs/tags/$Depuis") -join "`n"
    $m = [regex]::Match($message, '(?m)^source: ([0-9a-f]{40})\s*$')
    if ($m.Success) { $source = $m.Groups[1].Value }
    else {
        $sujet = (git -C $root log -1 --format=%s $commitEtiquette) -join ''
        if ($sujet -notlike 'Publication de la version*') {
            throw "L'étiquette $Depuis ne dit pas quel code a été compilé (« source: » absent) et son commit n'est pas une compilation (« $sujet »). Utilisez l'étiquette tablette-test-... de la même version."
        }
        $source = ((git -C $root rev-parse "$commitEtiquette^") -join '').Trim()
    }

    $feeds = Get-PublishedFeeds
    $etiquettes = Get-EtiquettesDistantes
    $codeVise = Get-CodeEtiquette $Depuis
    $canal = if ($Test) { 'test' } else { 'stable' }
    $enLigne = if ($Test) { $feeds.test } else { $feeds.stable }
    if ($codeVise -ge [int]$enLigne.versionCode) {
        throw "Rien à faire : la version de $Depuis ($codeVise) n'est pas plus ancienne que celle en ligne pour $(if ($Test) { 'les tablettes de test' } else { 'toutes les tablettes' }) ($($enLigne.versionCode)). Pour avancer une version, utilisez promouvoir-mise-a-jour.ps1."
    }

    $nouveauCode = [math]::Max([math]::Max([int]$feeds.stable.versionCode, [int]$feeds.test.versionCode), (Get-PlusHautCodeEtiquete $etiquettes)) + 1
    $work = Join-Path ([System.IO.Path]::GetTempPath()) 'papote-retour'
    $avantRenum = New-SourceAndroid $source $work
    if ($avantRenum.code -ne $codeVise) {
        throw "Le code noté pour $Depuis (commit $source) porte la version $($avantRenum.code), pas $codeVise : rien n'a été changé. Vérifiez l'étiquette."
    }
    $nouveauNom = ($avantRenum.name -replace '-retour$', '') + '-retour'
    $nouvelle = New-SourceAndroid $source $work $nouveauCode $nouveauNom
    $etiquette = Get-NomEtiquette $canal $nouveauNom $nouveauCode
    Assert-CodeLibre $nouveauCode $etiquettes
    Assert-EtiquetteLibre $etiquette $etiquettes

    Write-Host "Retour en arrière vers $Depuis (code du commit $source, version $($avantRenum.name) ($codeVise))." -ForegroundColor Cyan
    Write-Host "  Nouvelle version : $nouveauNom ($nouveauCode), pour $(if ($Test) { 'les tablettes de test' } else { 'toutes les tablettes' })."
    Write-Host "  En ligne aujourd'hui : toutes les tablettes $($feeds.stable.versionName) ($($feeds.stable.versionCode)), test $($feeds.test.versionName) ($($feeds.test.versionCode))."
    Write-Host "  Étiquette qui sera créée : $etiquette"
    if ($Essai) {
        Write-Host "Essai seulement : code extrait et renuméroté dans $work ; rien n'a été compilé, enregistré ni publié." -ForegroundColor Yellow
        return [pscustomobject]@{ source = $source; ancienCode = $codeVise; code = $nouveauCode; name = $nouveauNom; etiquette = $etiquette; work = $work; gradle = $nouvelle.gradle }
    }
    $r = Read-Host 'Publier ce retour en arrière ? (O/N)'
    if ($r -notmatch '^[oOyY]') { throw "Retour en arrière annulé, rien n'a été publié." }

    $apk = Build-Apk $work
    $file = if ($Test) { 'Papote-test.apk' } else { 'Papote.apk' }
    Copy-Item $apk (Join-Path $root "installation\$file") -Force
    $entry = Save-ApkOnGitHub $file "Retour en arrière : version $nouveauNom ($nouveauCode) = code de $Depuis$(if ($Test) { ' pour les tablettes de test' })" $etiquette $source
    $entry.versionCode = $nouveauCode
    $entry.versionName = $nouveauNom
    $nouveaux = [pscustomobject]@{ stable = $feeds.stable; test = $feeds.test }
    if ($Test) { $nouveaux.test = $entry } else { $nouveaux.stable = $entry; $nouveaux.test = $entry }
    Publish-Feeds $nouveaux $feeds
    Write-Host "Retour en arrière publié : $nouveauNom ($nouveauCode)." -ForegroundColor Green
}
