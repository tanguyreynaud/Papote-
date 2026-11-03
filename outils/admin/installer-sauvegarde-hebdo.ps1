# Installe la sauvegarde automatique de Papote : chaque dimanche à 3 h (ou au prochain allumage du PC si
# celui-ci était éteint), sauvegarder.bat --auto --vers <dossier>, avec un journal dans <dossier>\journal.txt.
# Utilisation : .\installer-sauvegarde-hebdo.bat "G:\Mon Drive\PapoteSauvegardes"   (dossier par défaut : Documents\PapoteSauvegardes)
#               .\installer-sauvegarde-hebdo.bat -Retirer                 (supprime la tâche)
param([string]$Dossier = "$env:USERPROFILE\Documents\PapoteSauvegardes", [switch]$Retirer)

$ErrorActionPreference = 'Stop'
$Nom = 'Papote - sauvegarde hebdomadaire'
if ($Retirer) {
    Unregister-ScheduledTask -TaskName $Nom -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Tâche « $Nom » retirée." -ForegroundColor Green
    exit 0
}
$bat = Join-Path $PSScriptRoot 'sauvegarder.bat'
if (-not (Test-Path $bat)) { Write-Host "sauvegarder.bat introuvable à côté de ce script." -ForegroundColor Red; exit 1 }
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if (-not $node) { Write-Host "Node.js introuvable : installer Node 22 d'abord." -ForegroundColor Red; exit 1 }
$cle = Join-Path $env:USERPROFILE '.papote\cle-admin-firebase.json'
if (-not (Test-Path $cle)) { Write-Host "Clé d'administration introuvable : $cle" -ForegroundColor Red; exit 1 }
New-Item -ItemType Directory -Force -Path $Dossier | Out-Null

$commande = "/c `"`"$bat`" --auto --vers `"$Dossier`" >> `"$Dossier\journal.txt`" 2>&1`""
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $commande -WorkingDirectory $PSScriptRoot
$declencheur = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3:00
$reglages = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 3) -WakeToRun:$false
Register-ScheduledTask -TaskName $Nom -Action $action -Trigger $declencheur -Settings $reglages -Force | Out-Null
Write-Host "Tâche « $Nom » installée : chaque dimanche à 3 h (ou dès que le PC est rallumé), vers $Dossier." -ForegroundColor Green
Write-Host "Journal : $Dossier\journal.txt. Vérifier une fois par mois : .\verifier-sauvegarde.bat $Dossier\papote-<date>.json"
Write-Host "Premier essai maintenant..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $Nom
Start-Sleep -Seconds 5
Write-Host "Lancé : suivre dans $Dossier\journal.txt (quelques minutes). Copier ensuite le dossier hors du PC (clé USB, disque)."
