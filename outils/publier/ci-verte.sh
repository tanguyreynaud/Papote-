#!/usr/bin/env bash
# Vérifie que la CI d'un commit est verte avant de le publier (bouton « Publier », .github/workflows/publier.yml).
# Usage : outils/publier/ci-verte.sh <sha> <nom lisible>
# Regarde chaque vérification (workflow) lancée sur ce commit, garde la plus récente de chacune (une relance remplace
# l'échec ; un même commit poussé ensuite sur main ou l'admin relance la CI : la dernière vérification TERMINÉE
# compte, une relance encore en cours ou annulée ne bloque pas un commit déjà vérifié).
# Une vérification encore en file ou en cours (et jamais terminée sur ce commit) : on ATTEND qu'elle finisse
# (nouveau regard toutes les 60 s, 60 min au plus) au lieu de refuser (Tanguy, 18/11 : publier juste après une fusion).
# Refus : une vérification rouge (tout de suite, sans attendre les autres), aucune vérification sur ce commit, ou
# encore en cours au bout de 60 min. Le bouton « Publier » lui-même est ignoré.
# CI_VERTE_PAS / CI_VERTE_MAX (secondes) : pas et attente maximale (60 et 3600 par défaut), réglables pour les essais.
set -euo pipefail
sha="$1"; nom="$2"
pas="${CI_VERTE_PAS:-60}"
max="${CI_VERTE_MAX:-3600}"
debut=$(date +%s)
court="${sha:0:7}"

while :; do
  ecoule=$(( $(date +%s) - debut ))
  if ! json=$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs?head_sha=${sha}&per_page=100"); then
    # Panne passagère de l'API GitHub : on retente au prochain tour (dans la limite de l'attente).
    if [ "$ecoule" -ge "$max" ]; then
      echo "::error::${nom} (${court}) : impossible de lire la CI sur GitHub. Publication refusée."
      exit 1
    fi
    echo "  GitHub ne répond pas, nouvel essai dans ${pas} s."
    sleep "$pas"; continue
  fi
  lignes=$(jq -r '[.workflow_runs[] | select(.name != "Publier")]
    | group_by(.name)
    | map(([.[] | select(.status == "completed" and .conclusion != "cancelled")] | max_by([.created_at, .run_attempt]))
          // max_by([.created_at, .run_attempt])) | .[]
    | "\(.name)\t\(.status)\t\(.conclusion // "")"' <<<"$json")
  if [ -z "$lignes" ]; then
    echo "::error::${nom} (${court}) : aucune vérification n'a tourné sur ce commit. Publication refusée."
    exit 1
  fi

  verts=(); rouges=(); encours=()
  while IFS=$'\t' read -r n etat fin; do
    if [ "$etat" = completed ]; then
      if [ "$fin" = success ] || [ "$fin" = skipped ]; then verts+=("$n"); else rouges+=("$n : ${fin:-sans résultat}"); fi
    else
      encours+=("$n : $etat")
    fi
  done <<<"$lignes"

  if [ "${#rouges[@]}" -gt 0 ] || [ "${#encours[@]}" -eq 0 ]; then
    echo "Vérifications de ${nom} (${court}) :"
    for v in "${verts[@]}"; do echo "  ✓ $v"; done
    for r in "${rouges[@]}"; do echo "  ✗ $r"; done
    for e in "${encours[@]}"; do echo "  … $e (pas attendue : une autre est déjà rouge)"; done
    if [ "${#rouges[@]}" -gt 0 ]; then
      echo "::error::${nom} (${court}) : CI pas verte. Publication refusée."
      exit 1
    fi
    exit 0
  fi

  if [ "$ecoule" -ge "$max" ]; then
    echo "Vérifications de ${nom} (${court}) :"
    for v in "${verts[@]}"; do echo "  ✓ $v"; done
    for e in "${encours[@]}"; do echo "  ✗ $e"; done
    echo "::error::${nom} (${court}) : CI toujours en cours après $(( max / 60 )) min d'attente. Publication refusée (relancer « Publier » plus tard)."
    exit 1
  fi
  liste=$(printf '%s, ' "${encours[@]}"); liste="${liste%, }"
  echo "${nom} (${court}) : ${#verts[@]} vérification(s) verte(s), ${#encours[@]} encore en cours (${liste}). Attente : $(( ecoule / 60 )) min sur $(( max / 60 )) au plus, nouveau regard dans ${pas} s."
  sleep "$pas"
done
