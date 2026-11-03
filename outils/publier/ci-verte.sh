#!/usr/bin/env bash
# Vérifie que la CI d'un commit est verte avant de le publier (bouton « Publier », .github/workflows/publier.yml).
# Usage : outils/publier/ci-verte.sh <sha> <nom lisible>
# Regarde chaque vérification (workflow) lancée sur ce commit, garde la plus récente de chacune (une relance remplace
# l'échec), et refuse s'il y en a une rouge, une encore en cours, ou aucune. Le bouton « Publier » lui-même est ignoré.
set -euo pipefail
sha="$1"; nom="$2"
json=$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs?head_sha=${sha}&per_page=100")
lignes=$(jq -r '[.workflow_runs[] | select(.name != "Publier")]
  | group_by(.name) | map(max_by([.created_at, .run_attempt])) | .[]
  | "\(.name)\t\(.status)\t\(.conclusion // "")"' <<<"$json")
if [ -z "$lignes" ]; then
  echo "::error::${nom} (${sha:0:7}) : aucune vérification n'a tourné sur ce commit. Publication refusée."
  exit 1
fi
echo "Vérifications de ${nom} (${sha:0:7}) :"
mauvais=0
while IFS=$'\t' read -r n etat fin; do
  if [ "$etat" = completed ] && { [ "$fin" = success ] || [ "$fin" = skipped ]; }; then
    echo "  ✓ $n"
  else
    echo "  ✗ $n : ${etat} ${fin}"; mauvais=1
  fi
done <<<"$lignes"
if [ "$mauvais" = 1 ]; then
  echo "::error::${nom} (${sha:0:7}) : CI pas verte. Publication refusée."
  exit 1
fi
