# Copia guidata del database (Render -> Neon). Doppio clic non serve: lancia dal terminale con
#   powershell -ExecutionPolicy Bypass -File tools\copia-database.ps1
# Le due stringhe di collegamento vengono chieste a schermo, nascoste, e non vengono salvate da nessuna parte.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Ask($label) {
  $secure = Read-Host -AsSecureString $label
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  return $plain.Trim()
}

Write-Host ""
Write-Host "COPIA DEL DATABASE delle tessere" -ForegroundColor Cyan
Write-Host "Il database attuale (Render) viene solo letto: nulla viene cancellato."
Write-Host ""
$env:SORGENTE = Ask "1) Incolla la External Database URL di Render e premi Invio"
$env:DESTINAZIONE = Ask "2) Incolla la connection string di Neon e premi Invio"
Write-Host ""
node tools/copia-database.js
$code = $LASTEXITCODE
Remove-Item Env:SORGENTE, Env:DESTINAZIONE
Write-Host ""
if ($code -eq 0) { Write-Host "Fatto. Scrivi 'copiato' a Claude." -ForegroundColor Green }
else { Write-Host "Qualcosa non va: copia questo messaggio a Claude. Il database attuale non e' stato toccato." -ForegroundColor Yellow }
