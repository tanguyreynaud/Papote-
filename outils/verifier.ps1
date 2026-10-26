# Vérifie tout avant une publication : lance tous les tests sur les versions EXACTES qui vont partir
# (fonctions depuis origin/main, site et règles depuis dlattc, tablette depuis cmnwxy) et s'arrête net
# au premier échec. Rien n'est envoyé en ligne : émulateurs Firebase et navigateur caché seulement.
#
# Utilisation (depuis n'importe quel dossier du projet) :
#   .\outils\verifier.bat              tout (environ 5 minutes)
#   .\outils\verifier.bat fonctions    avant « firebase deploy --only functions »
#   .\outils\verifier.bat site         avant la publication de l'app famille et des règles
#   .\outils\verifier.bat tablette     avant la publication d'une version de la tablette
#
# Les copies vérifiées sont dans %LOCALAPPDATA%\papote-verif (dossiers à part, gérés par ce script :
# jamais le dossier où l'on travaille). Code de sortie 0 si tout est bon, 1 sinon.
param(
    [ValidateSet('tout', 'fonctions', 'site', 'tablette')]
    [string]$Quoi = 'tout',
    [string]$Fonctions = 'origin/main',
    [string]$Site = 'origin/claude/project-thread-dlattc',
    [string]$Tablette = 'origin/claude/project-thread-cmnwxy',
    [switch]$SansPause
)

# Continue : chaque commande est contrôlée à la main (PowerShell 5 prend le stderr de git pour une erreur).
$ErrorActionPreference = 'Continue'
$Debut = Get-Date
$Racine = (& git -C (Join-Path $PSScriptRoot '..') rev-parse --show-toplevel 2>$null)
$Dossier = Join-Path $env:LOCALAPPDATA 'papote-verif'
New-Item -ItemType Directory -Force -Path $Dossier | Out-Null

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Fin($code) {
    if (-not $SansPause) { Read-Host "`nAppuyez sur Entrée pour fermer" | Out-Null }
    exit $code
}
function Echec($titre, $journal) {
    Say "`n!!! ÉCHEC : $titre" 'Red'
    if ($journal -and (Test-Path $journal)) {
        Say "--- fin du journal ($journal) ---" 'DarkGray'
        Get-Content -Encoding UTF8 $journal | Select-Object -Last 40 | ForEach-Object { Say "  $_" 'DarkGray' }
    }
    Say "`n=== NE PAS PUBLIER. Copiez ce message à Claude. ===" 'Red'
    Fin 1
}

# Lance une commande dans un dossier, sortie dans un journal ; renvoie le code de sortie.
# cmd /c : PowerShell 5 prendrait les messages de npm sur stderr pour des erreurs.
function Lancer($dossier, $commande, $journal) {
    Push-Location $dossier
    try { & cmd /c "($commande) > `"$journal`" 2>&1" } finally { Pop-Location }
    return $LASTEXITCODE
}

$script:Numero = 0
function Etape($titre, $dossier, $commande, [scriptblock]$Controle) {
    $script:Numero++
    $journal = Join-Path $Dossier ("journal-{0}.txt" -f $script:Numero)
    Write-Host ("{0}. {1}… " -f $script:Numero, $titre) -NoNewline
    $t = Get-Date
    $code = Lancer $dossier $commande $journal
    $probleme = if ($code -ne 0) { "code de sortie $code" } elseif ($Controle) { & $Controle $journal } else { $null }
    if ($probleme) { Say 'ÉCHEC' 'Red'; Echec "$titre ($probleme)" $journal }
    Say ("OK ({0:N0} s)" -f ((Get-Date) - $t).TotalSeconds) 'Green'
}

# Copie vérifiée d'une branche (git worktree) : créée la première fois, puis remise sur le bon commit.
function Copie($nom, $ref) {
    $dir = Join-Path $Dossier $nom
    $sha = (& git -C $Racine rev-parse --verify --quiet "$ref^{commit}")
    if (-not $sha) { Echec "branche introuvable : $ref" }
    if (-not (Test-Path (Join-Path $dir '.git'))) {
        & git -C $Racine worktree prune 2>$null
        if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
        & cmd /c "git -C `"$Racine`" worktree add --detach `"$dir`" $sha >nul 2>&1"
        if ($LASTEXITCODE) { Echec "copie de $ref impossible dans $dir" }
    } else {
        # Dossier réservé à ce script : on peut l'écraser sans risque (node_modules est gardé).
        & cmd /c "git -C `"$dir`" checkout --quiet --detach --force $sha >nul 2>&1"
        if ($LASTEXITCODE) { Echec "mise à jour de $dir impossible" }
        & cmd /c "git -C `"$dir`" clean -fdq -e node_modules >nul 2>&1"
    }
    return [pscustomobject]@{ Dir = $dir; Sha = $sha.Substring(0, 7); Ref = $ref }
}

# npm ci seulement si package-lock.json a changé depuis la dernière fois.
function Modules($dossier, $titre) {
    $lock = Join-Path $dossier 'package-lock.json'
    $marque = Join-Path $dossier 'node_modules\.verif-lock'
    $empreinte = (Get-FileHash $lock -Algorithm SHA256).Hash
    if ((Test-Path $marque) -and (Get-Content $marque) -eq $empreinte) { return }
    Etape "Installation des modules ($titre, une seule fois)" $dossier 'npm ci --no-audit --no-fund'
    Set-Content -Path $marque -Value $empreinte
}

Say "=== Vérification avant publication ($Quoi) ===`n" 'Cyan'

if (-not $Racine) { Echec "ce script doit rester dans le dossier du projet (dépôt git)" }
foreach ($outil in @('git', 'node', 'npm')) {
    if (-not (Get-Command $outil -ErrorAction SilentlyContinue)) { Echec "$outil n'est pas installé sur ce PC" }
}
$avecEmulateurs = $Quoi -in @('tout', 'fonctions', 'site')
if ($avecEmulateurs -and -not (Get-Command java -ErrorAction SilentlyContinue)) {
    Echec "Java (11 ou plus) est nécessaire aux émulateurs Firebase : installer « Temurin 21 » depuis adoptium.net, puis relancer"
}

# Dernières versions publiées sur GitHub (rien n'est modifié dans le dossier de travail).
& cmd /c "git -C `"$Racine`" fetch --quiet origin main claude/project-thread-dlattc claude/project-thread-cmnwxy 2>&1"
if ($LASTEXITCODE) { Echec "pas de réseau : impossible de lire les dernières versions sur GitHub" }

$copies = @()

if ($Quoi -in @('tout', 'fonctions')) {
    $f = Copie 'fonctions' $Fonctions
    $copies += $f
    Say "Fonctions : $($f.Ref) @ $($f.Sha)" 'Cyan'
    $fn = Join-Path $f.Dir 'functions'
    Modules $fn 'fonctions'
    Etape 'Tests unitaires des fonctions' $fn 'npm test'
    Etape 'Parcours client complet (émulateurs, environ 1 min)' $fn 'npm run parcours'
}

if ($Quoi -in @('tout', 'site')) {
    $s = Copie 'site' $Site
    $copies += $s
    Say "Site et règles : $($s.Ref) @ $($s.Sha)" 'Cyan'
    $regles = Join-Path $s.Dir 'tests\regles'
    if (-not (Test-Path (Join-Path $regles 'package.json'))) { Echec "tests des règles absents de $($s.Ref)" }
    Modules $regles 'règles'
    Etape 'Tests des règles Firestore (émulateur)' $regles 'npm test'
    # Tests de bout en bout de l'app famille (tests/app-famille, fil « Tester l'app famille
    # automatiquement ») : vraies pages + fonctions de main sur les émulateurs ; sautés s'ils manquent.
    $appFamille = Join-Path $s.Dir 'tests\app-famille'
    if (Test-Path (Join-Path $appFamille 'package.json')) {
        if (Test-Path (Join-Path $appFamille 'package-lock.json')) { Modules $appFamille 'app famille' }
        elseif (-not (Test-Path (Join-Path $appFamille 'node_modules'))) {
            Etape "Installation des modules (app famille, une seule fois)" $appFamille 'npm install --no-audit --no-fund'
        }
        Etape "App famille de bout en bout (émulateurs, quelques minutes)" $appFamille 'npm test'
    } else {
        Say "Tests de bout en bout de l'app famille : pas encore dans $($s.Ref), étape sautée." 'Yellow'
    }
    if (Test-Path (Join-Path $s.Dir 'outils\web\verifier.mjs')) {
        Etape "Contrôle de l'app famille (syntaxe, imports, éléments)" $s.Dir 'node outils\web\verifier.mjs'
    }
}

if ($Quoi -in @('tout', 'tablette')) {
    $t = Copie 'tablette' $Tablette
    $copies += $t
    Say "Tablette : $($t.Ref) @ $($t.Sha)" 'Cyan'
    $assets = Join-Path $t.Dir 'android\app\src\main\assets'
    # appels.js est un module (import) : lu comme tel, quelle que soit la version de Node.
    $pages = @(Get-ChildItem -Path $assets -Filter *.js -Recurse | ForEach-Object {
        if (Select-String -Quiet -Path $_.FullName -Pattern '^\s*import\s') { "node --input-type=module --check < `"$($_.FullName)`"" }
        else { "node --check `"$($_.FullName)`"" }
    })
    Etape 'Pages de la tablette sans erreur de syntaxe' $t.Dir ($pages -join ' && ')
}

# Galerie (outils\galerie, arrivée avec la PR #225) : ouvre chaque écran avec de fausses données et
# signale toute erreur de la page. Elle lit elle-même les branches dlattc et cmnwxy.
$quelle = @{ tout = ''; site = 'famille'; tablette = 'tablette' }
if ($quelle.ContainsKey($Quoi)) {
    $g = Copie 'fonctions' $Fonctions
    $galerie = Join-Path $g.Dir 'outils\galerie'
    if (-not (Test-Path (Join-Path $galerie 'galerie.js'))) {
        Say "Galerie des écrans : pas encore dans $($g.Ref), étape sautée." 'Yellow'
    } else {
        if (-not (Test-Path (Join-Path $galerie 'node_modules\playwright'))) {
            Etape 'Installation de Playwright (une seule fois, environ 150 Mo)' $galerie 'npm install --no-audit --no-fund && npx playwright install chromium'
        }
        Etape 'Galerie : chaque écran ouvert sans erreur (environ 2 min)' $galerie "node galerie.js $($quelle[$Quoi])" {
            param($journal)
            # Texte ASCII pour ne pas dépendre de l'encodage de la console.
            $l = Get-Content -Encoding UTF8 $journal | Where-Object { $_ -match 'avec une erreur de la page' }
            if ($l) { "$l ouvrir $galerie\sortie\galerie.html" }
        }
        Say "   Captures : $galerie\sortie\galerie.html" 'DarkGray'
    }
}

Say ("`n=== Tout est bon ({0:N0} min). Versions vérifiées : ===" -f ((Get-Date) - $Debut).TotalMinutes) 'Green'
foreach ($c in ($copies | Sort-Object Ref -Unique)) { Say "  $($c.Ref) @ $($c.Sha)" 'Green' }
Say 'Publiez exactement ces versions (vérifiez le SHA affiché par git log -1 --oneline).' 'Green'
Fin 0
