# Logo largo per l'intestazione della tessera Google Wallet (wideProgramLogo, 1280x400, PNG trasparente).
# Su Android sostituisce il logo rotondo + nome del locale.
# Uso: powershell -File tools/gen-wide-logo.ps1 -Name "Pizzeria Da Mario"
param([string]$Name = 'Pizzeria Da Mario', [string]$Tagline = '')
if (-not $Tagline) { $Tagline = 'TESSERA FEDELT' + [char]0x00C0 }  # "À" senza problemi di codifica del file

Add-Type -AssemblyName System.Drawing
$W = 1280; $H = 400
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)

# Icona pizza (stessa usata nei timbri)
$icon = [System.Drawing.Image]::FromFile((Join-Path $PSScriptRoot '..\public\stamps\pizza.png'))
$g.DrawImage($icon, 30, 60, 280, 280)
$icon.Dispose()

# Testo come tracciato vettoriale: dimensione in pixel precisa, adattata alla larghezza disponibile
function Text-Path($text, $family, $style, $size, $x, $y) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddString($text, (New-Object System.Drawing.FontFamily $family), [int]$style, [float]$size, (New-Object System.Drawing.PointF ([float]$x, [float]$y)), [System.Drawing.StringFormat]::GenericTypographic)
  return $p
}
$maxW = $W - 350 - 30
$size = 150
do {
  $path = Text-Path $Name 'Georgia' 1 $size 340 0
  $b = $path.GetBounds(); $size -= 4
} while ($b.Width -gt $maxW -and $size -gt 40)
$tag = Text-Path $Tagline 'Segoe UI Semibold' 0 ($size * 0.42) 344 0
$tb = $tag.GetBounds()

# centra verticalmente il blocco nome + sottotitolo
$gapY = $size * 0.18
$top = ($H - ($b.Height + $gapY + $tb.Height)) / 2
$m = New-Object System.Drawing.Drawing2D.Matrix; $m.Translate(0, [float]($top - $b.Top)); $path.Transform($m)
$m2 = New-Object System.Drawing.Drawing2D.Matrix; $m2.Translate(0, [float]($top + $b.Height + $gapY - $tb.Top)); $tag.Transform($m2)

$sh = $path.Clone(); $ms = New-Object System.Drawing.Drawing2D.Matrix; $ms.Translate(5, 6); $sh.Transform($ms)
$g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(80, 0, 0, 0))), $sh)
$g.FillPath([System.Drawing.Brushes]::White, $path)
$g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#ffcf4a'))), $tag)

$out = Join-Path $PSScriptRoot '..\public\wide-logo.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "Creato $out"
