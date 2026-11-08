# Retrouver une photo ou une vidéo effacée (Storage)

Les photos et vidéos ne sont pas copiées par la sauvegarde hebdomadaire : le bucket `papote-famille-eu` garde
lui-même **7 jours** tout fichier effacé ou remplacé (« suppression douce »). Coût : le stockage de ces fichiers
pendant 7 jours, soit quelques centimes par mois (0,023 $/Go/mois ; une famille pleine ≈ 0,45 Go).

## Vérifier / activer (une fois, PowerShell, gcloud installé et connecté au projet papote-famille)

```powershell
gcloud storage buckets describe gs://papote-famille-eu --format="value(soft_delete_policy)"
gcloud storage buckets update gs://papote-famille-eu --soft-delete-duration=7d
```

La première commande doit montrer `retentionDurationSeconds: 604800` (7 jours). Les buckets créés depuis 2024 l'ont
déjà par défaut ; la seconde l'impose dans tous les cas.

## Retrouver un fichier effacé (dans les 7 jours)

```powershell
gcloud storage ls --soft-deleted -r gs://papote-famille-eu/families/<fid>/
gcloud storage restore "gs://papote-famille-eu/families/<fid>/<nom du fichier>#<génération>"
```

La première commande liste les fichiers effacés de la famille avec leur numéro de génération ; la seconde remet le
fichier à sa place, à l'identique. Toute une famille : `gcloud storage restore "gs://papote-famille-eu/families/<fid>/**" --all-versions`.

Au-delà de 7 jours, le fichier est perdu. Une copie complète reste possible à la main : `.\sauvegarder.bat --photos --vers D:\…`.
