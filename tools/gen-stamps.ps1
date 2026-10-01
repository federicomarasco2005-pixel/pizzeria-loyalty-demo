# Genera le immagini "pallini" mostrate nella tessera Google Wallet (heroImage).
# Uso: powershell -File tools/gen-stamps.ps1 -Total 6
# Produce public/stamps/stamps-<Total>-<n>.png per n = 0..Total (sfondo trasparente).
param([int]$Total = 6)

Add-Type -AssemblyName System.Drawing
$outDir = Join-Path $PSScriptRoot '..\public\stamps'
New-Item -ItemType Directory -Force $outDir | Out-Null

$W = 1032; $H = 336
$gap = 22
$d = [Math]::Min(150, [Math]::Floor(($W - 80 - $gap * ($Total - 1)) / $Total))
$startX = ($W - ($d * $Total + $gap * ($Total - 1))) / 2
$y = ($H - $d) / 2

$white = [System.Drawing.Color]::White
$crust = [System.Drawing.ColorTranslator]::FromHtml('#d9963f')
$cheese = [System.Drawing.ColorTranslator]::FromHtml('#ffd36b')
$pepperoni = [System.Drawing.ColorTranslator]::FromHtml('#c0392b')
$basil = [System.Drawing.ColorTranslator]::FromHtml('#2e7d32')

function Draw-Pizza($g, $x, $y, $d) {
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $white), $x, $y, $d, $d)
  $m = $d * 0.12; $p = $d - 2 * $m
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $crust), $x + $m, $y + $m, $p, $p)
  $c = $p * 0.12
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $cheese), $x + $m + $c, $y + $m + $c, $p - 2 * $c, $p - 2 * $c)
  $cx = $x + $d / 2; $cy = $y + $d / 2; $r = $d * 0.085
  foreach ($o in @(@(-0.18, -0.16), @(0.17, -0.12), @(-0.05, 0.17), @(0.2, 0.15), @(-0.22, 0.08))) {
    $g.FillEllipse((New-Object System.Drawing.SolidBrush $pepperoni), $cx + $o[0] * $d - $r, $cy + $o[1] * $d - $r, 2 * $r, 2 * $r)
  }
  $b = $d * 0.05
  foreach ($o in @(@(0.02, -0.04), @(-0.1, 0.0))) {
    $g.FillEllipse((New-Object System.Drawing.SolidBrush $basil), $cx + $o[0] * $d - $b, $cy + $o[1] * $d - $b, 2 * $b, 2 * $b)
  }
}

for ($n = 0; $n -le $Total; $n++) {
  $bmp = New-Object System.Drawing.Bitmap $W, $H
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)
  for ($i = 0; $i -lt $Total; $i++) {
    $x = $startX + $i * ($d + $gap)
    if ($i -lt $n) {
      Draw-Pizza $g $x $y $d
    } else {
      $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(150, 255, 255, 255)), 6
      $pen.DashStyle = 'Dash'
      $g.DrawEllipse($pen, $x + 3, $y + 3, $d - 6, $d - 6)
      $font = New-Object System.Drawing.Font 'Segoe UI', ($d * 0.28), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
      $sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
      $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, 255, 255, 255))
      $g.DrawString([string]($i + 1), $font, $brush, (New-Object System.Drawing.RectangleF $x, $y, $d, $d), $sf)
    }
  }
  $bmp.Save((Join-Path $outDir "stamps-$Total-$n.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
# Icona singola usata dalla tessera web (stessa pizza del Wallet)
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)
Draw-Pizza $g 0 0 256
$bmp.Save((Join-Path $outDir 'pizza.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

Write-Output "Generate $($Total + 1) immagini + pizza.png in $outDir"
