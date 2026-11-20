#!/usr/bin/env bash
# Avant chaque push d'un fil : ce que la CI va vérifier, en local et en quelques minutes, pour ne plus recevoir des
# dizaines d'e-mails « Run failed » (Tanguy, 18/11). Même fichier sur main et sur l'admin
# (claude/project-thread-dlattc) : il reconnaît la branche où il tourne.
#
#   outils/verifier-avant-pousser.sh             les commits pas encore sur GitHub, et les parties qu'ils touchent
#   outils/verifier-avant-pousser.sh --tout      tout ce qui diffère du tronc (origin/main ou l'admin), pas
#                                                seulement les commits pas encore poussés
#   outils/verifier-avant-pousser.sh --complet   en plus : parcours client (functions), tous les scénarios de
#                                                l'app famille (une dizaine de minutes), comme la CI
#   outils/verifier-avant-pousser.sh --secrets   seulement la recherche de secrets (quelques secondes)
#
# Ce qui est vérifié, selon les fichiers touchés :
#   tout                  secrets (gitleaks, même version et même .gitleaks.toml que .github/workflows/secrets.yml)
#                         dans les commits à pousser ; et, pour information, dans toutes les branches de GitHub
#                         (la CI « Secrets » les lit toutes : un secret sur une branche la rend rouge partout)
#   functions/            npm test (tests unitaires) ; --complet : npm run parcours
#   outils/admin/         copie chiffrée des sauvegardes (node --test outils/admin/chiffrement.test.js)
#   vitrine/, outils/galerie/, functions/mail*
#                         balayage accessibilité du site (galerie.js --accessibilite vitrine) et parcours de
#                         commande sur téléphone (commande-site.test.js), comme balayages.yml de main
#   web/                  balayage accessibilité de l'app famille et/ou de l'admin (galerie.js de main, comme
#                         balayages.yml de l'admin) ; tests sans dépendance (tests/reseau, tests/promesses-app)
#   firestore.rules, storage*.rules, tests/regles/
#                         tests des règles (tests/regles, npm test, émulateurs)
#   tests/app-famille/scenarios/x.test.js
#                         ces scénarios-là (émulateurs) ; --complet : tous
#
# Code de sortie 1 si une vérification échoue : ne pas pousser, corriger d'abord.
# Il faut : git, Node 22, curl (gitleaks est téléchargé une fois dans ~/.cache/papote), Java 21 pour les émulateurs.
set -uo pipefail
# Tout le script entre accolades : bash le lit en entier avant de commencer, un fichier changé pendant qu'il tourne
# (git checkout, git pull d'une autre branche pendant les scénarios) ne le fait plus dérailler.
{

DEBUT=$(date +%s)
TOUT=0; COMPLET=0; SECRETS_SEULS=0
for a in "$@"; do
  case "$a" in
    --tout) TOUT=1 ;;
    --complet) COMPLET=1 ;;
    --secrets) SECRETS_SEULS=1 ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Option inconnue : $a (voir --help)"; exit 2 ;;
  esac
done

RACINE=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "Pas dans un dépôt git."; exit 2; }
cd "$RACINE" || exit 2
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/papote"
mkdir -p "$CACHE"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

RESULTATS=()   # « OK|ÉCHEC|SAUTÉ<tab>étape<tab>durée<tab>détail »
ECHECS=0
noter() { RESULTATS+=("$1"$'\t'"$2"$'\t'"$3"$'\t'"${4:-}"); [ "$1" = "ÉCHEC" ] && ECHECS=$((ECHECS + 1)); return 0; }
titre() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# Lance une étape : etape "nom" commande... ; sortie dans un journal, affichée en entier si elle échoue.
etape() {
  local nom="$1"; shift
  # Nom court et fixe (numéro de l'étape) : construit sur le nom de l'étape, il dépassait la longueur permise
  # quand plusieurs scénarios étaient touchés (« File name too long »).
  N_ETAPE=$(( ${N_ETAPE:-0} + 1 ))
  local journal="$TMP/etape-$N_ETAPE.log"
  titre "$nom"
  local t0; t0=$(date +%s)
  # (les lignes de progression « \r 12/172 écrans » de la galerie sont retirées du journal affiché)
  if "$@" >"$journal" 2>&1; then
    tr '\r' '\n' <"$journal" | grep -Ev '^ *$|[0-9]+/[0-9]+ [a-zé]' | tail -n 4
    noter OK "$nom" "$(( $(date +%s) - t0 )) s"
  else
    tr '\r' '\n' <"$journal" | grep -Ev '^ *$|[0-9]+/[0-9]+ [a-zé]' | tail -n 80
    noter ÉCHEC "$nom" "$(( $(date +%s) - t0 )) s" "voir ci-dessus (journal complet : relancer la commande à la main)"
  fi
}

# ---------- Où suis-je, qu'est-ce qui part ----------

git fetch --quiet origin 2>/dev/null || echo "(pas de réseau : on compare avec la dernière copie de GitHub connue)"
BRANCHE=$(git rev-parse --abbrev-ref HEAD)
if [ -d tests/app-famille ] && [ -d web ]; then
  TRONC=origin/claude/project-thread-dlattc; GENRE=admin
elif [ -d functions ]; then
  TRONC=origin/main; GENRE=main
else
  TRONC=""; GENRE=autre
fi
A_POUSSER=$(git rev-list --count HEAD --not --remotes=origin 2>/dev/null || echo 0)
echo "Branche $BRANCHE (tronc : ${TRONC:-aucun}), $A_POUSSER commit(s) pas encore sur GitHub."

if [ "$TOUT" = 1 ] && [ -n "$TRONC" ]; then
  FICHIERS=$(git diff --name-only "$(git merge-base HEAD "$TRONC")" HEAD)
else
  FICHIERS=$(git log --format= --name-only HEAD --not --remotes=origin | sort -u)
fi
SALE=$(git status --porcelain --untracked-files=no)
[ -n "$SALE" ] && echo "Attention : des changements ne sont pas encore dans un commit (ils sont testés ici, mais ne partiront pas au push) :" && echo "$SALE" | head -10
# Les changements pas encore commités comptent aussi pour choisir les vérifications (on teste les fichiers du disque).
FICHIERS=$(printf '%s\n%s\n' "$FICHIERS" "$(git diff --name-only HEAD)" | sed '/^$/d' | sort -u)
# Un texte (.md) seul ne casse aucun test : il ne déclenche rien ici (la CI, elle, relance quand même).
touche() { echo "$FICHIERS" | grep -v '\.md$' | grep -Eq "$1"; }

# ---------- Secrets (gitleaks, comme .github/workflows/secrets.yml) ----------

gitleaks_bin() {
  local version
  version=$(git show "${TRONC:-HEAD}:.github/workflows/secrets.yml" 2>/dev/null | sed -n 's/^ *VERSION: *\([0-9.]*\).*/\1/p' | head -1)
  version=${version:-8.21.2}
  local dossier="$CACHE/gitleaks-$version" exe=gitleaks
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) exe=gitleaks.exe ;; esac
  if [ ! -x "$dossier/$exe" ]; then
    mkdir -p "$dossier"
    local os arch
    case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) os=windows ;; esac
    case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) arch=x64 ;; esac
    local url="https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_${os}_${arch}"
    echo "Téléchargement de gitleaks $version (une seule fois, dans $dossier)…" >&2
    if [ "$os" = windows ]; then
      curl -sSfL --retry 3 "$url.zip" -o "$dossier/g.zip" && (cd "$dossier" && unzip -oq g.zip "$exe") && rm -f "$dossier/g.zip"
    else
      curl -sSfL --retry 3 "$url.tar.gz" | tar -xz -C "$dossier" gitleaks \
        || (command -v go >/dev/null && GOBIN="$dossier" go install "github.com/zricethezav/gitleaks/v8@v${version}")
    fi
  fi
  [ -x "$dossier/$exe" ] && echo "$dossier/$exe"
}

# Affiche les trouvailles d'un rapport JSON de gitleaks, avec les branches de GitHub qui contiennent chaque commit.
lire_rapport() {
  node -e '
    const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8") || "[]");
    for (const f of l) console.log(`${f.Commit} ${f.RuleID} dans ${f.File}:${f.StartLine} (commit « ${(f.Message || "").split("\n")[0].slice(0, 60)} »)`);
  ' "$1" | while read -r sha reste; do
    local branches
    branches=$(git branch -r --contains "$sha" 2>/dev/null | sed 's/^ *origin\///' | grep -v HEAD | tr '\n' ' ')
    echo "  - commit ${sha:0:8} : $reste"
    [ -n "$branches" ] && echo "    sur GitHub dans : $branches"
  done
}

GL=$(gitleaks_bin)
if [ -z "$GL" ]; then
  noter ÉCHEC "Secrets" "-" "gitleaks introuvable (pas de réseau ?)"
else
  titre "Secrets dans les commits à pousser"
  t0=$(date +%s)
  if [ "$A_POUSSER" = 0 ]; then
    echo "Aucun commit à pousser."
    noter SAUTÉ "Secrets (commits à pousser)" "0 s" "rien à pousser"
  elif "$GL" git --redact --no-banner --config .gitleaks.toml --exit-code 1 \
      --log-opts="HEAD --not --remotes=origin" --report-format json --report-path "$TMP/gl.json" . >"$TMP/gl.log" 2>&1; then
    sed 's/\x1b\[[0-9;]*m//g' "$TMP/gl.log" | grep -E "commits scanned|no leaks" | sed 's/^.*INF *//'
    noter OK "Secrets (commits à pousser)" "$(( $(date +%s) - t0 )) s"
  else
    echo "Secret trouvé : la CI « Secrets » sera rouge. Retirez-le de l'historique avant de pousser (git rebase -i /"
    echo "git commit --amend sur ces commits pas encore poussés), ou, si c'est une fausse alerte (valeur publique ou de"
    echo "test), demandez à Tanguy : on ne touche jamais seul à .gitleaks.toml."
    lire_rapport "$TMP/gl.json"
    grep -E "ERR|error" "$TMP/gl.log" | head -5
    noter ÉCHEC "Secrets (commits à pousser)" "$(( $(date +%s) - t0 )) s" "voir ci-dessus"
  fi

  # La CI lit toutes les branches (actions/checkout fetch-depth: 0, gitleaks git sans --log-opts) : un secret poussé
  # sur une autre branche la rend rouge sur chaque push, quelle que soit la branche. Dit ici, sans bloquer.
  titre "Secrets sur toutes les branches de GitHub (comme la CI)"
  t0=$(date +%s)
  if "$GL" git --redact --no-banner --config .gitleaks.toml --exit-code 1 \
      --log-opts="--remotes=origin" --report-format json --report-path "$TMP/gl-tout.json" . >"$TMP/gl-tout.log" 2>&1; then
    sed 's/\x1b\[[0-9;]*m//g' "$TMP/gl-tout.log" | grep -E "commits scanned" | sed 's/^.*INF *//'
    noter OK "Secrets (toutes les branches)" "$(( $(date +%s) - t0 )) s"
  else
    echo "ATTENTION : la CI « Secrets » sera rouge sur CHAQUE branche tant que ceci reste sur GitHub (pas forcément de"
    echo "votre fait) : prévenir le fil de la branche concernée."
    lire_rapport "$TMP/gl-tout.json"
    noter "ATTENTION" "Secrets (toutes les branches)" "$(( $(date +%s) - t0 )) s" "CI Secrets rouge partout, voir ci-dessus"
  fi
fi

# ---------- Tests selon les parties touchées ----------

npm_pret() { # npm_pret dossier : npm ci si node_modules manque
  [ -d "$1/node_modules" ] || (cd "$1" && npm ci --no-audit --no-fund >/dev/null 2>&1) || (cd "$1" && npm install --no-audit --no-fund >/dev/null 2>&1)
}

# outils/galerie de main, prêt à tourner : sur main le dossier du disque ; ailleurs une copie de origin/main dans le
# cache (comme balayages.yml de l'admin, qui prend l'outil sur main), avec web/ de cette branche copié à côté.
galerie_prete() {
  local dossier
  if [ "$GENRE" = main ]; then
    dossier="$RACINE/outils/galerie"
  else
    local sha; sha=$(git rev-parse origin/main:outils/galerie 2>/dev/null) || return 1
    local base="$CACHE/galerie-main"
    dossier="$base/outils/galerie"
    if [ "$(cat "$base/ARBRE" 2>/dev/null)" != "$sha" ]; then
      rm -rf "$base/outils"; mkdir -p "$base"
      git archive --format=tar origin/main outils/galerie | tar -x -C "$base" || return 1
      echo "$sha" > "$base/ARBRE"
    fi
    rm -rf "$base/web" && cp -r "$RACINE/web" "$base/web"
  fi
  if [ ! -d "$dossier/node_modules/axe-core" ]; then
    (cd "$dossier" && npm install --no-audit --no-fund >/dev/null 2>&1) || return 1
  fi
  # Navigateur de la version de Playwright de l'outil ; sans réseau pour l'installer, celui de la machine.
  if ! (cd "$dossier" && node -e 'process.exit(require("fs").existsSync(require("playwright").chromium.executablePath()) ? 0 : 1)' 2>/dev/null); then
    (cd "$dossier" && npx playwright install chromium >/dev/null 2>&1) \
      || { echo "(Chromium de Playwright non installable : Playwright de la machine utilisé)" >&2; rm -rf "$dossier/node_modules/playwright" "$dossier/node_modules/playwright-core"; }
  fi
  echo "$dossier"
}

emulateurs() { # emulateurs dossier config commande : comme les package.json des tests
  npx --yes firebase-tools@14 emulators:exec --only "$1" --project demo-papote --config "$2" "$3"
}

if [ "$SECRETS_SEULS" = 0 ]; then
  [ -z "$FICHIERS" ] && echo && echo "Aucun fichier touché : rien d'autre à vérifier (--tout pour comparer avec le tronc)."

  if [ "$GENRE" = main ]; then
    if touche '^functions/'; then
      npm_pret functions
      etape "Fonctions : tests unitaires (npm test)" bash -c 'cd functions && npm test'
      [ "$COMPLET" = 1 ] && etape "Fonctions : parcours client (émulateurs)" bash -c 'cd functions && npm run parcours'
    fi
    if touche '^outils/admin/'; then
      etape "Sauvegardes : copie chiffrée" bash -c 'cd functions && node --test ../outils/admin/chiffrement.test.js'
    fi
    if touche '^(vitrine/|outils/galerie/|functions/mail)'; then
      if G=$(galerie_prete); then
        etape "Site : balayage accessibilité (--accessibilite vitrine)" bash -c "cd '$G' && node galerie.js --accessibilite vitrine --vitrine=ici --emails=ici"
        etape "Site : parcours de commande sur téléphone (commande-site.test.js)" bash -c "cd '$G' && NAVIGATEUR=chromium node --test commande-site.test.js"
      else
        noter ÉCHEC "Site : balayages" "-" "outils/galerie pas prêt (npm install ?)"
      fi
    fi
  fi

  if [ "$GENRE" = admin ]; then
    if touche '^web/'; then
      etape "App : tests sans dépendance (réseau, promesses)" node --test tests/reseau.test.mjs tests/promesses-app.test.js tests/entetes-securite.test.js tests/polices.test.js
      # Admin seulement si ses fichiers bougent ; famille.css sert aux deux.
      ADMIN='^web/(admin\.html|js/(admin|gestion|gestion-api|statistiques|validation|validation-donnees)\.js|css/(admin|gestion|validation|famille)\.css)$'
      FAMILLE=0; ADMIN_TOUCHE=0
      echo "$FICHIERS" | grep '^web/' | grep -Evq "$ADMIN" && FAMILLE=1
      echo "$FICHIERS" | grep -Eq "$ADMIN" && ADMIN_TOUCHE=1
      echo "$FICHIERS" | grep -Eq '^web/css/famille\.css$' && FAMILLE=1
      PARTIES=$( { [ "$FAMILLE" = 1 ] && echo famille; [ "$ADMIN_TOUCHE" = 1 ] && echo admin; } | tr '\n' ' ' | sed 's/ $//')
      if G=$(galerie_prete); then
        etape "App : balayage accessibilité (--accessibilite $PARTIES)" bash -c "cd '$G' && node galerie.js --accessibilite $PARTIES --famille=ici --admin=ici"
      else
        noter ÉCHEC "App : balayage accessibilité" "-" "outils/galerie de main pas prêt (git fetch, npm install ?)"
      fi
    fi
    if touche '^(firestore(-origine)?\.rules|storage(-eu)?\.rules|firebase\.json|tests/regles/)'; then
      npm_pret tests/regles
      etape "Règles Firestore et Storage (tests/regles)" bash -c 'cd tests/regles && npm test'
    fi
    # La CI coupe les scénarios en morceaux parallèles : un scénario ajouté mais rangé dans aucun morceau la rend rouge.
    if touche '^tests/app-famille/(scenarios/|morceaux\.js)'; then
      etape "App famille : chaque scénario dans exactement un morceau (morceaux.js)" node tests/app-famille/morceaux.js verifier
    fi
    SCENARIOS=$(echo "$FICHIERS" | grep -E '^tests/app-famille/scenarios/[^/]+\.test\.js$' | sed 's#^tests/app-famille/##' | while read -r f; do [ -f "tests/app-famille/$f" ] && echo "$f"; done | tr '\n' ' ')
    if [ "$COMPLET" = 1 ] && touche '^(web/|firestore\.rules|storage-eu\.rules|tests/app-famille/)'; then
      npm_pret tests/app-famille
      etape "App famille : tous les scénarios (npm test)" bash -c 'cd tests/app-famille && npm test'
    elif [ -n "$SCENARIOS" ]; then
      npm_pret tests/app-famille
      etape "App famille : scénarios touchés ($SCENARIOS)" bash -c "cd tests/app-famille && node preparer.js && npx --yes firebase-tools@14 emulators:exec --only firestore,auth,storage --project demo-papote --config firebase.json \"node --test --test-concurrency=1 --test-timeout=600000 --test-reporter=spec $SCENARIOS\""
    fi
    if [ "$COMPLET" = 0 ] && touche '^(web/|tests/app-famille/(banc|gestes|tablette)\.js)'; then
      echo
      echo "(Les scénarios de l'app famille, une dizaine de minutes, ne sont lancés qu'avec --complet ; la CI les passe.)"
    fi
  fi
fi

# ---------- Résumé ----------

titre "Résumé"
for r in "${RESULTATS[@]}"; do
  IFS=$'\t' read -r etat nom duree detail <<<"$r"
  printf '  %-10s %-72s %6s  %s\n' "$etat" "$nom" "$duree" "$detail"
done
TOTAL=$(( $(date +%s) - DEBUT ))
echo
if [ "$ECHECS" -gt 0 ]; then
  echo "ÉCHEC : $ECHECS vérification(s) en erreur ($TOTAL s). Ne pas pousser avant de corriger."
  exit 1
fi
echo "Tout est bon ($TOTAL s) : vous pouvez pousser."
exit 0
}
