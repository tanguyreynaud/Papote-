# Retour en arrière : republie le code d'une version déjà publiée, avec un numéro plus grand (Android refuse
# d'installer un numéro plus petit). Mode d'emploi complet : installation\LISEZMOI-MISES-A-JOUR.md.
#
#   Liste des versions publiées : git tag -l "tablette-*"
#   Essai sans rien publier     : powershell -ExecutionPolicy Bypass -File installation\revenir-en-arriere.ps1 -Depuis tablette-v2.99.64-171 -Essai
#   D'abord la tablette de test : powershell -ExecutionPolicy Bypass -File installation\revenir-en-arriere.ps1 -Depuis tablette-v2.99.64-171 -Test
#   Puis toutes les tablettes   : powershell -ExecutionPolicy Bypass -File installation\revenir-en-arriere.ps1 -Depuis tablette-v2.99.64-171
param(
    [Parameter(Mandatory = $true)][string]$Depuis,
    [switch]$Test,
    [switch]$Essai
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'maj-commun.ps1')

# Pas de garde-fou « 30 jours » ici : un retour en arrière est par nature une urgence.
Invoke-RetourArriere -Depuis $Depuis -Test:$Test -Essai:$Essai | Out-Null
