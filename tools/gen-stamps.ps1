# Genera le immagini dei timbri.
# Uso: powershell -File tools/gen-stamps.ps1 -Total 6
# Produce in public/stamps/:
#   grid-<Total>-<n>.png  striscia 1032x336 (immagine principale Google Wallet), sfondo trasparente,
#                         n pizze colorate (timbri ottenuti) + pizze scure (timbri mancanti)
#   pizza.png / pizza-empty.png  icone singole per la tessera web
#   .frames/  fotogrammi per le GIF animate (vedi tools/make-gifs.js)
# -BrandColor deve essere uguale a BRAND_COLOR (colore di sfondo della tessera).
param([int]$Total = 6, [string]$BrandColor = '#b3261e')

Add-Type -AssemblyName System.Drawing
$outDir = Join-Path $PSScriptRoot '..\public\stamps'
New-Item -ItemType Directory -Force $outDir | Out-Null

$C = { param($hex) [System.Drawing.ColorTranslator]::FromHtml($hex) }
$full = @{ shadow = [System.Drawing.Color]::FromArgb(70, 0, 0, 0); crust = & $C '#e0a04a'; crustEdge = & $C '#b8772c'
           cheese = & $C '#ffd76e'; spot = & $C '#ffe9a8'; pepperoni = & $C '#c62828'; basil = & $C '#2e7d32' }
$dark = @{ shadow = [System.Drawing.Color]::FromArgb(40, 0, 0, 0); crust = & $C '#2a2a2a'; crustEdge = & $C '#1c1c1c'
           cheese = & $C '#3a3a3a'; spot = & $C '#444444'; pepperoni = & $C '#262626'; basil = & $C '#303030' }

function Fill($g, $color, $x, $y, $w, $h) { $g.FillEllipse((New-Object System.Drawing.SolidBrush $color), [float]$x, [float]$y, [float]$w, [float]$h) }

function Draw-Pizza($g, $x, $y, $d, $p) {
  Fill $g $p.shadow ($x + $d * 0.03) ($y + $d * 0.06) $d $d                 # ombra
  Fill $g $p.crustEdge $x $y $d $d                                          # bordo
  Fill $g $p.crust ($x + $d * 0.03) ($y + $d * 0.03) ($d * 0.94) ($d * 0.94) # cornicione
  $m = $d * 0.13
  Fill $g $p.cheese ($x + $m) ($y + $m) ($d - 2 * $m) ($d - 2 * $m)         # mozzarella
  $cx = $x + $d / 2; $cy = $y + $d / 2
  foreach ($o in @(@(-0.12, -0.2, 0.07), @(0.2, 0.05, 0.06), @(-0.05, 0.22, 0.05))) {
    $r = $d * $o[2]; Fill $g $p.spot ($cx + $o[0] * $d - $r) ($cy + $o[1] * $d - $r) (2 * $r) (2 * $r)
  }
  $r = $d * 0.075
  foreach ($o in @(@(-0.18, -0.12), @(0.14, -0.2), @(0.03, 0.03), @(-0.2, 0.15), @(0.2, 0.18), @(0.0, -0.32), @(-0.31, -0.02))) {
    Fill $g $p.pepperoni ($cx + $o[0] * $d - $r) ($cy + $o[1] * $d - $r) (2 * $r) (2 * $r)
  }
  $b = $d * 0.045
  foreach ($o in @(@(0.1, -0.06), @(-0.08, 0.1), @(0.16, 0.32))) {
    $g.FillEllipse((New-Object System.Drawing.SolidBrush $p.basil), [float]($cx + $o[0] * $d - $b * 1.4), [float]($cy + $o[1] * $d - $b * 0.8), [float]($b * 2.8), [float]($b * 1.6))
  }
}

function New-Canvas($w, $h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  return @($bmp, $g)
}

# Striscia 3:1 (1032x336): è la forma con cui il Wallet mostra l'immagine sulle carte fedeltà,
# così nessuna pizza viene tagliata. Una riga fino a 8 timbri, due righe oltre.
$W = 1032; $H = 336
$rows = if ($Total -gt 8) { 2 } else { 1 }
$cols = [Math]::Ceiling($Total / $rows)
$padX = 34; $padY = $(if ($rows -eq 1) { 70 } else { 22 }); $gap = 20
$d = [Math]::Floor([Math]::Min(($W - 2 * $padX - $gap * ($cols - 1)) / $cols, ($H - 2 * $padY - $gap * ($rows - 1)) / $rows))
$gridW = $cols * $d + ($cols - 1) * $gap; $gridH = $rows * $d + ($rows - 1) * $gap
$x0 = ($W - $gridW) / 2; $y0 = ($H - $gridH) / 2

for ($n = 0; $n -le $Total; $n++) {
  $bmp, $g = New-Canvas $W $H
  for ($i = 0; $i -lt $Total; $i++) {
    $col = $i % $cols; $row = [Math]::Floor($i / $cols)
    $palette = if ($i -lt $n) { $full } else { $dark }
    Draw-Pizza $g ($x0 + $col * ($d + $gap)) ($y0 + $row * ($d + $gap)) $d $palette
  }
  $bmp.Save((Join-Path $outDir "grid-$Total-$n.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

# Icone singole per la tessera web
foreach ($v in @(@('pizza.png', $full), @('pizza-empty.png', $dark))) {
  $bmp, $g = New-Canvas 256 256
  Draw-Pizza $g 4 2 240 $v[1]
  $bmp.Save((Join-Path $outDir $v[0]), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

Write-Output "Generate $($Total + 1) griglie ($cols x $rows) + icone in $outDir"

# ---------- Fotogrammi per le GIF animate della tessera Wallet ----------
# Sfondo pieno nel colore della tessera (le GIF non hanno trasparenza morbida).
# Poi: node tools/make-gifs.js  ->  public/stamps/anim-<Total>-<n>.gif
$bg = & $C $BrandColor
$framesDir = Join-Path $PSScriptRoot '.frames'
Remove-Item -Recurse -Force $framesDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $framesDir | Out-Null
$gold = & $C '#ffcf4a'

function Slot($i) { @(($x0 + ($i % $cols) * ($d + $gap)), ($y0 + [Math]::Floor($i / $cols) * ($d + $gap))) }

function Draw-PizzaAt($g, $i, $p, [double]$scale = 1, [double]$angle = 0) {
  $x, $y = Slot $i
  $g.TranslateTransform([float]($x + $d / 2), [float]($y + $d / 2))
  $g.RotateTransform([float]$angle)
  $g.ScaleTransform([float]$scale, [float]$scale)
  Draw-Pizza $g (-$d / 2) (-$d / 2) $d $p
  $g.ResetTransform()
}

function Save-Frame($bmp, $name, $idx) {
  $dir = Join-Path $framesDir $name
  New-Item -ItemType Directory -Force $dir | Out-Null
  $bmp.Save((Join-Path $dir ('f{0:D2}.png' -f $idx)), [System.Drawing.Imaging.ImageFormat]::Png)
}

$manifest = @{}

# "+1" dorato con bordo scuro, centrato in (cx, cy)
$plusFont = New-Object System.Drawing.FontFamily 'Arial Black'
function Draw-PlusOne($g, $cx, $cy, [double]$size, [int]$alpha) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $path.AddString('+1', $plusFont, 0, [float]$size, (New-Object System.Drawing.PointF ([float]$cx, [float]$cy)), $sf)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb($alpha, 90, 12, 8)), ([float]($size * 0.16))
  $pen.LineJoin = 'Round'
  $g.DrawPath($pen, $path)
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($alpha, $gold))), $path)
}

# 1) Timbro appena ottenuto (n = 1..Total): l'ultima pizza entra girando, anello dorato,
#    scintille e un "+1" che sale e svanisce
for ($n = 1; $n -le $Total; $n++) {
  $name = "anim-$Total-$n"; $delays = @(); $frames = 22; $popFrames = 12
  for ($f = 0; $f -lt $frames; $f++) {
    $t = [Math]::Min(1, $f / $popFrames)
    $bmp = New-Object System.Drawing.Bitmap $W, $H
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.SmoothingMode = 'AntiAlias'; $g.Clear($bg)
    for ($i = 0; $i -lt $Total; $i++) {
      if ($i -lt $n - 1) { Draw-PizzaAt $g $i $full } else { Draw-PizzaAt $g $i $dark }
    }
    $k = $n - 1; $sx, $sy = Slot $k; $cx = $sx + $d / 2; $cy = $sy + $d / 2
    # easeOutBack per la scala, rotazione che si smorza
    $u = $t - 1; $scale = 1 + 2.70158 * [Math]::Pow($u, 3) + 1.70158 * [Math]::Pow($u, 2)
    if ($t -gt 0) { Draw-PizzaAt $g $k $full ([Math]::Max(0.05, $scale)) (-200 * [Math]::Pow(1 - $t, 2)) }
    if ($t -ge 0.35 -and $f -le $popFrames) {
      $q = ($t - 0.35) / 0.65; $alpha = [int](255 * (1 - $q))
      $r = $d * (0.52 + 0.4 * $q)
      $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb($alpha, $gold)), ([float]($d * 0.06 * (1 - $q) + 2))
      $g.DrawEllipse($pen, [float]($cx - $r), [float]($cy - $r), [float](2 * $r), [float](2 * $r))
      for ($s = 0; $s -lt 8; $s++) {
        $a = $s * [Math]::PI / 4 + 0.3; $dist = $d * (0.55 + 0.45 * $q); $sr = $d * 0.05 * (1 - $q) + 2
        $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($alpha, 255, 255, 255))),
          [float]($cx + [Math]::Cos($a) * $dist - $sr), [float]($cy + [Math]::Sin($a) * $dist - $sr), [float](2 * $sr), [float](2 * $sr))
      }
    }
    # "+1": compare con un piccolo rimbalzo sopra la pizza, sale e svanisce
    $pf = $f - 5
    if ($pf -ge 0 -and $f -lt $frames - 1) {
      $pq = $pf / ($frames - 7)
      $pop = if ($pq -lt 0.2) { 0.6 + 2.5 * $pq } elseif ($pq -lt 0.35) { 1.1 - ($pq - 0.2) * 0.66 } else { 1.0 }
      $alpha = if ($pq -lt 0.7) { 255 } else { [int](255 * (1 - ($pq - 0.7) / 0.3)) }
      $py = $cy - $d * 0.3 - $pq * $d * 0.42
      Draw-PlusOne $g ($cx + $d * 0.32) $py ($d * 0.5 * $pop) ([Math]::Max(0, $alpha))
    }
    Save-Frame $bmp $name $f; $g.Dispose(); $bmp.Dispose()
    $delays += $(if ($f -eq 0) { 400 } elseif ($f -eq $frames - 1) { 2400 } else { 50 })
  }
  $manifest[$name] = $delays
}

# 2) Premio pronto: tutte le pizze colorate, una alla volta fa un saltello (onda)
$name = "anim-$Total-reward"; $delays = @(); $hop = @(1.1, 1.16, 1.08, 1.0)
$f = 0
for ($i = 0; $i -lt $Total; $i++) {
  foreach ($s in $hop) {
    $bmp = New-Object System.Drawing.Bitmap $W, $H
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.SmoothingMode = 'AntiAlias'; $g.Clear($bg)
    for ($j = 0; $j -lt $Total; $j++) { if ($j -ne $i) { Draw-PizzaAt $g $j $full } }
    Draw-PizzaAt $g $i $full $s (($s - 1) * 60)
    Save-Frame $bmp $name $f; $g.Dispose(); $bmp.Dispose()
    $delays += $(if ($i -eq $Total - 1 -and $s -eq 1.0) { 1400 } else { 60 })
    $f++
  }
}
$manifest[$name] = $delays

$manifest | ConvertTo-Json | Set-Content (Join-Path $framesDir 'manifest.json') -Encoding utf8
Write-Output "Fotogrammi pronti in ${framesDir}: esegui  node tools/make-gifs.js"
